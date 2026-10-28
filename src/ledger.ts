import { createHash } from 'node:crypto';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys, pkExists, pkNotExists, type TableKey } from './keys';

/**
 * One metered call, fully priced. It is plain JSON so it can wait on the retry queue and be
 * recorded later by the retry Lambda with exactly the same result.
 */
export interface UsageRecord {
  appId: string;
  sub: string;
  householdId: string;
  /** Household plan for this app at call time (undefined = legacy prepaid). Lets statements drop dev traffic. */
  plan?: string;
  /** The app's request id (e.g. API Gateway's): one per incoming call, so one upstream call. */
  requestId: string;
  /** When the call reached the app (ISO, ms). Picks the day/month buckets, matching enforcement. */
  requestTime: string;
  /** e.g. 'chat', 'tts': what was metered. */
  kind: string;
  pricingVersion: string;
  /** Raw facts stored on the event item so costs can be recomputed (model, meters, durations...). */
  details: Record<string, string | number | boolean>;
  /** Added to every counter item besides `requests` and `costMicroUsd`. Keys must be code constants. */
  counters: Record<string, number>;
  baseCostMicroUsd: number;
  costMicroUsd: number;
  markupBps: number;
  /** Legacy prepaid households pay from the credit balance; plan households don't touch it. */
  deductCredit: boolean;
  /**
   * Account-wide counters against a provider's monthly free tier, added to PROVIDER#<provider> /
   * MONTH#<YYYY-MM> (e.g. `{ provider: 'gcp-tts', counters: { premiumChars: 120 } }`), plus `requests`.
   * Only calls that use up a free tier carry counters. `sets` adds one member to a string set on the
   * same item (e.g. `{ voiceHouseholds: 'fam' }`: who used the provider this month); adding a member
   * twice is a no-op. Names must be code constants.
   */
  providerMonth?: { provider: string; counters?: Record<string, number>; sets?: Record<string, string> };
  /**
   * One-way marks on the household's month counter item (HOUSEHOLD#<id> / USAGE#<app>#<YYYY-MM>),
   * set only if absent (`if_not_exists`), so the first call that sets one wins and retries are
   * no-ops, e.g. Nieto's `{ premiumEndedAt: <iso>, premiumEndedReason: 'household_share' }`.
   */
  householdMonthMarks?: Record<string, string>;
}

/** DynamoDB idempotency token (max 36 chars) derived from app and request id. */
export const clientRequestToken = (appId: string, requestId: string) =>
  createHash('sha256').update(`${appId}#${requestId}`).digest('hex').slice(0, 32);

