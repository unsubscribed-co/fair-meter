import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { clientRequestToken, isAlreadyRecorded, recordProvider, recordUsage, usageTransaction, type UsageRecord } from '../ledger';

const record: UsageRecord = {
  appId: 'nieto',
  sub: 'u1',
  householdId: 'fam',
  plan: 'test',
  requestId: 'req-1',
  requestTime: '2026-10-31T23:59:59.900Z',
  kind: 'chat',
  pricingVersion: 'deepseek-v4-flash@2026-10-01',
  details: { sku: 'deepseek-v4-flash', inputTokens: 10, durationMs: 1200 },
  counters: { inputTokens: 10, outputTokens: 5 },
  baseCostMicroUsd: 7,
  costMicroUsd: 7,
  markupBps: 0,
  deductCredit: false,
};

const items = (r: UsageRecord) => usageTransaction('t', r).input.TransactItems!;

describe('usageTransaction', () => {
  test('event and per-app counters in one transaction, bucketed by request time', () => {
    const tx = items(record);
    expect(tx).toHaveLength(6);
    expect(tx[0].Put!.Item).toMatchObject({
      PK: 'USER#u1',
      SK: 'EVENT#2026-10-31T23:59:59.900Z#nieto#req-1',
      appId: 'nieto',
      plan: 'test',
      requestId: 'req-1',
      sku: 'deepseek-v4-flash',
      durationMs: 1200,
      costMicroUsd: 7,
    });
    expect(tx[0].Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(tx.slice(1).map((t) => t.Update!.Key)).toEqual([
      { PK: 'USER#u1', SK: 'USAGE#nieto#2026-10' },
      { PK: 'USER#u1', SK: 'DAILY#nieto#2026-10-31' },
      { PK: 'HOUSEHOLD#fam', SK: 'USAGE#nieto#2026-10' },
      { PK: 'APP#nieto', SK: 'DAILY#2026-10-31' },
      { PK: 'GLOBAL', SK: 'DAILY#2026-10-31' },
    ]);
    for (const t of tx.slice(1)) {
      expect(t.Update!.UpdateExpression).toBe('ADD requests :one, inputTokens :c0, outputTokens :c1, costMicroUsd :cost');
      expect(t.Update!.ExpressionAttributeValues).toEqual({ ':one': 1, ':c0': 10, ':c1': 5, ':cost': 7 });
    }
  });

  test('legacy prepaid households also pay from the credit balance', () => {
    const tx = items({ ...record, plan: undefined, deductCredit: true });
    expect(tx).toHaveLength(7);
    expect(tx[0].Put!.Item).not.toHaveProperty('plan');
    expect(tx[6].Update).toMatchObject({
      Key: { PK: 'HOUSEHOLD#fam', SK: 'META' },
      UpdateExpression: 'ADD creditBalanceMicroUsd :neg',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':neg': -7 },
    });
  });

  test('records priced for a provider also add our base cost to its day counter (all apps)', () => {
    const tx = items({ ...record, details: { ...record.details, provider: 'deepseek' }, costMicroUsd: 9, markupBps: 2_500 });
    expect(tx).toHaveLength(7);
    expect(tx[6].Update).toEqual({
      TableName: 't',
      Key: { PK: 'PROVIDER#deepseek', SK: 'DAILY#2026-10-31' },
      UpdateExpression: 'ADD requests :one, inputTokens :c0, outputTokens :c1, baseCostMicroUsd :base',
      ExpressionAttributeValues: { ':one': 1, ':c0': 10, ':c1': 5, ':base': 7 },
    });
    // With credit deduction too: 8 items, far below DynamoDB's 100-item transaction limit.
    expect(items({ ...record, details: { provider: 'deepseek' }, deductCredit: true })).toHaveLength(8);
    // Records without a provider and malformed names add no provider counter.
    expect(recordProvider(record)).toBeUndefined();
    expect(recordProvider({ details: { provider: 'Deep#Seek' } })).toBeUndefined();
    expect(items({ ...record, details: { provider: 'Deep#Seek' } })).toHaveLength(6);
  });

  test('a record queued before the provider counter existed gets it on retry (provider was already in details)', () => {
    const queued = JSON.parse(JSON.stringify({ ...record, details: { ...record.details, provider: 'deepseek' } })) as UsageRecord;
    expect(items(queued)[6].Update!.Key).toEqual({ PK: 'PROVIDER#deepseek', SK: 'DAILY#2026-10-31' });
  });

  test('is deterministic, so a retry sends the identical transaction and token', () => {
    expect(usageTransaction('t', record).input).toEqual(usageTransaction('t', JSON.parse(JSON.stringify(record))).input);
    expect(usageTransaction('t', record).input.ClientRequestToken).toBe(clientRequestToken('nieto', 'req-1'));
    expect(clientRequestToken('nieto', 'req-1')).toHaveLength(32);
    expect(clientRequestToken('other-app', 'req-1')).not.toBe(clientRequestToken('nieto', 'req-1'));
  });

  test('refuses counter names that could inject into the update expression', () => {
    expect(() => usageTransaction('t', { ...record, counters: { 'x, SET y': 1 } })).toThrow();
  });

  test('a call that uses up a free tier adds to the provider month counter in the same transaction', () => {
    const tts: UsageRecord = {
      ...record,
      kind: 'tts',
      details: { sku: 'gcp-tts-chirp3-hd-free', chars: 120 },
      counters: { ttsChars: 120 },
      baseCostMicroUsd: 0,
      costMicroUsd: 0,
      providerMonth: { provider: 'gcp-tts', counters: { premiumChars: 120 } },
    };
    const tx = items(tts);
    expect(tx).toHaveLength(7);
    // Bucketed by the request's UTC month, like every other counter.
    expect(tx[6].Update).toEqual({
      TableName: 't',
      Key: { PK: 'PROVIDER#gcp-tts', SK: 'MONTH#2026-10' },
      UpdateExpression: 'ADD requests :one, premiumChars :f0',
      ExpressionAttributeValues: { ':one': 1, ':f0': 120 },
    });
    // Without it, no provider month item.
    expect(items({ ...tts, providerMonth: undefined })).toHaveLength(6);
  });

  test('refuses provider month counters that could inject into the update expression', () => {
    const bad = (providerMonth: UsageRecord['providerMonth']) => () => usageTransaction('t', { ...record, providerMonth });
    expect(bad({ provider: 'gcp-tts', counters: { 'x, SET y': 1 } })).toThrow();
    expect(bad({ provider: 'GCP TTS', counters: { premiumChars: 1 } })).toThrow();
    expect(bad({ provider: 'gcp-tts', counters: {} })).toThrow();
    expect(bad({ provider: 'gcp-tts', sets: { 'x, SET y': 'fam' } })).toThrow();
    expect(bad({ provider: 'gcp-tts', sets: { voiceHouseholds: '' } })).toThrow();
  });

  test('a set member rides on the provider month (string set, idempotent); `requests` only with counters', () => {
    const tts: UsageRecord = { ...record, kind: 'tts', counters: { ttsChars: 120, premiumChars: 120 } };
    const both = items({ ...tts, providerMonth: { provider: 'gcp-tts', counters: { premiumChars: 120 }, sets: { voiceHouseholds: 'fam' } } });
    expect(both[6].Update).toEqual({
      TableName: 't',
      Key: { PK: 'PROVIDER#gcp-tts', SK: 'MONTH#2026-10' },
      UpdateExpression: 'ADD requests :one, premiumChars :f0, voiceHouseholds :s0',
      ExpressionAttributeValues: { ':one': 1, ':f0': 120, ':s0': new Set(['fam']) },
    });
    const setOnly = items({ ...tts, providerMonth: { provider: 'gcp-tts', sets: { voiceHouseholds: 'fam' } } });
    expect(setOnly[6].Update!.UpdateExpression).toBe('ADD voiceHouseholds :s0');
    expect(setOnly[6].Update!.ExpressionAttributeValues).toEqual({ ':s0': new Set(['fam']) });
    // Plain JSON on the record (the retry queue), a Set only in the transaction.
    expect(JSON.parse(JSON.stringify({ ...tts, providerMonth: { provider: 'gcp-tts', sets: { voiceHouseholds: 'fam' } } })).providerMonth.sets).toEqual({ voiceHouseholds: 'fam' });
  });

  test('household month marks: set only if absent, in the same update as its counters', () => {
    const tx = items({ ...record, householdMonthMarks: { premiumEndedAt: '2026-10-31T23:59:59.900Z', premiumEndedReason: 'household_share' } });
    expect(tx).toHaveLength(6);
    expect(tx[3].Update).toEqual({
      TableName: 't',
      Key: { PK: 'HOUSEHOLD#fam', SK: 'USAGE#nieto#2026-10' },
      UpdateExpression: 'ADD requests :one, inputTokens :c0, outputTokens :c1, costMicroUsd :cost ' +
        'SET premiumEndedAt = if_not_exists(premiumEndedAt, :m0), premiumEndedReason = if_not_exists(premiumEndedReason, :m1)',
      ExpressionAttributeValues: { ':one': 1, ':c0': 10, ':c1': 5, ':cost': 7, ':m0': '2026-10-31T23:59:59.900Z', ':m1': 'household_share' },
    });
    // The user counters never carry them.
    expect(tx[1].Update!.UpdateExpression).not.toContain('SET');
    expect(() => usageTransaction('t', { ...record, householdMonthMarks: { 'x = :y, z': 'v' } })).toThrow();
    expect(() => usageTransaction('t', { ...record, householdMonthMarks: { premiumEndedAt: '' } })).toThrow();
  });
});

describe('recordUsage (exactly once)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  beforeEach(() => ddb.reset());

  const cancelled = (code: string) =>
    Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: code }, { Code: 'None' }] });

  test('records once', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await expect(recordUsage(client, 't', record)).resolves.toBe('recorded');
  });

  test('a retry of an already-recorded event is a no-op duplicate, never a double count', async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed'));
    await expect(recordUsage(client, 't', record)).resolves.toBe('duplicate');
  });

  test('other failures propagate', async () => {
    ddb.on(TransactWriteCommand).rejects(new Error('throttled'));
    await expect(recordUsage(client, 't', record)).rejects.toThrow('throttled');
    expect(isAlreadyRecorded(cancelled('None'))).toBe(false);
  });
});
