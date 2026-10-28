import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { usageTransaction } from '../ledger';
import { Meter, type MeteringConfig } from '../meter';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

const cfg: MeteringConfig = {
  tableName: 't',
  appId: 'nieto',
  markupBps: 0,
  skuAliases: { 'deepseek-flash': 'deepseek-v4-flash' },
  retryQueueUrl: 'https://sqs/retry',
  limits: { defaultDailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 3_000_000, allAppsDailyCapMicroUsd: 5_000_000 },
};
const meter = () => new Meter(cfg, { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) });

/** Items by "PK|SK"; anything else reads as missing. */
function table(items: Record<string, Record<string, unknown>>) {
  ddbMock.on(GetCommand).callsFake(({ Key }) => ({ Item: items[`${Key.PK}|${Key.SK}`] }));
}

const prices: Record<string, Record<string, unknown>[]> = {};
function pricing() {
  ddbMock.on(QueryCommand).callsFake((input) => ({ Items: prices[input.ExpressionAttributeValues[':pk']] ?? [] }));
}

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  for (const k of Object.keys(prices)) delete prices[k];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const AT = new Date('2026-10-15T12:00:00Z');
const base = {
  'USER#u1|PROFILE': { householdId: 'fam', role: 'owner' },
  'HOUSEHOLD#fam|META': { creditBalanceMicroUsd: 0 },
  'HOUSEHOLD#fam|PLAN#nieto': { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000 },
};

