import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { decimalToMicroUsd } from '../cost';
import {
  balanceMetricData,
  driftBps,
  driftBreached,
  driftMetricData,
  formatBps,
  formatReconciliation,
  isDayAligned,
  parseDeepSeekBalance,
  parseReconcileArgs,
  providerDayFromItem,
  reconcile,
  reconcileWindows,
  snapshotFromItem,
  snapshotItem,
  type BalanceSnapshot,
} from '../reconcile';

process.env.TABLE_NAME = 'tbl';
process.env.BALANCE_URL = 'https://api.deepseek.com/user/balance';
process.env.API_KEY_PARAM = '/elder-assistant/model-api-key';
process.env.METRIC_NAMESPACE = 'Nieto';
// Imported after the env is set: the handler reads it at load time.
const { handler } = require('../reconcile-handler') as typeof import('../reconcile-handler');

describe('decimalToMicroUsd', () => {
  test('provider decimal strings to exact integer micro-USD', () => {
    expect(decimalToMicroUsd('1.234567')).toBe(1_234_567);
    expect(decimalToMicroUsd('0.10')).toBe(100_000);
    expect(decimalToMicroUsd('12')).toBe(12_000_000);
    expect(decimalToMicroUsd('110.00')).toBe(110_000_000);
    expect(decimalToMicroUsd('-0.5')).toBe(-500_000);
    expect(decimalToMicroUsd('7.')).toBe(7_000_000);
    expect(decimalToMicroUsd(' 0.000001 ')).toBe(1);
    // Floats would get this one wrong (0.29 * 1e6 = 289999.99999999994).
    expect(decimalToMicroUsd('0.29')).toBe(290_000);
  });

  test('past the sixth decimal: rounds half away from zero', () => {
    expect(decimalToMicroUsd('0.0000004416')).toBe(0);
    expect(decimalToMicroUsd('0.0000005')).toBe(1);
    expect(decimalToMicroUsd('1.2345675')).toBe(1_234_568);
    expect(decimalToMicroUsd('-1.2345675')).toBe(-1_234_568);
    expect(decimalToMicroUsd('-0.0000001')).toBe(0);
    expect(Object.is(decimalToMicroUsd('-0.0000001'), -0)).toBe(false);
  });

  test('exponent notation (Cost Explorer may use it)', () => {
    expect(decimalToMicroUsd('4.416E-7')).toBe(0);
    expect(decimalToMicroUsd('5.5E-6')).toBe(6);
    expect(decimalToMicroUsd('1.5e2')).toBe(150_000_000);
    expect(decimalToMicroUsd('3E-1')).toBe(300_000);
  });

  test('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '1,5', '$1', '1.2.3', 'NaN', '0x10', '1e']) expect(() => decimalToMicroUsd(bad)).toThrow();
    expect(() => decimalToMicroUsd('1e40')).toThrow(/too large/);
  });
});

describe('parseDeepSeekBalance', () => {
  const body = (infos: unknown[], available = true) => ({ is_available: available, balance_infos: infos });
  const usd = { currency: 'USD', total_balance: '9.876543', granted_balance: '0.00', topped_up_balance: '9.876543' };

  test('USD entry to micro-USD; other currencies are listed, not reconciled', () => {
    expect(parseDeepSeekBalance(body([{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }, usd]))).toEqual({
      isAvailable: true,
      totalBalanceMicroUsd: 9_876_543,
      grantedBalanceMicroUsd: 0,
      toppedUpBalanceMicroUsd: 9_876_543,
      otherCurrencies: ['CNY'],
    });
    expect(parseDeepSeekBalance(body([usd], false))).toMatchObject({ isAvailable: false, otherCurrencies: [] });
  });

  test('malformed or USD-less responses throw (never a guessed balance)', () => {
    expect(() => parseDeepSeekBalance(null)).toThrow();
    expect(() => parseDeepSeekBalance({})).toThrow(/balance_infos/);
    expect(() => parseDeepSeekBalance(body([{ ...usd, currency: 'CNY' }]))).toThrow(/USD/);
    expect(() => parseDeepSeekBalance(body([usd, usd]))).toThrow(/USD/);
    expect(() => parseDeepSeekBalance(body([{ ...usd, total_balance: undefined }]))).toThrow(/total_balance/);
    expect(() => parseDeepSeekBalance(body([{ ...usd, granted_balance: 'lots' }]))).toThrow();
  });
});

const snap = (takenAt: string, totalMicroUsd: number, source = 'schedule'): BalanceSnapshot => ({
  provider: 'deepseek',
  takenAt,
  source,
  isAvailable: true,
  totalBalanceMicroUsd: totalMicroUsd,
  grantedBalanceMicroUsd: 0,
  toppedUpBalanceMicroUsd: totalMicroUsd,
  otherCurrencies: [],
});

