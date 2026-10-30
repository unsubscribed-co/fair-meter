import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import * as root from '../index';
import { FairMeter, settlementRecord, type CallRequest, type FairMeterConfig, type Reservation } from '../fair-meter';
import { syncPrices } from '../prices-cli';
import { loadPriceFiles } from '../prices';
import { retryUsage } from '../retry-handler';
import { actionQuery, rollup } from '../rollup-handler';
import { sweep } from '../sweep-handler';

/*
 * billing: { walletTable }: every hold, settle, release, sweep and rollup charge moves the person's
 * wallet in the transaction that writes the ledger. Against DynamoDB Local, two tables (the app's
 * ledger and the wallet's); skipped unless DYNAMODB_ENDPOINT is set.
 */
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');
const suite = endpoint ? describe : describe.skip;

const RUN = Date.now();
const LEDGER = `fair-meter-hosted-${RUN}`;
const WALLET = `wallet-${RUN}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const ddb = DynamoDBDocumentClient.from(raw);
// The fee in prices/fee.json: 100% of cost.
const FEE = { versions: [{ validFrom: '2026-10-29T00:00:00Z', feeBps: 10_000 }] };
const config: FairMeterConfig = {
  appId: 'stacksplit', env: 'prod', tableName: LEDGER, retryQueueUrl: 'https://sqs/never-used',
  dailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 100_000_000, billing: { walletTable: WALLET, fee: FEE },
};
const AT = new Date('2026-11-03T14:05:09.120Z');
const meter = (cfg: Partial<FairMeterConfig> = {}, now = () => AT) => new FairMeter({ ...config, ...cfg }, { ddb, sqs: new SQSClient({ region: 'us-east-1' }), now });
/** What support does to relink a person (the wallet's admin command), reduced to the LINK row. */
const relink = (person: string, account: string) =>
  ddb.send(new UpdateCommand({ TableName: WALLET, Key: { PK: `LINK#stacksplit#${person}`, SK: 'LINK' }, UpdateExpression: 'SET account = :a', ExpressionAttributeValues: { ':a': account } }));
const RESERVED = 5_798; // 30,000 bytes in, 4,096 out at Haiku 5.5
const HELD = 2 * RESERVED; // the hold plus the 100% fee
const ask = (person: string): CallRequest => ({ person, sku: 'claude-haiku-5-5', max: { inputTokens: 30_000, outputTokens: 4_096 } });
const usage = { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000, output_tokens: 100 }; // 440 µUSD

const logsMock = mockClient(CloudWatchLogsClient);
const cwl = new CloudWatchLogsClient({ region: 'us-east-1' });
const SKU = 'stacksplit-new-expense';
// 1,000 new expenses: $0.008874 at list price, the same again as the fee.
const THOUSAND = 8_874;
type Line = { person: string; n: number; account?: string };
/** Logs Insights answers the 14:00 window with these rows. */
function lines(rows: Line[]) {
  logsMock.reset();
  logsMock.on(StartQueryCommand).resolves({ queryId: 'q' });
  logsMock.on(GetQueryResultsCommand).resolves({
    status: 'Complete',
    results: rows.map((r) => [
      { field: 'person', value: r.person }, { field: 'sku', value: SKU }, { field: 'env', value: 'prod' }, { field: 'actions', value: String(r.n) },
      ...(r.account ? [{ field: 'account', value: r.account }] : []),
    ]),
  });
}
/** One rollup of the 14:00 window for its own app id (its own cursor): the first run sets the cursor, the second settles. */
async function rollUp(appId: string, rows: Line[]) {
  const cfg = { ...config, appId };
  lines([]);
  await rollup(ddb, cwl, cfg, ['/aws/lambda/api'], new Date('2026-11-03T14:05:00Z'));
  lines(rows);
  return rollup(ddb, cwl, cfg, ['/aws/lambda/api'], new Date('2026-11-03T14:30:00Z'));
}

