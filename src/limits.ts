import type { TierThresholds } from './budget';

/**
 * Spend limits, checked before every upstream call ("no surprises"). Each check reads a counter
 * that earlier calls' usage transactions maintain, so the last call before a limit may overshoot
 * it slightly; that is accepted by design.
 *
 * Periods are UTC days and UTC months (the counter keys). Statements for Colombian families use
 * America/Bogota months (statement.ts); enforcement stays on UTC, which only moves the monthly
 * reset 5 hours earlier (19:00 Bogota on the last day of the month).
 *
 * Billing modes, per household and app:
 * - Legacy prepaid (no PLAN#<app> item): needs household credit; each call is deducted from
 *   creditBalanceMicroUsd on HOUSEHOLD META.
 * - Plan (`test`, `dev`, later `family`): an active subscription plus a monthly allowance for that
 *   app. The credit balance stays in the data model but is neither required nor deducted. Future
 *   subscription plans use allowance + status, not top-ups.
 *
 * Both apply with `billing: 'hosted'` (the default). With `billing: 'none'` (self-hosting: nobody is
 * charged) they are skipped: no credit, subscription status or monthly allowance. The protection
 * limits stay: circuit breakers, the per-user daily cap (plan override included), the per-minute brake.
 */
export const BILLING_MODES = ['hosted', 'none'] as const;
export type Billing = (typeof BILLING_MODES)[number];

export function parseBilling(value: unknown): Billing {
  if (!BILLING_MODES.includes(value as Billing)) throw new Error(`billing must be one of ${BILLING_MODES.join(', ')}`);
  return value as Billing;
}

export const PLANS = ['test', 'dev', 'family'] as const;
export const SUBSCRIPTION_STATUSES = ['active', 'paused', 'cancelled'] as const;

/** HOUSEHOLD#<id> PLAN#<app>. */
export interface AppPlan {
  plan: string;
  subscriptionStatus: string;
  /** Undefined only when misconfigured; enforcement then fails closed. */
  monthlyAllowanceMicroUsd?: number;
  /** Per-user daily cap override for this app; the app's default applies when absent. */
  dailyCapMicroUsd?: number;
}

export interface Spend {
  /** This user, this app, today. */
  userDayMicroUsd: number;
  /** This household, this app, this month. */
  householdMonthMicroUsd: number;
  /** Everyone, this app, today. */
  appDayMicroUsd: number;
  /** Everyone, every app, today. */
  allAppsDayMicroUsd: number;
}

export interface LimitConfig {
  /** Undefined = 'hosted' (charging). 'none': no credit, subscription or allowance checks; markup 0, no credit deducted. */
  billing?: Billing;
  /**
   * Per-minute brake against loops: at most this many metered calls per user and UTC minute (any
   * kind), else 429 too_many_requests. Undefined = no brake. Needs the table's TTL on `expiresAt`.
   */
  maxCallsPerMinute?: number;
  /** Budget tier thresholds (budget.ts); default 75 % saving, 90 % essential. */
  tiers?: TierThresholds;
  /** Per-user daily cap unless the household's plan overrides it. */
  defaultDailyCapMicroUsd: number;
  /** Per-app circuit breaker across all users. */
  appDailyCapMicroUsd: number;
  /** Optional ceiling across every app sharing the table. */
  allAppsDailyCapMicroUsd?: number;
}

export type LimitCode =
  | 'service_paused'
  | 'subscription_inactive'
  | 'insufficient_credit'
  | 'monthly_allowance_reached'
  | 'daily_limit_reached';

export type LimitDecision =
  | { ok: true }
  | { ok: false; status: number; error: LimitCode; reason: string };

const deny = (status: number, error: LimitCode, reason: string): LimitDecision => ({ ok: false, status, error, reason });

const optionalAmount = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));

export function planFromItem(item: Record<string, any> | undefined): AppPlan | undefined {
  if (!item || typeof item.plan !== 'string') return undefined;
  return {
    plan: item.plan,
    subscriptionStatus: typeof item.subscriptionStatus === 'string' ? item.subscriptionStatus : 'active',
    monthlyAllowanceMicroUsd: optionalAmount(item.monthlyAllowanceMicroUsd),
    dailyCapMicroUsd: optionalAmount(item.dailyCapMicroUsd),
  };
}

export const dailyCapFor = (plan: AppPlan | undefined, cfg: LimitConfig) => plan?.dailyCapMicroUsd ?? cfg.defaultDailyCapMicroUsd;

/**
 * Most global first, most lasting next, so the message the user hears is the one that will still
 * be true tomorrow: breakers, subscription, credit/allowance, then the daily cap.
 */
export function checkLimits(
  plan: AppPlan | undefined,
  creditBalanceMicroUsd: number,
  spend: Spend,
  cfg: LimitConfig,
): LimitDecision {
  if (cfg.allAppsDailyCapMicroUsd !== undefined && spend.allAppsDayMicroUsd >= cfg.allAppsDailyCapMicroUsd) {
    return deny(503, 'service_paused', 'all_apps_daily_cap');
  }
  if (spend.appDayMicroUsd >= cfg.appDailyCapMicroUsd) return deny(503, 'service_paused', 'app_daily_cap');

  if (cfg.billing === 'none') {
    // Self-hosted: nothing to charge, so only the protection limits around this block apply.
  } else if (!plan) {
    if (!(creditBalanceMicroUsd > 0)) return deny(402, 'insufficient_credit', 'no_credit');
  } else {
    if (plan.subscriptionStatus !== 'active') return deny(402, 'subscription_inactive', plan.subscriptionStatus);
    if (plan.monthlyAllowanceMicroUsd === undefined) return deny(402, 'monthly_allowance_reached', 'plan_without_allowance');
    if (spend.householdMonthMicroUsd >= plan.monthlyAllowanceMicroUsd) {
      return deny(402, 'monthly_allowance_reached', 'monthly_allowance');
    }
  }

  if (spend.userDayMicroUsd >= dailyCapFor(plan, cfg)) return deny(429, 'daily_limit_reached', 'user_daily_cap');
  return { ok: true };
}
