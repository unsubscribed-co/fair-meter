import { adjustmentId } from '../adjust';
import { formatRepricePlan, parseRepriceArgs, planReprice, repriceEvent, storedMeters, type PriceHistory } from '../reprice';

const offPeak = { inputMicroUsdPerMTok: 150_000, cachedInputMicroUsdPerMTok: 3_000, outputMicroUsdPerMTok: 600_000 };
const peak = { inputMicroUsdPerMTok: 300_000, cachedInputMicroUsdPerMTok: 6_000, outputMicroUsdPerMTok: 1_200_000 };

// The price list as stored now: September's version carries the official bands.
const history: PriceHistory = {
  'deepseek-v4-flash': [
    {
      PK: 'PRICING#deepseek-v4-flash',
      SK: '2026-09-01',
      validFrom: '2026-09-01T00:00:00Z',
      validTo: '2026-11-01T00:00:00Z',
      ...offPeak,
      bands: [{ name: 'peak', days: [1, 2, 3, 4, 5], hours: [{ startHour: 1, endHour: 4 }, { startHour: 6, endHour: 10 }], ...peak }],
    },
  ],
  'gcp-tts-wavenet': [{ PK: 'PRICING#gcp-tts-wavenet', SK: '2026-09-01', validFrom: '2026-09-01T00:00:00Z', microUsdPerMChars: 16_000_000 }],
};

// 1000 input + 9000 cache-read + 200 output tokens. At peak rates: 300 + 54 + 240 = 594 micro-USD.
// Off-peak: 150 + 27 + 120 = 297.
const legacyChat = (iso: string, extra: Record<string, unknown> = {}) => ({
  PK: 'USER#u1',
  SK: `EVENT#${iso}#req-${iso}`,
  kind: 'chat',
  householdId: 'fam',
  model: 'deepseek-v4-flash',
  inputTokens: 1000,
  cachedInputTokens: 9000,
  outputTokens: 200,
  pricingVersion: 'deepseek-v4-flash@2026-09-01',
  baseCostMicroUsd: 594,
  costMicroUsd: 594, // flat = peak price, the known bug
  markupBps: 0,
  ...extra,
});
const SATURDAY_NOON = '2026-09-26T12:00:00.000Z'; // off-peak
const WEDNESDAY_PEAK = '2026-09-30T02:00:00.000Z';

