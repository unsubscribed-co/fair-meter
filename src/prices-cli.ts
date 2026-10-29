import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { formatUsd } from './cost';
import { setTableKeys, skOf, tableKeys } from './keys';
import { parseValidFrom, planNewVersion, priceShape, versionRanges, type PriceShape } from './pricing';
import { parseFlags } from './report';
import { isProvider } from './usage';

/*
 * Prices have one home: the files in prices/, one per SKU, each version immutable once stored.
 *
 *   npx tsx node_modules/fair-meter/src/prices-cli.ts sync --table <name> [--keys pk,sk] [--dry-run]
 *       Puts every version that isn't in the table yet, closing the previous version's range in the
 *       same transaction. A stored version with other values is refused (nothing is written); so is
 *       a new version that starts before one already stored.
 *   npx tsx node_modules/fair-meter/src/prices-cli.ts price-history <sku> --table <name> [--keys pk,sk]
 *
 * Credentials: the AWS SDK's usual chain (AWS_PROFILE, ...).
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

const RATE_FIELDS: Record<PriceShape, string[]> = {
  tokens: ['inputMicroUsdPerMTok', 'cachedInputMicroUsdPerMTok', 'outputMicroUsdPerMTok', 'cacheWriteMicroUsdPerMTok', 'reasoningMicroUsdPerMTok', 'tiers', 'bands'],
  chars: ['microUsdPerMChars'],
  units: ['microUsdPerKUnits'],
  requests: ['microUsdPerRequest'],
};

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
    if (typeof v.validFrom !== 'string' || parseValidFrom(v.validFrom) !== v.validFrom || !v.validFrom.includes('T')) fail(`${at}: validFrom must be YYYY-MM-DDTHH:MM:SSZ`);
    if (v.validFrom <= previous) fail(`${at}: versions must be in order, oldest first`);
    previous = v.validFrom;
    if (typeof v.source !== 'string' || !v.source.startsWith('https://')) fail(`${at}: source must be the https URL of the provider's pricing page`);
    const unknown = Object.keys(v).filter((k) => k !== 'validFrom' && k !== 'source' && !RATE_FIELDS[f.unit].includes(k));
    if (unknown.length) fail(`${at}: unknown fields ${unknown.join(', ')}`);
    if (priceShape({ provider: f.provider, ...v }) !== f.unit) fail(`${at}: rates are malformed or not ${f.unit}`);
  }
  return { sku, ...f };
}

export function loadPriceFiles(dir = PRICES_DIR): PriceFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => parsePriceFile(n.slice(0, -'.json'.length), readFileSync(path.join(dir, n), 'utf8')));
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
        : item.microUsdPerKUnits !== undefined ? `${formatUsd(item.microUsdPerKUnits)}/1,000 units`
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
  const { positional, flags } = parseFlags(rest, { values: ['table', 'keys'], booleans: ['dry-run'] });
  const usage = 'sync --table <name> [--keys pk,sk] [--dry-run]  |  price-history <sku> --table <name> [--keys pk,sk]';
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
