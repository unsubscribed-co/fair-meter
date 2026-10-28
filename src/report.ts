import { formatUsd, usdToMicroUsd } from './cost';
import { APP_ID_PATTERN, keys, parseCounterSk, pkOf, skOf, subOf } from './keys';
import { PLANS, SUBSCRIPTION_STATUSES } from './limits';

/*
 * Admin helpers shared by any app's CLI: flag parsing, plan updates and spend reports.
 * Pure functions; the CLI does the DynamoDB reads and writes.
 */

/** `--name value`, `--name=value` and boolean `--name`; everything else is positional. */
export function parseFlags(
  args: string[],
  spec: { values?: string[]; booleans?: string[] },
): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (spec.booleans?.includes(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      flags[name] = true;
    } else if (spec.values?.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      flags[name] = value;
    } else {
      throw new Error(`Unknown flag --${name}`);
    }
  }
  return { positional, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

export function checkAppId(appId: string): string {
  if (!APP_ID_PATTERN.test(appId)) throw new Error(`Invalid --app "${appId}"`);
  return appId;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface HouseholdPlanArgs {
  householdId: string;
  appId: string;
  plan: string;
  monthlyAllowanceMicroUsd?: number;
  /** number = override, 'default' = remove the override, undefined = leave as is. */
  dailyCapMicroUsd?: number | 'default';
  subscriptionStatus?: string;
}

/** household-plan <householdId> <plan> [--app X] [--monthly-usd X] [--daily-usd Y|default] [--status S] */
export function parseHouseholdPlanArgs(args: string[], defaultAppId: string): HouseholdPlanArgs {
  const { positional, flags } = parseFlags(args, { values: ['app', 'monthly-usd', 'daily-usd', 'status'] });
  const [householdId, plan] = positional;
  if (positional.length !== 2 || !householdId || !plan) throw new Error('Expected <householdId> <plan>');
  if (!PLANS.includes(plan as (typeof PLANS)[number])) throw new Error(`Unknown plan "${plan}" (${PLANS.join(', ')})`);
  const status = str(flags.status);
  if (status !== undefined && !SUBSCRIPTION_STATUSES.includes(status as (typeof SUBSCRIPTION_STATUSES)[number])) {
    throw new Error(`Unknown status "${status}" (${SUBSCRIPTION_STATUSES.join(', ')})`);
  }
  const monthly = str(flags['monthly-usd']);
  const daily = str(flags['daily-usd']);
  return {
    householdId,
    appId: checkAppId(str(flags.app) ?? defaultAppId),
    plan,
    ...(monthly !== undefined ? { monthlyAllowanceMicroUsd: usdToMicroUsd(monthly) } : {}),
    ...(daily !== undefined ? { dailyCapMicroUsd: daily === 'default' ? 'default' : usdToMicroUsd(daily) } : {}),
    ...(status !== undefined ? { subscriptionStatus: status } : {}),
  };
}

/** HOUSEHOLD#<id> META for a new household (`household-create`, the admin page's new family); Put it with attribute_not_exists. */
export function householdMetaItem(householdId: string, billingOwnerSub: string, extra: Record<string, unknown> = {}) {
  return { ...keys.householdMeta(householdId), billingOwnerSub, creditBalanceMicroUsd: 0, ...extra };
}

/**
 * UpdateItem input for HOUSEHOLD#<id> PLAN#<app>. Atomic and conditional: the household must
 * exist (checked by the CLI's transaction) and a plan never ends up without a monthly allowance.
 */
export function householdPlanUpdate(table: string, a: HouseholdPlanArgs, now: Date) {
  const set = ['#plan = :plan', 'subscriptionStatus = :status', 'updatedAt = :now'];
  const remove: string[] = [];
  const values: Record<string, unknown> = {
    ':plan': a.plan,
    ':now': now.toISOString(),
  };
  // Status: explicit, else keep the current one, else active.
  if (a.subscriptionStatus) values[':status'] = a.subscriptionStatus;
  else {
    set[1] = 'subscriptionStatus = if_not_exists(subscriptionStatus, :status)';
    values[':status'] = 'active';
  }
  if (a.monthlyAllowanceMicroUsd !== undefined) {
    set.push('monthlyAllowanceMicroUsd = :monthly');
    values[':monthly'] = a.monthlyAllowanceMicroUsd;
  }
  if (a.dailyCapMicroUsd === 'default') remove.push('dailyCapMicroUsd');
  else if (a.dailyCapMicroUsd !== undefined) {
    set.push('dailyCapMicroUsd = :daily');
    values[':daily'] = a.dailyCapMicroUsd;
  }
  return {
    TableName: table,
    Key: keys.householdPlan(a.householdId, a.appId),
    UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
    ...(a.monthlyAllowanceMicroUsd === undefined ? { ConditionExpression: 'attribute_exists(monthlyAllowanceMicroUsd)' } : {}),
    ExpressionAttributeNames: { '#plan': 'plan' }, // "plan" is a DynamoDB reserved word
    ExpressionAttributeValues: values,
  };
}

export interface SpendArgs {
  appId?: string;
  householdId?: string;
  sub?: string;
  month: string;
}

/** spend [--app X] [--household id | --user sub] [--month YYYY-MM] (default: this UTC month, all apps) */
export function parseSpendArgs(args: string[], now: Date): SpendArgs {
  const { positional, flags } = parseFlags(args, { values: ['app', 'household', 'user', 'month'] });
  if (positional.length) throw new Error(`Unexpected argument ${positional[0]}`);
  if (flags.household && flags.user) throw new Error('Use --household or --user, not both');
  const month = str(flags.month) ?? now.toISOString().slice(0, 7);
  if (!MONTH.test(month)) throw new Error(`Invalid --month "${month}" (YYYY-MM)`);
  return {
    month,
    ...(flags.app ? { appId: checkAppId(String(flags.app)) } : {}),
    ...(flags.household ? { householdId: String(flags.household) } : {}),
    ...(flags.user ? { sub: String(flags.user) } : {}),
  };
}

/** global-spend [--app X] [--day YYYY-MM-DD | --month YYYY-MM] (default: this UTC month by day) */
export function parseGlobalSpendArgs(args: string[], now: Date): { appId?: string; prefix: string } {
  const { positional, flags } = parseFlags(args, { values: ['app', 'day', 'month'] });
  if (positional.length) throw new Error(`Unexpected argument ${positional[0]}`);
  if (flags.day && flags.month) throw new Error('Use --day or --month, not both');
  const day = str(flags.day);
  const month = str(flags.month);
  if (day !== undefined && !DAY.test(day)) throw new Error(`Invalid --day "${day}" (YYYY-MM-DD)`);
  if (month !== undefined && !MONTH.test(month)) throw new Error(`Invalid --month "${month}" (YYYY-MM)`);
  return { ...(flags.app ? { appId: checkAppId(String(flags.app)) } : {}), prefix: day ?? month ?? now.toISOString().slice(0, 7) };
}

export interface SpendLine {
  requests: number;
  costMicroUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  ttsChars: number;
}

export interface SpendReport {
  total: SpendLine;
  byApp: Map<string, SpendLine>;
  bySku: Map<string, SpendLine>;
  byBand: Map<string, SpendLine>;
  byDay: Map<string, SpendLine>;
  byUser: Map<string, SpendLine>;
  byPlan: Map<string, SpendLine>;
}

const emptyLine = (): SpendLine => ({
  requests: 0, costMicroUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, ttsChars: 0,
});

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Normalizes an EVENT item, old or new. Legacy events have no appId, sku or canonical meter names. */
export function eventFacts(item: Record<string, any>, legacyAppId: string) {
  const sku = item.sku || String(item.pricingVersion ?? '').split('@')[0] || item.model || item.kind;
  return {
    appId: String(item.appId ?? legacyAppId),
    sub: subOf(item),
    day: skOf(item).slice('EVENT#'.length, 'EVENT#'.length + 10),
    sku: String(sku || 'unknown'),
    band: item.pricingBand ? `${item.pricingBand}${item.pricingTier ? ` ${item.pricingTier}` : ''}` : item.pricingTier ?? 'flat',
    plan: String(item.plan ?? 'prepaid'),
    line: {
      requests: 1,
      costMicroUsd: n(item.costMicroUsd),
      inputTokens: n(item.inputTokens),
      cacheReadTokens: n(item.cacheReadTokens) + n(item.cachedInputTokens),
      cacheWriteTokens: n(item.cacheWriteTokens),
      outputTokens: n(item.outputTokens),
      reasoningTokens: n(item.reasoningTokens),
      ttsChars: n(item.chars),
    } satisfies SpendLine,
  };
}

function accumulate(acc: SpendLine, line: SpendLine) {
  for (const k of Object.keys(acc) as (keyof SpendLine)[]) acc[k] += line[k];
}

function add(map: Map<string, SpendLine>, key: string, line: SpendLine) {
  const acc = map.get(key) ?? emptyLine();
  accumulate(acc, line);
  map.set(key, acc);
}

export function aggregateSpend(items: Record<string, any>[], legacyAppId: string, appId?: string): SpendReport {
  const report: SpendReport = {
    total: emptyLine(), byApp: new Map(), bySku: new Map(), byBand: new Map(), byDay: new Map(), byUser: new Map(), byPlan: new Map(),
  };
  for (const item of items) {
    const f = eventFacts(item, legacyAppId);
    if (appId && f.appId !== appId) continue;
    accumulate(report.total, f.line);
    add(report.byApp, f.appId, f.line);
    add(report.bySku, `${f.appId} ${f.sku}`, f.line);
    add(report.byBand, `${f.appId} ${f.sku} ${f.band}`, f.line);
    add(report.byDay, f.day, f.line);
    add(report.byUser, f.sub, f.line);
    add(report.byPlan, `${f.appId} ${f.plan}`, f.line);
  }
  return report;
}

function formatLine(l: SpendLine): string {
  const parts = [`${formatUsd(l.costMicroUsd)}`, `${l.requests} req`];
  const tokens = l.inputTokens + l.cacheReadTokens + l.cacheWriteTokens + l.outputTokens + l.reasoningTokens;
  if (tokens) {
    parts.push(`in ${l.inputTokens} / cache-read ${l.cacheReadTokens} / cache-write ${l.cacheWriteTokens} / out ${l.outputTokens} / reasoning ${l.reasoningTokens}`);
  }
  if (l.ttsChars) parts.push(`tts ${l.ttsChars} chars`);
  return parts.join('  ');
}

export function formatSpendReport(r: SpendReport): string {
  const section = (title: string, map: Map<string, SpendLine>) =>
    map.size ? [`\n${title}`, ...[...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, l]) => `  ${k.padEnd(40)} ${formatLine(l)}`)] : [];
  return [
    `Total  ${formatLine(r.total)}`,
    ...section('By app', r.byApp),
    ...section('By plan (app plan)', r.byPlan),
    ...section('By SKU (app sku)', r.bySku),
    ...section('By band (app sku band)', r.byBand),
    ...section('By day (UTC)', r.byDay),
    ...section('By user', r.byUser),
  ].join('\n');
}

/** Rows for global-spend from APP#<app> and GLOBAL DAILY# counter items. */
export function globalSpendRows(
  items: Record<string, any>[],
  caps: { appDailyCapMicroUsd?: Record<string, number>; allAppsDailyCapMicroUsd?: number },
): string[] {
  return items
    .map((item) => {
      const pk = pkOf(item);
      const scope = pk === 'GLOBAL' ? 'all apps' : pk.replace(/^APP#/, '');
      const day = parseCounterSk(skOf(item), '')?.period ?? skOf(item);
      const cap = pk === 'GLOBAL' ? caps.allAppsDailyCapMicroUsd : caps.appDailyCapMicroUsd?.[scope];
      const pct = cap ? `  ${((n(item.costMicroUsd) * 100) / cap).toFixed(1)}% of ${formatUsd(cap)}` : '';
      return { day, scope, text: `${day}  ${scope.padEnd(10)} ${formatUsd(n(item.costMicroUsd))}  ${n(item.requests)} req${pct}` };
    })
    .sort((a, b) => (a.day === b.day ? (a.scope < b.scope ? -1 : 1) : a.day < b.day ? -1 : 1))
    .map((r) => r.text);
}
