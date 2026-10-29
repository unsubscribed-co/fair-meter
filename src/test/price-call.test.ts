import { computeCost, computeRequestCost, computeUnitCost, type Meters } from '../cost';
import { priceCall, priceShape, reserveCost } from '../pricing';
import { repriceEvent } from '../reprice';

const haiku = {
  PK: 'PRICING#claude-haiku-5-5', SK: '2026-10-28T00:00:00Z', provider: 'anthropic',
  inputMicroUsdPerMTok: 100_000, cacheWriteMicroUsdPerMTok: 125_000, cachedInputMicroUsdPerMTok: 10_000, outputMicroUsdPerMTok: 500_000,
};
// Bands, context tiers, a reasoning rate, and a cache write dearer than input: every way the rate can move.
const busy = {
  ...haiku,
  reasoningMicroUsdPerMTok: 900_000,
  tiers: [{ aboveInputTokens: 100_000, inputMicroUsdPerMTok: 500_000, cachedInputMicroUsdPerMTok: 50_000, outputMicroUsdPerMTok: 2_500_000, cacheWriteMicroUsdPerMTok: 625_000 }],
  bands: [{ name: 'peak', days: [1, 2, 3, 4, 5], hours: [{ startHour: 1, endHour: 4 }, { startHour: 6, endHour: 10 }],
    inputMicroUsdPerMTok: 300_000, cachedInputMicroUsdPerMTok: 6_000, outputMicroUsdPerMTok: 1_200_000,
    tiers: [{ aboveInputTokens: 50_000, inputMicroUsdPerMTok: 200_000, cachedInputMicroUsdPerMTok: 900_000, outputMicroUsdPerMTok: 100_000 }] }],
};
const OFF = new Date('2026-11-03T14:05:09.120Z'); // Tuesday 14:05 UTC
const PEAK = new Date('2026-11-03T02:00:00.000Z');

describe('priceShape', () => {
  test('from the field the version carries; malformed is undefined', () => {
    expect(priceShape(haiku)).toBe('tokens');
    expect(priceShape({ microUsdPerMChars: 30_000_000 })).toBe('chars');
    expect(priceShape({ microUsdPerKUnits: 14_000_000 })).toBe('units');
    expect(priceShape({ microUsdPerRequest: 32_000 })).toBe('requests');
    expect(priceShape({ microUsdPerRequest: 1.5 })).toBeUndefined();
    expect(priceShape({ inputMicroUsdPerMTok: 1 })).toBeUndefined();
  });
});

describe('reserveCost (T13)', () => {
  test("the design's walkthrough: 30,000 bytes in, 4,096 out on Haiku = 5,798 µUSD", () => {
    expect(reserveCost(haiku, { inputTokens: 30_000, outputTokens: 4_096 }, OFF)).toBe(5_798);
  });

  test("a context tier counts only when max could reach it (prompt tokens can't exceed maxIn)", () => {
    const tiered = { ...haiku, tiers: busy.tiers };
    expect(reserveCost(tiered, { inputTokens: 30_000, outputTokens: 4_096 }, OFF)).toBe(5_798);
    expect(reserveCost(tiered, { inputTokens: 100_000, outputTokens: 0 }, OFF)).toBe(12_500);
    expect(reserveCost(tiered, { inputTokens: 100_001, outputTokens: 0 }, OFF)).toBe(62_501);
  });

  test('a max that does not match the price shape is undefined', () => {
    expect(reserveCost(haiku, { chars: 10 }, OFF)).toBeUndefined();
    expect(reserveCost(haiku, { inputTokens: -1, outputTokens: 1 }, OFF)).toBeUndefined();
    expect(reserveCost({ microUsdPerMChars: 30_000_000 }, { inputTokens: 1, outputTokens: 1 }, OFF)).toBeUndefined();
  });

  test('chars, units and requests reserve exactly what that usage would cost', () => {
    expect(reserveCost({ microUsdPerMChars: 30_000_000 }, { chars: 1234 }, OFF)).toBe(37_020);
    expect(reserveCost({ microUsdPerKUnits: 14_000_000 }, { units: 3 }, OFF)).toBe(computeUnitCost(3, 14_000_000, 0).costMicroUsd);
    expect(reserveCost({ microUsdPerRequest: 32_000 }, { requests: 2 }, OFF)).toBe(64_000);
  });

  test('property: the hold is >= the cost of any usage within max (bands, tiers, cache writes, reasoning)', () => {
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed % (n + 1); };
    for (const at of [OFF, PEAK]) {
      for (let i = 0; i < 2_000; i++) {
        const maxIn = rand(300_000);
        const maxOut = rand(8_192);
        const reserved = reserveCost(busy, { inputTokens: maxIn, outputTokens: maxOut }, at)!;
        const cacheRead = rand(maxIn);
        const cacheWrite = rand(maxIn - cacheRead);
        const reasoning = rand(maxOut);
        const m: Meters = { inputTokens: rand(maxIn - cacheRead - cacheWrite), cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: rand(maxOut - reasoning), reasoningTokens: reasoning };
        const actual = priceCall(busy, { meters: m }, at);
        if ('error' in actual) throw new Error(actual.error);
        expect(actual.costMicroUsd).toBeLessThanOrEqual(reserved);
      }
    }
  });
});

