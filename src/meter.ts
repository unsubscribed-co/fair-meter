import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { budgetTier, DEFAULT_TIER_THRESHOLDS, monthForecastPct, usedPct, type BudgetTier, type Usage } from './budget';
import { computeCharCost, computeCost, computeRequestCost, computeUnitCost, METER_NAMES, promptTokens } from './cost';
import { assertAppId, keys, nextUtcDay, nextUtcMonth, planDefPk, skOf, tableKeys, utcDay, utcMinute, utcMonth, type TableKey } from './keys';
import { recordUsage, type UsageRecord } from './ledger';
import { checkLimits, dailyCapFor, planFromItem, type AppPlan, type LimitConfig } from './limits';
import { pricingTime, scheduleFromItem, selectPrice, skuFor, versionCovers, type PricingSchedule } from './pricing';
import { metersFromUsage, type Provider } from './usage';

export interface MeteringConfig {
  tableName: string;
  /** Which app is calling, e.g. "nieto". Every counter, limit, plan and event is per app. */
  appId: string;
  limits: LimitConfig;
  markupBps: number;
  /** Model name -> billing SKU (PRICING#<sku>); unlisted names are their own SKU. */
  skuAliases: Record<string, string>;
  /** SQS queue drained by retry-handler.ts; usage that can't be recorded inline waits there. */
  retryQueueUrl: string;
}

export interface MeteringClients {
  ddb: DynamoDBDocumentClient;
  sqs: SQSClient;
}

export interface Caller {
  sub: string;
  householdId: string;
  role?: string;
  /** This app's plan for the household; undefined = legacy prepaid credit. */
  plan?: AppPlan;
}

export type AuthorizeResult =
  | {
      ok: true;
      caller: Caller;
      tier: BudgetTier;
      /**
       * The household's spend this month as a floored percent of its allowance (the same numbers as
       * the tier); undefined without a plan allowance. Lets an app step a feature down per household.
       */
      householdMonthPct?: number;
      /**
       * The household's month counter item for this app as read for the limits (consistent read;
       * undefined before its first call this month): per-household state an app keeps on it, e.g.
       * Nieto's premiumChars and premiumEndedAt (UsageRecord.householdMonthMarks). No extra read.
       */
      householdMonth?: Record<string, any>;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
      /** Known once the household's counters were read (not for not_registered / household_not_found). */
      tier?: BudgetTier;
      /** too_many_requests only: seconds until the next UTC minute (an HTTP Retry-After). */
      retryAfterSeconds?: number;
    };

/** GET usage: where the caller stands, as percentages only (never money). */
export interface UsageSummary {
  tier: BudgetTier;
  /** The caller's own spend today against their daily cap. */
  day: { usedPct: number; resetsAt: string };
  /** The household's spend this month against its allowance; null without a plan allowance. */
  month: { usedPct: number | null; forecastPct: number | null; resetsAt: string };
  app: string;
}

export interface TokenPricing {
  sku: string;
  version: string;
  schedule: PricingSchedule;
}

/**
 * Metering for one app: who may call (limits), what a call costs (versioned prices, provider
 * usage adapters), and recording it exactly once. The app does auth, request validation and the
 * upstream call; it asks `authorize` before the call and `record` after it.
 */
export class Meter {
  constructor(
    private readonly cfg: MeteringConfig,
    private readonly clients: MeteringClients,
  ) {
    assertAppId(cfg.appId);
  }

  get appId() {
    return this.cfg.appId;
  }

  /** False with `limits.billing: 'none'` (self-hosting): no allowance, credit or markup. */
  private get charging() {
    return this.cfg.limits.billing !== 'none';
  }

  private get markupBps() {
    return this.charging ? this.cfg.markupBps : 0;
  }

