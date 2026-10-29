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
  // The app's own table: metering must never touch it.
  new dynamodb.Table(s, 'AppTable', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING } });
  const fn = new lambda.Function(s, 'Api', {
    runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: lambda.Code.fromInline('x'),
    logGroup: new logs.LogGroup(s, 'ApiLogs'),
  });
  const metering = new Metering(s, 'Metering', { appId: 'stacksplit', env: 'prod', alarmAction, dailyCapUsd: '0.50', appDailyCapUsd: '5', ...props });
  metering.grant(fn);
  return { t: Template.fromStack(s), s, metering };
}

test('Metering owns one ledger table: on-demand, PK/SK, TTL, PITR, deletion protected, retained, named by CDK, a stack output', () => {
  const { t, s, metering } = synth();
  const ledger = Object.entries(t.findResources('AWS::DynamoDB::Table')).filter(([id]) => id.startsWith('Metering'));
  expect(ledger).toHaveLength(1);
  const [id, table] = ledger[0];
  expect(table).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  expect(table.Properties).toEqual({
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    DeletionProtectionEnabled: true,
  });
  expect(s.resolve(metering.table.tableName)).toEqual({ Ref: id });
  expect(Object.values(t.findOutputs('*')).map((o) => o.Value)).toContainEqual({ Ref: id });
});

test('the FAIR_METER env: the whole config as JSON, tokens resolved by CloudFormation', () => {
  const { t, s } = synth({ maxCallsPerMinute: 20 });
  const api = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('Api'))![1];
  const env = s.resolve(api.Properties.Environment.Variables.FAIR_METER);
  const json = JSON.stringify(env);
  for (const piece of ['"appId\\":\\"stacksplit\\"', '"env\\":\\"prod\\"', '"dailyCapMicroUsd\\":500000', '"appDailyCapMicroUsd\\":5000000', '"maxCallsPerMinute\\":20']) {
    expect(json).toContain(piece);
  }
  // The ledger table's default keys: no tableKeys.
  expect(json).not.toContain('tableKeys');
  // The table name and queue URL are CloudFormation references, not literals.
  expect(json).toContain('{"Ref":"MeteringLedger');
  expect(json).toContain('QueueUrl');
});

test('the app function may reserve, settle, read usage and queue', () => {
  const { t } = synth();
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  for (const action of ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'sqs:SendMessage']) expect(policies).toContain(action);
});

test("grant(fn), the retry Lambda and the sweeper reach the ledger table only, never the app's", () => {
  const { t } = synth();
  const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const dynamo = statements.filter((st) => [st.Action].flat().some((a: string) => a.startsWith('dynamodb:')));
  // The app function, the retry Lambda (two grants), the redrive and the sweeper.
  expect(dynamo).toHaveLength(5);
  for (const st of dynamo) expect(JSON.stringify(st.Resource)).toMatch(/^\[\{"Fn::GetAtt":\["MeteringLedger\w+","Arn"\]\}/);
  expect(JSON.stringify(statements)).not.toContain('AppTable');
});

test('a v0.2.0 table prop (untyped code) is refused at synth, pointing at the upgrade notes', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const s = new cdk.Stack(app, 'S');
  const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  const old = { table, appId: 'stacksplit', env: 'prod', dailyCapUsd: '0.50', appDailyCapUsd: '5' } as MeteringProps;
  expect(() => new Metering(s, 'Metering', old)).toThrow('v0.3.0 owns its ledger table: see Upgrading in the README');
});

test('without an alarmAction every alarm still exists, with no action', () => {
  const { t } = synth({ alarmAction: undefined });
  const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
  // Two on the DLQ, swept, sweeper failure, metering errors.
  expect(alarms).toHaveLength(5);
  for (const a of alarms) expect(a.Properties.AlarmActions).toBeUndefined();
});

