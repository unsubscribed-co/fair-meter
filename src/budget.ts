/**
 * Budget tiers: how close a caller is to a hard limit, so the app can step down gently before it
 * stops (e.g. phone voice instead of cloud TTS at `saving`, no photo questions at `essential`).
 *
 * The tier comes from the higher of two fractions: the user's spend today / their daily cap, and
 * (households with a plan) the household's spend this month / its monthly allowance. `limit` = at or
 * over 100 %; the hard-limit errors (`daily_limit_reached`, `monthly_allowance_reached`) still apply.
 * Comparisons are integer (micro-USD x percent), never floats; reported percentages are floored, so
 * 100 means the limit is reached.
 */
export const BUDGET_TIERS = ['normal', 'saving', 'essential', 'limit'] as const;
export type BudgetTier = (typeof BUDGET_TIERS)[number];
/** What a metered response's header carries: `limit` is sent as `essential` (the most careful mode). */
export type HeaderTier = Exclude<BudgetTier, 'limit'>;

export interface TierThresholds {
  /** At or above this percent of a limit: `saving`. */
  savingPct: number;
  /** At or above this percent of a limit: `essential`. */
  essentialPct: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = { savingPct: 75, essentialPct: 90 };

export function assertTierThresholds(t: TierThresholds): TierThresholds {
  const pct = (v: number) => Number.isInteger(v) && v > 0 && v < 100;
  if (!pct(t.savingPct) || !pct(t.essentialPct) || t.essentialPct <= t.savingPct) {
    throw new Error('Budget tiers need integer percents with 0 < savingPct < essentialPct < 100');
  }
  return t;
}

/** One spend against its limit, both integer micro-USD. */
export interface Usage {
  usedMicroUsd: number;
  capMicroUsd: number;
}

function tierOf({ usedMicroUsd: used, capMicroUsd: cap }: Usage, t: TierThresholds): BudgetTier {
  if (used >= cap) return 'limit';
  if (used * 100 >= t.essentialPct * cap) return 'essential';
  if (used * 100 >= t.savingPct * cap) return 'saving';
  return 'normal';
}

/** The highest tier over the given usages (undefined entries are skipped, e.g. no monthly allowance). */
export function budgetTier(usages: Array<Usage | undefined>, t: TierThresholds = DEFAULT_TIER_THRESHOLDS): BudgetTier {
  let rank = 0;
  for (const u of usages) if (u) rank = Math.max(rank, BUDGET_TIERS.indexOf(tierOf(u, t)));
  return BUDGET_TIERS[rank];
}

/** The tier of a person's day: committed against the daily cap. */
export const dayTier = (committedMicroUsd: number, capMicroUsd: number, t?: TierThresholds): BudgetTier => budgetTier([{ usedMicroUsd: committedMicroUsd, capMicroUsd }], t);

export const headerTier = (tier: BudgetTier): HeaderTier => (tier === 'limit' ? 'essential' : tier);

export const atLeast = (tier: BudgetTier, min: BudgetTier) => BUDGET_TIERS.indexOf(tier) >= BUDGET_TIERS.indexOf(min);

/** Integer percent of a limit used, floored (100 = reached). A zero cap counts as reached. */
export function usedPct({ usedMicroUsd: used, capMicroUsd: cap }: Usage): number {
  if (!(cap > 0)) return 100;
  return Math.floor((Math.max(0, used) * 100) / cap);
}

const daysInUtcMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Projected percent of the monthly allowance at the end of the UTC month, at this month's average
 * daily rate so far (today counts as a whole day, so a busy first morning doesn't explode the
 * forecast). Floored integer.
 */
export function monthForecastPct({ usedMicroUsd: used, capMicroUsd: cap }: Usage, at: Date): number {
  if (!(cap > 0)) return 100;
  return Math.floor((Math.max(0, used) * daysInUtcMonth(at) * 100) / (at.getUTCDate() * cap));
}