describe('snapshot items', () => {
  test('immutable PROVIDER#deepseek BALANCE#<iso> item round-trips', () => {
    const s = { ...snap('2026-10-02T00:00:03.120Z', 5_000_000), otherCurrencies: ['CNY'] };
    const item = snapshotItem(s);
    expect(item).toMatchObject({ PK: 'PROVIDER#deepseek', SK: 'BALANCE#2026-10-02T00:00:03.120Z', currency: 'USD', totalBalanceMicroUsd: 5_000_000, otherCurrencies: ['CNY'] });
    expect(snapshotItem(snap('2026-10-02T00:00:03.120Z', 1))).not.toHaveProperty('otherCurrencies');
    expect(snapshotFromItem(item)).toEqual(s);
    expect(snapshotFromItem({ PK: 'PROVIDER#deepseek', SK: 'DAILY#2026-10-02', baseCostMicroUsd: 1 })).toBeUndefined();
  });

  test('provider day counters', () => {
    expect(providerDayFromItem({ SK: 'DAILY#2026-10-01', requests: 3, baseCostMicroUsd: 900 })).toEqual({ day: '2026-10-01', requests: 3, baseCostMicroUsd: 900 });
    expect(providerDayFromItem({ SK: 'BALANCE#2026-10-01T00:00:00.000Z' })).toBeUndefined();
  });
});

describe('windows', () => {
  test('day alignment: within 15 minutes after 00:00 UTC', () => {
    expect(isDayAligned('2026-10-02T00:00:00.000Z')).toBe(true);
    expect(isDayAligned('2026-10-02T00:14:59.999Z')).toBe(true);
    expect(isDayAligned('2026-10-02T00:15:00.000Z')).toBe(false);
    expect(isDayAligned('2026-10-01T23:59:59.000Z')).toBe(false);
    expect(isDayAligned('garbage')).toBe(false);
  });

  test('consecutive aligned snapshots make day windows, in time order', () => {
    const w = reconcileWindows([
      snap('2026-10-03T00:00:05.000Z', 8_000_000),
      snap('2026-10-01T00:00:05.000Z', 10_000_000),
      snap('2026-10-02T00:00:05.000Z', 9_000_000),
    ]);
    expect(w.map((x) => [x.fromDay, x.toDay, x.toppedUp])).toEqual([
      ['2026-10-01', '2026-10-02', false],
      ['2026-10-02', '2026-10-03', false],
    ]);
  });

  test('mid-day and same-day snapshots never split a window; a missed day makes a two-day window', () => {
    const w = reconcileWindows([
      snap('2026-09-30T15:00:00.000Z', 11_000_000, 'admin'), // before the first aligned one: ignored
      snap('2026-10-01T00:00:05.000Z', 10_000_000),
      snap('2026-10-01T00:03:00.000Z', 10_000_000), // retried run, same day
      snap('2026-10-01T12:00:00.000Z', 9_500_000, 'admin'),
      snap('2026-10-03T00:00:05.000Z', 9_000_000), // the 2nd's run failed
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ fromDay: '2026-10-01', toDay: '2026-10-03', toppedUp: false });
    expect(w[0].start.takenAt).toBe('2026-10-01T00:00:05.000Z');
  });

  test('a balance increase anywhere inside marks a top-up window, even if the net change is a drop', () => {
    const w = reconcileWindows([
      snap('2026-10-01T00:00:05.000Z', 10_000_000),
      snap('2026-10-01T09:00:00.000Z', 6_000_000, 'admin'),
      snap('2026-10-01T10:00:00.000Z', 7_000_000, 'admin'), // topped up $1 after spending $4
      snap('2026-10-02T00:00:05.000Z', 6_500_000),
      snap('2026-10-03T00:00:05.000Z', 6_400_000),
    ]);
    expect(w.map((x) => x.toppedUp)).toEqual([true, false]);
  });

  test('no windows without two aligned snapshots on different days', () => {
    expect(reconcileWindows([])).toEqual([]);
    expect(reconcileWindows([snap('2026-10-01T00:00:05.000Z', 1), snap('2026-10-01T12:00:00.000Z', 1)])).toEqual([]);
  });
});

