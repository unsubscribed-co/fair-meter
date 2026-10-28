import { createHash } from 'node:crypto';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys, pkExists, pkNotExists, type TableKey } from './keys';
import { isAlreadyRecorded } from './ledger';

/*
 * Adjustments: the correcting half of the cost ledger. EVENT items are charges and are never
 * mutated; a correction (e.g. a re-price after a price-list fix) is a new immutable ADJUST item
 * with a signed delta, written with the counters it moves in one transaction.
 *
 * The key is deterministic from (reason, event SK), so applying the same correction twice is
 * refused by the conditional put: a no-op, never a double refund. A later, different correction
 * of the same event needs a new reason id.
 */

/** Reason ids name one correction run, e.g. "reprice-offpeak-2026-09". */
export const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function checkReason(reason: string): string {
  if (!REASON_PATTERN.test(reason)) throw new Error(`Invalid reason "${reason}" (lowercase letters, digits, dashes)`);
  return reason;
}

export interface Adjustment {
  appId: string;
  sub: string;
  householdId: string;
  /** The corrected event's plan (undefined = legacy prepaid). */
  plan?: string;
  /** SK of the EVENT this corrects (same USER# partition). */
  eventSk: string;
  /** The event's time (ISO, ms). Picks the key and the counters' periods: the event's, not today's. */
  eventTime: string;
  /** Pre-appId event: its charge sits in the legacy user counters (USAGE#<month>, DAILY#<day>). */
  legacyEvent: boolean;
  /** Copied from the event so statements and exports can group adjustments without a join. */
  kind: string;
  sku: string;
  reason: string;
  oldPricingVersion: string;
  newPricingVersion: string;
  oldCostMicroUsd: number;
  newCostMicroUsd: number;
  /** newCostMicroUsd - oldCostMicroUsd: negative is a refund. */
  deltaMicroUsd: number;
  createdAt: string;
  /** Legacy prepaid households paid from the credit balance, so the delta goes back there too. */
  deductCredit: boolean;
  /** e.g. the new price's band/tier; stored as-is. */
  details?: Record<string, string | number | boolean>;
}

export const adjustmentId = (reason: string, eventSk: string) =>
  createHash('sha256').update(`${reason}#${eventSk}`).digest('hex').slice(0, 32);

/** The counter items the original event's transaction wrote, in its own periods. */
export function adjustedCounterKeys(a: Pick<Adjustment, 'sub' | 'householdId' | 'appId' | 'eventTime' | 'legacyEvent'>) {
  const month = a.eventTime.slice(0, 7);
  const day = a.eventTime.slice(0, 10);
  // Legacy events only ever counted in the user's legacy month/day items.
  if (a.legacyEvent) return [keys.legacyUserMonth(a.sub, month), keys.legacyUserDay(a.sub, day)];
  return [
    keys.userMonth(a.sub, a.appId, month),
    keys.userDay(a.sub, a.appId, day),
    keys.householdMonth(a.householdId, a.appId, month),
  ];
}

/**
 * The adjustment item plus the delta on the original event's counters, in one transaction.
 *
 * Not the app/global DAILY breakers: those are operational (they stopped or allowed calls on that
 * day, which has passed); rewriting them would change nothing and blur what the breaker saw.
 * Counter updates require the item to exist: the event's own transaction created it, so a missing
 * one means the keys are wrong and the whole correction is refused instead of creating strays.
 */
export function adjustmentTransaction(table: string, a: Adjustment) {
  if (a.deltaMicroUsd !== a.newCostMicroUsd - a.oldCostMicroUsd || !Number.isSafeInteger(a.deltaMicroUsd)) {
    throw new Error(`Inconsistent adjustment delta for ${a.eventSk}`);
  }
  checkReason(a.reason);
  const id = adjustmentId(a.reason, a.eventSk);
  const counter = (key: TableKey) => ({
    Update: {
      TableName: table,
      Key: key,
      UpdateExpression: 'ADD costMicroUsd :delta, adjustmentsMicroUsd :delta',
      ConditionExpression: pkExists(),
      ExpressionAttributeValues: { ':delta': a.deltaMicroUsd },
    },
  });
  return new TransactWriteCommand({
    ClientRequestToken: id,
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: {
            ...keys.adjustment(a.sub, a.eventTime, a.appId, id),
            adjustmentId: id,
            appId: a.appId,
            householdId: a.householdId,
            ...(a.plan ? { plan: a.plan } : {}),
            eventSk: a.eventSk,
            eventTime: a.eventTime,
            month: a.eventTime.slice(0, 7),
            day: a.eventTime.slice(0, 10),
            kind: a.kind,
            sku: a.sku,
            ...a.details,
            reason: a.reason,
            oldPricingVersion: a.oldPricingVersion,
            newPricingVersion: a.newPricingVersion,
            oldCostMicroUsd: a.oldCostMicroUsd,
            newCostMicroUsd: a.newCostMicroUsd,
            deltaMicroUsd: a.deltaMicroUsd,
            createdAt: a.createdAt,
          },
          ConditionExpression: pkNotExists(),
        },
      },
      ...adjustedCounterKeys(a).map(counter),
      ...(a.deductCredit
        ? [
            {
              Update: {
                TableName: table,
                Key: keys.householdMeta(a.householdId),
                // Same sign convention as the charge: a negative delta refunds credit.
                UpdateExpression: 'ADD creditBalanceMicroUsd :neg',
                ConditionExpression: pkExists(),
                ExpressionAttributeValues: { ':neg': -a.deltaMicroUsd },
              },
            },
          ]
        : []),
    ],
  });
}

/** Writes an adjustment exactly once. 'duplicate' when this correction was already applied. */
export async function applyAdjustment(
  ddb: DynamoDBDocumentClient,
  table: string,
  a: Adjustment,
): Promise<'applied' | 'duplicate'> {
  try {
    await ddb.send(adjustmentTransaction(table, a));
    return 'applied';
  } catch (err) {
    if (isAlreadyRecorded(err)) return 'duplicate';
    throw err;
  }
}
