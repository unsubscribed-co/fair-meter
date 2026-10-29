import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { FairMeter, type CallRequest, type FairMeterConfig, type Reservation } from '../fair-meter';
import { setTableKeys } from '../keys';
import { loadPriceFiles, syncPrices } from '../prices-cli';
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

  test('T3: a different payload for the same reservation: conflict, ledger unchanged', async () => {
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

  test.each([['undefined', undefined], ['{}', {}]])('T6: no usable usage (%s): the reservation, no_usage, USAGE_MISSING', async (name, given) => {
    const person = `t6-${name.length}@x.co`;
    const call = (await meter().authorize(ask(person))) as Reservation;
    expect(await meter().record(call, given)).toBe('recorded');
    expect(await events(person)).toEqual([expect.objectContaining({ costMicroUsd: RESERVED, estimated: 'no_usage' })]);
    // A 200 without usage served the person: not absorbed.
    expect((await events(person))[0]).not.toHaveProperty('absorbedMicroUsd');
    expect(charged(await day(person))).toBe(RESERVED);
    expect(console.error).toHaveBeenCalledWith('USAGE_MISSING', expect.anything());
  });

  test("T7: 'unknown': aborted, at the reservation, no error log", async () => {
    const call = (await meter().authorize(ask('t7@x.co'))) as Reservation;
    expect(await meter().record(call, 'unknown')).toBe('recorded');
    expect(await events('t7@x.co')).toEqual([expect.objectContaining({ costMicroUsd: RESERVED, estimated: 'aborted', absorbedMicroUsd: RESERVED })]);
    expect(console.error).not.toHaveBeenCalled();
    // Counted toward the cap at the reservation; the operator absorbs it.
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

  test('T15: actual above the reservation: the actual cost, committed over by the excess', async () => {
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
