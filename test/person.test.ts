import { describe, expect, it } from 'vitest';
import { isPersonId, parsePersonInput } from '../src/person';

describe('isPersonId', () => {
  it.each(['1249302d-9c20-4a1f-8cf5-afdd0173f2a9', '1249302D-9C20-4A1F-8CF5-AFDD0173F2A9'])(
    'accepts the v4 UUID %s',
    (id) => {
      expect(isPersonId(id)).toBe(true);
    },
  );

  it.each([
    ['a non-UUID string', 'abc'],
    ['a v1 UUID', '1249302d-9c20-1a1f-8cf5-afdd0173f2a9'],
    ['a UUID with extra characters', '1249302d-9c20-4a1f-8cf5-afdd0173f2a9x'],
    ['a number', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isPersonId(value)).toBe(false);
  });
});

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