describe('authorize', () => {
  test('reads only per-app counters for the request day and month', async () => {
    table(base);
    const res = await meter().authorize('u1', AT);
    expect(res).toEqual({
      ok: true,
      caller: { sub: 'u1', householdId: 'fam', role: 'owner', plan: { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000, dailyCapMicroUsd: undefined } },
      tier: 'normal',
      householdMonthPct: 0,
    });
    const keys = ddbMock.commandCalls(GetCommand).map((c) => `${c.args[0].input.Key!.PK}|${c.args[0].input.Key!.SK}`);
    expect(keys.sort()).toEqual([
      'APP#nieto|DAILY#2026-10-15',
      'GLOBAL|DAILY#2026-10-15',
      'HOUSEHOLD#fam|META',
      'HOUSEHOLD#fam|PLAN#nieto',
      'HOUSEHOLD#fam|USAGE#nieto#2026-10',
      'USER#u1|DAILY#nieto#2026-10-15',
      'USER#u1|PROFILE',
    ]);
  });

  test("the household month's percent of its allowance, from the counters the tier already read", async () => {
    table({ ...base, 'HOUSEHOLD#fam|USAGE#nieto#2026-10': { costMicroUsd: 2_499_999 } });
    expect(await meter().authorize('u1', AT)).toMatchObject({ ok: true, householdMonthPct: 49 });
    table({ ...base, 'HOUSEHOLD#fam|USAGE#nieto#2026-10': { costMicroUsd: 2_500_000 } });
    expect(await meter().authorize('u1', AT)).toMatchObject({ ok: true, householdMonthPct: 50 });
    // Legacy prepaid (no plan): no allowance, no month figure.
    table({ ...base, 'HOUSEHOLD#fam|META': { creditBalanceMicroUsd: 1_000_000 }, 'HOUSEHOLD#fam|PLAN#nieto': undefined as any });
    const res = await meter().authorize('u1', AT);
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('householdMonthPct');
  });

  test("the household month's item comes back as read (an app's per-household state), with no extra read", async () => {
    const month = { costMicroUsd: 100, premiumChars: 1200, premiumEndedAt: '2026-10-14T10:00:00.000Z' };
    table({ ...base, 'HOUSEHOLD#fam|USAGE#nieto#2026-10': month });
    expect(await meter().authorize('u1', AT)).toMatchObject({ ok: true, householdMonth: month });
    expect(ddbMock.commandCalls(GetCommand).filter((c) => c.args[0].input.Key!.SK === 'USAGE#nieto#2026-10')[0].args[0].input.ConsistentRead).toBe(true);
    table(base);
    expect(await meter().authorize('u1', AT)).not.toHaveProperty('householdMonth');
  });

  test('planDefItem: the PLANDEF#<app>#<plan> version valid at the request time', async () => {
    prices['PLANDEF#nieto#test'] = [{ PK: 'PLANDEF#nieto#test', SK: '2026-10-09T00:00:00Z', validFrom: '2026-10-09T00:00:00Z', grid: {} }];
    pricing();
    expect(await meter().planDefItem('test', AT)).toMatchObject({ version: 'test@2026-10-09T00:00:00Z', item: { grid: {} } });
    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'PLANDEF#nieto#test', ':at': '2026-10-15T12:00:00Z' });
    // A version closed before the request time: none valid (logged), never a guess.
    prices['PLANDEF#nieto#test'] = [{ PK: 'PLANDEF#nieto#test', SK: '2026-10-09T00:00:00Z', validTo: '2026-10-10T00:00:00Z', grid: {} }];
    expect(await meter().planDefItem('test', AT)).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('PLAN_DEF_VERSION_GAP', expect.objectContaining({ version: 'test@2026-10-09T00:00:00Z' }));
    delete prices['PLANDEF#nieto#test'];
    expect(await meter().planDefItem('test', AT)).toBeUndefined();
  });

  test('providerMonthCount reads one account-wide counter of the UTC month (0 when unused)', async () => {
    table({ 'PROVIDER#gcp-tts|MONTH#2026-10': { premiumChars: 1234, requests: 9 } });
    expect(await meter().providerMonthCount('gcp-tts', 'premiumChars', AT)).toBe(1234);
    expect(await meter().providerMonthCount('gcp-tts', 'premiumChars', new Date('2026-11-01T00:00:00Z'))).toBe(0);
  });

  test('unregistered and missing household', async () => {
    table({});
    expect(await meter().authorize('u1', AT)).toEqual({ ok: false, status: 403, body: { error: 'not_registered', sub: 'u1' } });
    table({ 'USER#u1|PROFILE': { householdId: 'fam' } });
    expect(await meter().authorize('u1', AT)).toEqual({ ok: false, status: 403, body: { error: 'household_not_found' } });
  });

  test('daily cap says when it resets', async () => {
    table({ ...base, 'USER#u1|DAILY#nieto#2026-10-15': { costMicroUsd: 500_000 } });
    expect(await meter().authorize('u1', AT)).toEqual({
      ok: false, status: 429, body: { error: 'daily_limit_reached', resetsAt: '2026-10-16T00:00:00.000Z' }, tier: 'limit',
    });
  });

  test('legacy un-prefixed counters do not count toward per-app limits', async () => {
    table({ ...base, 'USER#u1|DAILY#2026-10-15': { costMicroUsd: 9_000_000 } });
    expect((await meter().authorize('u1', AT)).ok).toBe(true);
  });

  test('monthly allowance resets with the UTC month', async () => {
    const spent = { ...base, 'HOUSEHOLD#fam|USAGE#nieto#2026-10': { costMicroUsd: 5_000_000 } };
    table(spent);
    expect(await meter().authorize('u1', new Date('2026-10-31T23:59:59Z'))).toEqual({
      ok: false, status: 402, body: { error: 'monthly_allowance_reached', resetsAt: '2026-11-01T00:00:00.000Z' }, tier: 'limit',
    });
    expect((await meter().authorize('u1', new Date('2026-11-01T00:00:00Z'))).ok).toBe(true);
  });

  test('per-app breaker blocks everyone with service_paused and logs the alarm line', async () => {
    table({ ...base, 'APP#nieto|DAILY#2026-10-15': { costMicroUsd: 3_000_000 } });
    expect(await meter().authorize('u1', AT)).toEqual({ ok: false, status: 503, body: { error: 'service_paused' }, tier: 'normal' });
    expect(console.error).toHaveBeenCalledWith('SERVICE_PAUSED', expect.objectContaining({ reason: 'app_daily_cap', appId: 'nieto' }));
  });

  test('all-apps ceiling', async () => {
    table({ ...base, 'GLOBAL|DAILY#2026-10-15': { costMicroUsd: 5_000_000 } });
    expect(await meter().authorize('u1', AT)).toMatchObject({ ok: false, status: 503 });
    expect(console.error).toHaveBeenCalledWith('SERVICE_PAUSED', expect.objectContaining({ reason: 'all_apps_daily_cap' }));
  });

  test('a household without a plan for this app is legacy prepaid (credit required)', async () => {
    table({ 'USER#u1|PROFILE': { householdId: 'fam' }, 'HOUSEHOLD#fam|META': { creditBalanceMicroUsd: 0 } });
    expect(await meter().authorize('u1', AT)).toEqual({ ok: false, status: 402, body: { error: 'insufficient_credit' }, tier: 'normal' });
  });

  test('without maxCallsPerMinute there is no brake and no write', async () => {
    table(base);
    await meter().authorize('u1', AT);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test('per-minute brake: an atomic counter per user and minute; over it, too_many_requests until the next minute', async () => {
    const braked = () => new Meter({ ...cfg, limits: { ...cfg.limits, maxCallsPerMinute: 20 } }, { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) });
    table(base);
    const at = new Date('2026-10-15T12:00:59.500Z');
    expect(await braked().authorize('u1', at)).toMatchObject({ ok: true, tier: 'normal' });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
      Key: { PK: 'USER#u1', SK: 'RATE#nieto#2026-10-15T12:00' },
      ConditionExpression: 'attribute_not_exists(calls) OR calls < :max',
      ExpressionAttributeValues: { ':max': 20 },
    });

    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' }));
    expect(await braked().authorize('u1', at)).toEqual({
      ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds: 1 }, tier: 'normal', retryAfterSeconds: 1,
    });
    expect(console.warn).toHaveBeenCalledWith('RATE_LIMITED', expect.objectContaining({ appId: 'nieto', maxCallsPerMinute: 20 }));

    ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
    await expect(braked().authorize('u1', at)).rejects.toThrow('throttled');
  });

  test('plans are per app: another app\'s plan does not apply', async () => {
    table({
      'USER#u1|PROFILE': { householdId: 'fam' },
      'HOUSEHOLD#fam|META': { creditBalanceMicroUsd: 0 },
      'HOUSEHOLD#fam|PLAN#other-app': { plan: 'family', monthlyAllowanceMicroUsd: 1 },
    });
    expect(await meter().authorize('u1', AT)).toMatchObject({ ok: false, body: { error: 'insufficient_credit' } });
  });
});

