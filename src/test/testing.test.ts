import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import * as root from '../index';
import { FairMeter, type CallRequest, type FairMeterApi, type FairMeterConfig, type Reservation } from '../fair-meter';
import { recordUsage } from '../ledger';
import { syncPrices } from '../prices-cli';
import { loadPriceFiles } from '../prices';
import { FakeFairMeter } from '../testing';

/*
 * The test double can't drift: the same scenarios run against FakeFairMeter and against FairMeter on
 * DynamoDB Local (that half skipped unless DYNAMODB_ENDPOINT is set).
 */
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');

const AT = new Date('2026-11-03T14:05:09.120Z');
const RESETS = { day: '2026-11-04T00:00:00.000Z', month: '2026-12-01T00:00:00.000Z' };
const RESERVED = 5_798; // 30,000 bytes in, 4,096 out at Haiku 5.5
const usage = { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000, output_tokens: 100 }; // 440 µUSD
const SKU = 'stacksplit-new-expense';
const ACTIONS = { skus: [SKU], perPersonPerMinute: 20, maxConcurrency: 10 };
// DynamoDB Local keeps transaction tokens across tables: people unique per run.
const RUN = Date.now();

type Limits = Pick<FairMeterConfig, 'dailyCapMicroUsd' | 'actions' | 'actionFloorMicroUsd'>;
interface Subject {
  meter(limits: Limits): FairMeterApi;
  /** What the rollup does: charge rolled-up actions to the person's day. */
  rollUp(m: FairMeterApi, person: string, costMicroUsd: number): Promise<void>;
}

const TABLE = `fair-meter-contract-${RUN}`;
const WALLET = `wallet-contract-${RUN}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const ddb = DynamoDBDocumentClient.from(raw);
const real: Subject = {
  meter: (limits) => new FairMeter(
    { appId: 'stacksplit', env: 'prod', tableName: TABLE, retryQueueUrl: 'https://sqs/never-used', appDailyCapMicroUsd: 100_000_000, ...limits },
    { ddb, sqs: new SQSClient({ region: 'us-east-1' }), now: () => AT },
  ),
  rollUp: async (_, person, cost) => {
    await recordUsage(ddb, TABLE, {
      appId: 'stacksplit', sub: person, requestId: `actions-${SKU}-2026-11-03T13:45:00.000Z`, requestTime: '2026-11-03T13:45:00.000Z', kind: 'actions',
      pricingVersion: `${SKU}@2026-10-28T00:00:00Z`, details: { provider: 'aws', sku: SKU, actions: 1 }, counters: { actions: 1 },
      baseCostMicroUsd: cost, costMicroUsd: cost, markupBps: 0, deductCredit: false, env: 'prod',
    });
  },
};
const fake: Subject = {
  meter: (limits) => new FakeFairMeter({ ...limits, now: () => AT }),
  rollUp: async (m, person, cost) => (m as FakeFairMeter).rollUp(person, cost),
};

/** Hosted billing: the wallet's top-up, reduced to the guard counter. */
interface HostedSubject {
  meter(limits: Limits): FairMeterApi;
  fund(m: FairMeterApi, account: string, availableMicroUsd: number): Promise<void>;
}
const realHosted: HostedSubject = {
  meter: (limits) => new FairMeter(
    { appId: 'stacksplit', env: 'prod', tableName: TABLE, retryQueueUrl: 'https://sqs/never-used', appDailyCapMicroUsd: 100_000_000, billing: { walletTable: WALLET }, ...limits },
    { ddb, sqs: new SQSClient({ region: 'us-east-1' }), now: () => AT },
  ),
  fund: async (_, account, availableMicroUsd) => {
    await ddb.send(new PutCommand({ TableName: WALLET, Item: { PK: `WALLET#${account}`, SK: 'BALANCE', availableMicroUsd } }));
  },
};
const fakeHosted: HostedSubject = {
  meter: (limits) => new FakeFairMeter({ ...limits, hosted: true, now: () => AT }),
  fund: async (m, account, availableMicroUsd) => (m as FakeFairMeter).fund(account, availableMicroUsd),
};

