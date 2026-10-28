import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { recordUsage, type UsageRecord } from './ledger';

/**
 * Durable retry path for usage an app could not record after the provider already answered.
 * Messages are UsageRecords (any app); recording is idempotent, so redelivery is harmless.
 * A message that keeps failing lands in the dead-letter queue, which alarms; redrive it from the
 * SQS console once the cause is fixed.
 */
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const message of event.Records) {
    try {
      const record = JSON.parse(message.body) as UsageRecord;
      const outcome = await recordUsage(ddb, TABLE_NAME, record);
      console.log('USAGE_RECORD_RETRIED', { appId: record.appId, requestId: record.requestId, outcome });
    } catch (err) {
      console.warn('USAGE_RETRY_FAILED', {
        messageId: message.messageId,
        receiveCount: message.attributes?.ApproximateReceiveCount,
        err,
      });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }
  return { batchItemFailures };
}
