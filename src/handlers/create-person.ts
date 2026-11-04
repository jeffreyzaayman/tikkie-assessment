import { randomUUID } from 'node:crypto';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { parsePersonInput, type Person } from '../person';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PHONE_ITEM_INDEX = 1;

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const body = parseJson(event);
  if (body === INVALID_JSON) {
    return json(400, { message: 'Request body must be valid JSON' });
  }

  const parsed = parsePersonInput(body);
  if (!parsed.ok) {
    return json(400, { message: 'Validation failed', errors: parsed.errors });
  }

  const person: Person = {
    id: randomUUID(),
    ...parsed.value,
    createdAt: new Date().toISOString(),
  };

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: requireEnv('PERSONS_TABLE_NAME'),
              Item: person,
              ConditionExpression: 'attribute_not_exists(id)',
            },
          },
          {
            Put: {
              TableName: requireEnv('PHONE_NUMBERS_TABLE_NAME'),
              Item: { phoneNumber: person.phoneNumber, personId: person.id },
              ConditionExpression: 'attribute_not_exists(phoneNumber)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isDuplicatePhoneNumber(error)) {
      return json(409, { message: 'A person with this phone number already exists' });
    }
    // Log only non-PII metadata: never the request body or person fields.
    console.error(
      JSON.stringify({
        message: 'Failed to create person',
        errorName: error instanceof Error ? error.name : 'Unknown',
        awsRequestId: context.awsRequestId,
      }),
    );
    return json(500, { message: 'Internal server error' });
  }

  return json(201, person, { Location: `/person/${person.id}` });
}

const INVALID_JSON = Symbol('invalid-json');

function parseJson(event: APIGatewayProxyEvent): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

function isDuplicatePhoneNumber(error: unknown): boolean {
  return (
    error instanceof TransactionCanceledException &&
    error.CancellationReasons?.[PHONE_ITEM_INDEX]?.Code === 'ConditionalCheckFailed'
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
