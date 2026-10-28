import { adjustmentId, checkReason, type Adjustment } from './adjust';
import { computeCharCost, computeCost, computeRequestCost, computeUnitCost, formatUsd, promptTokens, type Meters } from './cost';
import { ADJUST_PREFIX, EVENT_PREFIX, ledgerTime, pkOf, skOf, subOf } from './keys';
import type { Billing } from './limits';
import { pricingTime, scheduleFromItem, selectPrice, versionRanges } from './pricing';
import { checkAppId, parseFlags } from './report';

/*
 * Re-pricing: recompute an event's cost from its stored raw meters with the price version that
 * was valid at the event's time, and turn the difference into an adjustment. Pure; the admin CLI
 * does the reads and writes. The math is cost.ts/pricing.ts, the same code that priced the call.
 */

/** PRICING#<sku> items per SKU, as stored (any order). */
export type PriceHistory = Record<string, Record<string, any>[]>;

export type RepriceResult =
  | {
      status: 'changed';
      sku: string;
      oldPricingVersion: string;
      newPricingVersion: string;
      oldCostMicroUsd: number;
      newCostMicroUsd: number;
      deltaMicroUsd: number;
      band?: string;
      tier?: string;
    }
  | { status: 'unchanged'; sku: string; pricingVersion: string; costMicroUsd: number }
  | { status: 'unrepriceable'; sku: string; reason: string };

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/** The SKU the event was priced as: `sku`, else the pricingVersion's prefix (legacy events). */
export function eventSku(item: Record<string, any>): string | undefined {
  if (typeof item.sku === 'string' && item.sku) return item.sku;
  const fromVersion = String(item.pricingVersion ?? '').split('@')[0];
  return fromVersion || undefined;
}

/**
 * The canonical meters stored on a chat event, or undefined when any are missing. Legacy events
 * call cache reads `cachedInputTokens` and predate cache-write and reasoning meters (both 0 then).
 */
export function storedMeters(item: Record<string, any>): Meters | undefined {
  const inputTokens = count(item.inputTokens);
  const outputTokens = count(item.outputTokens);
  const cacheReadTokens = count(item.cacheReadTokens ?? item.cachedInputTokens);
  const cacheWriteTokens = item.cacheWriteTokens === undefined ? 0 : count(item.cacheWriteTokens);
  const reasoningTokens = item.reasoningTokens === undefined ? 0 : count(item.reasoningTokens);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].includes(undefined)) return undefined;
  return { inputTokens: inputTokens!, cacheReadTokens: cacheReadTokens!, cacheWriteTokens: cacheWriteTokens!, outputTokens: outputTokens!, reasoningTokens: reasoningTokens! };
}

/** The version of `items` whose [validFrom, validTo) contains `at` (ranges derived for legacy items). */
export function versionAt(items: Record<string, any>[], at: Date): Record<string, any> | undefined {
  const t = pricingTime(at);
  const range = versionRanges(items).find((r) => r.validFrom <= t && (r.validTo === undefined || t < r.validTo));
  return range && items.find((i) => skOf(i) === range.sk);
}

/**
 * The event's current cost: its charge plus any adjustments already written for it. Re-pricing
 * compares against this, so a correction is never applied on top of an earlier one twice.
 */
export function currentCost(event: Record<string, any>, prior: Record<string, any>[]): { costMicroUsd: number; pricingVersion: string } {
  const sorted = [...prior].sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
  return {
    costMicroUsd: Number(event.costMicroUsd ?? 0) + sorted.reduce((sum, a) => sum + Number(a.deltaMicroUsd ?? 0), 0),
    pricingVersion: String(sorted.at(-1)?.newPricingVersion ?? event.pricingVersion ?? ''),
  };
}

/**
 * Recomputes one event's cost. Token events use the version's time band and context tier;
 * per-character (TTS) events use its microUsdPerMChars, per-request ones (Places) its microUsdPerRequest, per-unit
 * (search query) ones its microUsdPerKUnits. Never guesses: missing meters, markup or
 * price version make the event unrepriceable.
 *
 * [pricesAt]: use the price list valid at that instant instead of the one valid at the event's
 * time, for corrections where the old list itself was wrong (September's flat DeepSeek price).
 * The band (peak/off-peak) is still picked from the event's own time.
 */
