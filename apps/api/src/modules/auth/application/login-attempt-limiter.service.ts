import { createHmac } from 'node:crypto';

import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import { reserveAuthRateLimitBucket } from './auth-rate-limit-bucket.js';

export interface LoginAttemptContext {
  readonly accountKeyHash: string;
  readonly networkKeyHash: string | null;
}

@Injectable()
export class LoginAttemptLimiter {
  readonly enabled: boolean;
  private readonly networkEnabled: boolean;
  private readonly tokenPepper: string;
  private readonly accountFailureLimit: number;
  private readonly networkFailureLimit: number;
  private readonly windowSeconds: number;
  private readonly blockSeconds: number;
  private readonly bucketCapacity: number;

  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('AUTH_LOGIN_RATE_LIMIT_ENABLED', { infer: true });
    this.networkEnabled = config.get('AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED', { infer: true });
    this.tokenPepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
    this.accountFailureLimit = config.get('AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES', {
      infer: true,
    });
    this.networkFailureLimit = config.get('AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES', {
      infer: true,
    });
    this.windowSeconds = config.get('AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS', { infer: true });
    this.blockSeconds = config.get('AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS', { infer: true });
    this.bucketCapacity =
      config.get('AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE', { infer: true }) ?? 100_000;
  }

  createContext(input: {
    readonly tenantSlug: string;
    readonly email: string;
    readonly clientAddress?: string | null;
  }): LoginAttemptContext {
    const tenantSlug = input.tenantSlug.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    const clientAddress = normalizeClientAddress(input.clientAddress);
    return {
      accountKeyHash: this.digest(`account\u0000${tenantSlug}\u0000${email}`),
      networkKeyHash: !this.networkEnabled ? null : this.digest(`network\u0000${clientAddress}`),
    };
  }

  async beginAttempt(context: LoginAttemptContext): Promise<void> {
    if (!this.enabled) return;
    const blocked = await this.prisma.withAuth(async (transaction) => {
      const networkBlocked =
        context.networkKeyHash === null
          ? false
          : (
              await reserveAuthRateLimitBucket({
                transaction,
                keyHash: context.networkKeyHash,
                scope: 'NETWORK',
                limit: this.networkFailureLimit,
                windowSeconds: this.windowSeconds,
                blockSeconds: this.blockSeconds,
                capacity: this.bucketCapacity,
                staleRetentionSeconds: Math.max(this.windowSeconds, this.blockSeconds) * 2,
              })
            ).blocked;
      // A blocked or capacity-exhausted global network bucket must short-circuit
      // before an attacker-controlled tenant/email can allocate another row.
      if (networkBlocked) return true;

      return (
        await reserveAuthRateLimitBucket({
          transaction,
          keyHash: context.accountKeyHash,
          scope: 'ACCOUNT',
          limit: this.accountFailureLimit,
          windowSeconds: this.windowSeconds,
          blockSeconds: this.blockSeconds,
          capacity: this.bucketCapacity,
          staleRetentionSeconds: Math.max(this.windowSeconds, this.blockSeconds) * 2,
        })
      ).blocked;
    });
    if (blocked) throw rateLimited();
  }

  async clearSuccessfulAttempt(context: LoginAttemptContext): Promise<void> {
    if (!this.enabled) return;
    await this.prisma.withAuth(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        DELETE FROM public."auth_login_rate_limits"
        WHERE "key_hash" = ${context.accountKeyHash}
      `);
      if (context.networkKeyHash === null) return;

      // The network bucket is shared by every account behind the same
      // address across all tenants. Roll back only this successful attempt's
      // reservation; deleting the row would let one valid account erase
      // password-spraying failures against every other account.
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."auth_login_rate_limits"
        SET "failure_count" = GREATEST("failure_count" - 1, 0),
            "updated_at" = now()
        WHERE "key_hash" = ${context.networkKeyHash}
          AND "scope" = 'NETWORK'
      `);
      await transaction.$executeRaw(Prisma.sql`
        DELETE FROM public."auth_login_rate_limits"
        WHERE "key_hash" = ${context.networkKeyHash}
          AND "scope" = 'NETWORK'
          AND "failure_count" = 0
          AND ("blocked_until" IS NULL OR "blocked_until" <= now())
      `);
    });
  }

  private digest(value: string): string {
    return createHmac('sha256', this.tokenPepper).update(value, 'utf8').digest('hex');
  }
}

function normalizeClientAddress(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return '\u0001unattributed-client';
  return normalized.slice(0, 200);
}

export class LoginRateLimitExceededException extends HttpException {
  constructor() {
    super('Too many login attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
  }
}

function rateLimited(): LoginRateLimitExceededException {
  return new LoginRateLimitExceededException();
}
