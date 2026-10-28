import { decimalToMicroUsd, formatUsd } from './cost';
import { BALANCE_PREFIX, keys, pkOf, skOf, utcDay } from './keys';
import { parseFlags } from './report';

/*
 * Provider reconciliation: does what the provider actually took from our account match what we
 * metered? DeepSeek exposes only a balance (GET /user/balance), so we snapshot it once a day and
 * compare the drop between two snapshots with our base cost (before markup) for the same days.
 *
 * Our side comes from PROVIDER#<provider> DAILY#<day> counters written in every usage transaction
 * (ledger.ts), so windows are whole UTC days: the scheduled snapshot runs at 00:00 UTC and a window
 * runs from one day-aligned snapshot to the next. Calls in flight at midnight land on either side;
 * at our volume that is a fraction of a cent.
 *
 *   PROVIDER#deepseek  BALANCE#<iso-ms>   immutable snapshot (USD only; other currencies listed)
 *
 * A balance that went up means a top-up happened in the window; how much of the change was spend
 * is then unknown, so the window is reported as not reconcilable instead of guessed. Pure, except
 * fetchDeepSeekBalance; the scheduled Lambda (reconcile-handler.ts) and the admin CLI do the I/O.
 */

export const DEEPSEEK_PROVIDER = 'deepseek';

/** A snapshot this long after 00:00 UTC still starts/ends a day window (Lambda start, retries). */
export const ALIGN_TOLERANCE_MS = 15 * 60_000;

/** Alarm when the provider's spend and ours differ by more than both of these (tiny windows are noisy). */
export const DRIFT_THRESHOLD_BPS = 1_500; // 15%
export const DRIFT_MIN_DIFF_MICRO_USD = 50_000; // $0.05

/** The low-balance alarm (metering/cdk.ts) and the dashboard's "top up" line, unless set otherwise. */
export const LOW_BALANCE_USD_DEFAULT = 1;

export interface Balance {
  isAvailable: boolean;
  totalBalanceMicroUsd: number;
  grantedBalanceMicroUsd: number;
  toppedUpBalanceMicroUsd: number;
  /** Currencies other than USD the account also reported (not reconciled). */
  otherCurrencies: string[];
}

export interface BalanceSnapshot extends Balance {
  provider: string;
  /** ISO, ms. */
  takenAt: string;
  /** 'schedule' (the daily Lambda) or 'admin' (reconcile --snapshot --apply). */
  source: string;
}

const amount = (info: Record<string, unknown>, field: string): number => {
  const v = info[field];
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`Balance field ${field} missing`);
  return decimalToMicroUsd(String(v));
};

/**
 * DeepSeek's /user/balance body: { is_available, balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }, amounts as decimal strings. Throws when malformed or
 * when there is no USD entry (a CNY-only account can't be compared with USD prices).
 */
export function parseDeepSeekBalance(body: unknown): Balance {
  const b = body as { is_available?: unknown; balance_infos?: unknown };
  if (typeof b !== 'object' || b === null || !Array.isArray(b.balance_infos)) throw new Error('Balance response has no balance_infos');
  const infos = b.balance_infos as Record<string, unknown>[];
  const usd = infos.filter((i) => i?.currency === 'USD');
  if (usd.length !== 1) throw new Error(`Expected one USD balance, got ${usd.length}`);
  return {
    isAvailable: b.is_available === true,
    totalBalanceMicroUsd: amount(usd[0], 'total_balance'),
    grantedBalanceMicroUsd: amount(usd[0], 'granted_balance'),
    toppedUpBalanceMicroUsd: amount(usd[0], 'topped_up_balance'),
    otherCurrencies: [...new Set(infos.map((i) => String(i?.currency)).filter((c) => c !== 'USD'))].sort(),
  };
}

