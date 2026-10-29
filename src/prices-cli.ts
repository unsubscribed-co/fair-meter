import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { computeUnitCost, formatUsd, METER_NAMES, type Meters } from './cost';
import { setTableKeys, skOf, tableKeys } from './keys';
import { parseValidFrom, planNewVersion, priceCall, priceShape, pricingTime, versionRanges, type PriceShape } from './pricing';
import { checkAppId, parseFlags } from './report';
import { isProvider } from './usage';

/*
 * Prices have one home: the files in prices/, one per SKU, each version immutable once stored.
 *
 *   npx tsx node_modules/fair-meter/src/prices-cli.ts sync --table <name> [--keys pk,sk] [--dry-run]
 *       Puts every version that isn't in the table yet, closing the previous version's range in the
 *       same transaction. A stored version with other values is refused (nothing is written); so is
 *       a new version that starts before one already stored.
 *   npx tsx node_modules/fair-meter/src/prices-cli.ts price-history <sku> --table <name> [--keys pk,sk]
 *   npx tsx node_modules/fair-meter/src/prices-cli.ts list <app> [--write --valid-from <iso>]
 *       Prices each action in prices/apps/<app>.json at AWS's public Price List (no credentials),
 *       plus the fee. --write appends a version to each SKU whose rates changed and writes
 *       prices/apps/<app>.list.json.
 *   npx tsx node_modules/fair-meter/src/prices-cli.ts measure <app> --log-group <dev group> --start <iso> --end <iso>
 *       Averages what each action used in dev (measure mode's action lines, Lambda's reports, the
 *       bytes logged) into prices/apps/<app>.json, keeping its profiles. Needs @aws-sdk/client-cloudwatch-logs.
 *
 * Credentials (sync, price-history, measure with dev's): the AWS SDK's usual chain (AWS_PROFILE, ...).
 */

export const PRICES_DIR = path.join(__dirname, '..', 'prices');

export interface PriceFile {
  sku: string;
  /** The provider whose usage adapter and PROVIDER# counter the SKU uses. */
  provider: string;
  unit: PriceShape;
  /** Oldest first. Rates in the fields PRICING items use; `source` is the provider's pricing page. */
  versions: ({ validFrom: string; source: string } & Record<string, unknown>)[];
}

/** An action SKU's breakdown of microUsdPerKUnits, each integer micro-USD per 1,000 actions. */
const COMPONENTS = ['database', 'api', 'compute', 'logs', 'other'];

const RATE_FIELDS: Record<PriceShape, string[]> = {
  tokens: ['inputMicroUsdPerMTok', 'cachedInputMicroUsdPerMTok', 'outputMicroUsdPerMTok', 'cacheWriteMicroUsdPerMTok', 'reasoningMicroUsdPerMTok', 'tiers', 'bands'],
  chars: ['microUsdPerMChars'],
  units: ['microUsdPerKUnits', 'components'],
  requests: ['microUsdPerRequest'],
};

const isCanonical = (t: unknown): t is string => typeof t === 'string' && t.includes('T') && parseValidFrom(t) === t;

/** One prices/<sku>.json, checked strictly: a typo must not become a price. */
export function parsePriceFile(sku: string, text: string): PriceFile {
  const f = JSON.parse(text) as Omit<PriceFile, 'sku'>;
  const fail = (why: string) => { throw new Error(`prices/${sku}.json: ${why}`); };
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(sku)) fail('the file name is not a SKU');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(f.provider ?? '')) fail('provider must be a lowercase name');
  if (!(f.unit in RATE_FIELDS)) fail(`unit must be one of ${Object.keys(RATE_FIELDS).join(', ')}`);
  if (f.unit === 'tokens' && !isProvider(f.provider)) fail(`no usage adapter for provider ${f.provider}`);
  if (!Array.isArray(f.versions) || f.versions.length === 0) fail('versions must be a non-empty array');
  let previous = '';
  for (const v of f.versions) {
    const at = `version ${v.validFrom}`;
    if (!isCanonical(v.validFrom)) fail(`${at}: validFrom must be YYYY-MM-DDTHH:MM:SSZ`);
    if (v.validFrom <= previous) fail(`${at}: versions must be in order, oldest first`);
    previous = v.validFrom;
    if (typeof v.source !== 'string' || !v.source.startsWith('https://')) fail(`${at}: source must be the https URL of the provider's pricing page`);
    const unknown = Object.keys(v).filter((k) => k !== 'validFrom' && k !== 'source' && !RATE_FIELDS[f.unit].includes(k));
    if (unknown.length) fail(`${at}: unknown fields ${unknown.join(', ')}`);
    if (priceShape({ provider: f.provider, ...v }) !== f.unit) fail(`${at}: rates are malformed or not ${f.unit}`);
    if (v.components !== undefined) {
      const c = v.components as Record<string, unknown>;
      const exact = typeof c === 'object' && c !== null && Object.keys(c).sort().join() === [...COMPONENTS].sort().join() &&
        COMPONENTS.every((k) => Number.isSafeInteger(c[k]) && (c[k] as number) >= 0);
      if (!exact) fail(`${at}: components must be exactly ${COMPONENTS.join(', ')}, each integer micro-USD per 1,000`);
      if (COMPONENTS.reduce((sum, k) => sum + (c[k] as number), 0) !== v.microUsdPerKUnits) fail(`${at}: components must sum to microUsdPerKUnits`);
    }
  }
  return { sku, ...f };
}

