import { CreateTableCommand, DynamoDBClient, PutItemCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { migrate } from '../migrate-cli';

/* An app table's ledger rows copied into a ledger table, against DynamoDB Local. Skipped unless DYNAMODB_ENDPOINT is set. */
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');
const suite = endpoint ? describe : describe.skip;

const run = Date.now();
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

async function createTable(name: string, pk: string, sk: string) {
  await raw.send(new CreateTableCommand({
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: pk, AttributeType: 'S' }, { AttributeName: sk, AttributeType: 'S' }],
    KeySchema: [{ AttributeName: pk, KeyType: 'HASH' }, { AttributeName: sk, KeyType: 'RANGE' }],
  }));
}
const put = (table: string, item: Record<string, unknown>) => raw.send(new PutItemCommand({ TableName: table, Item: marshall(item) }));
async function scan(table: string): Promise<Record<string, any>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await raw.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.map((i) => unmarshall(i)).sort((a, b) => (`${a.PK ?? a.pk}|${a.SK ?? a.sk}` < `${b.PK ?? b.pk}|${b.SK ?? b.sk}` ? -1 : 1));
}
const row = (items: Record<string, any>[], pk: string, sk: string) => items.find((i) => i.PK === pk && i.SK === sk);

const DAY = '2026-10-29';
const EVENT_SK = `EVENT#${DAY}T10:00:00.000Z#stacksplit#r1`;
// A StackSplit-style app table: lowercase keys, ledger rows next to the app's own rows.
const SOURCE_ROWS = [
  { pk: 'USER#ana', sk: `DAILY#stacksplit#${DAY}`, requests: 2, costMicroUsd: 300, committedMicroUsd: 500, appId: 'stacksplit' },
  { pk: 'USER#ana', sk: 'USAGE#stacksplit#2026-10', requests: 2, costMicroUsd: 300 },
  { pk: 'USER#ana', sk: EVENT_SK, costMicroUsd: 123_456_789, env: 'dev', appId: 'stacksplit', usage: { units: 3 } },
  { pk: 'USER#ana', sk: `ADJUST#${DAY}T10:00:00.000Z#stacksplit#a1`, deltaMicroUsd: -5, env: 'dev' },
  { pk: 'USER#ana', sk: `RATE#stacksplit#${DAY}T10:00`, calls: 1, expiresAt: 1_800_000_000 },
  { pk: 'USER#ana', sk: `EVENT#${DAY}T11:00:00.000Z#nieto#r2`, costMicroUsd: 9 },
  { pk: 'USER#ana', sk: `DAILY#nieto#${DAY}`, costMicroUsd: 9 },
  { pk: 'USER#ana', sk: 'PROFILE', name: 'Ana' },
  { pk: 'APP#stacksplit', sk: `DAILY#${DAY}`, requests: 2, costMicroUsd: 300 },
  { pk: 'APP#nieto', sk: `DAILY#${DAY}`, costMicroUsd: 9 },
  { pk: 'GLOBAL', sk: `DAILY#${DAY}`, requests: 3, costMicroUsd: 309 },
  { pk: 'PENDING#stacksplit', sk: 'CALL#c1', reservedMicroUsd: 200, sub: 'ana' },
  { pk: 'PRICING#stacksplit-add-expense', sk: '2026-11-01T00:00:00Z', microUsdPerKUnits: 1_234, provider: 'aws' },
  { pk: 'PROVIDER#aws', sk: `DAILY#${DAY}`, requests: 2, baseCostMicroUsd: 250 },
  { pk: 'PROVIDER#aws', sk: `BALANCE#${DAY}T00:00:00.000Z`, balanceMicroUsd: 1_000 },
  { pk: 'GROUP#g1', sk: 'EXPENSE#e1', amount: '200000', currency: 'COP' },
];

