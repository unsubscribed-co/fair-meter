import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { exportKey, exportRow, streamRuns, toNdjson } from './export';

/**
 * Table stream consumer: new EVENT#/ADJUST# items (the event source filter drops everything else)
 * become NDJSON objects in the export bucket, one per run of same app and day.
 *
 * On a failed write it reports that run's first record as the batch item failure, so Lambda retries
 * from there; earlier runs are not rewritten. After the retries are exhausted the batch's metadata
 * goes to the on-failure queue, which alarms; repair with `export-backfill` (see the README).
 */
const BUCKET_NAME = process.env.BUCKET_NAME ?? '';
const LEGACY_APP_ID = process.env.LEGACY_APP_ID ?? '';
const s3 = new S3Client({});

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const records = event.Records.flatMap((r) => {
    const image = r.dynamodb?.NewImage;
    if (r.eventName !== 'INSERT' || !image || !r.eventID || !r.dynamodb?.SequenceNumber) return [];
    const item = exportRow(unmarshall(image as Parameters<typeof unmarshall>[0]), LEGACY_APP_ID);
    return item ? [{ eventId: r.eventID, sequenceNumber: r.dynamodb.SequenceNumber, item }] : [];
  });

  for (const run of streamRuns(records)) {
    const key = exportKey(run.appId, run.dt, run.batchId);
    try {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: toNdjson(run.rows), ContentType: 'application/x-ndjson' }));
    } catch (err) {
      console.warn('LEDGER_EXPORT_RETRY', { key, rows: run.rows.length, err });
      return { batchItemFailures: [{ itemIdentifier: run.firstSequenceNumber }] };
    }
  }
  console.log('LEDGER_EXPORTED', { records: records.length });
  return { batchItemFailures: [] };
}