/** People and accounts unique per run: DynamoDB Local keeps transaction tokens across tables. */
const who = (name: string) => `${name}-${RUN}@x.co`;
const sub = (name: string) => `sub-${name}-${RUN}`;
const getW = async (PK: string, SK: string) => (await ddb.send(new GetCommand({ TableName: WALLET, Key: { PK, SK }, ConsistentRead: true }))).Item;
const balance = (account: string) => getW(`WALLET#${account}`, 'BALANCE');
const spend = (account: string) => getW(`WALLET#${account}`, 'SPEND#2026-11');
/** What the wallet does on a top-up, reduced to the guard counter. */
const fund = (account: string, availableMicroUsd: number) =>
  ddb.send(new PutCommand({ TableName: WALLET, Item: { PK: `WALLET#${account}`, SK: 'BALANCE', availableMicroUsd, heldMicroUsd: 0, spentMicroUsd: 0 } }));
const events = async (person: string) =>
  ((await ddb.send(new QueryCommand({ TableName: LEDGER, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `USER#${person}` }, ConsistentRead: true }))).Items ?? [])
    .filter((i) => String(i.SK).startsWith('EVENT#'));

/** A linked, funded person: their meter, person and account. */
async function linked(name: string, availableMicroUsd: number, cfg: Partial<FairMeterConfig> = {}) {
  const m = meter(cfg);
  const person = who(name);
  const account = sub(name);
  await fund(account, availableMicroUsd);
  expect(await m.link(person, account, { email: person, lang: 'es' })).toBe('linked');
  return { m, person, account };
}

