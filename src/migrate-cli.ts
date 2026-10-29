import { isDeepStrictEqual } from 'node:util';
import { DynamoDBClient, GetItemCommand, ScanCommand, TransactWriteItemsCommand, type AttributeValue, type TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { DEFAULT_TABLE_KEYS } from './keys';
import { checkAppId, parseFlags } from './report';

/*
 * Copies an app table's ledger rows for one app into Metering's own ledger table (v0.3.0).
 *
 *   npx tsx node_modules/fair-meter/src/migrate-cli.ts migrate --from <app table> [--from-keys pk,sk]
 *       [--from-user-prefix USER#] --to <ledger table> --app <appId> [--apply]
 *
 * Reads the source only. Dry run by default (counts per family); --apply writes each row in its own
 * transaction with a MIGRATION#<from table> marker, so a re-run copies nothing twice. Exit code 1 on
 * any refusal. Credentials: the AWS SDK's usual chain (AWS_PROFILE, ...).
 */

type Item = Record<string, AttributeValue>;
/** Counters are merged with ADD (the live app may have started the same row); the rest are put only if absent. */
type Family = { name: string; counter: boolean };
export const FAMILIES = ['DAILY', 'USAGE', 'EVENT', 'ADJUST', 'APP', 'GLOBAL', 'PENDING', 'PRICING', 'PROVIDER'];

export interface MigrateArgs {
  from: string;
  /** The source table's key attribute names (default PK, SK). */
  fromKeys?: { pk: string; sk: string };
  /** The source table's user partition prefix (default USER#). */
  fromUserPrefix?: string;
  to: string;
  app: string;
  apply?: boolean;
}

/** The family of one source row for `app`, or undefined for a row the migration leaves alone (RATE#, the app's own rows, other apps). */
export function familyOf(pk: string, sk: string, app: string, userPrefix: string): Family | undefined {
  const [kind, second, third] = sk.split('#');
  if (pk.startsWith(userPrefix)) {
    if ((kind === 'DAILY' || kind === 'USAGE') && second === app && third !== undefined) return { name: kind, counter: true };
    // EVENT#<iso-ms>#<app>#<requestId>, ADJUST#<iso-ms>#<app>#<adjId>
    if ((kind === 'EVENT' || kind === 'ADJUST') && third === app) return { name: kind, counter: false };
    return undefined;
  }
  if (pk === `APP#${app}`) return { name: 'APP', counter: true };
  if (pk === 'GLOBAL') return { name: 'GLOBAL', counter: true };
  if (pk === `PENDING#${app}`) return { name: 'PENDING', counter: false };
  if (pk.startsWith('PRICING#')) return { name: 'PRICING', counter: false };
  if (pk.startsWith('PROVIDER#')) {
    if (kind === 'DAILY' || kind === 'MONTH') return { name: 'PROVIDER', counter: true };
    if (kind === 'BALANCE') return { name: 'PROVIDER', counter: false };
  }
  return undefined;
}

/** Scans `from` (read only, consistent, paginated) and copies `app`'s ledger rows into `to` when `apply`. Returns the lines it printed and the refusals. */
export async function migrate(ddb: DynamoDBClient, args: MigrateArgs): Promise<{ lines: string[]; refused: string[] }> {
  const app = checkAppId(args.app);
  const { pk: fromPk, sk: fromSk } = args.fromKeys ?? DEFAULT_TABLE_KEYS;
  const userPrefix = args.fromUserPrefix ?? DEFAULT_TABLE_KEYS.userPrefix;
  const counts = new Map<string, number>(FAMILIES.map((f) => [f, 0]));
  const refused: string[] = [];
  const lines: string[] = [];
  const say = (line: string) => { lines.push(line); console.log(line); };
  let skipped = 0;
  let copied = 0;
  let already = 0;

  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: args.from,
      ConsistentRead: true,
      // A coarse filter on the partition; familyOf decides each row.
      FilterExpression: 'begins_with(#pk, :user) OR #pk IN (:app, :global, :pending) OR begins_with(#pk, :pricing) OR begins_with(#pk, :provider)',
      ExpressionAttributeNames: { '#pk': fromPk },
      ExpressionAttributeValues: {
        ':user': { S: userPrefix }, ':app': { S: `APP#${app}` }, ':global': { S: 'GLOBAL' }, ':pending': { S: `PENDING#${app}` },
        ':pricing': { S: 'PRICING#' }, ':provider': { S: 'PROVIDER#' },
      },
      ExclusiveStartKey,
    }));
    for (const item of page.Items ?? []) {
      const pk = item[fromPk]?.S ?? '';
      const sk = item[fromSk]?.S ?? '';
      const family = familyOf(pk, sk, app, userPrefix);
      if (!family) {
        skipped++;
        continue;
      }
      counts.set(family.name, counts.get(family.name)! + 1);
      if (!args.apply) continue;
      const { [fromPk]: _pk, [fromSk]: _sk, ...attributes } = item;
      const key: Item = { PK: { S: pk.startsWith(userPrefix) ? `USER#${pk.slice(userPrefix.length)}` : pk }, SK: { S: sk } };
      const outcome = await copyRow(ddb, args.from, args.to, `${pk}#${sk}`, key, attributes, family);
      if (outcome === 'copied') copied++;
      else if (outcome === 'already') already++;
      else refused.push(`${pk} ${sk}: ${outcome}`);
    }
    skipped += (page.ScannedCount ?? 0) - (page.Count ?? 0);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  say(`${[...counts].map(([f, n]) => `${f} ${n}`).join(', ')} (${total} rows; ${skipped} others skipped)`);
  if (!args.apply) {
    say('Dry run. Re-run with --apply to write.');
    return { lines, refused };
  }
  for (const r of refused) say(`Refused ${r}`);
  say(`${copied} copied, ${already} already copied, ${refused.length} refused.`);
  return { lines, refused };
}

