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
import { IS_PUBLIC_ROUTE } from './public.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
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
    if (authorization === undefined) {
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

    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
    if (match === null) throw unauthorized();

    request.authPrincipal = await this.auth.authenticateAccessToken(match[1]!);
    if (request.authPrincipal.passwordChangeRequired && !isPasswordChangeFlowRequest(request)) {
      throw new ForbiddenException('Password change required.');
    }
    return true;
  }
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