export function repriceEvent(
  event: Record<string, any>,
  priceHistory: PriceHistory,
  prior: Record<string, any>[] = [],
  pricesAt?: Date,
): RepriceResult {
  const sku = eventSku(event);
  if (!sku) return { status: 'unrepriceable', sku: 'unknown', reason: 'no sku or pricing version' };
  const markupBps = count(event.markupBps);
  if (markupBps === undefined) return { status: 'unrepriceable', sku, reason: 'missing markupBps' };
  const at = new Date(ledgerTime(skOf(event)));
  if (Number.isNaN(at.getTime())) return { status: 'unrepriceable', sku, reason: 'bad event time' };
  const version = versionAt(priceHistory[sku] ?? [], pricesAt ?? at);
  if (!version) return { status: 'unrepriceable', sku, reason: `no price version covers ${pricesAt ? '--prices-at' : 'the event time'}` };
  const newPricingVersion = `${sku}@${skOf(version)}`;

  let newCost: number;
  let band: string | undefined;
  let tier: string | undefined;
  if (version.microUsdPerRequest !== undefined) {
    // One request per event (Places searches, static maps).
    const rate = count(version.microUsdPerRequest);
    if (rate === undefined) return { status: 'unrepriceable', sku, reason: 'malformed price version' };
    newCost = computeRequestCost(1, rate, markupBps).costMicroUsd;
  } else if (version.microUsdPerMChars !== undefined) {
    const rate = count(version.microUsdPerMChars);
    const chars = count(event.chars);
    if (rate === undefined) return { status: 'unrepriceable', sku, reason: 'malformed price version' };
    if (chars === undefined) return { status: 'unrepriceable', sku, reason: 'missing meters (chars)' };
    newCost = computeCharCost(chars, rate, markupBps).costMicroUsd;
  } else if (version.microUsdPerKUnits !== undefined) {
    const rate = count(version.microUsdPerKUnits);
    const units = count(event.units);
    if (rate === undefined) return { status: 'unrepriceable', sku, reason: 'malformed price version' };
    if (units === undefined) return { status: 'unrepriceable', sku, reason: 'missing meters (units)' };
    newCost = computeUnitCost(units, rate, markupBps).costMicroUsd;
  } else {
    const schedule = scheduleFromItem(version);
    if (!schedule) return { status: 'unrepriceable', sku, reason: 'malformed price version' };
    const meters = storedMeters(event);
    if (!meters) return { status: 'unrepriceable', sku, reason: 'missing meters (tokens)' };
    const selected = selectPrice(schedule, at, promptTokens(meters));
    newCost = computeCost(meters, selected.price, markupBps).costMicroUsd;
    band = selected.band;
    tier = selected.tier;
  }

  const old = currentCost(event, prior);
  if (newCost === old.costMicroUsd) return { status: 'unchanged', sku, pricingVersion: newPricingVersion, costMicroUsd: newCost };
  return {
    status: 'changed',
    sku,
    oldPricingVersion: old.pricingVersion,
    newPricingVersion,
    oldCostMicroUsd: old.costMicroUsd,
    newCostMicroUsd: newCost,
    deltaMicroUsd: newCost - old.costMicroUsd,
    ...(band ? { band } : {}),
    ...(tier ? { tier } : {}),
  };
}

export interface RepriceTotals {
  events: number;
  oldMicroUsd: number;
  newMicroUsd: number;
  deltaMicroUsd: number;
}

export interface RepricePlan {
  adjustments: Adjustment[];
  counts: { changed: number; unchanged: number; unrepriceable: number; alreadyAdjusted: number };
  unrepriceable: { sub: string; sk: string; sku: string; reason: string }[];
  /** Changed events whose adjustment with this reason already exists: needs a new --reason. */
  alreadyAdjusted: { sub: string; sk: string }[];
  byHousehold: Map<string, RepriceTotals>;
  byUser: Map<string, RepriceTotals>;
}