describe('repriceEvent', () => {
  test('an off-peak call charged the old flat (peak) rate gets a negative delta', () => {
    expect(repriceEvent(legacyChat(SATURDAY_NOON), history)).toEqual({
      status: 'changed',
      sku: 'deepseek-v4-flash',
      oldPricingVersion: 'deepseek-v4-flash@2026-09-01',
      newPricingVersion: 'deepseek-v4-flash@2026-09-01',
      oldCostMicroUsd: 594,
      newCostMicroUsd: 297,
      deltaMicroUsd: -297,
      band: 'default',
    });
  });

  test('with pricesAt, a flat September list is corrected by the October one, band from the event time', () => {
    const flatThenBands: PriceHistory = {
      'deepseek-v4-flash': [
        { PK: 'PRICING#deepseek-v4-flash', SK: '2026-09-01', validFrom: '2026-09-01T00:00:00Z', validTo: '2026-10-01T00:00:00Z', ...peak },
        { ...history['deepseek-v4-flash'][0], SK: '2026-10-01', validFrom: '2026-10-01T00:00:00Z', validTo: undefined },
      ],
    };
    // By the event's own time the flat list applies: nothing to correct.
    expect(repriceEvent(legacyChat(SATURDAY_NOON), flatThenBands)).toMatchObject({ status: 'unchanged' });
    const pricesAt = new Date('2026-10-01T12:00:00Z'); // a Thursday at peak: must not leak into the band choice
    expect(repriceEvent(legacyChat(SATURDAY_NOON), flatThenBands, [], pricesAt)).toMatchObject({
      status: 'changed', newPricingVersion: 'deepseek-v4-flash@2026-10-01', newCostMicroUsd: 297, deltaMicroUsd: -297,
    });
    expect(repriceEvent(legacyChat(WEDNESDAY_PEAK), flatThenBands, [], pricesAt)).toMatchObject({ status: 'unchanged', costMicroUsd: 594 });
    expect(parseRepriceArgs(['--from', '2026-09-01', '--to', '2026-10-01', '--prices-at', '2026-10-01T12:00:00Z'], 'nieto').pricesAt)
      .toBe('2026-10-01T12:00:00.000Z');
  });

  test('a peak call is unchanged', () => {
    expect(repriceEvent(legacyChat(WEDNESDAY_PEAK), history)).toEqual({
      status: 'unchanged', sku: 'deepseek-v4-flash', pricingVersion: 'deepseek-v4-flash@2026-09-01', costMicroUsd: 594,
    });
  });

  test('missing meters are unrepriceable, never guessed', () => {
    const { outputTokens, ...noOutput } = legacyChat(SATURDAY_NOON);
    expect(repriceEvent(noOutput, history)).toMatchObject({ status: 'unrepriceable', reason: 'missing meters (tokens)' });
    const { cachedInputTokens, ...noCache } = legacyChat(SATURDAY_NOON);
    expect(repriceEvent(noCache, history)).toMatchObject({ status: 'unrepriceable', reason: 'missing meters (tokens)' });
    const { markupBps, ...noMarkup } = legacyChat(SATURDAY_NOON);
    expect(repriceEvent(noMarkup, history)).toMatchObject({ status: 'unrepriceable', reason: 'missing markupBps' });
  });

  test('no price version at the event time is unrepriceable', () => {
    expect(repriceEvent(legacyChat('2026-08-31T23:59:59.000Z'), history)).toMatchObject({ status: 'unrepriceable', reason: 'no price version covers the event time' });
    expect(repriceEvent({ ...legacyChat(SATURDAY_NOON), pricingVersion: 'other@2026-09-01' }, history)).toMatchObject({ status: 'unrepriceable', sku: 'other' });
  });

  test('new-format events use sku, canonical meters and markup', () => {
    const event = {
      ...legacyChat(SATURDAY_NOON),
      SK: `EVENT#${SATURDAY_NOON}#nieto#req-1`,
      appId: 'nieto',
      sku: 'deepseek-v4-flash',
      cachedInputTokens: undefined,
      cacheReadTokens: 9000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      markupBps: 1000,
      costMicroUsd: 654, // 594 + 10%, rounded up
    };
    expect(repriceEvent(event, history)).toMatchObject({ status: 'changed', oldCostMicroUsd: 654, newCostMicroUsd: 327, deltaMicroUsd: -327 });
  });

  test('TTS events reprice per character', () => {
    const tts = { PK: 'USER#u1', SK: `EVENT#${SATURDAY_NOON}#req-t`, kind: 'tts', householdId: 'fam', voice: 'es-US-Wavenet-A', chars: 100,
      pricingVersion: 'gcp-tts-wavenet@2026-09-01', costMicroUsd: 1600, markupBps: 0 };
    expect(repriceEvent(tts, history)).toMatchObject({ status: 'unchanged', costMicroUsd: 1600 });
    expect(repriceEvent({ ...tts, costMicroUsd: 2000 }, history)).toMatchObject({ status: 'changed', deltaMicroUsd: -400 });
    const { chars, ...noChars } = tts;
    expect(repriceEvent(noChars, history)).toMatchObject({ status: 'unrepriceable', reason: 'missing meters (chars)' });
  });

  test('a $0 SKU (Chirp 3 HD inside the free pool) reprices like any other: 0 is a price, not a missing one', () => {
    const free: PriceHistory = {
      ...history,
      'gcp-tts-chirp3-hd-free': [
        { PK: 'PRICING#gcp-tts-chirp3-hd-free', SK: '2026-10-01T00:00:00Z', validFrom: '2026-10-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z', microUsdPerMChars: 0 },
        // A later (hypothetical) paid version never touches October's calls.
        { PK: 'PRICING#gcp-tts-chirp3-hd-free', SK: '2026-11-01T00:00:00Z', validFrom: '2026-11-01T00:00:00Z', microUsdPerMChars: 30_000_000 },
      ],
    };
    const chirp = {
      PK: 'USER#u1', SK: 'EVENT#2026-10-15T12:00:00.000Z#nieto#req-c', appId: 'nieto', kind: 'tts', householdId: 'fam',
      sku: 'gcp-tts-chirp3-hd-free', voice: 'es-US-Chirp3-HD-Achird', voiceRung: 'chirp-free', chars: 120,
      pricingVersion: 'gcp-tts-chirp3-hd-free@2026-10-01T00:00:00Z', costMicroUsd: 0, markupBps: 0,
    };
    expect(repriceEvent(chirp, free)).toEqual({ status: 'unchanged', sku: 'gcp-tts-chirp3-hd-free', pricingVersion: 'gcp-tts-chirp3-hd-free@2026-10-01T00:00:00Z', costMicroUsd: 0 });
    // Charged by mistake: the correction brings it back to 0.
    expect(repriceEvent({ ...chirp, costMicroUsd: 3_600 }, free)).toMatchObject({ status: 'changed', newCostMicroUsd: 0, deltaMicroUsd: -3_600 });
    // A markup on $0 is still $0.
    expect(repriceEvent({ ...chirp, markupBps: 1000 }, free)).toMatchObject({ status: 'unchanged', costMicroUsd: 0 });
    // Priced as of November instead (--prices-at): the paid rate, an explicit correction only.
    expect(repriceEvent(chirp, free, [], new Date('2026-11-02T00:00:00Z'))).toMatchObject({ status: 'changed', newCostMicroUsd: 3_600 });
    const plan = planReprice({
      events: [chirp], adjustments: [], priceHistory: free, appId: 'nieto', legacyAppId: 'nieto', sku: 'gcp-tts-chirp3-hd-free',
      reason: 'reprice-free', now: new Date('2026-10-20T00:00:00Z'),
    });
    expect(plan.counts).toEqual({ changed: 0, unchanged: 1, unrepriceable: 0, alreadyAdjusted: 0 });
  });

  test('compares against the cost after earlier adjustments, so corrections never stack', () => {
    const prior = [{ deltaMicroUsd: -297, newPricingVersion: 'deepseek-v4-flash@2026-09-01', createdAt: '2026-10-02T00:00:00Z' }];
    expect(repriceEvent(legacyChat(SATURDAY_NOON), history, prior)).toMatchObject({ status: 'unchanged', costMicroUsd: 297 });
  });

  test('stored meters: legacy cache reads, absent newer meters are zero', () => {
    expect(storedMeters(legacyChat(SATURDAY_NOON))).toEqual({ inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0 });
    expect(storedMeters({ ...legacyChat(SATURDAY_NOON), reasoningTokens: -1 })).toBeUndefined();
  });
});

