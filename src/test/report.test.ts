import {
  aggregateSpend,
  eventFacts,
  formatSpendReport,
  globalSpendRows,
  householdPlanUpdate,
  parseFlags,
  parseGlobalSpendArgs,
  parseHouseholdPlanArgs,
  parseSpendArgs,
} from '../report';
import { parseCounterSk } from '../keys';

const NOW = new Date('2026-10-15T12:00:00Z');

describe('parseFlags', () => {
  test('values, inline values, booleans and positionals', () => {
    expect(parseFlags(['a', '--x', '1', '--y=2', '--z', 'b'], { values: ['x', 'y'], booleans: ['z'] })).toEqual({
      positional: ['a', 'b'], flags: { x: '1', y: '2', z: true },
    });
  });

  test('rejects unknown flags, missing values and values on booleans', () => {
    expect(() => parseFlags(['--nope'], {})).toThrow(/Unknown/);
    expect(() => parseFlags(['--x'], { values: ['x'] })).toThrow(/needs a value/);
    expect(() => parseFlags(['--x', '--y'], { values: ['x', 'y'] })).toThrow(/needs a value/);
    expect(() => parseFlags(['--z=1'], { booleans: ['z'] })).toThrow(/no value/);
  });
});

describe('household-plan', () => {
  test('parses plan and limits into integer micro-USD', () => {
    expect(parseHouseholdPlanArgs(['family', 'test', '--monthly-usd', '3', '--daily-usd=0.25'], 'nieto')).toEqual({
      householdId: 'family', appId: 'nieto', plan: 'test', monthlyAllowanceMicroUsd: 3_000_000, dailyCapMicroUsd: 250_000,
    });
    expect(parseHouseholdPlanArgs(['dev', 'dev', '--app', 'other-app', '--daily-usd', 'default', '--status', 'paused'], 'nieto')).toEqual({
      householdId: 'dev', appId: 'other-app', plan: 'dev', dailyCapMicroUsd: 'default', subscriptionStatus: 'paused',
    });
  });

  test('rejects bad input', () => {
    expect(() => parseHouseholdPlanArgs(['family'], 'nieto')).toThrow();
    expect(() => parseHouseholdPlanArgs(['family', 'gold'], 'nieto')).toThrow(/Unknown plan/);
    expect(() => parseHouseholdPlanArgs(['family', 'test', '--monthly-usd', '-1'], 'nieto')).toThrow();
    expect(() => parseHouseholdPlanArgs(['family', 'test', '--status', 'happy'], 'nieto')).toThrow(/status/);
    expect(() => parseHouseholdPlanArgs(['family', 'test', '--app', 'Bad#App'], 'nieto')).toThrow(/--app/);
  });

  test('update is per app, atomic, and never leaves a plan without an allowance', () => {
    const full = householdPlanUpdate('t', parseHouseholdPlanArgs(['family', 'test', '--monthly-usd', '3', '--daily-usd', '0.25'], 'nieto'), NOW);
    expect(full).toEqual({
      TableName: 't',
      Key: { PK: 'HOUSEHOLD#family', SK: 'PLAN#nieto' },
      UpdateExpression: 'SET #plan = :plan, subscriptionStatus = if_not_exists(subscriptionStatus, :status), updatedAt = :now, monthlyAllowanceMicroUsd = :monthly, dailyCapMicroUsd = :daily',
      ExpressionAttributeNames: { '#plan': 'plan' },
      ExpressionAttributeValues: { ':plan': 'test', ':status': 'active', ':now': NOW.toISOString(), ':monthly': 3_000_000, ':daily': 250_000 },
    });
    const partial = householdPlanUpdate('t', parseHouseholdPlanArgs(['family', 'test', '--daily-usd', 'default', '--status', 'paused'], 'nieto'), NOW);
    expect(partial.UpdateExpression).toBe('SET #plan = :plan, subscriptionStatus = :status, updatedAt = :now REMOVE dailyCapMicroUsd');
    expect(partial.ConditionExpression).toBe('attribute_exists(monthlyAllowanceMicroUsd)');
  });
});

describe('spend args', () => {
  test('defaults to this UTC month, all apps', () => {
    expect(parseSpendArgs([], NOW)).toEqual({ month: '2026-10' });
    expect(parseSpendArgs(['--app', 'nieto', '--household', 'family', '--month', '2026-09'], NOW)).toEqual({
      appId: 'nieto', householdId: 'family', month: '2026-09',
    });
    expect(() => parseSpendArgs(['--household', 'a', '--user', 'b'], NOW)).toThrow(/not both/);
    expect(() => parseSpendArgs(['--month', '2026-13'], NOW)).toThrow();
    expect(() => parseSpendArgs(['extra'], NOW)).toThrow();
  });

  test('global-spend', () => {
    expect(parseGlobalSpendArgs([], NOW)).toEqual({ prefix: '2026-10' });
    expect(parseGlobalSpendArgs(['--day', '2026-10-01', '--app', 'nieto'], NOW)).toEqual({ appId: 'nieto', prefix: '2026-10-01' });
    expect(() => parseGlobalSpendArgs(['--day', '2026-10-01', '--month', '2026-10'], NOW)).toThrow();
    expect(() => parseGlobalSpendArgs(['--day', 'today'], NOW)).toThrow();
  });
});

