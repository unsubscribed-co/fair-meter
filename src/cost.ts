/**
 * Rates are integer micro-USD per 1M tokens. Never floats.
 * `cachedInputMicroUsdPerMTok` is the cache-read rate (the attribute name predates cache writes).
 * The two optional rates fall back so a price list only states what the provider actually charges:
 * cache writes cost the input rate, reasoning tokens cost the output rate.
 */
export interface Price {
  inputMicroUsdPerMTok: number;
  cachedInputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  cacheWriteMicroUsdPerMTok?: number;
  reasoningMicroUsdPerMTok?: number;
}

/**
 * Canonical meters for one LLM call. They never overlap, so cost is a plain sum:
 * inputTokens excludes cache reads and writes; outputTokens excludes reasoningTokens.
 */
export interface Meters {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const METER_NAMES = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const;

/** Every token the model read for this call; context tiers are chosen on this. */
export const promptTokens = (m: Meters) => m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;

export interface Cost {
  baseCostMicroUsd: number;
  costMicroUsd: number;
}

/** Integer math only; rounds up so fractional micro-USD are never lost. */
export function computeCost(m: Meters, price: Price, markupBps: number): Cost {
  const numerator =
    BigInt(m.inputTokens) * BigInt(price.inputMicroUsdPerMTok) +
    BigInt(m.cacheReadTokens) * BigInt(price.cachedInputMicroUsdPerMTok) +
    BigInt(m.cacheWriteTokens) * BigInt(price.cacheWriteMicroUsdPerMTok ?? price.inputMicroUsdPerMTok) +
    BigInt(m.outputTokens) * BigInt(price.outputMicroUsdPerMTok) +
    BigInt(m.reasoningTokens) * BigInt(price.reasoningMicroUsdPerMTok ?? price.outputMicroUsdPerMTok);
  return withMarkup(ceilDiv(numerator, 1_000_000n), markupBps);
}

/** Per-character pricing (text-to-speech). Same integer math and rounding as computeCost. */
export function computeCharCost(chars: number, microUsdPerMChars: number, markupBps: number): Cost {
  return withMarkup(ceilDiv(BigInt(chars) * BigInt(microUsdPerMChars), 1_000_000n), markupBps);
}

/** Per-request pricing (a Places search, a static map): `microUsdPerRequest` per call. Same integer math as computeCost. */
export function computeRequestCost(requests: number, microUsdPerRequest: number, markupBps: number): Cost {
  return withMarkup(BigInt(requests) * BigInt(microUsdPerRequest), markupBps);
}

/**
 * Per-unit pricing (one web search query the model ran, docs/questions-and-search.md): the rate is per 1,000 units,
 * as providers list it ($14 per 1,000 queries = 14_000_000). Same integer math and rounding as computeCost.
 */
export function computeUnitCost(units: number, microUsdPerKUnits: number, markupBps: number): Cost {
  return withMarkup(ceilDiv(BigInt(units) * BigInt(microUsdPerKUnits), 1_000n), markupBps);
}

function withMarkup(base: bigint, markupBps: number): Cost {
  const marked = ceilDiv(base * (10_000n + BigInt(markupBps)), 10_000n);
  return { baseCostMicroUsd: Number(base), costMicroUsd: Number(marked) };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Parses a decimal USD string like "5" or "0.27" into integer micro-USD without float rounding. */
export function usdToMicroUsd(usd: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!match) throw new Error(`Invalid USD amount "${usd}" (use up to 6 decimals, e.g. 0.27)`);
  const micro = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Amount too large: ${usd}`);
  return Number(micro);
}

/**
 * Parses a decimal amount from a provider API ("12", "0.10", "-1.5", "0.0000004416", "4.416E-7")
 * into integer micro-USD with string/BigInt math, never floats. Digits past the sixth decimal are
 * rounded half away from zero: these amounts are read for reconciliation and reports, and a
 * sub-micro remainder can't be represented anyway.
 */
export function decimalToMicroUsd(value: string): number {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal amount "${value}"`);
  const [, sign, rawInt, frac = '', exp = '0'] = match;
  const int = rawInt.replace(/^0+(?=\d)/, '');
  // Shift the decimal point by the exponent plus 6 (micro), on the digit string.
  const digits = int + frac;
  const point = int.length + Number(exp) + 6;
  if (point > 40) throw new Error(`Amount too large: ${value}`);
  const whole = point <= 0 ? '0' : digits.padEnd(point, '0').slice(0, point);
  const firstDropped = point < 0 ? 0 : Number(digits[point] ?? 0);
  let micro = BigInt(whole) + (firstDropped >= 5 ? 1n : 0n);
  if (sign === '-') micro = -micro;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER) || micro < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Amount too large: ${value}`);
  return Number(micro) || 0; // no -0
}

/** Integer micro-USD to a "$0.012345" string (display only, exact: no float division). */
export function formatUsd(micro: number | bigint | undefined): string {
  const v = BigInt(micro ?? 0);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  return `${sign}$${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
}
