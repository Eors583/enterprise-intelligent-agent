import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AuthService } from './application/auth.service.js';
import { BrowserSessionTransport, readBrowserAccessToken } from './browser-session.transport.js';
import { IS_PUBLIC_ROUTE } from './public.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
    @Inject(BrowserSessionTransport)
    private readonly browserSession: BrowserSessionTransport,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'OPTIONS' || isHealthRequest(request)) return true;

    const authorization = request.header('authorization');
    const cookieAccessToken = authorization === undefined ? readBrowserAccessToken(request) : null;
    if (authorization === undefined && cookieAccessToken === null) {
      // Header identities remain available only as a local/test compatibility
      // bridge. Production traffic must carry an authenticated session unless
      // the existing trusted identity proxy is explicitly enabled.
      if (
        this.config.get('ALLOW_DEV_IDENTITY_HEADERS', { infer: true }) ||
        this.config.get('TRUST_PROXY_IDENTITY_HEADERS', { infer: true })
      ) {
        return true;
      }
      throw unauthorized();
    }

    const token =
      authorization === undefined
        ? cookieAccessToken
        : /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
    if (token === null || token === undefined) throw unauthorized();

    request.authPrincipal = await this.auth.authenticateAccessToken(token);
    if (authorization === undefined && isMutationRequest(request)) {
      this.browserSession.requireCsrf(request);
    }
    if (request.authPrincipal.passwordChangeRequired && !isPasswordChangeFlowRequest(request)) {
      throw new ForbiddenException('Password change required.');
    }
    return true;
  }
}

function isMutationRequest(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
}

function isPasswordChangeFlowRequest(request: Request): boolean {
  const path = request.path.replace(/^\/api\/v1/, '');
  return path === '/auth/change-password' || path === '/auth/logout' || path === '/auth/me';
}

function isHealthRequest(request: Request): boolean {
  const path = request.path.replace(/^\/api\/v1/, '');
  return path === '/health/live' || path === '/health/ready';
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException('Authentication required.');
}
