import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { assertTierThresholds, budgetTier, DEFAULT_TIER_THRESHOLDS, type BudgetTier, type TierThresholds } from './budget';
import type { Meters } from './cost';
import { assertAppId, keys, nextUtcDay, pkNotExists, setTableKeys, skOf, tableKeys, utcDay, type TableKeys } from './keys';
import { recordUsage, type UsageRecord } from './ledger';
import { Meter } from './meter';
import { priceCall, priceShape, pricingTime, reserveCost, versionCovers, type CallUsage, type PriceShape } from './pricing';
import { isProvider, metersFromUsage, type Provider } from './usage';

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
  /** 'none' (default): nobody is charged. 'hosted' needs the wallet, which doesn't exist yet: refused. */
  billing?: 'none' | 'hosted';
  /** The table's key names when they aren't PK/SK (StackSplit: pk/sk). */
  tableKeys?: Partial<TableKeys>;
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
}

export interface Reservation {
  ok: true;
  /** The person's day after this hold: normal | saving | essential | limit. */
  tier: BudgetTier;
  /** Minted here, one per attempt; the EVENT's requestId. */
  callId: string;
  readonly hold: Hold;
}

export type RefusalCode = 'daily_limit_reached' | 'too_many_requests' | 'service_paused' | 'pricing_not_configured' | 'metering_unavailable';

export interface Refusal {
  ok: false;
  status: 429 | 500 | 503;
  body: { error: RefusalCode; resetsAt?: string; retryAfterSeconds?: number };
  /** Retry-After on too_many_requests; otherwise {}. */
  headers: Record<string, string>;
  /** Known once the counters were read. */
  tier?: BudgetTier;
}

export type RecordOutcome = 'recorded' | 'duplicate' | 'trued_up' | 'conflict' | 'deferred' | 'failed';

/** What the app saw of the attempt: the provider's usage block, an estimate, or one of the two words. */
export type AttemptUsage = object | undefined | 'unknown' | 'not_billed';

