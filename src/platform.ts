import { decimalToMicroUsd, formatUsd } from './cost';
import { ADJUST_PREFIX, EVENT_PREFIX, ledgerTime, skOf, subOf } from './keys';
import { checkAppId, eventFacts, parseFlags } from './report';

/*
 * Platform overhead (Lambda, API Gateway, DynamoDB, CloudWatch, S3, SQS, Glue, Athena, ...) is
 * never priced per request: once a month its AWS cost is split across users in proportion to the
 * time their calls kept the proxy busy (EVENT durationMs, the whole proxy call). Users with no
 * recorded duration get nothing; if nobody has any, the total stays unallocated.
 *
 * The cost side is one Cost Explorer GetCostAndUsage call (UNBLENDED, grouped by SERVICE) for the
 * UTC month. Cost Explorer is account-wide per service: this assumes the account runs only this
 * stack (true for the `prod` account). Pure; the admin CLI does the call and the table reads.
 */

/**
 * Cost Explorer SERVICE names counted as platform overhead. Anything else the account spent on is
 * listed as excluded, so a renamed or new service shows up instead of vanishing silently.
 */
export const PLATFORM_SERVICES = [
  'AWS Lambda',
  'Amazon API Gateway',
  'Amazon DynamoDB',
  'AmazonCloudWatch',
  'Amazon Simple Storage Service',
  'Amazon Simple Queue Service',
  'Amazon Simple Notification Service',
  'AWS Glue',
  'Amazon Athena',
  'Amazon EventBridge',
  'CloudWatch Events',
  'AWS Systems Manager',
  'AWS Key Management Service',
  'AWS Cost Explorer',
];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GetCostAndUsage input for UTC month "YYYY-MM": [1st, min(next 1st, tomorrow)). End is exclusive
 * and capped at tomorrow so the current month asks only for days that exist.
 */
export function costExplorerRequest(month: string, now: Date) {
  if (!MONTH.test(month)) throw new Error(`Invalid month "${month}" (YYYY-MM)`);
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m, 1));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  if (start >= tomorrow) throw new Error(`${month} has not started yet`);
  const end = next < tomorrow ? next : tomorrow;
  return {
    input: {
      TimePeriod: { Start: isoDay(start), End: isoDay(end) },
      Granularity: 'MONTHLY' as const,
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION' as const, Key: 'SERVICE' }],
    },
    /** The month is still running, so its costs are incomplete. */
    partial: end < next,
  };
}

export interface PlatformCosts {
  /** Platform services and their cost (micro-USD), as Cost Explorer names them. */
  services: Record<string, number>;
  /** Everything else the account was charged for in the period. */
  excluded: Record<string, number>;
  totalMicroUsd: number;
}

/** Maps a GetCostAndUsage response (grouped by SERVICE) onto platform and excluded services. */
export function mapCostResponse(
  response: { ResultsByTime?: { Groups?: { Keys?: string[]; Metrics?: Record<string, { Amount?: string; Unit?: string }> }[] }[] },
  platformServices: string[] = PLATFORM_SERVICES,
): PlatformCosts {
  const services: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  for (const result of response.ResultsByTime ?? []) {
    for (const group of result.Groups ?? []) {
      const name = group.Keys?.[0] ?? 'unknown';
      const metric = group.Metrics?.UnblendedCost;
      if (!metric?.Amount) continue;
      if (metric.Unit && metric.Unit !== 'USD') throw new Error(`Cost Explorer returned ${metric.Unit} for ${name}, expected USD`);
      const target = platformServices.includes(name) ? services : excluded;
      target[name] = (target[name] ?? 0) + decimalToMicroUsd(metric.Amount);
    }
  }
  return { services, excluded, totalMicroUsd: Object.values(services).reduce((a, b) => a + b, 0) };
}

/**
 * Splits `totalMicroUsd` across keys in proportion to their weights with the largest-remainder
 * method, so the shares sum exactly to the total (integer math). Ties go to the larger weight, then
 * the smaller key, so the result is deterministic. A negative total (credits) is split the same way.
 * With no positive weight nothing is allocated.
 */
