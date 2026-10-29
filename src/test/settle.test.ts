import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { adjustmentTransaction } from '../adjust';
import { setTableKeys } from '../keys';
import { clientRequestToken, recordUsage, usageTransaction, type UsageRecord } from '../ledger';
import { planReprice } from '../reprice';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeAll(() => setTableKeys({ pk: 'pk', sk: 'sk' }));
afterAll(() => setTableKeys(undefined));
beforeEach(() => {
  ddbMock.reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** Walkthrough A: Ana's Haiku call settled at its actual cost. */
const settle: UsageRecord = {
  appId: 'stacksplit',
  sub: 'ana@x.co',
  requestId: '7f3c',
  requestTime: '2026-11-03T14:05:09.120Z',
  kind: 'tokens',
  pricingVersion: 'claude-haiku-5-5@2026-10-28T00:00:00Z',
  details: { provider: 'anthropic', sku: 'claude-haiku-5-5', inputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 2000, outputTokens: 100, reasoningTokens: 0 },
  counters: { inputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 2000, outputTokens: 100, reasoningTokens: 0 },
  baseCostMicroUsd: 440,
  costMicroUsd: 440,
  markupBps: 0,
  deductCredit: false,
  env: 'prod',
  paidBy: 'credit',
  reservedMicroUsd: 5_798,
  usageHash: 'h-actual',
};
const release: UsageRecord = { ...settle, release: true, details: { sku: 'claude-haiku-5-5' }, counters: {}, baseCostMicroUsd: 0, costMicroUsd: 0, usageHash: 'h-release' };
const eventKey = { pk: 'USER#ana@x.co', sk: 'EVENT#2026-11-03T14:05:09.120Z#stacksplit#7f3c' };
const pendingKey = { pk: 'PENDING#stacksplit', sk: 'CALL#7f3c' };

const cancelled = (...codes: string[]) =>
  Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) });
const event = (item?: Record<string, unknown>) => ddbMock.on(GetCommand).resolves({ Item: item });

describe('the settle transaction', () => {
  test('EVENT, counters with the hold moved, PENDING deleted; no household, no credit', () => {
    const tx = usageTransaction('t', settle).input;
    expect(tx.ClientRequestToken).toBe(clientRequestToken('stacksplit', '7f3c'));
    const items = tx.TransactItems!;
    expect(items[0].Put!.Item).toEqual({
      ...eventKey, appId: 'stacksplit', kind: 'tokens', requestId: '7f3c', ...settle.details,
      pricingVersion: settle.pricingVersion, baseCostMicroUsd: 440, costMicroUsd: 440, markupBps: 0,
      env: 'prod', paidBy: 'credit', reservedMicroUsd: 5_798, usageHash: 'h-actual',
    });
    expect(items[0].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items.slice(1, -1).map((i) => i.Update!.Key)).toEqual([
      { pk: 'USER#ana@x.co', sk: 'USAGE#stacksplit#2026-11' },
      { pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' },
      { pk: 'APP#stacksplit', sk: 'DAILY#2026-11-03' },
      { pk: 'GLOBAL', sk: 'DAILY#2026-11-03' },
      { pk: 'PROVIDER#anthropic', sk: 'DAILY#2026-11-03' },
    ]);
    // Only the person's day carries the hold: committed moves by actual − reserved.
    expect(items[2].Update!.UpdateExpression).toMatch(/, committedMicroUsd :held$/);
    expect(items[2].Update!.ExpressionAttributeValues![':held']).toBe(440 - 5_798);
    expect(items[1].Update!.UpdateExpression).not.toContain('committed');
    expect(items.at(-1)).toEqual({ Delete: { TableName: 't', Key: pendingKey, ConditionExpression: 'attribute_exists(pk)' } });
    expect(items).toHaveLength(7);
  });

  test('an estimate is marked on the EVENT', () => {
    const item = usageTransaction('t', { ...settle, estimated: 'swept' }).input.TransactItems![0].Put!.Item!;
    expect(item.estimated).toBe('swept');
  });

  test("release ('not_billed'): PENDING deleted and the whole hold given back, nothing else", () => {
    const tx = usageTransaction('t', release).input;
    expect(tx.ClientRequestToken).toBe(clientRequestToken('stacksplit', '7f3c'));
    expect(tx.TransactItems).toEqual([
      { Delete: { TableName: 't', Key: pendingKey, ConditionExpression: 'attribute_exists(pk)' } },
      { Update: { TableName: 't', Key: { pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' }, UpdateExpression: 'ADD committedMicroUsd :held', ExpressionAttributeValues: { ':held': -5_798 } } },
    ]);
  });
});

describe('recordUsage on the new path', () => {
  test('written: recorded', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    expect(await recordUsage(ddb(), 't', settle)).toBe('recorded');
  });

  test('T2: the same payload again after the token window: duplicate (consistent read of the EVENT)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed'));
    event({ ...eventKey, usageHash: 'h-actual' });
    expect(await recordUsage(ddb(), 't', settle)).toBe('duplicate');
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input).toEqual({ TableName: 't', Key: eventKey, ConsistentRead: true });
  });

  test('T3: a different payload for a settled call: conflict, RECORD_CONFLICT, nothing written', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed'));
    event({ ...eventKey, usageHash: 'h-other', costMicroUsd: 999 });
    expect(await recordUsage(ddb(), 't', settle)).toBe('conflict');
    expect(console.error).toHaveBeenCalledWith('RECORD_CONFLICT', expect.objectContaining({ appId: 'stacksplit', requestId: '7f3c' }));
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  test('T3 (token window): IdempotentParameterMismatchException is a conflict', async () => {
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('mismatch'), { name: 'IdempotentParameterMismatchException' }));
    expect(await recordUsage(ddb(), 't', settle)).toBe('conflict');
    expect(console.error).toHaveBeenCalledWith('RECORD_CONFLICT', expect.anything());
  });

  test('T9: real usage after the sweeper estimate: one ADJUST late-usage, then duplicate', async () => {
    ddbMock.on(TransactWriteCommand).rejectsOnce(cancelled('ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed')).resolves({});
    event({ ...eventKey, usageHash: 'h-swept', estimated: 'swept', costMicroUsd: 5_798, pricingVersion: settle.pricingVersion });
    expect(await recordUsage(ddb(), 't', settle)).toBe('trued_up');
    const adjust = ddbMock.commandCalls(TransactWriteCommand)[1].args[0].input;
    const put = adjust.TransactItems![0].Put!;
    expect(put.Item).toMatchObject({ pk: 'USER#ana@x.co', reason: 'late-usage', eventSk: eventKey.sk, oldCostMicroUsd: 5_798, newCostMicroUsd: 440, deltaMicroUsd: 440 - 5_798, usageHash: 'h-actual' });
    expect(put.Item).not.toHaveProperty('householdId');
    expect(adjust.TransactItems!.slice(1).map((i) => i.Update!.Key)).toEqual([
      { pk: 'USER#ana@x.co', sk: 'USAGE#stacksplit#2026-11' },
      { pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' },
    ]);
    expect(console.warn).toHaveBeenCalledWith('LATE_USAGE', expect.objectContaining({ deltaMicroUsd: 440 - 5_798 }));
    // The same late usage again: the ADJUST key is deterministic, so it is refused.
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed'));
    expect(await recordUsage(ddb(), 't', settle)).toBe('duplicate');
  });

  test('a release whose PENDING is gone: duplicate without an EVENT, conflict with one, a true-up to 0 after a sweep', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None'));
    event(undefined);
    expect(await recordUsage(ddb(), 't', release)).toBe('duplicate');
    event({ ...eventKey, usageHash: 'h-actual', costMicroUsd: 440 });
    expect(await recordUsage(ddb(), 't', release)).toBe('conflict');
    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).rejectsOnce(cancelled('ConditionalCheckFailed', 'None')).resolves({});
    event({ ...eventKey, usageHash: 'h-swept', estimated: 'swept', costMicroUsd: 5_798 });
    expect(await recordUsage(ddb(), 't', release)).toBe('trued_up');
    expect(ddbMock.commandCalls(TransactWriteCommand).at(-1)!.args[0].input.TransactItems![0].Put!.Item).toMatchObject({ deltaMicroUsd: -5_798 });
  });

  test('a settle after a release (PENDING gone, no EVENT): conflict, never a silent drop', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed'));
    event(undefined);
    expect(await recordUsage(ddb(), 't', settle)).toBe('conflict');
  });

  test('anything else throws (the caller queues it)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'TransactionConflict'));
    await expect(recordUsage(ddb(), 't', settle)).rejects.toThrow('cancelled');
  });
});

