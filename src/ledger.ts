import { createHash } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { adjustmentId, applyAdjustment } from './adjust';
import { keys, pkExists, pkNotExists, skOf, type TableKey } from './keys';
import { feeOf, walletKeys } from './wallet';

/**
 * One metered call, fully priced. It is plain JSON so it can wait on the retry queue and be
 * recorded later by the retry Lambda with exactly the same result.
 */
export interface UsageRecord {
  appId: string;
  sub: string;
  /** Absent on FairMeter records: no household counter, no credit. */
  householdId?: string;
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
  /** Which deployment ("prod" | "dev"); FairMeter writes it on every EVENT. */
  env?: string;
  /** Who paid the provider: a key billed to a card, or a credit (e.g. Claude on API credit). */
  paidBy?: 'credit' | 'paid';
  /**
   * FairMeter: the hold this record settles. Its PENDING row is deleted in the same transaction
   * and the person's day `committedMicroUsd` moves by cost − reserved. Absent on the old path.
   */
  reservedMicroUsd?: number;
  /** FairMeter: tells a repeat of this same record ('duplicate') from a different one ('conflict'). */
  usageHash?: string;
  /** Not the provider's reported usage: the app aborted, no usage came back, or the sweeper settled it. */
  estimated?: 'aborted' | 'no_usage' | 'swept';
  /** FairMeter 'not_billed': release the hold; no EVENT and no counters. */
  release?: boolean;
  /**
   * Hosted billing: the person's wallet moves in this transaction. `heldMicroUsd` is the hold plus its
   * fee (absent for rolled-up actions); `chargedMicroUsd` is what the person pays, cost minus absorbed
   * plus `feeMicroUsd`, never more than the hold (or, for actions, than available at the rollup's read).
   */
  wallet?: { table: string; account: string; heldMicroUsd?: number; feeMicroUsd: number; chargedMicroUsd: number };
}

/**
 * What the operator absorbs of a settle, always a part of cost: the whole cost of an attempt that
 * didn't serve the person (swept, aborted). It still counts toward the cap; the person is charged
 * cost minus absorbed. Hosted, the cost the wallet wasn't charged (above the hold, or a rollup's
 * floor overrun): cost + fee - charged, where the fee is the part of the charge that is fee (walletChargeOf).
 */
export const absorbedOf = (r: Pick<UsageRecord, 'estimated' | 'release' | 'costMicroUsd' | 'wallet'>) =>
  r.wallet ? (r.release ? 0 : r.costMicroUsd + r.wallet.feeMicroUsd - r.wallet.chargedMicroUsd)
    : !r.release && (r.estimated === 'swept' || r.estimated === 'aborted') ? r.costMicroUsd : 0;

/**
 * Hosted: what the wallet is charged for `paidMicroUsd` of cost plus its fee, at most `capMicroUsd`
 * (the hold, or what the rollup found available). A capped charge splits into cost and fee at the
 * fee's rate, so the fee is only ever on cost the person paid: absorbed stays a part of cost.
 */
export function walletChargeOf(paidMicroUsd: number, feeBps: number, capMicroUsd: number) {
  const fee = feeOf(paidMicroUsd, feeBps);
  if (paidMicroUsd + fee <= capMicroUsd) return { feeMicroUsd: fee, chargedMicroUsd: paidMicroUsd + fee };
  const charged = Math.max(0, capMicroUsd);
  return { feeMicroUsd: charged - Math.floor((charged * 10_000) / (10_000 + feeBps)), chargedMicroUsd: charged };
}

/**
 * Hosted: the person's wallet in the usage transaction. A settle or release gives the hold back and
 * spends the charge; rolled-up actions (no hold) spend it only while available covers it. The
 * app's SPEND counter for the month grows by the charge. Nothing for a charge of 0 without a hold.
 */
