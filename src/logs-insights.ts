import { GetQueryResultsCommand, StartQueryCommand, type CloudWatchLogsClient, type ResultField, type StartQueryCommandInput } from '@aws-sdk/client-cloudwatch-logs';

/** Logs Insights returns at most this many rows per query: that many means some may be cut. */
export const QUERY_ROW_LIMIT = 10_000;

/** Starts one Logs Insights query (at most QUERY_ROW_LIMIT rows) and polls it every second until it completes. */
export async function runQuery(cwl: CloudWatchLogsClient, input: Omit<StartQueryCommandInput, 'limit'>): Promise<ResultField[][]> {
  const { queryId } = await cwl.send(new StartQueryCommand({ ...input, limit: QUERY_ROW_LIMIT }));
  for (;;) {
    const out = await cwl.send(new GetQueryResultsCommand({ queryId }));
    if (out.status === 'Complete') return out.results ?? [];
    if (out.status !== 'Scheduled' && out.status !== 'Running') throw new Error(`Logs Insights query ${out.status} (${queryId})`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