export function loadPriceFiles(dir = PRICES_DIR): PriceFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n !== FEE_FILE)
    .sort()
    .map((n) => parsePriceFile(n.slice(0, -'.json'.length), readFileSync(path.join(dir, n), 'utf8')));
}

/**
 * The fee's one home: prices/fee.json, versioned like a price, in basis points of cost (10000 = 100%).
 * Nothing at runtime applies it yet: billing 'none' means no fee, and 'hosted' is refused.
 */
export interface FeeFile {
  /** Oldest first. */
  versions: { validFrom: string; feeBps: number }[];
}

const FEE_FILE = 'fee.json';

export function parseFeeFile(text: string): FeeFile {
  const f = JSON.parse(text) as FeeFile;
  const fail = (why: string) => { throw new Error(`prices/${FEE_FILE}: ${why}`); };
  if (!Array.isArray(f.versions) || f.versions.length === 0) fail('versions must be a non-empty array');
  let previous = '';
  for (const v of f.versions) {
    const at = `version ${v.validFrom}`;
    if (!isCanonical(v.validFrom)) fail(`${at}: validFrom must be YYYY-MM-DDTHH:MM:SSZ`);
    if (v.validFrom <= previous) fail(`${at}: versions must be in order, oldest first`);
    previous = v.validFrom;
    if (Object.keys(v).sort().join() !== 'feeBps,validFrom') fail(`${at}: a version is exactly validFrom and feeBps`);
    if (!Number.isInteger(v.feeBps) || v.feeBps < 0 || v.feeBps > 10_000) fail(`${at}: feeBps must be an integer from 0 to 10000`);
  }
  return f;
}

/** The fee version valid at `at`. */
export function feeAt(at: Date, fee = parseFeeFile(readFileSync(path.join(PRICES_DIR, FEE_FILE), 'utf8'))): FeeFile['versions'][number] {
  const t = pricingTime(at);
  const version = [...fee.versions].reverse().find((v) => v.validFrom <= t);
  if (!version) throw new Error(`prices/${FEE_FILE}: no fee version at ${t}`);
  return version;
}

/** A new version's least lead time: twice FairMeter's 5-minute price cache. */
const MIN_LEAD_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// The price list: an app's measured usage per action times AWS's public Price List, plus the fee.

export const OFFER_SERVICES = ['AmazonDynamoDB', 'AWSLambda', 'AmazonApiGateway', 'AmazonCloudWatch'] as const;
type OfferService = typeof OFFER_SERVICES[number];

export const PRICE_LIST_SOURCE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json';
const offerUrl = (service: OfferService, region: string) => `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/${region}/index.json`;

/** Each rate the list needs: its product (usage type without the region prefix, and group) and the unit AWS prices it in. */
const RATE_PRODUCTS = {
  readRequestUnit: { service: 'AmazonDynamoDB', usage: 'ReadRequestUnits', group: 'DDB-ReadUnits', unit: 'ReadRequestUnits' },
  writeRequestUnit: { service: 'AmazonDynamoDB', usage: 'WriteRequestUnits', group: 'DDB-WriteUnits', unit: 'WriteRequestUnits' },
  armRequest: { service: 'AWSLambda', usage: 'Request-ARM', group: 'AWS-Lambda-Requests-ARM', unit: 'Requests' },
  armGbSecond: { service: 'AWSLambda', usage: 'Lambda-GB-Second-ARM', group: 'AWS-Lambda-Duration-ARM', unit: 'Lambda-GB-Second' },
  httpApiRequest: { service: 'AmazonApiGateway', usage: 'ApiGatewayHttpRequest', group: undefined, unit: 'Requests' },
  logIngestedGb: { service: 'AmazonCloudWatch', usage: 'DataProcessing-Bytes', group: 'Ingested Logs', unit: 'GB' },
  logScannedGb: { service: 'AmazonCloudWatch', usage: 'DataScanned-Bytes', group: 'Queried Logs', unit: 'GB' },
} as const;
export type Rates = Record<keyof typeof RATE_PRODUCTS, string>;

