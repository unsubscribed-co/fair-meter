import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { pastFloor } from './actions';
import { assertTierThresholds, dayTier, type BudgetTier, type TierThresholds } from './budget';
import type { Meters } from './cost';
import { assertAppId, keys, nextUtcDay, nextUtcMonth, pkNotExists, secondsToNextUtcMinute, setTableKeys, skOf, tableKeys, utcDay, utcMinute, utcMonth, type TableKeys } from './keys';
import { absorbedOf, recordUsage, type UsageRecord } from './ledger';
import { takeCapacity } from './measure';
import { Meter } from './meter';
import { feeAt, type FeeFile } from './prices';
import { priceCall, priceShape, reserveCost, versionStartedBy, versionCovers, type CallUsage, type PriceShape } from './pricing';
import { canonicalMeters, isProvider, metersFromUsage, type Provider } from './usage';
import { feeOf, PASS_TTL_SECONDS, TOP_UP_URL, walletKeys } from './wallet';

/*
 * The money path for apps: `authorize` reserves an attempt's highest possible cost against the
 * person's daily cap before the provider is called, `record` settles it exactly once after.
 * Both write the same table and ledger as the old Meter path; see keys.ts and ledger.ts.
 */

/**
 * The one config. The `Metering` construct writes it as JSON into the function's FAIR_METER env var,
 * so `new FairMeter()` needs no arguments; tests pass it directly.
 */
export interface FairMeterConfig {
  /** Which app ("stacksplit"). Prefixes every counter, event and pending row: several apps can share a table. */
  appId: string;
  /** Which deployment ("prod" | "dev"). Written on every EVENT and export row. */
  env: string;
  tableName: string;
  /** MeteringRetry's queue. A settle that can't be written inline waits there, so it is never lost. */
  retryQueueUrl: string;
  /** Hard cap per person per UTC day, in micro-USD. Reserved atomically: parallel calls can't overshoot it. */
  dailyCapMicroUsd: number;
  /** Soft breaker for everyone in this app per UTC day (read before the call, not reserved). */
  appDailyCapMicroUsd: number;
  /** Optional soft breaker for every app in the table. */
  allAppsDailyCapMicroUsd?: number;
  /** Optional per-person brake against loops (calls per UTC minute). */
  maxCallsPerMinute?: number;
  /** Budget tier thresholds; default 75/90. */
  tiers?: TierThresholds;
  /**
   * 'none' (default): nobody is charged. Hosted: every charge, plus the fee, moves the person's wallet
   * in the same transaction as the ledger. `fee` is prices/fee.json (Metering writes it at synth; read from the file when absent).
   */
  billing?: 'none' | { walletTable: string; fee?: FeeFile };
  /** The table's key names when they aren't PK/SK (StackSplit: pk/sk). */
  tableKeys?: Partial<TableKeys>;
  /** The app's action SKUs and the limits the floor is computed from (Metering's `actions`). Absent: no actions. */
  actions?: Actions;
  /** The floor, computed at synth (micro-USD): the room under the daily cap that AI holds can't use. Required with `actions`. */
  actionFloorMicroUsd?: number;
}

/** An app's actions: its action SKUs and the limits the floor is computed from. */
export interface Actions {
  skus: string[];
  /** Per person, per function instance, per UTC minute. */
  perPersonPerMinute: number;
  /** The most instances of the granted functions that can run at once. */
  maxConcurrency: number;
}

export type Max = { inputTokens: number; outputTokens: number } | { chars: number } | { units: number } | { requests: number };

export interface CallRequest {
  /** Whose call: the person's stable id in this app (StackSplit: the lowercased email). Key: USER#<person>. */
  person: string;
  /** The billing SKU (PRICING#<sku>). Its price version decides the provider and the unit. */
  sku: string;
  /**
   * The most this attempt can use. Tokens: inputTokens = the UTF-8 bytes of everything sent (always
   * >= tokens), outputTokens = the max_tokens sent. Chars, units or requests for the other prices.
   */
  max: Max;
  /** Who paid the provider: 'paid' (default: a key billed to a card) or 'credit'. */
  paidBy?: 'credit' | 'paid';
}

/** Everything `record` and the sweeper need, read once at authorize. Plain JSON. */
export interface Hold {
  person: string;
  /** The meter's clock at authorize (ISO ms): the price version, band, day and month all come from it. */
  at: string;
  sku: string;
  provider?: string;
  pricingVersion: string;
  /** The price version as read at authorize: nothing is read between the provider's answer and the settle. */
  price: Record<string, unknown>;
  max: Max;
  reservedMicroUsd: number;
  paidBy: 'credit' | 'paid';
  /** Hosted: the wallet account charged, found at authorize; settle, release and sweep use it, never a fresh lookup. */
  account?: string;
  /** Hosted: the fee version's basis points at authorize. */
  feeBps?: number;
}

export interface Reservation {
  ok: true;
  /** The person's day after this hold: normal | saving | essential | limit. */
  tier: BudgetTier;
  /** Minted here, one per attempt; the EVENT's requestId. */
  callId: string;
  readonly hold: Hold;
}

export type RefusalCode = 'daily_limit_reached' | 'too_many_requests' | 'service_paused' | 'pricing_not_configured' | 'metering_unavailable'
  | 'balance_too_low' | 'account_not_linked' | 'link_conflict';

export interface Refusal {
  ok: false;
  status: 402 | 403 | 429 | 500 | 503;
  /** topUpUrl: on balance_too_low, where the person tops up. */
  body: { error: RefusalCode; resetsAt?: string; retryAfterSeconds?: number; topUpUrl?: string };
  /** Retry-After on too_many_requests; otherwise {}. */
  headers: Record<string, string>;
  /** Known once the counters were read. */
  tier?: BudgetTier;
}

