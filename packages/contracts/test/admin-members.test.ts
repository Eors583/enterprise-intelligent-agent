import { describe, expect, it } from 'vitest';

import { updateMemberRequestSchema } from '../src/admin.js';

describe('admin member update contract', () => {
  it('normalizes a login email maintained by the local identity system', () => {
    expect(
      updateMemberRequestSchema.parse({
        email: '  Employee.Login@Example.COM  ',
      }),
    ).toEqual({ email: 'employee.login@example.com' });
  });

  it('rejects an invalid login email', () => {
    expect(updateMemberRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});
