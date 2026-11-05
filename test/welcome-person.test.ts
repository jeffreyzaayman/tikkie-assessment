import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handler } from '../src/handlers/welcome-person';
import { parsePersonCreatedEvent } from '../src/welcome';

const ddb = mockClient(DynamoDBDocumentClient);

const event = {
  eventType: 'PersonCreated',
  version: 1,
  eventId: 'c45a3349b2a3ec6ece631a21b4a04e0c',
  occurredAt: '2026-11-05T05:08:43.122Z',
  data: {
    id: '58364f8f-d2c0-4c79-8d35-d36305829457',
    firstName: 'Edsger',
    lastName: 'Dijkstra',
    phoneNumber: '+31640021343',
    address: 'Oudegracht 4, Utrecht',
    createdAt: '2026-11-05T05:08:43.122Z',
  },
};

function sqsEvent(...bodies: (string | object)[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, i) =>
        ({
          messageId: `message-${i}`,
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }) as SQSRecord,
    ),
  };
}

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

let log: MockInstance<typeof console.log>;
let errorLog: MockInstance<typeof console.error>;

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('PROCESSED_EVENTS_TABLE_NAME', 'processed-events');
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const logged = (spy: MockInstance<typeof console.log>) =>
  spy.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);

describe('parsePersonCreatedEvent', () => {
  it('accepts a PersonCreated v1 event', () => {
    expect(parsePersonCreatedEvent(JSON.stringify(event))).toEqual(event);
  });

  it.each([
    ['a body that is not JSON', '{not json', 'Message body is not JSON'],
    ['another event type', { ...event, eventType: 'PersonDeleted' }, 'not a PersonCreated event'],
    ['an SNS envelope (raw delivery off)', { Type: 'Notification', Message: '{}' }, 'not a'],
    ['an unknown version', { ...event, version: 2 }, 'Unsupported PersonCreated version: 2'],
    ['a missing eventId', { ...event, eventId: '' }, 'has no eventId'],
    ['a missing person id', { ...event, data: {} }, 'has no person id'],
  ])('rejects %s', (_label, body, message) => {
    expect(() =>
      parsePersonCreatedEvent(typeof body === 'string' ? body : JSON.stringify(body)),
    ).toThrow(message);
  });
});

describe('welcome-person handler', () => {
  it('claims the eventId with a 7-day TTL, then welcomes the person by id only', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T06:00:00.000Z'), toFake: ['Date'] });
    ddb.on(PutCommand).resolves({});

    const response = await handler(sqsEvent(event));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input).toEqual({
      TableName: 'processed-events',
      Item: {
        eventId: event.eventId,
        personId: event.data.id,
        expiresAt: Date.parse('2026-11-05T06:00:00.000Z') / 1000 + 7 * 24 * 60 * 60,
      },
      ConditionExpression: 'attribute_not_exists(eventId)',
    });
    expect(logged(log)).toEqual([
      { message: 'Welcomed person', personId: event.data.id, eventId: event.eventId },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Edsger|Dijkstra|\+316|Oudegracht/);
  });

  it('skips a duplicate delivery without welcoming again', async () => {
    ddb.on(PutCommand).rejects(conditionFailed());

    const response = await handler(sqsEvent(event));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(logged(log)).toEqual([
      { message: 'Skipped duplicate person-created event', eventId: event.eventId },
    ]);
  });

  it('welcomes once when the same event arrives twice in one batch', async () => {
    ddb.on(PutCommand).resolvesOnce({}).rejects(conditionFailed());

    const response = await handler(sqsEvent(event, event));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(logged(log).map((entry) => entry.message)).toEqual([
      'Welcomed person',
      'Skipped duplicate person-created event',
    ]);
  });

  it('reports only the failing message, so the rest of the batch is not retried', async () => {
    ddb.on(PutCommand).resolves({});
    const other = { ...event, eventId: 'other-event' };

    const response = await handler(sqsEvent(event, '{not json', other));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(2);
  });

  it('fails the message when the claim fails for another reason, and logs no personal data', async () => {
    ddb
      .on(PutCommand)
      .rejects(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));

    const response = await handler(sqsEvent(event));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-0' }] });
    expect(logged(log)).toEqual([]);
    expect(logged(errorLog)).toEqual([
      {
        message: 'Failed to process person-created message',
        messageId: 'message-0',
        errorName: 'ThrottlingException',
        errorMessage: 'Rate exceeded',
      },
    ]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/Edsger|Dijkstra|\+316|Oudegracht/);
  });

  it('releases the claim when the welcome fails, so the retry welcomes the person', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    log.mockImplementationOnce(() => {
      throw new Error('welcome failed');
    });

    const response = await handler(sqsEvent(event));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-0' }] });
    expect(ddb.commandCalls(DeleteCommand)[0]?.args[0].input).toEqual({
      TableName: 'processed-events',
      Key: { eventId: event.eventId },
    });
  });
});