/** A person's spend for the app to show them: integer micro-USD and ISO times (UTC). */
export interface PersonUsage {
  day: { spentMicroUsd: number; heldMicroUsd: number; capMicroUsd: number; roomMicroUsd: number; resetsAt: string };
  month: { spentMicroUsd: number; resetsAt: string };
  tier: BudgetTier;
  /** Actions configured and committed above cap - floor: canWrite refuses until the room comes back. */
  readOnly: boolean;
  /** Hosted, for a linked person: what their wallet may still spend (0 without a BALANCE row). */
  wallet?: { availableMicroUsd: number };
}

/**
 * A `resetsAt` for the person to read: the local clock time and how far away it is, in their
 * language (from the platform's Intl). The sentence around them stays in the app's own strings.
 */
export function resetsAtLocal(resetsAt: string, opts: { locale: string; timeZone: string; now?: Date }): { time: string; relative: string } {
  const at = new Date(resetsAt);
  const minutes = (at.getTime() - (opts.now ?? new Date()).getTime()) / 60_000;
  const [n, unit] = minutes < 60 ? [minutes, 'minute' as const] : minutes < 24 * 60 ? [minutes / 60, 'hour' as const] : [minutes / (24 * 60), 'day' as const];
  return {
    time: new Intl.DateTimeFormat(opts.locale, { timeZone: opts.timeZone, hour: 'numeric', minute: '2-digit' }).format(at),
    relative: new Intl.RelativeTimeFormat(opts.locale, { numeric: 'auto' }).format(Math.round(n), unit),
  };
}

/** The public methods of FairMeter: inject this type to swap in `FakeFairMeter` (fair-meter/testing) in tests. */
export type FairMeterApi = Pick<FairMeter, 'authorize' | 'record' | 'usage' | 'canWrite' | 'action' | 'link' | 'walletPass'>;

/** `link`'s answer: the person now pays from that account, or their link points to another one (nothing written). */
export type LinkOutcome = 'linked' | 'conflict';

export type RecordOutcome = 'recorded' | 'duplicate' | 'trued_up' | 'conflict' | 'deferred' | 'failed';

/** What the app saw of the attempt: the provider's usage block, an estimate, or one of the three words. */
export type AttemptUsage = object | undefined | 'unknown' | 'not_billed' | 'not_sent';

const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function readConfig(config?: FairMeterConfig): FairMeterConfig {
  if (!config) {
    if (!process.env.FAIR_METER) throw new Error('FairMeter: no config and no FAIR_METER env (the Metering construct sets it)');
    config = JSON.parse(process.env.FAIR_METER) as FairMeterConfig;
  }
  const c = config;
  assertAppId(c.appId);
  const billing = c.billing;
  if (typeof billing === 'object' && billing !== null) {
    if (!(typeof billing.walletTable === 'string' && billing.walletTable)) throw new Error('FairMeter: billing.walletTable must be the wallet table name');
  } else if (billing !== undefined && billing !== 'none') throw new Error(`FairMeter: unknown billing ${JSON.stringify(c.billing)} (hosted is { walletTable })`);
  if (!c.env || !c.tableName || !c.retryQueueUrl) throw new Error('FairMeter: env, tableName and retryQueueUrl are required');
  for (const [name, v] of Object.entries({ dailyCapMicroUsd: c.dailyCapMicroUsd, appDailyCapMicroUsd: c.appDailyCapMicroUsd })) {
    if (!positive(v)) throw new Error(`FairMeter: ${name} must be a positive integer (micro-USD)`);
  }
  if (c.allAppsDailyCapMicroUsd !== undefined && !positive(c.allAppsDailyCapMicroUsd)) throw new Error('FairMeter: allAppsDailyCapMicroUsd must be a positive integer');
  if (c.maxCallsPerMinute !== undefined && !positive(c.maxCallsPerMinute)) throw new Error('FairMeter: maxCallsPerMinute must be a positive integer');
  if (c.tiers) assertTierThresholds(c.tiers);
  if (c.tableKeys) setTableKeys(c.tableKeys);
  if (c.actions) {
    const a = c.actions;
    if (!Array.isArray(a.skus) || !a.skus.length || !a.skus.every((s) => typeof s === 'string' && s)) throw new Error('FairMeter: actions.skus must be a non-empty list of SKUs');
    if (!positive(a.perPersonPerMinute) || !positive(a.maxConcurrency)) throw new Error('FairMeter: actions.perPersonPerMinute and actions.maxConcurrency must be positive integers');
    const floor = c.actionFloorMicroUsd;
    if (!(Number.isSafeInteger(floor) && floor! >= 0 && floor! < c.dailyCapMicroUsd)) throw new Error('FairMeter: actionFloorMicroUsd must be an integer from 0 to below dailyCapMicroUsd');
  }
  return c;
}

export class FairMeter {
  private readonly cfg: FairMeterConfig;
  private readonly ddb: DynamoDBDocumentClient;
  private readonly sqs: SQSClient;
  private readonly now: () => Date;
  /** The old path's brake, reused as it is. */
  private readonly meter: Meter;
  /** Each SKU's versions as last read, oldest first. Sync starts a version at least 10 minutes ahead, so 5 minutes old is safe. */
  private readonly prices = new Map<string, { readAt: number; versions: Record<string, any>[] }>();
  /** Actions per person in the current UTC minute, this instance only; a new minute starts an empty map. */
  private actionCounts = { minute: '', perPerson: new Map<string, number>() };
  /** Hosted: each person's last `link` on this instance: the account that pays, or none (a link conflict). */
  private readonly links = new Map<string, { sub: string; account?: string }>();

