import { usdToMicroUsd, type Price } from './cost';
import { pkOf, skOf } from './keys';

/*
 * PRICING#<sku> items, one per immutable price version:
 *
 *   PK  PRICING#deepseek-v4-flash
 *   SK  2026-10-05T16:00:00Z        (= validFrom; legacy items use a bare date, meaning 00:00 UTC)
 *   validFrom 2026-10-05T16:00:00Z  (absent on legacy items until `price-migrate --apply`)
 *   validTo   2026-11-01T00:00:00Z  (exclusive; set once, atomically, when the next version is added)
 *   inputMicroUsdPerMTok, cachedInputMicroUsdPerMTok, outputMicroUsdPerMTok,
 *   cacheWriteMicroUsdPerMTok?, reasoningMicroUsdPerMTok?      default rate card
 *   tiers?: [{ aboveInputTokens: 200000, ...rates }]            context tiers of the default card
 *   bands?: [{ name, days, hours, ...rates, tiers? }]           time-of-day rate cards
 *
 * Rates are chosen in two steps: the time band (first match, else the default card), then the
 * card's highest context tier whose threshold the call's prompt tokens exceed (else the card).
 * A tier prices the whole call, which is how providers with long-context pricing bill it.
 */

/** Rates that apply to the whole call once its prompt tokens exceed `aboveInputTokens`. */
export interface PriceTier extends Price {
  aboveInputTokens: number;
}

export interface RateCard extends Price {
  tiers?: PriceTier[];
}

export interface PriceBand extends RateCard {
  name: string;
  /** UTC days of the week, 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** UTC hour windows, start inclusive, end exclusive (0..24). A window never wraps past midnight. */
  hours: { startHour: number; endHour: number }[];
}

export interface PricingSchedule {
  default: RateCard;
  bands: PriceBand[];
}

export const DEFAULT_BAND = 'default';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export interface SelectedPrice {
  price: Price;
  /** Undefined for a schedule without bands, so flat prices are recorded exactly as before. */
  band?: string;
  /** e.g. ">200000"; undefined when no tier applies. */
  tier?: string;
}

/** The rates in force at `at` (UTC) for a call that read `promptTokens` tokens. */
export function selectPrice(schedule: PricingSchedule, at: Date, promptTokens = 0): SelectedPrice {
  let card: RateCard = schedule.default;
  let band: string | undefined;
  if (schedule.bands.length > 0) {
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    const match = schedule.bands.find(
      (b) => b.days.includes(day) && b.hours.some((w) => hour >= w.startHour && hour < w.endHour),
    );
    card = match ?? schedule.default;
    band = match ? match.name : DEFAULT_BAND;
  }
  const tier = [...(card.tiers ?? [])]
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)
    .find((t) => promptTokens > t.aboveInputTokens);
  return {
    price: priceOf(tier ?? card),
    ...(band ? { band } : {}),
    ...(tier ? { tier: `>${tier.aboveInputTokens}` } : {}),
  };
}

const priceOf = (p: Price): Price => ({
  inputMicroUsdPerMTok: p.inputMicroUsdPerMTok,
  cachedInputMicroUsdPerMTok: p.cachedInputMicroUsdPerMTok,
  outputMicroUsdPerMTok: p.outputMicroUsdPerMTok,
  ...(p.cacheWriteMicroUsdPerMTok !== undefined ? { cacheWriteMicroUsdPerMTok: p.cacheWriteMicroUsdPerMTok } : {}),
  ...(p.reasoningMicroUsdPerMTok !== undefined ? { reasoningMicroUsdPerMTok: p.reasoningMicroUsdPerMTok } : {}),
});

const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isHour = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

function priceFromRecord(r: Record<string, any>): Price | undefined {
  const price: Price = {
    inputMicroUsdPerMTok: Number(r.inputMicroUsdPerMTok),
    cachedInputMicroUsdPerMTok: Number(r.cachedInputMicroUsdPerMTok),
    outputMicroUsdPerMTok: Number(r.outputMicroUsdPerMTok),
  };
  if (!Object.values(price).every(isRate)) return undefined;
  for (const key of ['cacheWriteMicroUsdPerMTok', 'reasoningMicroUsdPerMTok'] as const) {
    if (r[key] === undefined) continue;
    const rate = Number(r[key]);
    if (!isRate(rate)) return undefined;
    price[key] = rate;
  }
  return price;
}

