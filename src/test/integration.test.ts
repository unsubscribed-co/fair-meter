import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { FairMeter, type CallRequest, type FairMeterConfig, type Reservation } from '../fair-meter';
import { setTableKeys } from '../keys';
import { syncPrices } from '../prices-cli';
import { loadPriceFiles } from '../prices';
import { sweep } from '../sweep-handler';

/*
 * ★ tests: real conditions and transactions, against DynamoDB Local (CI runs it as a service
 * container). Skipped unless DYNAMODB_ENDPOINT is set.
 */
const endpoint = process.env.DYNAMODB_ENDPOINT;
// CI must never skip them silently.
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');
const suite = endpoint ? describe : describe.skip;

// The queue is never reached in these tests except where a test says so.
const sqsMock = mockClient(SQSClient);
const TABLE = `fair-meter-it-${Date.now()}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const ddb = DynamoDBDocumentClient.from(raw);
const config: FairMeterConfig = {
  appId: 'stacksplit', env: 'prod', tableName: TABLE, retryQueueUrl: 'https://sqs/never-used',
  dailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 100_000_000, tableKeys: { pk: 'pk', sk: 'sk' },
};
let clock = new Date('2026-11-03T14:05:09.120Z');
const meter = (cfg: Partial<FairMeterConfig> = {}, client = ddb) => new FairMeter({ ...config, ...cfg }, { ddb: client, sqs: new SQSClient({ region: 'us-east-1' }), now: () => clock });
const RESERVED = 5_798; // 30,000 bytes in, 4,096 out at Haiku 5.5 (no context tier reachable)
const ask = (person: string): CallRequest => ({ person, sku: 'claude-haiku-5-5', paidBy: 'credit', max: { inputTokens: 30_000, outputTokens: 4_096 } });
const usage = { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000, output_tokens: 100 }; // 440 µUSD

const get = async (pk: string, sk: string) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk }, ConsistentRead: true }))).Item;
const day = (person: string, d = '2026-11-03') => get(`USER#${person}`, `DAILY#stacksplit#${d}`);
const ledger = async (person: string) =>
  (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `USER#${person}` }, ConsistentRead: true }))).Items ?? [];
const pendingOf = async (person: string) =>
  ((await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'PENDING#stacksplit' }, ConsistentRead: true }))).Items ?? [])
    .filter((p) => p.person === person);
const events = async (person: string) => (await ledger(person)).filter((i) => String(i.sk).startsWith('EVENT#'));
const month = (person: string) => get(`USER#${person}`, 'USAGE#stacksplit#2026-11');
/** What the person is charged on a row: list-price cost minus what the operator absorbed. */
const charged = (row?: Record<string, any>) => Number(row?.costMicroUsd ?? 0) - Number(row?.absorbedMicroUsd ?? 0);