  /** Reads FAIR_METER when `config` is omitted. Throws on a bad config (startup, never after a paid call). */
  constructor(config?: FairMeterConfig, clients: { ddb?: DynamoDBDocumentClient; sqs?: SQSClient; now?: () => Date } = {}) {
    this.cfg = readConfig(config);
    this.ddb = clients.ddb ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.sqs = clients.sqs ?? new SQSClient({});
    this.now = clients.now ?? (() => new Date());
    this.meter = new Meter(
      {
        tableName: this.cfg.tableName,
        appId: this.cfg.appId,
        markupBps: 0,
        skuAliases: {},
        retryQueueUrl: this.cfg.retryQueueUrl,
        limits: { billing: 'none', maxCallsPerMinute: this.cfg.maxCallsPerMinute, defaultDailyCapMicroUsd: this.cfg.dailyCapMicroUsd, appDailyCapMicroUsd: this.cfg.appDailyCapMicroUsd },
      },
      { ddb: this.ddb, sqs: this.sqs },
    );
  }

  /**
   * Before each paid provider attempt (every retry, hedge and fallback is its own attempt): finds
   * the SKU's price, checks the breakers and the brake, and reserves the most this attempt can cost
   * against the person's daily cap, atomically. Never throws: a refusal is a ready HTTP answer.
   */
  async authorize(req: CallRequest): Promise<Reservation | Refusal> {
    const started = Date.now();
    const timing: Timing = { readsMs: 0, attempts: 0 };
    const result = await this.authorizeTimed(req, timing);
    console.log('AUTHORIZE_TIMING', {
      appId: this.cfg.appId,
      sku: req?.sku,
      outcome: result.ok ? 'ok' : result.body.error,
      readsMs: timing.readsMs,
      reserveMs: timing.reserving === undefined ? 0 : Date.now() - timing.reserving,
      totalMs: Date.now() - started,
      attempts: timing.attempts,
    });
    return result;
  }

  private async authorizeTimed(req: CallRequest, timing: Timing): Promise<Reservation | Refusal> {
    const bad = badRequest(req);
    if (bad) {
      // An app bug (TypeScript callers can't get here): refused and alarmed, never thrown.
      console.error('METER_UNAVAILABLE', { appId: this.cfg.appId, reason: bad, req });
      return refuse(500, 'metering_unavailable');
    }
    try {
      return await this.reserve(req, timing);
    } catch (err) {
      console.error('METER_UNAVAILABLE', { appId: this.cfg.appId, person: req.person, sku: req.sku, err });
      return refuse(503, 'metering_unavailable');
    }
  }

  private async reserve(req: CallRequest, timing: Timing): Promise<Reservation | Refusal> {
    const { appId, tableName: table } = this.cfg;
    const at = this.now();
    const day = utcDay(at);
    const log = { appId, person: req.person, sku: req.sku };
    const charge = this.walletCharge(req.person, at);
    if (charge && 'ok' in charge) return charge;
    let read;
    const reading = Date.now();
    try {
      read = await Promise.all([
        this.priceAt(req.sku, at),
        this.get(keys.userDay(req.person, appId, day)),
        this.get(keys.appDay(appId, day)),
        this.cfg.allAppsDailyCapMicroUsd === undefined ? undefined : this.get(keys.globalDay(day)),
        this.meter.brake(req.person, at),
      ]);
    } catch (err) {
      console.error('METER_UNAVAILABLE', { ...log, err });
      return refuse(503, 'metering_unavailable');
    } finally {
      timing.readsMs = Date.now() - reading;
    }
    const [found, userDay, appDay, allAppsDay, retryAfterSeconds] = read;
    const price = found?.item;
    const shape = price && priceShape(price);
    if (!found || !shape || (shape === 'tokens' && !isProvider(price.provider))) {
      console.error('PRICE_MISSING', { ...log, version: found?.version, at: at.toISOString() });
      return refuse(503, 'pricing_not_configured');
    }

    const committed = Number(userDay?.committedMicroUsd ?? 0);
    const cap = this.cfg.dailyCapMicroUsd;
    const tierAt = (used: number) => dayTier(used, cap, this.cfg.tiers);
    const tier = tierAt(committed);
    const appSpent = Number(appDay?.costMicroUsd ?? 0);
    const allSpent = Number(allAppsDay?.costMicroUsd ?? 0);
    const paused = this.cfg.allAppsDailyCapMicroUsd !== undefined && allSpent >= this.cfg.allAppsDailyCapMicroUsd ? 'all_apps_daily_cap'
      : appSpent >= this.cfg.appDailyCapMicroUsd ? 'app_daily_cap' : undefined;
    if (paused) {
      // Alarmed; calls resume on their own at 00:00 UTC.
      console.error('SERVICE_PAUSED', { ...log, reason: paused, appSpent, allSpent });
      return refuse(503, 'service_paused', { resetsAt: nextUtcDay(at) }, tier);
    }
    const reserved = reserveCost(price, req.max, at);
    if (reserved === undefined) {
      console.error('METER_UNAVAILABLE', { ...log, reason: `max ${JSON.stringify(req.max)} does not fit the ${shape} price` });
      return refuse(503, 'metering_unavailable');
    }
    // AI holds stop at cap - floor: the floor stays free for actions the rollup hasn't counted yet.
    const limit = cap - this.floor;
    if (reserved > limit) {
      console.error('CALL_EXCEEDS_CAP', { ...log, reservedMicroUsd: reserved, dailyCapMicroUsd: cap, ...(this.floor ? { actionFloorMicroUsd: this.floor } : {}) });
      return refuse(429, 'daily_limit_reached', { resetsAt: nextUtcDay(at) }, tier);
    }
    if (pastFloor(committed + reserved, cap, this.floor)) return this.limitReached(log, at, tier);
    if (retryAfterSeconds !== undefined) {
      console.warn('RATE_LIMITED', { ...log, maxCallsPerMinute: this.cfg.maxCallsPerMinute });
      return { ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds }, headers: { 'Retry-After': String(retryAfterSeconds) }, tier };
    }