/**
 * Plans adjustments for every event of `appId` (legacy events belong to `legacyAppId`) and,
 * optionally, one SKU. `adjustments` are the ADJUST items already written for these events.
 */
export function planReprice(args: {
  events: Record<string, any>[];
  adjustments: Record<string, any>[];
  priceHistory: PriceHistory;
  appId: string;
  legacyAppId: string;
  sku?: string;
  reason: string;
  now: Date;
  /** See repriceEvent: one price list for every event. */
  pricesAt?: Date;
  /** 'none' (self-hosted): no household credit to correct. Default 'hosted'. */
  billing?: Billing;
}): RepricePlan {
  const priorBy = new Map<string, Record<string, any>[]>();
  for (const a of args.adjustments) {
    const k = `${pkOf(a)}|${a.eventSk}`;
    priorBy.set(k, [...(priorBy.get(k) ?? []), a]);
  }
  const plan: RepricePlan = {
    adjustments: [],
    counts: { changed: 0, unchanged: 0, unrepriceable: 0, alreadyAdjusted: 0 },
    unrepriceable: [],
    alreadyAdjusted: [],
    byHousehold: new Map(),
    byUser: new Map(),
  };
  const add = (map: Map<string, RepriceTotals>, key: string, oldMicro: number, newMicro: number) => {
    const t = map.get(key) ?? { events: 0, oldMicroUsd: 0, newMicroUsd: 0, deltaMicroUsd: 0 };
    t.events += 1;
    t.oldMicroUsd += oldMicro;
    t.newMicroUsd += newMicro;
    t.deltaMicroUsd += newMicro - oldMicro;
    map.set(key, t);
  };

  const events = args.events
    .filter((e) => skOf(e).startsWith(EVENT_PREFIX))
    .filter((e) => String(e.appId ?? args.legacyAppId) === args.appId)
    .sort((a, b) => (`${skOf(a)}|${pkOf(a)}` < `${skOf(b)}|${pkOf(b)}` ? -1 : 1));
  for (const event of events) {
    const sk = skOf(event);
    const sub = subOf(event);
    const householdId = String(event.householdId ?? 'unknown');
    if (args.sku && eventSku(event) !== args.sku) continue;
    const prior = priorBy.get(`${pkOf(event)}|${sk}`) ?? [];
    const result = repriceEvent(event, args.priceHistory, prior, args.pricesAt);
    if (result.status === 'unrepriceable') {
      plan.counts.unrepriceable += 1;
      plan.unrepriceable.push({ sub, sk, sku: result.sku, reason: result.reason });
      continue;
    }
    if (result.status === 'unchanged') {
      plan.counts.unchanged += 1;
      add(plan.byHousehold, householdId, result.costMicroUsd, result.costMicroUsd);
      add(plan.byUser, sub, result.costMicroUsd, result.costMicroUsd);
      continue;
    }
    if (prior.some((a) => a.adjustmentId === adjustmentId(args.reason, sk))) {
      plan.counts.alreadyAdjusted += 1;
      plan.alreadyAdjusted.push({ sub, sk });
      continue;
    }
    plan.counts.changed += 1;
    add(plan.byHousehold, householdId, result.oldCostMicroUsd, result.newCostMicroUsd);
    add(plan.byUser, sub, result.oldCostMicroUsd, result.newCostMicroUsd);
    plan.adjustments.push({
      appId: args.appId,
      sub,
      householdId,
      ...(event.plan ? { plan: String(event.plan) } : {}),
      eventSk: sk,
      eventTime: ledgerTime(sk),
      legacyEvent: event.appId === undefined,
      kind: String(event.kind ?? 'unknown'),
      sku: result.sku,
      reason: args.reason,
      oldPricingVersion: result.oldPricingVersion,
      newPricingVersion: result.newPricingVersion,
      oldCostMicroUsd: result.oldCostMicroUsd,
      newCostMicroUsd: result.newCostMicroUsd,
      deltaMicroUsd: result.deltaMicroUsd,
      createdAt: args.now.toISOString(),
      deductCredit: args.billing !== 'none' && event.plan === undefined,
      ...(result.band || result.tier
        ? { details: { ...(result.band ? { newPricingBand: result.band } : {}), ...(result.tier ? { newPricingTier: result.tier } : {}) } }
        : {}),
    });
  }
  return plan;
}