suite('★ FairMeter against DynamoDB Local', () => {
  beforeAll(async () => {
    setTableKeys({ pk: 'pk', sk: 'sk' });
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    }));
    // The prices come from prices/, through the CLI's own sync.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await syncPrices(ddb, TABLE, loadPriceFiles(), new Date('2026-10-28T12:00:00Z'), false);
  });
  afterAll(() => setTableKeys(undefined));
  beforeEach(() => {
    clock = new Date('2026-11-03T14:05:09.120Z');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('sync again: nothing changes', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(await syncPrices(ddb, TABLE, loadPriceFiles(), new Date('2026-10-29T00:00:00Z'), false)).toEqual(['Prices are in sync.']);
  });

  test('walkthrough A: reserve, settle at the actual cost, PENDING gone, committed = actual', async () => {
    const call = (await meter().authorize(ask('a@x.co'))) as Reservation;
    expect(call.ok).toBe(true);
    expect(await day('a@x.co')).toMatchObject({ committedMicroUsd: RESERVED });
    expect(await pendingOf('a@x.co')).toHaveLength(1);
    expect(await meter().record(call, usage)).toBe('recorded');
    expect(await pendingOf('a@x.co')).toHaveLength(0);
    expect(await day('a@x.co')).toMatchObject({ committedMicroUsd: 440, costMicroUsd: 440, requests: 1, inputTokens: 1000 });
    expect(await events('a@x.co')).toEqual([expect.objectContaining({ costMicroUsd: 440, reservedMicroUsd: RESERVED, paidBy: 'credit', env: 'prod' })]);
    expect(await get('PROVIDER#anthropic', 'DAILY#2026-11-03')).toMatchObject({ baseCostMicroUsd: 440 });
    // Real usage: the person pays it all.
    expect((await events('a@x.co'))[0]).not.toHaveProperty('absorbedMicroUsd');
    expect(charged(await day('a@x.co'))).toBe(440);
    expect(charged(await month('a@x.co'))).toBe(440);
  });

  test('T1: a crash between reserve and settle: nothing at +29 min, swept at +31', async () => {
    const call = (await meter().authorize(ask('t1@x.co'))) as Reservation;
    expect(await sweep(ddb, config, new Date(clock.getTime() + 29 * 60_000))).toEqual({ settled: 0 });
    expect(await pendingOf('t1@x.co')).toHaveLength(1);
    await sweep(ddb, config, new Date(clock.getTime() + 31 * 60_000));
    expect(await pendingOf('t1@x.co')).toHaveLength(0);
    expect(await events('t1@x.co')).toEqual([expect.objectContaining({ requestId: call.callId, costMicroUsd: RESERVED, estimated: 'swept' })]);
    expect(await day('t1@x.co')).toMatchObject({ committedMicroUsd: RESERVED, costMicroUsd: RESERVED });
    expect(console.error).toHaveBeenCalledWith('SETTLED_BY_SWEEPER', expect.objectContaining({ callId: call.callId }));

    // T9: the real usage arrives later: one ADJUST late-usage, written once.
    expect(await meter().record(call, usage)).toBe('trued_up');
    // Again: within 10 minutes DynamoDB's token makes it a silent success, after that the ADJUST key refuses it.
    expect(['trued_up', 'duplicate']).toContain(await meter().record(call, usage));
    const adjustments = (await ledger('t1@x.co')).filter((i) => String(i.sk).startsWith('ADJUST#'));
    expect(adjustments).toEqual([expect.objectContaining({ reason: 'late-usage', deltaMicroUsd: 440 - RESERVED, absorbedMicroUsd: -RESERVED })]);
    expect(await day('t1@x.co')).toMatchObject({ costMicroUsd: 440, committedMicroUsd: RESERVED });
    // The attempt served the person after all: they pay its real cost.
    expect(charged(await day('t1@x.co'))).toBe(440);
    expect(charged(await month('t1@x.co'))).toBe(440);
  });

  test("absorbed: a late 'not_billed' after a sweep leaves the person at $0", async () => {
    const call = (await meter().authorize(ask('ab-nb@x.co'))) as Reservation;
    await sweep(ddb, config, new Date(clock.getTime() + 31 * 60_000));
    expect(await meter().record(call, 'not_billed')).toBe('trued_up');
    const adjustments = (await ledger('ab-nb@x.co')).filter((i) => String(i.sk).startsWith('ADJUST#'));
    expect(adjustments).toEqual([expect.objectContaining({ deltaMicroUsd: -RESERVED, absorbedMicroUsd: -RESERVED })]);
    expect(await day('ab-nb@x.co')).toMatchObject({ costMicroUsd: 0, absorbedMicroUsd: 0 });
    expect(charged(await day('ab-nb@x.co'))).toBe(0);
    expect(charged(await month('ab-nb@x.co'))).toBe(0);
  });

  test('absorbed: a swept attempt counts toward the cap at list price, the person pays $0', async () => {
    const call = (await meter().authorize(ask('ab-sweep@x.co'))) as Reservation;
    await sweep(ddb, config, new Date(clock.getTime() + 31 * 60_000));
    expect(await events('ab-sweep@x.co')).toEqual([expect.objectContaining({ costMicroUsd: RESERVED, absorbedMicroUsd: RESERVED })]);
    expect(await day('ab-sweep@x.co')).toMatchObject({ committedMicroUsd: RESERVED, costMicroUsd: RESERVED });
    expect(charged(await day('ab-sweep@x.co'))).toBe(0);
    expect(charged(await month('ab-sweep@x.co'))).toBe(0);
    expect(await get('APP#stacksplit', 'DAILY#2026-11-03')).not.toHaveProperty('absorbedMicroUsd');
    expect(console.error).toHaveBeenCalledWith('SETTLED_BY_SWEEPER', expect.objectContaining({ callId: call.callId, absorbedMicroUsd: RESERVED }));
  });

  test('T2: the same usage twice: counters added once', async () => {
    const call = (await meter().authorize(ask('t2@x.co'))) as Reservation;
    expect(await meter().record(call, usage)).toBe('recorded');
    // DynamoDB's token makes a repeat within 10 minutes a silent success; after that the condition says duplicate.
    expect(['recorded', 'duplicate']).toContain(await meter().record(call, usage));
    expect(await day('t2@x.co')).toMatchObject({ requests: 1, costMicroUsd: 440, committedMicroUsd: 440 });
    expect(await events('t2@x.co')).toHaveLength(1);
  });

  test('T3: a different payload for the same hold: conflict, ledger unchanged', async () => {
    const call = (await meter().authorize(ask('t3@x.co'))) as Reservation;
    await meter().record(call, usage);
    expect(await meter().record(call, { ...usage, output_tokens: 999 })).toBe('conflict');
    expect(console.error).toHaveBeenCalledWith('RECORD_CONFLICT', expect.anything());
    expect(await day('t3@x.co')).toMatchObject({ requests: 1, costMicroUsd: 440 });
  });

  test('T4: 10 parallel authorize calls against a cap that fits 9', async () => {
    const tight = meter({ dailyCapMicroUsd: 9 * RESERVED + 100 });
    const results = await Promise.all(Array.from({ length: 10 }, () => tight.authorize(ask('t4@x.co'))));
    expect(results.filter((r) => r.ok)).toHaveLength(9);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ status: 429, body: expect.objectContaining({ error: 'daily_limit_reached' }) })]);
    expect(await day('t4@x.co')).toMatchObject({ committedMicroUsd: 9 * RESERVED });
    expect(await pendingOf('t4@x.co')).toHaveLength(9);
  });

  test.each([['undefined', undefined], ['{}', {}]])('T6: no usable usage (%s): the hold, no_usage, USAGE_MISSING', async (name, given) => {
    const person = `t6-${name.length}@x.co`;
    const call = (await meter().authorize(ask(person))) as Reservation;
    expect(await meter().record(call, given)).toBe('recorded');
    expect(await events(person)).toEqual([expect.objectContaining({ costMicroUsd: RESERVED, estimated: 'no_usage' })]);
    // A 200 without usage served the person: not absorbed.
    expect((await events(person))[0]).not.toHaveProperty('absorbedMicroUsd');
    expect(charged(await day(person))).toBe(RESERVED);
    expect(console.error).toHaveBeenCalledWith('USAGE_MISSING', expect.anything());
  });

  test("T7: 'unknown': aborted, at the hold, no error log", async () => {
    const call = (await meter().authorize(ask('t7@x.co'))) as Reservation;
    expect(await meter().record(call, 'unknown')).toBe('recorded');
    expect(await events('t7@x.co')).toEqual([expect.objectContaining({ costMicroUsd: RESERVED, estimated: 'aborted', absorbedMicroUsd: RESERVED })]);
    expect(console.error).not.toHaveBeenCalled();
    // Counted toward the cap at the hold; the operator absorbs it.
    expect(await day('t7@x.co')).toMatchObject({ committedMicroUsd: RESERVED, costMicroUsd: RESERVED });
    expect(charged(await day('t7@x.co'))).toBe(0);
    expect(charged(await month('t7@x.co'))).toBe(0);
  });

  test("{ estimate }: aborted at the app's estimate; committed released down to it", async () => {
    const call = (await meter().authorize(ask('est@x.co'))) as Reservation;
    expect(await meter().record(call, { estimate: { input_tokens: 7_000, output_tokens: 0 } })).toBe('recorded');
    expect(await events('est@x.co')).toEqual([expect.objectContaining({ costMicroUsd: 700, estimated: 'aborted', absorbedMicroUsd: 700 })]);
    expect(await day('est@x.co')).toMatchObject({ committedMicroUsd: 700, costMicroUsd: 700 });
    expect(charged(await day('est@x.co'))).toBe(0);
    expect(charged(await month('est@x.co'))).toBe(0);
  });

  test('{ estimate } in canonical meters: aborted at that estimate, the same as the provider block', async () => {
    const call = (await meter().authorize(ask('canon@x.co'))) as Reservation;
    expect(await meter().record(call, { estimate: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 2000 } })).toBe('recorded');
    expect(await events('canon@x.co')).toEqual([expect.objectContaining({
      costMicroUsd: 440, estimated: 'aborted', absorbedMicroUsd: 440, inputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 2000, outputTokens: 100, reasoningTokens: 0,
    })]);
    expect(await day('canon@x.co')).toMatchObject({ committedMicroUsd: 440, costMicroUsd: 440 });
    expect(await pendingOf('canon@x.co')).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("'not_sent': the hold released like 'not_billed', and one after the other is a duplicate", async () => {
    const call = (await meter().authorize(ask('ns@x.co'))) as Reservation;
    expect(await day('ns@x.co')).toMatchObject({ committedMicroUsd: RESERVED });
    expect(await meter().record(call, 'not_sent')).toBe('recorded');
    expect(await day('ns@x.co')).toMatchObject({ committedMicroUsd: 0 });
    expect(await events('ns@x.co')).toHaveLength(0);
    expect(await pendingOf('ns@x.co')).toHaveLength(0);
    // The same record: DynamoDB's token makes the repeat a silent success; after 10 minutes the condition says duplicate.
    expect(['recorded', 'duplicate']).toContain(await meter().record(call, 'not_billed'));
    expect(await day('ns@x.co')).toMatchObject({ committedMicroUsd: 0 });
    expect(console.error).not.toHaveBeenCalled();
  });

  test("T8: 'not_billed': no EVENT, PENDING gone, committed back where it was", async () => {
    const first = (await meter().authorize(ask('t8@x.co'))) as Reservation;
    await meter().record(first, usage);
    const call = (await meter().authorize(ask('t8@x.co'))) as Reservation;
    expect(await day('t8@x.co')).toMatchObject({ committedMicroUsd: 440 + RESERVED });
    expect(await meter().record(call, 'not_billed')).toBe('recorded');
    expect(await day('t8@x.co')).toMatchObject({ committedMicroUsd: 440, requests: 1 });
    expect(await events('t8@x.co')).toHaveLength(1);
    expect(await pendingOf('t8@x.co')).toHaveLength(0);
  });

  test('T15: actual above the hold: the actual cost, committed over by the excess', async () => {
    const call = (await meter().authorize(ask('t15@x.co'))) as Reservation;
    expect(await meter().record(call, { input_tokens: 0, output_tokens: 20_000 })).toBe('recorded');
    expect(await day('t15@x.co')).toMatchObject({ committedMicroUsd: 10_000, costMicroUsd: 10_000 });
    expect(console.error).toHaveBeenCalledWith('RESERVATION_EXCEEDED', expect.anything());
  });

  /** A client whose reserve transactions commit, then report a failure `times` times (a lost response). */
  function lossyReserves(times: number) {
    const client = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const state = { left: times };
    client.middlewareStack.add((next) => async (args) => {
      const out = await next(args);
      const input = JSON.stringify(args.input);
      if (state.left > 0 && input.includes('PENDING#') && input.includes('"Put"')) {
        state.left--;
        throw new Error('connection reset after the commit');
      }
      return out;
    }, { step: 'initialize' });
    return { ddb: DynamoDBDocumentClient.from(client), state };
  }

  test('T17 / M3: the reserve committed but its answer was lost: the identical resend finds the hold (same token)', async () => {
    const lossy = lossyReserves(1);
    const result = await meter({}, lossy.ddb).authorize(ask('t17@x.co'));
    expect(lossy.state.left).toBe(0);
    expect(result).toMatchObject({ ok: true });
    // Held once, not twice: DynamoDB Local honours the token on the resend.
    expect(await pendingOf('t17@x.co')).toHaveLength(1);
    expect(await day('t17@x.co')).toMatchObject({ committedMicroUsd: RESERVED });
    expect(await meter().record(result as Reservation, usage)).toBe('recorded');
  });

  test('M3: still unresolved after the resends: refused, the committed hold released, a delayed release queued', async () => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({});
    const lossy = lossyReserves(3);
    expect(await meter({}, lossy.ddb).authorize(ask('m3@x.co'))).toMatchObject({ ok: false, status: 503 });
    expect(await pendingOf('m3@x.co')).toHaveLength(0);
    expect(await day('m3@x.co')).toMatchObject({ committedMicroUsd: 0 });
    expect(sqsMock.commandCalls(SendMessageCommand).map((c) => c.args[0].input.DelaySeconds)).toEqual([60]);
    // Nothing is left for the sweeper to turn into a charge for a call never made.
    await sweep(ddb, config, new Date(clock.getTime() + 31 * 60_000));
    expect(await events('m3@x.co')).toHaveLength(0);
  });

  test('unverified in the design: a cancelled transaction does not use up its ClientRequestToken (DynamoDB Local only)', async () => {
    const token = `cancelled-${Date.now()}`;
    const gated = () => new TransactWriteCommand({
      ClientRequestToken: token,
      TransactItems: [
        { ConditionCheck: { TableName: TABLE, Key: { pk: 'TOKEN#probe', sk: 'gate' }, ConditionExpression: 'attribute_exists(pk)' } },
        { Put: { TableName: TABLE, Item: { pk: 'TOKEN#probe', sk: 'written' } } },
      ],
    });
    await expect(ddb.send(gated())).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: 'TOKEN#probe', sk: 'gate' } }));
    // The identical request again, same token: it runs, rather than replaying the cancellation.
    await ddb.send(gated());
    expect(await get('TOKEN#probe', 'written')).toBeDefined();
  });

  test('every authorize logs one AUTHORIZE_TIMING line, refusals included', async () => {
    await meter().authorize(ask('timing@x.co'));
    await meter().authorize({ ...ask('timing@x.co'), sku: 'no-such-sku' });
    await meter().authorize({ ...ask('timing@x.co'), max: undefined } as unknown as CallRequest);
    const ms = expect.any(Number);
    const lines = (console.log as jest.Mock).mock.calls.filter(([term]) => term === 'AUTHORIZE_TIMING').map(([, fields]) => fields);
    expect(lines).toEqual([
      { appId: 'stacksplit', sku: 'claude-haiku-5-5', outcome: 'ok', readsMs: ms, reserveMs: ms, totalMs: ms, attempts: 1 },
      { appId: 'stacksplit', sku: 'no-such-sku', outcome: 'pricing_not_configured', readsMs: ms, reserveMs: 0, totalMs: ms, attempts: 0 },
      { appId: 'stacksplit', sku: 'claude-haiku-5-5', outcome: 'metering_unavailable', readsMs: 0, reserveMs: 0, totalMs: ms, attempts: 0 },
    ]);
  });

  describe('price cache: one price query per SKU per 5 minutes per instance', () => {
    const unitsAsk = (sku: string): CallRequest => ({ person: `${sku}@x.co`, sku, max: { units: 1 } });
    const putVersion = (sku: string, validFrom: string, microUsdPerKUnits: number, validTo?: string) =>
      ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `PRICING#${sku}`, sk: validFrom, validFrom, provider: 'aws', microUsdPerKUnits, ...(validTo ? { validTo } : {}) } }));
    /** A client of its own, so the test sees how many price queries the meter sent. */
    const counting = () => {
      const client = DynamoDBDocumentClient.from(raw);
      const send = jest.spyOn(client, 'send');
      const priceQueries = () => send.mock.calls.filter(([c]) => c instanceof QueryCommand && String(c.input.ExpressionAttributeValues?.[':pk']).startsWith('PRICING#')).length;
      return { client, priceQueries };
    };

    test('two authorizes within 5 minutes: one query, each priced at the version valid at its own time; a new query after 5', async () => {
      await putVersion('it-cached', '2026-11-03T00:00:00Z', 1_000_000, '2026-11-03T15:00:00Z');
      await putVersion('it-cached', '2026-11-03T15:00:00Z', 2_000_000);
      const { client, priceQueries } = counting();
      const m = meter({}, client);
      clock = new Date('2026-11-03T14:58:00.000Z');
      expect(await m.authorize(unitsAsk('it-cached'))).toMatchObject({ ok: true, hold: { pricingVersion: 'it-cached@2026-11-03T00:00:00Z', reservedMicroUsd: 1_000 } });
      clock = new Date('2026-11-03T15:02:59.999Z');
      expect(await m.authorize(unitsAsk('it-cached'))).toMatchObject({ ok: true, hold: { pricingVersion: 'it-cached@2026-11-03T15:00:00Z', reservedMicroUsd: 2_000 } });
      expect(priceQueries()).toBe(1);
      clock = new Date('2026-11-03T15:03:00.000Z');
      await m.authorize(unitsAsk('it-cached'));
      expect(priceQueries()).toBe(2);
    });

    test('no version yet is not cached: a version synced a minute later is found', async () => {
      const { client, priceQueries } = counting();
      const m = meter({}, client);
      expect(await m.authorize(unitsAsk('it-late'))).toMatchObject({ ok: false, body: { error: 'pricing_not_configured' } });
      await putVersion('it-late', '2026-11-03T00:00:00Z', 1_000_000);
      clock = new Date(clock.getTime() + 60_000);
      expect(await m.authorize(unitsAsk('it-late'))).toMatchObject({ ok: true });
      expect(priceQueries()).toBe(2);
    });
  });

  describe('usage(person)', () => {
    const CAP = config.dailyCapMicroUsd;
    const resets = { day: '2026-11-04T00:00:00.000Z', month: '2026-12-01T00:00:00.000Z' };

    test('no rows: zeros, the full cap as room, normal', async () => {
      expect(await meter().usage('u-none@x.co')).toEqual({
        day: { spentMicroUsd: 0, heldMicroUsd: 0, capMicroUsd: CAP, roomMicroUsd: CAP, resetsAt: resets.day },
        month: { spentMicroUsd: 0, resetsAt: resets.month },
        tier: 'normal',
        readOnly: false,
      });
    });

    test('after a hold: held is the hold amount, nothing spent yet', async () => {
      await meter().authorize(ask('u-hold@x.co'));
      expect(await meter().usage('u-hold@x.co')).toEqual({
        day: { spentMicroUsd: 0, heldMicroUsd: RESERVED, capMicroUsd: CAP, roomMicroUsd: CAP - RESERVED, resetsAt: resets.day },
        month: { spentMicroUsd: 0, resetsAt: resets.month },
        tier: 'normal',
        readOnly: false,
      });
    });

    test('after a settle: spent is the cost, nothing held', async () => {
      const call = (await meter().authorize(ask('u-settle@x.co'))) as Reservation;
      await meter().record(call, usage);
      expect(await meter().usage('u-settle@x.co')).toMatchObject({
        day: { spentMicroUsd: 440, heldMicroUsd: 0, roomMicroUsd: CAP - 440 },
        month: { spentMicroUsd: 440 },
      });
    });

    test('an absorbed attempt: counted toward the cap, not in what the person spent', async () => {
      const served = (await meter().authorize(ask('u-abs@x.co'))) as Reservation;
      await meter().record(served, usage);
      const aborted = (await meter().authorize(ask('u-abs@x.co'))) as Reservation;
      await meter().record(aborted, 'unknown');
      expect(await meter().usage('u-abs@x.co')).toMatchObject({
        day: { spentMicroUsd: 440, heldMicroUsd: 0, roomMicroUsd: CAP - 440 - RESERVED },
        month: { spentMicroUsd: 440 },
      });
    });

    test('across a UTC day change: a new day, the same month', async () => {
      clock = new Date('2026-11-03T23:59:00.000Z');
      await meter().record((await meter().authorize(ask('u-midnight@x.co'))) as Reservation, usage);
      clock = new Date('2026-11-04T00:00:01.000Z');
      expect(await meter().usage('u-midnight@x.co')).toEqual({
        day: { spentMicroUsd: 0, heldMicroUsd: 0, capMicroUsd: CAP, roomMicroUsd: CAP, resetsAt: '2026-11-05T00:00:00.000Z' },
        month: { spentMicroUsd: 440, resetsAt: resets.month },
        tier: 'normal',
        readOnly: false,
      });
    });
  });

  describe('actions: the floor and the write check', () => {
    const FLOOR = 30_000;
    const withActions = () => meter({ actions: { skus: ['stacksplit-new-expense'], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: FLOOR });
    /** What the rollup will do: an actions EVENT adds its cost to committed (ticket 10). */
    const rollUp = (person: string, micro: number) => ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: `USER#${person}`, sk: 'DAILY#stacksplit#2026-11-03' }, UpdateExpression: 'ADD committedMicroUsd :c, costMicroUsd :c', ExpressionAttributeValues: { ':c': micro },
    }));

    test('AI holds stop at cap - floor while canWrite still allows', async () => {
      const m = withActions();
      await rollUp('act-ai@x.co', 500_000 - FLOOR - 2 * RESERVED);
      expect(await m.authorize(ask('act-ai@x.co'))).toMatchObject({ ok: true });
      expect(await m.authorize(ask('act-ai@x.co'))).toMatchObject({ ok: true });
      expect(await m.authorize(ask('act-ai@x.co'))).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
      expect(await day('act-ai@x.co')).toMatchObject({ committedMicroUsd: 500_000 - FLOOR });
      expect(await m.canWrite('act-ai@x.co')).toEqual({ ok: true });
      expect(await m.usage('act-ai@x.co')).toMatchObject({ readOnly: false });
      // Without actions the same person could still hold up to the cap: v0.2.0 is unchanged.
      expect(await meter().authorize(ask('act-ai@x.co'))).toMatchObject({ ok: true });
    });

    test('a DAILY row pushed past cap - floor by the rollup: read-only until the next UTC day', async () => {
      const m = withActions();
      await rollUp('act-ro@x.co', 500_000 - FLOOR + 1);
      expect(await m.canWrite('act-ro@x.co')).toEqual({ ok: false, status: 429, body: { error: 'daily_limit_reached', resetsAt: '2026-11-04T00:00:00.000Z' }, headers: {}, tier: 'essential' });
      expect(await m.usage('act-ro@x.co')).toMatchObject({ readOnly: true });
      clock = new Date('2026-11-04T00:00:01.000Z');
      expect(await m.canWrite('act-ro@x.co')).toEqual({ ok: true });
      expect(await m.usage('act-ro@x.co')).toMatchObject({ readOnly: false });
    });
  });

  test('T18: reserved at 23:59:59.900, settled after midnight: the earlier day and month', async () => {
    clock = new Date('2026-11-30T23:59:59.900Z');
    const call = (await meter().authorize(ask('t18@x.co'))) as Reservation;
    clock = new Date('2026-12-01T00:00:01.000Z');
    expect(await meter().record(call, usage)).toBe('recorded');
    expect(await day('t18@x.co', '2026-11-30')).toMatchObject({ committedMicroUsd: 440, costMicroUsd: 440 });
    expect(await day('t18@x.co', '2026-12-01')).toBeUndefined();
    expect(await get('USER#t18@x.co', 'USAGE#stacksplit#2026-11')).toMatchObject({ costMicroUsd: 440 });
    expect((await events('t18@x.co'))[0].sk).toMatch(/^EVENT#2026-11-30T23:59:59.900Z#/);
  });
});

