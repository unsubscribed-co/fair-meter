import { mockClient } from 'aws-sdk-client-mock';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  backfillObjects,
  EXPORT_COLUMNS,
  exportKey,
  exportRow,
  insertedAt,
  streamFilterPattern,
  streamRuns,
  toNdjson,
} from '../export';

process.env.BUCKET_NAME = 'export-bucket';
process.env.LEGACY_APP_ID = 'nieto';
// Imported after the env is set: the handler reads it at load time.
const { handler } = require('../export-handler') as typeof import('../export-handler');

const event = {
  PK: 'USER#u1',
  SK: 'EVENT#2026-10-01T03:00:00.000Z#nieto#req-1',
  appId: 'nieto',
  kind: 'chat',
  householdId: 'fam',
  plan: 'test',
  requestId: 'req-1',
  provider: 'deepseek',
  requestedModel: 'deepseek-v4-flash',
  servedModel: 'deepseek-v4-flash',
  model: 'deepseek-v4-flash',
  sku: 'deepseek-v4-flash',
  inputTokens: 1000,
  cacheReadTokens: 9000,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: 0,
  pricingBand: 'default',
  durationMs: 1200,
  upstreamMs: 1100,
  upstreamId: 'chatcmpl-1',
  pricingVersion: 'deepseek-v4-flash@2026-10-01',
  baseCostMicroUsd: 297,
  costMicroUsd: 297,
  markupBps: 0,
};

const adjustment = {
  PK: 'USER#u1',
  SK: 'ADJUST#2026-09-26T12:00:00.000Z#nieto#abc',
  adjustmentId: 'abc',
  appId: 'nieto',
  householdId: 'fam',
  eventSk: 'EVENT#2026-09-26T12:00:00.000Z#req-9',
  eventTime: '2026-09-26T12:00:00.000Z',
  month: '2026-09',
  day: '2026-09-26',
  kind: 'chat',
  sku: 'deepseek-v4-flash',
  newPricingBand: 'default',
  reason: 'reprice-offpeak',
  oldPricingVersion: 'deepseek-v4-flash@2026-09-01',
  newPricingVersion: 'deepseek-v4-flash@2026-09-01',
  oldCostMicroUsd: 594,
  newCostMicroUsd: 297,
  deltaMicroUsd: -297,
  createdAt: '2026-10-02T15:00:00.000Z',
};

describe('exportRow', () => {
  test('flattens an event; dt is the UTC day of the event', () => {
    expect(exportRow(event, 'nieto')).toEqual({
      appId: 'nieto',
      dt: '2026-10-01',
      row: {
        recordType: 'event', appId: 'nieto', sub: 'u1', householdId: 'fam', plan: 'test', sk: event.SK,
        eventTime: '2026-10-01T03:00:00.000Z', kind: 'chat', sku: 'deepseek-v4-flash', amountMicroUsd: 297,
        requestId: 'req-1', provider: 'deepseek', requestedModel: 'deepseek-v4-flash', servedModel: 'deepseek-v4-flash',
        pricingVersion: 'deepseek-v4-flash@2026-10-01', pricingBand: 'default', inputTokens: 1000, cacheReadTokens: 9000,
        cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0, durationMs: 1200, upstreamMs: 1100,
        baseCostMicroUsd: 297, costMicroUsd: 297, markupBps: 0,
      },
    });
  });

  test('an adjustment lands in its event day, amount = delta', () => {
    expect(exportRow(adjustment, 'nieto')).toEqual({
      appId: 'nieto',
      dt: '2026-09-26',
      row: {
        recordType: 'adjustment', appId: 'nieto', sub: 'u1', householdId: 'fam', sk: adjustment.SK,
        eventTime: '2026-09-26T12:00:00.000Z', kind: 'chat', sku: 'deepseek-v4-flash', amountMicroUsd: -297,
        pricingBand: 'default', eventSk: adjustment.eventSk, reason: 'reprice-offpeak',
        oldPricingVersion: 'deepseek-v4-flash@2026-09-01', newPricingVersion: 'deepseek-v4-flash@2026-09-01',
        oldCostMicroUsd: 594, newCostMicroUsd: 297, deltaMicroUsd: -297, createdAt: '2026-10-02T15:00:00.000Z',
      },
    });
  });

  test('legacy events: app, sku, request id and cache reads are normalized', () => {
    const legacy = {
      PK: 'USER#u1', SK: 'EVENT#2026-09-26T12:00:00.000Z#req-9', kind: 'chat', householdId: 'fam', model: 'deepseek-chat',
      inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, pricingVersion: 'deepseek-v4-flash@2026-09-01', costMicroUsd: 594, markupBps: 0,
    };
    expect(exportRow(legacy, 'nieto')!.row).toMatchObject({
      appId: 'nieto', sku: 'deepseek-v4-flash', requestId: 'req-9', servedModel: 'deepseek-chat', cacheReadTokens: 2, amountMicroUsd: 594,
    });
    expect(exportRow(legacy, 'nieto')!.row).not.toHaveProperty('plan');
  });

  test('other items are not exported', () => {
    expect(exportRow({ PK: 'USER#u1', SK: 'USAGE#nieto#2026-10', costMicroUsd: 1 }, 'nieto')).toBeUndefined();
    expect(exportRow({ PK: 'PRICING#x', SK: '2026-09-01' }, 'nieto')).toBeUndefined();
  });

  test('every row key is a Glue column (lowercased) and every column is typed', () => {
    const columns = new Set(EXPORT_COLUMNS.map((c) => c.name));
    expect(columns.size).toBe(EXPORT_COLUMNS.length);
    for (const item of [event, adjustment]) {
      for (const key of Object.keys(exportRow(item, 'nieto')!.row)) expect(columns).toContain(key.toLowerCase());
    }
    // Partition keys must not repeat as columns.
    expect(columns).not.toContain('app');
    expect(columns).not.toContain('dt');
  });

  test('keys, NDJSON and insertion time', () => {
    expect(exportKey('nieto', '2026-10-01', 'b1')).toBe('app=nieto/dt=2026-10-01/b1.json');
    expect(toNdjson([{ a: 1 }, { b: 'x' }])).toBe('{"a":1}\n{"b":"x"}\n');
    expect(insertedAt(exportRow(event, 'nieto')!.row)).toBe('2026-10-01T03:00:00.000Z');
    expect(insertedAt(exportRow(adjustment, 'nieto')!.row)).toBe('2026-10-02T15:00:00.000Z');
  });

  test('backfill: one object per app and day, deterministic names', () => {
    const rows = [event, adjustment, { ...event, SK: 'EVENT#2026-10-01T09:00:00.000Z#nieto#req-2' }].map((i) => exportRow(i, 'nieto')!);
    expect(backfillObjects(rows).map((o) => [o.key, o.rows.length])).toEqual([
      ['app=nieto/dt=2026-09-26/backfill.json', 1],
      ['app=nieto/dt=2026-10-01/backfill.json', 2],
    ]);
  });
});