describe('drift', () => {
  test('basis points of the provider spend, integer and signed', () => {
    expect(driftBps(1_000_000, 1_000_000)).toBe(0);
    expect(driftBps(1_000_000, 850_000)).toBe(1_500); // provider took 15% more than we metered
    expect(driftBps(1_000_000, 1_200_000)).toBe(-2_000);
    expect(driftBps(3, 2)).toBe(3_333); // truncated
    expect(driftBps(0, 0)).toBe(0);
    expect(driftBps(0, 10)).toBeNull();
    expect(formatBps(1_500)).toBe('15.00%');
    expect(formatBps(-5)).toBe('-0.05%');
    expect(formatBps(null)).toBe('n/a');
  });

  test('alarm only when |drift| > 15% AND |diff| > $0.05', () => {
    expect(driftBreached(1_000_000, 840_000)).toBe(true); // 16%, $0.16
    expect(driftBreached(1_000_000, 850_000)).toBe(false); // exactly 15%: not over
    expect(driftBreached(1_000_000, 1_160_000)).toBe(true); // -16%, we over-meter
    expect(driftBreached(200_000, 100_000)).toBe(true); // 50%, $0.10
    expect(driftBreached(100_000, 50_000)).toBe(false); // 50% but only $0.05
    expect(driftBreached(100_000, 49_999)).toBe(true); // 50%, $0.050001
    expect(driftBreached(10_000_000, 9_000_000)).toBe(false); // $1 but only 10%
    expect(driftBreached(0, 60_000)).toBe(true); // provider took nothing, we metered $0.06
    expect(driftBreached(0, 40_000)).toBe(false);
  });

  const window = (start: number, end: number, toppedUp = false) => ({
    start: snap('2026-10-01T00:00:05.000Z', start),
    end: snap('2026-10-03T00:00:05.000Z', end),
    fromDay: '2026-10-01',
    toDay: '2026-10-03',
    toppedUp,
  });
  const days = [
    { day: '2026-09-30', requests: 50, baseCostMicroUsd: 999_999 }, // before the window
    { day: '2026-10-01', requests: 10, baseCostMicroUsd: 300_000 },
    { day: '2026-10-02', requests: 5, baseCostMicroUsd: 120_000 },
    { day: '2026-10-03', requests: 50, baseCostMicroUsd: 999_999 }, // the end day is excluded
  ];

  test('window spend vs counters of its days [from, to)', () => {
    const r = reconcile(window(10_000_000, 9_500_000), days);
    expect(r).toMatchObject({
      status: 'reconciled', providerSpendMicroUsd: 500_000, meteredBaseMicroUsd: 420_000, requests: 15, diffMicroUsd: 80_000, driftBps: 1_600, breached: true,
    });
    expect(formatReconciliation(r)).toBe(
      '2026-10-01 .. 2026-10-03  provider $0.500000  metered $0.420000 (15 req)  diff $0.080000  drift 16.00%  DRIFT ALARM',
    );
    expect(reconcile(window(10_000_000, 9_580_000), days)).toMatchObject({ diffMicroUsd: 0, driftBps: 0, breached: false });
  });

  test('top-up windows are reported as not reconcilable, never as drift', () => {
    const up = reconcile(window(1_000_000, 6_000_000), days);
    expect(up).toMatchObject({ status: 'topup', driftBps: null, breached: false, meteredBaseMicroUsd: 420_000 });
    expect(formatReconciliation(up)).toMatch(/top-up in window, not reconcilable/);
    expect(reconcile(window(10_000_000, 1_000_000, true), days)).toMatchObject({ status: 'topup', breached: false });
    expect(driftMetricData(up, 'DeepSeek')).toEqual([]);
  });

  test('metrics: drift percent for graphs, breached flag for the alarm', () => {
    expect(driftMetricData(reconcile(window(10_000_000, 9_500_000), days), 'DeepSeek')).toEqual([
      { MetricName: 'DeepSeekDriftPct', Value: 16, Unit: 'Percent' },
      { MetricName: 'DeepSeekDriftMicroUsd', Value: 80_000, Unit: 'None' },
      { MetricName: 'DeepSeekDriftBreached', Value: 1, Unit: 'Count' },
    ]);
    // Provider took nothing but we metered: no percent, still a breach.
    expect(driftMetricData(reconcile(window(1_000_000, 1_000_000), days), 'DeepSeek')).toEqual([
      { MetricName: 'DeepSeekDriftMicroUsd', Value: -420_000, Unit: 'None' },
      { MetricName: 'DeepSeekDriftBreached', Value: 1, Unit: 'Count' },
    ]);
  });
});

describe('reconcile args', () => {
  test('defaults, flags and refusals', () => {
    expect(parseReconcileArgs([])).toEqual({ days: 14, snapshot: false, apply: false });
    expect(parseReconcileArgs(['--days', '30', '--snapshot', '--apply'])).toEqual({ days: 30, snapshot: true, apply: true });
    expect(() => parseReconcileArgs(['--apply'])).toThrow(/--snapshot/);
    expect(() => parseReconcileArgs(['--days', '0'])).toThrow();
    expect(() => parseReconcileArgs(['--days', '1.5'])).toThrow();
    expect(() => parseReconcileArgs(['extra'])).toThrow();
  });
});

