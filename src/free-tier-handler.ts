import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { freeTierMetricData, freeTierPct, previousUtcMonth, setSize } from './free-tier';
import { keys, utcMonth } from './keys';

/*
 * FreeTierWatch (cdk.ts), hourly: reads this UTC month's PROVIDER#<provider> / MONTH# counter and
 * publishes it with its percent of the cap; the alarms on <prefix>Pct email once it passes the
 * threshold (and 100 %) and clear when a new month starts. Any failure throws, and its own alarm fires.
 *
 * Optional share count (SHARE_FROM_SET -> SHARE_TO): once a month, the size of last month's string set
 * (e.g. voiceHouseholds: households that used the provider) is copied onto this month's item, set
 * only if absent, so the proxy divides a shared pool with one read and no scan.
 */
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const PROVIDER = process.env.PROVIDER ?? '';
const COUNTER = process.env.COUNTER ?? '';
const LIMIT = Number(process.env.LIMIT ?? 0);
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? '';
const METRIC_PREFIX = process.env.METRIC_PREFIX ?? '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cloudwatch = new CloudWatchClient({});

export async function handler(): Promise<{ month: string; used: number; pct: number; shareCount?: number }> {
  const now = new Date();
  const month = utcMonth(now);
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.providerMonth(PROVIDER, month) }));
  const used = Number(Item?.[COUNTER] ?? 0);
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: METRIC_NAMESPACE,
    MetricData: freeTierMetricData(METRIC_PREFIX, used, LIMIT).map((m) => ({ ...m, Timestamp: now })),
  }));
  const summary = { provider: PROVIDER, counter: COUNTER, month, used, limit: LIMIT, pct: freeTierPct(used, LIMIT) };
  console.log('FREE_TIER_CHECKED', summary);

  let shareCount: number | undefined;
  const shareFrom = process.env.SHARE_FROM_SET ?? '';
  const shareTo = process.env.SHARE_TO ?? '';
  if (shareFrom && shareTo && Item?.[shareTo] === undefined) {
    const lastMonth = previousUtcMonth(now);
    const { Item: last } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.providerMonth(PROVIDER, lastMonth), ConsistentRead: true }));
    shareCount = setSize(last?.[shareFrom]);
    // if_not_exists: a second run (or a retry) never changes this month's divisor.
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.providerMonth(PROVIDER, month),
      UpdateExpression: 'SET #to = if_not_exists(#to, :n)',
      ExpressionAttributeNames: { '#to': shareTo },
      ExpressionAttributeValues: { ':n': shareCount },
    }));
    console.log('FREE_TIER_SHARE_COUNTED', { provider: PROVIDER, month, from: `${lastMonth} ${shareFrom}`, [shareTo]: shareCount });
  }
  return { month, used, pct: summary.pct, ...(shareCount !== undefined ? { shareCount } : {}) };
}
