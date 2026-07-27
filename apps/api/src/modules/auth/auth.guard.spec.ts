import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { EnvironmentVariables } from '../../config/environment.js';
import type { AuthService } from './application/auth.service.js';
import type { AuthenticatedPrincipal } from './domain/authenticated-principal.js';
import { AuthGuard } from './auth.guard.js';

const principal: AuthenticatedPrincipal = {
  sessionId: '00000000-0000-7000-8000-000000000010',
  tenantId: '00000000-0000-7000-8000-000000000001',
  tenantSlug: 'test-workspace',
  tenantName: 'Test workspace',
  userId: '00000000-0000-7000-8000-000000000101',
  email: 'user@example.test',
  displayName: 'Test user',
  role: 'OWNER',
  passwordChangeRequired: false,
  accessExpiresAt: '2030-01-01T00:15:00.000Z',
  refreshExpiresAt: '2030-01-31T00:00:00.000Z',
  authenticationSource: 'session',
};

describe('AuthGuard', () => {
  it('requires a bearer session in production', async () => {
    const { guard, context } = setup({ environment: 'production' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('allows explicitly public routes', async () => {
    const { guard, context } = setup({ environment: 'production', isPublic: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('authenticates a bearer token and attaches its principal', async () => {
    const token = `ea_access_${'a'.repeat(43)}`;
    const { guard, context, request, authenticate } = setup({
      environment: 'production',
      authorization: `Bearer ${token}`,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith(token);
    expect(request.authPrincipal).toEqual(principal);
  });

  it('blocks normal application routes until a required password change is completed', async () => {
    const { guard, context } = setup({
      environment: 'production',
      authorization: `Bearer ea_access_${'a'.repeat(43)}`,
      authenticatedPrincipal: { ...principal, passwordChangeRequired: true },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it.each(['/api/v1/auth/change-password', '/api/v1/auth/logout', '/api/v1/auth/me'])(
    'allows the constrained password-change flow at %s',
    async (path) => {
      const { guard, context } = setup({
        environment: 'production',
        authorization: `Bearer ea_access_${'a'.repeat(43)}`,
        authenticatedPrincipal: { ...principal, passwordChangeRequired: true },
        path,
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    },
  );
});

function setup(options: {
  readonly environment: 'development' | 'production';
  readonly isPublic?: boolean;
  readonly authorization?: string;
  readonly authenticatedPrincipal?: AuthenticatedPrincipal;
  readonly path?: string;
}): {
  readonly guard: AuthGuard;
  readonly context: ExecutionContext;
  readonly request: Request;
  readonly authenticate: ReturnType<typeof vi.fn>;
} {
  const request = {
    method: 'GET',
    path: options.path ?? '/api/v1/bootstrap',
    header: (name: string) => (name === 'authorization' ? options.authorization : undefined),
  } as Request;
  const context = {
    getHandler: () => setup,
    getClass: () => AuthGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: () => options.isPublic ?? false,
  } as unknown as Reflector;
  const authenticate = vi.fn().mockResolvedValue(options.authenticatedPrincipal ?? principal);
  const auth = { authenticateAccessToken: authenticate } as unknown as AuthService;
  const config = {
    get: (key: keyof EnvironmentVariables) => {
      if (key === 'NODE_ENV') return options.environment;
      if (key === 'TRUST_PROXY_IDENTITY_HEADERS') return false;
      return undefined;
    },
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return {
    guard: new AuthGuard(reflector, auth, config),
    context,
    request,
    authenticate,
  };
}
