import { randomBytes, randomUUID } from 'node:crypto';
import { pastFloor } from './actions';
import { dayTier, type TierThresholds } from './budget';
import { settlementRecord, type Actions, type AttemptUsage, type CallRequest, type FairMeterApi, type Hold, type LinkOutcome, type PersonUsage, type RecordOutcome, type Refusal, type RefusalCode, type Reservation } from './fair-meter';
import { nextUtcDay, nextUtcMonth, secondsToNextUtcMinute, utcDay, utcMinute, utcMonth } from './keys';
import { absorbedOf, walletChargeOf } from './ledger';
import { feeAt, loadPriceFiles, type PriceFile } from './prices';
import { reserveCost, versionStartedBy } from './pricing';
import { feeOf, TOP_UP_URL } from './wallet';

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
  /** Hosted billing: wallets in memory (`fund`), charged cost plus the fee of prices/fee.json; people `link` first. */
  hosted?: boolean;
}

type Row = { committed: number; cost: number; absorbed: number; fee: number };

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
  /** Hosted: the LINK rows (person to account), each person's last link (none: a conflict), and each account's available. */
  private readonly linkRows = new Map<string, string>();
  private readonly links = new Map<string, string | undefined>();
  private readonly available = new Map<string, number>();

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

  /** Hosted: what the wallet does on a top-up, reduced to the account's available. */
  fund(account: string, availableMicroUsd: number): void {
    this.available.set(account, availableMicroUsd);
  }

  /**
   * What the rollup does: charge rolled-up actions to the person's day (committed too) and month.
   * Hosted, cost plus fee leaves the linked account's available, up to what is there (the rest absorbed, FLOOR_OVERRUN).
   */
  rollUp(person: string, costMicroUsd: number): void {
    const at = this.now();
    let absorbed = 0;
    let fee = 0;
    const account = this.links.get(person);
    if (this.options.hosted && account) {
      const { feeMicroUsd, chargedMicroUsd } = walletChargeOf(costMicroUsd, feeAt(at).feeBps, this.available.get(account) ?? 0);
      this.available.set(account, (this.available.get(account) ?? 0) - chargedMicroUsd);
      // Only cost is absorbed, never the fee.
      absorbed = costMicroUsd + feeMicroUsd - chargedMicroUsd;
      fee = feeMicroUsd;
      if (absorbed) console.error('FLOOR_OVERRUN', { person, account, chargedMicroUsd, absorbedMicroUsd: absorbed });
    }
    for (const row of [this.row(person, utcDay(at)), this.row(person, utcMonth(at))]) {
      row.cost += costMicroUsd;
      row.absorbed += absorbed;
      row.fee += fee;
    }
    // Hosted, the daily cap counts charged amounts (cost plus the fee charged), as in FairMeter.
    this.row(person, utcDay(at)).committed += costMicroUsd + fee;
  }

  async link(person: string, sub: string, labels: { email: string; lang: string }): Promise<LinkOutcome> {
    this.calls.push({ method: 'link', args: [person, sub, labels] });
    if (!this.options.hosted) throw new Error("FakeFairMeter.link: needs hosted billing");
    const linked = this.linkRows.get(person) ?? sub;
    this.linkRows.set(person, linked);
    if (linked !== sub) console.error('LINK_CONFLICT', { person });
    this.links.set(person, linked === sub ? sub : undefined);
    return linked === sub ? 'linked' : 'conflict';
  }

  async walletPass(person: string): Promise<string> {
    this.calls.push({ method: 'walletPass', args: [person] });
    if (!this.options.hosted) throw new Error('FakeFairMeter.walletPass: needs hosted billing');
    if (!this.links.get(person)) throw new Error(`FakeFairMeter.walletPass: ${this.links.has(person) ? 'link_conflict' : 'account_not_linked'}`);
    return randomBytes(32).toString('base64url');
  }

  async authorize(req: CallRequest): Promise<Reservation | Refusal> {
    this.calls.push({ method: 'authorize', args: [req] });
    const at = this.now();
    const day = this.row(req.person, utcDay(at));
    const forced = this.takeForced(at, this.tier(day.committed));
    if (forced) return forced;
    const unlinked = this.unlinked(req.person, at);
    if (unlinked) return unlinked;
    const file = this.prices.find((f) => f.sku === req.sku);
    const version = file && versionStartedBy(file.versions, at);
    if (!file || !version) return refusal('pricing_not_configured', at);
    const price = { provider: file.provider, ...version };
    const reserved = reserveCost(price, req.max, at);
    if (reserved === undefined) return refusal('metering_unavailable', at);
    const account = this.links.get(req.person);
    const feeBps = feeAt(at).feeBps;
    // Hosted, the daily cap counts charged amounts: the hold plus its fee, the floor plus its fee.
    const held = account ? reserved + feeOf(reserved, feeBps) : reserved;
    // AI holds stop at cap - floor, as in FairMeter.
    if (pastFloor(day.committed + held, this.cap, this.capFloor(at))) return refusal('daily_limit_reached', at, this.tier(day.committed));
    if (account) {
      // The hold plus its fee must leave the floor (with its fee) in available, as in FairMeter.
      const left = this.available.get(account);
      if (left === undefined || left < held + this.capFloor(at)) return refusal('balance_too_low', at, this.tier(day.committed));
      this.available.set(account, left - held);
    }
    const callId = randomUUID();
    const hold: Hold = {
      person: req.person, at: at.toISOString(), sku: req.sku, provider: file.provider, pricingVersion: `${req.sku}@${version.validFrom}`,
      price, max: req.max, reservedMicroUsd: reserved, paidBy: req.paidBy ?? 'paid', ...(account ? { account, feeBps } : {}),
    };
    day.committed += held;
    this.open.add(callId);
    return { ok: true, tier: this.tier(day.committed), callId, hold };
  }

  async record(call: Reservation, usage: AttemptUsage): Promise<RecordOutcome> {
    this.calls.push({ method: 'record', args: [call, usage] });
    let r;
    try {
      r = settlementRecord({ appId: 'fake', env: 'test', billing: this.options.hosted ? { walletTable: 'fake' } : 'none' }, call, usage);
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
    const w = r.wallet;
    // The hold back, the charge spent, on the hold's own account.
    if (w) this.available.set(w.account, (this.available.get(w.account) ?? 0) + w.heldMicroUsd! - (r.release ? 0 : w.chargedMicroUsd));
    const day = this.row(r.sub, r.requestTime.slice(0, 10));
    const held = w?.heldMicroUsd ?? r.reservedMicroUsd!;
    if (r.release) {
      day.committed -= held;
      return 'recorded';
    }
    const fee = w?.feeMicroUsd ?? 0;
    day.committed += r.costMicroUsd + fee - held;
    for (const row of [day, this.row(r.sub, r.requestTime.slice(0, 7))]) {
      row.cost += r.costMicroUsd;
      row.absorbed += absorbedOf(r);
      row.fee += fee;
    }
    return 'recorded';
  }

  async usage(person: string): Promise<PersonUsage> {
    this.calls.push({ method: 'usage', args: [person] });
    const at = this.now();
    const day = this.row(person, utcDay(at));
    const month = this.row(person, utcMonth(at));
    // Hosted: the charges apart, cost (minus absorbed) and fee, as in FairMeter.
    const apart = (row: Row) => (this.options.hosted ? { costMicroUsd: row.cost - row.absorbed, feeMicroUsd: row.fee } : {});
    return {
      day: {
        ...apart(day),
        spentMicroUsd: day.cost - day.absorbed + day.fee,
        heldMicroUsd: Math.max(0, day.committed - day.cost - day.fee),
        capMicroUsd: this.cap,
        roomMicroUsd: Math.max(0, this.cap - day.committed),
        resetsAt: nextUtcDay(at),
      },
      month: { ...apart(month), spentMicroUsd: month.cost - month.absorbed + month.fee, resetsAt: nextUtcMonth(at) },
      tier: this.tier(day.committed),
      readOnly: this.options.actions !== undefined && pastFloor(day.committed, this.cap, this.capFloor(at)),
      ...(this.links.get(person) ? { wallet: { availableMicroUsd: this.available.get(this.links.get(person)!) ?? 0 } } : {}),
    };
  }

  action(req: { person: string; sku: string; n?: number }): void {
    this.calls.push({ method: 'action', args: [req] });
    const { person, sku, n = 1 } = req ?? {};
    if (typeof person !== 'string' || !person || !this.options.actions?.skus.includes(sku) || !Number.isInteger(n) || n < 1 || n > this.options.actions.perPersonPerMinute
      || (this.options.hosted && !this.links.get(person))) {
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
    const unlinked = this.unlinked(person, at);
    if (unlinked) return unlinked;
    if (pastFloor(committed, this.cap, this.capFloor(at))) return refusal('daily_limit_reached', at, this.tier(committed));
    const account = this.links.get(person);
    if (account && !((this.available.get(account) ?? -1) >= this.capFloor(at))) return refusal('balance_too_low', at, this.tier(committed));
    return { ok: true };
  }

  /** Hosted: a person with no link here (account_not_linked) or a conflicting one (link_conflict). */
  private unlinked(person: string, at: Date): Refusal | undefined {
    if (!this.options.hosted || this.links.get(person)) return undefined;
    return refusal(this.links.has(person) ? 'link_conflict' : 'account_not_linked', at);
  }

  /** Hosted: the floor plus its fee, what AI holds must leave in available and under the daily cap (charged amounts). */
  private capFloor(at: Date): number {
    return this.options.hosted ? this.floor + feeOf(this.floor, feeAt(at).feeBps) : this.floor;
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
    if (!row) this.rows.set(key, (row = { committed: 0, cost: 0, absorbed: 0, fee: 0 }));
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
  const known = tier && !['pricing_not_configured', 'metering_unavailable', 'account_not_linked', 'link_conflict'].includes(error) ? { tier } : {};
  if (error === 'too_many_requests') return { ok: false, status: 429, body: { error, retryAfterSeconds }, headers: { 'Retry-After': String(retryAfterSeconds) }, ...known };
  if (error === 'balance_too_low') return { ok: false, status: 402, body: { error, topUpUrl: TOP_UP_URL }, headers: {}, ...known };
  if (error === 'account_not_linked' || error === 'link_conflict') return { ok: false, status: 403, body: { error }, headers: {} };
  const resetsAt = error === 'daily_limit_reached' || error === 'service_paused' ? { resetsAt: nextUtcDay(at) } : {};
  return { ok: false, status: error === 'daily_limit_reached' ? 429 : 503, body: { error, ...resetsAt }, headers: {}, ...known };
}
