import {
  BadRequestException,
  Inject,
  Injectable,
  Scope,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import type { TenantRole } from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../config/environment.js';

export interface TenantPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
  readonly authenticationSource: 'session' | 'development-header' | 'trusted-proxy';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  private principal?: TenantPrincipal;

  constructor(
    @Inject(REQUEST) private readonly request: Request,
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  get current(): TenantPrincipal {
    this.principal ??= this.resolvePrincipal();
    return this.principal;
  }

  private resolvePrincipal(): TenantPrincipal {
    if (this.request.authPrincipal !== undefined) {
      return {
        tenantId: this.request.authPrincipal.tenantId,
        userId: this.request.authPrincipal.userId,
        role: this.request.authPrincipal.role,
        authenticationSource: 'session',
      };
    }

    const production = this.config.get('NODE_ENV', { infer: true }) === 'production';

    if (production) {
      if (!this.config.get('TRUST_PROXY_IDENTITY_HEADERS', { infer: true })) {
        throw new UnauthorizedException(
          'No trusted identity provider is configured for production.',
        );
      }
      return {
        tenantId: this.requireUuidHeader('x-authenticated-tenant-id'),
        userId: this.requireUuidHeader('x-authenticated-user-id'),
        role: 'MEMBER',
        authenticationSource: 'trusted-proxy',
      };
    }

    if (!this.config.get('ALLOW_DEV_IDENTITY_HEADERS', { infer: true })) {
      throw new UnauthorizedException('Authentication required.');
    }

    return {
      tenantId: this.optionalUuidHeader(
        'x-tenant-id',
        this.config.get('DEV_TENANT_ID', { infer: true }),
      ),
      userId: this.optionalUuidHeader('x-user-id', this.config.get('DEV_USER_ID', { infer: true })),
      role: 'OWNER',
      authenticationSource: 'development-header',
    };
  }

  private requireUuidHeader(name: string): string {
    const value = this.request.header(name);
    if (value === undefined) {
      throw new UnauthorizedException(`Missing trusted identity header: ${name}.`);
    }
    return this.assertUuid(value, name);
  }

  private optionalUuidHeader(name: string, fallback: string): string {
    const value = this.request.header(name);
    return value === undefined ? fallback : this.assertUuid(value, name);
  }

  private assertUuid(value: string, name: string): string {
    if (!UUID_PATTERN.test(value)) {
      throw new BadRequestException(`${name} must be a UUID.`);
    }
    return value;
  }
}