suite('migrate against DynamoDB Local', () => {
  const FROM = `fair-meter-app-${run}`;
  const TO = `fair-meter-ledger-${run}`;
  const args = { from: FROM, fromKeys: { pk: 'pk', sk: 'sk' }, to: TO, app: 'stacksplit' };

  beforeAll(async () => {
    await createTable(FROM, 'pk', 'sk');
    await createTable(TO, 'PK', 'SK');
    for (const r of SOURCE_ROWS) await put(FROM, r);
    // The live app already started today's DAILY row in the ledger table, and prices were synced.
    await put(TO, { PK: 'USER#ana', SK: `DAILY#stacksplit#${DAY}`, requests: 1, costMicroUsd: 40, committedMicroUsd: 60, appId: 'stacksplit' });
    await put(TO, { PK: 'PRICING#stacksplit-add-expense', SK: '2026-11-01T00:00:00Z', microUsdPerKUnits: 1_234, provider: 'aws' });
  });
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('a dry run counts each family and writes nothing', async () => {
    const before = await scan(TO);
    const { lines, refused } = await migrate(raw, args);
    expect(refused).toEqual([]);
    expect(lines).toEqual([
      'DAILY 1, USAGE 1, EVENT 1, ADJUST 1, APP 1, GLOBAL 1, PENDING 1, PRICING 1, PROVIDER 2 (10 rows; 6 others skipped)',
      'Dry run. Re-run with --apply to write.',
    ]);
    expect(await scan(TO)).toEqual(before);
  });

  test('--apply copies the families as PK/SK, adds the source counters to the live row, and only reads the source', async () => {
    const source = await scan(FROM);
    const { refused } = await migrate(raw, { ...args, apply: true });
    expect(refused).toEqual([]);
    expect(await scan(FROM)).toEqual(source);

    const to = await scan(TO);
    // Live app 1 request / 40 / 60 plus the source's 2 / 300 / 500.
    expect(row(to, 'USER#ana', `DAILY#stacksplit#${DAY}`)).toEqual({ PK: 'USER#ana', SK: `DAILY#stacksplit#${DAY}`, requests: 3, costMicroUsd: 340, committedMicroUsd: 560, appId: 'stacksplit' });
    expect(row(to, 'USER#ana', EVENT_SK)).toEqual({ PK: 'USER#ana', SK: EVENT_SK, costMicroUsd: 123_456_789, env: 'dev', appId: 'stacksplit', usage: { units: 3 } });
    expect(row(to, 'PENDING#stacksplit', 'CALL#c1')).toEqual({ PK: 'PENDING#stacksplit', SK: 'CALL#c1', reservedMicroUsd: 200, sub: 'ana' });
    expect(row(to, 'GLOBAL', `DAILY#${DAY}`)).toEqual({ PK: 'GLOBAL', SK: `DAILY#${DAY}`, requests: 3, costMicroUsd: 309 });
    expect(to.filter((i) => !i.PK.startsWith('MIGRATION#')).map((i) => `${i.PK} ${i.SK}`)).toEqual([
      `APP#stacksplit DAILY#${DAY}`,
      `GLOBAL DAILY#${DAY}`,
      'PENDING#stacksplit CALL#c1',
      'PRICING#stacksplit-add-expense 2026-11-01T00:00:00Z',
      `PROVIDER#aws BALANCE#${DAY}T00:00:00.000Z`,
      `PROVIDER#aws DAILY#${DAY}`,
      `USER#ana ADJUST#${DAY}T10:00:00.000Z#stacksplit#a1`,
      `USER#ana DAILY#stacksplit#${DAY}`,
      `USER#ana ${EVENT_SK}`,
      'USER#ana USAGE#stacksplit#2026-10',
    ]);
  });

  test('a second --apply copies nothing and adds nothing', async () => {
    const before = await scan(TO);
    const { lines, refused } = await migrate(raw, { ...args, apply: true });
    expect(refused).toEqual([]);
    expect(lines.at(-1)).toBe('0 copied, 10 already copied, 0 refused.');
    expect(await scan(TO)).toEqual(before);
  });

  test('an EVENT already in the ledger table with other values is refused and reported, never overwritten', async () => {
    const sk = `EVENT#${DAY}T12:00:00.000Z#stacksplit#r3`;
    await put(FROM, { pk: 'USER#ana', sk, costMicroUsd: 10 });
    await put(TO, { PK: 'USER#ana', SK: sk, costMicroUsd: 11 });
    const { lines, refused } = await migrate(raw, { ...args, apply: true });
    expect(refused).toEqual([`USER#ana ${sk}: costMicroUsd is {"N":"11"} in the ledger table, {"N":"10"} in the source`]);
    expect(lines).toContain(`Refused USER#ana ${sk}: costMicroUsd is {"N":"11"} in the ledger table, {"N":"10"} in the source`);
    expect(lines.at(-1)).toBe('0 copied, 10 already copied, 1 refused.');
    expect(row(await scan(TO), 'USER#ana', sk)).toEqual({ PK: 'USER#ana', SK: sk, costMicroUsd: 11 });
  });

  test('a source user prefix other than USER# becomes USER# in the ledger table', async () => {
    const from = `fair-meter-app-prefix-${run}`;
    const to = `fair-meter-ledger-prefix-${run}`;
    await createTable(from, 'pk', 'sk');
    await createTable(to, 'PK', 'SK');
    await put(from, { pk: 'u#ana', sk: `DAILY#stacksplit#${DAY}`, costMicroUsd: 7 });
    await put(from, { pk: 'USER#bob', sk: `DAILY#stacksplit#${DAY}`, costMicroUsd: 8 });
    await migrate(raw, { from, fromKeys: { pk: 'pk', sk: 'sk' }, fromUserPrefix: 'u#', to, app: 'stacksplit', apply: true });
    expect((await scan(to)).filter((i) => !i.PK.startsWith('MIGRATION#'))).toEqual([{ PK: 'USER#ana', SK: `DAILY#stacksplit#${DAY}`, costMicroUsd: 7 }]);
  });
});
