import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { syncPrices } from '../prices-cli';
import { parsePriceFile } from '../prices';
import { FairMeter } from '../fair-meter';
import { actionQuery, rollup } from '../rollup-handler';

/* The action rollup against DynamoDB Local, Logs Insights mocked. Skipped unless DYNAMODB_ENDPOINT is set. */
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');
const suite = endpoint ? describe : describe.skip;

const logsMock = mockClient(CloudWatchLogsClient);
const cwl = new CloudWatchLogsClient({ region: 'us-east-1' });
const TABLE = `fair-meter-rollup-${Date.now()}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const ddb = DynamoDBDocumentClient.from(raw);
// DynamoDB Local keeps transaction tokens across tables: people unique per run.
const RUN = Date.now();
const who = (name: string) => `${name}-${RUN}@x.co`;
const GROUPS = ['/aws/lambda/api'];
const source = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json';
const priceFile = (sku: string, ...versions: [string, number][]) => parsePriceFile(sku, JSON.stringify({
  provider: 'aws',
  unit: 'units',
  versions: versions.map(([validFrom, k]) => ({ validFrom, microUsdPerKUnits: k, components: { database: k, api: 0, compute: 0, logs: 0, other: 0 }, source })),
}));
/** Each app its own cursor, so tests don't share one. */
const cfgOf = (appId: string) => ({ appId, env: 'prod', tableName: TABLE });

type Row = { person: string; sku: string; n: number; env?: string };
/** Logs Insights answers each window's query with these rows (keyed by window start). */
function logs(byWindow: Record<string, Row[]>) {
  logsMock.reset();
  logsMock.on(StartQueryCommand).callsFake((input) => ({ queryId: new Date(input.startTime * 1000).toISOString() }));
  logsMock.on(GetQueryResultsCommand).callsFake((input) => ({
    status: 'Complete',
    results: (byWindow[input.queryId] ?? []).map((r) => [
      { field: 'person', value: r.person }, { field: 'sku', value: r.sku }, { field: 'env', value: r.env ?? 'prod' }, { field: 'actions', value: String(r.n) },
    ]),
  }));
}
const queried = () => logsMock.commandCalls(StartQueryCommand).map((c) => new Date(c.args[0].input.startTime! * 1000).toISOString());

const get = async (PK: string, SK: string) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK }, ConsistentRead: true }))).Item;
const day = (appId: string, person: string, d = '2026-11-03') => get(`USER#${person}`, `DAILY#${appId}#${d}`);
const at = (iso: string) => new Date(iso);

