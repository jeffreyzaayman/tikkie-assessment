import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/list-persons';

const ddb = mockClient(DynamoDBDocumentClient);
const context = { awsRequestId: 'request-123' } as Context;

const lastId = '1249302d-9c20-4a1f-8cf5-afdd0173f2a9';
const persons = [
  {
    id: '7d0f7a7e-3f4b-4c9a-9b1e-2a6c5d8e9f01',
    firstName: 'Grace',
    lastName: 'Hopper',
    phoneNumber: '+31687654321',
    address: 'Coolsingel 2, Rotterdam',
    createdAt: '2026-11-04T14:00:00.000Z',
  },
  {
    id: lastId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    phoneNumber: '+31612345678',
    address: 'Dam 1, 1012 JS Amsterdam',
    createdAt: '2026-11-04T14:12:09.077Z',
  },
];

const cursorFor = (key: unknown) => Buffer.from(JSON.stringify(key)).toString('base64url');

function event(query: Record<string, string> | null = null): APIGatewayProxyEvent {
  return { queryStringParameters: query } as APIGatewayProxyEvent;
}

function scanInput() {
  return ddb.commandCalls(ScanCommand)[0]?.args[0].input;
}

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('PERSONS_TABLE_NAME', 'persons-table');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('list-persons handler', () => {
  it('returns the first page with a cursor for the next one, 20 per page by default', async () => {
    ddb.on(ScanCommand).resolves({ Items: persons, LastEvaluatedKey: { id: lastId } });

    const response = await handler(event(), context);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(response.body)).toEqual({
      items: persons,
      nextCursor: cursorFor({ id: lastId }),
    });
    expect(scanInput()).toEqual({ TableName: 'persons-table', Limit: 20 });
  });

  it('continues from the cursor with the requested limit', async () => {
    ddb.on(ScanCommand).resolves({ Items: [] });

    await handler(event({ limit: '5', cursor: cursorFor({ id: lastId }) }), context);

    expect(scanInput()).toEqual({
      TableName: 'persons-table',
      Limit: 5,
      ExclusiveStartKey: { id: lastId },
    });
  });

  it('round-trips its own cursor', async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: persons, LastEvaluatedKey: { id: lastId } })
      .resolves({ Items: [] });

    const first = JSON.parse((await handler(event(), context)).body) as { nextCursor: string };
    await handler(event({ cursor: first.nextCursor }), context);

    expect(ddb.commandCalls(ScanCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
      id: lastId,
    });
  });

  it('omits nextCursor on the last page', async () => {
    ddb.on(ScanCommand).resolves({ Items: persons });

    const response = await handler(event(), context);

    expect(JSON.parse(response.body)).toEqual({ items: persons });
  });

  it('returns an empty page when there are no persons', async () => {
    ddb.on(ScanCommand).resolves({});

    const response = await handler(event(), context);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
  });

  it.each(['0', '101', '-1', '2.5', 'abc', ''])(
    'returns 400 without calling DynamoDB for limit=%j',
    async (limit) => {
      const response = await handler(event({ limit }), context);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        message: 'limit must be an integer from 1 to 100',
      });
      expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
    },
  );

  it.each([
    ['not base64url JSON', 'not-a-cursor!'],
    ['not an object', cursorFor('abc')],
    ['an id that is not a UUID', cursorFor({ id: 'abc' })],
    ['extra keys', cursorFor({ id: lastId, phoneNumber: '+31612345678' })],
    ['a different key', cursorFor({ phoneNumber: '+31612345678' })],
  ])('returns 400 without calling DynamoDB for a cursor with %s', async (_label, cursor) => {
    const response = await handler(event({ cursor }), context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ message: 'cursor is invalid' });
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('returns 500 for DynamoDB failures and logs no personal data', async () => {
    ddb.on(ScanCommand).rejects(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handler(event(), context);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ message: 'Internal server error' });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      message: 'Failed to list persons',
      errorName: 'InternalServerError',
      awsRequestId: 'request-123',
    });
  });
});
