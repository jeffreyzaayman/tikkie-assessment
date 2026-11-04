import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { json, requireEnv } from '../http';
import { isPersonId, type Person } from '../person';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  // Reject anything that can't be a person id before touching DynamoDB.
  if (!isPersonId(id)) {
    return json(400, { message: 'Person id must be a UUID' });
  }

  try {
    const { Item } = await client.send(
      new GetCommand({
        TableName: requireEnv('PERSONS_TABLE_NAME'),
        Key: { id: id.toLowerCase() },
        // Strongly consistent, so a GET right after POST (following Location) always finds the person.
        ConsistentRead: true,
      }),
    );
    if (!Item) {
      return json(404, { message: 'Person not found' });
    }
    return json(200, Item as Person);
  } catch (error) {
    // Log only non-PII metadata: never the person fields.
    console.error(
      JSON.stringify({
        message: 'Failed to get person',
        errorName: error instanceof Error ? error.name : 'Unknown',
        awsRequestId: context.awsRequestId,
      }),
    );
    return json(500, { message: 'Internal server error' });
  }
}
