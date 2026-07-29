import { randomBytes, timingSafeEqual } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BrowserAuthSessionResponse, AuthSessionResponse } from '@enterprise/contracts';
import type { CookieOptions, Request, Response } from 'express';

import type { EnvironmentVariables } from '../../config/environment.js';

export const BROWSER_ACCESS_COOKIE = 'ea_access';
export const BROWSER_REFRESH_COOKIE = 'ea_refresh';
export const BROWSER_CSRF_COOKIE = 'ea_csrf';
export const BROWSER_CSRF_HEADER = 'x-csrf-token';

@Injectable()
export class BrowserSessionTransport {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  issue(response: Response, session: AuthSessionResponse): BrowserAuthSessionResponse {
    const secure = this.config.get('NODE_ENV', { infer: true }) === 'production';
    response.setHeader('Cache-Control', 'no-store');
    response.cookie(BROWSER_ACCESS_COOKIE, session.accessToken, {
      ...baseCookie(secure),
      httpOnly: true,
      path: '/api/v1',
      expires: new Date(session.account.accessExpiresAt),
    });
    response.cookie(BROWSER_REFRESH_COOKIE, session.refreshToken, {
      ...baseCookie(secure),
      httpOnly: true,
      path: '/api/v1/auth/browser',
      expires: new Date(session.account.refreshExpiresAt),
    });
    response.cookie(BROWSER_CSRF_COOKIE, randomBytes(32).toString('base64url'), {
      ...baseCookie(secure),
      httpOnly: false,
      path: '/',
      expires: new Date(session.account.refreshExpiresAt),
    });
    return { account: session.account };
  }

  clear(response: Response): void {
    const secure = this.config.get('NODE_ENV', { infer: true }) === 'production';
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie(BROWSER_ACCESS_COOKIE, {
      ...baseCookie(secure),
      httpOnly: true,
      path: '/api/v1',
    });
    response.clearCookie(BROWSER_REFRESH_COOKIE, {
      ...baseCookie(secure),
      httpOnly: true,
      path: '/api/v1/auth/browser',
    });
    response.clearCookie(BROWSER_CSRF_COOKIE, {
      ...baseCookie(secure),
      httpOnly: false,
      path: '/',
    });
  }

  requireRefreshToken(request: Request): string {
    const value = readRequestCookie(request, BROWSER_REFRESH_COOKIE);
    if (value === null) throw new UnauthorizedException('Browser session refresh required.');
    return value;
  }

  requireCsrf(request: Request): void {
    const cookie = readRequestCookie(request, BROWSER_CSRF_COOKIE);
    const header = request.header(BROWSER_CSRF_HEADER);
    if (
      cookie === null ||
      header === undefined ||
      cookie.length !== header.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))
    ) {
      throw new ForbiddenException('Browser session CSRF validation failed.');
    }
  }
}

export function readBrowserAccessToken(request: Request): string | null {
  return readRequestCookie(request, BROWSER_ACCESS_COOKIE);
}

export function readRequestCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  const values: string[] = [];
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    if (segment.slice(0, separator).trim() !== name) continue;
    const encoded = segment.slice(separator + 1).trim();
    try {
      values.push(decodeURIComponent(encoded));
    } catch {
      return null;
    }
  }
  if (values.length !== 1 || values[0]!.length === 0) return null;
  return values[0]!;
}

function baseCookie(secure: boolean): Pick<CookieOptions, 'secure' | 'sameSite'> {
  return {
    secure,
    sameSite: 'strict',
  };
}