  /**
   * Registered user, household, then every spend limit, all before the upstream call. Logs
   * SERVICE_PAUSED (error, alarms) when a circuit breaker blocks.
   */
  async authorize(sub: string, at: Date): Promise<AuthorizeResult> {
    const profile = await this.get(keys.profile(sub), false);
    // Returning the sub lets family members read it off the app for onboarding.
    if (!profile?.householdId) return { ok: false, status: 403, body: { error: 'not_registered', sub } };
    const householdId = String(profile.householdId);
    const app = this.cfg.appId;
    const day = utcDay(at);
    const month = utcMonth(at);

    // The brake's counter goes up alongside the reads (no extra latency); the spend limits answer
    // first because their message stays true longer.
    const [meta, planItem, userDay, householdMonthItem, appDay, allAppsDay, retryAfterSeconds] = await Promise.all([
      this.get(keys.householdMeta(householdId)),
      this.get(keys.householdPlan(householdId, app)),
      this.cost(keys.userDay(sub, app, day)),
      this.get(keys.householdMonth(householdId, app, month)),
      this.cost(keys.appDay(app, day)),
      this.cost(keys.globalDay(day)),
      this.brake(sub, at),
    ]);
    if (!meta) return { ok: false, status: 403, body: { error: 'household_not_found' } };
    const householdMonth = Number(householdMonthItem?.costMicroUsd ?? 0);
    const plan = planFromItem(planItem);
    const usages = this.usages(plan, userDay, householdMonth);
    const tier = budgetTier([usages.day, usages.month], this.cfg.limits.tiers ?? DEFAULT_TIER_THRESHOLDS);

    const decision = checkLimits(
      plan,
      Number(meta.creditBalanceMicroUsd ?? 0),
      { userDayMicroUsd: userDay, householdMonthMicroUsd: householdMonth, appDayMicroUsd: appDay, allAppsDayMicroUsd: allAppsDay },
      this.cfg.limits,
    );
    if (decision.ok) {
      if (retryAfterSeconds === undefined) {
        return {
          ok: true,
          caller: { sub, householdId, role: profile.role, plan },
          tier,
          ...(usages.month ? { householdMonthPct: usedPct(usages.month) } : {}),
          ...(householdMonthItem ? { householdMonth: householdMonthItem } : {}),
        };
      }
      console.warn('RATE_LIMITED', { appId: app, sub, householdId, maxCallsPerMinute: this.cfg.limits.maxCallsPerMinute });
      return { ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds }, tier, retryAfterSeconds };
    }

