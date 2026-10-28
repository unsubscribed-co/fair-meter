import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import type { UsageRecord } from '../ledger';

const ddb = mockClient(DynamoDBDocumentClient);
let handler: (e: SQSEvent) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;

beforeAll(() => {
  process.env.TABLE_NAME = 'retry-table';
  ({ handler } = require('../retry-handler'));
});
beforeEach(() => {
  ddb.reset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
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
  ddb
    .on(TransactWriteCommand)
    .resolvesOnce({})
    .rejectsOnce(Object.assign(new Error('dup'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }))
    .rejectsOnce(new Error('still down'));
  const res = await handler(
    event(message('m1', JSON.stringify(record('a'))), message('m2', JSON.stringify(record('b'))), message('m3', JSON.stringify(record('c'))), message('m4', 'not json')),
  );
  // m2 was already recorded (duplicate = success); m3 failed again; m4 can never succeed (goes to the DLQ).
  expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm3' }, { itemIdentifier: 'm4' }] });
  expect(ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Put!.TableName).toBe('retry-table');
});
