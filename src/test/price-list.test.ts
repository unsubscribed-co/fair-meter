import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { extractRates, formatPriceList, OFFER_SERVICES, parseAppFile, parsePriceFile, priceList, writePriceList, type PriceFile } from '../prices-cli';

/** Trimmed from AWS's public us-east-1 offer files: the products the list needs, plus look-alikes it must skip. */
const offers = () => Object.fromEntries(OFFER_SERVICES.map((s) => [s, JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'price-list', `${s}.json`), 'utf8'))]));

describe('rates from the public Price List', () => {
  test('the first-tier on-demand list rates, USD per unit as AWS writes them', () => {
    expect(extractRates(offers())).toEqual({
      readRequestUnit: '0.0000001250',
      writeRequestUnit: '0.0000006250',
      armRequest: '0.0000002000',
      armGbSecond: '0.0000133334',
      httpApiRequest: '0.0000010000',
      logIngestedGb: '0.5000000000',
      logScannedGb: '0.0050000000',
    });
  });

  test('a rate it can not find stops the run, naming it', () => {
    const o = offers();
    for (const [sku, p] of Object.entries<any>(o.AWSLambda.products)) if (p.attributes.usagetype === 'Lambda-GB-Second-ARM') delete o.AWSLambda.products[sku];
    expect(() => extractRates(o)).toThrow(/armGbSecond: not in the AWSLambda Price List/);
  });
});

const NOW = new Date('2026-11-02T12:00:00Z');
const RATES = {
  readRequestUnit: '0.0000001250', writeRequestUnit: '0.0000006250', armRequest: '0.0000002000', armGbSecond: '0.0000133334',
  httpApiRequest: '0.0000010000', logIngestedGb: '0.5000000000', logScannedGb: '0.0050000000',
};
const haiku: PriceFile = {
  sku: 'claude-haiku-5-5', provider: 'anthropic', unit: 'tokens',
  versions: [{ validFrom: '2026-10-28T00:00:00Z', inputMicroUsdPerMTok: 100_000, cachedInputMicroUsdPerMTok: 10_000, outputMicroUsdPerMTok: 500_000, source: 'https://example.com/p' }],
};
const measured = { rru: 2, wru: 3, apiRequests: 1, lambdaRequests: 1, billedMs: 40, memoryMb: 1024, logBytes: 2048, samples: 50, measuredAt: '2026-11-01T00:00:00Z' };
const profile = (actions: number, calls: number) => ({
  actions: { 'demo-add': actions },
  ai: { 'claude-haiku-5-5': { callsPerDay: calls, meters: { inputTokens: 2_000, outputTokens: 400 } } },
});
const app = {
  region: 'us-east-1',
  actions: { 'demo-add': measured },
  profiles: { light: profile(10, 1), regular: profile(50, 5), heavy: profile(200, 20) },
};

describe('prices/apps/<app>.json: the measurement and the profiles, parsed strictly', () => {
  test('a well-formed file parses', () => {
    expect(parseAppFile('demo', JSON.stringify(app))).toEqual(app);
  });

  const withAction = (patch: object) => ({ ...app, actions: { 'demo-add': { ...measured, ...patch } } });
  test.each([
    ['an unknown top-level field', { ...app, currency: 'USD' }],
    ['a region that is not one', { ...app, region: 'Virginia' }],
    ['no actions', { ...app, actions: {} }],
    ['a missing measurement', { ...app, actions: { 'demo-add': { ...measured, logBytes: undefined } } }],
    ['an unknown measurement (a typo)', withAction({ rcu: 1 })],
    ['a negative average', withAction({ wru: -1 })],
    ['no samples', withAction({ samples: 0 })],
    ['a non-canonical measuredAt', withAction({ measuredAt: '2026-11-01' })],
    ['a missing profile', { ...app, profiles: { light: app.profiles.light, regular: app.profiles.regular } }],
    ['a profile using an action that was not measured', { ...app, profiles: { ...app.profiles, heavy: { actions: { 'demo-other': 1 }, ai: {} } } }],
    ['actions a day that are not a whole number', { ...app, profiles: { ...app.profiles, light: profile(0.5, 1) } }],
    ['an unknown meter', { ...app, profiles: { ...app.profiles, light: { actions: {}, ai: { 'claude-haiku-5-5': { callsPerDay: 1, meters: { tokens: 1 } } } } } }],
  ])('refused, naming the file: %s', (_, bad) => {
    expect(() => parseAppFile('demo', JSON.stringify(bad))).toThrow(/^prices\/apps\/demo\.json: /);
  });
});

