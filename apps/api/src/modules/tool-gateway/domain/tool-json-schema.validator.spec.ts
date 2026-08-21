import { describe, expect, it } from 'vitest';

import { validateToolJsonInput } from './tool-json-schema.validator.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    customerId: { type: 'string', minLength: 3 },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: { includeHistory: { type: 'boolean' } },
      required: ['includeHistory'],
    },
  },
  required: ['customerId'],
} as const;

describe('validateToolJsonInput', () => {
  it('accepts the supported closed JSON-Schema subset', () => {
    expect(
      validateToolJsonInput(SCHEMA, {
        customerId: 'customer-1',
        options: { includeHistory: true },
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it('rejects missing, mistyped, nested, and additional input fields', () => {
    const result = validateToolJsonInput(SCHEMA, {
      options: { includeHistory: 'yes', hidden: true },
      unexpected: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '$.customerId: required property is missing.',
        '$.options.includeHistory: expected boolean.',
        '$.options.hidden: additional property is not allowed.',
        '$.unexpected: additional property is not allowed.',
      ]),
    );
  });
});
