import {
  allocate,
  costExplorerRequest,
  formatPlatformReport,
  mapCostResponse,
  parsePlatformCostsArgs,
  platformReport,
  usageByUser,
} from '../platform';

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('allocate (largest remainder)', () => {
  test('pro rata, exact when it divides', () => {
    const { shares, unallocatedMicroUsd } = allocate(1_000_000, new Map([['a', 3_000], ['b', 1_000]]));
    expect(Object.fromEntries(shares)).toEqual({ a: 750_000, b: 250_000 });
    expect(unallocatedMicroUsd).toBe(0);
  });

  test('parts always sum exactly to the total; leftovers go to the largest remainders', () => {
    const { shares } = allocate(100, new Map([['a', 1], ['b', 1], ['c', 1]]));
    // 33.33 each: one leftover micro-USD, tie on remainder and weight -> smallest key.
    expect(Object.fromEntries(shares)).toEqual({ a: 34, b: 33, c: 33 });
    const uneven = allocate(1_000, new Map([['x', 2], ['y', 3], ['z', 5_000_001]]));
    expect(sum(uneven.shares)).toBe(1_000);
    expect(uneven.shares.get('z')).toBe(1_000);
    for (const total of [0, 1, 7, 999_999, 123_456_789]) {
      const r = allocate(total, new Map([['a', 1_234], ['b', 98_765], ['c', 7], ['d', 0]]));
      expect(sum(r.shares)).toBe(total);
      expect(r.shares.get('d')).toBe(0);
    }
  });

  test('a larger remainder wins over a larger weight', () => {
    // 10 * 1/3 = 3.33, 10 * 2/3 = 6.67: the second has the larger remainder.
    expect(Object.fromEntries(allocate(10, new Map([['a', 1], ['b', 2]])).shares)).toEqual({ a: 3, b: 7 });
  });

  test('zero-duration users get nothing; nobody with duration leaves it unallocated', () => {
    const { shares } = allocate(500, new Map([['busy', 10], ['idle', 0]]));
    expect(Object.fromEntries(shares)).toEqual({ busy: 500, idle: 0 });
    expect(allocate(500, new Map([['idle', 0]]))).toEqual({ shares: new Map([['idle', 0]]), unallocatedMicroUsd: 500 });
    expect(allocate(500, new Map())).toEqual({ shares: new Map(), unallocatedMicroUsd: 500 });
  });

  test('a negative total (credits) splits with the same rounding', () => {
    const { shares } = allocate(-100, new Map([['a', 1], ['b', 1], ['c', 1]]));
    expect(Object.fromEntries(shares)).toEqual({ a: -34, b: -33, c: -33 });
  });
});

describe('Cost Explorer', () => {
  test('one month, UNBLENDED, grouped by service; a running month stops at tomorrow', () => {
    expect(costExplorerRequest('2026-09', new Date('2026-10-01T05:00:00Z'))).toEqual({
      input: {
        TimePeriod: { Start: '2026-09-01', End: '2026-10-01' },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      },
      partial: false,
    });
    expect(costExplorerRequest('2026-10', new Date('2026-10-15T05:00:00Z'))).toMatchObject({
      input: { TimePeriod: { Start: '2026-10-01', End: '2026-10-16' } },
      partial: true,
    });
    expect(costExplorerRequest('2026-12', new Date('2026-12-31T23:00:00Z')).input.TimePeriod).toEqual({ Start: '2026-12-01', End: '2027-01-01' });
    expect(() => costExplorerRequest('2026-11', new Date('2026-10-15T05:00:00Z'))).toThrow(/not started/);
    expect(() => costExplorerRequest('2026-13', new Date())).toThrow();
  });

  test('maps services to integer micro-USD; others are excluded but shown', () => {
    const costs = mapCostResponse({
      ResultsByTime: [{
        Groups: [
          { Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '0.0123456789', Unit: 'USD' } } },
          { Keys: ['Amazon DynamoDB'], Metrics: { UnblendedCost: { Amount: '0.25', Unit: 'USD' } } },
          { Keys: ['AmazonCloudWatch'], Metrics: { UnblendedCost: { Amount: '3.6E-7', Unit: 'USD' } } },
          { Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: '4.00', Unit: 'USD' } } },
          { Keys: ['Tax'], Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } } },
          { Keys: ['AWS Glue'], Metrics: {} },
        ],
      }],
    });
    expect(costs).toEqual({
      services: { 'AWS Lambda': 12_346, 'Amazon DynamoDB': 250_000, AmazonCloudWatch: 0 },
      excluded: { 'Amazon Elastic Compute Cloud - Compute': 4_000_000, Tax: 0 },
      totalMicroUsd: 262_346,
    });
    expect(mapCostResponse({})).toEqual({ services: {}, excluded: {}, totalMicroUsd: 0 });
    expect(() => mapCostResponse({ ResultsByTime: [{ Groups: [{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '1', Unit: 'EUR' } } }] }] })).toThrow(/EUR/);
  });
});

