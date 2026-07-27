import { describe, expect, it } from 'vitest';

import {
  resetMemberPasswordRequestSchema,
  resetMemberPasswordResponseSchema,
} from '../src/index.js';

const MEMBER_ID = '00000000-0000-7000-8000-000000000101';

describe('member password reset contracts', () => {
  it('accepts a bounded temporary password without normalizing the secret', () => {
    const temporaryPassword = '  Temporary Password 2026  ';

    expect(resetMemberPasswordRequestSchema.parse({ temporaryPassword })).toEqual({
      temporaryPassword,
    });
  });

  it('rejects temporary passwords outside the supported length', () => {
    expect(
      resetMemberPasswordRequestSchema.safeParse({ temporaryPassword: 'too-short' }).success,
    ).toBe(false);
    expect(
      resetMemberPasswordRequestSchema.safeParse({ temporaryPassword: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('returns only reset state and never requires the temporary password in the response', () => {
    const result = resetMemberPasswordResponseSchema.parse({
      memberId: MEMBER_ID,
      passwordChangeRequired: true,
      revokedSessionCount: 3,
    });

    expect(result).toEqual({
      memberId: MEMBER_ID,
      passwordChangeRequired: true,
      revokedSessionCount: 3,
    });
    expect(result).not.toHaveProperty('temporaryPassword');
  });
});
