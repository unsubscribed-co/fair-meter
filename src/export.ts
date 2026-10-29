import { ADJUST_PREFIX, EVENT_PREFIX, ledgerTime, skOf, subOf, tableKeys } from './keys';
import { eventFacts } from './report';

/*
 * Ledger export for analytics: EVENT and ADJUST items as flat newline-delimited JSON rows in S3,
 * laid out for Athena partition projection:
 *
 *   s3://<bucket>/app=<appId>/dt=<YYYY-MM-DD>/<batch-id>.json
 *
 * `dt` is the UTC day of the EVENT's time, for adjustments too (they belong to the event they
 * correct), so a Bogota-month query scans the same partitions for both. One row per item; rows are
 * unique by (sub, sk). The stream consumer and the admin backfill both use exportRow, so the two
 * paths can't drift. Pure; no AWS calls here.
 */

/** Glue/Athena columns (lowercase, as Glue stores them). JSON keys are the camelCase originals. */
export const EXPORT_COLUMNS: { name: string; type: 'string' | 'bigint' }[] = [
  ['recordType', 'string'], // event | adjustment
  ['appId', 'string'],
  ['sub', 'string'],
  ['householdId', 'string'],
  ['plan', 'string'], // absent = legacy prepaid
  ['sk', 'string'],
  ['eventTime', 'string'], // ISO ms, UTC
  ['kind', 'string'],
  ['sku', 'string'],
  ['amountMicroUsd', 'bigint'], // event: costMicroUsd; adjustment: deltaMicroUsd. SUM() it.
  // Events
  ['requestId', 'string'],
  ['provider', 'string'],
  ['requestedModel', 'string'],
  ['servedModel', 'string'],
  ['pricingVersion', 'string'],
  ['pricingBand', 'string'],
  ['pricingTier', 'string'],
  ['inputTokens', 'bigint'],
  ['cacheReadTokens', 'bigint'],
  ['cacheWriteTokens', 'bigint'],
  ['outputTokens', 'bigint'],
  ['reasoningTokens', 'bigint'],
  ['chars', 'bigint'],
  ['durationMs', 'bigint'],
  ['upstreamMs', 'bigint'],
  ['baseCostMicroUsd', 'bigint'],
  ['costMicroUsd', 'bigint'],
  ['markupBps', 'bigint'],
  // Adjustments
  ['eventSk', 'string'],
  ['reason', 'string'],
  ['oldPricingVersion', 'string'],
  ['newPricingVersion', 'string'],
  ['oldCostMicroUsd', 'bigint'],
  ['newCostMicroUsd', 'bigint'],
  ['deltaMicroUsd', 'bigint'],
  ['createdAt', 'string'],
  // v0.2.0, events (the end of the list, so earlier columns keep their places)
  ['env', 'string'],
  ['paidBy', 'string'], // credit | paid
  ['estimated', 'string'], // aborted | no_usage | swept; absent = the provider's own usage
  ['reservedMicroUsd', 'bigint'],
].map(([name, type]) => ({ name: name.toLowerCase(), type: type as 'string' | 'bigint' }));

export type ExportRow = Record<string, string | number>;

