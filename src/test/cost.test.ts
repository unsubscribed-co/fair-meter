import { computeCharCost, computeCost, formatUsd, promptTokens, usdToMicroUsd, type Meters } from '../cost';

const price = {
  inputMicroUsdPerMTok: 270_000, // $0.27 / 1M
  cachedInputMicroUsdPerMTok: 70_000, // $0.07 / 1M
  outputMicroUsdPerMTok: 1_100_000, // $1.10 / 1M
};

const meters = (m: Partial<Meters>): Meters => ({
  inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, ...m,
});

describe('computeCost', () => {
  test('sums each meter at its own price', () => {
    // 200*0.27 + 800*0.07 + 50*1.10 = 54 + 56 + 55 = 165 micro-USD exactly
    expect(computeCost(meters({ inputTokens: 200, cacheReadTokens: 800, outputTokens: 50 }), price, 0)).toEqual({
      baseCostMicroUsd: 165,
      costMicroUsd: 165,
    });
  });

  test('cache writes default to the input rate, reasoning to the output rate', () => {
    // 1M cache-write at $0.27 + 1M reasoning at $1.10
    const m = meters({ cacheWriteTokens: 1_000_000, reasoningTokens: 1_000_000 });
    expect(computeCost(m, price, 0).costMicroUsd).toBe(270_000 + 1_100_000);
  });

  test('cache-write and reasoning rates apply when priced separately', () => {
    const m = meters({ cacheWriteTokens: 1_000_000, reasoningTokens: 1_000_000 });
    const priced = { ...price, cacheWriteMicroUsdPerMTok: 337_500, reasoningMicroUsdPerMTok: 2_000_000 };
    expect(computeCost(m, priced, 0).costMicroUsd).toBe(337_500 + 2_000_000);
  });

  test('rounds fractional micro-USD up', () => {
    // 1 input token = 0.27 micro-USD -> 1
    expect(computeCost(meters({ inputTokens: 1 }), price, 0).costMicroUsd).toBe(1);
  });

  test('applies markup in basis points', () => {
    const cost = computeCost(meters({ outputTokens: 1_000_000 }), price, 1_500);
    expect(cost).toEqual({ baseCostMicroUsd: 1_100_000, costMicroUsd: 1_265_000 });
  });

  test('zero tokens cost nothing', () => {
    expect(computeCost(meters({}), price, 0).costMicroUsd).toBe(0);
  });

  test('stays exact past float precision', () => {
    // 2^53 tokens would lose precision as floats; BigInt keeps it exact.
    const big = computeCost(meters({ inputTokens: 9_000_000_000 }), { ...price, inputMicroUsdPerMTok: 999_999_999 }, 0);
    expect(big.costMicroUsd).toBe(8_999_999_991_000);
  });

  test('promptTokens counts every token the model read', () => {
    expect(promptTokens(meters({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 100 }))).toBe(6);
  });
});

describe('computeCharCost', () => {
  test('charges per character', () => {
    // 235 chars at $4/1M = 940 micro-USD exactly
    expect(computeCharCost(235, 4_000_000, 0)).toEqual({ baseCostMicroUsd: 940, costMicroUsd: 940 });
  });

  test('rounds fractional micro-USD up', () => {
    // 1 char at $0.50/1M = 0.5 micro-USD -> 1
    expect(computeCharCost(1, 500_000, 0).costMicroUsd).toBe(1);
  });

  test('applies markup in basis points', () => {
    expect(computeCharCost(1_000_000, 4_000_000, 1_500)).toEqual({ baseCostMicroUsd: 4_000_000, costMicroUsd: 4_600_000 });
  });

  test('zero chars cost nothing', () => {
    expect(computeCharCost(0, 4_000_000, 0).costMicroUsd).toBe(0);
  });
});

describe('usdToMicroUsd', () => {
  test('parses decimal strings exactly', () => {
    expect(usdToMicroUsd('5')).toBe(5_000_000);
    expect(usdToMicroUsd('0.27')).toBe(270_000);
    expect(usdToMicroUsd('0.000001')).toBe(1);
    expect(usdToMicroUsd('0.1')).toBe(100_000);
  });

  test('rejects invalid amounts', () => {
    expect(() => usdToMicroUsd('-1')).toThrow();
    expect(() => usdToMicroUsd('1.0000001')).toThrow();
    expect(() => usdToMicroUsd('abc')).toThrow();
  });
});

test('formatUsd is exact and signed', () => {
  expect(formatUsd(36_431)).toBe('$0.036431');
  expect(formatUsd(5_000_000)).toBe('$5.000000');
  expect(formatUsd(-940)).toBe('-$0.000940');
  expect(formatUsd(undefined)).toBe('$0.000000');
});