const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function readConfig(config?: FairMeterConfig): FairMeterConfig {
  if (!config) {
    if (!process.env.FAIR_METER) throw new Error('FairMeter: no config and no FAIR_METER env (the Metering construct sets it)');
    config = JSON.parse(process.env.FAIR_METER) as FairMeterConfig;
  }
  const c = config;
  assertAppId(c.appId);
  if (c.billing === 'hosted') throw new Error("FairMeter: billing 'hosted' needs the wallet, which v0.2.0 doesn't have");
  if (c.billing !== undefined && c.billing !== 'none') throw new Error(`FairMeter: unknown billing ${c.billing}`);
  if (!c.env || !c.tableName || !c.retryQueueUrl) throw new Error('FairMeter: env, tableName and retryQueueUrl are required');
  for (const [name, v] of Object.entries({ dailyCapMicroUsd: c.dailyCapMicroUsd, appDailyCapMicroUsd: c.appDailyCapMicroUsd })) {
    if (!positive(v)) throw new Error(`FairMeter: ${name} must be a positive integer (micro-USD)`);
  }
  if (c.allAppsDailyCapMicroUsd !== undefined && !positive(c.allAppsDailyCapMicroUsd)) throw new Error('FairMeter: allAppsDailyCapMicroUsd must be a positive integer');
  if (c.maxCallsPerMinute !== undefined && !positive(c.maxCallsPerMinute)) throw new Error('FairMeter: maxCallsPerMinute must be a positive integer');
  if (c.tiers) assertTierThresholds(c.tiers);
  if (c.tableKeys) setTableKeys(c.tableKeys);
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
    const tierAt = (used: number) => budgetTier([{ usedMicroUsd: used, capMicroUsd: cap }], this.cfg.tiers ?? DEFAULT_TIER_THRESHOLDS);
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
    if (reserved > cap) {
      console.error('CALL_EXCEEDS_CAP', { ...log, reservedMicroUsd: reserved, dailyCapMicroUsd: cap });
      return refuse(429, 'daily_limit_reached', { resetsAt: nextUtcDay(at) }, tier);
    }
    if (committed + reserved > cap) return this.limitReached(log, at, tier);
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
    };
    const { price: _, ...pending } = hold;
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
            ExpressionAttributeValues: { ':reserved': reserved, ':room': cap - reserved },
          },
        },
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
   *  - { estimate: <the same shape> }: the app's guess for an attempt it aborted (a hedge loser),
   *    settled at that cost, estimated 'aborted', no alarm;
   *  - 'unknown': aborted or lost with no guess; settled at the reservation, estimated 'aborted';
   *  - 'not_billed': the provider answered with an error status it doesn't bill; the hold is released;
   *  - undefined or malformed: settled at the reservation, estimated 'no_usage', USAGE_MISSING (alarms).
   */
  async record(call: Reservation, usage: AttemptUsage): Promise<RecordOutcome> {
    let r: UsageRecord;
    try {
      r = this.settlement(call, usage);
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

  /** The UsageRecord that settles (or releases) this call. Throws only on a hold it can't read. */
  private settlement(call: Reservation, usage: AttemptUsage): UsageRecord {
    const h = call.hold;
    const at = new Date(h.at);
    if (!h.price || Number.isNaN(at.getTime()) || typeof h.reservedMicroUsd !== 'number') throw new Error('Unreadable hold');
    const facts = { appId: this.cfg.appId, env: this.cfg.env, callId: call.callId, hold: h };
    if (usage === 'not_billed') return holdRecord(facts, 'release');
    if (usage === 'unknown') return holdRecord(facts, 'aborted');
    const estimate = typeof usage === 'object' && usage !== null && 'estimate' in usage;
    const given = estimate ? (usage as { estimate: unknown }).estimate : usage;
    const callUsage = priceShape(h.price) === 'tokens' ? { meters: metersFromUsage(h.provider as Provider, given) } : given;
    const priced = typeof callUsage === 'object' && callUsage !== null ? priceCall(h.price, callUsage as CallUsage, at) : undefined;
    if (!priced || 'error' in priced) {
      console.error('USAGE_MISSING', { appId: this.cfg.appId, callId: call.callId, person: h.person, sku: h.sku, estimate, error: priced && 'error' in priced ? priced.error : 'no usage' });
      return holdRecord(facts, estimate ? 'aborted' : 'no_usage');
    }
    if (priced.costMicroUsd > h.reservedMicroUsd) {
      // The only sign the cap was overshot (max didn't bound the real usage): it alarms.
      console.error('RESERVATION_EXCEEDED', { appId: this.cfg.appId, callId: call.callId, person: h.person, sku: h.sku, costMicroUsd: priced.costMicroUsd, reservedMicroUsd: h.reservedMicroUsd });
    }
    return holdRecord(facts, { usage: callUsage as CallUsage, ...priced }, estimate ? 'aborted' : undefined);
  }

  /**
   * A hold that may exist although authorize refused (the provider is never called): released
   * now, and again from the queue a minute later in case the reserve commits after this release.
   * The sweeper must never settle a call that wasn't made.
   */
  private async giveBack(call: Reservation) {
    const release = this.settlement(call, 'not_billed');
    const queue = (DelaySeconds?: number) =>
      this.sqs.send(new SendMessageCommand({ QueueUrl: this.cfg.retryQueueUrl, MessageBody: JSON.stringify(release), ...(DelaySeconds ? { DelaySeconds } : {}) }));
    try {
      await recordUsage(this.ddb, this.cfg.tableName, release);
    } catch (err) {
      await queue().catch((queueErr) => console.error('USAGE_RECORD_FAILED', { record: release, err, queueErr }));
    }
    await queue(60).catch((queueErr) => console.error('USAGE_RECORD_FAILED', { record: release, queueErr, delayed: true }));
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
    const t = pricingTime(at);
    const item = cached.versions.filter((v) => skOf(v) <= t).at(-1);
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

function refuse(status: Refusal['status'], error: RefusalCode, extra: { resetsAt?: string } = {}, tier?: BudgetTier): Refusal {
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
 * release. Shared by FairMeter.record and the sweeper, so both write the same thing.
 */
export function holdRecord(
  facts: { appId: string; env: string; callId: string; hold: HoldFacts },
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
  record.usageHash = createHash('sha256')
    .update(JSON.stringify([record.kind, record.details, record.costMicroUsd, record.estimated ?? null, record.release ?? false]))
    .digest('hex')
    .slice(0, 32);
  return record;
}
