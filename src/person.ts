import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface PersonInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly phoneNumber: string;
  readonly address: string;
}

export interface Person extends PersonInput {
  readonly id: string;
  readonly createdAt: string;
}

export type ParseResult =
  | { readonly ok: true; readonly value: PersonInput }
  | { readonly ok: false; readonly errors: readonly string[] };

export const PERSON_INPUT_FIELDS = ['firstName', 'lastName', 'phoneNumber', 'address'] as const;
export const MAX_FIELD_LENGTH = 200;

// Numbers without a country code (e.g. "06 12345678") are read as Dutch.
const DEFAULT_PHONE_REGION = 'NL';

/**
 * Validates a create-person request body and trims every field.
 * The phone number is normalised to E.164 (e.g. "+31612345678") so that
 * differently formatted versions of the same number are detected as duplicates.
 */
export function parsePersonInput(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: ['Request body must be a JSON object'] };
  }

  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  const unknownFields = Object.keys(record).filter(
    (key) => !(PERSON_INPUT_FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    errors.push(`Unknown field(s): ${unknownFields.join(', ')}`);
  }

  const value: Record<string, string> = {};
  for (const field of PERSON_INPUT_FIELDS) {
    const raw = record[field];
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`${field} is required and must be a non-empty string`);
    } else if (raw.trim().length > MAX_FIELD_LENGTH) {
      errors.push(`${field} must be at most ${MAX_FIELD_LENGTH} characters`);
    } else if (field === 'phoneNumber') {
      const normalised = toE164(raw.trim());
      if (normalised === undefined) {
        // Never echo the submitted value: it is personal data.
        errors.push('phoneNumber must be a valid phone number');
      } else {
        value[field] = normalised;
      }
    } else {
      value[field] = raw.trim();
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as PersonInput };
}

/*
 * Returns the number in E.164 format, or undefined if it is not a valid number.
 * parsePhoneNumberFromString returns undefined instead of throwing on bad input.
 */
function toE164(raw: string): string | undefined {
  const parsed = parsePhoneNumberFromString(raw, DEFAULT_PHONE_REGION);
  return parsed?.isValid() ? parsed.number : undefined;
}

// Ids are created with crypto.randomUUID() (v4).
const PERSON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// True if the value has the shape of a person id (a v4 UUID, any case).
export function isPersonId(value: unknown): value is string {
  return typeof value === 'string' && PERSON_ID_PATTERN.test(value);
}