function walletItems(r: UsageRecord, month: string) {
  const w = r.wallet;
  if (!w) return [];
  const charged = r.release ? 0 : w.chargedMicroUsd;
  const held = w.heldMicroUsd;
  if (held === undefined && !charged) return [];
  const balance = {
    Update: {
      TableName: w.table,
      Key: walletKeys.balance(w.account),
      ...(held === undefined
        ? {
            UpdateExpression: 'ADD availableMicroUsd :out, spentMicroUsd :charged',
            ConditionExpression: 'availableMicroUsd >= :charged',
            ExpressionAttributeValues: { ':out': -charged, ':charged': charged },
          }
        : {
            UpdateExpression: `ADD availableMicroUsd :back, heldMicroUsd :unheld${charged ? ', spentMicroUsd :charged' : ''}`,
            ExpressionAttributeValues: { ':back': held - charged, ':unheld': -held, ...(charged ? { ':charged': charged } : {}) },
          }),
    },
  };
  const spend = { Update: { TableName: w.table, Key: walletKeys.spend(w.account, month), UpdateExpression: 'ADD #app :charged', ExpressionAttributeNames: { '#app': r.appId }, ExpressionAttributeValues: { ':charged': charged } } };
  return charged ? [balance, spend] : [balance];
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
 * credit balance; hosted, the wallet's BALANCE and SPEND. At most 11 items, far below the 100-item transaction limit. The household month
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
  const held = r.reservedMicroUsd;
  // Hosted, the daily cap counts charged amounts: the hold plus its fee, cost plus the fee charged.
  const fee = r.wallet?.feeMicroUsd ?? 0;
  const capHold = r.wallet?.heldMicroUsd ?? held;
  const pending = held === undefined ? [] : [{ Delete: { TableName: table, Key: keys.pending(r.appId, r.requestId), ConditionExpression: pkExists() } }];
  if (r.release) {
    if (held === undefined) throw new Error(`A release needs reservedMicroUsd: ${r.requestId}`);
    return new TransactWriteCommand({
      ClientRequestToken: clientRequestToken(r.appId, r.requestId),
      TransactItems: [
        ...pending,
        { Update: { TableName: table, Key: keys.userDay(r.sub, r.appId, day), UpdateExpression: 'ADD committedMicroUsd :held', ExpressionAttributeValues: { ':held': -capHold! } } },
        ...walletItems(r, month),
      ],
    });
  }
  const names = Object.keys(r.counters);
  if (!names.every((n) => COUNTER_NAME.test(n))) throw new Error(`Invalid counter names: ${names.join(',')}`);
  const meters = `ADD requests :one, ${names.map((name, i) => `${name} :c${i}, `).join('')}`;
  const meterValues = { ':one': 1, ...Object.fromEntries(names.map((name, i) => [`:c${i}`, r.counters[name]])) };
  const counters = {
    UpdateExpression: `${meters}costMicroUsd :cost`,
    ExpressionAttributeValues: { ...meterValues, ':cost': r.costMicroUsd },
  };
  const counter = (key: TableKey) => ({ Update: { TableName: table, Key: key, ...counters } });
  // Only the person's day and month carry what the operator absorbed.
  const absorbed = absorbedOf(r);
  // ...and the fee charged, hosted.
  const personal = {
    UpdateExpression: `${counters.UpdateExpression}${absorbed ? ', absorbedMicroUsd :absorbed' : ''}${fee ? ', feeMicroUsd :fee' : ''}`,
    ExpressionAttributeValues: { ...counters.ExpressionAttributeValues, ...(absorbed ? { ':absorbed': absorbed } : {}), ...(fee ? { ':fee': fee } : {}) },
  };
  if (r.householdId === undefined && (r.deductCredit || r.householdMonthMarks)) throw new Error(`No household to charge: ${r.requestId}`);
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
  const householdMonth = r.householdId === undefined ? [] : [marks.length
    ? {
        Update: {
          TableName: table,
          Key: keys.householdMonth(r.householdId!, r.appId, month),
          UpdateExpression: `${counters.UpdateExpression} SET ${marks.map(([n], i) => `${n} = if_not_exists(${n}, :m${i})`).join(', ')}`,
          ExpressionAttributeValues: { ...counters.ExpressionAttributeValues, ...Object.fromEntries(marks.map(([, v], i) => [`:m${i}`, v])) },
        },
      }
    : counter(keys.householdMonth(r.householdId!, r.appId, month))];
  // Free-tier counters (with `requests`) and set members, e.g. "ADD requests :one, premiumChars :f0, voiceHouseholds :s0".
  const freeTierAdds = [
    ...(freeTierNames.length ? ['requests :one', ...freeTierNames.map((name, i) => `${name} :f${i}`)] : []),
    ...setNames.map((name, i) => `${name} :s${i}`),
  ];

  return new TransactWriteCommand({
    // An actions requestId is per SKU and window, not per person, so one token would collide across
    // people: the EVENT's condition alone keeps it exactly once.
    ...(r.kind === 'actions' ? {} : { ClientRequestToken: clientRequestToken(r.appId, r.requestId) }),
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: {
            ...keys.event(r.sub, r.requestTime, r.appId, r.requestId),
            appId: r.appId,
            kind: r.kind,
            ...(r.householdId !== undefined ? { householdId: r.householdId } : {}),
            ...(r.plan ? { plan: r.plan } : {}),
            requestId: r.requestId,
            ...r.details,
            pricingVersion: r.pricingVersion,
            baseCostMicroUsd: r.baseCostMicroUsd,
            costMicroUsd: r.costMicroUsd,
            markupBps: r.markupBps,
            ...(r.env !== undefined ? { env: r.env } : {}),
            ...(r.paidBy !== undefined ? { paidBy: r.paidBy } : {}),
            ...(held !== undefined ? { reservedMicroUsd: held } : {}),
            ...(r.usageHash !== undefined ? { usageHash: r.usageHash } : {}),
            ...(r.estimated !== undefined ? { estimated: r.estimated } : {}),
            ...(absorbed ? { absorbedMicroUsd: absorbed } : {}),
            ...(r.wallet ? { account: r.wallet.account, feeMicroUsd: r.wallet.feeMicroUsd } : {}),
          },
          ConditionExpression: pkNotExists(),
        },
      },
      { Update: { TableName: table, Key: keys.userMonth(r.sub, r.appId, month), ...personal } },
      held === undefined
        ? r.kind === 'actions'
          // Rolled-up actions count toward the cap like a settled hold: the write check reads committed.
          ? { Update: { TableName: table, Key: keys.userDay(r.sub, r.appId, day), UpdateExpression: `${personal.UpdateExpression}, committedMicroUsd :committed`, ExpressionAttributeValues: { ...personal.ExpressionAttributeValues, ':committed': r.costMicroUsd + fee } } }
          : counter(keys.userDay(r.sub, r.appId, day))
        : {
            Update: {
              TableName: table,
              Key: keys.userDay(r.sub, r.appId, day),
              // The hold becomes the actual cost: committed (the cap's attribute) moves by the difference.
              UpdateExpression: `${personal.UpdateExpression}, committedMicroUsd :held`,
              ExpressionAttributeValues: { ...personal.ExpressionAttributeValues, ':held': r.costMicroUsd + fee - capHold! },
            },
          },
      ...householdMonth,
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
                Key: keys.householdMeta(r.householdId!),
                // May go slightly negative on the last request; that overshoot is accepted by design.
                UpdateExpression: 'ADD creditBalanceMicroUsd :neg',
                ConditionExpression: pkExists(),
                ExpressionAttributeValues: { ':neg': -r.costMicroUsd },
              },
            },
          ]
        : []),
      ...pending,
      ...walletItems(r, month),
    ],
  });
}

