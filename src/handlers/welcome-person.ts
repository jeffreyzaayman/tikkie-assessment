import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { PersonCreatedEvent } from '../events';
import { requireEnv } from '../http';
import { parsePersonCreatedEvent } from '../welcome';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// How long a processed eventId is remembered; well beyond the queue's 4-day retention.
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Welcome Service consumer: welcomes every newly created person once.
 *
 * Delivery is at least once (SNS and SQS standard), so each eventId is claimed in the
 * processed-events table first; a duplicate finds the claim and is skipped. Failed messages are
 * reported individually, so only they are retried (and moved to the DLQ after 5 receives).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      // Log only message metadata: the body contains personal data.
      console.error(
        JSON.stringify({
          message: 'Failed to process person-created message',
          messageId: record.messageId,
          errorName: error instanceof Error ? error.name : 'Unknown',
          errorMessage: error instanceof Error ? error.message : undefined,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const event = parsePersonCreatedEvent(record.body);
  const tableName = requireEnv('PROCESSED_EVENTS_TABLE_NAME');

  if (!(await claim(tableName, event))) {
    console.log(
      JSON.stringify({ message: 'Skipped duplicate person-created event', eventId: event.eventId }),
    );
    return;
  }

  try {
    welcome(event);
  } catch (error) {
    // Release the claim so the retry can welcome the person instead of skipping them.
    await client.send(new DeleteCommand({ TableName: tableName, Key: { eventId: event.eventId } }));
    throw error;
  }
}

// Records the eventId; false if it was already there (a duplicate delivery).
async function claim(tableName: string, event: PersonCreatedEvent): Promise<boolean> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          eventId: event.eventId,
          personId: event.data.id,
          expiresAt: Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(eventId)',
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
}

/**
 * The welcome itself. A demo: it logs instead of, say, sending an SMS. Only ids are logged;
 * a real implementation would use data.firstName and data.phoneNumber here.
 */
function welcome(event: PersonCreatedEvent): void {
  console.log(
    JSON.stringify({ message: 'Welcomed person', personId: event.data.id, eventId: event.eventId }),
  );
}