/** GETs the balance. The key goes in the Authorization header only; errors never include it. */
export async function fetchDeepSeekBalance(url: string, apiKey: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Balance request failed: HTTP ${res.status}`);
  return res.json();
}

export function snapshotItem(s: BalanceSnapshot): Record<string, unknown> {
  return {
    ...keys.providerBalance(s.provider, s.takenAt),
    provider: s.provider,
    takenAt: s.takenAt,
    source: s.source,
    currency: 'USD',
    isAvailable: s.isAvailable,
    totalBalanceMicroUsd: s.totalBalanceMicroUsd,
    grantedBalanceMicroUsd: s.grantedBalanceMicroUsd,
    toppedUpBalanceMicroUsd: s.toppedUpBalanceMicroUsd,
    ...(s.otherCurrencies.length ? { otherCurrencies: s.otherCurrencies } : {}),
  };
}

export function snapshotFromItem(item: Record<string, any>): BalanceSnapshot | undefined {
  const sk = skOf(item);
  if (!sk.startsWith(BALANCE_PREFIX) || !Number.isSafeInteger(item.totalBalanceMicroUsd)) return undefined;
  return {
    provider: pkOf(item).replace(/^PROVIDER#/, ''),
    takenAt: sk.slice(BALANCE_PREFIX.length),
    source: String(item.source ?? 'unknown'),
    isAvailable: item.isAvailable === true,
    totalBalanceMicroUsd: item.totalBalanceMicroUsd,
    grantedBalanceMicroUsd: Number(item.grantedBalanceMicroUsd ?? 0),
    toppedUpBalanceMicroUsd: Number(item.toppedUpBalanceMicroUsd ?? 0),
    otherCurrencies: Array.isArray(item.otherCurrencies) ? item.otherCurrencies.map(String) : [],
  };
}

/** True when the snapshot was taken within ALIGN_TOLERANCE_MS after 00:00 UTC. */
export function isDayAligned(takenAt: string): boolean {
  const ms = new Date(takenAt).getTime();
  return Number.isFinite(ms) && ms % 86_400_000 < ALIGN_TOLERANCE_MS;
}

export interface ReconcileWindow {
  /** Day-aligned snapshots that bound the window. */
  start: BalanceSnapshot;
  end: BalanceSnapshot;
  /** UTC days [fromDay, toDay) whose counters are our side. */
  fromDay: string;
  toDay: string;
  /** Some snapshot in the window showed a higher balance than the one before it. */
  toppedUp: boolean;
}

/**
 * Windows between consecutive day-aligned snapshots on different days. Snapshots in between
 * (manual ones, a retried run) don't split a window, but a balance increase at any of them marks
 * it as a top-up window. Snapshots before the first aligned one are ignored.
 */
export function reconcileWindows(snapshots: BalanceSnapshot[]): ReconcileWindow[] {
  const sorted = [...snapshots].sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
  const windows: ReconcileWindow[] = [];
  let start: BalanceSnapshot | undefined;
  let prev: BalanceSnapshot | undefined;
  let toppedUp = false;
  for (const s of sorted) {
    if (start && prev && s.totalBalanceMicroUsd > prev.totalBalanceMicroUsd) toppedUp = true;
    prev = s;
    if (!isDayAligned(s.takenAt)) continue;
    if (!start) {
      start = s;
      toppedUp = false;
    } else if (utcDay(new Date(s.takenAt)) > utcDay(new Date(start.takenAt))) {
      windows.push({ start, end: s, fromDay: utcDay(new Date(start.takenAt)), toDay: utcDay(new Date(s.takenAt)), toppedUp });
      start = s;
      toppedUp = false;
    }
  }
  return windows;
}

export interface ProviderDay {
  day: string;
  requests: number;
  baseCostMicroUsd: number;
}

/** A PROVIDER#<p> DAILY#<day> counter item, or undefined for any other item. */
export function providerDayFromItem(item: Record<string, any>): ProviderDay | undefined {
  const sk = skOf(item);
  if (!sk.startsWith('DAILY#')) return undefined;
  return { day: sk.slice('DAILY#'.length), requests: Number(item.requests ?? 0), baseCostMicroUsd: Number(item.baseCostMicroUsd ?? 0) };
}

export interface Reconciliation extends ReconcileWindow {
  /** 'topup': the balance went up in the window, so the provider's spend is unknown. */
  status: 'reconciled' | 'topup';
  /** start balance - end balance (meaningless when status is 'topup'). */
  providerSpendMicroUsd: number;
  meteredBaseMicroUsd: number;
  requests: number;
  /** provider - metered: positive = the provider took more than we metered (we under-meter). */
  diffMicroUsd: number;
  /** diff / provider spend in basis points (truncated); null when the provider spent nothing but we metered some. */
  driftBps: number | null;
  breached: boolean;
}

/** diff / provider in basis points, integer math. 0 when both are 0. */
export function driftBps(providerMicroUsd: number, meteredMicroUsd: number): number | null {
  const diff = BigInt(providerMicroUsd - meteredMicroUsd);
  if (providerMicroUsd === 0) return diff === 0n ? 0 : null;
  return Number((diff * 10_000n) / BigInt(providerMicroUsd));
}

/** The alarm rule: |drift| > 15% AND |provider - ours| > $0.05. An unbounded drift counts as over 15%. */
export function driftBreached(providerMicroUsd: number, meteredMicroUsd: number): boolean {
  const bps = driftBps(providerMicroUsd, meteredMicroUsd);
  return Math.abs(providerMicroUsd - meteredMicroUsd) > DRIFT_MIN_DIFF_MICRO_USD && (bps === null || Math.abs(bps) > DRIFT_THRESHOLD_BPS);
}

export function reconcile(w: ReconcileWindow, days: ProviderDay[]): Reconciliation {
  const inWindow = days.filter((d) => d.day >= w.fromDay && d.day < w.toDay);
  const metered = inWindow.reduce((sum, d) => sum + d.baseCostMicroUsd, 0);
  const requests = inWindow.reduce((sum, d) => sum + d.requests, 0);
  const provider = w.start.totalBalanceMicroUsd - w.end.totalBalanceMicroUsd;
  const reconcilable = !w.toppedUp && provider >= 0;
  return {
    ...w,
    status: reconcilable ? 'reconciled' : 'topup',
    providerSpendMicroUsd: provider,
    meteredBaseMicroUsd: metered,
    requests,
    diffMicroUsd: provider - metered,
    driftBps: reconcilable ? driftBps(provider, metered) : null,
    breached: reconcilable && driftBreached(provider, metered),
  };
}

/**
 * CloudWatch datapoints for one window (none for a top-up window). DriftPct is for graphs;
 * DriftBreached (0/1) carries the alarm rule, so the thresholds live in one tested place.
 */
export function driftMetricData(r: Reconciliation, prefix: string): { MetricName: string; Value: number; Unit: 'Percent' | 'None' | 'Count' }[] {
  if (r.status !== 'reconciled') return [];
  return [
    ...(r.driftBps !== null ? [{ MetricName: `${prefix}DriftPct`, Value: r.driftBps / 100, Unit: 'Percent' as const }] : []),
    { MetricName: `${prefix}DriftMicroUsd`, Value: r.diffMicroUsd, Unit: 'None' },
    { MetricName: `${prefix}DriftBreached`, Value: r.breached ? 1 : 0, Unit: 'Count' },
  ];
}

/**
 * The balance itself, published on every snapshot so a low balance alarms before calls start
 * failing (and before the fallback model quietly takes over). USD as a float is fine here: it's a
 * metric for an alarm threshold, never money we record.
 */
export function balanceMetricData(s: Pick<BalanceSnapshot, 'totalBalanceMicroUsd' | 'isAvailable'>, prefix: string): { MetricName: string; Value: number; Unit: 'None' | 'Count' }[] {
  return [
    { MetricName: `${prefix}BalanceUsd`, Value: s.totalBalanceMicroUsd / 1_000_000, Unit: 'None' },
    { MetricName: `${prefix}Unavailable`, Value: s.isAvailable ? 0 : 1, Unit: 'Count' },
  ];
}

/** Basis points as "12.34%" (exact, no float division). */
export function formatBps(bps: number | null): string {
  if (bps === null) return 'n/a';
  const abs = Math.abs(bps);
  return `${bps < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

export function formatSnapshot(s: BalanceSnapshot): string {
  return `${s.takenAt}  ${formatUsd(s.totalBalanceMicroUsd)} (granted ${formatUsd(s.grantedBalanceMicroUsd)}, ` +
    `topped-up ${formatUsd(s.toppedUpBalanceMicroUsd)})  ${s.isAvailable ? 'available' : 'NOT available'}  [${s.source}]` +
    `${isDayAligned(s.takenAt) ? '' : '  (not day-aligned)'}${s.otherCurrencies.length ? `  also: ${s.otherCurrencies.join(', ')}` : ''}`;
}

export function formatReconciliation(r: Reconciliation): string {
  const head = `${r.fromDay} .. ${r.toDay}  `;
  if (r.status === 'topup') {
    return `${head}top-up in window, not reconcilable (balance ${formatUsd(r.start.totalBalanceMicroUsd)} -> ` +
      `${formatUsd(r.end.totalBalanceMicroUsd)}; metered ${formatUsd(r.meteredBaseMicroUsd)}, ${r.requests} req)`;
  }
  return `${head}provider ${formatUsd(r.providerSpendMicroUsd)}  metered ${formatUsd(r.meteredBaseMicroUsd)} (${r.requests} req)  ` +
    `diff ${formatUsd(r.diffMicroUsd)}  drift ${formatBps(r.driftBps)}${r.breached ? '  DRIFT ALARM' : ''}`;
}

export interface ReconcileArgs {
  days: number;
  snapshot: boolean;
  apply: boolean;
}

/** reconcile [--days 14] [--snapshot [--apply]] */
export function parseReconcileArgs(args: string[]): ReconcileArgs {
  const { positional, flags } = parseFlags(args, { values: ['days'], booleans: ['snapshot', 'apply'] });
  if (positional.length) throw new Error(`Unexpected argument ${positional[0]}`);
  const days = flags.days === undefined ? 14 : Number(flags.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('--days must be a whole number from 1 to 366');
  if (flags.apply && !flags.snapshot) throw new Error('--apply only applies to --snapshot');
  return { days, snapshot: flags.snapshot === true, apply: flags.apply === true };
}
