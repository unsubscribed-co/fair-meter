import { checkLimits, dailyCapFor, parseBilling, planFromItem, type AppPlan, type LimitConfig, type Spend } from '../limits';

const cfg: LimitConfig = { defaultDailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 3_000_000, allAppsDailyCapMicroUsd: 5_000_000 };
const none: Spend = { userDayMicroUsd: 0, householdMonthMicroUsd: 0, appDayMicroUsd: 0, allAppsDayMicroUsd: 0 };
const test_: AppPlan = { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000 };

const decide = (plan: AppPlan | undefined, spend: Partial<Spend> = {}, credit = 0, config = cfg) =>
  checkLimits(plan, credit, { ...none, ...spend }, config);

describe('plan households', () => {
  test('within every limit', () => {
    expect(decide(test_)).toEqual({ ok: true });
  });

  test('credit is not required', () => {
    expect(decide(test_, {}, 0)).toEqual({ ok: true });
    expect(decide(test_, {}, -5)).toEqual({ ok: true });
  });

  test('monthly allowance reached -> 402 monthly_allowance_reached (small overshoot accepted)', () => {
    expect(decide(test_, { householdMonthMicroUsd: 4_999_999 })).toEqual({ ok: true });
    expect(decide(test_, { householdMonthMicroUsd: 5_000_000 })).toMatchObject({ ok: false, status: 402, error: 'monthly_allowance_reached' });
  });

  test('a plan without an allowance fails closed', () => {
    expect(decide({ plan: 'test', subscriptionStatus: 'active' })).toMatchObject({
      ok: false, error: 'monthly_allowance_reached', reason: 'plan_without_allowance',
    });
  });

  test('inactive subscription -> 402 subscription_inactive', () => {
    expect(decide({ ...test_, subscriptionStatus: 'paused' })).toMatchObject({ ok: false, status: 402, error: 'subscription_inactive' });
  });

  test('per-user daily cap: config default, or the plan override', () => {
    expect(decide(test_, { userDayMicroUsd: 500_000 })).toMatchObject({ ok: false, status: 429, error: 'daily_limit_reached' });
    const generous = { ...test_, dailyCapMicroUsd: 1_000_000 };
    expect(decide(generous, { userDayMicroUsd: 500_000 })).toEqual({ ok: true });
    expect(decide(generous, { userDayMicroUsd: 1_000_000 })).toMatchObject({ error: 'daily_limit_reached' });
    expect(dailyCapFor(generous, cfg)).toBe(1_000_000);
    expect(dailyCapFor(undefined, cfg)).toBe(500_000);
  });

  test('monthly is reported before daily (the longer-lasting reason)', () => {
    expect(decide(test_, { householdMonthMicroUsd: 9_000_000, userDayMicroUsd: 9_000_000 })).toMatchObject({ error: 'monthly_allowance_reached' });
  });
});

describe('legacy prepaid households (no plan)', () => {
  test('need credit', () => {
    expect(decide(undefined, {}, 1)).toEqual({ ok: true });
    expect(decide(undefined, {}, 0)).toMatchObject({ ok: false, status: 402, error: 'insufficient_credit' });
  });

  test('have no monthly allowance but keep the daily cap', () => {
    expect(decide(undefined, { householdMonthMicroUsd: 99_000_000 }, 1)).toEqual({ ok: true });
    expect(decide(undefined, { userDayMicroUsd: 500_000 }, 1)).toMatchObject({ error: 'daily_limit_reached' });
  });
});

describe('circuit breakers', () => {
  test('per-app breaker -> 503 service_paused, ahead of everything else', () => {
    expect(decide(test_, { appDayMicroUsd: 2_999_999 })).toEqual({ ok: true });
    expect(decide(test_, { appDayMicroUsd: 3_000_000, householdMonthMicroUsd: 9e9 })).toEqual({
      ok: false, status: 503, error: 'service_paused', reason: 'app_daily_cap',
    });
  });

  test('all-apps ceiling, when configured', () => {
    expect(decide(test_, { allAppsDayMicroUsd: 5_000_000 })).toMatchObject({ error: 'service_paused', reason: 'all_apps_daily_cap' });
    const noCeiling = { defaultDailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 3_000_000 };
    expect(decide(test_, { allAppsDayMicroUsd: 9e12 }, 0, noCeiling)).toEqual({ ok: true });
  });
});

test('planFromItem', () => {
  expect(planFromItem(undefined)).toBeUndefined();
  expect(planFromItem({ SK: 'PLAN#nieto' })).toBeUndefined();
  expect(planFromItem({ plan: 'dev', monthlyAllowanceMicroUsd: 1_000_000 })).toEqual({
    plan: 'dev', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 1_000_000, dailyCapMicroUsd: undefined,
  });
});

describe("billing: 'none' (self-hosted)", () => {
  const selfHosted: LimitConfig = { ...cfg, billing: 'none' };

  test('hosted (explicit or default) charges: credit, subscription and allowance refuse', () => {
    for (const config of [cfg, { ...cfg, billing: 'hosted' as const }]) {
      expect(decide(undefined, {}, 0, config)).toMatchObject({ error: 'insufficient_credit' });
      expect(decide({ ...test_, subscriptionStatus: 'cancelled' }, {}, 0, config)).toMatchObject({ error: 'subscription_inactive' });
      expect(decide(test_, { householdMonthMicroUsd: 5_000_000 }, 0, config)).toMatchObject({ error: 'monthly_allowance_reached' });
    }
  });

  test('none: no credit, subscription or allowance needed', () => {
    expect(decide(undefined, {}, 0, selfHosted)).toEqual({ ok: true });
    expect(decide({ ...test_, subscriptionStatus: 'cancelled' }, {}, 0, selfHosted)).toEqual({ ok: true });
    expect(decide(test_, { householdMonthMicroUsd: 99_000_000 }, 0, selfHosted)).toEqual({ ok: true });
    expect(decide({ plan: 'test', subscriptionStatus: 'active' }, {}, 0, selfHosted)).toEqual({ ok: true });
  });

  test('none: the protection limits still refuse (breakers, daily cap and its plan override)', () => {
    expect(decide(undefined, { appDayMicroUsd: 3_000_000 }, 0, selfHosted)).toMatchObject({ status: 503, error: 'service_paused' });
    expect(decide(undefined, { allAppsDayMicroUsd: 5_000_000 }, 0, selfHosted)).toMatchObject({ status: 503, error: 'service_paused' });
    expect(decide(undefined, { userDayMicroUsd: 500_000 }, 0, selfHosted)).toMatchObject({ status: 429, error: 'daily_limit_reached' });
    expect(decide({ ...test_, dailyCapMicroUsd: 1_000_000 }, { userDayMicroUsd: 600_000 }, 0, selfHosted)).toEqual({ ok: true });
  });

  test('parseBilling accepts only the two modes', () => {
    expect(parseBilling('hosted')).toBe('hosted');
    expect(parseBilling('none')).toBe('none');
    expect(() => parseBilling('free')).toThrow(/hosted, none/);
    expect(() => parseBilling(undefined)).toThrow();
  });
});