/**
 * The first-tier on-demand list rate of each product, in USD per unit as the offer file writes it.
 * A tier priced 0 is a free tier and skipped. A rate missing or ambiguous stops the run, naming it.
 */
export function extractRates(offers: Record<string, any>): Rates {
  const rates = {} as Rates;
  for (const [name, want] of Object.entries(RATE_PRODUCTS) as [keyof Rates, typeof RATE_PRODUCTS[keyof Rates]][]) {
    const offer = offers[want.service];
    const usage = new RegExp(`^([A-Z0-9]+-)?${want.usage}$`);
    const found = new Set<string>();
    for (const [sku, product] of Object.entries<any>(offer.products ?? {})) {
      if (!usage.test(product.attributes?.usagetype) || product.attributes?.group !== want.group) continue;
      const dims = Object.values<any>(offer.terms?.OnDemand?.[sku] ?? {}).flatMap((t) => Object.values<any>(t.priceDimensions))
        .filter((d) => d.unit === want.unit && Number(d.pricePerUnit?.USD) > 0)
        .sort((a, b) => Number(a.beginRange) - Number(b.beginRange));
      if (dims.length) found.add(dims[0].pricePerUnit.USD);
    }
    if (found.size !== 1) throw new Error(`${name}: ${found.size ? `ambiguous (${[...found].join(', ')})` : 'not'} in the ${want.service} Price List`);
    rates[name] = [...found][0];
  }
  return rates;
}

/** The region's offer files, public: no credentials. */
export async function fetchOffers(region: string): Promise<Record<OfferService, any>> {
  return Object.fromEntries(await Promise.all(OFFER_SERVICES.map(async (s) => {
    const res = await fetch(offerUrl(s, region));
    if (!res.ok) throw new Error(`${offerUrl(s, region)}: HTTP ${res.status}`);
    return [s, await res.json()];
  }))) as Record<OfferService, any>;
}

const MEASURED = ['rru', 'wru', 'apiRequests', 'lambdaRequests', 'billedMs', 'memoryMb', 'logBytes', 'samples', 'measuredAt'] as const;
const PROFILES = ['light', 'regular', 'heavy'] as const;

/** prices/apps/<app>.json: the app's measured averages per action SKU, and three user profiles. */
export interface AppFile {
  region: string;
  /** Averages per action from `samples` measured requests (measuredAt is when). */
  actions: Record<string, Record<Exclude<typeof MEASURED[number], 'measuredAt'>, number> & { measuredAt: string }>;
  /** Per profile: actions a day per action SKU; AI calls a day per SKU with the average meters of one call. */
  profiles: Record<typeof PROFILES[number], {
    actions: Record<string, number>;
    ai: Record<string, { callsPerDay: number; meters: Partial<Meters> }>;
  }>;
}

export function parseAppFile(app: string, text: string): AppFile {
  const f = JSON.parse(text) as AppFile;
  const fail = (why: string): never => { throw new Error(`prices/apps/${app}.json: ${why}`); };
  const exactly = (o: unknown, keys: readonly string[], what: string) => {
    if (typeof o !== 'object' || o === null || Object.keys(o).sort().join() !== [...keys].sort().join()) fail(`${what} must be exactly ${keys.join(', ')}`);
  };
  const isObject = (o: unknown): o is Record<string, any> => typeof o === 'object' && o !== null && !Array.isArray(o);
  const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  exactly(f, ['region', 'actions', 'profiles'], 'the file');
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(f.region)) fail('region must be an AWS region code');
  if (!isObject(f.actions) || !Object.keys(f.actions).length) fail('actions must name at least one action SKU');
  for (const [sku, m] of Object.entries(f.actions)) {
    exactly(m, MEASURED, `actions.${sku}`);
    for (const k of MEASURED.slice(0, -2)) if (typeof m[k] !== 'number' || !(m[k] >= 0) || !Number.isFinite(m[k])) fail(`actions.${sku}.${k} must be a number, 0 or more`);
    if (!Number.isSafeInteger(m.samples) || m.samples < 1) fail(`actions.${sku}.samples must be a whole number, 1 or more`);
    if (!isCanonical(m.measuredAt)) fail(`actions.${sku}.measuredAt must be YYYY-MM-DDTHH:MM:SSZ`);
  }
  exactly(f.profiles, PROFILES, 'profiles');
  for (const name of PROFILES) {
    const p = f.profiles[name];
    exactly(p, ['actions', 'ai'], `profiles.${name}`);
    if (!isObject(p.actions) || !isObject(p.ai)) fail(`profiles.${name}: actions and ai must be objects`);
    for (const [sku, n] of Object.entries(p.actions)) {
      if (!(sku in f.actions)) fail(`profiles.${name}.actions.${sku} was not measured`);
      if (!isCount(n)) fail(`profiles.${name}.actions.${sku} must be a whole number a day`);
    }
    for (const [sku, call] of Object.entries(p.ai)) {
      exactly(call, ['callsPerDay', 'meters'], `profiles.${name}.ai.${sku}`);
      if (!isCount(call.callsPerDay)) fail(`profiles.${name}.ai.${sku}.callsPerDay must be a whole number`);
      if (!isObject(call.meters) || !Object.entries(call.meters).every(([k, v]) => (METER_NAMES as readonly string[]).includes(k) && isCount(v))) {
        fail(`profiles.${name}.ai.${sku}.meters must be whole numbers of ${METER_NAMES.join(', ')}`);
      }
    }
  }
  return f;
}