test('the metering-error alarm watches the app function logs, the retry Lambda logs and the redrive logs (M2)', () => {
  const { t } = synth();
  const pattern = Match.stringLikeRegexp('METER_UNAVAILABLE.*PRICE_MISSING.*SERVICE_PAUSED.*CALL_EXCEEDS_CAP.*CALL_ID_REUSED.*USAGE_MISSING.*RECORD_CONFLICT.*USAGE_RECORD_FAILED.*RESERVATION_EXCEEDED.*USAGE_RECORD_PARKED');
  t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: pattern, LogGroupName: { Ref: Match.stringLikeRegexp('^ApiLogs') }, MetricTransformations: [Match.objectLike({ MetricName: 'stacksplit-prod-MeteringErrors' })] });
  // Conflicts found when a queued record is retried are logged there.
  t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: pattern, LogGroupName: { Ref: Match.stringLikeRegexp('^MeteringRetryLogs') }, MetricTransformations: [Match.objectLike({ MetricName: 'stacksplit-prod-MeteringErrors' })] });
  t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: pattern, LogGroupName: { Ref: Match.stringLikeRegexp('^MeteringRetryRedriveLogs') }, MetricTransformations: [Match.objectLike({ MetricName: 'stacksplit-prod-MeteringErrors' })] });
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

test("MeteringRetry with an alarmAction: v0.2.0's template (Nieto's construct)", () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const s = new cdk.Stack(app, 'S');
  const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  new MeteringRetry(s, 'Retry', { table, alarmAction });
  // The code asset's hash changes with any source edit; the template's shape is what's pinned.
  const json = JSON.stringify(Template.fromStack(s).toJSON()).replace(/"[0-9a-f]{64}\.zip"/g, '"<asset>.zip"');
  expect(JSON.parse(json)).toMatchSnapshot();
});

describe('MeteringRetry: park at once and the nightly redrive', () => {
  const retry = () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const s = new cdk.Stack(app, 'S');
    const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
    new MeteringRetry(s, 'Retry', { table, alarmAction });
    const t = Template.fromStack(s);
    const policy = (prefix: string) => Object.entries(t.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith(prefix))![1].Properties.PolicyDocument.Statement;
    const fn = (prefix: string) => Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith(prefix))![1].Properties;
    return { t, policy, fn };
  };
  const on = (statements: any[], action: string) => statements.filter((st) => [st.Action].flat().includes(action)).map((st) => JSON.stringify(st.Resource));

  test('the retry Lambda knows the DLQ and may send to it', () => {
    const { policy, fn } = retry();
    expect(fn('RetryFn').Environment.Variables.DLQ_URL).toEqual({ Ref: expect.stringMatching(/^RetryDlq/) });
    expect(on(policy('RetryFnServiceRoleDefaultPolicy'), 'sqs:SendMessage')).toEqual([expect.stringMatching(/"RetryDlq\w+","Arn"/)]);
  });

  test('the redrive runs at 04:00 UTC, receives and deletes on the DLQ, sends to the source queue and updates the table only', () => {
    const { t, policy, fn } = retry();
    const redrive = fn('RetryRedrive');
    expect(Object.keys(redrive.Environment.Variables)).toEqual(expect.arrayContaining(['TABLE_NAME', 'QUEUE_URL', 'DLQ_URL']));
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 4 * * ? *)', Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^RetryRedrive'), 'Arn'] } })] });
    const st = policy('RetryRedriveServiceRoleDefaultPolicy');
    expect(on(st, 'sqs:ReceiveMessage')).toEqual([expect.stringMatching(/"RetryDlq\w+","Arn"/)]);
    expect(on(st, 'sqs:DeleteMessage')).toEqual([expect.stringMatching(/"RetryDlq\w+","Arn"/)]);
    expect(on(st, 'sqs:SendMessage')).toEqual([expect.stringMatching(/"RetryQueue\w+","Arn"/)]);
    expect(on(st, 'dynamodb:UpdateItem')).toEqual([expect.stringMatching(/"T\w+","Arn"/)]);
    const dynamo = st.flatMap((s: any) => [s.Action].flat()).filter((a: string) => a.startsWith('dynamodb:'));
    expect(dynamo).toEqual(['dynamodb:UpdateItem']);
  });
});

test('MeteringRetry without an alarmAction: both DLQ alarms, no action', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const s = new cdk.Stack(app, 'S');
  const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  new MeteringRetry(s, 'Retry', { table });
  const alarms = Object.values(Template.fromStack(s).findResources('AWS::CloudWatch::Alarm'));
  expect(alarms.map((a) => a.Properties.MetricName).sort()).toEqual(['ApproximateAgeOfOldestMessage', 'ApproximateNumberOfMessagesVisible']);
  for (const a of alarms) expect(a.Properties.AlarmActions).toBeUndefined();
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
