import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSEvent } from 'aws-lambda';
import { FairMeter, resetsAtLocal, type FairMeterConfig, type Reservation } from '../fair-meter';
import { setTableKeys } from '../keys';
import { Meter } from '../meter';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

const config: FairMeterConfig = {
  appId: 'stacksplit',
  env: 'prod',
  tableName: 't',
  retryQueueUrl: 'https://sqs/retry',
  dailyCapMicroUsd: 500_000,
  appDailyCapMicroUsd: 5_000_000,
  tableKeys: { pk: 'pk', sk: 'sk' },
};
const AT = new Date('2026-11-03T14:05:09.120Z');
const meter = (cfg: Partial<FairMeterConfig> = {}) =>
  new FairMeter({ ...config, ...cfg }, { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}), now: () => AT });

const haiku = {
  pk: 'PRICING#claude-haiku-5-5', sk: '2026-10-28T00:00:00Z', validFrom: '2026-10-28T00:00:00Z', provider: 'anthropic',
  inputMicroUsdPerMTok: 100_000, cacheWriteMicroUsdPerMTok: 125_000, cachedInputMicroUsdPerMTok: 10_000, outputMicroUsdPerMTok: 500_000,
};
const ask = { person: 'ana@x.co', sku: 'claude-haiku-5-5', paidBy: 'credit' as const, max: { inputTokens: 30_000, outputTokens: 4_096 } };
const anthropicUsage = { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000, output_tokens: 100 };

let items: Record<string, Record<string, unknown>>;
let prices: Record<string, unknown>[];
beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  items = {};
  prices = [haiku];
  ddbMock.on(GetCommand).callsFake(({ Key }) => ({ Item: items[`${Key.pk}|${Key.sk}`] }));
  ddbMock.on(QueryCommand).callsFake(() => ({ Items: prices }));
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(TransactWriteCommand).resolves({});
  for (const level of ['error', 'warn', 'log'] as const) jest.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => setTableKeys(undefined));

const cancelled = (...codes: string[]) =>
  Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) });
const sentTransactions = () => ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input);