export interface ExportedItem {
  appId: string;
  /** Partition day (UTC day of the event's time). */
  dt: string;
  row: ExportRow;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Drops undefined values, so absent attributes read as NULL in Athena. */
const compact = (row: Record<string, string | number | undefined>): ExportRow =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as ExportRow;

/**
 * Maps an EVENT or ADJUST item (old or new) to its row, or undefined for any other item. Legacy
 * events are normalized like the spend report does (appId, sku, cachedInputTokens).
 */
export function exportRow(item: Record<string, any>, legacyAppId: string): ExportedItem | undefined {
  const sk = skOf(item);
  const isEvent = sk.startsWith(EVENT_PREFIX);
  if (!isEvent && !sk.startsWith(ADJUST_PREFIX)) return undefined;
  const eventTime = ledgerTime(sk);
  const appId = String(item.appId ?? legacyAppId);
  const common = {
    appId,
    sub: subOf(item),
    householdId: str(item.householdId),
    plan: str(item.plan),
    sk,
    eventTime,
    kind: str(item.kind),
  };
  if (isEvent) {
    const f = eventFacts(item, legacyAppId);
    return {
      appId,
      dt: eventTime.slice(0, 10),
      row: compact({
        recordType: 'event',
        ...common,
        sku: f.sku,
        amountMicroUsd: f.line.costMicroUsd,
        requestId: str(item.requestId) ?? sk.split('#').at(-1),
        provider: str(item.provider),
        requestedModel: str(item.requestedModel),
        servedModel: str(item.servedModel) ?? str(item.model),
        pricingVersion: str(item.pricingVersion),
        pricingBand: str(item.pricingBand),
        pricingTier: str(item.pricingTier),
        inputTokens: num(item.inputTokens),
        cacheReadTokens: num(item.cacheReadTokens) ?? num(item.cachedInputTokens),
        cacheWriteTokens: num(item.cacheWriteTokens),
        outputTokens: num(item.outputTokens),
        reasoningTokens: num(item.reasoningTokens),
        chars: num(item.chars),
        durationMs: num(item.durationMs),
        upstreamMs: num(item.upstreamMs),
        baseCostMicroUsd: num(item.baseCostMicroUsd),
        costMicroUsd: num(item.costMicroUsd),
        markupBps: num(item.markupBps),
        env: str(item.env),
        paidBy: str(item.paidBy),
        estimated: str(item.estimated),
        reservedMicroUsd: num(item.reservedMicroUsd),
      }),
    };
  }
  return {
    appId,
    dt: eventTime.slice(0, 10),
    row: compact({
      recordType: 'adjustment',
      ...common,
      sku: str(item.sku),
      amountMicroUsd: num(item.deltaMicroUsd),
      pricingBand: str(item.newPricingBand),
      pricingTier: str(item.newPricingTier),
      eventSk: str(item.eventSk),
      reason: str(item.reason),
      oldPricingVersion: str(item.oldPricingVersion),
      newPricingVersion: str(item.newPricingVersion),
      oldCostMicroUsd: num(item.oldCostMicroUsd),
      newCostMicroUsd: num(item.newCostMicroUsd),
      deltaMicroUsd: num(item.deltaMicroUsd),
      createdAt: str(item.createdAt),
    }),
  };
}

export const exportKey = (appId: string, dt: string, batchId: string) => `app=${appId}/dt=${dt}/${batchId}.json`;

export const toNdjson = (rows: ExportRow[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/**
 * Lambda event filter for the table stream: only new EVENT#/ADJUST# items reach the consumer
 * (no invocations, no cost for counter updates, profiles or prices). Values are arrays (OR).
 */
export const streamFilterPattern = (sk = tableKeys().sk) => ({
  eventName: ['INSERT'],
  dynamodb: { Keys: { [sk]: { S: [{ prefix: EVENT_PREFIX }, { prefix: ADJUST_PREFIX }] } } },
});

export interface StreamRun {
  appId: string;
  dt: string;
  /** The first record's eventID (globally unique): a retried run overwrites its own object. */
  batchId: string;
  /** Where Lambda resumes if this run fails (reportBatchItemFailures). */
  firstSequenceNumber: string;
  rows: ExportRow[];
}

/**
 * Splits stream records, in order, into runs of consecutive records with the same app and day.
 * Writing runs in order and stopping at the first failure means everything before the reported
 * sequence number was written exactly once and nothing after it was written at all.
 */
export function streamRuns(records: { eventId: string; sequenceNumber: string; item: ExportedItem }[]): StreamRun[] {
  const runs: StreamRun[] = [];
  for (const r of records) {
    const last = runs.at(-1);
    if (last && last.appId === r.item.appId && last.dt === r.item.dt) last.rows.push(r.item.row);
    else runs.push({ appId: r.item.appId, dt: r.item.dt, batchId: r.eventId, firstSequenceNumber: r.sequenceNumber, rows: [r.item.row] });
  }
  return runs;
}

/**
 * When the item reached the table (approximately): an adjustment's createdAt, an event's time.
 * The backfill only exports items from before the stream existed; later ones came through it.
 */
export const insertedAt = (row: ExportRow) => String(row.createdAt ?? row.eventTime);

/** Backfill objects, one per app and day, named so a re-run overwrites instead of duplicating. */
export function backfillObjects(items: ExportedItem[]): { key: string; rows: ExportRow[] }[] {
  const groups = new Map<string, ExportRow[]>();
  for (const i of items) {
    const key = exportKey(i.appId, i.dt, 'backfill');
    groups.set(key, [...(groups.get(key) ?? []), i.row]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, rows]) => ({ key, rows }));
}
