/*
 * Provider free tiers counted account-wide (all apps, all users): e.g. Google gives each billing
 * account 1,000,000 Chirp 3 HD characters a month for free. Apps add to PROVIDER#<provider> /
 * MONTH#<YYYY-MM> in the usage transaction (UsageRecord.providerMonth), check it before a call
 * (Meter.providerMonthCount), and FreeTierWatch (cdk.ts) emails when a month nears its cap. UTC
 * months, like every other counter. Pure; the handler and the admin CLI do the reads.
 */

/** Used as a floored integer percent of `limit` (100 = reached). A zero limit counts as reached. */
export function freeTierPct(used: number, limit: number): number {
  if (!(limit > 0)) return 100;
  return Math.floor((Math.max(0, used) * 100) / limit);
}

/** One provider-month counter as an admin line, e.g. "2026-10  gcp-tts premiumChars  123456 / 900000 (13%)". */
export function formatFreeTierLine(args: { month: string; provider: string; counter: string; used: number; limit: number }): string {
  const { month, provider, counter, used, limit } = args;
  return `${month}  ${provider} ${counter}  ${used} / ${limit} free (${freeTierPct(used, limit)}%)`;
}

/** Members of a DynamoDB string set as the document client returns it (a Set), or of a plain list; 0 when absent. */
export function setSize(value: unknown): number {
  if (value instanceof Set) return value.size;
  return Array.isArray(value) ? new Set(value).size : 0;
}

/** "2026-09" for any instant in October 2026 (UTC). */
export const previousUtcMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

/** The metrics FreeTierWatch publishes for one run: the counter and its percent of the cap. */
export function freeTierMetricData(metricPrefix: string, used: number, limit: number) {
  return [
    { MetricName: `${metricPrefix}Used`, Value: used, Unit: 'Count' as const },
    { MetricName: `${metricPrefix}Pct`, Value: freeTierPct(used, limit), Unit: 'Percent' as const },
  ];
}
