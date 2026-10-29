import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { holdRecord, type FairMeterConfig, type HoldFacts } from './fair-meter';
import { setTableKeys, skOf, tableKeys } from './keys';
import { absorbedOf, recordUsage } from './ledger';

/**
 * Settles reservations nobody settled: the app's Lambda died between authorize and the settle
 * write (or both the write and the queue failed). Each is settled at its reservation, marked
 * `estimated: 'swept'`, and logged SETTLED_BY_SWEEPER, which alarms. If the real usage turns up
 * later, `recordUsage` trues it up with an ADJUST.
 *
 * 30 minutes is more than any Lambda's timeout (15 min) plus the retry queue's window (~10 min),
 * so a deferred settle normally lands first.
 */
export const SWEEP_AFTER_MS = 30 * 60_000;

export async function sweep(ddb: DynamoDBDocumentClient, cfg: Pick<FairMeterConfig, 'appId' | 'env' | 'tableName'>, now: Date): Promise<{ settled: number }> {
  let settled = 0;
  let failed = 0;
  let seen = 0;
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: cfg.tableName,
      KeyConditionExpression: `${tableKeys().pk} = :pk`,
      ExpressionAttributeValues: { ':pk': `PENDING#${cfg.appId}` },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    for (const row of page.Items ?? []) {
      if (!(Date.parse(row.at) < now.getTime() - SWEEP_AFTER_MS)) continue;
      seen++;
      const callId = skOf(row).slice('CALL#'.length);
      try {
        const record = holdRecord({ appId: cfg.appId, env: String(row.env ?? cfg.env), callId, hold: row as HoldFacts }, 'swept');
        const outcome = await recordUsage(ddb, cfg.tableName, record);
        const facts = { appId: cfg.appId, callId, person: row.person, sku: row.sku, at: row.at, reservedMicroUsd: row.reservedMicroUsd, absorbedMicroUsd: absorbedOf(record), outcome };
        if (outcome === 'recorded') {
          console.error('SETTLED_BY_SWEEPER', facts);
          settled++;
        } else {
          // The app's own settle or release got there first (or a late true-up did): nothing to alarm.
          console.log('SWEEP_LOST_RACE', facts);
        }
      } catch (err) {
        console.error('SWEEP_FAILED', { appId: cfg.appId, callId, err });
        failed++;
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // The rows stay pending (caps stay conservative); the next run retries them.
  if (failed) throw new Error(`Sweeper: ${failed} of ${seen} pending rows could not be settled`);
  return { settled };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Every 10 minutes (the Metering construct's schedule). FAIR_METER is the app's own config. */
export async function handler(): Promise<{ settled: number }> {
  const cfg = JSON.parse(process.env.FAIR_METER ?? '{}') as FairMeterConfig;
  if (cfg.tableKeys) setTableKeys(cfg.tableKeys);
  return sweep(ddb, cfg, new Date());
}