/** A JSON number or a Price List decimal as an exact fraction n / 10^scale (no float rounding on money). */
function exact(v: number | string): [bigint, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(v));
  if (!m) throw new Error(`not a decimal: ${v}`);
  const frac = m[2] ?? '';
  const scale = frac.length - Number(m[3] ?? 0);
  const n = BigInt(m[1] + frac);
  return scale < 0 ? [n * 10n ** BigInt(-scale), 0] : [n, scale];
}

/** The sum of products of factors, times 1,000 actions, in micro-USD rounded up. */
function microUsdPerK(...terms: (number | string)[][]): number {
  const fractions = terms.map((t) => t.map(exact).reduce(([n, s], [m, r]) => [n * m, s + r], [1_000n * 1_000_000n, 0] as [bigint, number]));
  const scale = Math.max(...fractions.map(([, s]) => s));
  const sum = fractions.reduce((acc, [n, s]) => acc + n * 10n ** BigInt(scale - s), 0n);
  const d = 10n ** BigInt(scale);
  return Number((sum + d - 1n) / d);
}

/** Exact decimals: AWS bills log data per GB of 2^30 bytes, and Lambda per GB (1,024 MB) second. */
const PER_BYTE_GB = '0.000000000931322574615478515625';
const PER_MS_MB_GB_SECOND = '0.0000009765625';

/** One action's components at list rates, each integer micro-USD per 1,000 actions. */
function actionComponents(m: AppFile['actions'][string], r: Rates): Record<string, number> {
  return {
    // Every write first runs the write check: one eventually consistent read, half a read unit.
    database: microUsdPerK([m.rru, r.readRequestUnit], [0.5, r.readRequestUnit], [m.wru, r.writeRequestUnit]),
    api: microUsdPerK([m.apiRequests, r.httpApiRequest]),
    compute: microUsdPerK([m.lambdaRequests, r.armRequest], [m.billedMs, m.memoryMb, r.armGbSecond, PER_MS_MB_GB_SECOND]),
    // Ingested, then scanned once by the rollup's Logs Insights query.
    logs: microUsdPerK([m.logBytes, r.logIngestedGb, PER_BYTE_GB], [m.logBytes, r.logScannedGb, PER_BYTE_GB]),
    other: 0,
  };
}

export interface PriceList {
  app: string;
  region: string;
  at: string;
  feeBps: number;
  /** USD per unit, as the Price List writes them. */
  rates: Rates;
  actions: { sku: string; components: Record<string, number>; costMicroUsdPerK: number; feeMicroUsdPerK: number; priceMicroUsdPerK: number }[];
  profiles: Record<typeof PROFILES[number], {
    ai: { sku: string; callsPerDay: number; costMicroUsdPerCall: number }[];
    dailyCostMicroUsd: number;
    monthlyCostMicroUsd: number;
    monthlyPriceMicroUsd: number;
    /** How many days $2 lasts at the price with the fee. */
    daysFor2Usd: number;
  }>;
}

const MONTH_DAYS = 30;