/** True when the transaction was refused only because this event is already recorded. */
export function isAlreadyRecorded(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  return e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

/**
 * Records a call exactly once. Resolves 'duplicate' when an earlier attempt already got through.
 * FairMeter records (reservedMicroUsd) also resolve 'trued_up' (real usage after the sweeper's
 * estimate, written as an ADJUST) or 'conflict' (a different payload for the same call: refused,
 * RECORD_CONFLICT alarms). Anything else throws, for the caller to queue.
 */
export async function recordUsage(
  ddb: DynamoDBDocumentClient,
  table: string,
  r: UsageRecord,
): Promise<'recorded' | 'duplicate' | 'trued_up' | 'conflict'> {
  try {
    await ddb.send(usageTransaction(table, r));
    return 'recorded';
  } catch (err) {
    if (r.reservedMicroUsd !== undefined) return inspectSettled(ddb, table, r, err);
    if (isAlreadyRecorded(err)) return 'duplicate';
    throw err;
  }
}

/** Logged at error level: the metric filters on the app and retry Lambdas alarm on it. */
function conflict(r: UsageRecord, reason: string) {
  console.error('RECORD_CONFLICT', { appId: r.appId, requestId: r.requestId, sub: r.sub, reason, record: r });
  return 'conflict' as const;
}

/** Why a FairMeter settle or release was refused: the EVENT (consistent read) decides. */
async function inspectSettled(ddb: DynamoDBDocumentClient, table: string, r: UsageRecord, err: unknown) {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  // Same token, other parameters, within DynamoDB's 10-minute idempotency window (e.g. real usage
  // right after the sweeper's estimate). The token's other use may or may not have committed.
  const mismatch = e?.name === 'IdempotentParameterMismatchException';
  // Only the EVENT put and the PENDING delete carry conditions.
  if (!mismatch && !(e?.name === 'TransactionCanceledException' && e.CancellationReasons?.some((c) => c.Code === 'ConditionalCheckFailed'))) throw err;
  const { Item: event } = await ddb.send(new GetCommand({ TableName: table, Key: keys.event(r.sub, r.requestTime, r.appId, r.requestId), ConsistentRead: true }));
  // The sweeper lost a race to the app's own settle or release: the real outcome stands (a row
  // still pending is swept again on the next run).
  if (r.estimated === 'swept') return 'duplicate';
  if (!event) {
    // Nothing settled under the token yet: queue it; after the window the condition decides.
    if (mismatch) throw err;
    // No EVENT and no PENDING: the hold was released. A second release is a repeat; a settle is not.
    return r.release ? 'duplicate' : conflict(r, 'the reservation was already released');
  }
  if (event.usageHash === r.usageHash) return 'duplicate';
  if (event.estimated === 'swept') return trueUp(ddb, table, r, event);
  return conflict(r, 'the call was already settled with another payload');
}

/** The sweeper estimated this call; the real usage arrived later. The difference is an ADJUST. */
async function trueUp(ddb: DynamoDBDocumentClient, table: string, r: UsageRecord, event: Record<string, any>) {
  const oldCost = Number(event.costMicroUsd);
  const newCost = r.release ? 0 : r.costMicroUsd;
  const eventSk = skOf(event);
  const adjustment = {
    appId: r.appId,
    sub: r.sub,
    eventSk,
    eventTime: r.requestTime,
    legacyEvent: false,
    kind: r.kind,
    sku: String(r.details.sku ?? event.sku),
    reason: 'late-usage',
    oldPricingVersion: String(event.pricingVersion),
    newPricingVersion: r.pricingVersion,
    oldCostMicroUsd: oldCost,
    newCostMicroUsd: newCost,
    deltaMicroUsd: newCost - oldCost,
    // A late real usage charges the person; a late 'not_billed' leaves them at $0.
    absorbedMicroUsd: absorbedOf(r) - Number(event.absorbedMicroUsd ?? 0),
    // Deterministic, so a retry sends the same parameters under the same token.
    createdAt: r.requestTime,
    deductCredit: false,
    details: { ...r.details, ...(r.usageHash ? { usageHash: r.usageHash } : {}), ...(r.release ? { release: true } : {}) },
  };
  let outcome;
  let mismatchErr: unknown;
  try {
    outcome = await applyAdjustment(ddb, table, adjustment);
  } catch (err) {
    if ((err as { name?: string }).name !== 'IdempotentParameterMismatchException') throw err;
    outcome = 'mismatch' as const;
    mismatchErr = err;
  }
  if (outcome !== 'applied') {
    // One true-up per call: a repeat of it is a duplicate, any other late payload a conflict.
    const id = adjustmentId(adjustment.reason, eventSk);
    const { Item: prior } = await ddb.send(new GetCommand({ TableName: table, Key: keys.adjustment(r.sub, r.requestTime, r.appId, id), ConsistentRead: true }));
    // Inside the token window with nothing written yet: queue it; after the window the condition decides.
    if (!prior && outcome === 'mismatch') throw mismatchErr;
    if (prior?.usageHash === r.usageHash) return 'duplicate';
    return conflict(r, 'a late payload was already trued up');
  }
  console.warn('LATE_USAGE', { appId: r.appId, requestId: r.requestId, sub: r.sub, deltaMicroUsd: newCost - oldCost });
  return 'trued_up';
}
