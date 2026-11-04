import type { DynamoDBRecord } from 'aws-lambda';
import { toPersonCreatedEvent, type PersonCreatedEvent } from '../events';

/**
 * EventBridge Pipe enrichment: turns a batch of persons-table stream records (already filtered
 * to INSERTs by the Pipe) into person-created events. The Pipe publishes each returned event to
 * SNS. Throwing fails the batch, which the Pipe retries, bisects and finally dead-letters.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async turns a bad record into a rejection
export async function handler(records: DynamoDBRecord[]): Promise<PersonCreatedEvent[]> {
  return records.map(toPersonCreatedEvent);
}