/** The list: each action's components, cost, fee and price; per profile what a month costs and how long $2 lasts. */
export function priceList(app: string, file: AppFile, rates: Rates, skus: PriceFile[], now: Date, feeBps = feeAt(now).feeBps): PriceList {
  const actions = Object.entries(file.actions).map(([sku, m]) => {
    const components = actionComponents(m, rates);
    const cost = COMPONENTS.reduce((sum, k) => sum + components[k], 0);
    const price = computeUnitCost(1_000, cost, feeBps).costMicroUsd;
    return { sku, components, costMicroUsdPerK: cost, feeMicroUsdPerK: price - cost, priceMicroUsdPerK: price };
  });
  const t = pricingTime(now);
  const profiles = Object.fromEntries(PROFILES.map((name) => {
    const p = file.profiles[name];
    const ai = Object.entries(p.ai).map(([sku, call]) => {
      const version = skus.find((f) => f.sku === sku)?.versions.filter((v) => v.validFrom <= t).at(-1);
      if (!version) throw new Error(`profiles.${name}.ai.${sku}: no price version at ${t}`);
      const meters = Object.fromEntries(METER_NAMES.map((k) => [k, call.meters[k] ?? 0])) as unknown as Meters;
      const priced = priceCall(version, { meters }, now);
      if ('error' in priced) throw new Error(`profiles.${name}.ai.${sku}: ${priced.error}`);
      return { sku, callsPerDay: call.callsPerDay, costMicroUsdPerCall: priced.costMicroUsd };
    });
    const daily = Object.entries(p.actions).reduce((sum, [sku, n]) => sum + computeUnitCost(n, actions.find((a) => a.sku === sku)!.costMicroUsdPerK, 0).costMicroUsd, 0) +
      ai.reduce((sum, a) => sum + a.callsPerDay * a.costMicroUsdPerCall, 0);
    const dailyPrice = computeUnitCost(1_000, daily, feeBps).costMicroUsd;
    return [name, {
      ai,
      dailyCostMicroUsd: daily,
      monthlyCostMicroUsd: daily * MONTH_DAYS,
      monthlyPriceMicroUsd: dailyPrice * MONTH_DAYS,
      daysFor2Usd: Math.floor(2_000_000 / dailyPrice),
    }];
  })) as PriceList['profiles'];
  return { app, region: file.region, at: t, feeBps, rates, actions, profiles };
}

/** The list as printed: one line per action, then per profile its month and its AI lines. */
export function formatPriceList(l: PriceList): string {
  return [
    `${l.app} (${l.region}) at ${l.at}: AWS list rates, fee ${l.feeBps / 100}% of cost`,
    ...l.actions.map((a) => `${a.sku}  per 1,000: ${COMPONENTS.map((k) => `${k} ${formatUsd(a.components[k])}`).join(' ')}` +
      `  cost ${formatUsd(a.costMicroUsdPerK)}  fee ${formatUsd(a.feeMicroUsdPerK)}  price ${formatUsd(a.priceMicroUsdPerK)}`),
    '',
    ...PROFILES.flatMap((name) => {
      const p = l.profiles[name];
      return [
        `${name}  cost ${formatUsd(p.monthlyCostMicroUsd)}/month  price ${formatUsd(p.monthlyPriceMicroUsd)}/month  $2 lasts ${p.daysFor2Usd} days`,
        ...p.ai.map((a) => `  ${a.sku}  ${a.callsPerDay}/day at ${formatUsd(a.costMicroUsdPerCall)} a call`),
      ];
    }),
  ].join('\n');
}

/**
 * Appends a version starting at `validFrom` to each action SKU whose rates differ from its latest
 * version (creating the file for a new SKU), then writes prices/apps/<app>.list.json. Checks every
 * file before writing any. Returns the lines to print.
 */