describe('priceCall (T14)', () => {
  test('tokens: the band and tier at the call, as computeCost', () => {
    const m: Meters = { inputTokens: 1_000, cacheReadTokens: 4_000, cacheWriteTokens: 2_000, outputTokens: 100, reasoningTokens: 0 };
    expect(priceCall(haiku, { meters: m }, OFF)).toEqual({ baseCostMicroUsd: 440, costMicroUsd: 440 });
    expect(priceCall(busy, { meters: { ...m, inputTokens: 200_000 } }, OFF)).toMatchObject({ band: 'default', tier: '>100000' });
    expect(priceCall(busy, { meters: m }, PEAK, 1_000)).toEqual({ ...computeCost(m, { inputMicroUsdPerMTok: 300_000, cachedInputMicroUsdPerMTok: 6_000, outputMicroUsdPerMTok: 1_200_000 }, 1_000), band: 'peak' });
  });

  test('per request and per unit match computeRequestCost / computeUnitCost', () => {
    expect(priceCall({ microUsdPerRequest: 32_000 }, { requests: 1 }, OFF, 1_000)).toEqual(computeRequestCost(1, 32_000, 1_000));
    expect(priceCall({ microUsdPerKUnits: 14_000_000 }, { units: 7 }, OFF, 2_500)).toEqual(computeUnitCost(7, 14_000_000, 2_500));
  });

  test('never guesses: malformed price or missing usage is an error', () => {
    expect(priceCall({ microUsdPerRequest: -1 }, { requests: 1 }, OFF)).toEqual({ error: 'malformed price version' });
    expect(priceCall({ microUsdPerKUnits: 1 }, {}, OFF)).toEqual({ error: 'missing meters (units)' });
    expect(priceCall({ microUsdPerMChars: 1 }, {}, OFF)).toEqual({ error: 'missing meters (chars)' });
    expect(priceCall({ microUsdPerRequest: 1 }, {}, OFF)).toEqual({ error: 'missing meters (requests)' });
    expect(priceCall(haiku, {}, OFF)).toEqual({ error: 'missing meters (tokens)' });
    expect(priceCall({ inputMicroUsdPerMTok: 1 }, {}, OFF)).toEqual({ error: 'malformed price version' });
  });
});

describe('repriceEvent goes through priceCall (M8)', () => {
  const event = (extra: Record<string, unknown>) => ({ PK: 'USER#u1', SK: 'EVENT#2026-10-15T12:00:00.000Z#nieto#r1', markupBps: 1_000, costMicroUsd: 1, pricingVersion: 'x@2026-10-01', ...extra });
  test('per-request and per-unit events', () => {
    const places = { 'gcp-places': [{ PK: 'PRICING#gcp-places', SK: '2026-10-01T00:00:00Z', microUsdPerRequest: 32_000 }] };
    expect(repriceEvent(event({ sku: 'gcp-places' }), places)).toMatchObject({ status: 'changed', newCostMicroUsd: computeRequestCost(1, 32_000, 1_000).costMicroUsd });
    const search = { 'gemini-search': [{ PK: 'PRICING#gemini-search', SK: '2026-10-01T00:00:00Z', microUsdPerKUnits: 14_000_000 }] };
    expect(repriceEvent(event({ sku: 'gemini-search', units: 3 }), search)).toMatchObject({ status: 'changed', newCostMicroUsd: computeUnitCost(3, 14_000_000, 1_000).costMicroUsd });
    expect(repriceEvent(event({ sku: 'gemini-search' }), search)).toEqual({ status: 'unrepriceable', sku: 'gemini-search', reason: 'missing meters (units)' });
  });

  test('an estimated event (settled at its hold, or trued up later) is never re-priced from its meters', () => {
    expect(repriceEvent(event({ sku: 'claude-haiku-5-5', estimated: 'swept', inputTokens: 30_000, outputTokens: 4_096, cacheReadTokens: 0 }), { 'claude-haiku-5-5': [haiku] }))
      .toEqual({ status: 'unrepriceable', sku: 'claude-haiku-5-5', reason: 'estimated usage' });
  });
});
