import {
  parsePriceSetArgs,
  parseTierSpec,
  parseValidFrom,
  planNewVersion,
  planPriceMigration,
  pricingTime,
  scheduleFromItem,
  selectPrice,
  skuFor,
  validFromOf,
  versionCovers,
  versionRanges,
  type PricingSchedule,
} from '../pricing';

const offPeak = { inputMicroUsdPerMTok: 150_000, cachedInputMicroUsdPerMTok: 3_000, outputMicroUsdPerMTok: 600_000 };
const peak = { inputMicroUsdPerMTok: 300_000, cachedInputMicroUsdPerMTok: 6_000, outputMicroUsdPerMTok: 1_200_000 };
const peakBand = {
  name: 'peak',
  days: [1, 2, 3, 4, 5],
  hours: [{ startHour: 1, endHour: 4 }, { startHour: 6, endHour: 10 }],
  ...peak,
};
const at = (iso: string) => new Date(iso);
const WEDNESDAY_PEAK = at('2026-09-30T02:00:00Z');
const SATURDAY = at('2026-10-03T02:00:00Z');

describe('context tiers', () => {
  const tiered: PricingSchedule = {
    default: {
      ...offPeak,
      tiers: [{ aboveInputTokens: 200_000, ...peak }, { aboveInputTokens: 500_000, ...peak, outputMicroUsdPerMTok: 9 }],
    },
    bands: [],
  };

  test('at or below the threshold the base rates apply', () => {
    expect(selectPrice(tiered, WEDNESDAY_PEAK, 200_000)).toEqual({ price: offPeak });
  });

  test('above a threshold the whole call uses the tier; the highest matching tier wins', () => {
    expect(selectPrice(tiered, WEDNESDAY_PEAK, 200_001)).toEqual({ price: peak, tier: '>200000' });
    expect(selectPrice(tiered, WEDNESDAY_PEAK, 600_000)).toEqual({ price: { ...peak, outputMicroUsdPerMTok: 9 }, tier: '>500000' });
  });

  test('tiers combine with bands: band first, then that card\'s tiers', () => {
    const schedule: PricingSchedule = {
      default: { ...offPeak, tiers: [{ aboveInputTokens: 1000, ...peak }] },
      bands: [{ ...peakBand, tiers: [{ aboveInputTokens: 1000, ...offPeak, outputMicroUsdPerMTok: 7 }] }],
    };
    expect(selectPrice(schedule, WEDNESDAY_PEAK, 5000)).toEqual({
      price: { ...offPeak, outputMicroUsdPerMTok: 7 }, band: 'peak', tier: '>1000',
    });
    expect(selectPrice(schedule, SATURDAY, 5000)).toEqual({ price: peak, band: 'default', tier: '>1000' });
    expect(selectPrice(schedule, SATURDAY, 10)).toEqual({ price: offPeak, band: 'default' });
  });

  test('optional cache-write and reasoning rates survive selection', () => {
    const card = { ...offPeak, cacheWriteMicroUsdPerMTok: 11, reasoningMicroUsdPerMTok: 12 };
    expect(selectPrice({ default: card, bands: [] }, WEDNESDAY_PEAK).price).toEqual(card);
  });

  test('scheduleFromItem reads tiers and rejects bad ones', () => {
    const item = { SK: '2026-10-01', ...offPeak, tiers: [{ aboveInputTokens: 200000, ...peak }] };
    expect(scheduleFromItem(item)).toEqual({ default: { ...offPeak, tiers: [{ aboveInputTokens: 200_000, ...peak }] }, bands: [] });
    expect(scheduleFromItem({ ...item, tiers: [] })).toBeUndefined();
    expect(scheduleFromItem({ ...item, tiers: [{ aboveInputTokens: 0, ...peak }] })).toBeUndefined();
    expect(scheduleFromItem({ ...item, tiers: [{ aboveInputTokens: 10, ...peak, inputMicroUsdPerMTok: -1 }] })).toBeUndefined();
    expect(scheduleFromItem({ ...item, tiers: [{ aboveInputTokens: 10, ...peak }, { aboveInputTokens: 10, ...peak }] })).toBeUndefined();
    expect(scheduleFromItem({ ...item, reasoningMicroUsdPerMTok: 1.5 })).toBeUndefined();
  });

  test('parseTierSpec', () => {
    expect(parseTierSpec('200000:0.3:0.006:1.2')).toEqual({ tier: { aboveInputTokens: 200_000, ...peak } });
    expect(parseTierSpec('200000:0.3:0.006:1.2:0.4@peak')).toEqual({
      band: 'peak', tier: { aboveInputTokens: 200_000, ...peak, cacheWriteMicroUsdPerMTok: 400_000 },
    });
    expect(() => parseTierSpec('0:1:1:1')).toThrow();
    expect(() => parseTierSpec('big:1:1:1')).toThrow();
    expect(() => parseTierSpec('10:1:1')).toThrow();
  });

  test('price-set flags: cache-write, reasoning, tiers per card, backdate', () => {
    const parsed = parsePriceSetArgs([
      'gemini-pro', '2026-11-01', '1.25', '0.31', '10', '--cache-write', '1.5', '--reasoning=10',
      '--band', 'peak:mon-fri:01-04:2:0.5:12', '--tier', '200000:2.5:0.62:15', '--tier', '200000:3:1:20@peak', '--backdate',
    ]);
    expect(parsed.positional).toEqual(['gemini-pro', '2026-11-01', '1.25', '0.31', '10']);
    expect(parsed.cacheWriteMicroUsdPerMTok).toBe(1_500_000);
    expect(parsed.reasoningMicroUsdPerMTok).toBe(10_000_000);
    expect(parsed.tiers).toEqual([
      { aboveInputTokens: 200_000, inputMicroUsdPerMTok: 2_500_000, cachedInputMicroUsdPerMTok: 620_000, outputMicroUsdPerMTok: 15_000_000 },
    ]);
    expect(parsed.bands[0].tiers![0].outputMicroUsdPerMTok).toBe(20_000_000);
    expect(parsed.backdate).toBe(true);
    expect(() => parsePriceSetArgs(['--tier', '10:1:1:1@nope'])).toThrow(/unknown band/);
    expect(() => parsePriceSetArgs(['--tier', '10:1:1:1', '--tier', '10:2:2:2'])).toThrow(/unique/);
    expect(() => parsePriceSetArgs(['--bogus', '1'])).toThrow(/Unknown flag/);
  });
});