/**
 * Writes one row and its marker in one transaction. 'already' = the marker exists (copied by an
 * earlier run) or the immutable row is in the ledger table with the same values (a PRICING row's
 * validTo aside: a newer sync closes a version); any other string is why the row was refused (an
 * immutable row with other values is never overwritten).
 */
async function copyRow(ddb: DynamoDBClient, from: string, to: string, markerSk: string, key: Item, attributes: Item, { name, counter }: Family): Promise<'copied' | 'already' | string> {
  const marker = { Put: { TableName: to, Item: { PK: { S: `MIGRATION#${from}` }, SK: { S: markerSk }, migratedAt: { S: new Date().toISOString() } }, ConditionExpression: 'attribute_not_exists(PK)' } };
  const names = Object.keys(attributes);
  // shortcut: every number on a counter row is added, so a SET-once number (free tier's share count) would be summed; Metering's apps write none.
  const add = names.filter((n) => 'N' in attributes[n] || 'NS' in attributes[n] || 'SS' in attributes[n]);
  const set = names.filter((n) => !add.includes(n));
  const at = (n: string) => names.indexOf(n);
  const write = counter
    ? {
        Update: {
          TableName: to,
          Key: key,
          UpdateExpression: [
            add.length ? `ADD ${add.map((n) => `#a${at(n)} :a${at(n)}`).join(', ')}` : '',
            set.length ? `SET ${set.map((n) => `#a${at(n)} = if_not_exists(#a${at(n)}, :a${at(n)})`).join(', ')}` : '',
          ].join(' ').trim(),
          ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#a${i}`, n])),
          ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:a${i}`, attributes[n]])),
        },
      }
    : { Put: { TableName: to, Item: { ...key, ...attributes }, ConditionExpression: 'attribute_not_exists(PK)' } };
  try {
    await ddb.send(new TransactWriteItemsCommand({ TransactItems: [marker, write] }));
    return 'copied';
  } catch (err) {
    const reasons = (err as TransactionCanceledException).CancellationReasons;
    if ((err as Error).name !== 'TransactionCanceledException' || !reasons) throw err;
    if (reasons[0].Code === 'ConditionalCheckFailed') return 'already';
    if (counter || reasons[1].Code !== 'ConditionalCheckFailed') throw err;
  }
  const { Item: stored = {} } = await ddb.send(new GetItemCommand({ TableName: to, Key: key, ConsistentRead: true }));
  const source: Item = { ...key, ...attributes };
  // Compared unmarshalled (numbers kept as exact strings) so a set's member order doesn't count.
  const same = (n: string) => isDeepStrictEqual(...[stored, source].map((i) => unmarshall(n in i ? { v: i[n] } : {}, { wrapNumbers: true })) as [unknown, unknown]);
  const differ = [...new Set([...Object.keys(stored), ...Object.keys(source)])].filter((n) => !(name === 'PRICING' && n === 'validTo') && !same(n));
  if (!differ.length) return 'already';
  return differ.map((n) => `${n} is ${JSON.stringify(stored[n] ?? null)} in the ledger table, ${JSON.stringify(source[n] ?? null)} in the source`).join('; ');
}

async function main(argv: string[]) {
  const { positional, flags } = parseFlags(argv, { values: ['from', 'from-keys', 'from-user-prefix', 'to', 'app'], booleans: ['apply'] });
  const usage = '--from <app table> [--from-keys pk,sk] [--from-user-prefix USER#] --to <ledger table> --app <appId> [--apply]';
  const [pk, sk, extra] = typeof flags['from-keys'] === 'string' ? flags['from-keys'].split(',') : [];
  if (positional.length || typeof flags.from !== 'string' || typeof flags.to !== 'string' || typeof flags.app !== 'string' ||
      (flags['from-keys'] !== undefined && (!pk || !sk || extra !== undefined)) || flags.from === flags.to) {
    throw new Error(`Usage: ${usage}`);
  }
  const { refused } = await migrate(new DynamoDBClient({}), {
    from: flags.from,
    ...(pk ? { fromKeys: { pk, sk } } : {}),
    ...(typeof flags['from-user-prefix'] === 'string' ? { fromUserPrefix: flags['from-user-prefix'] } : {}),
    to: flags.to,
    app: flags.app,
    apply: flags.apply === true,
  });
  if (refused.length) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