suite('hosted billing against DynamoDB Local', () => {
  beforeAll(async () => {
    for (const TableName of [LEDGER, WALLET]) {
      await raw.send(new CreateTableCommand({
        TableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      }));
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await syncPrices(ddb, LEDGER, loadPriceFiles(), new Date('2026-10-28T12:00:00Z'), false);
  });
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  describe('link', () => {
    test('a first link writes LINK, adds it to BALANCE links and sets the email and lang labels', async () => {
      const person = who('first');
      const account = sub('first');
      expect(await meter().link(person, account, { email: 'first@x.co', lang: 'es' })).toBe('linked');
      expect(await getW(`LINK#stacksplit#${person}`, 'LINK')).toMatchObject({ account });
      expect(await balance(account)).toMatchObject({ links: new Set([`stacksplit#${person}`]), email: 'first@x.co', lang: 'es' });
    });

    test('the same account and labels again (any instance): nothing written', async () => {
      const { m, person, account } = await linked('again', 1_000);
      const before = await balance(account);
      const writes = jest.spyOn(ddb, 'send');
      expect(await m.link(person, account, { email: person, lang: 'es' })).toBe('linked');
      expect(await meter().link(person, account, { email: person, lang: 'es' })).toBe('linked');
      expect(writes.mock.calls.filter(([c]) => !(c instanceof GetCommand))).toEqual([]);
      expect(await balance(account)).toEqual(before);
    });

    test('the same account with a changed email or lang (an app keyed by account id): only the labels are updated', async () => {
      const { m, person, account } = await linked('relabel', 1_000);
      expect(await m.link(person, account, { email: 'renamed@x.co', lang: 'es' })).toBe('linked');
      expect(await balance(account)).toMatchObject({ email: 'renamed@x.co', lang: 'es', availableMicroUsd: 1_000, links: new Set([`stacksplit#${person}`]) });
      expect(await meter().link(person, account, { email: 'renamed@x.co', lang: 'en' })).toBe('linked');
      expect(await balance(account)).toMatchObject({ email: 'renamed@x.co', lang: 'en', availableMicroUsd: 1_000 });
    });

    test('support relinks a conflicting person: their next hosted call goes through, no restart', async () => {
      const { m, person } = await linked('relinked', 1_000);
      const newcomer = sub('relinked-new');
      await fund(newcomer, 100_000);
      expect(await m.link(person, newcomer, { email: person, lang: 'en' })).toBe('conflict');
      expect(await m.authorize(ask(person))).toMatchObject({ ok: false, body: { error: 'link_conflict' } });
      await relink(person, newcomer);
      expect(await m.authorize(ask(person))).toMatchObject({ ok: true, hold: { account: newcomer } });
      expect(await balance(newcomer)).toMatchObject({ heldMicroUsd: HELD });
    });

    test('a link is remembered 5 minutes: after support moves the person, the next link then reads LINK again', async () => {
      let clock = AT;
      const { person, account } = await linked('moved', 100_000);
      const m = meter({}, () => clock);
      expect(await m.link(person, account, { email: person, lang: 'es' })).toBe('linked');
      await relink(person, sub('moved-to'));
      clock = new Date(AT.getTime() + 4 * 60_000);
      expect(await m.link(person, account, { email: person, lang: 'es' })).toBe('linked');
      clock = new Date(AT.getTime() + 5 * 60_000);
      expect(await m.link(person, account, { email: person, lang: 'es' })).toBe('conflict');
      expect(await m.authorize(ask(person))).toMatchObject({ ok: false, body: { error: 'link_conflict' } });
    });

    test('another account: conflict, nothing written, LINK_CONFLICT; that person is refused link_conflict', async () => {
      const { person, account } = await linked('taken', 100_000);
      const other = sub('newcomer');
      const m = meter();
      expect(await m.link(person, other, { email: person, lang: 'en' })).toBe('conflict');
      expect(console.error).toHaveBeenCalledWith('LINK_CONFLICT', expect.objectContaining({ person }));
      expect(await getW(`LINK#stacksplit#${person}`, 'LINK')).toMatchObject({ account });
      expect(await balance(other)).toBeUndefined();
      expect(await m.authorize(ask(person))).toEqual({ ok: false, status: 403, body: { error: 'link_conflict' }, headers: {} });
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000, heldMicroUsd: 0 });
      await expect(m.walletPass(person)).rejects.toThrow(/link_conflict/);
      // The rightful owner signing in on the same instance pays again.
      expect(await m.link(person, account, { email: person, lang: 'en' })).toBe('linked');
      expect((await m.authorize(ask(person))).ok).toBe(true);
    });

    test("billing 'none': link and walletPass reject", async () => {
      const m = meter({ billing: 'none' });
      await expect(m.link(who('none'), sub('none'), { email: 'x', lang: 'en' })).rejects.toThrow(/hosted/);
      await expect(m.walletPass(who('none'))).rejects.toThrow(/hosted/);
    });
  });

  describe('walletPass', () => {
    test('writes PASS#<random> with the account, expiring in 2 minutes, and returns the random value', async () => {
      const { m, person, account } = await linked('pass', 1_000);
      const pass = await m.walletPass(person);
      expect(pass).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await getW(`PASS#${pass}`, 'PASS')).toEqual({ PK: `PASS#${pass}`, SK: 'PASS', account, expiresAt: Math.floor(AT.getTime() / 1000) + 120 });
      expect(await m.walletPass(person)).not.toBe(pass);
    });

    test('an unlinked person: rejected, nothing written', async () => {
      await expect(meter().walletPass(who('nopass'))).rejects.toThrow(/account_not_linked/);
    });
  });

  describe('two apps charging one account at once', () => {
    test('holds and settles race on BALANCE: no double spend, no lost update', async () => {
      const account = sub('shared');
      const person = who('shared');
      // Room for 7 holds of 11,596; 16 attempts from two apps at once.
      await fund(account, 7 * HELD + 100);
      const apps = [meter({ appId: 'race-a' }), meter({ appId: 'race-b' })];
      for (const m of apps) expect(await m.link(person, account, { email: person, lang: 'en' })).toBe('linked');
      const results = await Promise.all(Array.from({ length: 16 }, async (_, i) => ({ m: apps[i % 2], r: await apps[i % 2].authorize(ask(person)) })));
      const held = results.filter((x): x is { m: FairMeter; r: Reservation } => x.r.ok);
      // A hold refused for lack of balance, or (after 3 conflicting attempts) metering_unavailable: never an overdraft.
      for (const { r } of results) if (!r.ok) expect(['balance_too_low', 'metering_unavailable']).toContain(r.body.error);
      expect(held.length).toBeGreaterThan(0);
      expect(held.length).toBeLessThanOrEqual(7);
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 7 * HELD + 100 - held.length * HELD, heldMicroUsd: held.length * HELD });

      const outcomes = await Promise.all(held.map(({ m, r }) => m.record(r, usage)));
      const settled = outcomes.filter((o) => o === 'recorded').length;
      // A settle that loses 3 conflicts waits on the retry queue (mocked away here): it stays held.
      for (const o of outcomes) expect(['recorded', 'deferred', 'failed']).toContain(o);
      const left = held.length - settled;
      expect(await balance(account)).toMatchObject({
        availableMicroUsd: 7 * HELD + 100 - settled * 880 - left * HELD,
        heldMicroUsd: left * HELD,
        spentMicroUsd: settled * 880,
      });
    });
  });

  describe('hold', () => {
    test('moves the hold plus its fee from available to held, in the transaction that reserves it', async () => {
      const { m, account } = await linked('hold', 100_000);
      const call = (await m.authorize(ask(who('hold')))) as Reservation;
      expect(call.ok).toBe(true);
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - HELD, heldMicroUsd: HELD });
    });

    test('refused balance_too_low (402, with where to top up) below hold plus fee: nothing held, no PENDING', async () => {
      const { m, person, account } = await linked('low', HELD - 1);
      expect(await m.authorize(ask(person))).toEqual({
        ok: false, status: 402, body: { error: 'balance_too_low', topUpUrl: 'https://pay.unsubscribed.dev' }, headers: {}, tier: 'normal',
      });
      expect(await balance(account)).toMatchObject({ availableMicroUsd: HELD - 1, heldMicroUsd: 0 });
      expect(console.warn).toHaveBeenCalledWith('BALANCE_TOO_LOW', expect.objectContaining({ account }));
      // Exactly enough is enough.
      await fund(account, HELD);
      expect((await m.authorize(ask(person))).ok).toBe(true);
    });

    test("the app's floor stays free of AI holds: available must cover hold, fee and the floor with its fee", async () => {
      const floor = 1_000;
      const actions = { actions: { skus: ['stacksplit-new-expense'], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: floor };
      const { m, person, account } = await linked('floor', HELD + 2 * floor - 1, actions);
      expect(await m.authorize(ask(person))).toMatchObject({ ok: false, body: { error: 'balance_too_low' } });
      await fund(account, HELD + 2 * floor);
      expect((await m.authorize(ask(person))).ok).toBe(true);
    });

    test('a missing BALANCE row: balance_too_low, BALANCE_MISSING logged', async () => {
      const m = meter();
      const person = who('nobalance');
      expect(await m.link(person, sub('nobalance'), { email: person, lang: 'en' })).toBe('linked');
      expect(await m.authorize(ask(person))).toMatchObject({ ok: false, status: 402, body: { error: 'balance_too_low' } });
      expect(console.error).toHaveBeenCalledWith('BALANCE_MISSING', expect.objectContaining({ account: sub('nobalance') }));
    });

    test('an unlinked person: account_not_linked (403), logged, nothing read or written', async () => {
      const person = who('unlinked');
      expect(await meter().authorize(ask(person))).toEqual({ ok: false, status: 403, body: { error: 'account_not_linked' }, headers: {} });
      expect(console.error).toHaveBeenCalledWith('ACCOUNT_NOT_LINKED', expect.objectContaining({ person }));
    });
  });

  describe('actions', () => {
    const ACTIONS = { actions: { skus: [SKU], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: 1_000 };

    test("action(): the line carries the person's account; an unlinked person is ACTION_UNKNOWN and no line", async () => {
      const { m, person, account } = await linked('line', 1_000, ACTIONS);
      const out: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
      m.action({ person, sku: SKU });
      m.action({ person: who('stranger'), sku: SKU });
      expect(out.map((l) => JSON.parse(l))).toEqual([{ fairMeter: 'action', appId: 'stacksplit', env: 'prod', person, sku: SKU, n: 1, account }]);
      expect(console.error).toHaveBeenCalledWith('ACTION_UNKNOWN', expect.objectContaining({ person: who('stranger') }));
    });

    test('the hosted rollup query groups by account too', () => {
      expect(actionQuery('stacksplit', Date.parse('2026-11-03T14:00:00Z'), true)).toContain('stats sum(n) as actions by person, sku, env, account');
    });

    test('rollup: charges cost plus fee to the account on the lines, in the EVENT transaction; SPEND grows; a rerun moves nothing', async () => {
      const person = who('rolled');
      const account = sub('rolled');
      await fund(account, 100_000);
      expect(await rollUp('rolla', [{ person, n: 1_000, account }])).toMatchObject({ recorded: 1 });
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - 2 * THOUSAND, spentMicroUsd: 2 * THOUSAND, heldMicroUsd: 0 });
      expect(await spend(account)).toMatchObject({ rolla: 2 * THOUSAND });
      const [event] = (await events(person)).filter((e) => e.appId === 'rolla');
      expect(event).toMatchObject({ costMicroUsd: THOUSAND, feeMicroUsd: THOUSAND, account });
      expect(event).not.toHaveProperty('absorbedMicroUsd');
      expect(console.error).not.toHaveBeenCalledWith('FLOOR_OVERRUN', expect.anything());

      // The same window again (an overlapping run): a duplicate, the wallet untouched.
      lines([{ person, n: 1_000, account }]);
      await ddb.send(new UpdateCommand({ TableName: LEDGER, Key: { PK: 'ROLLUP#rolla', SK: 'CURSOR' }, UpdateExpression: 'SET lastWindowStart = :w', ExpressionAttributeValues: { ':w': '2026-11-03T13:45:00.000Z' } }));
      expect(await rollup(ddb, cwl, { ...config, appId: 'rolla' }, ['/aws/lambda/api'], new Date('2026-11-03T14:30:00Z'))).toMatchObject({ duplicate: 1 });
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - 2 * THOUSAND });
    });

    test('rollup overrun: charged is what is available, the shortfall absorbed on the EVENT, FLOOR_OVERRUN', async () => {
      const person = who('overrun');
      const account = sub('overrun');
      await fund(account, 5_000);
      await rollUp('rollb', [{ person, n: 1_000, account }]);
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 0, spentMicroUsd: 5_000 });
      expect(await spend(account)).toMatchObject({ rollb: 5_000 });
      expect((await events(person)).find((e) => e.appId === 'rollb')).toMatchObject({ costMicroUsd: THOUSAND, feeMicroUsd: THOUSAND, absorbedMicroUsd: 2 * THOUSAND - 5_000, account });
      expect(console.error).toHaveBeenCalledWith('FLOOR_OVERRUN', expect.objectContaining({ account, chargedMicroUsd: 5_000, absorbedMicroUsd: 2 * THOUSAND - 5_000 }));
    });

    test('rollup: available moved between its read and its write (another app charged): the condition refuses, it reads again and charges what is left', async () => {
      const person = who('raced');
      const account = sub('raced');
      await fund(account, 20_000);
      const send = ddb.send.bind(ddb);
      let raced = false;
      jest.spyOn(ddb, 'send').mockImplementation((async (command: any) => {
        const out = await send(command);
        if (!raced && command instanceof GetCommand && command.input.TableName === WALLET) {
          raced = true;
          await send(new UpdateCommand({ TableName: WALLET, Key: { PK: `WALLET#${account}`, SK: 'BALANCE' }, UpdateExpression: 'ADD availableMicroUsd :x', ExpressionAttributeValues: { ':x': -10_000 } }));
        }
        return out;
      }) as any);
      await rollUp('rollc', [{ person, n: 1_000, account }]);
      expect(raced).toBe(true);
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 0, spentMicroUsd: 10_000 });
      expect((await events(person)).find((e) => e.appId === 'rollc')).toMatchObject({ absorbedMicroUsd: 2 * THOUSAND - 10_000 });
    });

    test('canWrite: available at or above the floor plus its fee; below it balance_too_low; unlinked account_not_linked', async () => {
      const { m, person, account } = await linked('write', 2_000, ACTIONS);
      expect(await m.canWrite(person)).toEqual({ ok: true });
      await fund(account, 1_999);
      expect(await m.canWrite(person)).toEqual({ ok: false, status: 402, body: { error: 'balance_too_low', topUpUrl: 'https://pay.unsubscribed.dev' }, headers: {}, tier: 'normal' });
      // A top-up gives writes back at once.
      await fund(account, 2_000);
      expect(await m.canWrite(person)).toEqual({ ok: true });
      expect(await m.canWrite(who('nowrite'))).toEqual({ ok: false, status: 403, body: { error: 'account_not_linked' }, headers: {} });
    });

    test("usage(person) adds the wallet's available; an unlinked person's has no wallet", async () => {
      const { m, person } = await linked('usage', 50_000, ACTIONS);
      await m.authorize(ask(person));
      expect(await m.usage(person)).toMatchObject({ wallet: { availableMicroUsd: 50_000 - HELD }, day: { heldMicroUsd: RESERVED } });
      expect(await m.usage(who('nousage'))).not.toHaveProperty('wallet');
    });

    test('rollup: lines without an account (written before the switch to hosted) charge no wallet', async () => {
      const person = who('before');
      await rollUp('rolld', [{ person, n: 1_000 }]);
      const event = (await events(person)).find((e) => e.appId === 'rolld');
      expect(event).toMatchObject({ costMicroUsd: THOUSAND });
      expect(event).not.toHaveProperty('account');
    });
  });

  describe('settle, release and sweep', () => {
    test('settle: held back, cost plus fee spent, the rest of the hold back to available, SPEND for this app grows; the EVENT has fee and account', async () => {
      const { m, person, account } = await linked('settle', 100_000);
      const call = (await m.authorize(ask(person))) as Reservation;
      expect(await m.record(call, usage)).toBe('recorded');
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - 880, heldMicroUsd: 0, spentMicroUsd: 880 });
      expect(await spend(account)).toMatchObject({ stacksplit: 880 });
      expect(await events(person)).toEqual([expect.objectContaining({ costMicroUsd: 440, feeMicroUsd: 440, account })]);
      expect(await events(person)).toEqual([expect.not.objectContaining({ absorbedMicroUsd: expect.anything() })]);
      // A repeat moves nothing (within 10 minutes the transaction token makes it a silent success).
      expect(['recorded', 'duplicate']).toContain(await m.record(call, usage));
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - 880, spentMicroUsd: 880 });
    });

    test('settle uses the account on the hold: a relink after authorize changes nothing for it', async () => {
      const { m, person, account } = await linked('stays', 100_000);
      const call = (await m.authorize(ask(person))) as Reservation;
      // Another instance where the person now links elsewhere (a conflict): the hold still settles to its own account.
      const other = meter();
      await other.link(person, sub('elsewhere'), { email: person, lang: 'en' });
      expect(await other.record(call, usage)).toBe('recorded');
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - 880, heldMicroUsd: 0 });
    });

    test('charged never exceeds the hold: a cost above the reservation (RESERVATION_EXCEEDED) charges hold plus fee, the rest absorbed', async () => {
      const { m, person, account } = await linked('over', 100_000);
      const call = (await m.authorize({ ...ask(person), max: { inputTokens: 1_000, outputTokens: 10 } })) as Reservation;
      const held = 2 * call.hold.reservedMicroUsd;
      expect(await m.record(call, usage)).toBe('recorded');
      expect(console.error).toHaveBeenCalledWith('RESERVATION_EXCEEDED', expect.anything());
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - held, heldMicroUsd: 0, spentMicroUsd: held });
      expect(await events(person)).toEqual([expect.objectContaining({ costMicroUsd: 440, feeMicroUsd: 440, absorbedMicroUsd: 880 - held })]);
    });

    test("release ('not_billed'): the whole hold back to available, nothing spent, no SPEND", async () => {
      const { m, person, account } = await linked('release', 100_000);
      const call = (await m.authorize(ask(person))) as Reservation;
      expect(await m.record(call, 'not_billed')).toBe('recorded');
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000, heldMicroUsd: 0, spentMicroUsd: 0 });
      expect(await spend(account)).toBeUndefined();
      expect(['recorded', 'duplicate']).toContain(await m.record(call, 'not_billed'));
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000, heldMicroUsd: 0 });
    });

    test("an aborted attempt ('unknown'): absorbed, the person pays nothing, the hold comes back", async () => {
      const { m, person, account } = await linked('aborted', 100_000);
      const call = (await m.authorize(ask(person))) as Reservation;
      expect(await m.record(call, 'unknown')).toBe('recorded');
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000, heldMicroUsd: 0, spentMicroUsd: 0 });
      expect(await events(person)).toEqual([expect.objectContaining({ costMicroUsd: RESERVED, absorbedMicroUsd: RESERVED, feeMicroUsd: 0, account })]);
    });

    test('a settle that waits on the retry queue carries its wallet move: the retry Lambda writes it exactly once', async () => {
      const { m, person, account } = await linked('queued', 100_000);
      const call = (await m.authorize(ask(person))) as Reservation;
      const body = JSON.stringify(settlementRecord(config, call, usage));
      const sqs = new SQSClient({ region: 'us-east-1' });
      const message = { messageId: 'm1', body, attributes: {} } as any;
      expect(await retryUsage(ddb, sqs, { tableName: LEDGER, dlqUrl: 'https://sqs/dlq' }, { Records: [message, { ...message, messageId: 'm2' }] })).toEqual({ batchItemFailures: [] });
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000 - 880, heldMicroUsd: 0, spentMicroUsd: 880 });
    });

    test("sweep: the hold's own account gets its hold back (swept is absorbed), nothing spent", async () => {
      const { m, person, account } = await linked('swept', 100_000);
      await m.authorize(ask(person));
      expect(await sweep(ddb, config, new Date(AT.getTime() + 31 * 60_000))).toEqual({ settled: expect.any(Number) });
      expect(await balance(account)).toMatchObject({ availableMicroUsd: 100_000, heldMicroUsd: 0, spentMicroUsd: 0 });
      expect(await events(person)).toEqual([expect.objectContaining({ estimated: 'swept', feeMicroUsd: 0, account })]);
    });
  });
});

test("the wallet's row keys are exported from the package root, their one home", () => {
  expect(root.walletKeys.balance('acc')).toEqual({ PK: 'WALLET#acc', SK: 'BALANCE' });
  expect(root.walletKeys.spend('acc', '2026-11')).toEqual({ PK: 'WALLET#acc', SK: 'SPEND#2026-11' });
  expect(root.walletKeys.link('stacksplit', 'ana@x.co')).toEqual({ PK: 'LINK#stacksplit#ana@x.co', SK: 'LINK' });
  expect(root.walletKeys.pass('r')).toEqual({ PK: 'PASS#r', SK: 'PASS' });
  const balance: root.WalletBalance = { availableMicroUsd: 0 };
  const link: root.WalletLink = { account: 'acc' };
  const pass: root.WalletPass = { account: 'acc', expiresAt: 0 };
  const spend: root.WalletSpend = { stacksplit: 0 };
  expect([balance, link, pass, spend]).toHaveLength(4);
});
