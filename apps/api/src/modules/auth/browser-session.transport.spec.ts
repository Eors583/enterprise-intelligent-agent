import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthSessionResponse } from '@enterprise/contracts';
import type { Request, Response } from 'express';

import type { EnvironmentVariables } from '../../config/environment.js';
import {
  BROWSER_ACCESS_COOKIE,
  BROWSER_CSRF_COOKIE,
  BROWSER_REFRESH_COOKIE,
  BrowserSessionTransport,
  readBrowserAccessToken,
} from './browser-session.transport.js';

const SESSION: AuthSessionResponse = {
  accessToken: `ea_access_${'a'.repeat(43)}`,
  refreshToken: `ea_refresh_${'b'.repeat(43)}`,
  account: {
    sessionId: '00000000-0000-7000-8000-000000000010',
    tenantId: '00000000-0000-7000-8000-000000000001',
    tenantSlug: 'browser-test',
    tenantName: 'Browser test',
    userId: '00000000-0000-7000-8000-000000000101',
    email: 'owner@example.test',
    displayName: 'Owner',
    role: 'OWNER',
    passwordChangeRequired: false,
    accessExpiresAt: '2030-01-01T00:15:00.000Z',
    refreshExpiresAt: '2030-01-31T00:00:00.000Z',
  },
};

describe('BrowserSessionTransport', () => {
  it('keeps bearer credentials out of the browser JSON projection', () => {
    const { transport, response, cookie } = fixture('production');

    const result = transport.issue(response, SESSION);

    expect(result).toEqual({ account: SESSION.account });
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
    expect(cookie).toHaveBeenCalledWith(
      BROWSER_ACCESS_COOKIE,
      SESSION.accessToken,
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict' }),
    );
    expect(cookie).toHaveBeenCalledWith(
      BROWSER_REFRESH_COOKIE,
      SESSION.refreshToken,
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict' }),
    );
    expect(cookie).toHaveBeenCalledWith(
      BROWSER_CSRF_COOKIE,
      expect.any(String),
      expect.objectContaining({ httpOnly: false, secure: true, sameSite: 'strict' }),
    );
  });

  it('rejects missing, duplicate, or mismatched browser proofs', () => {
    const { transport } = fixture('development');

    expect(() => transport.requireRefreshToken(request(''))).toThrow(UnauthorizedException);
    expect(() =>
      transport.requireRefreshToken(
        request(`${BROWSER_REFRESH_COOKIE}=one; ${BROWSER_REFRESH_COOKIE}=two`),
      ),
    ).toThrow(UnauthorizedException);
    expect(() =>
      transport.requireCsrf(request(`${BROWSER_CSRF_COOKIE}=expected`, 'wrong')),
    ).toThrow(ForbiddenException);
    expect(() =>
      transport.requireCsrf(request(`${BROWSER_CSRF_COOKIE}=expected`, 'expected')),
    ).not.toThrow();
  });

  it('reads exactly one browser access cookie', () => {
    expect(readBrowserAccessToken(request(`${BROWSER_ACCESS_COOKIE}=${SESSION.accessToken}`))).toBe(
      SESSION.accessToken,
    );
    expect(
      readBrowserAccessToken(
        request(`${BROWSER_ACCESS_COOKIE}=${SESSION.accessToken}; ${BROWSER_ACCESS_COOKIE}=shadow`),
      ),
    ).toBeNull();
  });
});

function fixture(environment: 'development' | 'production') {
  const cookie = vi.fn();
  const response = {
    cookie,
    clearCookie: vi.fn(),
    setHeader: vi.fn(),
  } as unknown as Response;
  const config = {
    get: (key: keyof EnvironmentVariables) => (key === 'NODE_ENV' ? environment : undefined),
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return {
    transport: new BrowserSessionTransport(config),
    response,
    cookie,
  };
}

function request(cookie: string, csrf?: string): Request {
  return {
    headers: { ...(cookie === '' ? {} : { cookie }) },
    header: (name: string) => (name === 'x-csrf-token' ? csrf : undefined),
  } as Request;
}
