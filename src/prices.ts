import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { METER_NAMES, type Meters } from './cost';
import { parseValidFrom, priceShape, pricingTime, type PriceShape } from './pricing';
import { isProvider } from './usage';

/*
 * Prices have one home: the files in prices/, one per SKU, each version immutable once stored, plus
 * the fee (prices/fee.json) and each app's measurement (prices/apps/<app>.json). Loading and parsing
 * them, and finding the version valid at a time; no AWS SDK, so cdk.ts and testing.ts load it too.
 * The price CLI (prices-cli.ts) syncs, lists and measures.
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
export const COMPONENTS = ['database', 'api', 'compute', 'logs', 'other'];

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

const MEASURED = ['rru', 'wru', 'apiRequests', 'lambdaRequests', 'billedMs', 'memoryMb', 'logBytes', 'samples', 'measuredAt'] as const;
export const PROFILES = ['light', 'regular', 'heavy'] as const;

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
