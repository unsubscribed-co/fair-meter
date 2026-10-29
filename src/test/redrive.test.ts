import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import type { SQSEvent } from 'aws-lambda';
import { usageTransaction, type UsageRecord } from '../ledger';
import { redrive } from '../redrive-handler';
import { retryUsage } from '../retry-handler';

/* The nightly redrive against DynamoDB Local, SQS mocked. Skipped unless DYNAMODB_ENDPOINT is set. */
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');
const suite = endpoint ? describe : describe.skip;

const sqsMock = mockClient(SQSClient);
const sqs = new SQSClient({ region: 'us-east-1' });
const TABLE = `fair-meter-redrive-${Date.now()}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const ddb = DynamoDBDocumentClient.from(raw);
const cfg = { tableName: TABLE, queueUrl: 'https://sqs/retry', dlqUrl: 'https://sqs/dlq' };
const NOW = new Date('2026-11-04T04:00:00.000Z');
// DynamoDB Local keeps transaction tokens (app and call id) across tables: call ids unique per run.
const RUN = Date.now();

const record = (requestId: string): UsageRecord => ({
  appId: 'nieto', sub: 'u1', householdId: 'fam', requestId: `${requestId}-${RUN}`, requestTime: '2026-11-03T12:00:00.000Z', kind: 'tts',
  pricingVersion: 'gcp-tts-wavenet@2026-09-29', details: { chars: 10 }, counters: { ttsChars: 10 },
  baseCostMicroUsd: 40, costMicroUsd: 40, markupBps: 0, deductCredit: false,
});
/** The DLQ holds these messages once, then is empty. */
const dlq = (...bodies: string[]) => {
  sqsMock.reset();
  sqsMock.on(ReceiveMessageCommand)
    .resolvesOnce({ Messages: bodies.map((Body, i) => ({ MessageId: `m${i}`, ReceiptHandle: `r${i}`, Body })) })
    .resolves({});
  sqsMock.on(SendMessageCommand).resolves({});
  sqsMock.on(DeleteMessageCommand).resolves({});
};
const sent = () => sqsMock.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
const deleted = () => sqsMock.commandCalls(DeleteMessageCommand).map((c) => c.args[0].input);

suite('the nightly redrive against DynamoDB Local', () => {
  beforeAll(async () => {
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
  });
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('a valid record goes back to the retry queue and leaves the DLQ, counted by callId for 30 days; an invalid one stays', async () => {
    const body = JSON.stringify(record('valid'));
    dlq(body, 'not json');
    expect(await redrive(ddb, sqs, cfg, NOW)).toEqual({ redriven: 1, invalid: 1, limited: 0, failed: 0 });
    expect(sent()).toEqual([{ QueueUrl: 'https://sqs/retry', MessageBody: body }]);
    expect(deleted()).toEqual([{ QueueUrl: 'https://sqs/dlq', ReceiptHandle: 'r0' }]);
    const count = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'REDRIVE#nieto', SK: `CALL#valid-${RUN}` }, ConsistentRead: true }))).Item;
    expect(count).toEqual({ PK: 'REDRIVE#nieto', SK: `CALL#valid-${RUN}`, redrives: 1, expiresAt: Date.parse('2026-12-04T04:00:00.000Z') / 1000 });
  });

  test('a call is redriven at most 3 times: the fourth stays in the DLQ, REDRIVE_LIMIT', async () => {
    const body = JSON.stringify(record('poison'));
    for (let night = 1; night <= 3; night++) {
      dlq(body);
      expect(await redrive(ddb, sqs, cfg, NOW)).toEqual({ redriven: 1, invalid: 0, limited: 0, failed: 0 });
    }
    dlq(body);
    expect(await redrive(ddb, sqs, cfg, NOW)).toEqual({ redriven: 0, invalid: 0, limited: 1, failed: 0 });
    expect(sent()).toEqual([]);
    expect(deleted()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('REDRIVE_LIMIT', expect.objectContaining({ appId: 'nieto', callId: `poison-${RUN}`, redrives: 3 }));
  });

  test('a redriven record whose call is already recorded ends duplicate: one EVENT', async () => {
    const r = record('recorded');
    // Recorded the day before: its transaction token (10 minutes) is long gone, so only the EVENT key stops a second write.
    const tx = usageTransaction(TABLE, r);
    delete tx.input.ClientRequestToken;
    await ddb.send(tx);
    dlq(JSON.stringify(r));
    await redrive(ddb, sqs, cfg, NOW);
    const [{ MessageBody }] = sent();
    sqsMock.reset();
    const event = { Records: [{ messageId: 'q1', body: MessageBody }] } as unknown as SQSEvent;
    expect(await retryUsage(ddb, sqs, { tableName: TABLE, dlqUrl: cfg.dlqUrl }, event)).toEqual({ batchItemFailures: [] });
    expect(console.log).toHaveBeenCalledWith('USAGE_RECORD_RETRIED', { appId: 'nieto', requestId: `recorded-${RUN}`, outcome: 'duplicate' });
    const items = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'USER#u1' }, ConsistentRead: true }))).Items ?? [];
    expect(items.filter((i) => String(i.SK).startsWith('EVENT#') && String(i.SK).endsWith(`#recorded-${RUN}`))).toHaveLength(1);
  });
});
