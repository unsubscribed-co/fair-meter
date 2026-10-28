import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { formatFreeTierLine, freeTierMetricData, freeTierPct, previousUtcMonth, setSize } from '../free-tier';

process.env.TABLE_NAME = 'tbl';
process.env.PROVIDER = 'gcp-tts';
process.env.COUNTER = 'premiumChars';
process.env.LIMIT = '900000';
process.env.METRIC_NAMESPACE = 'Nieto';
process.env.METRIC_PREFIX = 'TtsPremiumChars';
// Imported after the env is set: the handler reads it at load time.
const { handler } = require('../free-tier-handler') as typeof import('../free-tier-handler');

describe('free tier helpers', () => {
  test('floored integer percent; a zero cap counts as reached', () => {
    expect(freeTierPct(0, 900_000)).toBe(0);
    expect(freeTierPct(629_999, 900_000)).toBe(69);
    expect(freeTierPct(630_000, 900_000)).toBe(70);
    expect(freeTierPct(950_000, 900_000)).toBe(105);
    expect(freeTierPct(10, 0)).toBe(100);
  });

  test('the admin line', () => {
    expect(formatFreeTierLine({ month: '2026-10', provider: 'gcp-tts', counter: 'premiumChars', used: 123_456, limit: 900_000 }))
      .toBe('2026-10  gcp-tts premiumChars  123456 / 900000 free (13%)');
  });

  test('metrics: the count and its percent', () => {
    expect(freeTierMetricData('TtsPremiumChars', 630_000, 900_000)).toEqual([
      { MetricName: 'TtsPremiumCharsUsed', Value: 630_000, Unit: 'Count' },
      { MetricName: 'TtsPremiumCharsPct', Value: 70, Unit: 'Percent' },
    ]);
  });
});

describe('scheduled watch', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const cw = mockClient(CloudWatchClient);

  beforeEach(() => {
    ddb.reset();
    cw.reset();
    cw.on(PutMetricDataCommand).resolves({});
    jest.useFakeTimers({ now: new Date('2026-10-20T09:05:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("reads this UTC month's counter and publishes it with its percent of the cap", async () => {
    ddb.on(GetCommand).resolves({ Item: { premiumChars: 640_000, requests: 4000 } });
    await expect(handler()).resolves.toEqual({ month: '2026-10', used: 640_000, pct: 71 });
    expect(ddb.commandCalls(GetCommand)[0].args[0].input).toEqual({ TableName: 'tbl', Key: { PK: 'PROVIDER#gcp-tts', SK: 'MONTH#2026-10' } });
    const input = cw.commandCalls(PutMetricDataCommand)[0].args[0].input;
    expect(input.Namespace).toBe('Nieto');
    expect(input.MetricData!.map((m) => [m.MetricName, m.Value])).toEqual([['TtsPremiumCharsUsed', 640_000], ['TtsPremiumCharsPct', 71]]);
  });

  test('a month with nothing used yet publishes 0 (the alarm clears)', async () => {
    ddb.on(GetCommand).resolves({});
    await expect(handler()).resolves.toEqual({ month: '2026-10', used: 0, pct: 0 });
  });

  test("once a month: copies the size of last month's set onto this month's item, only if absent", async () => {
    process.env.SHARE_FROM_SET = 'voiceHouseholds';
    process.env.SHARE_TO = 'shareHouseholds';
    ddb.on(GetCommand, { Key: { PK: 'PROVIDER#gcp-tts', SK: 'MONTH#2026-10' } }).resolves({ Item: { premiumChars: 1000 } });
    ddb.on(GetCommand, { Key: { PK: 'PROVIDER#gcp-tts', SK: 'MONTH#2026-09' } }).resolves({ Item: { voiceHouseholds: new Set(['fam', 'dev', 'rubio']) } });
    ddb.on(UpdateCommand).resolves({});
    await expect(handler()).resolves.toMatchObject({ month: '2026-10', shareCount: 3 });
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input).toEqual({
      TableName: 'tbl',
      Key: { PK: 'PROVIDER#gcp-tts', SK: 'MONTH#2026-10' },
      UpdateExpression: 'SET #to = if_not_exists(#to, :n)',
      ExpressionAttributeNames: { '#to': 'shareHouseholds' },
      ExpressionAttributeValues: { ':n': 3 },
    });

    // Already counted this month: no second read, no write.
    ddb.reset();
    ddb.on(GetCommand).resolves({ Item: { premiumChars: 1000, shareHouseholds: 3 } });
    await expect(handler()).resolves.not.toHaveProperty('shareCount');
    expect(ddb.commandCalls(GetCommand)).toHaveLength(1);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);

    // A first month (nothing last month) counts 0: the share's floor applies.
    ddb.reset();
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    await expect(handler()).resolves.toMatchObject({ shareCount: 0 });
    delete process.env.SHARE_FROM_SET;
    delete process.env.SHARE_TO;
  });

  test('set sizes and the previous UTC month', () => {
    expect(setSize(new Set(['a', 'b']))).toBe(2);
    expect(setSize(['a', 'a', 'b'])).toBe(2);
    expect(setSize(undefined)).toBe(0);
    expect(previousUtcMonth(new Date('2026-10-01T00:00:00Z'))).toBe('2026-09');
    expect(previousUtcMonth(new Date('2027-01-31T23:59:59Z'))).toBe('2026-12');
  });

  test('failures throw (the failure alarm fires)', async () => {
    ddb.on(GetCommand).rejects(new Error('ddb down'));
    await expect(handler()).rejects.toThrow('ddb down');
  });
});
