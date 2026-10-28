import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DeepSeekReconciliation, MeteringExport, MeteringRetry } from '../cdk';
import { exportRow, streamFilterPattern } from '../export';
import { keys, setTableKeys, tableKeys } from '../keys';
import { usageTransaction, type UsageRecord } from '../ledger';
import { Meter } from '../meter';
import { versionRanges } from '../pricing';
import { eventFacts } from '../report';

/** Another app's table (StackSplit's shape): lowercase key attributes, people keyed by lowercased email. */
const STACKSPLIT = { pk: 'pk', sk: 'sk', userPrefix: 'PERSON#' };

const record: UsageRecord = {
  appId: 'stacksplit', sub: 'ana@example.com', householdId: 'h1', requestId: 'req-1',
  requestTime: '2026-10-15T12:00:00.000Z', kind: 'chat', pricingVersion: 'm@2026-10-01T00:00:00Z',
  details: { sku: 'm' }, counters: { inputTokens: 1 }, baseCostMicroUsd: 3, costMicroUsd: 3, markupBps: 0, deductCredit: true,
};
const tx = () => usageTransaction('t', record).input.TransactItems!;

afterEach(() => {
  setTableKeys(undefined);
  delete process.env.METERING_TABLE_KEYS;
});

describe('defaults are byte-identical to the keys before the setting', () => {
  test('keys, conditions and the stream filter', () => {
    expect(JSON.stringify(keys.profile('u1'))).toBe('{"PK":"USER#u1","SK":"PROFILE"}');
    expect(JSON.stringify(keys.event('u1', 't0', 'nieto', 'r1'))).toBe('{"PK":"USER#u1","SK":"EVENT#t0#nieto#r1"}');
    expect(JSON.stringify(keys.appDay('nieto', '2026-10-15'))).toBe('{"PK":"APP#nieto","SK":"DAILY#2026-10-15"}');
    const [put, , , , , , credit] = tx();
    expect(Object.keys(put.Put!.Item!).slice(0, 2)).toEqual(['PK', 'SK']);
    expect(put.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(credit.Update!.ConditionExpression).toBe('attribute_exists(PK)');
    expect(streamFilterPattern()).toEqual({
      eventName: ['INSERT'],
      dynamodb: { Keys: { SK: { S: [{ prefix: 'EVENT#' }, { prefix: 'ADJUST#' }] } } },
    });
  });
});

describe('another table: pk/sk attributes and its own user partition', () => {
  beforeEach(() => setTableKeys(STACKSPLIT));

  test('keys use the attribute names and the user prefix', () => {
    expect(keys.profile('ana@example.com')).toEqual({ pk: 'PERSON#ana@example.com', sk: 'PROFILE' });
    expect(keys.householdPlan('h1', 'stacksplit')).toEqual({ pk: 'HOUSEHOLD#h1', sk: 'PLAN#stacksplit' });
  });

  test('the usage transaction: items, keys and conditions', () => {
    const [put, userMonth, , , , , credit] = tx();
    expect(put.Put!.Item).toMatchObject({ pk: 'PERSON#ana@example.com', sk: 'EVENT#2026-10-15T12:00:00.000Z#stacksplit#req-1' });
    expect(put.Put!.Item).not.toHaveProperty('PK');
    expect(put.Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(userMonth.Update!.Key).toEqual({ pk: 'PERSON#ana@example.com', sk: 'USAGE#stacksplit#2026-10' });
    expect(credit.Update!.ConditionExpression).toBe('attribute_exists(pk)');
  });

  test('Meter reads and queries with the attribute names', async () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    const items: Record<string, Record<string, unknown>> = {
      'PERSON#ana@example.com|PROFILE': { householdId: 'h1' },
      'HOUSEHOLD#h1|META': {},
      'HOUSEHOLD#h1|PLAN#stacksplit': { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 1_000_000 },
    };
    ddbMock.on(GetCommand).callsFake(({ Key }) => ({ Item: items[`${Key.pk}|${Key.sk}`] }));
    ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'PRICING#m', sk: '2026-10-01T00:00:00Z', validFrom: '2026-10-01T00:00:00Z' }] });
    const meter = new Meter(
      { tableName: 't', appId: 'stacksplit', markupBps: 0, skuAliases: {}, retryQueueUrl: 'q', limits: { defaultDailyCapMicroUsd: 1, appDailyCapMicroUsd: 1 } },
      { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) },
    );
    const at = new Date('2026-10-15T12:00:00Z');
    expect(await meter.authorize('ana@example.com', at)).toMatchObject({ ok: true, caller: { sub: 'ana@example.com', householdId: 'h1' } });
    expect(await meter.pricingItem('m', at)).toMatchObject({ version: 'm@2026-10-01T00:00:00Z' });
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.KeyConditionExpression).toBe('pk = :pk AND sk <= :at');
    ddbMock.restore();
  });

  test('ledger readers find the sub and sort key', () => {
    const event = { pk: 'PERSON#ana@example.com', sk: 'EVENT#2026-10-15T12:00:00.000Z#stacksplit#req-1', appId: 'stacksplit', costMicroUsd: 3 };
    expect(exportRow(event, 'stacksplit')?.row).toMatchObject({ sub: 'ana@example.com', sk: event.sk, eventTime: '2026-10-15T12:00:00.000Z' });
    expect(eventFacts(event, 'stacksplit')).toMatchObject({ sub: 'ana@example.com', day: '2026-10-15' });
    expect(versionRanges([{ sk: '2026-10-01T00:00:00Z' }])[0]).toMatchObject({ sk: '2026-10-01T00:00:00Z', validFrom: '2026-10-01T00:00:00Z' });
    expect(streamFilterPattern().dynamodb.Keys).toHaveProperty('sk');
  });
});

