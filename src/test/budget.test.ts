import { assertTierThresholds, atLeast, budgetTier, headerTier, monthForecastPct, usedPct } from '../budget';

const of = (usedMicroUsd: number, capMicroUsd = 1_000_000) => ({ usedMicroUsd, capMicroUsd });

describe('budget tiers', () => {
  test('thresholds are inclusive: 75 % saving, 90 % essential, 100 % limit', () => {
    expect(budgetTier([of(749_999)])).toBe('normal');
    expect(budgetTier([of(750_000)])).toBe('saving');
    expect(budgetTier([of(899_999)])).toBe('saving');
    expect(budgetTier([of(900_000)])).toBe('essential');
    expect(budgetTier([of(999_999)])).toBe('essential');
    expect(budgetTier([of(1_000_000)])).toBe('limit');
    expect(budgetTier([of(1_200_000)])).toBe('limit');
  });

  test('the higher of day and month wins; a missing month is skipped', () => {
    expect(budgetTier([of(100_000), of(950_000)])).toBe('essential');
    expect(budgetTier([of(800_000), undefined])).toBe('saving');
    expect(budgetTier([])).toBe('normal');
  });

  test('a zero cap is already at the limit', () => {
    expect(budgetTier([of(0, 0)])).toBe('limit');
    expect(usedPct(of(0, 0))).toBe(100);
  });

  test('configurable thresholds', () => {
    const t = { savingPct: 50, essentialPct: 80 };
    expect(budgetTier([of(500_000)], t)).toBe('saving');
    expect(budgetTier([of(800_000)], t)).toBe('essential');
    expect(() => assertTierThresholds({ savingPct: 90, essentialPct: 75 })).toThrow(/savingPct < essentialPct/);
    expect(() => assertTierThresholds({ savingPct: 75, essentialPct: 100 })).toThrow();
    expect(() => assertTierThresholds({ savingPct: 74.5, essentialPct: 90 })).toThrow();
  });

  test('header carries three values: limit is sent as essential', () => {
    expect(headerTier('normal')).toBe('normal');
    expect(headerTier('limit')).toBe('essential');
    expect(atLeast('essential', 'saving')).toBe(true);
    expect(atLeast('saving', 'essential')).toBe(false);
    expect(atLeast('limit', 'essential')).toBe(true);
  });

  test('percentages are floored integers', () => {
    expect(usedPct(of(999_999))).toBe(99);
    expect(usedPct(of(1_500_000))).toBe(150);
    expect(usedPct(of(-5))).toBe(0);
  });

  test('month forecast: this month\'s average per day (today counted whole) times the days in the month', () => {
    // 30-day November, day 15: 1.5 M of 3 M -> 100 % by month end.
    expect(monthForecastPct(of(1_500_000, 3_000_000), new Date('2026-11-15T01:00:00Z'))).toBe(100);
    // 28-day February, day 1: 0.1 M -> 2.8 M of 3 M = 93 %.
    expect(monthForecastPct(of(100_000, 3_000_000), new Date('2027-02-01T23:00:00Z'))).toBe(93);
    expect(monthForecastPct(of(0, 3_000_000), new Date('2026-10-31T00:00:00Z'))).toBe(0);
  });
});