describe('an action priced by component, per 1,000 actions, each rounded up', () => {
  test('hand-checked at the us-east-1 rates', () => {
    // database 1000 x (2.5 x 0.125 + 3 x 0.625) = 2187.5 -> 2188 (rru 2 plus the write check's half unit)
    // api 1000 x 1 = 1000; compute 1000 x (0.2 + 0.040 s x 1 GB x 13.3334) = 733.336 -> 734
    // logs 1000 x 2048 B / 2^30 x (0.5 + 0.005) USD = 963.2 -> 964 micro-USD
    const list = priceList('demo', parseAppFile('demo', JSON.stringify(app)), RATES, [haiku], NOW, 10_000);
    expect(list.actions).toEqual([{
      sku: 'demo-add',
      components: { database: 2188, api: 1000, compute: 734, logs: 964, other: 0 },
      costMicroUsdPerK: 4886, feeMicroUsdPerK: 4886, priceMicroUsdPerK: 9772,
    }]);
  });
});

describe('the profiles: a month, the price with the fee, and how long $2 lasts', () => {
  test('hand-checked: actions at the list cost, AI calls at the current version through priceCall, 30-day months', () => {
    // demo-add costs 4,886 per 1,000; one haiku call (2,000 in, 400 out) costs 200 + 200 = 400.
    // light: 10 actions = 48.86 -> 49, plus 400 = 449 a day; with the 100% fee 898; $2 / 898 = 2,227 days.
    const { profiles } = priceList('demo', parseAppFile('demo', JSON.stringify(app)), RATES, [haiku], NOW, 10_000);
    expect(profiles.light).toEqual({
      ai: [{ sku: 'claude-haiku-5-5', callsPerDay: 1, costMicroUsdPerCall: 400 }],
      dailyCostMicroUsd: 449, monthlyCostMicroUsd: 13_470, monthlyPriceMicroUsd: 26_940, daysFor2Usd: 2_227,
    });
    // regular: 244.3 -> 245 plus 2,000 = 2,245 a day, 4,490 with the fee: 445 days.
    expect(profiles.regular).toMatchObject({ dailyCostMicroUsd: 2_245, monthlyPriceMicroUsd: 134_700, daysFor2Usd: 445 });
    // heavy: 977.2 -> 978 plus 8,000 = 8,978 a day, 17,956 with the fee: 111 days.
    expect(profiles.heavy).toMatchObject({ dailyCostMicroUsd: 8_978, monthlyPriceMicroUsd: 538_680, daysFor2Usd: 111 });
  });

  test('the fee comes from prices/fee.json by default', () => {
    expect(priceList('demo', parseAppFile('demo', JSON.stringify(app)), RATES, [haiku], NOW).feeBps).toBe(10_000);
  });

  test('an AI SKU without a price version now stops the run, naming it', () => {
    expect(() => priceList('demo', parseAppFile('demo', JSON.stringify(app)), RATES, [], NOW, 10_000)).toThrow(/profiles\.light\.ai\.claude-haiku-5-5: no price version/);
  });
});