beforeAll(async () => {
  if (!endpoint) return;
  for (const TableName of [TABLE, WALLET]) {
    await raw.send(new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
  }
  jest.spyOn(console, 'log').mockImplementation(() => {});
  await syncPrices(ddb, TABLE, loadPriceFiles(), new Date('2026-10-28T12:00:00Z'), false);
});
beforeEach(() => {
  for (const level of ['error', 'warn', 'log'] as const) jest.spyOn(console, level).mockImplementation(() => {});
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  ['FakeFairMeter', fake, true],
  ['FairMeter on DynamoDB Local', real, Boolean(endpoint)],
] as const)('contract: %s', (name, subject, runs) => {
  const it = runs ? test : test.skip;
  const who = (p: string) => `${p}-${name === 'FakeFairMeter' ? 'fake' : 'real'}-${RUN}@x.co`;
  const ask = (person: string, max: CallRequest['max'] = { inputTokens: 30_000, outputTokens: 4_096 }): CallRequest =>
    ({ person, sku: 'claude-haiku-5-5', paidBy: 'credit', max });
  const CAP = 500_000;

  const REPEAT = ['recorded', 'duplicate'];

  it('reserve and settle: held, then spent; a repeat changes nothing', async () => {
    const m = subject.meter({ dailyCapMicroUsd: CAP });
    const p = who('settle');
    const call = (await m.authorize(ask(p))) as Reservation;
    expect(call).toMatchObject({ ok: true, tier: 'normal', hold: { person: p, sku: 'claude-haiku-5-5', provider: 'anthropic', reservedMicroUsd: RESERVED, paidBy: 'credit' } });
    expect((await m.usage(p)).day).toMatchObject({ spentMicroUsd: 0, heldMicroUsd: RESERVED, roomMicroUsd: CAP - RESERVED });
    expect(await m.record(call, usage)).toBe('recorded');
    // FairMeter: 'recorded' within DynamoDB's 10-minute token window, 'duplicate' after; settled once either way.
    expect(REPEAT).toContain(await m.record(call, usage));
    expect(await m.usage(p)).toEqual({
      day: { spentMicroUsd: 440, heldMicroUsd: 0, capMicroUsd: CAP, roomMicroUsd: CAP - 440, resetsAt: RESETS.day },
      month: { spentMicroUsd: 440, resetsAt: RESETS.month },
      tier: 'normal',
      readOnly: false,
    });
  });

  it('cap refusal: a hold past the cap, or one bigger than the cap, is daily_limit_reached', async () => {
    const m = subject.meter({ dailyCapMicroUsd: 10_000 });
    const p = who('cap');
    const refusal = { ok: false, status: 429, body: { error: 'daily_limit_reached', resetsAt: RESETS.day }, headers: {}, tier: 'normal' };
    expect(await m.authorize(ask(p))).toMatchObject({ ok: true });
    expect(await m.authorize(ask(p))).toEqual(refusal);
    expect(await m.authorize(ask(who('cap-big'), { inputTokens: 300_000, outputTokens: 4_096 }))).toEqual(refusal);
  });

  it("release: 'not_billed' gives the hold back, 'not_sent' is the same record", async () => {
    const m = subject.meter({ dailyCapMicroUsd: CAP });
    const p = who('release');
    const call = (await m.authorize(ask(p))) as Reservation;
    expect(await m.record(call, 'not_billed')).toBe('recorded');
    expect(REPEAT).toContain(await m.record(call, 'not_sent'));
    expect((await m.usage(p)).day).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0, capMicroUsd: CAP, roomMicroUsd: CAP, resetsAt: RESETS.day });
  });

  it("usage after an absorbed settle ('unknown'): counted toward the cap, $0 to the person", async () => {
    const m = subject.meter({ dailyCapMicroUsd: CAP });
    const p = who('absorbed');
    expect(await m.record((await m.authorize(ask(p))) as Reservation, 'unknown')).toBe('recorded');
    expect(await m.usage(p)).toMatchObject({ day: { spentMicroUsd: 0, heldMicroUsd: 0, roomMicroUsd: CAP - RESERVED }, month: { spentMicroUsd: 0 } });
  });

  it('a SKU without a price: 503 pricing_not_configured', async () => {
    expect(await subject.meter({ dailyCapMicroUsd: CAP }).authorize({ ...ask(who('noprice')), sku: 'no-such-sku' }))
      .toEqual({ ok: false, status: 503, body: { error: 'pricing_not_configured' }, headers: {} });
  });

  it('canWrite below the floor: read-only, and AI holds stop at cap - floor', async () => {
    const m = subject.meter({ dailyCapMicroUsd: 10_000, actions: ACTIONS, actionFloorMicroUsd: 3_000 });
    const p = who('floor');
    expect(await m.canWrite(p)).toEqual({ ok: true });
    await subject.rollUp(m, p, 7_001);
    expect(await m.canWrite(p)).toEqual({ ok: false, status: 429, body: { error: 'daily_limit_reached', resetsAt: RESETS.day }, headers: {}, tier: 'normal' });
    expect(await m.usage(p)).toMatchObject({ day: { spentMicroUsd: 7_001, roomMicroUsd: 2_999 }, readOnly: true });
    expect(await m.authorize(ask(p))).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
  });

  it('canWrite: perPersonPerMinute actions per instance, then too_many_requests until the next minute', async () => {
    const m = subject.meter({ dailyCapMicroUsd: CAP, actions: ACTIONS, actionFloorMicroUsd: 3_000 });
    const p = who('rate');
    m.action({ person: p, sku: SKU, n: 19 });
    expect(await m.canWrite(p)).toEqual({ ok: true });
    expect(await m.canWrite(p, 2)).toEqual({ ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds: 51 }, headers: { 'Retry-After': '51' } });
    // An unknown SKU is an app bug: alarmed, not counted.
    m.action({ person: p, sku: 'not-configured' });
    expect(console.error).toHaveBeenCalledWith('ACTION_UNKNOWN', expect.objectContaining({ sku: 'not-configured' }));
    // Nor is an n above perPersonPerMinute: it would bypass the floor.
    m.action({ person: p, sku: SKU, n: ACTIONS.perPersonPerMinute + 1 });
    expect(console.error).toHaveBeenCalledWith('ACTION_UNKNOWN', expect.objectContaining({ n: ACTIONS.perPersonPerMinute + 1 }));
    expect(await m.canWrite(p)).toEqual({ ok: true });
  });

  it('canWrite without actions configured: 500 metering_unavailable', async () => {
    expect(await subject.meter({ dailyCapMicroUsd: CAP }).canWrite(who('noactions'))).toEqual({ ok: false, status: 500, body: { error: 'metering_unavailable' }, headers: {} });
  });
});