describe('stream filter', () => {
  test('only INSERTs of EVENT# and ADJUST# items', () => {
    expect(streamFilterPattern()).toEqual({
      eventName: ['INSERT'],
      dynamodb: { Keys: { SK: { S: [{ prefix: 'EVENT#' }, { prefix: 'ADJUST#' }] } } },
    });
  });
});

describe('streamRuns', () => {
  test('consecutive records of the same app and day share an object named by the first eventID', () => {
    const rec = (id: string, item: Record<string, any>) => ({ eventId: id, sequenceNumber: `seq-${id}`, item: exportRow(item, 'nieto')! });
    const runs = streamRuns([
      rec('e1', event),
      rec('e2', { ...event, SK: 'EVENT#2026-10-01T04:00:00.000Z#nieto#req-2' }),
      rec('e3', adjustment),
      rec('e4', { ...event, SK: 'EVENT#2026-10-01T05:00:00.000Z#nieto#req-3' }),
    ]);
    expect(runs.map((r) => [r.appId, r.dt, r.batchId, r.firstSequenceNumber, r.rows.length])).toEqual([
      ['nieto', '2026-10-01', 'e1', 'seq-e1', 2],
      ['nieto', '2026-09-26', 'e3', 'seq-e3', 1],
      ['nieto', '2026-10-01', 'e4', 'seq-e4', 1],
    ]);
  });
});

describe('stream consumer', () => {
  const s3 = mockClient(S3Client);
  beforeEach(() => {
    s3.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const record = (id: string, item: Record<string, any>, eventName: 'INSERT' | 'MODIFY' = 'INSERT') => ({
    eventID: id,
    eventName,
    dynamodb: {
      SequenceNumber: `seq-${id}`,
      Keys: marshall({ PK: item.PK, SK: item.SK }),
      NewImage: marshall(item, { removeUndefinedValues: true }),
    },
  });
  const streamEvent = (...records: ReturnType<typeof record>[]) => ({ Records: records }) as unknown as DynamoDBStreamEvent;

  test('writes one NDJSON object per run', async () => {
    s3.on(PutObjectCommand).resolves({});
    const result = await handler(streamEvent(record('e1', event), record('e2', adjustment), record('e3', event, 'MODIFY')));
    expect(result).toEqual({ batchItemFailures: [] });
    const puts = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
    expect(puts.map((p) => [p.Bucket, p.Key])).toEqual([
      ['export-bucket', 'app=nieto/dt=2026-10-01/e1.json'],
      ['export-bucket', 'app=nieto/dt=2026-09-26/e2.json'],
    ]);
    expect(JSON.parse(String(puts[1].Body).trim())).toMatchObject({ recordType: 'adjustment', amountMicroUsd: -297 });
  });

  test('a failed write reports its first record and writes nothing after it', async () => {
    s3.on(PutObjectCommand).resolvesOnce({}).rejects(new Error('slow down'));
    const result = await handler(streamEvent(record('e1', event), record('e2', adjustment), record('e3', event)));
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-e2' }] });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(2);
  });
});