export function writePriceList(dir: string, list: PriceList, validFrom: string, now: Date): string[] {
  // Instances cache price versions for 5 minutes: a version must not start inside that window.
  if (validFrom < pricingTime(new Date(now.getTime() + MIN_LEAD_MS))) throw new Error(`--valid-from ${validFrom} must be at least 10 minutes ahead`);
  const writes: [string, string][] = [];
  const lines: string[] = [];
  for (const a of list.actions) {
    const file = path.join(dir, `${a.sku}.json`);
    const current = existsSync(file) ? parsePriceFile(a.sku, readFileSync(file, 'utf8')) : undefined;
    const latest = current?.versions.at(-1);
    if (latest?.microUsdPerKUnits === a.costMicroUsdPerK && isDeepStrictEqual(latest.components, a.components)) {
      lines.push(`${a.sku} unchanged`);
      continue;
    }
    const { sku: _, ...body } = current ?? { sku: a.sku, provider: 'aws', unit: 'units' as const, versions: [] };
    const version = { validFrom, microUsdPerKUnits: a.costMicroUsdPerK, components: a.components, source: PRICE_LIST_SOURCE };
    const text = JSON.stringify({ ...body, versions: [...body.versions, version] }, null, 2) + '\n';
    parsePriceFile(a.sku, text);
    writes.push([file, text]);
    lines.push(`${a.sku}@${validFrom} added`);
  }
  writes.push([path.join(dir, 'apps', `${list.app}.list.json`), JSON.stringify({ validFrom, ...list }, null, 2) + '\n']);
  mkdirSync(path.join(dir, 'apps'), { recursive: true });
  for (const [file, text] of writes) writeFileSync(file, text);
  lines.push(`prices/apps/${list.app}.list.json written`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The measurement: what each action used in dev, from the app's own logs (see measureCapacity).

/** Logs Insights returns at most this many rows per query. */
const QUERY_LIMIT = 10_000;

/** A line's request id, in Lambda's text or JSON log format; raw stdout lines (the action line) have none. */
function requestIdOf(message: string, json: any): string | undefined {
  if (json) return json.requestId ?? json.record?.requestId;
  return (/^(?:START|END|REPORT) RequestId: (\S+)/.exec(message) ?? /^[^\t]+\t([0-9a-f-]{36})\t/.exec(message))?.[1];
}

/** Billed ms and memory MB from Lambda's report line, in either log format. */
function reportOf(message: string, json: any): { billedMs: number; memoryMb: number } | undefined {
  if (json?.type === 'platform.report') return { billedMs: json.record.metrics.billedDurationMs, memoryMb: json.record.metrics.memorySizeMB };
  const billed = /^REPORT .*Billed Duration: (\d+) ms/.exec(message);
  const memory = /Memory Size: (\d+) MB/.exec(message);
  return billed && memory ? { billedMs: Number(billed[1]), memoryMb: Number(memory[1]) } : undefined;
}

/**
 * Runs one Logs Insights query over the dev log group, groups its lines by request, and averages
 * per action SKU into prices/apps/<app>.json (a new file gets empty profiles; an existing one keeps
 * its region, profiles and the SKUs not measured this time). Returns the lines to print.
 */
export async function measureApp(
  logs: CloudWatchLogsClient, app: string, run: { logGroup: string; start: Date; end: Date }, now: Date, dir = PRICES_DIR,
): Promise<string[]> {
  // An optional peer: only measure needs it.
  const { StartQueryCommand, GetQueryResultsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupName: run.logGroup,
    startTime: Math.floor(run.start.getTime() / 1000),
    endTime: Math.ceil(run.end.getTime() / 1000),
    queryString: 'fields @timestamp, @logStream, @message | sort @timestamp asc',
    limit: QUERY_LIMIT,
  }));
  let reply;
  while ((reply = await logs.send(new GetQueryResultsCommand({ queryId }))).status !== 'Complete') {
    if (reply.status !== 'Running' && reply.status !== 'Scheduled') throw new Error(`Logs Insights query ${reply.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const results = reply.results ?? [];
  if (results.length >= QUERY_LIMIT) throw new Error(`${QUERY_LIMIT} lines or more: narrow --start and --end`);

  // Group by request. A line without a request id belongs to the request open in its log stream.
  // shortcut: one request at a time per log stream (a Lambda environment); revisit if dev runs multi-concurrency Lambda Managed Instances.
  type Request = { bytes: number; actions: { sku: string; n: number; rru?: number; wru?: number }[]; report?: { billedMs: number; memoryMb: number } };
  const requests = new Map<string, Request>();
  const open = new Map<string, string>();
  for (const row of results) {
    const field = (name: string) => row.find((f) => f.field === name)?.value ?? '';
    const message = field('@message');
    const stream = field('@logStream');
    let json: any;
    try { json = message.startsWith('{') ? JSON.parse(message) : undefined; } catch { /* a text line */ }
    const id = requestIdOf(message, json) ?? open.get(stream);
    if (!id) continue;
    open.set(stream, id);
    const r = requests.get(id) ?? { bytes: 0, actions: [] };
    requests.set(id, r);
    r.bytes += Buffer.byteLength(message);
    if (json?.fairMeter === 'action') r.actions.push(json);
    const report = reportOf(message, json);
    if (report) {
      r.report = report;
      open.delete(stream);
    }
  }

  // Per action: its own units, and an n-weighted share of its request (one API request, one invocation, its billed time and log bytes).
  const sums = new Map<string, { n: number; samples: number; rru: number; wru: number; units: boolean; requests: number; billedMs: number; memoryMbN: number; logBytes: number }>();
  for (const r of requests.values()) {
    if (!r.report || !r.actions.length) continue;
    const total = r.actions.reduce((sum, a) => sum + a.n, 0);
    for (const a of r.actions) {
      const s = sums.get(a.sku) ?? { n: 0, samples: 0, rru: 0, wru: 0, units: false, requests: 0, billedMs: 0, memoryMbN: 0, logBytes: 0 };
      sums.set(a.sku, s);
      const share = a.n / total;
      s.n += a.n;
      s.samples += 1;
      s.rru += a.rru ?? 0;
      s.wru += a.wru ?? 0;
      s.units ||= a.rru !== undefined || a.wru !== undefined;
      s.requests += share;
      s.billedMs += share * r.report.billedMs;
      s.memoryMbN += a.n * r.report.memoryMb;
      s.logBytes += share * r.bytes;
    }
  }
  if (!sums.size) throw new Error(`no action lines with a Lambda report in ${run.logGroup} between ${pricingTime(run.start)} and ${pricingTime(run.end)}`);
  // Averages round up to 3 decimals: a measurement must not underprice.
  const up = (x: number) => Math.ceil(Number((x * 1000).toPrecision(12))) / 1000;
  const measured: AppFile['actions'] = {};
  for (const [sku, s] of sums) {
    if (!s.units) throw new Error(`${sku}: no rru or wru on its action lines; wrap the app's DynamoDB client with measureCapacity in dev`);
    const avg = (x: number) => up(x / s.n);
    measured[sku] = {
      rru: avg(s.rru), wru: avg(s.wru), apiRequests: avg(s.requests), lambdaRequests: avg(s.requests),
      billedMs: avg(s.billedMs), memoryMb: avg(s.memoryMbN), logBytes: avg(s.logBytes), samples: s.samples, measuredAt: pricingTime(now),
    };
  }

  const file = path.join(dir, 'apps', `${app}.json`);
  const current = existsSync(file) ? parseAppFile(app, readFileSync(file, 'utf8')) : undefined;
  const empty = { actions: {}, ai: {} };
  const next: AppFile = {
    region: current?.region ?? await logs.config.region(),
    actions: { ...current?.actions, ...measured },
    profiles: current?.profiles ?? { light: empty, regular: empty, heavy: empty },
  };
  const text = JSON.stringify(next, null, 2) + '\n';
  parseAppFile(app, text);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return [...[...sums].map(([sku, s]) => `${sku}: ${s.samples} samples`), `prices/apps/${app}.json written`];
}

const itemOf = (f: PriceFile, v: PriceFile['versions'][number]) => ({ provider: f.provider, ...v });

/** A stored version as the file would write it: without its keys and the range close sync adds. */
function storedFacts(item: Record<string, unknown>) {
  const { [tableKeys().pk]: _pk, [tableKeys().sk]: _sk, validTo: _to, ...facts } = item;
  return facts;
}

async function versionsOf(ddb: DynamoDBDocumentClient, table: string, sku: string): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: `${tableKeys().pk} = :pk`,
      ExpressionAttributeValues: { ':pk': `PRICING#${sku}` },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Makes the table hold every version in `files`. Plans every SKU first and refuses before writing
 * anything if a stored version differs: versions are immutable, so a changed price is a new version.
 * Returns the lines it printed.
 */
export async function syncPrices(ddb: DynamoDBDocumentClient, table: string, files: PriceFile[], now: Date, dryRun: boolean): Promise<string[]> {
  const writes: { label: string; item: Record<string, unknown>; close?: { sk: string; validTo: string } }[] = [];
  const refused: string[] = [];
  const lines: string[] = [];
  for (const f of files) {
    const stored = await versionsOf(ddb, table, f.sku);
    // Backdating is only unsafe once calls were metered at an earlier version.
    const backdate = stored.length === 0;
    let latest = [...stored].sort((a, b) => (skOf(a) < skOf(b) ? -1 : 1)).at(-1);
    for (const v of f.versions) {
      const label = `${f.sku}@${v.validFrom}`;
      const item = itemOf(f, v);
      const existing = stored.find((s) => skOf(s) === v.validFrom);
      if (existing) {
        if (!isDeepStrictEqual(storedFacts(existing), item)) refused.push(`${label}: stored ${JSON.stringify(storedFacts(existing))}, file ${JSON.stringify(item)}`);
        continue;
      }
      try {
        const { closePrevious } = planNewVersion(latest, v.validFrom, now, backdate);
        if (!backdate && v.validFrom < pricingTime(new Date(now.getTime() + MIN_LEAD_MS))) {
          throw new Error(`starts less than 10 minutes after now (${pricingTime(now)}): FairMeter caches prices for 5 minutes, so a warm instance could still price calls at the old version`);
        }
        writes.push({ label, item, ...(closePrevious ? { close: { sk: closePrevious.sk, validTo: closePrevious.validTo } } : {}) });
        latest = { [tableKeys().sk]: v.validFrom, ...item };
      } catch (err) {
        refused.push(`${label}: ${(err as Error).message}`);
      }
    }
  }
  if (refused.length) throw new Error(`Refused; nothing written. Versions are immutable: add a new version instead.\n  ${refused.join('\n  ')}`);
  const say = (line: string) => { lines.push(line); console.log(line); };
  if (!writes.length) say('Prices are in sync.');
  const { pk, sk } = tableKeys();
  for (const w of writes) {
    const closing = w.close ? `; ${w.label.split('@')[0]}@${w.close.sk} ends at ${w.close.validTo}` : '';
    if (dryRun) {
      say(`would add ${w.label}${closing}`);
      continue;
    }
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: table, Item: { [pk]: `PRICING#${w.label.split('@')[0]}`, [sk]: w.item.validFrom, ...w.item }, ConditionExpression: `attribute_not_exists(${pk})` } },
        ...(w.close
          ? [{
              Update: {
                TableName: table,
                Key: { [pk]: `PRICING#${w.label.split('@')[0]}`, [sk]: w.close.sk },
                UpdateExpression: 'SET validTo = :to',
                ConditionExpression: `attribute_exists(${pk}) AND attribute_not_exists(validTo)`,
                ExpressionAttributeValues: { ':to': w.close.validTo },
              },
            }]
          : []),
      ],
    }));
    say(`${w.label} added${closing}`);
  }
  if (dryRun && writes.length) say('\nDry run. Re-run without --dry-run to write.');
  return lines;
}

