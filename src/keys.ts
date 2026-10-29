/**
 * Single-table keys for metering. Everything billing-related carries an appId so several AI apps
 * can share one table, one price list and one household/payer model.
 *
 *   USER#<sub>        PROFILE                         householdId, role         (shared by all apps)
 *   HOUSEHOLD#<id>    META                            billingOwnerSub, creditBalanceMicroUsd
 *   HOUSEHOLD#<id>    MEMBER#<sub>                    role
 *   HOUSEHOLD#<id>    PLAN#<app>                      plan, subscriptionStatus, monthlyAllowanceMicroUsd, dailyCapMicroUsd?
 *   HOUSEHOLD#<id>    USAGE#<app>#<YYYY-MM>           counters (monthly allowance); optional one-way marks an app sets
 *                                                     once a month (UsageRecord.householdMonthMarks, e.g. Nieto's premiumEndedAt)
 *   USER#<sub>        USAGE#<app>#<YYYY-MM>           counters
 *   USER#<sub>        DAILY#<app>#<YYYY-MM-DD>        counters (per-user daily cap); committedMicroUsd (FairMeter:
 *                                                     settled cost plus open holds, the attribute the cap condition reads)
 *   USER#<sub>        RATE#<app>#<YYYY-MM-DDTHH:MM>   calls this UTC minute (per-minute brake); expiresAt (TTL)
 *   USER#<sub>        EVENT#<iso-ms>#<app>#<requestId> one item per call (appId attribute too)
 *   USER#<sub>        ADJUST#<iso-ms>#<app>#<adjId>   one correction of one event (iso-ms = the EVENT's time)
 *   APP#<app>         DAILY#<YYYY-MM-DD>              counters (per-app circuit breaker)
 *   GLOBAL            DAILY#<YYYY-MM-DD>              counters (all-apps ceiling)
 *   PENDING#<app>     CALL#<callId>                   FairMeter: one open reservation per provider attempt, deleted
 *                                                     when it is settled (EVENT put in the same transaction) or released
 *   REDRIVE#<app>     CALL#<callId>                   redrives: times the nightly redrive put this call's record back
 *                                                     on the retry queue (at most 3); expiresAt (TTL, 30 days)
 *   ROLLUP#<app>      CURSOR                          the action rollup: lastWindowStart, the last 15-minute window settled
 *   PRICING#<sku>     <validFrom>                     price versions, shared by all apps
 *   PLANDEF#<app>#<plan> <validFrom>                  plan definition versions (what a plan includes per budget mode),
 *                                                     immutable like prices: validFrom, validTo, grid (the app's own shape)
 *   PROVIDER#<prov>   DAILY#<YYYY-MM-DD>              requests, meters, baseCostMicroUsd per provider (all apps)
 *   PROVIDER#<prov>   BALANCE#<iso-ms>                provider account balance snapshot (reconcile.ts)
 *   PROVIDER#<prov>   MONTH#<YYYY-MM>                 account-wide monthly counters against a provider's free tier
 *                                                     (all apps; e.g. gcp-tts premiumChars, free-tier.ts), string sets
 *                                                     (e.g. voiceHouseholds) and a share count copied from last month's set
 *
 * EVENT and ADJUST items are the cost ledger: events are charges and never change; an adjustment
 * corrects one event (e.g. a re-price) by a signed delta. Both are immutable once written.
 *
 * Legacy items written before appId existed (USER USAGE#<YYYY-MM>, DAILY#<YYYY-MM-DD>, events
 * EVENT#<iso-ms>#<requestId> without appId) belong to the app named by the caller's `legacyAppId` (Nieto: "nieto"). They are
 * read by reports as history; enforcement only reads the per-app keys.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function assertAppId(appId: string): string {
  if (!APP_ID_PATTERN.test(appId)) throw new Error(`Invalid appId "${appId}" (lowercase letters, digits, dashes)`);
  return appId;
}

export const GLOBAL_PK = 'GLOBAL';

/**
 * How the table names its key attributes and the user partition. Defaults are Nieto's (`PK`, `SK`,
 * `USER#<sub>`). Another table sets it once at startup (`setTableKeys`) or, for the module's own
 * Lambdas (retry, export, reconcile, free tier), through `METERING_TABLE_KEYS` (JSON), which the
 * cdk.ts constructs set from their `tableKeys` prop. Read at call time, so a test can switch it.
 */