describe('list --write --valid-from: a new price version, never an edit', () => {
  const list = () => priceList('demo', parseAppFile('demo', JSON.stringify(app)), RATES, [haiku], NOW, 10_000);
  const dir = () => mkdtempSync(path.join(tmpdir(), 'price-list-'));
  const read = (d: string, sku: string) => parsePriceFile(sku, readFileSync(path.join(d, `${sku}.json`), 'utf8'));
  const version = (validFrom: string, microUsdPerKUnits: number, components: object) => ({ validFrom, microUsdPerKUnits, components, source: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json' });
  const FROM = '2026-11-03T00:00:00Z';

  test('a new SKU gets its file; the published list is written with the version it starts', () => {
    const d = dir();
    const lines = writePriceList(d, list(), FROM, NOW);
    expect(read(d, 'demo-add')).toEqual({
      sku: 'demo-add', provider: 'aws', unit: 'units',
      versions: [version(FROM, 4_886, { database: 2_188, api: 1_000, compute: 734, logs: 964, other: 0 })],
    });
    const published = JSON.parse(readFileSync(path.join(d, 'apps', 'demo.list.json'), 'utf8'));
    expect(published).toMatchObject({ app: 'demo', validFrom: FROM, feeBps: 10_000, actions: [{ sku: 'demo-add', priceMicroUsdPerK: 9_772 }] });
    expect(lines).toContain('demo-add@2026-11-03T00:00:00Z added');
  });

  test('rates equal to the latest version add nothing', () => {
    const d = dir();
    writePriceList(d, list(), FROM, NOW);
    const lines = writePriceList(d, list(), '2026-12-01T00:00:00Z', NOW);
    expect(read(d, 'demo-add').versions).toHaveLength(1);
    expect(lines).toContain('demo-add unchanged');
  });

  test('other rates append a version after the latest; the old one is left exactly as it was', () => {
    const d = dir();
    const old = version('2026-11-01T00:00:00Z', 4_000, { database: 2_000, api: 1_000, compute: 500, logs: 500, other: 0 });
    writeFileSync(path.join(d, 'demo-add.json'), JSON.stringify({ provider: 'aws', unit: 'units', versions: [old] }));
    writePriceList(d, list(), FROM, NOW);
    expect(read(d, 'demo-add').versions).toEqual([old, version(FROM, 4_886, { database: 2_188, api: 1_000, compute: 734, logs: 964, other: 0 })]);
  });

  test.each([
    ['in the past', '2026-11-01T00:00:00Z'],
    ['less than 10 minutes ahead', '2026-11-02T12:09:59Z'],
  ])('refused, nothing written: a validFrom %s', (_, from) => {
    const d = dir();
    expect(() => writePriceList(d, list(), from, NOW)).toThrow(/at least 10 minutes ahead/);
    expect(existsSync(path.join(d, 'demo-add.json'))).toBe(false);
    expect(existsSync(path.join(d, 'apps'))).toBe(false);
  });

  test('refused, nothing written: a validFrom not after the latest version', () => {
    const d = dir();
    writePriceList(d, list(), '2026-12-01T00:00:00Z', NOW);
    const cheaper = { ...list(), actions: [{ ...list().actions[0], costMicroUsdPerK: 1, components: { database: 1, api: 0, compute: 0, logs: 0, other: 0 } }] };
    expect(() => writePriceList(d, cheaper, FROM, NOW)).toThrow(/in order/);
    expect(read(d, 'demo-add').versions).toHaveLength(1);
  });
});

test('the printed list: each line, then each profile', () => {
  const text = formatPriceList(priceList('demo', parseAppFile('demo', JSON.stringify(app)), RATES, [haiku], NOW, 10_000));
  expect(text).toContain('demo-add  per 1,000: database $0.002188 api $0.001000 compute $0.000734 logs $0.000964 other $0.000000  cost $0.004886  fee $0.004886  price $0.009772');
  expect(text).toContain('light  cost $0.013470/month  price $0.026940/month  $2 lasts 2227 days');
  expect(text).toContain('  claude-haiku-5-5  1/day at $0.000400 a call');
});
