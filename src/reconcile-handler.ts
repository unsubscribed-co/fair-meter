import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BALANCE_PREFIX, pkNotExists, tableKeys } from './keys';
import {
  DEEPSEEK_PROVIDER,
  balanceMetricData,
  driftMetricData,
  fetchDeepSeekBalance,
  parseDeepSeekBalance,
  providerDayFromItem,
  reconcile,
  reconcileWindows,
  snapshotFromItem,
  snapshotItem,
  type BalanceSnapshot,
  type ProviderDay,
  type Reconciliation,
} from './reconcile';

/*
 * Daily DeepSeek reconciliation (EventBridge, 00:00 UTC): snapshot the account balance, then
 * compare the window since the previous day-aligned snapshot with our PROVIDER#deepseek day
 * counters. Publishes DeepSeekDrift* metrics (the alarm watches DeepSeekDriftBreached) and logs
 * PROVIDER_DRIFT at error level when the window breaches. Any failure throws: EventBridge retries,
 * then the invocation-errors alarm fires.
 */
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const BALANCE_URL = process.env.BALANCE_URL ?? '';
const API_KEY_PARAM = process.env.API_KEY_PARAM ?? '';
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? '';
/** Snapshots this far back are read to find the window's start (covers weeks of failed runs). */
const LOOKBACK_DAYS = 62;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const cloudwatch = new CloudWatchClient({});

async function queryAll(input: QueryCommandInput): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const between = (pk: string, lo: string, hi: string): QueryCommandInput => ({
  TableName: TABLE_NAME,
  KeyConditionExpression: `${tableKeys().pk} = :pk AND ${tableKeys().sk} BETWEEN :lo AND :hi`,
  ExpressionAttributeValues: { ':pk': pk, ':lo': lo, ':hi': hi },
  ConsistentRead: true,
});

export async function handler(): Promise<Reconciliation | undefined> {
  const now = new Date();
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: API_KEY_PARAM, WithDecryption: true }));
  if (!Parameter?.Value) throw new Error(`SSM parameter ${API_KEY_PARAM} is empty`);

  const snapshot = {
    provider: DEEPSEEK_PROVIDER,
    takenAt: now.toISOString(),
    source: 'schedule',
    ...parseDeepSeekBalance(await fetchDeepSeekBalance(BALANCE_URL, Parameter.Value)),
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: snapshotItem(snapshot), ConditionExpression: pkNotExists() }));
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: METRIC_NAMESPACE,
    MetricData: balanceMetricData(snapshot, 'DeepSeek').map((m) => ({ ...m, Timestamp: now })),
  }));

  const pk = `PROVIDER#${DEEPSEEK_PROVIDER}`;
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const snapshots = (await queryAll(between(pk, `${BALANCE_PREFIX}${since}`, `${BALANCE_PREFIX}${snapshot.takenAt}`)))
    .map(snapshotFromItem)
    .filter((s): s is BalanceSnapshot => s !== undefined);
  const window = reconcileWindows(snapshots).at(-1);
  if (!window || window.end.takenAt !== snapshot.takenAt) {
    // First snapshot, a same-day re-run, or a run too late after midnight to close a day window.
    console.log('BALANCE_SNAPSHOT', { snapshot, window: 'none' });
    return undefined;
  }

  const days = (await queryAll(between(pk, `DAILY#${window.fromDay}`, `DAILY#${window.toDay}`)))
    .map(providerDayFromItem)
    .filter((d): d is ProviderDay => d !== undefined);
  const result = reconcile(window, days);
  const metrics = driftMetricData(result, 'DeepSeek');
  if (metrics.length) {
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: metrics.map((m) => ({ ...m, Timestamp: now })) }));
  }
  const summary = {
    fromDay: result.fromDay,
    toDay: result.toDay,
    status: result.status,
    providerSpendMicroUsd: result.providerSpendMicroUsd,
    meteredBaseMicroUsd: result.meteredBaseMicroUsd,
    requests: result.requests,
    diffMicroUsd: result.diffMicroUsd,
    driftBps: result.driftBps,
    balanceMicroUsd: snapshot.totalBalanceMicroUsd,
  };
  if (result.breached) console.error('PROVIDER_DRIFT', summary);
  else console.log('PROVIDER_RECONCILED', summary);
  return result;
}
