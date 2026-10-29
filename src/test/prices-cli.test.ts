import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { setTableKeys } from '../keys';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { feeAt, formatPriceHistory, loadPriceFiles, parseFeeFile, parsePriceFile, syncPrices, type PriceFile } from '../prices-cli';
import { priceShape } from '../pricing';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));
const NOW = new Date('2026-10-28T12:00:00Z');

const haiku: PriceFile = {
  sku: 'claude-haiku-5-5',
  provider: 'anthropic',
  unit: 'tokens',
  versions: [
    { validFrom: '2026-10-28T00:00:00Z', inputMicroUsdPerMTok: 100_000, cachedInputMicroUsdPerMTok: 10_000, outputMicroUsdPerMTok: 500_000, source: 'https://example.com/p' },
    { validFrom: '2026-12-01T00:00:00Z', inputMicroUsdPerMTok: 90_000, cachedInputMicroUsdPerMTok: 9_000, outputMicroUsdPerMTok: 450_000, source: 'https://example.com/p' },
  ],
};
const stored = (v: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ pk: 'PRICING#claude-haiku-5-5', sk: v.validFrom, provider: 'anthropic', ...v, ...extra });

beforeAll(() => setTableKeys({ pk: 'pk', sk: 'sk' }));
afterAll(() => setTableKeys(undefined));
beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('the price files in prices/', () => {
  test('every file parses: one SKU each, rates in the unit it names, a source for every version', () => {
    const files = loadPriceFiles();
    expect(files.map((f) => f.sku).sort()).toEqual(['claude-haiku-5-5', 'deepseek-v4-flash']);
    for (const f of files) for (const v of f.versions) expect(priceShape({ provider: f.provider, ...v })).toBe(f.unit);
  });

  test.each([
    ['an unknown unit', { unit: 'minutes' }],
    ['rates that are not the unit', { unit: 'chars' }],
    ['a token SKU without a usage adapter', { provider: 'acme' }],
    ['versions out of order', { versions: [...haiku.versions].reverse() }],
    ['a version without a source', { versions: [{ ...haiku.versions[0], source: undefined }] }],
    ['an unknown field (a typo)', { versions: [{ ...haiku.versions[0], outputMicroUsdPerMtok: 1 }] }],
    ['a non-canonical validFrom', { versions: [{ ...haiku.versions[0], validFrom: '2026-10-28' }] }],
    ['a float rate', { versions: [{ ...haiku.versions[0], inputMicroUsdPerMTok: 0.5 }] }],
  ])('refused: %s', (_, bad) => {
    const { sku, ...body } = { ...haiku, ...bad };
    expect(() => parsePriceFile(sku, JSON.stringify(body))).toThrow();
  });
});

describe('action SKUs: per 1,000 actions, with their components', () => {
  const action = {
    provider: 'aws',
    unit: 'units',
    versions: [{
      validFrom: '2026-11-01T00:00:00Z',
      microUsdPerKUnits: 1_000,
      components: { database: 400, api: 300, compute: 200, logs: 100, other: 0 },
      source: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json',
    }],
  };
  const withComponents = (components: unknown) => JSON.stringify({ ...action, versions: [{ ...action.versions[0], components }] });

  test('a components file parses as a units SKU', () => {
    const f = parsePriceFile('stacksplit-add-expense', JSON.stringify(action));
    expect(f).toEqual({ sku: 'stacksplit-add-expense', ...action });
    expect(priceShape({ provider: f.provider, ...f.versions[0] })).toBe('units');
  });

  test.each([
    ['a sum that is not the price', { database: 400, api: 300, compute: 200, logs: 100, other: 1 }],
    ['a missing component', { database: 500, api: 300, compute: 200 }],
    ['an unknown component', { database: 400, api: 300, compute: 200, logs: 100, storage: 0 }],
    ['a float component', { database: 399.5, api: 300.5, compute: 200, logs: 100, other: 0 }],
    ['a negative component', { database: 500, api: 300, compute: 200, logs: 100, other: -100 }],
    ['not an object', [400, 300, 200, 100, 0]],
  ])('refused, naming the file and version: %s', (_, components) => {
    expect(() => parsePriceFile('stacksplit-add-expense', withComponents(components)))
      .toThrow(/^prices\/stacksplit-add-expense\.json: version 2026-11-01T00:00:00Z: components/);
  });

  test('components only on a units SKU', () => {
    const { sku, ...body } = haiku;
    const bad = { ...body, versions: [{ ...body.versions[0], components: action.versions[0].components }] };
    expect(() => parsePriceFile(sku, JSON.stringify(bad))).toThrow(/unknown fields components/);
  });

  test('price-history shows the components', () => {
    const text = formatPriceHistory('stacksplit-add-expense', [{ pk: 'PRICING#stacksplit-add-expense', sk: '2026-11-01T00:00:00Z', provider: 'aws', ...action.versions[0] }]);
    expect(text).toBe('stacksplit-add-expense@2026-11-01T00:00:00Z  [2026-11-01T00:00:00Z .. open)  $0.001000/1,000 units' +
      ' (database $0.000400 api $0.000300 compute $0.000200 logs $0.000100 other $0.000000)  aws');
  });
});