/** Ledger SK bounds for a [from, to) time range: dates or ISO instants, compared as SK strings. */
export function ledgerRange(prefix: typeof EVENT_PREFIX | typeof ADJUST_PREFIX, from: string, to: string) {
  return { lo: `${prefix}${from}`, hi: `${prefix}${to}` };
}

export interface RepriceArgs {
  appId: string;
  /** Inclusive start, exclusive end: YYYY-MM-DD (00:00 UTC) or an ISO instant. */
  from: string;
  to: string;
  sku?: string;
  reason: string;
  apply: boolean;
  /** ISO instant whose price list re-prices every event (default: each event's own time). */
  pricesAt?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-01" stays a date (it sorts before every key of that day); instants become ISO ms. */
function rangeBound(flag: string, v: string | true | undefined): string {
  if (typeof v !== 'string') throw new Error(`--${flag} is required (YYYY-MM-DD or ISO instant, UTC)`);
  const t = Date.parse(DATE.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t) || (!DATE.test(v) && !/Z$|[+-]\d{2}:\d{2}$/.test(v))) throw new Error(`Invalid --${flag} "${v}" (YYYY-MM-DD or ISO instant with zone)`);
  return DATE.test(v) ? v : new Date(t).toISOString();
}

/** reprice --from X --to Y [--app A] [--sku S] [--reason R] [--prices-at T] [--apply] */
export function parseRepriceArgs(args: string[], defaultAppId: string): RepriceArgs {
  const { positional, flags } = parseFlags(args, { values: ['app', 'from', 'to', 'sku', 'reason', 'prices-at'], booleans: ['apply'] });
  if (positional.length) throw new Error(`Unexpected argument ${positional[0]}`);
  const from = rangeBound('from', flags.from);
  const to = rangeBound('to', flags.to);
  if (!(from < to)) throw new Error('--from must be before --to');
  return {
    appId: checkAppId(typeof flags.app === 'string' ? flags.app : defaultAppId),
    from,
    to,
    ...(typeof flags.sku === 'string' ? { sku: flags.sku } : {}),
    reason: checkReason(typeof flags.reason === 'string' ? flags.reason : 'reprice'),
    apply: flags.apply === true,
    ...(flags['prices-at'] !== undefined ? { pricesAt: rangeBound('prices-at', flags['prices-at']) } : {}),
  };
}

/** USD with 6 decimals (formatUsd), signed for deltas. */
const signed = (micro: number) => (micro > 0 ? `+${formatUsd(micro)}` : formatUsd(micro));

export function formatRepricePlan(plan: RepricePlan): string {
  const section = (title: string, map: Map<string, RepriceTotals>) =>
    map.size
      ? [`\n${title}`, ...[...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, t]) =>
          `  ${k.padEnd(36)} ${String(t.events).padStart(5)} events  old ${formatUsd(t.oldMicroUsd)}  new ${formatUsd(t.newMicroUsd)}  delta ${signed(t.deltaMicroUsd)}`)]
      : [];
  const total = [...plan.byHousehold.values()].reduce((s, t) => s + t.deltaMicroUsd, 0);
  const c = plan.counts;
  return [
    `Events: ${c.changed} changed, ${c.unchanged} unchanged, ${c.unrepriceable} unrepriceable` +
      (c.alreadyAdjusted ? `, ${c.alreadyAdjusted} already adjusted with this reason (use a new --reason for a further correction)` : ''),
    `Total delta: ${signed(total)}`,
    ...section('By household', plan.byHousehold),
    ...section('By user', plan.byUser),
    ...(plan.unrepriceable.length
      ? ['\nUnrepriceable (left as charged)', ...plan.unrepriceable.map((u) => `  ${u.sub}  ${u.sk}  ${u.sku}: ${u.reason}`)]
      : []),
  ].join('\n');
}