describe('scheduled handler', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const ssm = mockClient(SSMClient);
  const cw = mockClient(CloudWatchClient);
  let fetchSpy: jest.SpyInstance;
  const NOW = new Date('2026-10-03T00:00:04.000Z');

  beforeEach(() => {
    ddb.reset();
    ssm.reset();
    cw.reset();
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'sk-secret' } });
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.50', granted_balance: '0', topped_up_balance: '9.50' }] })),
    );
    ddb.on(PutCommand).resolves({});
    cw.on(PutMetricDataCommand).resolves({});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const previous = snapshotItem(snap('2026-10-01T00:00:05.000Z', 10_000_000));
  const mine = snapshotItem({ ...snap(NOW.toISOString(), 9_500_000) });
  const counters = [
    { PK: 'PROVIDER#deepseek', SK: 'DAILY#2026-10-01', requests: 10, baseCostMicroUsd: 300_000 },
    { PK: 'PROVIDER#deepseek', SK: 'DAILY#2026-10-02', requests: 5, baseCostMicroUsd: 120_000 },
  ];

  test('snapshots, reconciles the day window and publishes the drift metrics', async () => {
    ddb.on(QueryCommand).resolvesOnce({ Items: [previous, mine] }).resolvesOnce({ Items: counters });
    const result = await handler();
    expect(result).toMatchObject({ fromDay: '2026-10-01', toDay: '2026-10-03', providerSpendMicroUsd: 500_000, meteredBaseMicroUsd: 420_000, breached: true });

    expect(ssm.commandCalls(GetParameterCommand)[0].args[0].input).toEqual({ Name: '/elder-assistant/model-api-key', WithDecryption: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/user/balance');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-secret');

    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(put).toMatchObject({ TableName: 'tbl', ConditionExpression: 'attribute_not_exists(PK)' });
    expect(put.Item).toMatchObject({ PK: 'PROVIDER#deepseek', SK: 'BALANCE#2026-10-03T00:00:04.000Z', totalBalanceMicroUsd: 9_500_000, source: 'schedule' });

    const [snapQuery, dayQuery] = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(snapQuery.ExpressionAttributeValues).toEqual({ ':pk': 'PROVIDER#deepseek', ':lo': 'BALANCE#2026-08-02T00:00:04.000Z', ':hi': 'BALANCE#2026-10-03T00:00:04.000Z' });
    expect(dayQuery.ExpressionAttributeValues).toEqual({ ':pk': 'PROVIDER#deepseek', ':lo': 'DAILY#2026-10-01', ':hi': 'DAILY#2026-10-03' });

    // First the balance (every run), then the window's drift.
    expect(cw.commandCalls(PutMetricDataCommand)[0].args[0].input.MetricData!.map((m) => m.MetricName)).toEqual(['DeepSeekBalanceUsd', 'DeepSeekUnavailable']);
    const metrics = cw.commandCalls(PutMetricDataCommand)[1].args[0].input;
    expect(metrics.Namespace).toBe('Nieto');
    expect(metrics.MetricData!.map((m) => [m.MetricName, m.Value])).toEqual([
      ['DeepSeekDriftPct', 16], ['DeepSeekDriftMicroUsd', 80_000], ['DeepSeekDriftBreached', 1],
    ]);
    expect(console.error).toHaveBeenCalledWith('PROVIDER_DRIFT', expect.objectContaining({ driftBps: 1_600 }));
    // The key is never logged.
    expect(JSON.stringify([(console.log as jest.Mock).mock.calls, (console.error as jest.Mock).mock.calls])).not.toContain('sk-secret');
  });

  test('the first snapshot only stores itself', async () => {
    ddb.on(QueryCommand).resolvesOnce({ Items: [mine] });
    await expect(handler()).resolves.toBeUndefined();
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    // Only the balance: no window to reconcile yet.
    expect(cw.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('a provider error fails the run before anything is written', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(handler()).rejects.toThrow('HTTP 401');
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('balance metrics', () => {
  test('the balance in USD and whether DeepSeek still serves the account', () => {
    expect(balanceMetricData({ totalBalanceMicroUsd: 2_460_000, isAvailable: true }, 'DeepSeek')).toEqual([
      { MetricName: 'DeepSeekBalanceUsd', Value: 2.46, Unit: 'None' },
      { MetricName: 'DeepSeekUnavailable', Value: 0, Unit: 'Count' },
    ]);
    expect(balanceMetricData({ totalBalanceMicroUsd: 0, isAvailable: false }, 'DeepSeek')[1].Value).toBe(1);
  });
});