    const callId = randomUUID();
    const hold: Hold = {
      person: req.person,
      at: at.toISOString(),
      sku: req.sku,
      ...(typeof price.provider === 'string' ? { provider: price.provider } : {}),
      pricingVersion: found.version,
      price,
      max: req.max,
      reservedMicroUsd: reserved,
      paidBy: req.paidBy ?? 'paid',
      ...(charge ? { account: charge.account, feeBps: charge.feeBps } : {}),
    };
    const { price: _, ...pending } = hold;
    // Hosted: the hold plus its fee leaves available, which must still cover the app's floor (with its fee).
    const walletHold = charge && reserved + feeOf(reserved, charge.feeBps);
    const reserve = new TransactWriteCommand({
      ClientRequestToken: createHash('sha256').update(`${appId}#hold#${callId}`).digest('hex').slice(0, 32),
      TransactItems: [
        { Put: { TableName: table, Item: { ...keys.pending(appId, callId), ...pending, env: this.cfg.env }, ConditionExpression: pkNotExists() } },
        {
          Update: {
            TableName: table,
            Key: keys.userDay(req.person, appId, day),
            UpdateExpression: 'ADD committedMicroUsd :reserved',
            // Conditions can't add, so the room left for this hold is computed here.
            ConditionExpression: 'attribute_not_exists(committedMicroUsd) OR committedMicroUsd <= :room',
            ExpressionAttributeValues: { ':reserved': reserved, ':room': limit - reserved },
          },
        },
        ...(charge ? [{
          Update: {
            TableName: charge.table,
            Key: walletKeys.balance(charge.account),
            UpdateExpression: 'ADD availableMicroUsd :out, heldMicroUsd :held',
            ConditionExpression: 'availableMicroUsd >= :needed',
            ExpressionAttributeValues: { ':out': -walletHold!, ':held': walletHold!, ':needed': walletHold! + charge.floor },
          },
        }] : []),
      ],
    });
    timing.reserving = Date.now();
    for (let attempt = 0; ; attempt++) {
      timing.attempts = attempt + 1;
      try {
        await this.ddb.send(reserve);
        return { ok: true, tier: tierAt(committed + reserved), callId, hold };
      } catch (err) {
        const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          console.error('CALL_ID_REUSED', { ...log, callId });
          return refuse(500, 'metering_unavailable');
        }
        if (reasons[1]?.Code === 'ConditionalCheckFailed') return this.limitReached(log, at, tier);
        if (reasons[2]?.Code === 'ConditionalCheckFailed') return this.balanceTooLow(log, charge!, tier);
        // A cancellation is definite: nothing was written. Anything else (a timeout, a 5xx, a
        // transaction still in progress) may have committed or may still commit.
        const ambiguous = !reasons.length;
        // Parallel holds on one day counter conflict, and the condition then decides; an ambiguous
        // failure is resolved by the identical resend: same token, so a no-op if it committed.
        if (attempt < 2 && (ambiguous || reasons.some((r) => r.Code === 'TransactionConflict'))) {
          await jitter();
          continue;
        }
        console.error('METER_UNAVAILABLE', { ...log, callId, err });
        if (ambiguous) await this.giveBack({ ok: true, tier, callId, hold });
        return refuse(503, 'metering_unavailable');
      }
    }
  }

  /**
   * After the attempt, whatever happened. Settles the reservation exactly once and never throws:
   * a failed write goes to the retry queue, and if even that fails the PENDING row is still there
   * for the sweeper.
   *
   * usage:
   *  - the provider's own usage block (read by the adapter of the price's provider), or
   *    { chars } | { units } | { requests } for other prices;
   *  - { estimate: <the same shape, or canonical meters { inputTokens, outputTokens, cacheReadTokens?,
   *    cacheWriteTokens?, reasoningTokens? }> }: the app's guess for an attempt it aborted (a hedge
   *    loser), settled at that cost, estimated 'aborted', no alarm;
   *  - 'unknown': aborted or lost with no guess; settled at the reservation, estimated 'aborted';
   *  - 'not_billed': the provider answered with an error status it doesn't bill; the hold is released;
   *  - 'not_sent': the app never called the provider; released exactly like 'not_billed' (the same record);
   *  - undefined or malformed: settled at the reservation, estimated 'no_usage', USAGE_MISSING (alarms).
   */
  async record(call: Reservation, usage: AttemptUsage): Promise<RecordOutcome> {
    let r: UsageRecord;
    try {
      r = settlementRecord(this.cfg, call, usage);
    } catch (err) {
      console.error('USAGE_RECORD_FAILED', { appId: this.cfg.appId, callId: call?.callId, call, usage, err });
      return 'failed';
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await recordUsage(this.ddb, this.cfg.tableName, r);
      } catch (err) {
        const conflicted = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some((c) => c.Code === 'TransactionConflict');
        if (conflicted && attempt < 2) {
          // Hot counters (app and all-apps days) conflict under bursts; jitter, then the same token again.
          await jitter();
          continue;
        }
        try {
          await this.sqs.send(new SendMessageCommand({ QueueUrl: this.cfg.retryQueueUrl, MessageBody: JSON.stringify(r) }));
          console.warn('USAGE_RECORD_DEFERRED', { appId: r.appId, requestId: r.requestId, err });
          return 'deferred';
        } catch (queueErr) {
          console.error('USAGE_RECORD_FAILED', { record: r, err, queueErr });
          return 'failed';
        }
      }
    }
  }

  /**
   * A hold that may exist although authorize refused (the provider is never called): released
   * now, and again from the queue a minute later in case the reserve commits after this release.
   * The sweeper must never settle a call that wasn't made.
   */
  private async giveBack(call: Reservation) {
    const release = settlementRecord(this.cfg, call, 'not_billed');
    const queue = (DelaySeconds?: number) =>
      this.sqs.send(new SendMessageCommand({ QueueUrl: this.cfg.retryQueueUrl, MessageBody: JSON.stringify(release), ...(DelaySeconds ? { DelaySeconds } : {}) }));
    try {
      await recordUsage(this.ddb, this.cfg.tableName, release);
    } catch (err) {
      await queue().catch((queueErr) => console.error('USAGE_RECORD_FAILED', { record: release, err, queueErr }));
    }
    await queue(60).catch((queueErr) => console.error('USAGE_RECORD_FAILED', { record: release, queueErr, delayed: true }));
  }

  /**
   * What the person has spent today and this month, what is held for calls in flight, and the room
   * left under the daily cap: one strongly consistent read (hosted, a second for a linked person's
   * wallet). It moves no money, so a read error rejects.
   */
  async usage(person: string): Promise<PersonUsage> {
    const at = this.now();
    const dayKey = keys.userDay(person, this.cfg.appId, utcDay(at));
    const monthKey = keys.userMonth(person, this.cfg.appId, utcMonth(at));
    const billing = this.cfg.billing;
    const account = typeof billing === 'object' ? this.links.get(person)?.account : undefined;
    const [out, wallet] = await Promise.all([
      this.ddb.send(new BatchGetCommand({ RequestItems: { [this.cfg.tableName]: { Keys: [dayKey, monthKey], ConsistentRead: true } } })),
      account && this.ddb.send(new GetCommand({ TableName: (billing as { walletTable: string }).walletTable, Key: walletKeys.balance(account), ProjectionExpression: 'availableMicroUsd', ConsistentRead: true })),
    ]);
    if (Object.keys(out.UnprocessedKeys ?? {}).length) throw new Error('FairMeter.usage: the read was not processed (throttled)');
    const rows = out.Responses?.[this.cfg.tableName] ?? [];
    const sk = tableKeys().sk;
    const day = rows.find((r) => skOf(r) === dayKey[sk]) ?? {};
    const month = rows.find((r) => skOf(r) === monthKey[sk]) ?? {};
    // What the person paid: list-price cost minus the part the operator absorbed.
    const spent = (row: Record<string, unknown>) => Number(row.costMicroUsd ?? 0) - Number(row.absorbedMicroUsd ?? 0);
    const committed = Number(day.committedMicroUsd ?? 0);
    const cap = this.cfg.dailyCapMicroUsd;
    return {
      day: {
        spentMicroUsd: spent(day),
        heldMicroUsd: Math.max(0, committed - Number(day.costMicroUsd ?? 0)),
        capMicroUsd: cap,
        roomMicroUsd: Math.max(0, cap - committed),
        resetsAt: nextUtcDay(at),
      },
      month: { spentMicroUsd: spent(month), resetsAt: nextUtcMonth(at) },
      tier: dayTier(committed, cap, this.cfg.tiers),
      readOnly: this.cfg.actions !== undefined && pastFloor(committed, cap, this.floor),
      ...(wallet ? { wallet: { availableMicroUsd: Number(wallet.Item?.availableMicroUsd ?? 0) } } : {}),
    };
  }

  /**
   * After a successful write: one JSON line to stdout (its own log event), which the rollup turns
   * into an EVENT; no DynamoDB write. In measure mode (`measureCapacity`) the line also carries
   * the units tallied since the last one, as `rru` and `wru`. Synchronous, never throws. An SKU not configured or an `n`
   * outside 1..perPersonPerMinute is an app bug: ACTION_UNKNOWN (alarms), no line (bulk writes
   * go through authorize and record with `{ units: n }`).
   */
  action(req: { person: string; sku: string; n?: number }): void {
    try {
      const { person, sku, n = 1 } = req;
      // Hosted: the rollup charges the account on the line; a person not linked here has none (canWrite refused them).
      const account = typeof this.cfg.billing === 'object' ? this.links.get(person)?.account ?? '' : undefined;
      if (typeof person !== 'string' || !person || !this.cfg.actions?.skus.includes(sku) || !Number.isInteger(n) || n < 1 || n > this.cfg.actions.perPersonPerMinute || account === '') {
        console.error('ACTION_UNKNOWN', { appId: this.cfg.appId, person, sku, n });
        return;
      }
      process.stdout.write(JSON.stringify({ fairMeter: 'action', appId: this.cfg.appId, env: this.cfg.env, person, sku, n, ...(account ? { account } : {}), ...takeCapacity() }) + '\n');
      const counts = this.actionsThisMinute();
      counts.set(person, (counts.get(person) ?? 0) + n);
    } catch (err) {
      console.error('ACTION_UNKNOWN', { appId: this.cfg.appId, req, err });
    }
  }

  /**
   * Before a write that reports `n` actions: `{ ok: true }`, or a ready refusal (the person is
   * read-only until their room comes back). Never throws. Per instance, at most perPersonPerMinute
   * actions per person per UTC minute, then one eventually consistent read of the person's day:
   * committed above cap - floor (pushed there by the rollup) is daily_limit_reached. Hosted, also
   * one of the wallet: available below the floor (with its fee) is balance_too_low.
   */
  async canWrite(person: string, n = 1): Promise<{ ok: true } | Refusal> {
    const log = { appId: this.cfg.appId, person };
    try {
      const a = this.cfg.actions;
      const bad = !a ? 'no actions configured' : typeof person !== 'string' || !person ? 'no person'
        : !Number.isInteger(n) || n < 1 || n > a.perPersonPerMinute ? `n ${n} is not 1..perPersonPerMinute` : undefined;
      if (bad) {
        console.error('METER_UNAVAILABLE', { ...log, n, reason: bad });
        return refuse(500, 'metering_unavailable');
      }
      const at = this.now();
      // Bounds what one instance lets a person do within one rollup lag: the floor's premise.
      if ((this.actionsThisMinute().get(person) ?? 0) + n > a!.perPersonPerMinute) {
        const retryAfterSeconds = secondsToNextUtcMinute(at);
        console.warn('RATE_LIMITED', { ...log, perPersonPerMinute: a!.perPersonPerMinute });
        return { ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds }, headers: { 'Retry-After': String(retryAfterSeconds) } };
      }
      const charge = this.walletCharge(person, at);
      if (charge && 'ok' in charge) return charge;
      const [{ Item }, wallet] = await Promise.all([
        this.ddb.send(new GetCommand({ TableName: this.cfg.tableName, Key: keys.userDay(person, this.cfg.appId, utcDay(at)) })),
        charge && this.ddb.send(new GetCommand({ TableName: charge.table, Key: walletKeys.balance(charge.account), ProjectionExpression: 'availableMicroUsd' })),
      ]);
      const committed = Number(Item?.committedMicroUsd ?? 0);
      const tier = dayTier(committed, this.cfg.dailyCapMicroUsd, this.cfg.tiers);
      if (pastFloor(committed, this.cfg.dailyCapMicroUsd, this.floor)) return this.limitReached(log, at, tier);
      if (charge && !(Number(wallet!.Item?.availableMicroUsd) >= charge.floor)) return await this.balanceTooLow(log, charge, tier);
      return { ok: true };
    } catch (err) {
      console.error('METER_UNAVAILABLE', { ...log, err });
      return refuse(503, 'metering_unavailable');
    }
  }

  /** The room under the daily cap kept for actions not rolled up yet; 0 without actions. */
  private get floor(): number {
    return this.cfg.actions ? this.cfg.actionFloorMicroUsd! : 0;
  }

  /** This instance's per-person action counts for the current UTC minute. */
  private actionsThisMinute(): Map<string, number> {
    const minute = utcMinute(this.now());
    if (this.actionCounts.minute !== minute) this.actionCounts = { minute, perPerson: new Map() };
    return this.actionCounts.perPerson;
  }

  /**
   * Hosted, at every sign-in: which account pays for `person`. A first link writes LINK and adds it to
   * the account's BALANCE `links`, with the email and lang labels; the same account again is a no-op;
   * another account is 'conflict', writes nothing, and this person's hosted calls are refused
   * link_conflict until support relinks (wallet ADR 0003). Remembered per instance: hosted calls
   * use the account of the person's last link here. Rejects on a read or write error.
   */
  async link(person: string, sub: string, labels: { email: string; lang: string }): Promise<LinkOutcome> {
    const table = this.walletTable('link');
    if (typeof person !== 'string' || !person || typeof sub !== 'string' || !sub) throw new Error('FairMeter.link: person and sub are required');
    const known = this.links.get(person);
    if (known?.sub === sub) return known.account ? 'linked' : 'conflict';
    const key = walletKeys.link(this.cfg.appId, person);
    for (let attempt = 0; ; attempt++) {
      const { Item } = await this.ddb.send(new GetCommand({ TableName: table, Key: key, ProjectionExpression: 'account', ConsistentRead: true }));
      if (Item) {
        const same = Item.account === sub;
        if (!same) console.error('LINK_CONFLICT', { appId: this.cfg.appId, person });
        this.links.set(person, { sub, ...(same ? { account: sub } : {}) });
        return same ? 'linked' : 'conflict';
      }
      try {
        await this.ddb.send(new TransactWriteCommand({
          TransactItems: [
            { Update: { TableName: table, Key: key, UpdateExpression: 'SET account = :sub', ConditionExpression: 'attribute_not_exists(PK)', ExpressionAttributeValues: { ':sub': sub } } },
            {
              Update: {
                TableName: table,
                Key: walletKeys.balance(sub),
                UpdateExpression: 'ADD links :link SET email = :email, lang = :lang',
                ExpressionAttributeValues: { ':link': new Set([`${this.cfg.appId}#${person}`]), ':email': labels.email, ':lang': labels.lang },
              },
            },
          ],
        }));
        this.links.set(person, { sub, account: sub });
        return 'linked';
      } catch (err) {
        // Another instance linked this person first (or the BALANCE was busy): read again, then decide.
        if (attempt < 2 && (err as { name?: string }).name === 'TransactionCanceledException') continue;
        throw err;
      }
    }
  }

  /**
   * Hosted: a single-use pass to the embedded wallet view for this person, valid 2 minutes
   * (PASS#<random>, the account). Returns the random value for the view's URL fragment. Rejects
   * for a person not linked on this instance, or on a write error.
   */
  async walletPass(person: string): Promise<string> {
    const table = this.walletTable('walletPass');
    const account = this.links.get(person)?.account;
    if (!account) throw new Error(`FairMeter.walletPass: ${this.links.has(person) ? 'link_conflict' : 'account_not_linked'}`);
    const random = randomBytes(32).toString('base64url');
    await this.ddb.send(new PutCommand({
      TableName: table,
      Item: { ...walletKeys.pass(random), account, expiresAt: Math.floor(this.now().getTime() / 1000) + PASS_TTL_SECONDS },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return random;
  }

  private walletTable(method: string): string {
    const billing = this.cfg.billing;
    if (typeof billing !== 'object') throw new Error(`FairMeter.${method}: needs hosted billing`);
    return billing.walletTable;
  }

  /**
   * Hosted: who pays for `person` (their last link on this instance), the fee version's basis points
   * and the app's floor with its fee; or a ready refusal. Undefined under billing 'none'.
   */
  private walletCharge(person: string, at: Date): { table: string; account: string; feeBps: number; floor: number } | Refusal | undefined {
    const billing = this.cfg.billing;
    if (typeof billing !== 'object') return undefined;
    const link = this.links.get(person);
    if (!link?.account) {
      console.error(link ? 'LINK_CONFLICT' : 'ACCOUNT_NOT_LINKED', { appId: this.cfg.appId, person });
      return refuse(403, link ? 'link_conflict' : 'account_not_linked');
    }
    const { feeBps } = feeAt(at, billing.fee);
    return { table: billing.walletTable, account: link.account, feeBps, floor: this.floor + feeOf(this.floor, feeBps) };
  }

  /** A debit the wallet's available can't cover; a missing BALANCE row is refused the same way and alarms. */
  private async balanceTooLow(log: Record<string, unknown>, charge: { table: string; account: string }, tier?: BudgetTier): Promise<Refusal> {
    const { Item } = await this.ddb.send(new GetCommand({ TableName: charge.table, Key: walletKeys.balance(charge.account), ProjectionExpression: 'availableMicroUsd', ConsistentRead: true }));
    if (Item?.availableMicroUsd === undefined) console.error('BALANCE_MISSING', { ...log, account: charge.account });
    else console.warn('BALANCE_TOO_LOW', { ...log, account: charge.account, availableMicroUsd: Item.availableMicroUsd });
    return refuse(402, 'balance_too_low', { topUpUrl: TOP_UP_URL }, tier);
  }

  private limitReached(log: Record<string, unknown>, at: Date, tier: BudgetTier): Refusal {
    console.warn('LIMIT_REACHED', log);
    return refuse(429, 'daily_limit_reached', { resetsAt: nextUtcDay(at) }, tier);
  }

  /**
   * The PRICING#<sku> version whose [validFrom, validTo) range contains `at`, from the SKU's versions
   * read at most once per 5 minutes (none found isn't cached). Undefined when none does (logged).
   */
  private async priceAt(sku: string, at: Date): Promise<{ version: string; item: Record<string, any> } | undefined> {
    let cached = this.prices.get(sku);
    const age = at.getTime() - (cached?.readAt ?? 0);
    if (!cached || age < 0 || age >= PRICE_CACHE_MS) {
      // shortcut: one page (1 MB, thousands of versions); paginate if a SKU ever gets near that.
      const { Items = [] } = await this.ddb.send(new QueryCommand({
        TableName: this.cfg.tableName,
        KeyConditionExpression: `${tableKeys().pk} = :pk`,
        ExpressionAttributeValues: { ':pk': `PRICING#${sku}` },
      }));
      cached = { readAt: at.getTime(), versions: Items };
      if (Items.length) this.prices.set(sku, cached);
    }
    const item = versionStartedBy(cached.versions, at, skOf);
    if (!item) return undefined;
    const version = `${sku}@${skOf(item)}`;
    if (!versionCovers(item, at)) {
      console.error('PRICE_VERSION_GAP', { version, at: at.toISOString(), validTo: item.validTo });
      return undefined;
    }
    return { version, item };
  }

  private async get(key: Record<string, string>) {
    return (await this.ddb.send(new GetCommand({ TableName: this.cfg.tableName, Key: key, ConsistentRead: true }))).Item;
  }
}

/** The UsageRecord that settles (or releases) this call (FairMeter.record and FakeFairMeter). Throws only on a hold it can't read. */
export function settlementRecord(cfg: Pick<FairMeterConfig, 'appId' | 'env' | 'billing'>, call: Reservation, usage: AttemptUsage): UsageRecord {
  const h = call.hold;
  const at = new Date(h.at);
  if (!h.price || Number.isNaN(at.getTime()) || typeof h.reservedMicroUsd !== 'number') throw new Error('Unreadable hold');
  const facts = { appId: cfg.appId, env: cfg.env, callId: call.callId, hold: h, walletTable: typeof cfg.billing === 'object' ? cfg.billing.walletTable : undefined };
  if (usage === 'not_billed' || usage === 'not_sent') return holdRecord(facts, 'release');
  if (usage === 'unknown') return holdRecord(facts, 'aborted');
  const estimate = typeof usage === 'object' && usage !== null && 'estimate' in usage;
  const given = estimate ? (usage as { estimate: unknown }).estimate : usage;
  const canonical = estimate && typeof given === 'object' && given !== null && 'inputTokens' in given;
  const meters = () => (canonical ? canonicalMeters(given as Record<string, unknown>) : metersFromUsage(h.provider as Provider, given));
  const callUsage = priceShape(h.price) === 'tokens' ? { meters: meters() } : given;
  const priced = typeof callUsage === 'object' && callUsage !== null ? priceCall(h.price, callUsage as CallUsage, at) : undefined;
  if (!priced || 'error' in priced) {
    console.error('USAGE_MISSING', { appId: cfg.appId, callId: call.callId, person: h.person, sku: h.sku, estimate, error: priced && 'error' in priced ? priced.error : 'no usage' });
    return holdRecord(facts, estimate ? 'aborted' : 'no_usage');
  }
  if (priced.costMicroUsd > h.reservedMicroUsd) {
    // The only sign the cap was overshot (max didn't bound the real usage): it alarms.
    console.error('RESERVATION_EXCEEDED', { appId: cfg.appId, callId: call.callId, person: h.person, sku: h.sku, costMicroUsd: priced.costMicroUsd, reservedMicroUsd: h.reservedMicroUsd });
  }
  return holdRecord(facts, { usage: callUsage as CallUsage, ...priced }, estimate ? 'aborted' : undefined);
}

/** Why a request from an untyped caller can't be served, or undefined. */
function badRequest(req: CallRequest | undefined): string | undefined {
  if (!req || typeof req !== 'object') return 'no request';
  if (typeof req.person !== 'string' || !req.person) return 'a request without person';
  if (typeof req.sku !== 'string' || !req.sku) return 'a request without sku';
  if (typeof req.max !== 'object' || req.max === null) return 'a request without max';
  if (req.paidBy !== undefined && req.paidBy !== 'credit' && req.paidBy !== 'paid') return 'a request with an unknown paidBy';
  return undefined;
}

const PRICE_CACHE_MS = 5 * 60_000;

/** AUTHORIZE_TIMING's facts as authorize goes: the reads' ms, when the reserve began, its sends. */
type Timing = { readsMs: number; reserving?: number; attempts: number };

const jitter = () => new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));