test("the module's own Lambdas read the setting from METERING_TABLE_KEYS; bad names are refused", () => {
  process.env.METERING_TABLE_KEYS = '{"pk":"pk","sk":"sk"}';
  expect(tableKeys()).toEqual({ pk: 'pk', sk: 'sk', userPrefix: 'USER#' });
  expect(() => setTableKeys({ pk: 'pk = :x OR pk' })).toThrow(/Invalid table keys/);
  expect(() => setTableKeys({ pk: 'k', sk: 'k' })).toThrow(/Invalid table keys/);
});

describe('constructs', () => {
  function stack(props: { tableKeys?: typeof STACKSPLIT; metricNamespace: string }) {
    // No bundling: only the template matters here.
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const s = new cdk.Stack(app, 'S');
    const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, stream: dynamodb.StreamViewType.NEW_IMAGE });
    const alarmAction = { bind: () => ({ alarmActionArn: 'arn:aws:sns:us-east-2:111111111111:a' }) } as cloudwatch.IAlarmAction;
    new MeteringRetry(s, 'Retry', { table, alarmAction, tableKeys: props.tableKeys });
    new MeteringExport(s, 'Export', { table, alarmAction, appIds: ['stacksplit', 'other'], legacyAppId: 'stacksplit', firstDay: '2026-10-01', tableKeys: props.tableKeys });
    new DeepSeekReconciliation(s, 'Recon', {
      table, alarmAction, apiKeyParam: ssm.StringParameter.fromStringParameterName(s, 'K', '/k'), balanceUrl: 'https://b', metricNamespace: props.metricNamespace, tableKeys: props.tableKeys,
    });
    return Template.fromStack(s);
  }

  test('table keys, metric namespace and export appIds reach the template', () => {
    const t = stack({ tableKeys: STACKSPLIT, metricNamespace: 'StackSplit' });
    const env = Object.values(t.findResources('AWS::Lambda::Function')).map((f) => f.Properties.Environment.Variables);
    expect(env).toHaveLength(3);
    for (const v of env) expect(JSON.parse(v.METERING_TABLE_KEYS)).toEqual(STACKSPLIT);
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify(streamFilterPattern('sk')) }] },
    });
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ METRIC_NAMESPACE: 'StackSplit' }) } });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'StackSplit', MetricName: 'DeepSeekDriftBreached' });
    t.hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({ Parameters: Match.objectLike({ 'projection.app.values': 'stacksplit,other' }) }),
    });
  });

  test('defaults add no env and filter on SK', () => {
    const t = stack({ metricNamespace: 'Nieto' });
    expect(JSON.stringify(t.toJSON())).not.toContain('METERING_TABLE_KEYS');
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify(streamFilterPattern('SK')) }] },
    });
  });
});
