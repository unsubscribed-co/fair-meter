import {
  parseBandSpec,
  parseDays,
  parseHours,
  parsePriceSetArgs,
  scheduleFromItem,
  selectPrice,
  type PricingSchedule,
} from '../pricing';

const offPeak = { inputMicroUsdPerMTok: 150_000, cachedInputMicroUsdPerMTok: 3_000, outputMicroUsdPerMTok: 600_000 };
const peak = { inputMicroUsdPerMTok: 300_000, cachedInputMicroUsdPerMTok: 6_000, outputMicroUsdPerMTok: 1_200_000 };

const deepseek: PricingSchedule = {
  default: offPeak,
  bands: [
    {
      name: 'peak',
      days: [1, 2, 3, 4, 5],
      hours: [{ startHour: 1, endHour: 4 }, { startHour: 6, endHour: 10 }],
      ...peak,
    },
  ],
};

// 2026-09-30 is a Wednesday, 2026-10-03 a Saturday, 2026-10-04 a Sunday.
const at = (iso: string) => new Date(iso);

describe('selectPrice', () => {
  test.each([
    ['2026-09-30T01:00:00.000Z', 'peak'], // first window start is inclusive
    ['2026-09-30T03:59:59.999Z', 'peak'],
    ['2026-09-30T04:00:00.000Z', 'default'], // end is exclusive
    ['2026-09-30T05:30:00.000Z', 'default'], // gap between windows
    ['2026-09-30T06:00:00.000Z', 'peak'], // second window
    ['2026-09-30T09:59:59.999Z', 'peak'],
    ['2026-09-30T10:00:00.000Z', 'default'],
    ['2026-09-30T00:59:59.999Z', 'default'],
    ['2026-09-30T23:00:00.000Z', 'default'],
    ['2026-10-03T02:00:00.000Z', 'default'], // Saturday
    ['2026-10-04T07:00:00.000Z', 'default'], // Sunday
    ['2026-10-02T09:00:00.000Z', 'peak'], // Friday
    ['2026-09-28T01:30:00.000Z', 'peak'], // Monday
  ])('%s -> %s', (iso, band) => {
    const selected = selectPrice(deepseek, at(iso));
    expect(selected.band).toBe(band);
    expect(selected.price).toEqual(band === 'peak' ? peak : offPeak);
  });

  test('uses UTC, not the local time zone', () => {
    // 02:00 UTC Wednesday is still Tuesday evening in the Americas.
    expect(selectPrice(deepseek, at('2026-09-29T21:00:00-05:00')).band).toBe('peak');
  });

  test('without bands returns the flat price and no band name', () => {
    expect(selectPrice({ default: offPeak, bands: [] }, at('2026-09-30T02:00:00Z'))).toEqual({ price: offPeak });
  });

  test('first matching band wins and a window may end at 24', () => {
    const schedule: PricingSchedule = {
      default: offPeak,
      bands: [
        { name: 'night', days: [0, 1, 2, 3, 4, 5, 6], hours: [{ startHour: 22, endHour: 24 }], ...peak },
        { name: 'all', days: [0, 1, 2, 3, 4, 5, 6], hours: [{ startHour: 0, endHour: 24 }], ...offPeak },
      ],
    };
    expect(selectPrice(schedule, at('2026-09-30T23:59:59Z')).band).toBe('night');
    expect(selectPrice(schedule, at('2026-09-30T21:59:59Z')).band).toBe('all');
  });
});