describe('authorize', () => {
  test('reserves the most this attempt can cost, atomically, against the cap (walkthrough A)', async () => {
    items['USER#ana@x.co|DAILY#stacksplit#2026-11-03'] = { committedMicroUsd: 120_000, costMicroUsd: 120_000 };
    const call = await meter().authorize(ask);
    expect(call).toMatchObject({ ok: true, tier: 'normal', callId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const { callId, hold } = call as Reservation;
    expect(hold).toMatchObject({ person: 'ana@x.co', at: AT.toISOString(), sku: 'claude-haiku-5-5', provider: 'anthropic', pricingVersion: 'claude-haiku-5-5@2026-10-28T00:00:00Z', reservedMicroUsd: 5_798, paidBy: 'credit' });
    const [tx] = sentTransactions();
    expect(tx.ClientRequestToken).toHaveLength(32);
    expect(tx.TransactItems![0].Put).toEqual({
      TableName: 't',
      Item: { pk: 'PENDING#stacksplit', sk: `CALL#${callId}`, person: 'ana@x.co', at: AT.toISOString(), sku: 'claude-haiku-5-5', provider: 'anthropic', pricingVersion: hold.pricingVersion, max: ask.max, reservedMicroUsd: 5_798, paidBy: 'credit', env: 'prod' },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(tx.TransactItems![1].Update).toEqual({
      TableName: 't',
      Key: { pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' },
      UpdateExpression: 'ADD committedMicroUsd :reserved',
      ConditionExpression: 'attribute_not_exists(committedMicroUsd) OR committedMicroUsd <= :room',
      ExpressionAttributeValues: { ':reserved': 5_798, ':room': 500_000 - 5_798 },
    });
    // Plain JSON: the hold survives a queue or a log line.
    expect(JSON.parse(JSON.stringify(hold))).toEqual(hold);
    // The cap reads are consistent; the price is the version valid now, from the SKU's versions (cached).
    expect(ddbMock.commandCalls(GetCommand).every((c) => c.args[0].input.ConsistentRead)).toBe(true);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'PRICING#claude-haiku-5-5' });
  });

  test('every authorize mints a new callId', async () => {
    const a = (await meter().authorize(ask)) as Reservation;
    const b = (await meter().authorize(ask)) as Reservation;
    expect(a.callId).not.toBe(b.callId);
  });

  test('the tier counts this hold', async () => {
    items['USER#ana@x.co|DAILY#stacksplit#2026-11-03'] = { committedMicroUsd: 370_000 };
    expect(await meter().authorize(ask)).toMatchObject({ ok: true, tier: 'saving' });
  });

  test.each([
    ['no version', () => { prices = []; }],
    ['a closed range', () => { prices = [{ ...haiku, validTo: '2026-11-01T00:00:00Z' }]; }],
    ['a malformed version', () => { prices = [{ ...haiku, outputMicroUsdPerMTok: -1 }]; }],
    ['a token SKU without provider', () => { prices = [{ ...haiku, provider: undefined }]; }],
  ])('T5: %s: 503 pricing_not_configured, PRICE_MISSING, nothing written', async (_, setup) => {
    setup();
    expect(await meter().authorize(ask)).toEqual({ ok: false, status: 503, body: { error: 'pricing_not_configured' }, headers: {} });
    expect(console.error).toHaveBeenCalledWith('PRICE_MISSING', expect.objectContaining({ sku: 'claude-haiku-5-5' }));
    expect(sentTransactions()).toHaveLength(0);
  });

  test('a failed read: 503 metering_unavailable, METER_UNAVAILABLE, nothing reserved', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('throttled'));
    expect(await meter().authorize(ask)).toEqual({ ok: false, status: 503, body: { error: 'metering_unavailable' }, headers: {} });
    expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.anything());
    expect(sentTransactions()).toHaveLength(0);
  });

  test('a max that does not fit the price: 503, METER_UNAVAILABLE', async () => {
    expect(await meter().authorize({ ...ask, max: { chars: 10 } })).toMatchObject({ ok: false, status: 503, body: { error: 'metering_unavailable' } });
    expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.objectContaining({ reason: expect.stringContaining('max') }));
  });

  test('T16: the app and all-apps breakers pause the service until 00:00 UTC; nothing reserved', async () => {
    items['APP#stacksplit|DAILY#2026-11-03'] = { costMicroUsd: 5_000_000 };
    expect(await meter().authorize(ask)).toMatchObject({ ok: false, status: 503, body: { error: 'service_paused', resetsAt: '2026-11-04T00:00:00.000Z' } });
    expect(console.error).toHaveBeenCalledWith('SERVICE_PAUSED', expect.objectContaining({ reason: 'app_daily_cap' }));
    items['APP#stacksplit|DAILY#2026-11-03'] = {};
    items['GLOBAL|DAILY#2026-11-03'] = { costMicroUsd: 9_000_000 };
    expect(await meter({ allAppsDailyCapMicroUsd: 9_000_000 }).authorize(ask)).toMatchObject({ ok: false, status: 503, body: { error: 'service_paused' } });
    expect(sentTransactions()).toHaveLength(0);
  });

  test('T16: the brake: 429 with Retry-After; nothing reserved', async () => {
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('over'), { name: 'ConditionalCheckFailedException' }));
    expect(await meter({ maxCallsPerMinute: 20 }).authorize(ask)).toEqual({
      ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds: 51 }, headers: { 'Retry-After': '51' }, tier: 'normal',
    });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.Key).toEqual({ pk: 'USER#ana@x.co', sk: 'RATE#stacksplit#2026-11-03T14:05' });
    expect(sentTransactions()).toHaveLength(0);
  });

  test('a call that can never fit the cap: 429, CALL_EXCEEDS_CAP (a config error)', async () => {
    expect(await meter({ dailyCapMicroUsd: 5_000 }).authorize(ask)).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
    expect(console.error).toHaveBeenCalledWith('CALL_EXCEEDS_CAP', expect.objectContaining({ reservedMicroUsd: 5_798 }));
    expect(sentTransactions()).toHaveLength(0);
  });

  test('the cap reached: 429 daily_limit_reached with resetsAt, LIMIT_REACHED (warn)', async () => {
    items['USER#ana@x.co|DAILY#stacksplit#2026-11-03'] = { committedMicroUsd: 495_000 };
    expect(await meter().authorize(ask)).toEqual({
      ok: false, status: 429, body: { error: 'daily_limit_reached', resetsAt: '2026-11-04T00:00:00.000Z' }, headers: {}, tier: 'essential',
    });
    expect(console.warn).toHaveBeenCalledWith('LIMIT_REACHED', expect.anything());
    // The condition refuses too when a parallel hold got there first.
    items['USER#ana@x.co|DAILY#stacksplit#2026-11-03'] = { committedMicroUsd: 0 };
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'ConditionalCheckFailed'));
    expect(await meter().authorize(ask)).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
  });

  test('a callId collision: 500, CALL_ID_REUSED', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None'));
    expect(await meter().authorize(ask)).toMatchObject({ ok: false, status: 500, body: { error: 'metering_unavailable' } });
    expect(console.error).toHaveBeenCalledWith('CALL_ID_REUSED', expect.anything());
  });

  test('a TransactionConflict is retried (twice at most) with the same token', async () => {
    ddbMock.on(TransactWriteCommand).rejectsOnce(cancelled('None', 'TransactionConflict')).resolves({});
    expect(await meter().authorize(ask)).toMatchObject({ ok: true });
    const [first, second] = sentTransactions();
    expect(second).toEqual(first);
  });

  test('M3: an ambiguous reserve failure is resolved by resending the identical reserve (same token)', async () => {
    // It may have committed: the resend is a no-op success then, or does the reserve now. Either way the hold is real.
    ddbMock.on(TransactWriteCommand).rejectsOnce(new Error('socket hang up')).resolves({});
    expect(await meter().authorize(ask)).toMatchObject({ ok: true });
    const [first, second] = sentTransactions();
    expect(second).toEqual(first);
    expect(sentTransactions()).toHaveLength(2);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  test('M3: still unresolved: refused, released inline, and a delayed release queued in case it commits later', async () => {
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      if (input.TransactItems[0].Put) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return {};
    });
    sqsMock.on(SendMessageCommand).resolves({});
    expect(await meter().authorize(ask)).toMatchObject({ ok: false, status: 503, body: { error: 'metering_unavailable' } });
    const sent = sentTransactions();
    expect(sent.filter((t) => t.TransactItems![0].Put)).toHaveLength(3);
    const release = sent.find((t) => t.TransactItems![0].Delete)!;
    expect(release.TransactItems![0].Delete!.Key).toMatchObject({ pk: 'PENDING#stacksplit' });
    expect(release.TransactItems![1].Update!.ExpressionAttributeValues).toEqual({ ':held': -5_798 });
    const queued = sqsMock.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
    expect(queued).toEqual([expect.objectContaining({ QueueUrl: 'https://sqs/retry', DelaySeconds: 60 })]);
    expect(JSON.parse(queued[0].MessageBody!)).toMatchObject({ release: true, reservedMicroUsd: 5_798 });
    expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.anything());
  });

  test('M3: the inline release fails too: it is queued (now and delayed), never left for the sweeper', async () => {
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    sqsMock.on(SendMessageCommand).resolves({});
    expect(await meter().authorize(ask)).toMatchObject({ ok: false, status: 503 });
    const queued = sqsMock.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
    expect(queued.map((q) => q.DelaySeconds)).toEqual([undefined, 60]);
    for (const q of queued) expect(JSON.parse(q.MessageBody!)).toMatchObject({ release: true });
  });

  test.each([
    ['no request', undefined],
    ['no max', { person: 'ana@x.co', sku: 'claude-haiku-5-5' }],
    ['no person', { sku: 'claude-haiku-5-5', max: { inputTokens: 1, outputTokens: 1 } }],
    ['a bad paidBy', { ...ask, paidBy: 'card' }],
  ])('L7: a malformed request (%s) is refused, never thrown', async (_, req) => {
    expect(await meter().authorize(req as never)).toEqual({ ok: false, status: 500, body: { error: 'metering_unavailable' }, headers: {} });
    expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.objectContaining({ reason: expect.stringContaining('request') }));
    expect(sentTransactions()).toHaveLength(0);
  });
});