export function allocate(totalMicroUsd: number, weights: Map<string, number>): { shares: Map<string, number>; unallocatedMicroUsd: number } {
  const entries = [...weights].map(([key, w]) => [key, BigInt(Math.max(0, Math.trunc(w)))] as const);
  const sum = entries.reduce((a, [, w]) => a + w, 0n);
  if (sum === 0n) return { shares: new Map(entries.map(([key]) => [key, 0])), unallocatedMicroUsd: totalMicroUsd };
  const sign = totalMicroUsd < 0 ? -1n : 1n;
  const total = BigInt(totalMicroUsd) * sign;
  const parts = entries.map(([key, w]) => ({ key, w, floor: (total * w) / sum, rem: (total * w) % sum }));
  let left = total - parts.reduce((a, p) => a + p.floor, 0n);
  const order = [...parts].sort((a, b) => (a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.w !== b.w ? (a.w > b.w ? -1 : 1) : a.key < b.key ? -1 : 1));
  for (const p of order) {
    if (left === 0n) break;
    if (p.w === 0n) continue;
    p.floor += 1n;
    left -= 1n;
  }
  return { shares: new Map(parts.map((p) => [p.key, Number(p.floor * sign)])), unallocatedMicroUsd: 0 };
}

export interface UserUsage {
  appId: string;
  sub: string;
  householdId: string;
  requests: number;
  /** Events without durationMs (older than the duration fields). */
  requestsWithoutDuration: number;
  durationMs: number;
  /** Charges + adjustments in the month (what the household is billed for usage). */
  meteredMicroUsd: number;
}

/**
 * Per (app, user) duration and metered spend for UTC month "YYYY-MM", from EVENT and ADJUST items
 * (any superset; other months are skipped). Legacy events belong to `legacyAppId`. Adjustments
 * count in their event's month, as everywhere else.
 */
export function usageByUser(items: Record<string, any>[], month: string, legacyAppId: string): UserUsage[] {
  const users = new Map<string, UserUsage>();
  for (const item of items) {
    const sk = skOf(item);
    const isEvent = sk.startsWith(EVENT_PREFIX);
    if (!isEvent && !sk.startsWith(ADJUST_PREFIX)) continue;
    if (ledgerTime(sk).slice(0, 7) !== month) continue;
    const appId = String(item.appId ?? legacyAppId);
    const sub = subOf(item);
    const key = `${appId}#${sub}`;
    const u = users.get(key) ?? users.set(key, {
      appId, sub, householdId: String(item.householdId ?? 'unknown'), requests: 0, requestsWithoutDuration: 0, durationMs: 0, meteredMicroUsd: 0,
    }).get(key)!;
    if (!isEvent) {
      u.meteredMicroUsd += Number(item.deltaMicroUsd ?? 0);
      continue;
    }
    u.requests += 1;
    u.meteredMicroUsd += eventFacts(item, legacyAppId).line.costMicroUsd;
    const ms = Number(item.durationMs);
    if (Number.isSafeInteger(ms) && ms >= 0) u.durationMs += ms;
    else u.requestsWithoutDuration += 1;
  }
  return [...users.values()].sort((a, b) => (a.appId === b.appId ? (a.sub < b.sub ? -1 : 1) : a.appId < b.appId ? -1 : 1));
}

export interface PlatformLine {
  requests: number;
  durationMs: number;
  meteredMicroUsd: number;
  overheadMicroUsd: number;
}

export interface PlatformReport {
  month: string;
  appId: string;
  partial: boolean;
  period: { start: string; end: string };
  costs: PlatformCosts;
  /** Allocated across every app's users; the lines below are this app's. */
  allocatedMicroUsd: number;
  unallocatedMicroUsd: number;
  /** Platform cost allocated to other apps sharing the account. */
  otherAppsMicroUsd: number;
  requestsWithoutDuration: number;
  app: PlatformLine;
  byUser: Record<string, PlatformLine & { householdId: string }>;
  byHousehold: Record<string, PlatformLine>;
}

const emptyLine = (): PlatformLine => ({ requests: 0, durationMs: 0, meteredMicroUsd: 0, overheadMicroUsd: 0 });

const addTo = (acc: PlatformLine, u: UserUsage, overhead: number) => {
  acc.requests += u.requests;
  acc.durationMs += u.durationMs;
  acc.meteredMicroUsd += u.meteredMicroUsd;
  acc.overheadMicroUsd += overhead;
};

/**
 * Allocates the month's platform cost across all (app, user) pairs by duration, so apps sharing
 * the account split it fairly, and reports `appId`'s users and households.
 */
