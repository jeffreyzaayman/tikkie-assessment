import { Document } from 'yaml';
import { MAX_FIELD_LENGTH } from '../src/person';
import { personInputSchema } from './api-schemas';
import { API_THROTTLING } from './person-api';
import { STAGES } from './stage';

/*
 * The OpenAPI document of the Person Service API, written to api/openapi.yaml by
 * `npm run openapi`. A test fails when the committed file is out of date.
 */

const PERSON_ID_EXAMPLE = '1249302d-9c20-4a1f-8cf5-afdd0173f2a9';
const THROTTLING = `${API_THROTTLING.rateLimit} requests per second per stage, bursts up to ${API_THROTTLING.burstLimit}`;

const errorResponse = (description: string, examples: Record<string, unknown>) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      examples: Object.fromEntries(
        Object.entries(examples).map(([name, message]) => [name, { value: { message } }]),
      ),
    },
  },
});

const commonResponses = {
  '403': { $ref: '#/components/responses/Forbidden' },
  '429': { $ref: '#/components/responses/TooManyRequests' },
  '500': { $ref: '#/components/responses/InternalServerError' },
};

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Person Service API',
      version: '1.0.0',
      description: [
        'Stores persons and lists them. Every new person also fires a `PersonCreated` event on',
        'the person-created SNS topic (see the README).',
        '',
        '**Authentication:** every method requires AWS Signature Version 4 (IAM). The caller',
        'needs `execute-api:Invoke` on the API. Unsigned requests get `403`. Use awscurl,',
        'Postman\'s "AWS Signature" auth or an AWS SDK; the "Try it out" button in Swagger UI',
        "can't sign requests.",
        '',
        `**Throttling:** ${THROTTLING}. Above that the API returns \`429\`.`,
        '',
        '**Personal data:** requests and responses contain names, phone numbers and addresses.',
        'Error messages never echo submitted values.',
        '',
      ].join('\n'),
    },
    servers: [
      {
        url: 'https://{apiId}.execute-api.eu-west-1.amazonaws.com/{stage}',
        description: 'The `ApiUrl` output of the `PersonService-<stage>` stack',
        variables: {
          apiId: { default: 'abc123defg', description: 'The REST API id' },
          stage: { default: STAGES[0], enum: [...STAGES] },
        },
      },
    ],
    security: [{ sigv4: [] }],
    tags: [{ name: 'Persons', description: 'Create, get and list persons' }],
    paths: {
      '/person': {
        post: {
          tags: ['Persons'],
          operationId: 'createPerson',
          summary: 'Create a person',
          description: [
            'Validates and trims every field, normalises the phone number to E.164 and stores',
            'the person. Phone numbers are unique: a second person with the same number (in any',
            'format) is rejected with `409`. On success a `PersonCreated` event is published',
            'asynchronously.',
            '',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PersonInput' },
                examples: {
                  dutchMobile: {
                    summary: 'Dutch number without country code',
                    value: {
                      firstName: 'Ada',
                      lastName: 'Lovelace',
                      phoneNumber: '06 12345678',
                      address: 'Dam 1, 1012 JS Amsterdam',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Person created',
              headers: {
                Location: {
                  description: 'Path of the new person',
                  schema: { type: 'string', example: `/person/${PERSON_ID_EXAMPLE}` },
                },
              },
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Person' } },
              },
            },
            '400': {
              description: [
                'The body is not valid JSON or fails validation. API Gateway checks the shape',
                'against `PersonInput` first (`Invalid request body`); the Lambda then checks',
                'the rest, such as the phone number (`Validation failed`).',
                '',
              ].join('\n'),
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidationError' },
                  examples: {
                    shape: {
                      summary: 'Rejected by API Gateway',
                      value: {
                        message: 'Invalid request body',
                        errors: ['[object has missing required properties (["address"])]'],
                      },
                    },
                    validation: {
                      summary: 'Rejected by the Lambda',
                      value: {
                        message: 'Validation failed',
                        errors: ['phoneNumber must be a valid phone number'],
                      },
                    },
                  },
                },
              },
            },
            '409': errorResponse('A person with this phone number already exists', {
              duplicate: 'A person with this phone number already exists',
            }),
            ...commonResponses,
          },
        },
        get: {
          tags: ['Persons'],
          operationId: 'listPersons',
          summary: 'List persons, one page at a time',
          description: [
            'Returns persons in no particular order. To read everything, pass `nextCursor` back',
            'as `cursor` until a response has no `nextCursor`. A page can be empty while',
            '`nextCursor` is still present. Reads are eventually consistent: a person created a',
            'moment ago may not be listed yet.',
            '',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum number of persons on the page',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'cursor',
              in: 'query',
              description:
                "The `nextCursor` of the previous page. Opaque; don't build it yourself.",
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'One page of persons',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/PersonPage' } },
              },
            },
            '400': errorResponse('`limit` or `cursor` is invalid', {
              limit: 'limit must be an integer from 1 to 100',
              cursor: 'cursor is invalid',
            }),
            ...commonResponses,
          },
        },
      },
      '/person/{id}': {
        get: {
          tags: ['Persons'],
          operationId: 'getPerson',
          summary: 'Get a person by id',
          description: [
            'Strongly consistent, so following the `Location` header of a `201` always finds',
            'the person. The id is matched case-insensitively.',
            '',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/PersonId' },
            },
          ],
          responses: {
            '200': {
              description: 'The person',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Person' } },
              },
            },
            '400': errorResponse('The id is not a UUID', { invalidId: 'Person id must be a UUID' }),
            '404': errorResponse('No person with this id', { notFound: 'Person not found' }),
            ...commonResponses,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sigv4: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
          description: 'AWS Signature Version 4, signed for service `execute-api` in `eu-west-1`.',
          'x-amazon-apigateway-authtype': 'awsSigv4',
        },
      },
      schemas: {
        PersonId: {
          type: 'string',
          format: 'uuid',
          description: 'A version 4 UUID, created by the service',
          example: PERSON_ID_EXAMPLE,
        },
        PersonInput: personInputSchema,
        Person: {
          type: 'object',
          required: ['id', 'firstName', 'lastName', 'phoneNumber', 'address', 'createdAt'],
          properties: {
            id: { $ref: '#/components/schemas/PersonId' },
            firstName: { type: 'string', maxLength: MAX_FIELD_LENGTH, example: 'Ada' },
            lastName: { type: 'string', maxLength: MAX_FIELD_LENGTH, example: 'Lovelace' },
            phoneNumber: {
              type: 'string',
              description: 'E.164 format',
              pattern: '^\\+[1-9]\\d{1,14}$',
              example: '+31612345678',
            },
            address: {
              type: 'string',
              maxLength: MAX_FIELD_LENGTH,
              example: 'Dam 1, 1012 JS Amsterdam',
            },
            createdAt: { type: 'string', format: 'date-time', example: '2026-11-04T14:12:09.077Z' },
          },
        },
        PersonPage: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Person' } },
            nextCursor: {
              type: 'string',
              description: 'Pass as `cursor` to get the next page. Absent on the last page.',
              example: Buffer.from(JSON.stringify({ id: PERSON_ID_EXAMPLE })).toString('base64url'),
            },
          },
        },
        Error: {
          type: 'object',
          required: ['message'],
          properties: { message: { type: 'string' } },
        },
        ValidationError: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string' },
            errors: {
              type: 'array',
              description: 'One entry per problem. Present when validation failed.',
              items: { type: 'string' },
            },
          },
        },
      },
      responses: {
        Forbidden: errorResponse(
          'Missing or invalid AWS signature, or the caller may not invoke the API',
          { missingSignature: 'Missing Authentication Token' },
        ),
        TooManyRequests: errorResponse(`Throttled by API Gateway (${THROTTLING})`, {
          throttled: 'Too Many Requests',
        }),
        InternalServerError: errorResponse(
          'Unexpected error. It is logged without personal data.',
          {
            internal: 'Internal server error',
          },
        ),
      },
    },
  };
}

// The document as the YAML text committed in api/openapi.yaml.
export function renderOpenApiYaml(): string {
  const document = new Document(openApiDocument());
  document.commentBefore = ' Generated from lib/openapi.ts by `npm run openapi`. Do not edit.';
  return document.toString({ lineWidth: 0 });
}