const COUNTER_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The upstream provider a record was priced for, from `details.provider` (token records carry it
 * since phase 1, so queued records do too; Nieto's TTS records since the hourly-dashboard change). Undefined for records
 * without one: they get no provider counter.
 */
export function recordProvider(r: Pick<UsageRecord, 'details'>): string | undefined {
  const p = r.details.provider;
  return typeof p === 'string' && PROVIDER_NAME.test(p) ? p : undefined;
}

/**
 * The event and every counter in one transaction. The event put is conditional on its key, which
 * is deterministic per call, so a retried record is refused whole and never double-counts; the
 * ClientRequestToken also makes a retry within 10 minutes a no-op success.
 *
 * Counters (all per app): user month and day, household month (allowance), app day (breaker),
 * plus the all-apps day (ceiling), the provider day (reconciliation), the provider month (free
 * tiers, e.g. Google's free premium voice characters) and, for legacy prepaid households only, the
 * credit balance. At most 9 items, far below the 100-item transaction limit. The household month
 * also takes the record's one-way marks (householdMonthMarks), in the same update.
 *
 * The provider day sums what we expect the provider to charge (baseCostMicroUsd, before markup)
 * across all apps, so reconcile.ts compares it with the provider's balance by reading a few small
 * items instead of scanning every event (and its Lambda can be limited to PROVIDER# keys). Like
 * the breakers it records what we believed at call time: adjustments don't move it.
 */
export function usageTransaction(table: string, r: UsageRecord) {
  const month = r.requestTime.slice(0, 7);
  const day = r.requestTime.slice(0, 10);
  const names = Object.keys(r.counters);
  if (!names.every((n) => COUNTER_NAME.test(n))) throw new Error(`Invalid counter names: ${names.join(',')}`);
  const meters = `ADD requests :one, ${names.map((name, i) => `${name} :c${i}, `).join('')}`;
  const meterValues = { ':one': 1, ...Object.fromEntries(names.map((name, i) => [`:c${i}`, r.counters[name]])) };
  const counters = {
    UpdateExpression: `${meters}costMicroUsd :cost`,
    ExpressionAttributeValues: { ...meterValues, ':cost': r.costMicroUsd },
  };
  const counter = (key: TableKey) => ({ Update: { TableName: table, Key: key, ...counters } });
  const provider = recordProvider(r);
  const freeTier = r.providerMonth;
  const freeTierNames = Object.keys(freeTier?.counters ?? {});
  const setNames = Object.keys(freeTier?.sets ?? {});
  if (freeTier && (!PROVIDER_NAME.test(freeTier.provider) || !(freeTierNames.length + setNames.length) ||
    ![...freeTierNames, ...setNames].every((n) => COUNTER_NAME.test(n)) || !setNames.every((n) => freeTier.sets![n]))) {
    throw new Error(`Invalid provider month counters: ${freeTier.provider} ${[...freeTierNames, ...setNames].join(',')}`);
  }
  const marks = Object.entries(r.householdMonthMarks ?? {});
  if (!marks.every(([n, v]) => COUNTER_NAME.test(n) && typeof v === 'string' && v)) throw new Error(`Invalid household month marks: ${marks.map(([n]) => n).join(',')}`);
  // The household month: counters plus the one-way marks, in the same update.
  const householdMonth = marks.length
    ? {
        Update: {
          TableName: table,
          Key: keys.householdMonth(r.householdId, r.appId, month),
          UpdateExpression: `${counters.UpdateExpression} SET ${marks.map(([n], i) => `${n} = if_not_exists(${n}, :m${i})`).join(', ')}`,
          ExpressionAttributeValues: { ...counters.ExpressionAttributeValues, ...Object.fromEntries(marks.map(([, v], i) => [`:m${i}`, v])) },
        },
      }
    : counter(keys.householdMonth(r.householdId, r.appId, month));
  // Free-tier counters (with `requests`) and set members, e.g. "ADD requests :one, premiumChars :f0, voiceHouseholds :s0".
  const freeTierAdds = [
    ...(freeTierNames.length ? ['requests :one', ...freeTierNames.map((name, i) => `${name} :f${i}`)] : []),
    ...setNames.map((name, i) => `${name} :s${i}`),
  ];

  return new TransactWriteCommand({
    ClientRequestToken: clientRequestToken(r.appId, r.requestId),
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: {
            ...keys.event(r.sub, r.requestTime, r.appId, r.requestId),
            appId: r.appId,
            kind: r.kind,
            householdId: r.householdId,
            ...(r.plan ? { plan: r.plan } : {}),
            requestId: r.requestId,
            ...r.details,
            pricingVersion: r.pricingVersion,
            baseCostMicroUsd: r.baseCostMicroUsd,
            costMicroUsd: r.costMicroUsd,
            markupBps: r.markupBps,
          },
          ConditionExpression: pkNotExists(),
        },
      },
      counter(keys.userMonth(r.sub, r.appId, month)),
      counter(keys.userDay(r.sub, r.appId, day)),
      householdMonth,
      counter(keys.appDay(r.appId, day)),
      counter(keys.globalDay(day)),
      ...(provider
        ? [
            {
              Update: {
                TableName: table,
                Key: keys.providerDay(provider, day),
                // Base cost only: the provider never sees our markup.
                UpdateExpression: `${meters}baseCostMicroUsd :base`,
                ExpressionAttributeValues: { ...meterValues, ':base': r.baseCostMicroUsd },
              },
            },
          ]
        : []),
      ...(freeTier
        ? [
            {
              Update: {
                TableName: table,
                Key: keys.providerMonth(freeTier.provider, month),
                UpdateExpression: `ADD ${freeTierAdds.join(', ')}`,
                ExpressionAttributeValues: {
                  ...(freeTierNames.length ? { ':one': 1 } : {}),
                  ...Object.fromEntries(freeTierNames.map((name, i) => [`:f${i}`, freeTier.counters![name]])),
                  // A DynamoDB string set of one member: ADD merges it, so a repeat changes nothing.
                  ...Object.fromEntries(setNames.map((name, i) => [`:s${i}`, new Set([freeTier.sets![name]])])),
                },
              },
            },
          ]
        : []),
      ...(r.deductCredit
        ? [
            {
              Update: {
                TableName: table,
                Key: keys.householdMeta(r.householdId),
                // May go slightly negative on the last request; that overshoot is accepted by design.
                UpdateExpression: 'ADD creditBalanceMicroUsd :neg',
                ConditionExpression: pkExists(),
                ExpressionAttributeValues: { ':neg': -r.costMicroUsd },
              },
            },
          ]
        : []),
    ],
  });
}

/** True when the transaction was refused only because this event is already recorded. */
export function isAlreadyRecorded(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  return e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

/** Records a call exactly once. Resolves 'duplicate' when an earlier attempt already got through. */
export async function recordUsage(
  ddb: DynamoDBDocumentClient,
  table: string,
  r: UsageRecord,
): Promise<'recorded' | 'duplicate'> {
  try {
    await ddb.send(usageTransaction(table, r));
    return 'recorded';
  } catch (err) {
    if (isAlreadyRecorded(err)) return 'duplicate';
    throw err;
  }
}
