import { describe, expect, it } from 'vitest';
import { parsePersonInput } from '../src/person';

const valid = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: '+31612345678',
  address: 'Dam 1, 1012 JS Amsterdam',
};

describe('parsePersonInput', () => {
  it('accepts a valid person and trims whitespace', () => {
    const result = parsePersonInput({ ...valid, firstName: '  Ada  ' });
    expect(result).toEqual({ ok: true, value: valid });
  });

  it.each([null, undefined, 'text', 42, []])('rejects a non-object body: %j', (body) => {
    expect(parsePersonInput(body)).toEqual({
      ok: false,
      errors: ['Request body must be a JSON object'],
    });
  });

  it('reports every missing or empty field at once', () => {
    const result = parsePersonInput({ firstName: '   ', phoneNumber: 31612345678 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      'firstName is required and must be a non-empty string',
      'lastName is required and must be a non-empty string',
      'phoneNumber is required and must be a non-empty string',
      'address is required and must be a non-empty string',
    ]);
  });

  it('rejects unknown fields', () => {
    const result = parsePersonInput({ ...valid, id: 'chosen-by-client' });
    expect(result).toEqual({ ok: false, errors: ['Unknown field(s): id'] });
  });

  it('rejects overly long values', () => {
    const result = parsePersonInput({ ...valid, address: 'x'.repeat(201) });
    expect(result).toEqual({ ok: false, errors: ['address must be at most 200 characters'] });
  });
});