describe('T20: adjustments and re-pricing without a household', () => {
  const newPathEvent = {
    pk: 'USER#ana@x.co', sk: eventKey.sk, appId: 'stacksplit', kind: 'tokens', sku: 'claude-haiku-5-5', requestId: '7f3c',
    inputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 2000, outputTokens: 100, reasoningTokens: 0,
    pricingVersion: 'claude-haiku-5-5@2026-10-28T00:00:00Z', baseCostMicroUsd: 440, costMicroUsd: 440, markupBps: 0, env: 'prod', paidBy: 'credit', reservedMicroUsd: 5_798,
  };
  const prices = {
    'claude-haiku-5-5': [{ pk: 'PRICING#claude-haiku-5-5', sk: '2026-10-28T00:00:00Z', provider: 'anthropic', inputMicroUsdPerMTok: 200_000, cachedInputMicroUsdPerMTok: 10_000, outputMicroUsdPerMTok: 500_000, cacheWriteMicroUsdPerMTok: 125_000 }],
  };

  test('planReprice leaves the household out; the ADJUST touches no HOUSEHOLD# key', () => {
    const plan = planReprice({ events: [newPathEvent], adjustments: [], priceHistory: prices, appId: 'stacksplit', legacyAppId: 'stacksplit', reason: 'fix', now: new Date('2026-11-05T00:00:00Z'), billing: 'none' });
    expect(plan.adjustments).toHaveLength(1);
    const a = plan.adjustments[0];
    expect(a.householdId).toBeUndefined();
    expect(a.deltaMicroUsd).toBe(100);
    const tx = adjustmentTransaction('t', a).input;
    expect(tx.TransactItems![0].Put!.Item).not.toHaveProperty('householdId');
    expect(JSON.stringify(tx)).not.toContain('HOUSEHOLD#');
    expect(tx.TransactItems).toHaveLength(3);
    // No household, no credit to correct, whatever the billing mode.
    const hosted = planReprice({ events: [newPathEvent], adjustments: [], priceHistory: prices, appId: 'stacksplit', legacyAppId: 'stacksplit', reason: 'fix', now: new Date('2026-11-05T00:00:00Z') });
    expect(hosted.adjustments[0].deductCredit).toBe(false);
  });
});
