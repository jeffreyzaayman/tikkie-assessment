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

const FIELDS = ['firstName', 'lastName', 'phoneNumber', 'address'] as const;
const MAX_LENGTH = 200;

/**
 * Validates a create-person request body. Basic shape checks only for now;
 * phone-number normalisation (E.164) is added with the full validation step.
 */
export function parsePersonInput(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: ['Request body must be a JSON object'] };
  }

  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  const unknownFields = Object.keys(record).filter(
    (key) => !(FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    errors.push(`Unknown field(s): ${unknownFields.join(', ')}`);
  }

  const value: Record<string, string> = {};
  for (const field of FIELDS) {
    const raw = record[field];
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`${field} is required and must be a non-empty string`);
    } else if (raw.trim().length > MAX_LENGTH) {
      errors.push(`${field} must be at most ${MAX_LENGTH} characters`);
    } else {
      value[field] = raw.trim();
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as PersonInput };
}

// Ids are created with crypto.randomUUID() (v4).
const PERSON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True if the value has the shape of a person id (a v4 UUID, any case). */
export function isPersonId(value: unknown): value is string {
  return typeof value === 'string' && PERSON_ID_PATTERN.test(value);
}
