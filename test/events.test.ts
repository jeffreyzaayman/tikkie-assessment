import { marshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue, DynamoDBRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { toPersonCreatedEvent } from '../src/events';
import { handler } from '../src/handlers/enrich-person-created';

const person = {
  id: '1249302d-9c20-4a1f-8cf5-afdd0173f2a9',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: '+31612345678',
  address: 'Dam 1, 1012 JS Amsterdam',
  createdAt: '2026-11-04T14:12:09.077Z',
};

/** A persons-table stream record as the Pipe passes it to the enrichment Lambda. */
function streamRecord(overrides: Partial<DynamoDBRecord> = {}, item: object = person) {
  return {
    eventID: 'c4ca4238a0b923820dcc509a6f75849b',
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    dynamodb: {
      Keys: { id: { S: person.id } },
      NewImage: marshall(item) as Record<string, AttributeValue>,
      StreamViewType: 'NEW_IMAGE',
    },
    ...overrides,
  } as DynamoDBRecord;
}

describe('toPersonCreatedEvent', () => {
  it('builds a versioned event from an INSERT record', () => {
    expect(toPersonCreatedEvent(streamRecord())).toEqual({
      eventType: 'PersonCreated',
      version: 1,
      eventId: 'c4ca4238a0b923820dcc509a6f75849b',
      occurredAt: person.createdAt,
      data: person,
    });
  });

  it('leaves out attributes that are not part of the contract', () => {
    const event = toPersonCreatedEvent(streamRecord({}, { ...person, internalNote: 'secret' }));

    expect(event.data).toEqual(person);
  });

  it.each([
    ['a MODIFY record', { eventName: 'MODIFY' as const }],
    ['a record without an eventID', { eventID: undefined }],
    ['a record without a new image', { dynamodb: { Keys: { id: { S: person.id } } } }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => toPersonCreatedEvent(streamRecord(overrides))).toThrow(
      /Not a person INSERT record/,
    );
  });

  it('rejects a person with a missing field, naming the field but not the values', () => {
    const withoutAddress: Partial<typeof person> = { ...person };
    delete withoutAddress.address;

    expect(() => toPersonCreatedEvent(streamRecord({}, withoutAddress))).toThrow(
      'Person record is missing string field address',
    );
  });
});

describe('enrich-person-created handler', () => {
  it('returns one event per record, in order', async () => {
    const second = { ...person, id: '7d0f7a7e-3f4b-4c9a-9b1e-2a6c5d8e9f01' };

    const events = await handler([
      streamRecord(),
      streamRecord({ eventID: 'second-event' }, second),
    ]);

    expect(events.map((e) => [e.eventId, e.data.id])).toEqual([
      ['c4ca4238a0b923820dcc509a6f75849b', person.id],
      ['second-event', second.id],
    ]);
  });

  it('fails the whole batch on a bad record, so the Pipe retries and bisects it', async () => {
    await expect(handler([streamRecord(), streamRecord({ eventName: 'REMOVE' })])).rejects.toThrow(
      /Not a person INSERT record/,
    );
  });
});
