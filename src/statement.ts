import { formatUsd } from './cost';
import { ADJUST_PREFIX, EVENT_PREFIX, ledgerTime, pkOf, skOf, subOf } from './keys';
import { checkAppId, eventFacts, parseFlags } from './report';

/*
 * Household statements in the family's calendar month (America/Bogota by default), built from the
 * cost ledger: EVENT charges plus ADJUST corrections. Enforcement keeps UTC months; a statement is
 * a reporting view, so a call at 2026-10-01T03:00Z (22:00 on Sept 30 in Bogota) is September's.
 *
 * Adjustments count in the month of the event they correct, not the month they were written: a
 * re-price of a September call fixes September's statement (and its key already sorts there).
 * Pure; the admin CLI reads the items.
 */

export const DEFAULT_TIME_ZONE = 'America/Bogota';

/** Throws on an unknown IANA zone. */
export function checkTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`Unknown time zone "${timeZone}" (IANA name, e.g. America/Bogota)`);
  }
  return timeZone;
}

/** Wall-clock fields of `at` in `timeZone`. */
function zonedFields(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** "YYYY-MM" of `at` on the wall calendar of `timeZone`. */
export function zonedMonth(at: Date, timeZone: string): string {
  const f = zonedFields(at, timeZone);
  return `${f.year}-${String(f.month).padStart(2, '0')}`;
}

/** Zone offset (wall clock minus UTC) at instant `utcMs`, whole seconds. */
function offsetMs(utcMs: number, timeZone: string): number {
  const f = zonedFields(new Date(utcMs), timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant of local midnight starting the 1st of month `m` (1-based, may be 13). */
function zonedMonthStart(year: number, m: number, timeZone: string): Date {
  const wall = Date.UTC(year, m - 1, 1);
  // Two passes settle the offset even when it differs on either side of a DST change.
  const first = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(first, timeZone));
}

/** [from, to) in UTC (ISO ms) covering calendar month "YYYY-MM" in `timeZone`. */
export function monthRangeUtc(month: string, timeZone: string): { from: string; to: string } {
  const [year, m] = month.split('-').map(Number);
  return {
    from: zonedMonthStart(year, m, timeZone).toISOString(),
    to: zonedMonthStart(year, m + 1, timeZone).toISOString(),
  };
}

export interface StatementLine {
  requests: number;
  chargesMicroUsd: number;
  adjustments: number;
  adjustmentsMicroUsd: number;
  totalMicroUsd: number;
}

export interface Statement {
  householdId: string;
  appId: string;
  month: string;
  timeZone: string;
  /** UTC bounds of the month in that zone, [from, to). */
  from: string;
  to: string;
  members: string[];
  total: StatementLine;
  /** By member sub. */
  byUser: Record<string, StatementLine>;
  /** By "<kind> <sku>", e.g. "chat deepseek-v4-flash", "tts gcp-tts-wavenet". */
  byKind: Record<string, StatementLine>;
}

const emptyLine = (): StatementLine => ({ requests: 0, chargesMicroUsd: 0, adjustments: 0, adjustmentsMicroUsd: 0, totalMicroUsd: 0 });

const sorted = (map: Map<string, StatementLine>) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * One household's statement for one app and month. `items` are the members' EVENT and ADJUST items
 * (any superset: other households, apps and months are filtered out here). Legacy events without
 * appId belong to `legacyAppId`.
 */
export function buildStatement(args: {
  householdId: string;
  appId: string;
  month: string;
  timeZone: string;
  legacyAppId: string;
  members: string[];
  items: Record<string, any>[];
}): Statement {
  const total = emptyLine();
  const byUser = new Map<string, StatementLine>(args.members.map((m) => [m, emptyLine()]));
  const byKind = new Map<string, StatementLine>();
  const lineOf = (map: Map<string, StatementLine>, key: string) => map.get(key) ?? map.set(key, emptyLine()).get(key)!;
  const book = (sub: string, kind: string, type: 'charge' | 'adjustment', microUsd: number) => {
    for (const line of [total, lineOf(byUser, sub), lineOf(byKind, kind)]) {
      if (type === 'charge') {
        line.requests += 1;
        line.chargesMicroUsd += microUsd;
      } else {
        line.adjustments += 1;
        line.adjustmentsMicroUsd += microUsd;
      }
      line.totalMicroUsd += microUsd;
    }
  };

  // Adjustments are labelled like the event they correct (its kind may have been inferred).
  const eventKinds = new Map(
    args.items.filter((i) => skOf(i).startsWith(EVENT_PREFIX)).map((i) => [`${pkOf(i)}|${skOf(i)}`, ledgerKind(i)]),
  );

  for (const item of args.items) {
    const sk = skOf(item);
    const isEvent = sk.startsWith(EVENT_PREFIX);
    if (!isEvent && !sk.startsWith(ADJUST_PREFIX)) continue;
    if (String(item.householdId) !== args.householdId) continue;
    if (String(item.appId ?? args.legacyAppId) !== args.appId) continue;
    if (zonedMonth(new Date(ledgerTime(sk)), args.timeZone) !== args.month) continue;
    const sub = subOf(item);
    if (isEvent) {
      const f = eventFacts(item, args.legacyAppId);
      book(sub, `${ledgerKind(item)} ${f.sku}`, 'charge', f.line.costMicroUsd);
    } else {
      const kind = eventKinds.get(`${pkOf(item)}|${item.eventSk}`) ?? ledgerKind(item);
      book(sub, `${kind} ${item.sku ?? 'unknown'}`, 'adjustment', Number(item.deltaMicroUsd ?? 0));
    }
  }

  return {
    householdId: args.householdId,
    appId: args.appId,
    month: args.month,
    timeZone: args.timeZone,
    ...monthRangeUtc(args.month, args.timeZone),
    members: [...args.members].sort(),
    total,
    byUser: sorted(byUser),
    byKind: sorted(byKind),
  };
}

function formatLine(l: StatementLine): string {
  return `${String(l.requests).padStart(5)} req  charges ${formatUsd(l.chargesMicroUsd)}  ` +
    `adjustments ${formatUsd(l.adjustmentsMicroUsd)} (${l.adjustments})  total ${formatUsd(l.totalMicroUsd)}`;
}

export function formatStatement(s: Statement): string {
  const section = (title: string, rows: Record<string, StatementLine>) =>
    Object.keys(rows).length ? [`\n${title}`, ...Object.entries(rows).map(([k, l]) => `  ${k.padEnd(36)} ${formatLine(l)}`)] : [];
  return [
    `Statement ${s.householdId}, ${s.appId}, ${s.month} (${s.timeZone}: ${s.from} .. ${s.to} UTC)`,
    `Members: ${s.members.join(', ') || '(none)'}`,
    `\nTotal  ${formatLine(s.total)}`,
    ...section('By member', s.byUser),
    ...section('By kind and model', s.byKind),
  ].join('\n');
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** statement <householdId> --month YYYY-MM [--app X] [--tz Zone] [--json] */
export function parseStatementArgs(args: string[], defaultAppId: string) {
  const { positional, flags } = parseFlags(args, { values: ['month', 'app', 'tz'], booleans: ['json'] });
  const [householdId] = positional;
  if (positional.length !== 1 || !householdId) throw new Error('Expected <householdId>');
  const month = typeof flags.month === 'string' ? flags.month : '';
  if (!MONTH.test(month)) throw new Error('--month YYYY-MM is required');
  return {
    householdId,
    month,
    appId: checkAppId(typeof flags.app === 'string' ? flags.app : defaultAppId),
    timeZone: checkTimeZone(typeof flags.tz === 'string' ? flags.tz : DEFAULT_TIME_ZONE),
    json: flags.json === true,
  };
}

/**
 * What a ledger item was for. The earliest events predate `kind`: token meters mean a chat call,
 * a character count a TTS call. Old adjustments copied the missing kind as "unknown".
 */
export function ledgerKind(item: Record<string, any>): string {
  if (typeof item.kind === 'string' && item.kind && item.kind !== 'unknown') return item.kind;
  if (item.inputTokens !== undefined || item.cachedInputTokens !== undefined || item.cacheReadTokens !== undefined) return 'chat';
  if (item.chars !== undefined) return 'tts';
  return 'unknown';
}