const ev = (sub: string, iso: string, extra: Record<string, unknown> = {}) => ({
  PK: `USER#${sub}`, SK: `EVENT#${iso}#nieto#r-${sub}-${iso}`, appId: 'nieto', householdId: `fam-${sub}`, costMicroUsd: 100, durationMs: 1_000, ...extra,
});

describe('usageByUser', () => {
  test('durations and metered spend per app and user for the UTC month; adjustments count in their event month', () => {
    const items = [
      ev('a', '2026-10-01T00:00:00.000Z'),
      ev('a', '2026-10-31T23:59:59.999Z', { durationMs: 3_000 }),
      ev('a', '2026-11-01T00:00:00.000Z'), // next month
      ev('b', '2026-10-05T00:00:00.000Z', { durationMs: undefined }), // pre-duration event
      { PK: 'USER#a', SK: 'ADJUST#2026-10-01T00:00:00.000Z#nieto#x', appId: 'nieto', householdId: 'fam-a', deltaMicroUsd: -40 },
      { PK: 'USER#c', SK: 'EVENT#2026-10-02T00:00:00.000Z#r1', householdId: 'fam-c', costMicroUsd: 7, durationMs: 500 }, // legacy
      ev('d', '2026-10-03T00:00:00.000Z', { appId: 'recetas' }),
      { PK: 'USER#a', SK: 'DAILY#nieto#2026-10-01', costMicroUsd: 999 }, // counters are not ledger
    ];
    expect(usageByUser(items, '2026-10', 'nieto')).toEqual([
      { appId: 'nieto', sub: 'a', householdId: 'fam-a', requests: 2, requestsWithoutDuration: 0, durationMs: 4_000, meteredMicroUsd: 160 },
      { appId: 'nieto', sub: 'b', householdId: 'fam-b', requests: 1, requestsWithoutDuration: 1, durationMs: 0, meteredMicroUsd: 100 },
      { appId: 'nieto', sub: 'c', householdId: 'fam-c', requests: 1, requestsWithoutDuration: 0, durationMs: 500, meteredMicroUsd: 7 },
      { appId: 'recetas', sub: 'd', householdId: 'fam-d', requests: 1, requestsWithoutDuration: 0, durationMs: 1_000, meteredMicroUsd: 100 },
    ]);
  });
});