function refuse(status: Refusal['status'], error: RefusalCode, extra: { resetsAt?: string; topUpUrl?: string } = {}, tier?: BudgetTier): Refusal {
  return { ok: false, status, body: { error, ...extra }, headers: {}, ...(tier ? { tier } : {}) };
}

/** The pending row's facts, enough to settle a hold without its price (the sweeper's case). */
export type HoldFacts = Omit<Hold, 'price'>;

/** The price shape a max was given in. */
const shapeOf = (max: Max): PriceShape => ('inputTokens' in max ? 'tokens' : (Object.keys(max)[0] as PriceShape));

/** A call's usage in the price's own unit, as the EVENT's attributes and the counters. */
function usageFacts(shape: PriceShape, usage: CallUsage) {
  if (shape === 'tokens') {
    const m = usage.meters as Meters;
    const meters = { inputTokens: m.inputTokens, cacheReadTokens: m.cacheReadTokens, cacheWriteTokens: m.cacheWriteTokens, outputTokens: m.outputTokens, reasoningTokens: m.reasoningTokens };
    return { details: meters, counters: meters };
  }
  const n = usage[shape]!;
  // `requests` already counts calls on every counter item.
  return { details: { [shape]: n }, counters: shape === 'requests' ? {} : { [shape]: n } };
}