export function platformReport(args: {
  month: string;
  appId: string;
  request: ReturnType<typeof costExplorerRequest>;
  costs: PlatformCosts;
  usage: UserUsage[];
}): PlatformReport {
  const key = (u: UserUsage) => `${u.appId}#${u.sub}`;
  const { shares, unallocatedMicroUsd } = allocate(args.costs.totalMicroUsd, new Map(args.usage.map((u) => [key(u), u.durationMs])));
  const app = emptyLine();
  const byUser: PlatformReport['byUser'] = {};
  const byHousehold: Record<string, PlatformLine> = {};
  let otherApps = 0;
  for (const u of args.usage) {
    const overhead = shares.get(key(u)) ?? 0;
    if (u.appId !== args.appId) {
      otherApps += overhead;
      continue;
    }
    addTo(app, u, overhead);
    addTo((byUser[u.sub] ??= { ...emptyLine(), householdId: u.householdId }), u, overhead);
    addTo((byHousehold[u.householdId] ??= emptyLine()), u, overhead);
  }
  return {
    month: args.month,
    appId: args.appId,
    partial: args.request.partial,
    period: { start: args.request.input.TimePeriod.Start, end: args.request.input.TimePeriod.End },
    costs: args.costs,
    allocatedMicroUsd: args.costs.totalMicroUsd - unallocatedMicroUsd,
    unallocatedMicroUsd,
    otherAppsMicroUsd: otherApps,
    requestsWithoutDuration: args.usage.filter((u) => u.appId === args.appId).reduce((a, u) => a + u.requestsWithoutDuration, 0),
    app,
    byUser,
    byHousehold,
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function formatLine(l: PlatformLine): string {
  return `${String(l.requests).padStart(5)} req  ${seconds(l.durationMs).padStart(9)}  metered ${formatUsd(l.meteredMicroUsd)}  ` +
    `overhead ${formatUsd(l.overheadMicroUsd)}  total ${formatUsd(l.meteredMicroUsd + l.overheadMicroUsd)}`;
}

export function formatPlatformReport(r: PlatformReport): string {
  const rows = (map: Record<string, PlatformLine>, label: (k: string) => string) =>
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, l]) => `  ${label(k).padEnd(44)} ${formatLine(l)}`);
  const services = (map: Record<string, number>) =>
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `  ${k.padEnd(44)} ${formatUsd(v)}`);
  return [
    `Platform costs ${r.month} (UTC), Cost Explorer UNBLENDED [${r.period.start}, ${r.period.end})`,
    'Note: Cost Explorer data lags ~24 h' + (r.partial ? `, and ${r.month} is not over: this is a partial month.` : '.'),
    `\nPlatform services  ${formatUsd(r.costs.totalMicroUsd)}`,
    ...services(r.costs.services),
    ...(Object.keys(r.costs.excluded).length ? ['\nExcluded (not platform)', ...services(r.costs.excluded)] : []),
    `\nAllocated by proxy duration: ${formatUsd(r.allocatedMicroUsd)}` +
      (r.unallocatedMicroUsd ? `, unallocated (no durations) ${formatUsd(r.unallocatedMicroUsd)}` : '') +
      (r.otherAppsMicroUsd ? `, to other apps ${formatUsd(r.otherAppsMicroUsd)}` : ''),
    ...(r.requestsWithoutDuration ? [`${r.requestsWithoutDuration} ${r.appId} events have no durationMs and carry no overhead.`] : []),
    `\n${r.appId}  ${formatLine(r.app)}`,
    ...(Object.keys(r.byHousehold).length ? ['\nBy household', ...rows(r.byHousehold, (k) => k)] : []),
    ...(Object.keys(r.byUser).length ? ['\nBy user', ...rows(r.byUser, (k) => `${k} (${r.byUser[k].householdId})`)] : []),
  ].join('\n');
}

/** platform-costs --month YYYY-MM [--app X] [--json] */
export function parsePlatformCostsArgs(args: string[], defaultAppId: string) {
  const { positional, flags } = parseFlags(args, { values: ['month', 'app'], booleans: ['json'] });
  if (positional.length) throw new Error(`Unexpected argument ${positional[0]}`);
  const month = typeof flags.month === 'string' ? flags.month : '';
  if (!MONTH.test(month)) throw new Error('--month YYYY-MM is required');
  return { month, appId: checkAppId(typeof flags.app === 'string' ? flags.app : defaultAppId), json: flags.json === true };
}