describe('spend report', () => {
  const legacyChat = {
    PK: 'USER#u1', SK: 'EVENT#2026-09-29T10:00:00.000Z#req-a', kind: 'chat', model: 'deepseek-flash',
    pricingVersion: 'deepseek-v4-flash@2026-09-29', inputTokens: 100, cachedInputTokens: 900, outputTokens: 20, costMicroUsd: 60,
  };
  const legacyTts = { PK: 'USER#u1', SK: 'EVENT#2026-09-29T10:00:01.000Z#req-b', kind: 'tts', pricingVersion: 'gcp-tts-wavenet@2026-09-29', chars: 100, costMicroUsd: 400 };
  const newChat = {
    PK: 'USER#u2', SK: 'EVENT#2026-09-30T03:00:00.000Z#nieto#req-c', appId: 'nieto', plan: 'test', kind: 'chat',
    sku: 'deepseek-v4-flash', pricingBand: 'peak', inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 1, costMicroUsd: 7,
  };
  const otherApp = { ...newChat, SK: 'EVENT#2026-09-30T04:00:00.000Z#other#req-d', appId: 'other', costMicroUsd: 1000 };

  test('legacy events are attributed to the legacy app and normalized', () => {
    expect(eventFacts(legacyChat, 'nieto')).toMatchObject({
      appId: 'nieto', sub: 'u1', day: '2026-09-29', sku: 'deepseek-v4-flash', band: 'flat', plan: 'prepaid',
      line: { cacheReadTokens: 900, costMicroUsd: 60 },
    });
    expect(eventFacts(legacyTts, 'nieto')).toMatchObject({ sku: 'gcp-tts-wavenet', line: { ttsChars: 100 } });
  });

  test('totals by app, plan, SKU, band, day and user', () => {
    const r = aggregateSpend([legacyChat, legacyTts, newChat, otherApp], 'nieto');
    expect(r.total).toMatchObject({ requests: 4, costMicroUsd: 1467 });
    expect(r.byApp.get('nieto')).toMatchObject({ requests: 3, costMicroUsd: 467 });
    expect(r.byApp.get('other')).toMatchObject({ requests: 1, costMicroUsd: 1000 });
    expect(r.bySku.get('nieto deepseek-v4-flash')).toMatchObject({ requests: 2, costMicroUsd: 67, cacheReadTokens: 905, reasoningTokens: 1 });
    expect(r.byBand.get('nieto deepseek-v4-flash peak')).toMatchObject({ costMicroUsd: 7 });
    expect(r.byBand.get('nieto deepseek-v4-flash flat')).toMatchObject({ costMicroUsd: 60 });
    expect(r.byDay.get('2026-09-29')).toMatchObject({ requests: 2, costMicroUsd: 460 });
    expect(r.byUser.get('u2')).toMatchObject({ costMicroUsd: 1007 });
    expect(r.byPlan.get('nieto prepaid')).toMatchObject({ costMicroUsd: 460 });
  });

  test('filters by app', () => {
    const r = aggregateSpend([legacyChat, otherApp], 'nieto', 'other');
    expect(r.total).toMatchObject({ requests: 1, costMicroUsd: 1000 });
    expect(formatSpendReport(r)).toContain('Total  $0.001000  1 req');
  });
});

test('globalSpendRows shows each scope against its cap', () => {
  const rows = globalSpendRows(
    [
      { PK: 'GLOBAL', SK: 'DAILY#2026-10-01', costMicroUsd: 1_000_000, requests: 10 },
      { PK: 'APP#nieto', SK: 'DAILY#2026-10-01', costMicroUsd: 1_500_000, requests: 9 },
    ],
    { appDailyCapMicroUsd: { nieto: 3_000_000 }, allAppsDailyCapMicroUsd: 5_000_000 },
  );
  expect(rows).toEqual([
    '2026-10-01  all apps   $1.000000  10 req  20.0% of $5.000000',
    '2026-10-01  nieto      $1.500000  9 req  50.0% of $3.000000',
  ]);
});

test('parseCounterSk handles per-app and legacy keys', () => {
  expect(parseCounterSk('USAGE#nieto#2026-10', 'nieto')).toEqual({ kind: 'USAGE', appId: 'nieto', period: '2026-10' });
  expect(parseCounterSk('USAGE#2026-09', 'nieto')).toEqual({ kind: 'USAGE', appId: 'nieto', period: '2026-09' });
  expect(parseCounterSk('PROFILE', 'nieto')).toBeUndefined();
});