describe('planReprice', () => {
  const events = [
    legacyChat(SATURDAY_NOON),
    legacyChat(WEDNESDAY_PEAK),
    { ...legacyChat('2026-09-27T12:00:00.000Z'), PK: 'USER#u2', householdId: 'other' },
    { ...legacyChat('2026-09-27T13:00:00.000Z'), outputTokens: undefined },
    { ...legacyChat('2026-09-27T14:00:00.000Z'), appId: 'recetas', SK: 'EVENT#2026-09-27T14:00:00.000Z#recetas#r' },
    { PK: 'USER#u1', SK: 'USAGE#2026-09', costMicroUsd: 9 }, // not an event
  ];
  const base = { events, adjustments: [], priceHistory: history, appId: 'nieto', legacyAppId: 'nieto', reason: 'reprice-offpeak', now: new Date('2026-10-02T15:00:00Z') };

  test('adjusts changed events only and totals per household and user', () => {
    const plan = planReprice(base);
    expect(plan.counts).toEqual({ changed: 2, unchanged: 1, unrepriceable: 1, alreadyAdjusted: 0 });
    expect(plan.adjustments.map((a) => [a.sub, a.eventSk, a.deltaMicroUsd])).toEqual([
      ['u1', `EVENT#${SATURDAY_NOON}#req-${SATURDAY_NOON}`, -297],
      ['u2', 'EVENT#2026-09-27T12:00:00.000Z#req-2026-09-27T12:00:00.000Z', -297],
    ]);
    expect(plan.adjustments[0]).toMatchObject({
      appId: 'nieto', householdId: 'fam', legacyEvent: true, deductCredit: true, eventTime: SATURDAY_NOON, kind: 'chat',
      sku: 'deepseek-v4-flash', reason: 'reprice-offpeak', createdAt: '2026-10-02T15:00:00.000Z', details: { newPricingBand: 'default' },
    });
    expect(plan.byHousehold.get('fam')).toEqual({ events: 2, oldMicroUsd: 1188, newMicroUsd: 891, deltaMicroUsd: -297 });
    expect(plan.byUser.get('u2')).toEqual({ events: 1, oldMicroUsd: 594, newMicroUsd: 297, deltaMicroUsd: -297 });
    const text = formatRepricePlan(plan);
    expect(text).toContain('2 changed, 1 unchanged, 1 unrepriceable');
    expect(text).toContain('Total delta: -$0.000594');
    expect(text).toContain('missing meters (tokens)');
  });

  test('swept and aborted EVENTs are left as charged: absorbed stays equal to cost, never shifted onto the person', () => {
    const absorbed = (estimated: string) => legacyChat(SATURDAY_NOON, { SK: `EVENT#${SATURDAY_NOON}#${estimated}`, estimated, absorbedMicroUsd: 594 });
    const plan = planReprice({ ...base, events: [absorbed('swept'), absorbed('aborted')] });
    expect(plan.adjustments).toEqual([]);
    expect(plan.unrepriceable.map((u) => u.reason)).toEqual(['estimated usage', 'estimated usage']);
  });

  test("billing 'none': corrections of plan-less events never touch credit", () => {
    expect(planReprice({ ...base, billing: 'none' }).adjustments.map((a) => a.deductCredit)).toEqual([false, false]);
  });

  test('filters by sku and app (recetas events are not nieto)', () => {
    expect(planReprice({ ...base, sku: 'gcp-tts-wavenet' }).counts).toEqual({ changed: 0, unchanged: 0, unrepriceable: 0, alreadyAdjusted: 0 });
    expect(planReprice({ ...base, appId: 'recetas' }).counts.changed).toBe(1);
  });

  test('re-running after apply plans nothing; a correction already made under this reason is flagged', () => {
    const eventSk = `EVENT#${SATURDAY_NOON}#req-${SATURDAY_NOON}`;
    const applied = { PK: 'USER#u1', eventSk, adjustmentId: adjustmentId('reprice-offpeak', eventSk), deltaMicroUsd: -297, newPricingVersion: 'x', createdAt: '2026-10-02T15:00:00Z' };
    expect(planReprice({ ...base, adjustments: [applied] }).adjustments.map((a) => a.sub)).toEqual(['u2']);
    // Same reason but the prior adjustment did not reach today's price (e.g. prices changed again).
    const partial = { ...applied, deltaMicroUsd: -100 };
    const plan = planReprice({ ...base, adjustments: [partial] });
    expect(plan.counts.alreadyAdjusted).toBe(1);
    expect(plan.alreadyAdjusted).toEqual([{ sub: 'u1', sk: eventSk }]);
  });
});