export interface TableKeys {
  pk: string;
  sk: string;
  /** User partition = userPrefix + sub (the sub as the app passes it, e.g. an already lowercased email). */
  userPrefix: string;
}
export const DEFAULT_TABLE_KEYS: TableKeys = { pk: 'PK', sk: 'SK', userPrefix: 'USER#' };
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
let tableKeysSetting: TableKeys | undefined;

/** Overrides the defaults (and the env); `undefined` goes back to them. */
export function setTableKeys(settings?: Partial<TableKeys>): void {
  const k = settings && { ...DEFAULT_TABLE_KEYS, ...settings };
  // Interpolated into key expressions, so plain attribute names only.
  if (k && !(ATTRIBUTE_NAME.test(k.pk) && ATTRIBUTE_NAME.test(k.sk) && k.pk !== k.sk && k.userPrefix)) {
    throw new Error(`Invalid table keys ${JSON.stringify(settings)}`);
  }
  tableKeysSetting = k;
}

export function tableKeys(): TableKeys {
  if (!tableKeysSetting) setTableKeys(process.env.METERING_TABLE_KEYS ? JSON.parse(process.env.METERING_TABLE_KEYS) : {});
  return tableKeysSetting!;
}

/** A table key (e.g. `{ PK: 'USER#u1', SK: 'PROFILE' }` with the defaults). */
export type TableKey = Record<string, string>;
const key = (pk: string, sk: string): TableKey => {
  const t = tableKeys();
  return { [t.pk]: pk, [t.sk]: sk };
};
export const userPk = (sub: string) => `${tableKeys().userPrefix}${sub}`;
/** An item's partition and sort key values ('' when absent). */
export const pkOf = (item: Record<string, any>) => String(item[tableKeys().pk] ?? '');
export const skOf = (item: Record<string, any>) => String(item[tableKeys().sk] ?? '');
/** The sub of a user-partition item (the partition value as is when it is not one). */
export function subOf(item: Record<string, any>): string {
  const pk = pkOf(item);
  const { userPrefix } = tableKeys();
  return pk.startsWith(userPrefix) ? pk.slice(userPrefix.length) : pk;
}
/** Conditions on the table's partition key: `attribute_exists(PK)` / `attribute_not_exists(PK)` by default. */
export const pkExists = () => `attribute_exists(${tableKeys().pk})`;
export const pkNotExists = () => `attribute_not_exists(${tableKeys().pk})`;
/** A single write refused by its ConditionExpression (not a transaction's cancellation). */
export const conditionFailed = (err: unknown) => (err as { name?: string } | undefined)?.name === 'ConditionalCheckFailedException';