describe('account', () => {
  test('reports plan and effective limits for this app', async () => {
    table({ ...base, 'HOUSEHOLD#fam|PLAN#nieto': { ...base['HOUSEHOLD#fam|PLAN#nieto'], dailyCapMicroUsd: 250_000 } });
    expect(await meter().account('u1')).toEqual({
      sub: 'u1', registered: true, householdId: 'fam', role: 'owner', creditBalanceMicroUsd: 0,
      plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000, dailyCapMicroUsd: 250_000,
    });
  });
});

const flat = { SK: '2026-10-01', inputMicroUsdPerMTok: 300_000, cachedInputMicroUsdPerMTok: 6_000, outputMicroUsdPerMTok: 1_200_000 };
const caller = { sub: 'u1', householdId: 'fam', plan: { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000 } };
const usage = { prompt_tokens: 22, completion_tokens: 36, prompt_cache_hit_tokens: 0 };

describe('pricing lookup', () => {
  test('picks the version whose range contains the call time', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    pricing();
    const found = await meter().tokenPricing('deepseek-v4-flash', AT);
    expect(found).toMatchObject({ sku: 'deepseek-v4-flash', version: 'deepseek-v4-flash@2026-10-01' });
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'PRICING#deepseek-v4-flash', ':at': '2026-10-15T12:00:00Z',
    });
  });

  test('a closed range that does not cover the call time refuses instead of guessing', async () => {
    prices['PRICING#deepseek-v4-flash'] = [{ ...flat, validTo: '2026-10-10T00:00:00Z' }];
    pricing();
    expect(await meter().tokenPricing('deepseek-v4-flash', AT)).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('PRICE_VERSION_GAP', expect.anything());
  });

  test('aliases resolve before lookup', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    pricing();
    expect((await meter().tokenPricing('deepseek-flash', AT))?.sku).toBe('deepseek-v4-flash');
  });
});

