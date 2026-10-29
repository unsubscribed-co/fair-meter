import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { formatPriceHistory, syncPrices } from '../prices-cli';
import { parsePriceFile } from '../prices';
import { priceCall } from '../pricing';

/* An action SKU (components) synced into a table with the default keys, against DynamoDB Local. Skipped unless DYNAMODB_ENDPOINT is set. */
const endpoint = process.env.DYNAMODB_ENDPOINT;
if (process.env.CI && !endpoint) throw new Error('DYNAMODB_ENDPOINT is not set in CI');
const suite = endpoint ? describe : describe.skip;

const TABLE = `fair-meter-prices-${Date.now()}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const ddb = DynamoDBDocumentClient.from(raw);
const source = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json';
const action = parsePriceFile('stacksplit-add-expense', JSON.stringify({
  provider: 'aws',
  unit: 'units',
  versions: [
    { validFrom: '2026-11-01T00:00:00Z', microUsdPerKUnits: 1_234, components: { database: 500, api: 400, compute: 234, logs: 100, other: 0 }, source },
    { validFrom: '2026-12-01T00:00:00Z', microUsdPerKUnits: 1_000, components: { database: 400, api: 300, compute: 200, logs: 100, other: 0 }, source },
  ],
}));
const NOW = new Date('2026-10-30T00:00:00Z');

suite('sync of an action SKU against DynamoDB Local', () => {
  beforeAll(async () => {
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
  });
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('stored like any units SKU: priced per 1,000 actions, components kept, a re-sync changes nothing', async () => {
    await syncPrices(ddb, TABLE, [action], NOW, false);
    expect(await syncPrices(ddb, TABLE, [action], NOW, false)).toEqual(['Prices are in sync.']);

    const { Items = [] } = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'PRICING#stacksplit-add-expense' }, ConsistentRead: true,
    }));
    expect(Items[0]).toMatchObject({ provider: 'aws', validTo: '2026-12-01T00:00:00Z', components: { database: 500, api: 400, compute: 234, logs: 100, other: 0 } });
    // 3 actions at $0.001234 per 1,000 = 3.702 micro-USD, rounded up.
    expect(priceCall(Items[0], { units: 3 }, new Date('2026-11-02T00:00:00Z'))).toMatchObject({ costMicroUsd: 4 });
    expect(formatPriceHistory('stacksplit-add-expense', Items)).toBe([
      'stacksplit-add-expense@2026-11-01T00:00:00Z  [2026-11-01T00:00:00Z .. 2026-12-01T00:00:00Z)  $0.001234/1,000 units' +
        ' (database $0.000500 api $0.000400 compute $0.000234 logs $0.000100 other $0.000000)  aws',
      'stacksplit-add-expense@2026-12-01T00:00:00Z  [2026-12-01T00:00:00Z .. open)  $0.001000/1,000 units' +
        ' (database $0.000400 api $0.000300 compute $0.000200 logs $0.000100 other $0.000000)  aws',
    ].join('\n'));
  });
});