describe.each([
  ['FakeFairMeter', fakeHosted, true],
  ['FairMeter on DynamoDB Local', realHosted, Boolean(endpoint)],
] as const)('contract, hosted billing: %s', (name, subject, runs) => {
  const it = runs ? test : test.skip;
  const who = (p: string) => `${p}-hosted-${name === 'FakeFairMeter' ? 'fake' : 'real'}-${RUN}@x.co`;
  const sub = (p: string) => `sub-${p}-${name === 'FakeFairMeter' ? 'fake' : 'real'}-${RUN}`;
  const ask = (person: string): CallRequest => ({ person, sku: 'claude-haiku-5-5', max: { inputTokens: 30_000, outputTokens: 4_096 } });
  const CAP = 500_000;
  // The hold plus the 100% fee of prices/fee.json; the settle charges 440 plus 440.
  const HELD = 2 * RESERVED;
  const linked = async (p: string, availableMicroUsd: number, limits: Limits = { dailyCapMicroUsd: CAP }) => {
    const m = subject.meter(limits);
    await subject.fund(m, sub(p), availableMicroUsd);
    expect(await m.link(who(p), sub(p), { email: who(p), lang: 'en' })).toBe('linked');
    return m;
  };
  const wallet = async (m: FairMeterApi, p: string) => (await m.usage(who(p))).wallet;

  it('hold and settle: the hold plus its fee leaves available, then cost plus fee is spent', async () => {
    const m = await linked('settle', 100_000);
    const call = (await m.authorize(ask(who('settle')))) as Reservation;
    expect(call.ok).toBe(true);
    expect(await wallet(m, 'settle')).toEqual({ availableMicroUsd: 100_000 - HELD });
    expect(await m.record(call, usage)).toBe('recorded');
    expect(await wallet(m, 'settle')).toEqual({ availableMicroUsd: 100_000 - 880 });
  });

  it("release: the whole hold comes back", async () => {
    const m = await linked('release', 100_000);
    expect(await m.record((await m.authorize(ask(who('release')))) as Reservation, 'not_billed')).toBe('recorded');
    expect(await wallet(m, 'release')).toEqual({ availableMicroUsd: 100_000 });
  });

  it('balance_too_low below the hold plus its fee (402, where to top up); a top-up lets it through', async () => {
    const m = await linked('low', HELD - 1);
    expect(await m.authorize(ask(who('low')))).toEqual({ ok: false, status: 402, body: { error: 'balance_too_low', topUpUrl: 'https://pay.unsubscribed.dev' }, headers: {}, tier: 'normal' });
    await subject.fund(m, sub('low'), HELD);
    expect(await m.authorize(ask(who('low')))).toMatchObject({ ok: true });
    expect(await wallet(m, 'low')).toEqual({ availableMicroUsd: 0 });
  });

  it('unlinked: account_not_linked; linked elsewhere: conflict, then link_conflict', async () => {
    const m = await linked('owner', 100_000);
    expect(await m.authorize(ask(who('stranger')))).toEqual({ ok: false, status: 403, body: { error: 'account_not_linked' }, headers: {} });
    expect(await m.usage(who('stranger'))).not.toHaveProperty('wallet');
    await expect(m.walletPass(who('stranger'))).rejects.toThrow(/account_not_linked/);
    expect(await m.link(who('owner'), sub('intruder'), { email: who('owner'), lang: 'en' })).toBe('conflict');
    expect(await m.authorize(ask(who('owner')))).toEqual({ ok: false, status: 403, body: { error: 'link_conflict' }, headers: {} });
  });

  it('canWrite: available below the floor plus its fee is balance_too_low', async () => {
    const m = await linked('write', 6_000, { dailyCapMicroUsd: CAP, actions: ACTIONS, actionFloorMicroUsd: 3_000 });
    expect(await m.canWrite(who('write'))).toEqual({ ok: true });
    await subject.fund(m, sub('write'), 5_999);
    expect(await m.canWrite(who('write'))).toEqual({ ok: false, status: 402, body: { error: 'balance_too_low', topUpUrl: 'https://pay.unsubscribed.dev' }, headers: {}, tier: 'normal' });
  });

  it('walletPass: a fresh single-use value per call', async () => {
    const m = await linked('pass', 1);
    const pass = await m.walletPass(who('pass'));
    expect(pass).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await m.walletPass(who('pass'))).not.toBe(pass);
  });
});

