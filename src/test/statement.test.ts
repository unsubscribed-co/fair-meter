import { buildStatement, checkTimeZone, formatStatement, monthRangeUtc, parseStatementArgs, zonedMonth } from '../statement';

const BOGOTA = 'America/Bogota';

describe('Bogota calendar months', () => {
  test.each([
    ['2026-10-01T03:00:00.000Z', '2026-09'], // 22:00 on Sept 30 in Bogota
    ['2026-10-01T04:59:59.999Z', '2026-09'],
    ['2026-10-01T05:00:00.000Z', '2026-10'], // midnight Oct 1 in Bogota
    ['2026-09-01T04:59:59.999Z', '2026-08'],
    ['2026-09-01T05:00:00.000Z', '2026-09'],
    ['2027-01-01T04:00:00.000Z', '2026-12'], // across a year
  ])('%s is %s', (iso, month) => {
    expect(zonedMonth(new Date(iso), BOGOTA)).toBe(month);
  });

  test('month range in UTC', () => {
    expect(monthRangeUtc('2026-09', BOGOTA)).toEqual({ from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z' });
    expect(monthRangeUtc('2026-12', BOGOTA)).toEqual({ from: '2026-12-01T05:00:00.000Z', to: '2027-01-01T05:00:00.000Z' });
    expect(monthRangeUtc('2026-09', 'UTC')).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
  });

  test('works for zones with DST (offset differs at the two ends of the month)', () => {
    // New York: EST (UTC-5) on Mar 1, EDT (UTC-4) from Mar 8.
    expect(monthRangeUtc('2026-03', 'America/New_York')).toEqual({ from: '2026-03-01T05:00:00.000Z', to: '2026-04-01T04:00:00.000Z' });
    // Madrid: CET (UTC+1) on Mar 1, CEST (UTC+2) on Apr 1.
    expect(monthRangeUtc('2026-03', 'Europe/Madrid')).toEqual({ from: '2026-02-28T23:00:00.000Z', to: '2026-03-31T22:00:00.000Z' });
    expect(zonedMonth(new Date('2026-03-31T21:59:59.000Z'), 'Europe/Madrid')).toBe('2026-03');
    expect(zonedMonth(new Date('2026-03-31T22:00:00.000Z'), 'Europe/Madrid')).toBe('2026-04');
  });

  test('unknown zones are refused', () => {
    expect(checkTimeZone(BOGOTA)).toBe(BOGOTA);
    expect(() => checkTimeZone('Mars/Olympus')).toThrow(/time zone/);
  });
});

describe('buildStatement', () => {
  const event = (sub: string, iso: string, cost: number, extra: Record<string, unknown> = {}) => ({
    PK: `USER#${sub}`,
    SK: `EVENT#${iso}#nieto#r-${iso}`,
    appId: 'nieto',
    householdId: 'fam',
    kind: 'chat',
    sku: 'deepseek-v4-flash',
    costMicroUsd: cost,
    ...extra,
  });
  const adjustment = (sub: string, eventIso: string, delta: number, createdAt: string) => ({
    PK: `USER#${sub}`,
    SK: `ADJUST#${eventIso}#nieto#abc`,
    appId: 'nieto',
    householdId: 'fam',
    kind: 'chat',
    sku: 'deepseek-v4-flash',
    eventSk: `EVENT#${eventIso}#nieto#r-${eventIso}`,
    deltaMicroUsd: delta,
    createdAt,
  });
  const items = [
    event('mama', '2026-09-10T15:00:00.000Z', 594),
    event('mama', '2026-10-01T03:00:00.000Z', 400), // Sept 30, 22:00 Bogota: September
    event('mama', '2026-10-01T05:00:00.000Z', 1000), // October in Bogota
    event('papa', '2026-09-01T04:00:00.000Z', 50), // Aug 31, 23:00 Bogota: August
    event('papa', '2026-09-20T12:00:00.000Z', 1600, { kind: 'tts', sku: 'gcp-tts-wavenet', chars: 100 }),
    // Legacy event (no appId, cachedInputTokens): belongs to nieto.
    { PK: 'USER#papa', SK: 'EVENT#2026-09-21T12:00:00.000Z#legacy-1', householdId: 'fam', kind: 'chat', pricingVersion: 'deepseek-v4-flash@2026-09-01', costMicroUsd: 200 },
    event('papa', '2026-09-22T12:00:00.000Z', 999, { appId: 'recetas' }), // other app
    event('papa', '2026-09-23T12:00:00.000Z', 777, { householdId: 'old-household' }), // before moving households
    // Written in October, corrects a September event: counts in September.
    adjustment('mama', '2026-09-10T15:00:00.000Z', -297, '2026-10-02T15:00:00.000Z'),
    // Corrects the Sept 30 22:00 Bogota event (Oct 1 UTC): September too.
    adjustment('mama', '2026-10-01T03:00:00.000Z', -200, '2026-10-02T15:00:00.000Z'),
    { PK: 'USER#mama', SK: 'USAGE#nieto#2026-09', householdId: 'fam', costMicroUsd: 5 }, // not ledger
  ];

  const statement = buildStatement({
    householdId: 'fam', appId: 'nieto', month: '2026-09', timeZone: BOGOTA, legacyAppId: 'nieto', members: ['papa', 'mama', 'tia'], items,
  });

  test('charges, adjustments and totals in the Bogota month', () => {
    expect(statement.from).toBe('2026-09-01T05:00:00.000Z');
    expect(statement.to).toBe('2026-10-01T05:00:00.000Z');
    expect(statement.total).toEqual({ requests: 4, chargesMicroUsd: 594 + 400 + 1600 + 200, adjustments: 2, adjustmentsMicroUsd: -497, totalMicroUsd: 2794 - 497 });
    expect(statement.byUser).toEqual({
      mama: { requests: 2, chargesMicroUsd: 994, adjustments: 2, adjustmentsMicroUsd: -497, totalMicroUsd: 497 },
      papa: { requests: 2, chargesMicroUsd: 1800, adjustments: 0, adjustmentsMicroUsd: 0, totalMicroUsd: 1800 },
      tia: { requests: 0, chargesMicroUsd: 0, adjustments: 0, adjustmentsMicroUsd: 0, totalMicroUsd: 0 },
    });
    expect(statement.byKind).toEqual({
      'chat deepseek-v4-flash': { requests: 3, chargesMicroUsd: 1194, adjustments: 2, adjustmentsMicroUsd: -497, totalMicroUsd: 697 },
      'tts gcp-tts-wavenet': { requests: 1, chargesMicroUsd: 1600, adjustments: 0, adjustmentsMicroUsd: 0, totalMicroUsd: 1600 },
    });
  });

  test('October gets the event at 00:00 Bogota on Oct 1; UTC would differ', () => {
    const october = buildStatement({ householdId: 'fam', appId: 'nieto', month: '2026-10', timeZone: BOGOTA, legacyAppId: 'nieto', members: [], items });
    expect(october.total.chargesMicroUsd).toBe(1000);
    const utc = buildStatement({ householdId: 'fam', appId: 'nieto', month: '2026-10', timeZone: 'UTC', legacyAppId: 'nieto', members: [], items });
    expect(utc.total).toMatchObject({ chargesMicroUsd: 1400, adjustmentsMicroUsd: -200, totalMicroUsd: 1200 });
  });

  test('premium voice calls inside the free tier show as their own $0 line, counted as requests', () => {
    const premium = event('mama', '2026-09-24T12:00:00.000Z', 0, {
      kind: 'tts', sku: 'gcp-tts-chirp3-hd-free', chars: 80, voice: 'es-US-Chirp3-HD-Achird', voiceTier: 'premium', voiceRung: 'chirp-free',
      requestedVoice: 'es-US-Wavenet-B', planDefVersion: 'test@2026-10-01T00:00:00Z', budgetMode: 'normal',
    });
    const s = buildStatement({ householdId: 'fam', appId: 'nieto', month: '2026-09', timeZone: BOGOTA, legacyAppId: 'nieto', members: [], items: [...items, premium, premium] });
    expect(s.byKind['tts gcp-tts-chirp3-hd-free']).toEqual({ requests: 2, chargesMicroUsd: 0, adjustments: 0, adjustmentsMicroUsd: 0, totalMicroUsd: 0 });
    expect(s.total.chargesMicroUsd).toBe(statement.total.chargesMicroUsd);
    expect(formatStatement(s)).toMatch(/tts gcp-tts-chirp3-hd-free\s+2 req {2}charges \$0\.000000/);
  });

  test('formats USD for the CLI and serializes as JSON', () => {
    const text = formatStatement(statement);
    expect(text).toContain('Statement fam, nieto, 2026-09 (America/Bogota');
    expect(text).toContain('total $0.002297');
    expect(text).toContain('adjustments -$0.000497 (2)');
    expect(JSON.parse(JSON.stringify(statement)).byUser.mama.totalMicroUsd).toBe(497);
  });
});

describe('parseStatementArgs', () => {
  test('defaults to the Bogota zone and the default app', () => {
    expect(parseStatementArgs(['fam', '--month', '2026-09'], 'nieto')).toEqual({ householdId: 'fam', month: '2026-09', appId: 'nieto', timeZone: BOGOTA, json: false });
    expect(parseStatementArgs(['fam', '--month=2026-09', '--tz', 'UTC', '--app', 'recetas', '--json'], 'nieto'))
      .toEqual({ householdId: 'fam', month: '2026-09', appId: 'recetas', timeZone: 'UTC', json: true });
  });

  test('needs a household and a month', () => {
    expect(() => parseStatementArgs(['--month', '2026-09'], 'nieto')).toThrow(/householdId/);
    expect(() => parseStatementArgs(['fam'], 'nieto')).toThrow(/--month/);
    expect(() => parseStatementArgs(['fam', '--month', '2026-13'], 'nieto')).toThrow(/--month/);
  });
});

describe('ledgerKind', () => {
  test('old events without kind are labelled by what was metered; their adjustments follow', () => {
    const { ledgerKind } = require('../statement') as typeof import('../statement');
    expect(ledgerKind({ kind: 'chat' })).toBe('chat');
    expect(ledgerKind({ inputTokens: 10, outputTokens: 2 })).toBe('chat');
    expect(ledgerKind({ cachedInputTokens: 9000 })).toBe('chat');
    expect(ledgerKind({ chars: 120 })).toBe('tts');
    expect(ledgerKind({ kind: 'unknown' })).toBe('unknown');
  });
});