suite('★ the ledger table Metering creates: default keys, no setTableKeys', () => {
  const LEDGER = `fair-meter-ledger-it-${Date.now()}`;
  const ledgerConfig: FairMeterConfig = { appId: 'stacksplit', env: 'prod', tableName: LEDGER, retryQueueUrl: 'https://sqs/never-used', dailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 100_000_000 };
  const at = new Date('2026-11-03T14:05:09.120Z');
  const ledgerMeter = () => new FairMeter(ledgerConfig, { ddb, sqs: new SQSClient({ region: 'us-east-1' }), now: () => at });
  const rows = async (person: string) =>
    (await ddb.send(new QueryCommand({ TableName: LEDGER, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `USER#${person}` }, ConsistentRead: true }))).Items ?? [];

  beforeAll(async () => {
    // Metering's table: PK / SK, nothing else.
    await raw.send(new CreateTableCommand({
      TableName: LEDGER,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await syncPrices(ddb, LEDGER, loadPriceFiles(), new Date('2026-10-28T12:00:00Z'), false);
  });
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('authorize, record and the sweeper', async () => {
    const settled = (await ledgerMeter().authorize(ask('l1@x.co'))) as Reservation;
    expect(await ledgerMeter().record(settled, usage)).toBe('recorded');
    const crashed = (await ledgerMeter().authorize(ask('l1@x.co'))) as Reservation;
    expect(await sweep(ddb, ledgerConfig, new Date(at.getTime() + 31 * 60_000))).toEqual({ settled: 1 });

    const items = await rows('l1@x.co');
    expect(items.filter((i) => i.SK.startsWith('EVENT#'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: settled.callId, costMicroUsd: 440 }),
      expect.objectContaining({ requestId: crashed.callId, costMicroUsd: RESERVED, estimated: 'swept' }),
    ]));
    expect(items.find((i) => i.SK === 'DAILY#stacksplit#2026-11-03')).toMatchObject({ costMicroUsd: 440 + RESERVED, committedMicroUsd: 440 + RESERVED });
  });
});