/**
 * The record that settles a hold: at a priced usage, at the reservation (an estimate), or a
 * release. Shared by FairMeter.record and the sweeper, so both write the same thing. A hold with an
 * account (hosted) also moves that account's wallet, in `walletTable`.
 */
export function holdRecord(
  facts: { appId: string; env: string; callId: string; hold: HoldFacts; walletTable?: string },
  outcome: 'release' | 'aborted' | 'no_usage' | 'swept' | ({ usage: CallUsage; baseCostMicroUsd: number; costMicroUsd: number; band?: string; tier?: string }),
  estimated?: 'aborted',
): UsageRecord {
  const h = facts.hold;
  const shape = shapeOf(h.max);
  const atReservation = typeof outcome === 'string';
  const release = outcome === 'release';
  // An estimate at the reservation counts the whole max: the most the provider could have billed.
  const usage: CallUsage = atReservation
    ? shape === 'tokens'
      ? { meters: { ...(h.max as { inputTokens: number; outputTokens: number }), cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
      : (h.max as CallUsage)
    : outcome.usage;
  const cost = release ? 0 : atReservation ? h.reservedMicroUsd : outcome.costMicroUsd;
  const { details, counters } = release ? { details: {}, counters: {} } : usageFacts(shape, usage);
  const record: UsageRecord = {
    appId: facts.appId,
    sub: h.person,
    requestId: facts.callId,
    requestTime: h.at,
    kind: shape,
    pricingVersion: h.pricingVersion,
    details: {
      ...(h.provider ? { provider: h.provider } : {}),
      sku: h.sku,
      ...details,
      ...(!atReservation && outcome.band ? { pricingBand: outcome.band } : {}),
      ...(!atReservation && outcome.tier ? { pricingTier: outcome.tier } : {}),
    },
    counters,
    baseCostMicroUsd: cost,
    costMicroUsd: cost,
    markupBps: 0,
    deductCredit: false,
    env: facts.env,
    paidBy: h.paidBy,
    reservedMicroUsd: h.reservedMicroUsd,
    ...(release ? { release: true } : {}),
    ...(atReservation && !release ? { estimated: outcome as 'aborted' | 'no_usage' | 'swept' } : estimated ? { estimated } : {}),
  };
  if (h.account !== undefined) {
    if (!facts.walletTable || !Number.isInteger(h.feeBps)) throw new Error(`A hosted hold needs the wallet table and its feeBps: ${facts.callId}`);
    const held = h.reservedMicroUsd + feeOf(h.reservedMicroUsd, h.feeBps!);
    // The person pays what served them, plus the fee on it, never more than the hold.
    const paid = cost - absorbedOf(record);
    const fee = feeOf(paid, h.feeBps!);
    record.wallet = { table: facts.walletTable, account: h.account, heldMicroUsd: held, feeMicroUsd: fee, chargedMicroUsd: Math.min(paid + fee, held) };
  }
  record.usageHash = createHash('sha256')
    .update(JSON.stringify([record.kind, record.details, record.costMicroUsd, record.estimated ?? null, record.release ?? false]))
    .digest('hex')
    .slice(0, 32);
  return record;
}
