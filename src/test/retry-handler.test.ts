import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSEvent } from 'aws-lambda';
import type { UsageRecord } from '../ledger';

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);
let handler: (e: SQSEvent) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;

beforeAll(() => {
  process.env.TABLE_NAME = 'retry-table';
  process.env.DLQ_URL = 'https://sqs/dlq';
  ({ handler } = require('../retry-handler'));
});
beforeEach(() => {
  ddb.reset();
  sqs.reset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const record = (requestId: string): UsageRecord => ({
  appId: 'nieto', sub: 'u1', householdId: 'fam', requestId, requestTime: '2026-10-15T12:00:00.000Z', kind: 'tts',
  pricingVersion: 'gcp-tts-wavenet@2026-09-29', details: { chars: 10 }, counters: { ttsChars: 10 },
  baseCostMicroUsd: 40, costMicroUsd: 40, markupBps: 0, deductCredit: false,
});
const message = (id: string, body: string) => ({ messageId: id, body, attributes: { ApproximateReceiveCount: '1' } });
const event = (...records: ReturnType<typeof message>[]) => ({ Records: records }) as unknown as SQSEvent;

test('records queued usage idempotently and reports only failures for redelivery', async () => {
  sqs.on(SendMessageCommand).resolves({});
  ddb
    .on(TransactWriteCommand)
    .resolvesOnce({})
    .rejectsOnce(Object.assign(new Error('dup'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }))
    .rejectsOnce(new Error('still down'));
  const res = await handler(
    event(message('m1', JSON.stringify(record('a'))), message('m2', JSON.stringify(record('b'))), message('m3', JSON.stringify(record('c'))), message('m4', 'not json')),
  );
  // m2 was already recorded (duplicate = success); m3 failed again; m4 can never succeed: parked in the DLQ at once.
  expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm3' }] });
  expect(ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Put!.TableName).toBe('retry-table');
});

test.each([
  ['not JSON', 'not json'],
  ['JSON that is not an object', 'null'],
  ['no appId', JSON.stringify({ ...record('x'), appId: undefined })],
  ['no sub', JSON.stringify({ ...record('x'), sub: '' })],
  ['no requestId', JSON.stringify({ ...record('x'), requestId: undefined })],
  ['no requestTime', JSON.stringify({ ...record('x'), requestTime: undefined })],
  ["a transaction that can't be built", JSON.stringify({ ...record('x'), counters: { 'bad name': 1 } })],
])('a message with %s is parked in the DLQ as is, logged, and not a failure', async (_, body) => {
  sqs.on(SendMessageCommand).resolves({});
  const res = await handler(event(message('m1', body)));
  expect(res).toEqual({ batchItemFailures: [] });
  expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  expect(sqs.commandCalls(SendMessageCommand).map((c) => c.args[0].input)).toEqual([{ QueueUrl: 'https://sqs/dlq', MessageBody: body }]);
  expect(console.error).toHaveBeenCalledWith('USAGE_RECORD_PARKED', expect.objectContaining({ messageId: 'm1' }));
});

test('a malformed message whose DLQ send fails is a batch item failure, as before', async () => {
  sqs.on(SendMessageCommand).rejects(new Error('sqs down'));
  const res = await handler(event(message('m1', 'not json')));
  expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
});
