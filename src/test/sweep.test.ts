import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { setTableKeys } from '../keys';
import { sweep } from '../sweep-handler';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cfg = { appId: 'stacksplit', env: 'prod', tableName: 't' };
const AT = '2026-11-03T14:05:09.120Z';
const row = (callId: string) => ({
  pk: 'PENDING#stacksplit', sk: `CALL#${callId}`, person: 'ana@x.co', at: AT, sku: 'claude-haiku-5-5', provider: 'anthropic',
  pricingVersion: 'claude-haiku-5-5@2026-10-28T00:00:00Z', max: { inputTokens: 30_000, outputTokens: 4_096 }, reservedMicroUsd: 5_798, paidBy: 'credit', env: 'prod',
});
const minutes = (n: number) => new Date(Date.parse(AT) + n * 60_000);

beforeAll(() => setTableKeys({ pk: 'pk', sk: 'sk' }));
afterAll(() => setTableKeys(undefined));
beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('settles holds older than 30 minutes at their hold, swept; younger ones wait', async () => {
  ddbMock.on(QueryCommand).resolvesOnce({ Items: [row('a')], LastEvaluatedKey: { pk: 'PENDING#stacksplit', sk: 'CALL#a' } }).resolves({ Items: [row('b')] });
  expect(await sweep(ddb(), cfg, minutes(29))).toEqual({ settled: 0 });
  expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(QueryCommand).resolvesOnce({ Items: [row('a')], LastEvaluatedKey: { pk: 'PENDING#stacksplit', sk: 'CALL#a' } }).resolves({ Items: [row('b')] });
  expect(await sweep(ddb(), cfg, minutes(31))).toEqual({ settled: 2 });
  const queries = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
  expect(queries[0]).toMatchObject({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'PENDING#stacksplit' }, ConsistentRead: true });
  expect(queries[1].ExclusiveStartKey).toEqual({ pk: 'PENDING#stacksplit', sk: 'CALL#a' });
  const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
  expect(tx.TransactItems![0].Put!.Item).toMatchObject({
    sk: `EVENT#${AT}#stacksplit#a`, costMicroUsd: 5_798, estimated: 'swept', inputTokens: 30_000, outputTokens: 4_096, paidBy: 'credit', env: 'prod', reservedMicroUsd: 5_798,
  });
  expect(tx.TransactItems!.at(-1)!.Delete!.Key).toEqual({ pk: 'PENDING#stacksplit', sk: 'CALL#a' });
  expect(console.error).toHaveBeenCalledWith('SETTLED_BY_SWEEPER', expect.objectContaining({ callId: 'a', person: 'ana@x.co', sku: 'claude-haiku-5-5', reservedMicroUsd: 5_798 }));
});

test("L2: a sweeper that lost the race to the app's own settle neither counts nor alarms", async () => {
  ddbMock.on(QueryCommand).resolves({ Items: [row('a')] });
  ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('x'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }));
  ddbMock.on(GetCommand).resolves({ Item: { usageHash: 'the app settled it' } });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  expect(await sweep(ddb(), cfg, minutes(31))).toEqual({ settled: 0 });
  expect(console.error).not.toHaveBeenCalledWith('SETTLED_BY_SWEEPER', expect.anything());
  expect(console.log).toHaveBeenCalledWith('SWEEP_LOST_RACE', expect.objectContaining({ callId: 'a', outcome: 'duplicate' }));
});

test('a row that fails is retried on the next run; the run fails so the Errors alarm fires', async () => {
  ddbMock.on(QueryCommand).resolves({ Items: [row('a'), row('b')] });
  ddbMock.on(TransactWriteCommand).rejectsOnce(new Error('throttled')).resolves({});
  await expect(sweep(ddb(), cfg, minutes(31))).rejects.toThrow(/1 of 2/);
  expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
});
