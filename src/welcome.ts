import type { PersonCreatedEvent } from './events';

/*
 * The Welcome Service's view of the person-created contract. It validates what it receives
 * instead of trusting the producer, so a breaking change fails loudly (retries, then the DLQ)
 * rather than being half-processed. If this service moves to its own repo, copy the type (or
 * generate it from the event's JSON Schema) instead of importing it.
 */

// Parses and checks an SQS message body (raw SNS delivery) as a PersonCreated v1 event.
export function parsePersonCreatedEvent(body: string): PersonCreatedEvent {
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    throw new Error('Message body is not JSON');
  }

  if (!isRecord(event) || event.eventType !== 'PersonCreated') {
    throw new Error('Message is not a PersonCreated event');
  }
  if (event.version !== 1) {
    throw new Error(`Unsupported PersonCreated version: ${JSON.stringify(event.version)}`);
  }
  if (typeof event.eventId !== 'string' || event.eventId === '') {
    throw new Error('PersonCreated event has no eventId');
  }
  if (!isRecord(event.data) || typeof event.data.id !== 'string') {
    throw new Error('PersonCreated event has no person id');
  }
  return event as unknown as PersonCreatedEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