describe('platformReport', () => {
  const request = costExplorerRequest('2026-10', new Date('2026-10-20T00:00:00Z'));
  const costs = { services: { 'AWS Lambda': 600_000, 'Amazon DynamoDB': 400_001 }, excluded: { 'Amazon Route 53': 500_000 }, totalMicroUsd: 1_000_001 };

  test('allocates across every app by duration and reports this app per user and household', () => {
    const usage = usageByUser([
      ev('mom', '2026-10-01T10:00:00.000Z', { householdId: 'rubio', durationMs: 3_000 }),
      ev('dad', '2026-10-01T11:00:00.000Z', { householdId: 'rubio', durationMs: 1_000 }),
      ev('dev', '2026-10-02T11:00:00.000Z', { householdId: 'dev', durationMs: 1_000, costMicroUsd: 5 }),
      ev('zoe', '2026-10-03T11:00:00.000Z', { appId: 'recetas', householdId: 'x', durationMs: 5_000 }),
      ev('new', '2026-10-04T11:00:00.000Z', { householdId: 'dev', durationMs: undefined }),
    ], '2026-10', 'nieto');
    const r = platformReport({ month: '2026-10', appId: 'nieto', request, costs, usage });

    expect(r.byUser).toEqual({
      dad: { householdId: 'rubio', requests: 1, durationMs: 1_000, meteredMicroUsd: 100, overheadMicroUsd: 100_000 },
      dev: { householdId: 'dev', requests: 1, durationMs: 1_000, meteredMicroUsd: 5, overheadMicroUsd: 100_000 },
      mom: { householdId: 'rubio', requests: 1, durationMs: 3_000, meteredMicroUsd: 100, overheadMicroUsd: 300_000 },
      new: { householdId: 'dev', requests: 1, durationMs: 0, meteredMicroUsd: 100, overheadMicroUsd: 0 },
    });
    expect(r.byHousehold).toEqual({
      dev: { requests: 2, durationMs: 1_000, meteredMicroUsd: 105, overheadMicroUsd: 100_000 },
      rubio: { requests: 2, durationMs: 4_000, meteredMicroUsd: 200, overheadMicroUsd: 400_000 },
    });
    // zoe's 500000.5 has the largest remainder, so the leftover micro-USD goes to the other app.
    expect(r.otherAppsMicroUsd).toBe(500_001);
    // Every micro-USD lands somewhere: this app plus other apps equals the total.
    expect(r.app.overheadMicroUsd + r.otherAppsMicroUsd).toBe(costs.totalMicroUsd);
    expect(r).toMatchObject({ allocatedMicroUsd: 1_000_001, unallocatedMicroUsd: 0, requestsWithoutDuration: 1, partial: true });

    const text = formatPlatformReport(r);
    expect(text).toContain('Cost Explorer data lags ~24 h, and 2026-10 is not over: this is a partial month.');
    expect(text).toContain('Excluded (not platform)');
    expect(text).toContain('to other apps $0.500001');
    expect(text).toContain('1 nieto events have no durationMs');
    expect(text).toMatch(/mom \(rubio\)\s+1 req\s+3\.0s\s+metered \$0\.000100\s+overhead \$0\.300000\s+total \$0\.300100/);
  });

  test('no events: everything stays unallocated', () => {
    const r = platformReport({ month: '2026-10', appId: 'nieto', request, costs, usage: [] });
    expect(r).toMatchObject({ allocatedMicroUsd: 0, unallocatedMicroUsd: 1_000_001, byUser: {}, byHousehold: {} });
    expect(formatPlatformReport(r)).toContain('unallocated (no durations) $1.000001');
  });
});

describe('platform-costs args', () => {
  test('month required, app defaults to config', () => {
    expect(parsePlatformCostsArgs(['--month', '2026-10'], 'nieto')).toEqual({ month: '2026-10', appId: 'nieto', json: false });
    expect(parsePlatformCostsArgs(['--month=2026-09', '--app', 'recetas', '--json'], 'nieto')).toEqual({ month: '2026-09', appId: 'recetas', json: true });
    expect(() => parsePlatformCostsArgs([], 'nieto')).toThrow(/--month/);
    expect(() => parsePlatformCostsArgs(['--month', '2026-10', '--app', 'Bad#'], 'nieto')).toThrow(/--app/);
  });
});