    const context = { appId: app, sub, householdId, reason: decision.reason };
    if (decision.error === 'service_paused') {
      // Alarmed; calls resume on their own at 00:00 UTC.
      console.error('SERVICE_PAUSED', { ...context, appDay, allAppsDay, limits: this.cfg.limits });
    } else if (decision.reason === 'plan_without_allowance') {
      console.error('PLAN_WITHOUT_ALLOWANCE', context);
    } else {
      console.warn('LIMIT_REACHED', context);
    }
    const resetsAt =
      decision.error === 'daily_limit_reached' ? nextUtcDay(at)
        : decision.error === 'monthly_allowance_reached' ? nextUtcMonth(at)
          : undefined;
    return { ok: false, status: decision.status, body: { error: decision.error, ...(resetsAt ? { resetsAt } : {}) }, tier };
  }

  /**
   * Per-minute brake against loops (limits.maxCallsPerMinute): one atomic conditional counter per user
   * and UTC minute, expiring on its own. Returns the seconds to wait when over, else undefined.
   */
  private async brake(sub: string, at: Date): Promise<number | undefined> {
    const max = this.cfg.limits.maxCallsPerMinute;
    if (max === undefined) return undefined;
    const minuteStartMs = Math.floor(at.getTime() / 60_000) * 60_000;
    try {
      await this.clients.ddb.send(
        new UpdateCommand({
          TableName: this.cfg.tableName,
          Key: keys.userRate(sub, this.cfg.appId, utcMinute(at)),
          UpdateExpression: 'ADD calls :one SET expiresAt = :ttl',
          ConditionExpression: 'attribute_not_exists(calls) OR calls < :max',
          // Numeric epoch seconds: the table's TTL removes the item about an hour later.
          ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': minuteStartMs / 1000 + 3_600 },
        }),
      );
      return undefined;
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      return Math.max(1, Math.ceil((minuteStartMs + 60_000 - at.getTime()) / 1000));
    }
  }

  /** Today's spend / daily cap and (plan households) this month's / the allowance: the tier's inputs. */
  private usages(plan: AppPlan | undefined, userDayMicroUsd: number, householdMonthMicroUsd: number): { day: Usage; month?: Usage } {
    // Not charging: the allowance is no limit, so the tier and the month figure ignore it.
    const allowance = this.charging ? plan?.monthlyAllowanceMicroUsd : undefined;
    return {
      day: { usedMicroUsd: userDayMicroUsd, capMicroUsd: dailyCapFor(plan, this.cfg.limits) },
      ...(allowance !== undefined ? { month: { usedMicroUsd: householdMonthMicroUsd, capMicroUsd: allowance } } : {}),
    };
  }

  /**
   * Where the caller stands, in percentages (never money): their own day, the household's month.
   * Four eventually consistent point reads (profile, then plan and the two counters), no scans.
   */
  async usage(sub: string, at: Date): Promise<{ status: number; body: UsageSummary | Record<string, unknown> }> {
    const profile = await this.get(keys.profile(sub), false);
    if (!profile?.householdId) return { status: 403, body: { error: 'not_registered', sub } };
    const householdId = String(profile.householdId);
    const app = this.cfg.appId;
    const [planItem, userDay, householdMonth] = await Promise.all([
      this.get(keys.householdPlan(householdId, app), false),
      this.cost(keys.userDay(sub, app, utcDay(at)), false),
      this.cost(keys.householdMonth(householdId, app, utcMonth(at)), false),
    ]);
    const { day, month } = this.usages(planFromItem(planItem), userDay, householdMonth);
    const body: UsageSummary = {
      tier: budgetTier([day, month], this.cfg.limits.tiers ?? DEFAULT_TIER_THRESHOLDS),
      day: { usedPct: usedPct(day), resetsAt: nextUtcDay(at) },
      month: {
        usedPct: month ? usedPct(month) : null,
        forecastPct: month ? monthForecastPct(month, at) : null,
        resetsAt: nextUtcMonth(at),
      },
      app,
    };
    return { status: 200, body };
  }

  /** Registration and this app's limits, for a "who am I" endpoint. */
  async account(sub: string): Promise<Record<string, unknown>> {
    const profile = await this.get(keys.profile(sub), false);
    if (!profile?.householdId) return { sub, registered: false };
    const householdId = String(profile.householdId);
    const [meta, planItem] = await Promise.all([
      this.get(keys.householdMeta(householdId)),
      this.get(keys.householdPlan(householdId, this.cfg.appId)),
    ]);
    const plan = planFromItem(planItem);
    return {
      sub,
      registered: true,
      householdId,
      role: profile.role,
      creditBalanceMicroUsd: Number(meta?.creditBalanceMicroUsd ?? 0),
      ...(plan
        ? { plan: plan.plan, subscriptionStatus: plan.subscriptionStatus, monthlyAllowanceMicroUsd: plan.monthlyAllowanceMicroUsd ?? 0 }
        : {}),
      dailyCapMicroUsd: dailyCapFor(plan, this.cfg.limits),
    };
  }

  skuFor(model: string): string {
    return skuFor(model, this.cfg.skuAliases);
  }

  /**
   * The PRICING#<sku> version whose [validFrom, validTo) range contains `at`. Undefined when none
   * does (logged): never guess a price.
   */
  async pricingItem(sku: string, at: Date): Promise<{ version: string; item: Record<string, any> } | undefined> {
    return this.versionAt(`PRICING#${sku}`, sku, at, 'PRICE_VERSION_GAP');
  }

  /**
   * This app's PLANDEF#<app>#<plan> version valid at `at` ({ version: "<plan>@<validFrom>", item }),
   * or undefined when none covers it (logged). Read errors throw: the caller decides what is safe.
   */
  async planDefItem(plan: string, at: Date): Promise<{ version: string; item: Record<string, any> } | undefined> {
    return this.versionAt(planDefPk(this.cfg.appId, plan), plan, at, 'PLAN_DEF_VERSION_GAP');
  }

  /** The immutable version under `pk` whose [validFrom, validTo) contains `at`: the latest SK <= at. */
  private async versionAt(pk: string, label: string, at: Date, gapLog: string): Promise<{ version: string; item: Record<string, any> } | undefined> {
    const { Items } = await this.clients.ddb.send(
      new QueryCommand({
        TableName: this.cfg.tableName,
        KeyConditionExpression: `${tableKeys().pk} = :pk AND ${tableKeys().sk} <= :at`,
        ExpressionAttributeValues: { ':pk': pk, ':at': pricingTime(at) },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const item = Items?.[0];
    if (!item) return undefined;
    const version = `${label}@${skOf(item)}`;
    if (!versionCovers(item, at)) {
      console.error(gapLog, { version, at: at.toISOString(), validTo: item.validTo });
      return undefined;
    }
    return { version, item };
  }

  /** Token pricing for a model at `at`, or undefined (logged) when missing or malformed. */
  async tokenPricing(model: string, at: Date): Promise<TokenPricing | undefined> {
    const sku = this.skuFor(model);
    const found = await this.pricingItem(sku, at);
    if (!found) {
      console.error('No pricing configured', { sku, at: at.toISOString() });
      return undefined;
    }
    const schedule = scheduleFromItem(found.item);
    if (!schedule) console.error('Malformed pricing item', { version: found.version });
    return schedule ? { sku, version: found.version, schedule } : undefined;
  }

  /**
   * Prices an LLM call from the provider's `usage`. Bills the served model: a served name without
   * a price of its own falls back to the requested model's price (the answer is already paid for)
   * and logs SERVED_MODEL_UNPRICED (alarms) so the alias map gets fixed. Undefined when the usage
   * block is missing or malformed (logged; never guess).
   */
  async tokenRecord(args: {
    caller: Caller;
    requestId: string;
    at: Date;
    kind: string;
    provider: Provider;
    requestedModel: string;
    requestedPricing: TokenPricing;
    servedModel: string;
    usage: unknown;
    details?: Record<string, string | number | boolean>;
    /**
     * Chat only: true when this call starts one of the person's requests (its last message is hers),
     * false for the follow-up calls of the same request (tool results). Counted as `turns`, so
     * cost per request = cost / turns (docs/token-diet-plan.md). Omitted: no `turns` counter.
     */
    turnStart?: boolean;
    /** Counters besides the token meters on every counter item (e.g. Nieto's `searches`). Code constants. */
    counters?: Record<string, number>;
  }): Promise<UsageRecord | undefined> {
    const meters = metersFromUsage(args.provider, args.usage);
    if (!meters) {
      console.error('Upstream response missing usage; call not metered', { appId: this.cfg.appId, requestId: args.requestId });
      return undefined;
    }
    let pricing = args.requestedPricing;
    const servedSku = this.skuFor(args.servedModel);
    if (servedSku !== pricing.sku) {
      const served = await this.tokenPricing(args.servedModel, args.at);
      if (served) pricing = served;
      else console.error('SERVED_MODEL_UNPRICED', { servedModel: args.servedModel, servedSku, pricedAs: pricing.sku });
    }
    const { price, band, tier } = selectPrice(pricing.schedule, args.at, promptTokens(meters));
    return this.usageRecord(args.caller, args.requestId, args.at, args.kind, pricing.version, {
      details: {
        provider: args.provider,
        requestedModel: args.requestedModel,
        servedModel: args.servedModel,
        // Kept for older readers of event items; same value as servedModel.
        model: args.servedModel,
        sku: pricing.sku,
        ...meters,
        // Only present when the price has time bands / context tiers.
        ...(band ? { pricingBand: band } : {}),
        ...(tier ? { pricingTier: tier } : {}),
        ...args.details,
        ...(args.turnStart === undefined ? {} : { turnStart: args.turnStart }),
      },
      counters: {
        ...Object.fromEntries(METER_NAMES.map((name) => [name, meters[name]])),
        ...(args.turnStart === undefined ? {} : { turns: args.turnStart ? 1 : 0 }),
        ...args.counters,
      },
      ...computeCost(meters, price, this.markupBps),
    });
  }

  /** Prices a per-character call (text-to-speech) from a PRICING item with microUsdPerMChars. */
  charRecord(args: {
    caller: Caller;
    requestId: string;
    at: Date;
    kind: string;
    sku: string;
    pricing: { version: string; microUsdPerMChars: number };
    chars: number;
    details?: Record<string, string | number | boolean>;
    /** Counters besides ttsChars on every counter item (e.g. Nieto's premiumChars). Code constants. */
    counters?: Record<string, number>;
    /** Account-wide free-tier counters and set members of this call (UsageRecord.providerMonth). */
    providerMonth?: UsageRecord['providerMonth'];
    /** One-way marks on the household's month (UsageRecord.householdMonthMarks). */
    householdMonthMarks?: UsageRecord['householdMonthMarks'];
  }): UsageRecord {
    return {
      ...this.usageRecord(args.caller, args.requestId, args.at, args.kind, args.pricing.version, {
        details: { sku: args.sku, chars: args.chars, ...args.details },
        counters: { ttsChars: args.chars, ...args.counters },
        ...computeCharCost(args.chars, args.pricing.microUsdPerMChars, this.markupBps),
      }),
      ...(args.providerMonth ? { providerMonth: args.providerMonth } : {}),
      ...(args.householdMonthMarks ? { householdMonthMarks: args.householdMonthMarks } : {}),
    };
  }

  /**
   * Prices one per-request call (a Places search, a static map) from a PRICING item with microUsdPerRequest. Counters
   * are the app's own (code constants, e.g. Nieto's placesCalls); [providerMonth] carries the free-tier count.
   */
  requestRecord(args: {
    caller: Caller;
    requestId: string;
    at: Date;
    kind: string;
    sku: string;
    pricing: { version: string; microUsdPerRequest: number };
    details?: Record<string, string | number | boolean>;
    counters?: Record<string, number>;
    providerMonth?: UsageRecord['providerMonth'];
  }): UsageRecord {
    return {
      ...this.usageRecord(args.caller, args.requestId, args.at, args.kind, args.pricing.version, {
        details: { sku: args.sku, ...args.details },
        counters: { ...args.counters },
        ...computeRequestCost(1, args.pricing.microUsdPerRequest, this.markupBps),
      }),
      ...(args.providerMonth ? { providerMonth: args.providerMonth } : {}),
    };
  }

  /**
   * Prices a per-unit call (a web search query the model ran) from a PRICING item with microUsdPerKUnits (per 1,000
   * units). The event keeps `units` so reprice can recompute it; `counters` name what the units are (e.g. searchQueries).
   */
  unitRecord(args: {
    caller: Caller;
    requestId: string;
    at: Date;
    kind: string;
    sku: string;
    pricing: { version: string; microUsdPerKUnits: number };
    units: number;
    details?: Record<string, string | number | boolean>;
    counters: Record<string, number>;
    providerMonth?: UsageRecord['providerMonth'];
  }): UsageRecord {
    return {
      ...this.usageRecord(args.caller, args.requestId, args.at, args.kind, args.pricing.version, {
        details: { sku: args.sku, units: args.units, ...args.details },
        counters: args.counters,
        ...computeUnitCost(args.units, args.pricing.microUsdPerKUnits, this.markupBps),
      }),
      ...(args.providerMonth ? { providerMonth: args.providerMonth } : {}),
    };
  }

  /** A per-unit SKU's price version at `at` (microUsdPerKUnits), or undefined (logged) when none valid covers it. */
  async unitPricing(sku: string, at: Date): Promise<{ sku: string; version: string; microUsdPerKUnits: number } | undefined> {
    const found = await this.pricingItem(sku, at);
    const rate = Number(found?.item.microUsdPerKUnits);
    if (!found || !Number.isSafeInteger(rate) || rate < 0) {
      console.error('No pricing configured', { sku, at: at.toISOString() });
      return undefined;
    }
    return { sku, version: found.version, microUsdPerKUnits: rate };
  }

  /**
   * One account-wide counter of PROVIDER#<provider> / MONTH#<UTC month of `at`> (0 when nothing was
   * used yet), e.g. the premium voice characters checked against Google's free tier before a call.
   * Eventually consistent: callers accept a small overshoot.
   */
  async providerMonthCount(provider: string, counter: string, at: Date): Promise<number> {
    return Number((await this.providerMonthItem(provider, at))?.[counter] ?? 0);
  }

  /** The whole PROVIDER#<provider> / MONTH#<UTC month of `at`> item (undefined before its first use). Eventually consistent. */
  async providerMonthItem(provider: string, at: Date): Promise<Record<string, any> | undefined> {
    return this.get(keys.providerMonth(provider, utcMonth(at)), false);
  }

  private usageRecord(
    caller: Caller,
    requestId: string,
    at: Date,
    kind: string,
    pricingVersion: string,
    rest: Pick<UsageRecord, 'details' | 'counters' | 'baseCostMicroUsd' | 'costMicroUsd'>,
  ): UsageRecord {
    return {
      appId: this.cfg.appId,
      sub: caller.sub,
      householdId: caller.householdId,
      ...(caller.plan ? { plan: caller.plan.plan } : {}),
      requestId,
      requestTime: at.toISOString(),
      kind,
      pricingVersion,
      markupBps: this.markupBps,
      deductCredit: this.charging && caller.plan === undefined,
      ...rest,
    };
  }

  /**
   * Records a call exactly once. The provider already charged us, so this never throws: a failed
   * write goes to the durable retry queue (recording is idempotent, so a retry never double-counts);
   * only if that fails too is it logged as USAGE_RECORD_FAILED (alarms) with everything needed to
   * record it by hand.
   */
  async record(record: UsageRecord): Promise<'recorded' | 'duplicate' | 'deferred' | 'failed'> {
    try {
      return await recordUsage(this.clients.ddb, this.cfg.tableName, record);
    } catch (err) {
      try {
        await this.clients.sqs.send(new SendMessageCommand({ QueueUrl: this.cfg.retryQueueUrl, MessageBody: JSON.stringify(record) }));
        console.warn('USAGE_RECORD_DEFERRED', { appId: record.appId, requestId: record.requestId, err });
        return 'deferred';
      } catch (queueErr) {
        console.error('USAGE_RECORD_FAILED', { record, err, queueErr });
        return 'failed';
      }
    }
  }

  private async get(key: TableKey, consistent = true): Promise<Record<string, any> | undefined> {
    const { Item } = await this.clients.ddb.send(new GetCommand({ TableName: this.cfg.tableName, Key: key, ConsistentRead: consistent }));
    return Item;
  }

  /** costMicroUsd of a counter item (0 when the period has no usage yet). */
  private async cost(key: TableKey, consistent = true): Promise<number> {
    return Number((await this.get(key, consistent))?.costMicroUsd ?? 0);
  }
}