function cardFromRecord(r: Record<string, any>): RateCard | undefined {
  const price = priceFromRecord(r);
  if (!price) return undefined;
  if (r.tiers === undefined) return price;
  if (!Array.isArray(r.tiers) || r.tiers.length === 0) return undefined;
  const tiers: PriceTier[] = [];
  for (const t of r.tiers) {
    const tierPrice = typeof t === 'object' && t !== null ? priceFromRecord(t) : undefined;
    const above = Number(t?.aboveInputTokens);
    if (!tierPrice || !Number.isSafeInteger(above) || above <= 0) return undefined;
    tiers.push({ aboveInputTokens: above, ...tierPrice });
  }
  if (new Set(tiers.map((t) => t.aboveInputTokens)).size !== tiers.length) return undefined;
  return { ...price, tiers };
}

/** Reads a stored pricing item. Returns undefined if anything is malformed: never guess a price. */
export function scheduleFromItem(item: Record<string, any>): PricingSchedule | undefined {
  const base = cardFromRecord(item);
  if (!base) return undefined;
  if (item.bands === undefined) return { default: base, bands: [] };
  if (!Array.isArray(item.bands)) return undefined;

  const bands: PriceBand[] = [];
  for (const b of item.bands) {
    const card = typeof b === 'object' && b !== null ? cardFromRecord(b) : undefined;
    if (!card || typeof b.name !== 'string' || !b.name || b.name === DEFAULT_BAND) return undefined;
    const days = (Array.isArray(b.days) ? b.days : []).map(Number);
    const hours = Array.isArray(b.hours) ? b.hours : [];
    if (days.length === 0 || !days.every((d: number) => isHour(d, 6))) return undefined;
    if (
      hours.length === 0 ||
      !hours.every((w: any) => isHour(Number(w?.startHour), 23) && isHour(Number(w?.endHour), 24) && Number(w.startHour) < Number(w.endHour))
    ) {
      return undefined;
    }
    bands.push({
      name: b.name,
      days,
      hours: hours.map((w: any) => ({ startHour: Number(w.startHour), endHour: Number(w.endHour) })),
      ...card,
    });
  }
  return { default: base, bands };
}

// ---------------------------------------------------------------------------------------------
// Billing SKUs: prices are keyed by SKU, not by the model name a provider happens to use today.

/**
 * Model name -> billing SKU. Names missing from the alias map are their own SKU, so the
 * configured model (e.g. deepseek-v4-flash) prices exactly as before.
 */
export function skuFor(model: string, aliases: Record<string, string>): string {
  return Object.hasOwn(aliases, model) ? aliases[model] : model;
}

// ---------------------------------------------------------------------------------------------
// Version ranges. Every timestamp is canonical UTC to the second ("YYYY-MM-DDTHH:MM:SSZ"), so
// plain string comparison orders them, and legacy bare-date sort keys still sort correctly.

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A Date as the canonical key used for range lookups (milliseconds dropped). */
export const pricingTime = (at: Date) => at.toISOString().slice(0, 19) + 'Z';

/** "2026-10-05", "2026-10-05T16:00Z" or "2026-10-05T16:00:00Z" -> "2026-10-05T16:00:00Z". */
export function parseValidFrom(spec: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?Z)?$/.exec(spec.trim());
  const iso = m ? `${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}Z` : '';
  if (!m || Number.isNaN(Date.parse(iso)) || pricingTime(new Date(iso)) !== iso) {
    throw new Error(`Invalid start "${spec}" (UTC: YYYY-MM-DD or YYYY-MM-DDTHH:MMZ)`);
  }
  return iso;
}

/** A stored price or plan-definition version item (its SK is the validFrom). */
export type StoredVersion = Record<string, any> & { validFrom?: string; validTo?: string };

/** validFrom of a stored version: the attribute, else derived from a legacy bare-date SK. */
export function validFromOf(item: StoredVersion): string {
  if (typeof item.validFrom === 'string' && CANONICAL.test(item.validFrom)) return item.validFrom;
  const sk = skOf(item);
  return CANONICAL.test(sk) ? sk : `${sk}T00:00:00Z`;
}

/** True when `at` falls inside the version's [validFrom, validTo) range. */
export function versionCovers(item: StoredVersion, at: Date): boolean {
  const t = pricingTime(at);
  return validFromOf(item) <= t && (item.validTo === undefined || t < item.validTo);
}

export interface PriceVersionRange {
  sk: string;
  validFrom: string;
  validTo?: string;
  /** True when the range is computed from the next version rather than stored on the item. */
  derived: boolean;
}

