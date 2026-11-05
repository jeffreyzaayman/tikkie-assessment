import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { json, requireEnv } from '../http';
import { isPersonId, type Person } from '../person';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface PersonPage {
  readonly items: readonly Person[];
  // Pass as `cursor` to get the next page; absent on the last page.
  readonly nextCursor?: string;
}

/**
 * Lists persons a page at a time, in no particular order (a Scan; persons is keyed by id only).
 * DynamoDB can return a cursor whose next page is empty; clients stop when nextCursor is absent.
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const query = event.queryStringParameters ?? {};

  const limit = parseLimit(query.limit);
  if (limit === undefined) {
    return json(400, { message: `limit must be an integer from 1 to ${MAX_LIMIT}` });
  }

  const startKey = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (startKey === undefined) {
    return json(400, { message: 'cursor is invalid' });
  }

  try {
    const { Items = [], LastEvaluatedKey } = await client.send(
      new ScanCommand({
        TableName: requireEnv('PERSONS_TABLE_NAME'),
        Limit: limit,
        ...(startKey && { ExclusiveStartKey: startKey }),
        // Eventually consistent: a list doesn't need read-your-write, and it halves the read cost.
      }),
    );
    const page: PersonPage = {
      items: Items as Person[],
      ...(LastEvaluatedKey && { nextCursor: encodeCursor(LastEvaluatedKey) }),
    };
    return json(200, page);
  } catch (error) {
    // Log only non-PII metadata: never the person fields.
    console.error(
      JSON.stringify({
        message: 'Failed to list persons',
        errorName: error instanceof Error ? error.name : 'Unknown',
        awsRequestId: context.awsRequestId,
      }),
    );
    return json(500, { message: 'Internal server error' });
  }
}

// Returns the page size, or undefined if the query value is invalid.
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : undefined;
}

// The cursor is the scan's LastEvaluatedKey ({ id }) as base64url JSON. Opaque to clients.
function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ id: key.id })).toString('base64url');
}

/**
 * Returns the start key, or undefined if the cursor isn't one we issued.
 * Checked strictly so a forged cursor can't send arbitrary keys to DynamoDB.
 */
function decodeCursor(cursor: string): { id: string } | undefined {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof key === 'object' &&
      key !== null &&
      Object.keys(key).length === 1 &&
      isPersonId((key as { id?: unknown }).id)
    ) {
      return { id: (key as { id: string }).id };
    }
  } catch {
    // Not base64url JSON; fall through.
  }
  return undefined;
}