suite('the action rollup against DynamoDB Local', () => {
  beforeAll(async () => {
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // $0.001234 per 1,000 until 14:30 on the 3rd, then $0.002.
    await syncPrices(ddb, TABLE, [priceFile('stacksplit-new-expense', ['2026-11-01T00:00:00Z', 1_234], ['2026-11-03T14:30:00Z', 2_000])], at('2026-10-30T00:00:00Z'), false);
  });
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('a window is charged once: one EVENT per person and SKU, committed rises, a rerun is a duplicate', async () => {
    const cfg = cfgOf('once');
    const ana = who('ana');
    logs({ '2026-11-03T14:00:00.000Z': [{ person: ana, sku: 'stacksplit-new-expense', n: 3 }] });
    // First run: no cursor, it starts at the current window (14:00), not yet due.
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:05:00Z'))).toEqual({ windows: 0, recorded: 0, duplicate: 0 });
    expect(queried()).toEqual([]);

    // The cursor's write fails once, after the window's records: the run fails and the window stays due.
    const send = ddb.send.bind(ddb);
    let failed = false;
    jest.spyOn(ddb, 'send').mockImplementation(async (cmd: any) => {
      if (cmd instanceof UpdateCommand && !failed) {
        failed = true;
        throw new Error('throttled');
      }
      return send(cmd);
    });
    await expect(rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:30:00Z'))).rejects.toThrow('throttled');
    expect(console.error).toHaveBeenCalledWith('ROLLUP_FAILED', expect.objectContaining({ appId: 'once' }));
    jest.mocked(ddb.send).mockRestore();

    // 3 actions at $0.001234 per 1,000 = 3.702 micro-USD, rounded up.
    const charged = { costMicroUsd: 4, committedMicroUsd: 4, actions: 3, requests: 1 };
    expect(await day('once', ana)).toMatchObject(charged);
    expect(await get(`USER#${ana}`, 'EVENT#2026-11-03T14:00:00.000Z#once#actions-stacksplit-new-expense-2026-11-03T14:00:00.000Z')).toMatchObject({
      kind: 'actions', sku: 'stacksplit-new-expense', provider: 'aws', env: 'prod', actions: 3, costMicroUsd: 4,
      pricingVersion: 'stacksplit-new-expense@2026-11-01T00:00:00Z',
    });

    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:30:00Z'))).toEqual({ windows: 1, recorded: 0, duplicate: 1 });
    expect(await day('once', ana)).toMatchObject(charged);
    expect(await get('ROLLUP#once', 'CURSOR')).toMatchObject({ lastWindowStart: '2026-11-03T14:00:00.000Z' });
    // Settled: the next run has nothing due.
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:40:00Z'))).toEqual({ windows: 0, recorded: 0, duplicate: 0 });
  });

  test('actions at 23:50 UTC land on that day, charged after midnight', async () => {
    const cfg = cfgOf('midnight');
    const bea = who('bea');
    logs({ '2026-11-03T23:45:00.000Z': [{ person: bea, sku: 'stacksplit-new-expense', n: 1_000 }] });
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T23:50:00Z'));
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-04T00:15:00Z'))).toEqual({ windows: 1, recorded: 1, duplicate: 0 });
    // 1,000 actions at $0.002 per 1,000 (the version from 14:30 on).
    expect(await day('midnight', bea)).toMatchObject({ costMicroUsd: 2_000, committedMicroUsd: 2_000 });
    expect(await day('midnight', bea, '2026-11-04')).toBeUndefined();
    expect(await get(`USER#${bea}`, 'USAGE#midnight#2026-11')).toMatchObject({ costMicroUsd: 2_000, actions: 1_000 });
  });

  test('a missed run catches up oldest first, each window at the price valid at its start, and alarms late', async () => {
    const cfg = cfgOf('catchup');
    const cy = who('cy');
    logs({
      '2026-11-03T14:15:00.000Z': [{ person: cy, sku: 'stacksplit-new-expense', n: 1_000 }],
      '2026-11-03T14:30:00.000Z': [{ person: cy, sku: 'stacksplit-new-expense', n: 1_000 }],
    });
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:05:00Z'));
    // The runs at 14:30, 14:45 and 15:00 never happened.
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T15:15:00Z'))).toEqual({ windows: 4, recorded: 2, duplicate: 0 });
    expect(queried()).toEqual(['2026-11-03T14:00:00.000Z', '2026-11-03T14:15:00.000Z', '2026-11-03T14:30:00.000Z', '2026-11-03T14:45:00.000Z']);
    expect(console.error).toHaveBeenCalledWith('ROLLUP_LATE', expect.objectContaining({ appId: 'catchup', windowStart: '2026-11-03T14:00:00.000Z', minutesLate: 30 }));
    // 1,234 + 2,000: the price changed at 14:30.
    expect(await day('catchup', cy)).toMatchObject({ costMicroUsd: 3_234, committedMicroUsd: 3_234, actions: 2_000, requests: 2 });
    // Counted in the AWS provider day too (shared by every test here, so at least this much).
    expect((await get('PROVIDER#aws', 'DAILY#2026-11-03'))?.baseCostMicroUsd).toBeGreaterThanOrEqual(3_234);
  });

  test('ROLLUP_LATE once a window is not settled within the rollup lag (45 minutes after its start), not before', async () => {
    const cfg = cfgOf('late');
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:05:00Z'));
    logs({});
    // The 14:00 window, due at 14:30, run 10 minutes late: the floor still holds.
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:40:00Z'));
    expect(console.error).not.toHaveBeenCalledWith('ROLLUP_LATE', expect.anything());
    // The 14:15 window, first run at 15:01: past its 45 minutes.
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T15:01:00Z'));
    expect(console.error).toHaveBeenCalledWith('ROLLUP_LATE', expect.objectContaining({ appId: 'late', windowStart: '2026-11-03T14:15:00.000Z', minutesLate: 1 }));
  });

  test('at most 8 windows per run; the next run goes on from there', async () => {
    const cfg = cfgOf('eight');
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T10:05:00Z'));
    logs({});
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T13:00:00Z'))).toMatchObject({ windows: 8 });
    expect(queried()).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45'].map((t) => `2026-11-03T${t}:00.000Z`));
    logs({});
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T13:15:00Z'))).toMatchObject({ windows: 4 });
    expect(queried()).toEqual(['12:00', '12:15', '12:30', '12:45'].map((t) => `2026-11-03T${t}:00.000Z`));
  });

  test('an unpriced SKU blocks its window, alarms, and resumes once the price is synced', async () => {
    const cfg = cfgOf('unpriced');
    const dee = who('dee');
    logs({ '2026-11-03T14:00:00.000Z': [{ person: dee, sku: 'stacksplit-new-expense', n: 1_000 }, { person: dee, sku: 'unpriced-edit-expense', n: 1_000 }] });
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:05:00Z'));
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:30:00Z'))).toEqual({ windows: 0, recorded: 0, duplicate: 0 });
    expect(console.error).toHaveBeenCalledWith('ACTION_UNPRICED', expect.objectContaining({ appId: 'unpriced', sku: 'unpriced-edit-expense', windowStart: '2026-11-03T14:00:00.000Z' }));
    expect(await day('unpriced', dee)).toBeUndefined();
    expect(await get('ROLLUP#unpriced', 'CURSOR')).toMatchObject({ lastWindowStart: '2026-11-03T13:45:00.000Z' });

    await syncPrices(ddb, TABLE, [priceFile('unpriced-edit-expense', ['2026-11-01T00:00:00Z', 3_000])], at('2026-11-03T14:40:00Z'), false);
    expect(await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:45:00Z'))).toEqual({ windows: 2, recorded: 2, duplicate: 0 });
    expect(await day('unpriced', dee)).toMatchObject({ costMicroUsd: 1_234 + 3_000, committedMicroUsd: 1_234 + 3_000 });
  });

  test('10,000 rows may be cut short: the window fails with ROLLUP_TRUNCATED and nothing is charged', async () => {
    const cfg = cfgOf('truncated');
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:05:00Z'));
    const fay = who('fay');
    logs({ '2026-11-03T14:00:00.000Z': Array.from({ length: 10_000 }, (_, i) => ({ person: `${i}-${fay}`, sku: 'stacksplit-new-expense', n: 1 })) });
    await expect(rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:30:00Z'))).rejects.toThrow(/10000 rows/);
    expect(console.error).toHaveBeenCalledWith('ROLLUP_TRUNCATED', expect.objectContaining({ appId: 'truncated', windowStart: '2026-11-03T14:00:00.000Z' }));
    expect(console.error).toHaveBeenCalledWith('ROLLUP_FAILED', expect.objectContaining({ appId: 'truncated' }));
    expect(await day('truncated', `0-${fay}`)).toBeUndefined();
    expect(await get('ROLLUP#truncated', 'CURSOR')).toMatchObject({ lastWindowStart: '2026-11-03T13:45:00.000Z' });
  });

  test('committed rises with the rollup and canWrite then refuses', async () => {
    const cfg = cfgOf('stacksplit');
    const eve = who('eve');
    const meter = new FairMeter(
      { ...cfg, retryQueueUrl: 'https://sqs/never-used', dailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 100_000_000, actions: { skus: ['stacksplit-new-expense'], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: 30_000 },
      { ddb, now: () => at('2026-11-03T14:45:00Z') },
    );
    expect(await meter.canWrite(eve)).toEqual({ ok: true });
    // 380,875 actions at $0.001234 per 1,000 = 470,000 micro-USD rounded up, exactly cap - floor: still allowed.
    logs({
      '2026-11-03T14:00:00.000Z': [{ person: eve, sku: 'stacksplit-new-expense', n: 380_875 }],
      '2026-11-03T14:15:00.000Z': [{ person: eve, sku: 'stacksplit-new-expense', n: 1 }],
    });
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:05:00Z'));
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:30:00Z'));
    expect(await day('stacksplit', eve)).toMatchObject({ committedMicroUsd: 470_000 });
    expect(await meter.canWrite(eve)).toEqual({ ok: true });
    // One more action (rounded up to 1 micro-USD) and the person is read-only.
    await rollup(ddb, cwl, cfg, GROUPS, at('2026-11-03T14:45:00Z'));
    expect(await meter.canWrite(eve)).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
    expect(await meter.usage(eve)).toMatchObject({ readOnly: true });
  });
});

test("the query reads the line action() writes: its filters match the line's values and it sums n by person, SKU and env", () => {
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  new FairMeter(
    { appId: 'stacksplit', env: 'prod', tableName: 't', retryQueueUrl: 'q', dailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 1_000_000, actions: { skus: ['stacksplit-new-expense'], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: 30_000 },
    { ddb, now: () => at('2026-11-03T14:05:00Z') },
  ).action({ person: 'ana@x.co', sku: 'stacksplit-new-expense', n: 2 });
  const line = JSON.parse(String(write.mock.calls[0][0]));
  write.mockRestore();

  const q = actionQuery('stacksplit', Date.parse('2026-11-03T14:00:00Z'));
  const [filter, stats] = q.split(' | ');
  const equalities = [...filter.matchAll(/(\w+) = "([^"]*)"/g)].map(([, field, value]) => [field, value]);
  expect(equalities).toEqual([['fairMeter', 'action'], ['appId', 'stacksplit']]);
  for (const [field, value] of equalities) expect(line[field]).toBe(value);
  // 14:00 and 14:15 UTC on 2026-11-03, in epoch ms.
  expect(filter).toContain('@timestamp >= 1793714400000 and @timestamp < 1793715300000');
  const [, summed, by] = /^stats sum\((\w+)\) as actions by (.+)$/.exec(stats)!;
  expect(typeof line[summed]).toBe('number');
  expect(by.split(', ')).toEqual(['person', 'sku', 'env']);
  for (const field of by.split(', ')) expect(line[field]).toEqual(expect.any(String));
});