describe('tokenRecord', () => {
  const requested = async () => {
    pricing();
    return (await meter().tokenPricing('deepseek-v4-flash', AT))!;
  };

  test('records requested vs served model, canonical meters and the priced SKU', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    const r = await meter().tokenRecord({
      caller, requestId: 'req-1', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-flash', usage,
      details: { durationMs: 900, upstreamMs: 800 },
    });
    expect(r).toEqual({
      appId: 'nieto', sub: 'u1', householdId: 'fam', plan: 'test', requestId: 'req-1', requestTime: '2026-10-15T12:00:00.000Z',
      kind: 'chat', pricingVersion: 'deepseek-v4-flash@2026-10-01', markupBps: 0, deductCredit: false,
      details: {
        provider: 'deepseek', requestedModel: 'deepseek-v4-flash', servedModel: 'deepseek-flash', model: 'deepseek-flash',
        sku: 'deepseek-v4-flash', inputTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 36, reasoningTokens: 0,
        durationMs: 900, upstreamMs: 800,
      },
      counters: { inputTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 36, reasoningTokens: 0 },
      // 22 * $0.30/M + 36 * $1.20/M = 49.8 micro-USD, rounded up.
      baseCostMicroUsd: 50,
      costMicroUsd: 50,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  test('a chat call says whether it starts her request (turns counter)', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    const args = {
      caller, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek' as const,
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-v4-flash', usage,
    };
    expect(await meter().tokenRecord({ ...args, turnStart: true })).toMatchObject({ counters: { turns: 1 }, details: { turnStart: true } });
    expect(await meter().tokenRecord({ ...args, turnStart: false })).toMatchObject({ counters: { turns: 0 }, details: { turnStart: false } });
    const unsaid = await meter().tokenRecord(args);
    expect(unsaid?.counters).not.toHaveProperty('turns');
    expect(unsaid?.details).not.toHaveProperty('turnStart');
  });

  test('a served model with its own SKU is billed at that SKU', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    prices['PRICING#deepseek-v4-pro'] = [{ ...flat, outputMicroUsdPerMTok: 10_000_000 }];
    const r = await meter().tokenRecord({
      caller, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-v4-pro', usage,
    });
    expect(r?.details.sku).toBe('deepseek-v4-pro');
    expect(r?.pricingVersion).toBe('deepseek-v4-pro@2026-10-01');
  });

  test('an unpriced served model falls back to the requested price and alarms', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    const r = await meter().tokenRecord({
      caller, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-v5-surprise', usage,
    });
    expect(r?.details).toMatchObject({ sku: 'deepseek-v4-flash', servedModel: 'deepseek-v5-surprise' });
    expect(r?.costMicroUsd).toBe(50);
    expect(console.error).toHaveBeenCalledWith('SERVED_MODEL_UNPRICED', expect.anything());
  });

  test('context tier is recorded and prices the whole call', async () => {
    prices['PRICING#deepseek-v4-flash'] = [{ ...flat, tiers: [{ aboveInputTokens: 20, ...flat, outputMicroUsdPerMTok: 2_400_000 }] }];
    const r = await meter().tokenRecord({
      caller, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-v4-flash', usage,
    });
    // 22 * 0.30 + 36 * 2.40 = 6.6 + 86.4 = 93
    expect(r).toMatchObject({ costMicroUsd: 93, details: { pricingTier: '>20' } });
  });

  test('missing usage is not metered (logged, never guessed)', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    const r = await meter().tokenRecord({
      caller, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-v4-flash', usage: undefined,
    });
    expect(r).toBeUndefined();
  });

  test('legacy prepaid callers deduct credit', async () => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    const r = await meter().tokenRecord({
      caller: { sub: 'u1', householdId: 'fam' }, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing: await requested(), servedModel: 'deepseek-v4-flash', usage,
    });
    expect(r).toMatchObject({ deductCredit: true });
    expect(r).not.toHaveProperty('plan');
  });
});

