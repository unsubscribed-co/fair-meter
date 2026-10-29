import { randomUUID } from 'node:crypto';
import { pastFloor } from './actions';
import { dayTier, type TierThresholds } from './budget';
import { settlementRecord, type Actions, type AttemptUsage, type CallRequest, type FairMeterApi, type Hold, type PersonUsage, type RecordOutcome, type Refusal, type RefusalCode, type Reservation } from './fair-meter';
import { nextUtcDay, nextUtcMonth, secondsToNextUtcMinute, utcDay, utcMinute, utcMonth } from './keys';
import { absorbedOf } from './ledger';
import { loadPriceFiles, type PriceFile } from './prices';
import { reserveCost, versionStartedBy } from './pricing';

/*
 * fair-meter/testing: FairMeter in memory, for an app's own tests (no DynamoDB, no SDK mocks).
 * Same results, refusal bodies and usage as FairMeter; src/test/testing.test.ts runs the same
 * scenarios against both. Not exported from the package root.
 */

export interface FakeFairMeterOptions {
  /** Default 500,000 ($0.50). */
  dailyCapMicroUsd?: number;
  /** As Metering's `actions`. Absent: no actions, and canWrite refuses like FairMeter. */
  actions?: Actions;
  /** The floor Metering computes at synth; default 0. */
  actionFloorMicroUsd?: number;
  tiers?: TierThresholds;
  /** Default: the price files fair-meter ships in prices/. */
  prices?: PriceFile[];
  now?: () => Date;
}

type Row = { committed: number; cost: number; absorbed: number };

export class FakeFairMeter implements FairMeterApi {
  /** Every public call, in order, with its arguments. */
  readonly calls: { method: keyof FairMeterApi; args: unknown[] }[] = [];
  private readonly cap: number;
  private readonly floor: number;
  private readonly prices: PriceFile[];
  private readonly now: () => Date;
  /** Day (FairMeter's DAILY row) and month (USAGE row) per person, keyed by person and period. */
  private readonly rows = new Map<string, Row>();
  private readonly open = new Set<string>();
  /** callId to the usageHash of its settle or release: a repeat is a duplicate, anything else a conflict. */
  private readonly settled = new Map<string, string>();
  private actionCounts = { minute: '', perPerson: new Map<string, number>() };
  private forced?: RefusalCode;

  constructor(private readonly options: FakeFairMeterOptions = {}) {
    this.cap = options.dailyCapMicroUsd ?? 500_000;
    this.floor = options.actions ? options.actionFloorMicroUsd ?? 0 : 0;
    if (!(Number.isSafeInteger(this.floor) && this.floor >= 0 && this.floor < this.cap)) throw new Error('FakeFairMeter: actionFloorMicroUsd must be an integer from 0 to below dailyCapMicroUsd');
    this.prices = options.prices ?? loadPriceFiles();
    this.now = options.now ?? (() => new Date());
  }

  /** The next authorize or canWrite, whichever comes first, returns this refusal as FairMeter would. */
  refuseNext(code: RefusalCode): void {
    this.forced = code;
  }

  /** What the rollup does: charge rolled-up actions to the person's day (committed too) and month. */
  rollUp(person: string, costMicroUsd: number): void {
    const at = this.now();
    const day = this.row(person, utcDay(at));
    day.committed += costMicroUsd;
    day.cost += costMicroUsd;
    this.row(person, utcMonth(at)).cost += costMicroUsd;
  }

  async authorize(req: CallRequest): Promise<Reservation | Refusal> {
    this.calls.push({ method: 'authorize', args: [req] });
    const at = this.now();
    const day = this.row(req.person, utcDay(at));
    const forced = this.takeForced(at, this.tier(day.committed));
    if (forced) return forced;
    const file = this.prices.find((f) => f.sku === req.sku);
    const version = file && versionStartedBy(file.versions, at);
    if (!file || !version) return refusal('pricing_not_configured', at);
    const price = { provider: file.provider, ...version };
    const reserved = reserveCost(price, req.max, at);
    if (reserved === undefined) return refusal('metering_unavailable', at);
    // AI holds stop at cap - floor, as in FairMeter.
    if (pastFloor(day.committed + reserved, this.cap, this.floor)) return refusal('daily_limit_reached', at, this.tier(day.committed));
    const callId = randomUUID();
    const hold: Hold = {
      person: req.person, at: at.toISOString(), sku: req.sku, provider: file.provider, pricingVersion: `${req.sku}@${version.validFrom}`,
      price, max: req.max, reservedMicroUsd: reserved, paidBy: req.paidBy ?? 'paid',
    };
    day.committed += reserved;
    this.open.add(callId);
    return { ok: true, tier: this.tier(day.committed), callId, hold };
  }

