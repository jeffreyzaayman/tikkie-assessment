import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/handlers/get-person';

const ddb = mockClient(DynamoDBDocumentClient);
const context = { awsRequestId: 'request-123' } as Context;

const id = '1249302d-9c20-4a1f-8cf5-afdd0173f2a9';
const person = {
  id,
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: '+31612345678',
  address: 'Dam 1, 1012 JS Amsterdam',
  createdAt: '2026-11-04T14:12:09.077Z',
};

function event(pathId: string | undefined): APIGatewayProxyEvent {
  return { pathParameters: pathId === undefined ? null : { id: pathId } } as APIGatewayProxyEvent;
}

beforeEach(() => {
  ddb.reset();
  vi.stubEnv('PERSONS_TABLE_NAME', 'persons-table');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('get-person handler', () => {
  it('returns 200 with the person, read with strong consistency', async () => {
    ddb.on(GetCommand).resolves({ Item: person });

    const response = await handler(event(id), context);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(response.body)).toEqual(person);
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: 'persons-table',
      Key: { id },
      ConsistentRead: true,
    });
  });

  it('accepts an upper-case id and looks it up in lower case', async () => {
    ddb.on(GetCommand).resolves({ Item: person });

    const response = await handler(event(id.toUpperCase()), context);

    expect(response.statusCode).toBe(200);
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({ id });
  });

  it('returns 404 when the person does not exist', async () => {
    ddb.on(GetCommand).resolves({});

    const response = await handler(event(id), context);

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ message: 'Person not found' });
  });

  it.each([
    ['not a UUID', 'abc'],
    ['missing', undefined],
    ['not a v4 UUID', '1249302d-9c20-1a1f-8cf5-afdd0173f2a9'],
  ])('returns 400 without calling DynamoDB when the id is %s', async (_label, pathId) => {
    const response = await handler(event(pathId), context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ message: 'Person id must be a UUID' });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 500 for DynamoDB failures and logs no personal data', async () => {
    ddb.on(GetCommand).rejects(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handler(event(id), context);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ message: 'Internal server error' });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      message: 'Failed to get person',
      errorName: 'InternalServerError',
      awsRequestId: 'request-123',
    });
  });
});