/** Ranges for one SKU's versions (any order); legacy items get ranges derived from their successor. */
export function versionRanges(items: StoredVersion[]): PriceVersionRange[] {
  const sorted = [...items].sort((a, b) => (validFromOf(a) < validFromOf(b) ? -1 : 1));
  return sorted.map((item, i) => {
    const next = sorted[i + 1];
    const derivedTo = next ? validFromOf(next) : undefined;
    return {
      sk: skOf(item),
      validFrom: validFromOf(item),
      validTo: item.validTo ?? derivedTo,
      derived: item.validFrom === undefined || (item.validTo === undefined && derivedTo !== undefined),
    };
  });
}

/**
 * Checks a new version against the current latest one. Returns the update that closes the latest
 * version's range (set atomically with the new version's put), or throws.
 * Backdating is refused unless explicit: calls already metered at the old price would then fall
 * inside the new version's range and history would disagree with what was recorded.
 */
export function planNewVersion(
  latest: StoredVersion | undefined,
  validFrom: string,
  now: Date,
  allowBackdate = false,
): { closePrevious?: { sk: string; validFrom: string; validTo: string } } {
  if (!latest) return {};
  const latestFrom = validFromOf(latest);
  if (validFrom <= latestFrom) {
    throw new Error(`New version must start after the latest one (${latestFrom}); versions are immutable`);
  }
  if (latest.validTo !== undefined) throw new Error(`Latest version ${skOf(latest)} is already closed at ${latest.validTo}`);
  if (validFrom < pricingTime(now) && !allowBackdate) {
    throw new Error(`${validFrom} is in the past; calls since then were priced with ${skOf(latest)}. Use --backdate to force`);
  }
  return { closePrevious: { sk: skOf(latest), validFrom: latestFrom, validTo: validFrom } };
}

export interface MigrationStep {
  pk: string;
  sk: string;
  validFrom: string;
  validTo?: string;
}

