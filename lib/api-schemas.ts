import { JsonSchemaType, type JsonSchema } from 'aws-cdk-lib/aws-apigateway';
import { MAX_FIELD_LENGTH, PERSON_INPUT_FIELDS } from '../src/person';

type PersonInputField = (typeof PERSON_INPUT_FIELDS)[number];

const FIELD_DESCRIPTIONS: Record<PersonInputField, string | undefined> = {
  firstName: undefined,
  lastName: undefined,
  phoneNumber:
    'Any common format. Numbers without a country code are read as Dutch, so `06 12345678` ' +
    'becomes `+31612345678`. Invalid numbers are rejected.',
  address: 'Free text',
};

/**
 * The create-person request body, as JSON Schema. The single source for API Gateway's request
 * model and the OpenAPI document, so neither can drift from the other.
 *
 * Only the shape: trimming, phone-number parsing and the duplicate check stay in the Lambda
 * (src/person.ts), which remains the source of truth. Stay within what both JSON Schema draft 4
 * (API Gateway) and OpenAPI 3.0 accept: no `$schema`, `$ref` or `id` here.
 */
export const personInputSchema: JsonSchema = {
  type: JsonSchemaType.OBJECT,
  description:
    `All fields are required, must contain a non-space character and may be at most ` +
    `${MAX_FIELD_LENGTH} characters. Values are trimmed. Other fields are rejected.`,
  required: [...PERSON_INPUT_FIELDS],
  additionalProperties: false,
  properties: Object.fromEntries(
    PERSON_INPUT_FIELDS.map((field) => [
      field,
      {
        type: JsonSchemaType.STRING,
        minLength: 1,
        maxLength: MAX_FIELD_LENGTH,
        // Rejects whitespace-only values, which minLength alone would let through.
        pattern: '\\S',
        ...(FIELD_DESCRIPTIONS[field] && { description: FIELD_DESCRIPTIONS[field] }),
      },
    ]),
  ),
};