describe('scheduleFromItem', () => {
  const flatItem = { PK: 'PRICING#m', SK: '2026-09-29', ...peak };

  test('an item without bands is a flat price (backward compatible)', () => {
    expect(scheduleFromItem(flatItem)).toEqual({ default: peak, bands: [] });
  });

  test('reads bands', () => {
    const item = { ...flatItem, ...offPeak, bands: deepseek.bands };
    expect(scheduleFromItem(item)).toEqual(deepseek);
  });

  test.each([
    ['missing default rate', { inputMicroUsdPerMTok: 1, cachedInputMicroUsdPerMTok: 1 }],
    ['fractional rate', { ...peak, outputMicroUsdPerMTok: 1.5 }],
    ['bands not a list', { ...peak, bands: 'peak' }],
    ['band missing a rate', { ...peak, bands: [{ ...deepseek.bands[0], outputMicroUsdPerMTok: undefined }] }],
    ['band without name', { ...peak, bands: [{ ...deepseek.bands[0], name: '' }] }],
    ['band named default', { ...peak, bands: [{ ...deepseek.bands[0], name: 'default' }] }],
    ['band without days', { ...peak, bands: [{ ...deepseek.bands[0], days: [] }] }],
    ['bad day', { ...peak, bands: [{ ...deepseek.bands[0], days: [7] }] }],
    ['band without hours', { ...peak, bands: [{ ...deepseek.bands[0], hours: [] }] }],
    ['reversed window', { ...peak, bands: [{ ...deepseek.bands[0], hours: [{ startHour: 10, endHour: 6 }] }] }],
    ['empty window', { ...peak, bands: [{ ...deepseek.bands[0], hours: [{ startHour: 3, endHour: 3 }] }] }],
    ['hour past 24', { ...peak, bands: [{ ...deepseek.bands[0], hours: [{ startHour: 20, endHour: 25 }] }] }],
  ])('rejects %s', (_label, item) => {
    expect(scheduleFromItem(item)).toBeUndefined();
  });
});

describe('admin band parsing', () => {
  test('parseDays', () => {
    expect(parseDays('mon-fri')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays('sat,sun')).toEqual([0, 6]);
    expect(parseDays('mon,wed-fri')).toEqual([1, 3, 4, 5]);
    expect(parseDays('ALL')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(() => parseDays('fri-mon')).toThrow();
    expect(() => parseDays('weekdays')).toThrow();
  });

  test('parseHours', () => {
    expect(parseHours('01-04,06-10')).toEqual([{ startHour: 1, endHour: 4 }, { startHour: 6, endHour: 10 }]);
    expect(parseHours('22-24')).toEqual([{ startHour: 22, endHour: 24 }]);
    expect(() => parseHours('22-02')).toThrow(); // no wrap past midnight
    expect(() => parseHours('04-04')).toThrow();
    expect(() => parseHours('1-25')).toThrow();
    expect(() => parseHours('1to4')).toThrow();
  });

  test('parseBandSpec converts USD to integer micro-USD', () => {
    expect(parseBandSpec('peak:mon-fri:01-04,06-10:0.3:0.006:1.2')).toEqual(deepseek.bands[0]);
    expect(() => parseBandSpec('peak:mon-fri:01-04:0.3:0.006')).toThrow();
    expect(() => parseBandSpec('default:mon-fri:01-04:0.3:0.006:1.2')).toThrow();
    expect(() => parseBandSpec('peak:mon-fri:01-04:0.3:0.006:-1')).toThrow();
  });

  test('parsePriceSetArgs keeps the old positional usage working', () => {
    expect(parsePriceSetArgs(['m', '2026-10-01', '0.27', '0.07', '1.1'])).toEqual({
      positional: ['m', '2026-10-01', '0.27', '0.07', '1.1'],
      bands: [],
      tiers: [],
      backdate: false,
    });
  });

  test('parsePriceSetArgs collects bands in either flag form', () => {
    const { positional, bands } = parsePriceSetArgs([
      'deepseek-v4-flash', '2026-10-01', '0.15', '0.003', '0.6',
      '--band', 'peak:mon-fri:01-04,06-10:0.3:0.006:1.2',
      '--band=weekend:sat,sun:00-24:0.1:0.001:0.5',
    ]);
    expect(positional).toEqual(['deepseek-v4-flash', '2026-10-01', '0.15', '0.003', '0.6']);
    expect(bands.map((b) => b.name)).toEqual(['peak', 'weekend']);
    expect(bands[1].days).toEqual([0, 6]);
  });

  test('parsePriceSetArgs rejects a dangling flag and duplicate names', () => {
    expect(() => parsePriceSetArgs(['m', 'd', '1', '1', '1', '--band'])).toThrow();
    expect(() =>
      parsePriceSetArgs(['--band', 'p:all:00-01:1:1:1', '--band', 'p:all:02-03:1:1:1']),
    ).toThrow();
  });
});
