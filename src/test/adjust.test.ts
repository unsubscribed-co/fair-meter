import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { adjustmentId, adjustmentTransaction, applyAdjustment, checkReason, type Adjustment } from '../adjust';

const EVENT_SK = 'EVENT#2026-09-26T12:00:00.000Z#nieto#req-1';

const adjustment: Adjustment = {
  appId: 'nieto',
  sub: 'u1',
  householdId: 'fam',
  plan: 'test',
  eventSk: EVENT_SK,
  eventTime: '2026-09-26T12:00:00.000Z',
  legacyEvent: false,
  kind: 'chat',
  sku: 'deepseek-v4-flash',
  reason: 'reprice-offpeak',
  oldPricingVersion: 'deepseek-v4-flash@2026-09-01',
  newPricingVersion: 'deepseek-v4-flash@2026-09-01',
  oldCostMicroUsd: 594,
  newCostMicroUsd: 297,
  deltaMicroUsd: -297,
  createdAt: '2026-10-02T15:00:00.000Z',
  deductCredit: false,
  details: { newPricingBand: 'default' },
};

const items = (a: Adjustment) => adjustmentTransaction('t', a).input.TransactItems!;

describe('adjustment id', () => {
  test('is deterministic from reason and event key, so re-applying hits the same item', () => {
    expect(adjustmentId('reprice-offpeak', EVENT_SK)).toBe(adjustmentId('reprice-offpeak', EVENT_SK));
    expect(adjustmentId('reprice-offpeak', EVENT_SK)).toHaveLength(32);
    expect(adjustmentId('other-fix', EVENT_SK)).not.toBe(adjustmentId('reprice-offpeak', EVENT_SK));
    expect(adjustmentId('reprice-offpeak', `${EVENT_SK}x`)).not.toBe(adjustmentId('reprice-offpeak', EVENT_SK));
    const a = adjustmentTransaction('t', adjustment).input;
    const b = adjustmentTransaction('t', JSON.parse(JSON.stringify(adjustment))).input;
    expect(a).toEqual(b);
    expect(a.ClientRequestToken).toBe(adjustmentId('reprice-offpeak', EVENT_SK));
  });

  test('reason ids are plain', () => {
    expect(checkReason('reprice-2026-09')).toBe('reprice-2026-09');
    expect(() => checkReason('Reprice')).toThrow();
    expect(() => checkReason('a#b')).toThrow();
    expect(() => checkReason('')).toThrow();
  });
});

describe('adjustmentTransaction', () => {
  test('conditional put keyed by the event time, plus the event period counters', () => {
    const tx = items(adjustment);
    expect(tx).toHaveLength(4);
    const id = adjustmentId('reprice-offpeak', EVENT_SK);
    expect(tx[0].Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(tx[0].Put!.Item).toEqual({
      PK: 'USER#u1',
      SK: `ADJUST#2026-09-26T12:00:00.000Z#nieto#${id}`,
      adjustmentId: id,
      appId: 'nieto',
      householdId: 'fam',
      plan: 'test',
      eventSk: EVENT_SK,
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
    });
    // The event's month/day, not the month the correction is written in; no breaker counters.
    expect(tx.slice(1).map((t) => t.Update!.Key)).toEqual([
      { PK: 'USER#u1', SK: 'USAGE#nieto#2026-09' },
      { PK: 'USER#u1', SK: 'DAILY#nieto#2026-09-26' },
      { PK: 'HOUSEHOLD#fam', SK: 'USAGE#nieto#2026-09' },
    ]);
    for (const t of tx.slice(1)) {
      expect(t.Update).toMatchObject({
        UpdateExpression: 'ADD costMicroUsd :delta, adjustmentsMicroUsd :delta',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':delta': -297 },
      });
    }
  });

  test('legacy prepaid: legacy user counters and a credit refund, like the original deduction', () => {
    const tx = items({ ...adjustment, plan: undefined, legacyEvent: true, deductCredit: true, eventSk: 'EVENT#2026-09-26T12:00:00.000Z#req-1' });
    expect(tx[0].Put!.Item).not.toHaveProperty('plan');
    expect(tx.slice(1).map((t) => t.Update!.Key)).toEqual([
      { PK: 'USER#u1', SK: 'USAGE#2026-09' },
      { PK: 'USER#u1', SK: 'DAILY#2026-09-26' },
      { PK: 'HOUSEHOLD#fam', SK: 'META' },
    ]);
    expect(tx[3].Update).toMatchObject({
      UpdateExpression: 'ADD creditBalanceMicroUsd :neg',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':neg': 297 },
    });
  });

  test('refuses an inconsistent delta or a bad reason', () => {
    expect(() => adjustmentTransaction('t', { ...adjustment, deltaMicroUsd: -296 })).toThrow(/delta/);
    expect(() => adjustmentTransaction('t', { ...adjustment, reason: 'x y' })).toThrow(/reason/);
  });
});

describe('applyAdjustment (exactly once)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  beforeEach(() => ddb.reset());
  const cancelled = (code: string) =>
    Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: code }, { Code: 'None' }] });

  test('applies once; a second apply is a duplicate, not a second refund', async () => {
    ddb.on(TransactWriteCommand).resolvesOnce({}).rejects(cancelled('ConditionalCheckFailed'));
    await expect(applyAdjustment(client, 't', adjustment)).resolves.toBe('applied');
    await expect(applyAdjustment(client, 't', adjustment)).resolves.toBe('duplicate');
  });

  test('a missing counter (wrong keys) fails loudly', async () => {
    ddb.on(TransactWriteCommand).rejects(
      Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }),
    );
    await expect(applyAdjustment(client, 't', adjustment)).rejects.toThrow('cancelled');
  });
});