describe("a price's first context tier (README, under max)", () => {
  const tiered = { ...haiku, tiers: [{ aboveInputTokens: 100_000, inputMicroUsdPerMTok: 500_000, cachedInputMicroUsdPerMTok: 50_000, cacheWriteMicroUsdPerMTok: 625_000, outputMicroUsdPerMTok: 2_500_000 }] };

  test('a counted bound under the threshold reserves at the base rate; a bytes bound over it, at the tier', async () => {
    prices = [tiered];
    const counted = (await meter().authorize({ ...ask, max: { inputTokens: 90_000, outputTokens: 1_000 } })) as Reservation;
    // Every input token at the dearest input-side rate (cache write, $0.125 per million), output at $0.50.
    expect(counted.hold.reservedMicroUsd).toBe(11_250 + 500);
    const bytes = (await meter().authorize({ ...ask, max: { inputTokens: 400_000, outputTokens: 1_000 } })) as Reservation;
    // The tier's rates, five times as much: $0.625 and $2.50 per million.
    expect(bytes.hold.reservedMicroUsd).toBe(250_000 + 2_500);
  });
});

describe('record', () => {
  const reserve = async () => (await meter().authorize(ask)) as Reservation;
  const settled = () => sentTransactions().at(-1)!.TransactItems![0].Put?.Item;

  test("the provider's usage: settled at the actual cost through the price's adapter (walkthrough A)", async () => {
    const call = await reserve();
    expect(await meter().record(call, anthropicUsage)).toBe('recorded');
    expect(settled()).toMatchObject({
      pk: 'USER#ana@x.co', sk: `EVENT#${AT.toISOString()}#stacksplit#${call.callId}`, kind: 'tokens', requestId: call.callId, provider: 'anthropic', sku: 'claude-haiku-5-5',
      inputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 2000, outputTokens: 100, reasoningTokens: 0,
      costMicroUsd: 440, baseCostMicroUsd: 440, markupBps: 0, reservedMicroUsd: 5_798, env: 'prod', paidBy: 'credit', usageHash: expect.any(String),
    });
    expect(settled()).not.toHaveProperty('estimated');
    expect(settled()).not.toHaveProperty('householdId');
    expect(console.error).not.toHaveBeenCalled();
  });

  test("T7: 'unknown': settled at the reservation, estimated 'aborted', no alarm", async () => {
    const call = await reserve();
    expect(await meter().record(call, 'unknown')).toBe('recorded');
    expect(settled()).toMatchObject({ costMicroUsd: 5_798, estimated: 'aborted', inputTokens: 30_000, outputTokens: 4_096 });
    expect(console.error).not.toHaveBeenCalled();
  });

  test("{ estimate }: the app's guess for an aborted attempt, at its own cost, no alarm", async () => {
    const call = await reserve();
    expect(await meter().record(call, { estimate: { input_tokens: 7_000, output_tokens: 0 } })).toBe('recorded');
    expect(settled()).toMatchObject({ costMicroUsd: 700, estimated: 'aborted', inputTokens: 7_000, outputTokens: 0 });
    expect(sentTransactions().at(-1)!.TransactItems![2].Update!.ExpressionAttributeValues![':held']).toBe(700 - 5_798);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('an estimate above the reservation is recorded anyway, RESERVATION_EXCEEDED', async () => {
    const call = await reserve();
    expect(await meter().record(call, { estimate: { input_tokens: 100_000, output_tokens: 0 } })).toBe('recorded');
    expect(settled()).toMatchObject({ costMicroUsd: 10_000, estimated: 'aborted' });
    // An error: it is the only sign the cap was overshot, so it alarms.
    expect(console.error).toHaveBeenCalledWith('RESERVATION_EXCEEDED', expect.objectContaining({ costMicroUsd: 10_000, reservedMicroUsd: 5_798 }));
  });

  test('T15 (mock): actual above the reservation: the actual cost, RESERVATION_EXCEEDED', async () => {
    const call = await reserve();
    expect(await meter().record(call, { input_tokens: 0, output_tokens: 20_000 })).toBe('recorded');
    expect(settled()).toMatchObject({ costMicroUsd: 10_000 });
    expect(console.error).toHaveBeenCalledWith('RESERVATION_EXCEEDED', expect.anything());
  });

  test.each([[undefined], [{}], [{ input_tokens: 'many' }], [{ estimate: 'oops' }], [{ estimate: { inputTokens: 7_000 } }], [{ estimate: { inputTokens: 7_000, outputTokens: 0, reasoningTokens: -1 } }]])('T6: no usable usage (%p): the reservation, no_usage-style, USAGE_MISSING', async (usage) => {
    const call = await reserve();
    expect(await meter().record(call, usage as object | undefined)).toBe('recorded');
    expect(settled()).toMatchObject({ costMicroUsd: 5_798, estimated: (usage as any)?.estimate ? 'aborted' : 'no_usage' });
    expect(console.error).toHaveBeenCalledWith('USAGE_MISSING', expect.objectContaining({ callId: call.callId }));
  });

  test("'not_sent': exactly the release 'not_billed' writes", async () => {
    const call = await reserve();
    await meter().record(call, 'not_sent');
    await meter().record(call, 'not_billed');
    const [notSent, notBilled] = sentTransactions().slice(-2);
    expect(notSent).toEqual(notBilled);
    expect(notSent.TransactItems!.map((i) => Object.keys(i)[0])).toEqual(['Delete', 'Update']);
  });

  test("T8: 'not_billed': the hold released, no EVENT", async () => {
    const call = await reserve();
    expect(await meter().record(call, 'not_billed')).toBe('recorded');
    const tx = sentTransactions().at(-1)!;
    expect(tx.TransactItems!.map((i) => Object.keys(i)[0])).toEqual(['Delete', 'Update']);
  });

  test('non-token prices: chars, units and requests', async () => {
    prices = [{ pk: 'PRICING#gcp-tts', sk: '2026-10-01T00:00:00Z', microUsdPerMChars: 30_000_000 }];
    const call = (await meter().authorize({ person: 'ana@x.co', sku: 'gcp-tts', max: { chars: 2_000 } })) as Reservation;
    expect(call.hold.reservedMicroUsd).toBe(60_000);
    expect(call.hold.paidBy).toBe('paid');
    expect(await meter().record(call, { chars: 1_234 })).toBe('recorded');
    expect(settled()).toMatchObject({ kind: 'chars', chars: 1_234, costMicroUsd: 37_020, paidBy: 'paid' });
    expect(settled()).not.toHaveProperty('provider');
    prices = [{ pk: 'PRICING#places', sk: '2026-10-01T00:00:00Z', microUsdPerRequest: 32_000, provider: 'gcp-places' }];
    const places = (await meter().authorize({ person: 'ana@x.co', sku: 'places', max: { requests: 1 } })) as Reservation;
    await meter().record(places, { requests: 1 });
    expect(settled()).toMatchObject({ kind: 'requests', requests: 1, costMicroUsd: 32_000, provider: 'gcp-places' });
  });

  test('a TransactionConflict at settle is retried twice inline, same token', async () => {
    const call = await reserve();
    // rejectsOnce counts from the stub's first call, so start a fresh stub after the reserve.
    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).rejectsOnce(cancelled('None', 'None', 'None', 'TransactionConflict')).rejectsOnce(cancelled('None', 'None', 'None', 'TransactionConflict')).resolves({});
    expect(await meter().record(call, anthropicUsage)).toBe('recorded');
    const [a, b, c] = sentTransactions();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  test('T10: a settle that keeps failing is queued; the retry handler writes the identical transaction', async () => {
    const call = await reserve();
    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).rejects(new Error('ProvisionedThroughputExceeded'));
    sqsMock.on(SendMessageCommand).resolves({});
    expect(await meter().record(call, anthropicUsage)).toBe('deferred');
    const inline = sentTransactions()[0];
    const body = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!;
    expect(JSON.parse(body)).toMatchSnapshot({ requestId: expect.any(String), requestTime: expect.any(String), usageHash: expect.any(String) });

    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).resolves({});
    process.env.TABLE_NAME = 't';
    const { handler } = require('../retry-handler') as typeof import('../retry-handler');
    expect(await handler({ Records: [{ messageId: 'm1', body }] } as unknown as SQSEvent)).toEqual({ batchItemFailures: [] });
    expect(sentTransactions()[0]).toEqual(inline);
  });

  test('T11: the queue fails too: failed, USAGE_RECORD_FAILED with the full record', async () => {
    const call = await reserve();
    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).rejects(new Error('down'));
    sqsMock.on(SendMessageCommand).rejects(new Error('down too'));
    expect(await meter().record(call, anthropicUsage)).toBe('failed');
    expect(console.error).toHaveBeenCalledWith('USAGE_RECORD_FAILED', expect.objectContaining({
      record: expect.objectContaining({ requestId: call.callId, costMicroUsd: 440, reservedMicroUsd: 5_798 }),
    }));
  });

  test('a conflict is never queued', async () => {
    const call = await reserve();
    items[`USER#ana@x.co|EVENT#${AT.toISOString()}#stacksplit#${call.callId}`] = { usageHash: 'another' };
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('x'), { name: 'IdempotentParameterMismatchException' }));
    expect(await meter().record(call, anthropicUsage)).toBe('conflict');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  test('record never throws, even on a hold it cannot read', async () => {
    expect(await meter().record({ ok: true, tier: 'normal', callId: 'x', hold: {} as any }, anthropicUsage)).toBe('failed');
    expect(console.error).toHaveBeenCalledWith('USAGE_RECORD_FAILED', expect.anything());
  });
});