/** One line per version: its range and rates. */
export function formatPriceHistory(sku: string, items: Record<string, any>[]): string {
  if (!items.length) return `No prices for ${sku}`;
  return versionRanges(items).map((range) => {
    const item = items.find((i) => skOf(i) === range.sk)!;
    const rates = item.microUsdPerMChars !== undefined ? `${formatUsd(item.microUsdPerMChars)}/1M chars`
      : item.microUsdPerRequest !== undefined ? `${formatUsd(item.microUsdPerRequest)}/request`
        : item.microUsdPerKUnits !== undefined ? `${formatUsd(item.microUsdPerKUnits)}/1,000 units` +
          (item.components ? ` (${COMPONENTS.map((k) => `${k} ${formatUsd(item.components[k])}`).join(' ')})` : '')
          : `in ${formatUsd(item.inputMicroUsdPerMTok)} cached ${formatUsd(item.cachedInputMicroUsdPerMTok)} out ${formatUsd(item.outputMicroUsdPerMTok)} /1M` +
            (item.cacheWriteMicroUsdPerMTok !== undefined ? ` cache-write ${formatUsd(item.cacheWriteMicroUsdPerMTok)}` : '') +
            (item.reasoningMicroUsdPerMTok !== undefined ? ` reasoning ${formatUsd(item.reasoningMicroUsdPerMTok)}` : '') +
            (item.tiers?.length ? ` tiers ${item.tiers.map((t: any) => `>${t.aboveInputTokens}`).join(',')}` : '') +
            (item.bands?.length ? ` bands ${item.bands.map((b: any) => b.name).join(',')}` : '');
    return `${sku}@${range.sk}  [${range.validFrom} .. ${range.validTo ?? 'open'})${range.derived ? ' (derived)' : ''}  ${rates}` +
      (item.provider ? `  ${item.provider}` : '');
  }).join('\n');
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseFlags(rest, { values: ['table', 'keys', 'valid-from', 'log-group', 'start', 'end'], booleans: ['dry-run', 'write'] });
  const usage = 'sync --table <name> [--keys pk,sk] [--dry-run]  |  price-history <sku> --table <name> [--keys pk,sk]  |  list <app> [--write --valid-from <iso>]' +
    '  |  measure <app> --log-group <name> --start <iso> --end <iso>';
  if (command === 'measure') {
    if (positional.length !== 1 || typeof flags['log-group'] !== 'string' || typeof flags.start !== 'string' || typeof flags.end !== 'string') throw new Error(`Usage: ${usage}`);
    const [start, end] = [flags.start, flags.end].map((t) => new Date(parseValidFrom(t)));
    if (start >= end) throw new Error('--start must be before --end');
    const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
    for (const line of await measureApp(new CloudWatchLogsClient({}), checkAppId(positional[0]), { logGroup: flags['log-group'], start, end }, new Date())) console.log(line);
    return;
  }
  if (command === 'list') {
    if (positional.length !== 1 || (flags.write === true) !== (typeof flags['valid-from'] === 'string')) throw new Error(`Usage: ${usage}`);
    const app = checkAppId(positional[0]);
    const file = parseAppFile(app, readFileSync(path.join(PRICES_DIR, 'apps', `${app}.json`), 'utf8'));
    const now = new Date();
    const list = priceList(app, file, extractRates(await fetchOffers(file.region)), loadPriceFiles(), now);
    console.log(formatPriceList(list));
    if (flags.write) for (const line of writePriceList(PRICES_DIR, list, parseValidFrom(flags['valid-from'] as string), now)) console.log(line);
    return;
  }
  if (typeof flags.table !== 'string') throw new Error(`--table is required. Usage: ${usage}`);
  if (typeof flags.keys === 'string') {
    const [pk, sk] = flags.keys.split(',');
    setTableKeys({ pk, sk });
  }
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  if (command === 'sync' && !positional.length) {
    await syncPrices(ddb, flags.table, loadPriceFiles(), new Date(), flags['dry-run'] === true);
  } else if (command === 'price-history' && positional.length === 1) {
    console.log(formatPriceHistory(positional[0], await versionsOf(ddb, flags.table, positional[0])));
  } else {
    throw new Error(`Usage: ${usage}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.name === 'TransactionCanceledException' ? `Refused: ${err.message}` : err.message ?? err);
    process.exit(1);
  });
}