  async record(call: Reservation, usage: AttemptUsage): Promise<RecordOutcome> {
    this.calls.push({ method: 'record', args: [call, usage] });
    let r;
    try {
      r = settlementRecord({ appId: 'fake', env: 'test' }, call, usage);
    } catch (err) {
      console.error('USAGE_RECORD_FAILED', { callId: call?.callId, call, usage, err });
      return 'failed';
    }
    if (!this.open.has(call.callId)) {
      // Settled or released before, or never held here (FairMeter: no PENDING row left).
      const done = this.settled.get(call.callId);
      if (done === r.usageHash || (done === undefined && r.release)) return 'duplicate';
      console.error('RECORD_CONFLICT', { requestId: r.requestId, sub: r.sub, record: r });
      return 'conflict';
    }
    this.open.delete(call.callId);
    this.settled.set(call.callId, r.usageHash!);
    const day = this.row(r.sub, r.requestTime.slice(0, 10));
    if (r.release) {
      day.committed -= r.reservedMicroUsd!;
      return 'recorded';
    }
    day.committed += r.costMicroUsd - r.reservedMicroUsd!;
    for (const row of [day, this.row(r.sub, r.requestTime.slice(0, 7))]) {
      row.cost += r.costMicroUsd;
      row.absorbed += absorbedOf(r);
    }
    return 'recorded';
  }

  async usage(person: string): Promise<PersonUsage> {
    this.calls.push({ method: 'usage', args: [person] });
    const at = this.now();
    const day = this.row(person, utcDay(at));
    const month = this.row(person, utcMonth(at));
    return {
      day: {
        spentMicroUsd: day.cost - day.absorbed,
        heldMicroUsd: Math.max(0, day.committed - day.cost),
        capMicroUsd: this.cap,
        roomMicroUsd: Math.max(0, this.cap - day.committed),
        resetsAt: nextUtcDay(at),
      },
      month: { spentMicroUsd: month.cost - month.absorbed, resetsAt: nextUtcMonth(at) },
      tier: this.tier(day.committed),
      readOnly: this.options.actions !== undefined && pastFloor(day.committed, this.cap, this.floor),
    };
  }

  action(req: { person: string; sku: string; n?: number }): void {
    this.calls.push({ method: 'action', args: [req] });
    const { person, sku, n = 1 } = req ?? {};
    if (typeof person !== 'string' || !person || !this.options.actions?.skus.includes(sku) || !Number.isInteger(n) || n < 1 || n > this.options.actions.perPersonPerMinute) {
      console.error('ACTION_UNKNOWN', { person, sku, n });
      return;
    }
    const counts = this.actionsThisMinute();
    counts.set(person, (counts.get(person) ?? 0) + n);
  }

  async canWrite(person: string, n = 1): Promise<{ ok: true } | Refusal> {
    this.calls.push({ method: 'canWrite', args: [person, n] });
    const at = this.now();
    const committed = this.row(person, utcDay(at)).committed;
    // canWrite's too_many_requests carries no tier (FairMeter reads nothing before it).
    const forced = this.takeForced(at, this.forced === 'too_many_requests' ? undefined : this.tier(committed));
    if (forced) return forced;
    const a = this.options.actions;
    if (!a || typeof person !== 'string' || !person || !Number.isInteger(n) || n < 1 || n > a.perPersonPerMinute) return { ...refusal('metering_unavailable', at), status: 500 };
    if ((this.actionsThisMinute().get(person) ?? 0) + n > a.perPersonPerMinute) return refusal('too_many_requests', at);
    return !pastFloor(committed, this.cap, this.floor) ? { ok: true } : refusal('daily_limit_reached', at, this.tier(committed));
  }

  private takeForced(at: Date, tier: Refusal['tier']): Refusal | undefined {
    const code = this.forced;
    this.forced = undefined;
    return code && refusal(code, at, tier);
  }

  private tier(committed: number) {
    return dayTier(committed, this.cap, this.options.tiers);
  }

  private row(person: string, period: string): Row {
    const key = `${person}#${period}`;
    let row = this.rows.get(key);
    if (!row) this.rows.set(key, (row = { committed: 0, cost: 0, absorbed: 0 }));
    return row;
  }

  private actionsThisMinute(): Map<string, number> {
    const minute = utcMinute(this.now());
    if (this.actionCounts.minute !== minute) this.actionCounts = { minute, perPerson: new Map() };
    return this.actionCounts.perPerson;
  }
}

/** The refusal FairMeter returns for this code; the tier only where FairMeter knows it. */
function refusal(error: RefusalCode, at: Date, tier?: Refusal['tier']): Refusal {
  const retryAfterSeconds = secondsToNextUtcMinute(at);
  const known = tier && error !== 'pricing_not_configured' && error !== 'metering_unavailable' ? { tier } : {};
  if (error === 'too_many_requests') return { ok: false, status: 429, body: { error, retryAfterSeconds }, headers: { 'Retry-After': String(retryAfterSeconds) }, ...known };
  const resetsAt = error === 'daily_limit_reached' || error === 'service_paused' ? { resetsAt: nextUtcDay(at) } : {};
  return { ok: false, status: error === 'daily_limit_reached' ? 429 : 503, body: { error, ...resetsAt }, headers: {}, ...known };
}