describe('usage', () => {
  test("one strongly consistent BatchGetItem of today's DAILY row and this month's USAGE row", async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { t: [] } });
    await meter().usage('ana@x.co');
    expect(ddbMock.calls()).toHaveLength(1);
    expect(ddbMock.commandCalls(BatchGetCommand)[0].args[0].input).toEqual({
      RequestItems: { t: { ConsistentRead: true, Keys: [{ pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' }, { pk: 'USER#ana@x.co', sk: 'USAGE#stacksplit#2026-11' }] } },
    });
  });

  test('rejects on a read error: it moves no money', async () => {
    ddbMock.on(BatchGetCommand).rejects(new Error('ProvisionedThroughputExceededException'));
    await expect(meter().usage('ana@x.co')).rejects.toThrow('ProvisionedThroughputExceededException');
  });

  test('rejects when DynamoDB leaves the keys unprocessed', async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { t: [] }, UnprocessedKeys: { t: { Keys: [{ pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' }] } } });
    await expect(meter().usage('ana@x.co')).rejects.toThrow(/not processed/);
  });
});

describe('actions', () => {
  const actions = { skus: ['stacksplit-new-expense', 'stacksplit-edit-expense'], perPersonPerMinute: 3, maxConcurrency: 10 };
  const FLOOR = 30_000;
  let now: Date;
  const actionMeter = (cfg: Partial<FairMeterConfig> = { actions, actionFloorMicroUsd: FLOOR }) =>
    new FairMeter({ ...config, ...cfg }, { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}), now: () => now });
  let lines: string[];
  beforeEach(() => {
    now = new Date('2026-11-03T14:05:09.120Z');
    lines = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  });

  describe('action', () => {
    test('one JSON line straight to stdout, its own log event, and nothing else', () => {
      const m = actionMeter();
      expect(m.action({ person: 'ana@x.co', sku: 'stacksplit-new-expense' })).toBeUndefined();
      m.action({ person: 'ana@x.co', sku: 'stacksplit-edit-expense', n: 3 });
      expect(lines).toEqual([
        '{"fairMeter":"action","appId":"stacksplit","env":"prod","person":"ana@x.co","sku":"stacksplit-new-expense","n":1}\n',
        '{"fairMeter":"action","appId":"stacksplit","env":"prod","person":"ana@x.co","sku":"stacksplit-edit-expense","n":3}\n',
      ]);
      expect(ddbMock.calls()).toHaveLength(0);
      expect(console.error).not.toHaveBeenCalled();
    });

    test.each([
      ['an SKU not configured', { sku: 'stacksplit-delete-group' }],
      ['n = 0', { n: 0 }],
      ['n above perPersonPerMinute (bulk writes go through authorize)', { n: 4 }],
      ['a fractional n', { n: 1.5 }],
      ['n as a string', { n: '2' }],
      ['no person', { person: '' }],
    ])('%s: ACTION_UNKNOWN (alarms), no line', (_, bad) => {
      actionMeter().action({ person: 'ana@x.co', sku: 'stacksplit-new-expense', ...bad } as any);
      expect(lines).toEqual([]);
      expect(console.error).toHaveBeenCalledWith('ACTION_UNKNOWN', expect.objectContaining({ appId: 'stacksplit' }));
    });

    test('never throws: no request, no actions configured, stdout failing', () => {
      expect(() => actionMeter().action(undefined as any)).not.toThrow();
      expect(() => actionMeter({}).action({ person: 'ana@x.co', sku: 'stacksplit-new-expense' })).not.toThrow();
      expect(lines).toEqual([]);
      jest.spyOn(process.stdout, 'write').mockImplementation(() => { throw new Error('EPIPE'); });
      expect(() => actionMeter().action({ person: 'ana@x.co', sku: 'stacksplit-new-expense' })).not.toThrow();
      expect(console.error).toHaveBeenCalledTimes(3);
    });
  });

  describe('authorize: AI holds cannot use the floor', () => {
    test('the reserve condition leaves the floor free', async () => {
      expect(await actionMeter().authorize(ask)).toMatchObject({ ok: true });
      expect(sentTransactions()[0].TransactItems![1].Update!.ExpressionAttributeValues).toEqual({ ':reserved': 5_798, ':room': 500_000 - FLOOR - 5_798 });
    });

    test('the pre-check: a hold that would reach into the floor is refused, nothing reserved', async () => {
      items['USER#ana@x.co|DAILY#stacksplit#2026-11-03'] = { committedMicroUsd: 500_000 - FLOOR - 5_797 };
      expect(await actionMeter().authorize(ask)).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
      expect(sentTransactions()).toHaveLength(0);
    });

    test('CALL_EXCEEDS_CAP: a hold that can never fit under cap - floor', async () => {
      expect(await actionMeter({ actions, actionFloorMicroUsd: 500_000 - 5_797 }).authorize(ask)).toMatchObject({ ok: false, status: 429, body: { error: 'daily_limit_reached' } });
      expect(console.error).toHaveBeenCalledWith('CALL_EXCEEDS_CAP', expect.objectContaining({ reservedMicroUsd: 5_798, actionFloorMicroUsd: 500_000 - 5_797 }));
    });
  });

  test('usage says readOnly once committed is above cap - floor; never without actions', async () => {
    const day = (committedMicroUsd: number) => ddbMock.on(BatchGetCommand).resolves({ Responses: { t: [{ pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03', committedMicroUsd }] } });
    day(500_000 - FLOOR);
    expect(await actionMeter().usage('ana@x.co')).toMatchObject({ readOnly: false });
    day(500_000 - FLOOR + 1);
    expect(await actionMeter().usage('ana@x.co')).toMatchObject({ readOnly: true });
    day(500_000);
    expect(await actionMeter({}).usage('ana@x.co')).toMatchObject({ readOnly: false });
  });

  describe('canWrite', () => {
    const DAY = 'USER#ana@x.co|DAILY#stacksplit#2026-11-03';

    test("room above the floor: ok, after one eventually consistent GetItem of the person's DAILY row", async () => {
      items[DAY] = { committedMicroUsd: 500_000 - FLOOR };
      expect(await actionMeter().canWrite('ana@x.co')).toEqual({ ok: true });
      expect(ddbMock.calls()).toHaveLength(1);
      const get = ddbMock.commandCalls(GetCommand)[0].args[0].input;
      expect(get).toEqual({ TableName: 't', Key: { pk: 'USER#ana@x.co', sk: 'DAILY#stacksplit#2026-11-03' } });
    });

    test('committed past cap - floor (the rollup pushed it): read-only, 429 daily_limit_reached until 00:00 UTC', async () => {
      items[DAY] = { committedMicroUsd: 500_000 - FLOOR + 1 };
      expect(await actionMeter().canWrite('ana@x.co')).toEqual({
        ok: false, status: 429, body: { error: 'daily_limit_reached', resetsAt: '2026-11-04T00:00:00.000Z' }, headers: {}, tier: 'essential',
      });
      expect(console.warn).toHaveBeenCalledWith('LIMIT_REACHED', expect.objectContaining({ person: 'ana@x.co' }));
    });

    test('over perPersonPerMinute on this instance: 429 too_many_requests, Retry-After to the next minute, RATE_LIMITED, no read', async () => {
      const m = actionMeter();
      m.action({ person: 'ana@x.co', sku: 'stacksplit-new-expense', n: 2 });
      expect(await m.canWrite('ana@x.co')).toEqual({ ok: true });
      m.action({ person: 'ana@x.co', sku: 'stacksplit-new-expense' });
      ddbMock.resetHistory();
      expect(await m.canWrite('ana@x.co')).toEqual({
        ok: false, status: 429, body: { error: 'too_many_requests', retryAfterSeconds: 51 }, headers: { 'Retry-After': '51' },
      });
      expect(console.warn).toHaveBeenCalledWith('RATE_LIMITED', expect.objectContaining({ person: 'ana@x.co', perPersonPerMinute: 3 }));
      expect(ddbMock.calls()).toHaveLength(0);
      // Per person, and the next UTC minute starts at zero.
      expect(await m.canWrite('bo@x.co')).toEqual({ ok: true });
      now = new Date('2026-11-03T14:06:00.000Z');
      expect(await m.canWrite('ana@x.co')).toEqual({ ok: true });
    });

    test('a bulk write passes its n: refused when it would go over the limit', async () => {
      const m = actionMeter();
      m.action({ person: 'ana@x.co', sku: 'stacksplit-new-expense', n: 2 });
      expect(await m.canWrite('ana@x.co', 1)).toEqual({ ok: true });
      expect(await m.canWrite('ana@x.co', 2)).toMatchObject({ ok: false, status: 429, body: { error: 'too_many_requests' } });
    });

    test.each([
      ['an n above perPersonPerMinute (it could never pass)', 'ana@x.co', 4],
      ['an n of 0', 'ana@x.co', 0],
      ['no person', '', 1],
    ])('%s: 500 metering_unavailable, METER_UNAVAILABLE', async (_, person, n) => {
      expect(await actionMeter().canWrite(person, n)).toEqual({ ok: false, status: 500, body: { error: 'metering_unavailable' }, headers: {} });
      expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.objectContaining({ reason: expect.any(String) }));
    });

    test('a read error: 503 metering_unavailable (fail closed)', async () => {
      ddbMock.on(GetCommand).rejects(new Error('throttled'));
      expect(await actionMeter().canWrite('ana@x.co')).toEqual({ ok: false, status: 503, body: { error: 'metering_unavailable' }, headers: {} });
      expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.anything());
    });

    test('without actions configured: 500 metering_unavailable, METER_UNAVAILABLE, no read', async () => {
      expect(await actionMeter({}).canWrite('ana@x.co')).toEqual({ ok: false, status: 500, body: { error: 'metering_unavailable' }, headers: {} });
      expect(console.error).toHaveBeenCalledWith('METER_UNAVAILABLE', expect.anything());
      expect(ddbMock.calls()).toHaveLength(0);
    });
  });
});

describe('T19: config, refused at startup', () => {
  test.each([
    ["billing 'hosted' (no wallet yet)", { billing: 'hosted' as const }],
    ['a bad appId', { appId: 'Stack Split' }],
    ['a non-integer cap', { dailyCapMicroUsd: 0.5 }],
    ['a zero app cap', { appDailyCapMicroUsd: 0 }],
    ['no env', { env: '' }],
    ['bad tiers', { tiers: { savingPct: 90, essentialPct: 75 } }],
    ['actions without a floor', { actions: { skus: ['a'], perPersonPerMinute: 20, maxConcurrency: 10 } }],
    ['a floor not below the cap', { actions: { skus: ['a'], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: 500_000 }],
    ['actions without SKUs', { actions: { skus: [], perPersonPerMinute: 20, maxConcurrency: 10 }, actionFloorMicroUsd: 1 }],
    ['a zero per-minute limit', { actions: { skus: ['a'], perPersonPerMinute: 0, maxConcurrency: 10 }, actionFloorMicroUsd: 1 }],
  ])('%s', (_, bad) => {
    expect(() => new FairMeter({ ...config, ...bad } as FairMeterConfig)).toThrow();
  });

  test('without arguments it reads FAIR_METER', () => {
    process.env.FAIR_METER = JSON.stringify(config);
    expect(() => new FairMeter()).not.toThrow();
    delete process.env.FAIR_METER;
    expect(() => new FairMeter()).toThrow(/FAIR_METER/);
  });

  test("L1: the old Meter refuses a markup that isn't an integer", () => {
    const old = { tableName: 't', appId: 'nieto', skuAliases: {}, retryQueueUrl: 'q', limits: { defaultDailyCapMicroUsd: 1, appDailyCapMicroUsd: 1 } };
    const clients = { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) };
    expect(() => new Meter({ ...old, markupBps: 12.5 }, clients)).toThrow(/markupBps/);
    expect(() => new Meter({ ...old, markupBps: Number('') || NaN }, clients)).toThrow(/markupBps/);
    expect(() => new Meter({ ...old, markupBps: 0 }, clients)).not.toThrow();
  });
});


describe('resetsAtLocal', () => {
  const bogota = { timeZone: 'America/Bogota', now: AT };

  test("today's reset in the person's own time and language (America/Bogota is UTC-5)", () => {
    // ICU versions differ on the space before PM (a plain, narrow or no-break space).
    expect(resetsAtLocal('2026-11-04T00:00:00.000Z', { locale: 'en', ...bogota })).toEqual({ time: expect.stringMatching(/^7:00\sPM$/), relative: 'in 10 hours' });
    expect(resetsAtLocal('2026-11-04T00:00:00.000Z', { locale: 'es', ...bogota })).toEqual({ time: '19:00', relative: 'dentro de 10 horas' });
  });

  test('under an hour in minutes, a day or more in days', () => {
    expect(resetsAtLocal('2026-11-03T15:00:00.000Z', { locale: 'es', ...bogota }).relative).toBe('dentro de 55 minutos');
    expect(resetsAtLocal('2026-12-01T00:00:00.000Z', { locale: 'en', ...bogota }).relative).toBe('in 27 days');
  });
});