describe('record (durable)', () => {
  const r = meter().charRecord({
    caller, requestId: 'req-9', at: AT, kind: 'tts', sku: 'gcp-tts-wavenet',
    pricing: { version: 'gcp-tts-wavenet@2026-09-29', microUsdPerMChars: 4_000_000 }, chars: 235, details: { voice: 'v' },
  });

  test('charRecord prices per character', () => {
    expect(r).toMatchObject({ costMicroUsd: 940, counters: { ttsChars: 235 }, details: { sku: 'gcp-tts-wavenet', chars: 235, voice: 'v' } });
  });

  test('recorded inline', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await expect(meter().record(r)).resolves.toBe('recorded');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  test('a failed write is deferred to the retry queue with the exact record', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('ddb down'));
    sqsMock.on(SendMessageCommand).resolves({});
    await expect(meter().record(r)).resolves.toBe('deferred');
    const sent = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(sent.QueueUrl).toBe('https://sqs/retry');
    expect(JSON.parse(sent.MessageBody!)).toEqual(r);
    expect(console.error).not.toHaveBeenCalled();
  });

  test('if the queue fails too, USAGE_RECORD_FAILED is logged (alarm) with the record', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('ddb down'));
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs down'));
    await expect(meter().record(r)).resolves.toBe('failed');
    expect(console.error).toHaveBeenCalledWith('USAGE_RECORD_FAILED', expect.objectContaining({ record: r }));
  });
});

describe('billing modes', () => {
  const withBilling = (billing: 'hosted' | 'none', markupBps = 1_000) =>
    new Meter({ ...cfg, markupBps, limits: { ...cfg.limits, billing } }, { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) });
  const noPlan = { 'USER#u1|PROFILE': { householdId: 'fam' }, 'HOUSEHOLD#fam|META': { creditBalanceMicroUsd: 0 } };
  const overAllowance = { ...base, 'HOUSEHOLD#fam|USAGE#nieto#2026-10': { costMicroUsd: 5_000_000 } };
  const record = async (m: Meter) => {
    prices['PRICING#deepseek-v4-flash'] = [flat];
    pricing();
    const requestedPricing = (await m.tokenPricing('deepseek-v4-flash', AT))!;
    return (await m.tokenRecord({
      caller: { sub: 'u1', householdId: 'fam' }, requestId: 'r', at: AT, kind: 'chat', provider: 'deepseek',
      requestedModel: 'deepseek-v4-flash', requestedPricing, servedModel: 'deepseek-v4-flash', usage,
    }))!;
  };

  test('hosted: credit required and deducted (with markup), allowance refuses', async () => {
    table(noPlan);
    expect(await withBilling('hosted').authorize('u1', AT)).toMatchObject({ ok: false, status: 402, body: { error: 'insufficient_credit' } });
    table(overAllowance);
    expect(await withBilling('hosted').authorize('u1', AT)).toMatchObject({ ok: false, status: 402, body: { error: 'monthly_allowance_reached' } });
    const r = await record(withBilling('hosted'));
    expect(r).toMatchObject({ deductCredit: true, markupBps: 1_000, baseCostMicroUsd: 50, costMicroUsd: 55 });
    expect(usageTransaction('t', r).input.TransactItems!.at(-1)!.Update!.UpdateExpression).toBe('ADD creditBalanceMicroUsd :neg');
  });

  test('none: no credit needed or deducted, no markup, no allowance; caps still refuse and events are recorded', async () => {
    table(noPlan);
    expect(await withBilling('none').authorize('u1', AT)).toMatchObject({ ok: true, tier: 'normal' });
    table(overAllowance);
    const auth = await withBilling('none').authorize('u1', AT);
    expect(auth).toMatchObject({ ok: true, tier: 'normal' });
    expect(auth).not.toHaveProperty('householdMonthPct');
    table({ ...noPlan, 'USER#u1|DAILY#nieto#2026-10-15': { costMicroUsd: 500_000 } });
    expect(await withBilling('none').authorize('u1', AT)).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
    table({ ...noPlan, 'APP#nieto|DAILY#2026-10-15': { costMicroUsd: 3_000_000 } });
    expect(await withBilling('none').authorize('u1', AT)).toMatchObject({ ok: false, status: 503, body: { error: 'service_paused' } });

    const r = await record(withBilling('none'));
    expect(r).toMatchObject({ deductCredit: false, markupBps: 0, baseCostMicroUsd: 50, costMicroUsd: 50 });
    const tx = usageTransaction('t', r).input.TransactItems!;
    expect(tx[0].Put!.Item).toMatchObject({ PK: 'USER#u1', costMicroUsd: 50 });
    expect(JSON.stringify(tx)).not.toContain('creditBalanceMicroUsd');
  });
});

test('rejects an invalid appId', () => {
  expect(() => new Meter({ ...cfg, appId: 'Nieto#1' }, { ddb: {} as any, sqs: {} as any })).toThrow();
});
