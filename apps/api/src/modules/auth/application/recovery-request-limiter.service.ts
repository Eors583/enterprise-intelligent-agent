import { createHmac } from 'node:crypto';

import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import { reserveAuthRateLimitBucket } from './auth-rate-limit-bucket.js';

export interface RecoveryRequestContext {
  readonly accountKeyHash: string;
  readonly networkKeyHash: string | null;
}

/**
 * Pre-identity throttling for password-reset requests and opaque-token
 * consumption. Only HMAC buckets are persisted, so random identifiers do not
 * disclose tenant slugs, email addresses, IP addresses, or action tokens.
 */
@Injectable()
export class RecoveryRequestLimiter {
  private readonly enabled: boolean;
  private readonly networkEnabled: boolean;
  private readonly pepper: string;
  private readonly accountLimit: number;
  private readonly networkLimit: number;
  private readonly windowSeconds: number;
  private readonly bucketCapacity: number;

  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('AUTH_LOGIN_RATE_LIMIT_ENABLED', { infer: true });
    this.networkEnabled = config.get('AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED', { infer: true });
    this.pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
    this.accountLimit =
      config.get('AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS', {
        infer: true,
      }) ?? 3;
    this.networkLimit =
      config.get('AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS', {
        infer: true,
      }) ?? 20;
    this.windowSeconds =
      config.get('AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS', {
        infer: true,
      }) ?? 3_600;
    this.bucketCapacity =
      config.get('AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE', { infer: true }) ?? 100_000;
  }

  createContext(input: {
    readonly namespace: 'password-request' | 'reset-token' | 'invite-token';
    readonly tenantSlug: string;
    readonly accountValue: string;
    readonly clientAddress?: string | null | undefined;
  }): RecoveryRequestContext {
    const namespace = input.namespace;
    const tenantSlug = input.tenantSlug.trim().toLowerCase();
    const accountValue = input.accountValue.trim().toLowerCase();
    const address = normalizeClientAddress(input.clientAddress);
    return {
      accountKeyHash: this.digest(
        `recovery-account\u0000${namespace}\u0000${tenantSlug}\u0000${accountValue}`,
      ),
      networkKeyHash: !this.networkEnabled
        ? null
        : this.digest(`recovery-network\u0000${namespace}\u0000${address}`),
    };
  }

  async beginRequest(context: RecoveryRequestContext): Promise<void> {
    if (!this.enabled) return;
    const blocked = await this.prisma.withAuth(async (transaction) => {
      const networkBlocked =
        context.networkKeyHash === null
          ? false
          : (
              await reserveAuthRateLimitBucket({
                transaction,
                keyHash: context.networkKeyHash,
                scope: 'RECOVERY_NETWORK',
                limit: this.networkLimit,
                windowSeconds: this.windowSeconds,
                blockSeconds: this.windowSeconds,
                capacity: this.bucketCapacity,
                staleRetentionSeconds: this.windowSeconds * 2,
              })
            ).blocked;
      if (networkBlocked) return true;

      return (
        await reserveAuthRateLimitBucket({
          transaction,
          keyHash: context.accountKeyHash,
          scope: 'RECOVERY_ACCOUNT',
          limit: this.accountLimit,
          windowSeconds: this.windowSeconds,
          blockSeconds: this.windowSeconds,
          capacity: this.bucketCapacity,
          staleRetentionSeconds: this.windowSeconds * 2,
        })
      ).blocked;
    });
    if (blocked) throw new RecoveryRateLimitExceededException();
  }

  private digest(value: string): string {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest('hex');
  }
}

function normalizeClientAddress(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return '\u0001unattributed-client';
  return normalized.slice(0, 200);
}

export class RecoveryRateLimitExceededException extends HttpException {
  constructor() {
    super('Too many recovery requests. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