describe('parseRepriceArgs', () => {
  test('dates, instants, defaults', () => {
    expect(parseRepriceArgs(['--from', '2026-09-01', '--to', '2026-10-01'], 'nieto')).toEqual({
      appId: 'nieto', from: '2026-09-01', to: '2026-10-01', reason: 'reprice', apply: false,
    });
    expect(parseRepriceArgs(['--app', 'nieto', '--from=2026-09-30T19:00:00-05:00', '--to', '2026-10-02', '--sku', 'deepseek-v4-flash', '--reason', 'fix-1', '--apply'], 'x'))
      .toEqual({ appId: 'nieto', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02', sku: 'deepseek-v4-flash', reason: 'fix-1', apply: true });
  });

  test('refuses missing or reversed ranges and zone-less instants', () => {
    expect(() => parseRepriceArgs(['--to', '2026-10-01'], 'nieto')).toThrow(/--from/);
    expect(() => parseRepriceArgs(['--from', '2026-10-01', '--to', '2026-09-01'], 'nieto')).toThrow(/before/);
    expect(() => parseRepriceArgs(['--from', '2026-09-01T10:00', '--to', '2026-10-01'], 'nieto')).toThrow(/Invalid --from/);
    expect(() => parseRepriceArgs(['--from', '2026-09-01', '--to', '2026-10-01', '--reason', 'Bad'], 'nieto')).toThrow(/reason/);
  });
});