/** Stores the derived ranges on legacy items. Idempotent: items that already have them are skipped. */
export function planPriceMigration(items: StoredVersion[]): MigrationStep[] {
  const byPk = new Map<string, typeof items>();
  for (const item of items) byPk.set(pkOf(item), [...(byPk.get(pkOf(item)) ?? []), item]);
  const steps: MigrationStep[] = [];
  for (const [pk, versions] of [...byPk].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const range of versionRanges(versions)) {
      const item = versions.find((v) => skOf(v) === range.sk)!;
      const needsFrom = item.validFrom === undefined;
      const needsTo = item.validTo === undefined && range.validTo !== undefined;
      if (needsFrom || needsTo) {
        steps.push({ pk, sk: range.sk, validFrom: range.validFrom, ...(needsTo ? { validTo: range.validTo } : {}) });
      }
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Admin CLI parsing.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "mon-fri", "sat,sun", "mon,wed-fri", "all" -> sorted UTC day numbers. */
export function parseDays(spec: string): number[] {
  const s = spec.trim().toLowerCase();
  if (s === 'all' || s === '*') return [...ALL_DAYS];
  const days = new Set<number>();
  for (const part of s.split(',')) {
    const [from, to = from] = part.split('-').map((d) => DAY_NAMES.indexOf(d.trim()));
    if (from < 0 || to < 0 || from > to) throw new Error(`Invalid days "${spec}" (e.g. mon-fri, sat,sun, all)`);
    for (let d = from; d <= to; d++) days.add(d);
  }
  return [...days].sort((a, b) => a - b);
}

/** "01-04,06-10" -> windows; end is exclusive and may be 24. */
export function parseHours(spec: string): { startHour: number; endHour: number }[] {
  return spec.split(',').map((part) => {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(part.trim());
    const startHour = Number(m?.[1]);
    const endHour = Number(m?.[2]);
    if (!m || startHour > 23 || endHour > 24 || startHour >= endHour) {
      throw new Error(`Invalid hours "${part}" (UTC, end exclusive, no wrap past midnight, e.g. 01-04,06-10 or 22-24,00-02)`);
    }
    return { startHour, endHour };
  });
}

/** inputUsd:cachedInputUsd:outputUsd[:cacheWriteUsd[:reasoningUsd]] -> Price. */
function parseRates(parts: string[], spec: string): Price {
  if (parts.length < 3 || parts.length > 5) throw new Error(`Invalid rates in "${spec}"`);
  const [input, cached, output, cacheWrite, reasoning] = parts;
  return {
    inputMicroUsdPerMTok: usdToMicroUsd(input),
    cachedInputMicroUsdPerMTok: usdToMicroUsd(cached),
    outputMicroUsdPerMTok: usdToMicroUsd(output),
    ...(cacheWrite ? { cacheWriteMicroUsdPerMTok: usdToMicroUsd(cacheWrite) } : {}),
    ...(reasoning ? { reasoningMicroUsdPerMTok: usdToMicroUsd(reasoning) } : {}),
  };
}

/**
 * Admin CLI band spec: <name>:<days>:<hours>:<inputUsd>:<cachedInputUsd>:<outputUsd>[:<cacheWriteUsd>[:<reasoningUsd>]]
 * e.g. "peak:mon-fri:01-04,06-10:0.30:0.006:1.20"
 */
export function parseBandSpec(spec: string): PriceBand {
  const parts = spec.split(':');
  if (parts.length < 6 || parts.length > 8) {
    throw new Error(`Invalid band "${spec}" (use name:days:hours:inputUsd:cachedInputUsd:outputUsd[:cacheWriteUsd[:reasoningUsd]])`);
  }
  const [name, days, hours, ...rates] = parts;
  if (!/^[a-z0-9_-]+$/i.test(name) || name === DEFAULT_BAND) throw new Error(`Invalid band name "${name}"`);
  return { name, days: parseDays(days), hours: parseHours(hours), ...parseRates(rates, spec) };
}

/**
 * Admin CLI tier spec: <aboveInputTokens>:<inputUsd>:<cachedInputUsd>:<outputUsd>[:<cacheWriteUsd>[:<reasoningUsd>]][@<band>]
 * Without @band the tier belongs to the default rate card.
 */
export function parseTierSpec(spec: string): { band?: string; tier: PriceTier } {
  const [body, band, extra] = spec.split('@');
  if (extra !== undefined || band === '') throw new Error(`Invalid tier "${spec}"`);
  const [above, ...rates] = body.split(':');
  if (!/^\d+$/.test(above) || Number(above) <= 0 || !Number.isSafeInteger(Number(above))) {
    throw new Error(`Invalid tier threshold "${above}" (prompt tokens, e.g. 200000)`);
  }
  return { ...(band ? { band } : {}), tier: { aboveInputTokens: Number(above), ...parseRates(rates, spec) } };
}

export interface PriceSetArgs {
  positional: string[];
  bands: PriceBand[];
  /** Tiers of the default card. Band tiers are attached to their band. */
  tiers: PriceTier[];
  cacheWriteMicroUsdPerMTok?: number;
  reasoningMicroUsdPerMTok?: number;
  backdate: boolean;
}

/** Splits `price-set` args into positional values and flags (`--flag value` or `--flag=value`). */
export function parsePriceSetArgs(args: string[]): PriceSetArgs {
  const out: PriceSetArgs = { positional: [], bands: [], tiers: [], backdate: false };
  const bandTiers: { band: string; tier: PriceTier }[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith('--') ? args[i].split(/=(.*)/s) : [args[i]];
    const value = () => {
      const v = inline ?? args[++i];
      if (!v) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--band':
        out.bands.push(parseBandSpec(value()));
        break;
      case '--tier': {
        const { band, tier } = parseTierSpec(value());
        if (band) bandTiers.push({ band, tier });
        else out.tiers.push(tier);
        break;
      }
      case '--cache-write':
        out.cacheWriteMicroUsdPerMTok = usdToMicroUsd(value());
        break;
      case '--reasoning':
        out.reasoningMicroUsdPerMTok = usdToMicroUsd(value());
        break;
      case '--backdate':
        out.backdate = true;
        break;
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}`);
        out.positional.push(args[i]);
    }
  }
  if (new Set(out.bands.map((b) => b.name)).size !== out.bands.length) throw new Error('Band names must be unique');
  for (const { band, tier } of bandTiers) {
    const target = out.bands.find((b) => b.name === band);
    if (!target) throw new Error(`Tier refers to unknown band "${band}" (declare the --band first)`);
    target.tiers = [...(target.tiers ?? []), tier];
  }
  for (const card of [out, ...out.bands]) {
    const thresholds = card.tiers?.map((t) => t.aboveInputTokens) ?? [];
    if (new Set(thresholds).size !== thresholds.length) throw new Error('Tier thresholds must be unique per rate card');
  }
  return out;
}
