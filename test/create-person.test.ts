import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/create-person';

const ddb = mockClient(DynamoDBDocumentClient);
const context = { awsRequestId: 'request-123' } as Context;

const person = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: '+31612345678',
  address: 'Dam 1, 1012 JS Amsterdam',
};

function event(body: string | null, isBase64Encoded = false): APIGatewayProxyEvent {
  return { body, isBase64Encoded } as APIGatewayProxyEvent;
}

function cancelled(codes: string[]) {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('PERSONS_TABLE_NAME', 'persons-table');
  vi.stubEnv('PHONE_NUMBERS_TABLE_NAME', 'phone-numbers-table');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('create-person handler', () => {
  it('stores the person and phone number in one transaction and returns 201', async () => {
    ddb.on(TransactWriteCommand).resolves({});

    const response = await handler(event(JSON.stringify(person)), context);

    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as Record<string, string>;
    expect(created).toMatchObject(person);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(created.createdAt!).toISOString()).toBe(created.createdAt);
    expect(response.headers).toMatchObject({ Location: `/person/${created.id}` });

    const calls = ddb.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.TransactItems).toEqual([
      {
        Put: {
          TableName: 'persons-table',
          Item: created,
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
      {
        Put: {
          TableName: 'phone-numbers-table',
          Item: { phoneNumber: person.phoneNumber, personId: created.id },
          ConditionExpression: 'attribute_not_exists(phoneNumber)',
        },
      },
    ]);
  });

  it('accepts a base64-encoded body', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const body = Buffer.from(JSON.stringify(person)).toString('base64');

    const response = await handler(event(body, true), context);

    expect(response.statusCode).toBe(201);
  });

  it('returns 400 for malformed JSON without calling DynamoDB', async () => {
    const response = await handler(event('{not json'), context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ message: 'Request body must be valid JSON' });
    expect(ddb.calls()).toHaveLength(0);
  });

  it('returns 400 with validation errors for an invalid person', async () => {
    const response = await handler(event(JSON.stringify({ ...person, lastName: '' })), context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      message: 'Validation failed',
      errors: ['lastName is required and must be a non-empty string'],
    });
    expect(ddb.calls()).toHaveLength(0);
  });

  it('returns 409 when the phone number already exists', async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(['None', 'ConditionalCheckFailed']));

    const response = await handler(event(JSON.stringify(person)), context);

    expect(response.statusCode).toBe(409);
  });

  it('returns 500 for other failures and logs no personal data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ddb.on(TransactWriteCommand).rejects(cancelled(['ConditionalCheckFailed', 'None']));

    const response = await handler(event(JSON.stringify(person)), context);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ message: 'Internal server error' });
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('request-123');
    for (const value of Object.values(person)) {
      expect(logged).not.toContain(value);
    }
  });
});
