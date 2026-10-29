import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { keys } from './keys';
import { recordable } from './retry-handler';

/**
 * Nightly: puts the valid records parked in the retry DLQ back on the retry queue, so a DynamoDB
 * outage heals itself. Each call at most MAX_REDRIVES times, counted on REDRIVE#<app> / CALL#<callId>
 * before the send: a crash between steps either counts a redrive that didn't happen (conservative)
 * or duplicates a message (recording is idempotent on the EVENT key). Invalid records and calls at
 * the limit stay in the DLQ, so its alarms stay on until a human looks.
 */
export const MAX_REDRIVES = 3;
const COUNT_DAYS = 30;
/** Longer than the Lambda's timeout (cdk.ts): a message left in the DLQ isn't received twice in one run. */
const VISIBILITY_SECONDS = 6 * 60;

export async function redrive(
  ddb: DynamoDBDocumentClient,
  sqs: SQSClient,
  cfg: { tableName: string; queueUrl: string; dlqUrl: string },
  now: Date,
): Promise<{ redriven: number; invalid: number; limited: number; failed: number }> {
  const result = { redriven: 0, invalid: 0, limited: 0, failed: 0 };
  for (;;) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: cfg.dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: VISIBILITY_SECONDS,
    }));
    if (!Messages.length) return result;
    for (const m of Messages) {
      const record = recordable(m.Body ?? '', cfg.tableName);
      if (!record) {
        result.invalid++;
        continue;
      }
      const facts = { appId: record.appId, callId: record.requestId, messageId: m.MessageId };
      try {
        await ddb.send(new UpdateCommand({
          TableName: cfg.tableName,
          Key: keys.redrive(record.appId, record.requestId),
          UpdateExpression: 'ADD redrives :one SET expiresAt = :exp',
          ConditionExpression: 'attribute_not_exists(redrives) OR redrives < :max',
          ExpressionAttributeValues: { ':one': 1, ':max': MAX_REDRIVES, ':exp': Math.floor(now.getTime() / 1000) + COUNT_DAYS * 86_400 },
        }));
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
          console.warn('REDRIVE_LIMIT', { ...facts, redrives: MAX_REDRIVES });
          result.limited++;
        } else {
          console.error('REDRIVE_FAILED', { ...facts, err });
          result.failed++;
        }
        continue;
      }
      try {
        await sqs.send(new SendMessageCommand({ QueueUrl: cfg.queueUrl, MessageBody: m.Body }));
        await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.dlqUrl, ReceiptHandle: m.ReceiptHandle }));
        console.log('REDRIVEN', facts);
        result.redriven++;
      } catch (err) {
        console.error('REDRIVE_FAILED', { ...facts, err });
        result.failed++;
      }
    }
  }
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

/** 04:00 UTC every night (MeteringRetry's schedule). */
export const handler = () =>
  redrive(ddb, sqs, { tableName: process.env.TABLE_NAME ?? '', queueUrl: process.env.QUEUE_URL ?? '', dlqUrl: process.env.DLQ_URL ?? '' }, new Date());