describe('the fee: prices/fee.json', () => {
  const fee = (versions: unknown) => JSON.stringify({ versions });

  test('one version: 100% of cost, from the day it was decided', () => {
    expect(feeAt(new Date('2026-10-29T00:00:00Z'))).toEqual({ validFrom: '2026-10-29T00:00:00Z', feeBps: 10_000 });
    expect(feeAt(new Date('2030-01-01T00:00:00Z')).feeBps).toBe(10_000);
    expect(() => feeAt(new Date('2026-10-28T23:59:59Z'))).toThrow(/no fee version at 2026-10-28T23:59:59Z/);
  });

  test('feeAt picks the version valid at a time', () => {
    const file = parseFeeFile(fee([{ validFrom: '2026-10-29T00:00:00Z', feeBps: 10_000 }, { validFrom: '2027-01-01T00:00:00Z', feeBps: 5_000 }]));
    expect(feeAt(new Date('2026-12-31T23:59:59Z'), file).feeBps).toBe(10_000);
    expect(feeAt(new Date('2027-01-01T00:00:00Z'), file).feeBps).toBe(5_000);
  });

  test.each([
    ['no versions', []],
    ['versions out of order', [{ validFrom: '2027-01-01T00:00:00Z', feeBps: 0 }, { validFrom: '2026-10-29T00:00:00Z', feeBps: 0 }]],
    ['a non-canonical validFrom', [{ validFrom: '2026-10-29', feeBps: 10_000 }]],
    ['a float fee', [{ validFrom: '2026-10-29T00:00:00Z', feeBps: 9_999.5 }]],
    ['a fee above 100%', [{ validFrom: '2026-10-29T00:00:00Z', feeBps: 10_001 }]],
    ['a negative fee', [{ validFrom: '2026-10-29T00:00:00Z', feeBps: -1 }]],
    ['an unknown field (a typo)', [{ validFrom: '2026-10-29T00:00:00Z', feeBps: 10_000, feeBP: 1 }]],
  ])('refused: %s', (_, versions) => {
    expect(() => parseFeeFile(fee(versions))).toThrow(/^prices\/fee\.json: /);
  });

  test('loadPriceFiles reads only SKU files: not fee.json, not prices/apps/', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prices-'));
    const { sku, ...body } = haiku;
    writeFileSync(path.join(dir, `${sku}.json`), JSON.stringify(body));
    writeFileSync(path.join(dir, 'fee.json'), fee([{ validFrom: '2026-10-29T00:00:00Z', feeBps: 10_000 }]));
    mkdirSync(path.join(dir, 'apps'));
    writeFileSync(path.join(dir, 'apps', 'stacksplit.json'), '{}');
    expect(loadPriceFiles(dir).map((f) => f.sku)).toEqual([sku]);
  });
});

describe('sync', () => {
  test('puts every absent version, closing the previous one in the same transaction', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const lines = await syncPrices(ddb(), 't', [haiku], NOW, false);
    const [first, second] = ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!);
    expect(first).toEqual([{ Put: { TableName: 't', Item: { pk: 'PRICING#claude-haiku-5-5', sk: '2026-10-28T00:00:00Z', provider: 'anthropic', ...haiku.versions[0] }, ConditionExpression: 'attribute_not_exists(pk)' } }]);
    expect(second[0].Put!.Item).toMatchObject({ sk: '2026-12-01T00:00:00Z', validFrom: '2026-12-01T00:00:00Z' });
    expect(second[1].Update).toEqual({
      TableName: 't', Key: { pk: 'PRICING#claude-haiku-5-5', sk: '2026-10-28T00:00:00Z' },
      UpdateExpression: 'SET validTo = :to', ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(validTo)',
      ExpressionAttributeValues: { ':to': '2026-12-01T00:00:00Z' },
    });
    expect(lines.join('\n')).toContain('claude-haiku-5-5@2026-12-01T00:00:00Z added');
  });

  test('versions already stored with the same values are left alone (validTo may differ)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [stored(haiku.versions[0], { validTo: '2026-12-01T00:00:00Z' }), stored(haiku.versions[1])] });
    await syncPrices(ddb(), 't', [haiku], NOW, false);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  test('a stored version with other values is refused loudly; nothing is written, for any SKU', async () => {
    ddbMock.on(QueryCommand).callsFake((input) => ({
      Items: input.ExpressionAttributeValues[':pk'] === 'PRICING#claude-haiku-5-5' ? [stored({ ...haiku.versions[0], outputMicroUsdPerMTok: 1 })] : [],
    }));
    const other = { ...haiku, sku: 'other' };
    await expect(syncPrices(ddb(), 't', [other, haiku], NOW, false)).rejects.toThrow(/immutable.*claude-haiku-5-5@2026-10-28T00:00:00Z: stored/s);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  test('a new version may not backdate one already used (calls were metered at it)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [stored(haiku.versions[1])] });
    await expect(syncPrices(ddb(), 't', [haiku], NOW, false)).rejects.toThrow(/after the latest/);
  });

  test('--dry-run writes nothing and says what it would do', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const lines = await syncPrices(ddb(), 't', [haiku], NOW, true);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/would add.*Dry run/s);
  });
});

test('price-history lists each version and its range', () => {
  const text = formatPriceHistory('claude-haiku-5-5', [stored(haiku.versions[0], { validTo: '2026-12-01T00:00:00Z' }), stored(haiku.versions[1])]);
  expect(text).toContain('claude-haiku-5-5@2026-10-28T00:00:00Z  [2026-10-28T00:00:00Z .. 2026-12-01T00:00:00Z)  in $0.100000 cached $0.010000 out $0.500000 /1M');
  expect(text).toContain('[2026-12-01T00:00:00Z .. open)');
});
