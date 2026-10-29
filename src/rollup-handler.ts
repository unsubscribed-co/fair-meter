import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ACTION_LAG_MS } from './actions';
import type { FairMeterConfig } from './fair-meter';
import { keys, pkNotExists, setTableKeys, skOf, tableKeys } from './keys';
import { recordUsage, type UsageRecord } from './ledger';
import { QUERY_ROW_LIMIT, runQuery } from './logs-insights';
import { priceCall, versionStartedBy, versionCovers } from './pricing';

/*
 * The action rollup: every 15 minutes, one Logs Insights query per fixed 15-minute UTC window that
 * closed at least 15 minutes ago (Lambda lines can arrive 5 to 10 minutes late), and one EVENT per
 * person, SKU and window, exactly once. An action is in committed at most ACTION_LAG_MS (45 minutes)
 * after it happens: the floor's premise.
 */
export const WINDOW_MS = 15 * 60_000;
/** A window is due once its start is this far behind the clock. */
export const DUE_MS = 2 * WINDOW_MS;
/** Catch-up per run, so a run stays well inside its timeout. */
export const MAX_WINDOWS = 8;

/** The Logs Insights query for one window: the lines `action()` writes, summed per person, SKU and env. */
export function actionQuery(appId: string, windowStart: number): string {
  return [
    `filter fairMeter = "action" and appId = "${appId}" and @timestamp >= ${windowStart} and @timestamp < ${windowStart + WINDOW_MS}`,
    'stats sum(n) as n by person, sku, env',
  ].join(' | ');
}

export async function rollup(
  ddb: DynamoDBDocumentClient,
  cwl: CloudWatchLogsClient,
  cfg: Pick<FairMeterConfig, 'appId' | 'env' | 'tableName'>,
  logGroups: string[],
  now: Date,
): Promise<{ windows: number; recorded: number; duplicate: number }> {
  const done = { windows: 0, recorded: 0, duplicate: 0 };
  try {
    if (!logGroups.length) throw new Error('No log groups to query: grant a function first');
    const key = keys.rollupCursor(cfg.appId);
    const { Item } = await ddb.send(new GetCommand({ TableName: cfg.tableName, Key: key, ConsistentRead: true }));
    if (!Item) {
      // No backfill before the deploy: the current window is the first one settled.
      const lastWindowStart = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS - WINDOW_MS).toISOString();
      await ddb.send(new PutCommand({ TableName: cfg.tableName, Item: { ...key, lastWindowStart }, ConditionExpression: pkNotExists() }))
        .catch((err) => { if (err?.name !== 'ConditionalCheckFailedException') throw err; });
      return done;
    }
    let start = Date.parse(Item.lastWindowStart) + WINDOW_MS;
    // Not settled within the rollup lag (a run missed, failed or blocked): the floor no longer holds.
    if (start + ACTION_LAG_MS < now.getTime()) console.error('ROLLUP_LATE', { appId: cfg.appId, windowStart: new Date(start).toISOString(), minutesLate: Math.floor((now.getTime() - start - ACTION_LAG_MS) / 60_000) });
    const prices = new Map<string, Record<string, any>[]>();
    for (; done.windows < MAX_WINDOWS && start + DUE_MS <= now.getTime(); start += WINDOW_MS) {
      const windowStart = new Date(start).toISOString();
      const rows = await runQuery(cwl, {
        logGroupNames: logGroups,
        // Whole seconds, both ends inclusive: the query's own @timestamp filter keeps windows apart.
        startTime: start / 1000,
        endTime: (start + WINDOW_MS) / 1000,
        queryString: actionQuery(cfg.appId, start),
      });
      if (rows.length >= QUERY_ROW_LIMIT) {
        console.error('ROLLUP_TRUNCATED', { appId: cfg.appId, windowStart, rows: rows.length });
        throw new Error(`Rollup: the ${windowStart} window has ${rows.length} rows or more`);
      }
      const records: UsageRecord[] = [];
      for (const row of rows) {
        const { person, sku, env, n } = Object.fromEntries(row.map((f) => [f.field, f.value]));
        const count = Number(n);
        if (!person || !sku || !env || !(Number.isSafeInteger(count) && count > 0)) throw new Error(`Rollup: unreadable row in the ${windowStart} window: ${JSON.stringify(row)}`);
        const price = await priceAt(ddb, cfg.tableName, prices, sku, new Date(start));
        const priced = price && priceCall(price.item, { units: count }, new Date(start));
        if (!priced || 'error' in priced) {
          // The cursor stays: the next run retries this window, with the price once it is synced.
          console.error('ACTION_UNPRICED', { appId: cfg.appId, sku, windowStart, version: price?.version });
          return done;
        }
        records.push({
          appId: cfg.appId,
          sub: person,
          requestId: `actions-${sku}-${windowStart}`,
          requestTime: windowStart,
          kind: 'actions',
          pricingVersion: price.version,
          details: { provider: 'aws', sku, actions: count },
          counters: { actions: count },
          baseCostMicroUsd: priced.costMicroUsd,
          costMicroUsd: priced.costMicroUsd,
          markupBps: 0,
          deductCredit: false,
          env,
        });
      }
      for (const r of records) {
        // Without a hold, recordUsage resolves only these two (anything else throws).
        done[(await recordUsage(ddb, cfg.tableName, r)) as 'recorded' | 'duplicate']++;
      }
      await ddb.send(new UpdateCommand({
        TableName: cfg.tableName,
        Key: key,
        UpdateExpression: 'SET lastWindowStart = :w',
        // An overlapping run that got further keeps its cursor.
        ConditionExpression: 'lastWindowStart < :w',
        ExpressionAttributeValues: { ':w': windowStart },
      })).catch((err) => { if (err?.name !== 'ConditionalCheckFailedException') throw err; });
      done.windows++;
    }
    return done;
  } catch (err) {
    console.error('ROLLUP_FAILED', { appId: cfg.appId, ...done, err });
    throw err;
  }
}

/** The SKU's version valid at `at`, its versions read once per run. */
async function priceAt(ddb: DynamoDBDocumentClient, table: string, cache: Map<string, Record<string, any>[]>, sku: string, at: Date) {
  let versions = cache.get(sku);
  if (!versions) {
    // shortcut: one page (1 MB, thousands of versions); paginate if a SKU ever gets near that.
    const { Items = [] } = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: `${tableKeys().pk} = :pk`,
      ExpressionAttributeValues: { ':pk': `PRICING#${sku}` },
      ConsistentRead: true,
    }));
    versions = Items;
    cache.set(sku, versions);
  }
  const item = versionStartedBy(versions, at, skOf);
  return item && versionCovers(item, at) ? { version: `${sku}@${skOf(item)}`, item } : undefined;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cwl = new CloudWatchLogsClient({});

/** Every 15 minutes on the quarter hour (the Metering construct's schedule). FAIR_METER is the app's own config. */
export async function handler(): Promise<{ windows: number; recorded: number; duplicate: number }> {
  const cfg = JSON.parse(process.env.FAIR_METER ?? '{}') as FairMeterConfig;
  if (cfg.tableKeys) setTableKeys(cfg.tableKeys);
  return rollup(ddb, cwl, cfg, (process.env.LOG_GROUPS ?? '').split(',').filter(Boolean), new Date());
}
