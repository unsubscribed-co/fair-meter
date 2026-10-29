import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { recordUsage, usageTransaction, type UsageRecord } from './ledger';

/**
 * Durable retry path for usage an app could not record after the provider already answered.
 * Messages are UsageRecords (any app); recording is idempotent, so redelivery is harmless.
 * A message that can never be recorded is parked in the dead-letter queue at once; one that keeps
 * failing lands there after 10 receives. The DLQ alarms; the nightly redrive (redrive-handler.ts)
 * puts its valid records back.
 */
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const DLQ_URL = process.env.DLQ_URL ?? '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

/** The record a message holds, or undefined when it can never be recorded (not JSON, no keys, no transaction). */
export function recordable(body: string, table: string): UsageRecord | undefined {
  try {
    const r = JSON.parse(body) as UsageRecord;
    if (![r.appId, r.sub, r.requestId, r.requestTime].every((v) => typeof v === 'string' && v)) return undefined;
    usageTransaction(table, r);
    return r;
  } catch {
    return undefined;
  }
}

export async function retryUsage(
  ddb: DynamoDBDocumentClient,
  sqs: SQSClient,
  cfg: { tableName: string; dlqUrl: string },
  event: SQSEvent,
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const message of event.Records) {
    try {
      const record = recordable(message.body, cfg.tableName);
      if (!record) {
        await sqs.send(new SendMessageCommand({ QueueUrl: cfg.dlqUrl, MessageBody: message.body }));
        console.error('USAGE_RECORD_PARKED', { messageId: message.messageId });
        continue;
      }
      const outcome = await recordUsage(ddb, cfg.tableName, record);
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

export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => retryUsage(ddb, sqs, { tableName: TABLE_NAME, dlqUrl: DLQ_URL }, event);
