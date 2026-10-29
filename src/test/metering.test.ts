import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Metering, MeteringRetry, type MeteringProps } from '../cdk';
import { EXPORT_COLUMNS, exportRow } from '../export';

const alarmAction = { bind: () => ({ alarmActionArn: 'arn:aws:sns:us-east-2:111111111111:a' }) } as cloudwatch.IAlarmAction;

function synth(props: Partial<MeteringProps> = {}) {
  // No bundling: only the template matters here.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const s = new cdk.Stack(app, 'S');
  const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING } });
  const fn = new lambda.Function(s, 'Api', {
    runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('x'),
    logGroup: new logs.LogGroup(s, 'ApiLogs'),
  });
  const metering = new Metering(s, 'Metering', {
    table, appId: 'stacksplit', env: 'prod', alarmAction, tableKeys: { pk: 'pk', sk: 'sk' }, dailyCapUsd: '0.50', appDailyCapUsd: '5', ...props,
  });
  metering.grant(fn);
  return { t: Template.fromStack(s), s };
}

test('the FAIR_METER env: the whole config as JSON, tokens resolved by CloudFormation', () => {
  const { t, s } = synth({ maxCallsPerMinute: 20 });
  const api = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('Api'))![1];
  const env = s.resolve(api.Properties.Environment.Variables.FAIR_METER);
  const json = JSON.stringify(env);
  for (const piece of ['"appId\\":\\"stacksplit\\"', '"env\\":\\"prod\\"', '"dailyCapMicroUsd\\":500000', '"appDailyCapMicroUsd\\":5000000', '"maxCallsPerMinute\\":20', '"tableKeys\\":{\\"pk\\":\\"pk\\",\\"sk\\":\\"sk\\"}']) {
    expect(json).toContain(piece);
  }
  // The table name and queue URL are CloudFormation references, not literals.
  expect(json).toContain('Ref');
  expect(json).toContain('QueueUrl');
});

test('the app function may reserve, settle and queue', () => {
  const { t } = synth();
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  for (const action of ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'sqs:SendMessage']) expect(policies).toContain(action);
});

test('the metering-error alarm watches the app function logs', () => {
  const { t } = synth();
  t.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: Match.stringLikeRegexp('METER_UNAVAILABLE.*PRICE_MISSING.*SERVICE_PAUSED.*CALL_EXCEEDS_CAP.*CALL_ID_REUSED.*USAGE_MISSING.*RECORD_CONFLICT.*USAGE_RECORD_FAILED'),
    LogGroupName: { Ref: Match.stringLikeRegexp('^ApiLogs') },
  });
  t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'stacksplit-prod-MeteringErrors', Threshold: 1, Period: 300, AlarmActions: ['arn:aws:sns:us-east-2:111111111111:a'] });
});

test('the sweeper: every 10 minutes, 60 s, ARM, 256 MB, logs kept a month, alarms on each sweep and on errors', () => {
  const { t } = synth();
  const sweeper = Object.values(t.findResources('AWS::Lambda::Function')).find((f) => f.Properties.Timeout === 60)!;
  expect(sweeper.Properties).toMatchObject({ Timeout: 60, MemorySize: 256, Architectures: ['arm64'], Runtime: 'nodejs24.x' });
  expect(sweeper.Properties.Environment.Variables.FAIR_METER).toBeDefined();
  t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(10 minutes)' });
  t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '"SETTLED_BY_SWEEPER"' });
  t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'stacksplit-prod-SettledBySweeper', Period: 600, Threshold: 1 });
  t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Errors', Threshold: 1 });
});

test("the retry Lambda can also read EVENTs and delete PENDING rows (granted here, so MeteringRetry's own template doesn't change)", () => {
  const { t } = synth();
  const retryPolicy = Object.entries(t.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('MeteringRetryFnServiceRoleDefaultPolicy'))![1];
  const actions = JSON.stringify(retryPolicy);
  for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem']) expect(actions).toContain(action);
});

test('the DLQ age alarm: a parked record has a week left to be redriven (M3)', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const s = new cdk.Stack(app, 'S');
  const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  new MeteringRetry(s, 'Retry', { table, alarmAction });
  Template.fromStack(s).hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ApproximateAgeOfOldestMessage', Threshold: 7 * 86_400, ComparisonOperator: 'GreaterThanOrEqualToThreshold', AlarmActions: Match.anyValue(),
  });
});

test.each([
  ["billing 'hosted'", { billing: 'hosted' as const }],
  ['a bad appId', { appId: 'Stack Split' }],
  ['a cap with 7 decimals', { dailyCapUsd: '0.0000001' }],
  ['a daily cap above the app cap', { dailyCapUsd: '6' }],
  ['a zero cap', { dailyCapUsd: '0' }],
  ['a fractional brake', { maxCallsPerMinute: 1.5 }],
])('T19: refused at synth: %s', (_, bad) => {
  expect(() => synth(bad)).toThrow();
});

test('the export gains env, paidBy, estimated and reservedMicroUsd at the end of its columns', () => {
  expect(EXPORT_COLUMNS.slice(-4)).toEqual([
    { name: 'env', type: 'string' }, { name: 'paidby', type: 'string' }, { name: 'estimated', type: 'string' }, { name: 'reservedmicrousd', type: 'bigint' },
  ]);
  const row = exportRow({ PK: 'USER#u', SK: 'EVENT#2026-11-03T14:05:09.120Z#stacksplit#c', appId: 'stacksplit', costMicroUsd: 5, env: 'prod', paidBy: 'credit', estimated: 'swept', reservedMicroUsd: 9 }, 'nieto')!.row;
  expect(row).toMatchObject({ env: 'prod', paidBy: 'credit', estimated: 'swept', reservedMicroUsd: 9 });
});
