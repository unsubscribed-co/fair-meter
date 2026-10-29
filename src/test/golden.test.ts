import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { adjustmentTransaction, type Adjustment } from '../adjust';
import { usageTransaction, type UsageRecord } from '../ledger';
import { Meter, type MeteringConfig } from '../meter';

/*
 * T12: the old path, frozen. The snapshots were written by v0.1.1 (before any v0.2.0 change), so
 * any difference in what Nieto's code sends to DynamoDB fails here, byte for byte.
 */

const ddbMock = mockClient(DynamoDBDocumentClient);
const clients = () => ({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) });
const cfg: MeteringConfig = {
  tableName: 't',
  appId: 'nieto',
  markupBps: 1_000,
  skuAliases: { 'deepseek-flash': 'deepseek-v4-flash' },
  retryQueueUrl: 'https://sqs/retry',
  limits: { defaultDailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 3_000_000, allAppsDailyCapMicroUsd: 5_000_000, maxCallsPerMinute: 20 },
};
const AT = new Date('2026-10-15T12:00:00.123Z');
const items: Record<string, Record<string, unknown>> = {
  'USER#u1|PROFILE': { householdId: 'fam', role: 'owner' },
  'HOUSEHOLD#fam|META': { creditBalanceMicroUsd: 0 },
  'HOUSEHOLD#fam|PLAN#nieto': { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000 },
  'USER#u1|DAILY#nieto#2026-10-15': { costMicroUsd: 1234 },
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).callsFake(({ Key }) => ({ Item: items[`${Key.PK}|${Key.SK}`] }));
  ddbMock.on(QueryCommand).resolves({
    Items: [{ PK: 'PRICING#deepseek-v4-flash', SK: '2026-10-01T00:00:00Z', inputMicroUsdPerMTok: 150_000, cachedInputMicroUsdPerMTok: 3_000, outputMicroUsdPerMTok: 600_000 }],
  });
  ddbMock.on(UpdateCommand).resolves({});
});

const record: UsageRecord = {
  appId: 'nieto',
  sub: 'u1',
  householdId: 'fam',
  plan: 'test',
  requestId: 'req-1',
  requestTime: '2026-10-31T23:59:59.900Z',
  kind: 'chat',
  pricingVersion: 'deepseek-v4-flash@2026-10-01',
  details: { sku: 'deepseek-v4-flash', provider: 'deepseek', inputTokens: 10, durationMs: 1200, env: 'prod' },
  counters: { inputTokens: 10, outputTokens: 5 },
  baseCostMicroUsd: 7,
  costMicroUsd: 8,
  markupBps: 1_000,
  deductCredit: false,
};

test('usageTransaction', () => {
  expect(JSON.stringify(usageTransaction('t', record).input)).toMatchSnapshot('plan household with provider');
  expect(JSON.stringify(usageTransaction('t', { ...record, plan: undefined, deductCredit: true }).input)).toMatchSnapshot('legacy prepaid');
  expect(JSON.stringify(usageTransaction('t', {
    ...record,
    providerMonth: { provider: 'gcp-tts', counters: { premiumChars: 120 }, sets: { voiceHouseholds: 'fam' } },
    householdMonthMarks: { premiumEndedAt: '2026-10-31T23:59:59.900Z' },
  }).input, (_k, v) => (v instanceof Set ? [...v] : v))).toMatchSnapshot('free tier and marks');
});

test('adjustmentTransaction', () => {
  const a: Adjustment = {
    appId: 'nieto', sub: 'u1', householdId: 'fam', plan: 'test', eventSk: 'EVENT#2026-10-15T12:00:00.000Z#nieto#r1', eventTime: '2026-10-15T12:00:00.000Z',
    legacyEvent: false, kind: 'chat', sku: 'deepseek-v4-flash', reason: 'reprice-x', oldPricingVersion: 'a', newPricingVersion: 'b',
    oldCostMicroUsd: 10, newCostMicroUsd: 7, deltaMicroUsd: -3, createdAt: '2026-10-20T00:00:00.000Z', deductCredit: true,
  };
  expect(JSON.stringify(adjustmentTransaction('t', a).input)).toMatchSnapshot();
});

test('Meter.authorize: the commands sent and the answer', async () => {
  const res = await new Meter(cfg, clients()).authorize('u1', AT);
  expect(JSON.stringify(res)).toMatchSnapshot('result');
  const sent = ddbMock.calls().map((c) => JSON.stringify([c.args[0].constructor.name, c.args[0].input]));
  expect(sent.sort()).toMatchSnapshot('commands');
});

test('the four record builders', async () => {
  const meter = new Meter(cfg, clients());
  const caller = { sub: 'u1', householdId: 'fam', plan: { plan: 'test', subscriptionStatus: 'active', monthlyAllowanceMicroUsd: 5_000_000 } };
  const pricing = await meter.tokenPricing('deepseek-flash', AT);
  const token = await meter.tokenRecord({
    caller, requestId: 'r1', at: AT, kind: 'chat', provider: 'deepseek', requestedModel: 'deepseek-flash', requestedPricing: pricing!,
    servedModel: 'deepseek-flash', usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 600 }, turnStart: true, details: { env: 'prod' },
  });
  const char = meter.charRecord({ caller, requestId: 'r2', at: AT, kind: 'tts', sku: 'gcp-tts', pricing: { version: 'gcp-tts@x', microUsdPerMChars: 30_000_000 }, chars: 1234 });
  const request = meter.requestRecord({ caller, requestId: 'r3', at: AT, kind: 'places', sku: 'gcp-places', pricing: { version: 'gcp-places@x', microUsdPerRequest: 32_000 }, counters: { placesCalls: 1 } });
  const unit = meter.unitRecord({ caller, requestId: 'r4', at: AT, kind: 'search', sku: 'gemini-search', pricing: { version: 'gemini-search@x', microUsdPerKUnits: 14_000_000 }, units: 3, counters: { searchQueries: 3 } });
  expect(JSON.stringify([token, char, request, unit])).toMatchSnapshot();
});
