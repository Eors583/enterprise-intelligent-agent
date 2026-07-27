import { describe, expect, it } from 'vitest';

import { parseStoredSession } from './session';

const STORED_SESSION = {
  accessToken: 'a'.repeat(32),
  refreshToken: 'r'.repeat(32),
  account: {
    sessionId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
    tenantId: 'b39eb6b8-d537-4e83-b096-25375c4c6f51',
    tenantSlug: 'future-work',
    tenantName: '未来协作',
    userId: '83ceae87-554e-451d-b411-c336f1d02bf9',
    email: 'admin@example.com',
    displayName: '管理员',
    role: 'ADMIN',
    accessExpiresAt: '2026-07-16T09:00:00.000Z',
    refreshExpiresAt: '2026-07-23T08:00:00.000Z',
  },
} as const;

describe('stored admin session migration', () => {
  it('adds a safe default for sessions stored before password change enforcement', () => {
    const parsed = parseStoredSession(JSON.stringify(STORED_SESSION));

    expect(parsed?.account.passwordChangeRequired).toBe(false);
    expect(parsed?.accessToken).toBe(STORED_SESSION.accessToken);
    expect(parsed?.refreshToken).toBe(STORED_SESSION.refreshToken);
  });

  it('preserves an explicit password change requirement', () => {
    const parsed = parseStoredSession(
      JSON.stringify({
        ...STORED_SESSION,
        account: { ...STORED_SESSION.account, passwordChangeRequired: true },
      }),
    );

    expect(parsed?.account.passwordChangeRequired).toBe(true);
  });

  it('still rejects invalid or malformed stored data', () => {
    expect(parseStoredSession('{not-json')).toBeNull();
    expect(
      parseStoredSession(JSON.stringify({ ...STORED_SESSION, accessToken: 'short' })),
    ).toBeNull();
  });
});