export const keys = {
  profile: (sub: string) => key(userPk(sub), 'PROFILE'),
  householdMeta: (householdId: string) => key(`HOUSEHOLD#${householdId}`, 'META'),
  householdPlan: (householdId: string, appId: string) => key(`HOUSEHOLD#${householdId}`, `PLAN#${appId}`),
  householdMonth: (householdId: string, appId: string, month: string) => key(`HOUSEHOLD#${householdId}`, `USAGE#${appId}#${month}`),
  userMonth: (sub: string, appId: string, month: string) => key(userPk(sub), `USAGE#${appId}#${month}`),
  userDay: (sub: string, appId: string, day: string) => key(userPk(sub), `DAILY#${appId}#${day}`),
  /** Calls this UTC minute ("2026-10-06T14:05"), any metered kind: the per-minute brake. */
  userRate: (sub: string, appId: string, minute: string) => key(userPk(sub), `RATE#${appId}#${minute}`),
  appDay: (appId: string, day: string) => key(`APP#${appId}`, `DAILY#${day}`),
  globalDay: (day: string) => key(GLOBAL_PK, `DAILY#${day}`),
  event: (sub: string, requestTime: string, appId: string, requestId: string) =>
    key(userPk(sub), `EVENT#${requestTime}#${appId}#${requestId}`),
  /**
   * Keyed by the corrected event's time, not the adjustment's: the key is then deterministic (a
   * re-applied correction hits the same key and is refused) and sorts next to the month it corrects.
   */
  adjustment: (sub: string, eventTime: string, appId: string, adjustmentId: string) =>
    key(userPk(sub), `ADJUST#${eventTime}#${appId}#${adjustmentId}`),
  /** Our base cost (before markup) per provider and UTC day, for reconciling against its balance. */
  providerDay: (provider: string, day: string) => key(`PROVIDER#${provider}`, `DAILY#${day}`),
  /**
   * Account-wide counters per provider and UTC month for a provider's monthly free tier (e.g. Google's
   * free Chirp 3 HD characters), written in the usage transaction (UsageRecord.providerMonth).
   */
  providerMonth: (provider: string, month: string) => key(`PROVIDER#${provider}`, `MONTH#${month}`),
  /** One open FairMeter reservation; the sweeper reads the app's whole partition. */
  pending: (appId: string, callId: string) => key(`PENDING#${appId}`, `CALL#${callId}`),
  /** How many times the nightly redrive has put this call's record back on the retry queue. */
  redrive: (appId: string, callId: string) => key(`REDRIVE#${appId}`, `CALL#${callId}`),
  /** The action rollup's cursor: the last window whose every record was written. */
  rollupCursor: (appId: string) => key(`ROLLUP#${appId}`, 'CURSOR'),
  /**
   * One immutable version of a plan's definition for one app, valid in [validFrom, validTo) like a
   * price version (validFrom = SK, canonical UTC to the second). Version id: `<plan>@<SK>`.
   */
  planDef: (appId: string, plan: string, validFrom: string) => key(planDefPk(appId, plan), validFrom),
  /** Immutable snapshot of the provider account's balance at `takenAt` (ISO, ms). */
  providerBalance: (provider: string, takenAt: string) => key(`PROVIDER#${provider}`, `BALANCE#${takenAt}`),
  /** Pre-appId user counters (history only); legacy events' charges live here. */
  legacyUserMonth: (sub: string, month: string) => key(userPk(sub), `USAGE#${month}`),
  legacyUserDay: (sub: string, day: string) => key(userPk(sub), `DAILY#${day}`),
};

export const planDefPk = (appId: string, plan: string) => `PLANDEF#${appId}#${plan}`;

export const EVENT_PREFIX = 'EVENT#';
export const ADJUST_PREFIX = 'ADJUST#';
export const BALANCE_PREFIX = 'BALANCE#';

/** "2026-09-30T14:00:00.000Z" from an EVENT# or ADJUST# sort key (both start with the event's time). */
export function ledgerTime(sk: string): string {
  return sk.slice(sk.indexOf('#') + 1).split('#')[0];
}

/**
 * Splits a counter SK ("USAGE#nieto#2026-10", or legacy "USAGE#2026-10") into app and period.
 * Legacy keys have no app part and are attributed to `legacyAppId`.
 */
export function parseCounterSk(sk: string, legacyAppId: string): { kind: string; appId: string; period: string } | undefined {
  const parts = sk.split('#');
  if (parts.length === 2) return { kind: parts[0], appId: legacyAppId, period: parts[1] };
  if (parts.length === 3) return { kind: parts[0], appId: parts[1], period: parts[2] };
  return undefined;
}

export const utcDay = (at: Date) => at.toISOString().slice(0, 10);
export const utcMonth = (at: Date) => at.toISOString().slice(0, 7);
export const utcMinute = (at: Date) => at.toISOString().slice(0, 16);
/** Retry-After for a per-minute limit: whole seconds until the next UTC minute, at least 1. */
export const secondsToNextUtcMinute = (at: Date) => Math.max(1, Math.ceil((Math.floor(at.getTime() / 60_000) * 60_000 + 60_000 - at.getTime()) / 1000));
export const nextUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
export const nextUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