describe('FakeFairMeter: what only the double does', () => {
  const ask: CallRequest = { person: 'ana@x.co', sku: 'claude-haiku-5-5', max: { inputTokens: 30_000, outputTokens: 4_096 } };

  test('not exported from the package root', () => {
    expect(root).not.toHaveProperty('FakeFairMeter');
  });

  test('defaults: the $0.50 daily cap, the shipped prices, the real clock', async () => {
    const m = new FakeFairMeter();
    expect(await m.authorize(ask)).toMatchObject({ ok: true, hold: { reservedMicroUsd: RESERVED } });
    expect((await m.usage('ana@x.co')).day.capMicroUsd).toBe(500_000);
  });

  test('refuseNext: the next authorize or canWrite gets that refusal, then calls go through again', async () => {
    const m = new FakeFairMeter({ actions: ACTIONS, actionFloorMicroUsd: 3_000, now: () => AT });
    m.refuseNext('service_paused');
    expect(await m.authorize(ask)).toEqual({ ok: false, status: 503, body: { error: 'service_paused', resetsAt: RESETS.day }, headers: {}, tier: 'normal' });
    expect(await m.authorize(ask)).toMatchObject({ ok: true });
    m.refuseNext('too_many_requests');
    expect(await m.canWrite('ana@x.co')).toEqual({ ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds: 51 }, headers: { 'Retry-After': '51' } });
    m.refuseNext('metering_unavailable');
    expect(await m.canWrite('ana@x.co')).toEqual({ ok: false, status: 503, body: { error: 'metering_unavailable' }, headers: {} });
    expect(await m.canWrite('ana@x.co')).toEqual({ ok: true });
  });

  // FairMeter answers these after DynamoDB's 10-minute token window (within it: 'recorded', or 'deferred' to the retry queue).
  test("an identical repeat is 'duplicate', another payload a conflict, counted once", async () => {
    const m = new FakeFairMeter({ now: () => AT });
    const call = (await m.authorize(ask)) as Reservation;
    expect(await m.record(call, usage)).toBe('recorded');
    expect(await m.record(call, usage)).toBe('duplicate');
    expect(await m.record(call, { ...usage, output_tokens: 101 })).toBe('conflict');
    expect(await m.record(call, 'not_billed')).toBe('conflict');
    expect((await m.usage('ana@x.co')).day.spentMicroUsd).toBe(440);
    const released = (await m.authorize(ask)) as Reservation;
    expect(await m.record(released, 'not_billed')).toBe('recorded');
    expect(await m.record(released, 'not_sent')).toBe('duplicate');
    expect(await m.record(released, usage)).toBe('conflict');
    expect((await m.usage('ana@x.co')).day).toMatchObject({ spentMicroUsd: 440, heldMicroUsd: 0 });
  });

  test('hosted rollUp: charges cost plus fee up to what is available, never below zero', async () => {
    const m = new FakeFairMeter({ hosted: true, now: () => AT });
    m.fund('acc', 1_000);
    await m.link('ana@x.co', 'acc', { email: 'ana@x.co', lang: 'es' });
    m.rollUp('ana@x.co', 300);
    expect((await m.usage('ana@x.co')).wallet).toEqual({ availableMicroUsd: 400 });
    m.rollUp('ana@x.co', 300);
    expect((await m.usage('ana@x.co')).wallet).toEqual({ availableMicroUsd: 0 });
    expect(console.error).toHaveBeenCalledWith('FLOOR_OVERRUN', expect.objectContaining({ chargedMicroUsd: 400, absorbedMicroUsd: 200 }));
  });

  test('calls: every public call it saw, in order, with its arguments', async () => {
    const m = new FakeFairMeter({ actions: ACTIONS, actionFloorMicroUsd: 3_000, now: () => AT });
    const call = (await m.authorize(ask)) as Reservation;
    await m.record(call, 'not_sent');
    await m.canWrite('ana@x.co');
    m.action({ person: 'ana@x.co', sku: SKU, n: 3 });
    await m.usage('ana@x.co');
    expect(m.calls).toEqual([
      { method: 'authorize', args: [ask] },
      { method: 'record', args: [call, 'not_sent'] },
      { method: 'canWrite', args: ['ana@x.co', 1] },
      { method: 'action', args: [{ person: 'ana@x.co', sku: SKU, n: 3 }] },
      { method: 'usage', args: ['ana@x.co'] },
    ]);
  });
});
