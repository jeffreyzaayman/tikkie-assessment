import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';
import type { Person } from './person';

export const PERSON_CREATED = 'PersonCreated';

/**
 * The person-created event: a public contract other services depend on.
 * Additive changes keep `version`; anything breaking needs a new version.
 */
export interface PersonCreatedEvent {
  readonly eventType: typeof PERSON_CREATED;
  readonly version: 1;
  // Unique per event and stable across redeliveries, so consumers can deduplicate on it.
  readonly eventId: string;
  // When the person was created (ISO 8601).
  readonly occurredAt: string;
  readonly data: Person;
}

/**
 * Builds the person-created event from a DynamoDB Stream INSERT record of the persons table.
 * Throws on anything else, so the Pipe retries and finally dead-letters the record.
 */
export function toPersonCreatedEvent(record: DynamoDBRecord): PersonCreatedEvent {
  const newImage = record.dynamodb?.NewImage;
  if (record.eventName !== 'INSERT' || !record.eventID || !newImage) {
    throw new Error(`Not a person INSERT record (eventID ${record.eventID ?? 'unknown'})`);
  }

  const item = unmarshall(newImage as Record<string, AttributeValue>);
  // Pick the fields explicitly: attributes added to the table later must not leak into the event.
  const data: Person = {
    id: requireString(item, 'id'),
    firstName: requireString(item, 'firstName'),
    lastName: requireString(item, 'lastName'),
    phoneNumber: requireString(item, 'phoneNumber'),
    address: requireString(item, 'address'),
    createdAt: requireString(item, 'createdAt'),
  };

  return {
    eventType: PERSON_CREATED,
    version: 1,
    // The stream's eventID is unique per change and the same on every retry of that record.
    eventId: record.eventID,
    occurredAt: data.createdAt,
    data,
  };
}

function requireString(item: Record<string, unknown>, field: keyof Person): string {
  const value = item[field];
  if (typeof value !== 'string') {
    // Name the field only: the values are personal data.
    throw new Error(`Person record is missing string field ${field}`);
  }
  return value;
}