describe('billing SKUs', () => {
  const aliases = { 'deepseek-flash': 'deepseek-v4-flash', 'deepseek-chat': 'deepseek-v4-flash' };
  test('aliases map provider names onto one SKU; unlisted names are their own SKU', () => {
    expect(skuFor('deepseek-flash', aliases)).toBe('deepseek-v4-flash');
    expect(skuFor('deepseek-chat', aliases)).toBe('deepseek-v4-flash');
    expect(skuFor('deepseek-v4-flash', aliases)).toBe('deepseek-v4-flash');
    expect(skuFor('other', aliases)).toBe('other');
    expect(skuFor('toString', aliases)).toBe('toString'); // no prototype leaks
  });
});

describe('price version ranges', () => {
  test('parseValidFrom canonicalizes UTC starts', () => {
    expect(parseValidFrom('2026-10-05')).toBe('2026-10-05T00:00:00Z');
    expect(parseValidFrom('2026-10-05T16:30Z')).toBe('2026-10-05T16:30:00Z');
    expect(parseValidFrom('2026-10-05T16:30:15Z')).toBe('2026-10-05T16:30:15Z');
    for (const bad of ['2026-13-01', '2026-02-30', '2026-10-05T16:30', '2026-10-05 16:30Z', 'tomorrow']) {
      expect(() => parseValidFrom(bad)).toThrow();
    }
  });

  test('legacy bare-date sort keys mean 00:00 UTC and sort before same-day timestamps', () => {
    expect(validFromOf({ SK: '2026-09-29' })).toBe('2026-09-29T00:00:00Z');
    expect(validFromOf({ SK: '2026-10-05T16:00:00Z', validFrom: '2026-10-05T16:00:00Z' })).toBe('2026-10-05T16:00:00Z');
    expect('2026-10-01' < '2026-10-01T00:00:00Z').toBe(true);
    expect(pricingTime(at('2026-10-01T16:00:00.999Z'))).toBe('2026-10-01T16:00:00Z');
  });

  test('versionCovers checks [validFrom, validTo)', () => {
    const v = { SK: '2026-09-29', validTo: '2026-10-01T00:00:00Z' };
    expect(versionCovers(v, at('2026-09-29T00:00:00Z'))).toBe(true);
    expect(versionCovers(v, at('2026-09-30T23:59:59.999Z'))).toBe(true);
    expect(versionCovers(v, at('2026-10-01T00:00:00Z'))).toBe(false);
    expect(versionCovers(v, at('2026-09-28T23:59:59Z'))).toBe(false);
    expect(versionCovers({ SK: '2026-10-01' }, at('2030-01-01T00:00:00Z'))).toBe(true);
  });

  test('versionRanges derives ranges for legacy items and keeps stored ones', () => {
    expect(
      versionRanges([
        { SK: '2026-10-01' },
        { SK: '2026-09-29' },
        { SK: '2026-11-01T16:00:00Z', validFrom: '2026-11-01T16:00:00Z' },
      ]),
    ).toEqual([
      { sk: '2026-09-29', validFrom: '2026-09-29T00:00:00Z', validTo: '2026-10-01T00:00:00Z', derived: true },
      { sk: '2026-10-01', validFrom: '2026-10-01T00:00:00Z', validTo: '2026-11-01T16:00:00Z', derived: true },
      { sk: '2026-11-01T16:00:00Z', validFrom: '2026-11-01T16:00:00Z', validTo: undefined, derived: false },
    ]);
  });

  test('planNewVersion closes the latest version at the new start', () => {
    const now = at('2026-10-01T12:00:00Z');
    expect(planNewVersion(undefined, '2026-09-01T00:00:00Z', now)).toEqual({});
    expect(planNewVersion({ SK: '2026-10-01' }, '2026-11-01T00:00:00Z', now)).toEqual({
      closePrevious: { sk: '2026-10-01', validFrom: '2026-10-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z' },
    });
  });

  test('planNewVersion refuses overlaps, closed versions and silent backdating', () => {
    const now = at('2026-10-01T12:00:00Z');
    expect(() => planNewVersion({ SK: '2026-10-01' }, '2026-10-01T00:00:00Z', now)).toThrow(/after the latest/);
    expect(() => planNewVersion({ SK: '2026-10-01' }, '2026-09-30T00:00:00Z', now)).toThrow(/after the latest/);
    expect(() => planNewVersion({ SK: '2026-10-01', validTo: '2026-10-02T00:00:00Z' }, '2026-11-01T00:00:00Z', now)).toThrow(/closed/);
    expect(() => planNewVersion({ SK: '2026-10-01' }, '2026-10-01T06:00:00Z', now)).toThrow(/--backdate/);
    expect(planNewVersion({ SK: '2026-10-01' }, '2026-10-01T06:00:00Z', now, true).closePrevious?.validTo).toBe('2026-10-01T06:00:00Z');
  });

  test('planPriceMigration stores derived ranges and is idempotent', () => {
    const items = [
      { PK: 'PRICING#deepseek-v4-flash', SK: '2026-09-29' },
      { PK: 'PRICING#deepseek-v4-flash', SK: '2026-10-01' },
      { PK: 'PRICING#gcp-tts-wavenet', SK: '2026-09-29' },
    ];
    const steps = planPriceMigration(items);
    expect(steps).toEqual([
      { pk: 'PRICING#deepseek-v4-flash', sk: '2026-09-29', validFrom: '2026-09-29T00:00:00Z', validTo: '2026-10-01T00:00:00Z' },
      { pk: 'PRICING#deepseek-v4-flash', sk: '2026-10-01', validFrom: '2026-10-01T00:00:00Z' },
      { pk: 'PRICING#gcp-tts-wavenet', sk: '2026-09-29', validFrom: '2026-09-29T00:00:00Z' },
    ]);
    const migrated = items.map((i) => {
      const s = steps.find((x) => x.pk === i.PK && x.sk === i.SK)!;
      return { ...i, validFrom: s.validFrom, ...(s.validTo ? { validTo: s.validTo } : {}) };
    });
    expect(planPriceMigration(migrated)).toEqual([]);
  });
});
