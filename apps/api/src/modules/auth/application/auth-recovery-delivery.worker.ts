import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import { IdentitySecretVault } from '../../identity-governance/identity-secret-vault.js';
import {
  AuthRecoveryNotificationService,
  type AuthRecoveryDeliveryStatus,
} from './auth-recovery-notification.service.js';

const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

interface RecoveryDeliveryPayload {
  readonly schemaVersion: 1;
  readonly email: string;
  readonly displayName: string;
  readonly tenantName: string;
  readonly token: string;
}

interface RecoveryDeliveryClaim {
  readonly id: string;
  readonly tenantId: string;
  readonly actionTokenId: string;
  readonly payloadCiphertext: Uint8Array;
  readonly attempts: number;
  readonly expiresAt: Date;
}

@Injectable()
export class AuthRecoveryDeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuthRecoveryDeliveryWorker.name);
  private readonly workerId = `auth-recovery:${process.pid}:${randomUUID()}`;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(IdentitySecretVault) private readonly vault: IdentitySecretVault,
    @Inject(AuthRecoveryNotificationService)
    private readonly notifications: AuthRecoveryNotificationService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.prisma.enabled) return;
    this.stopped = false;
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  async runOnce(): Promise<number> {
    if (!this.prisma.enabled) return 0;
    const claims = await this.claim();
    const results = await Promise.allSettled(claims.map((claim) => this.process(claim)));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Unable to persist an account-recovery delivery transition (${errorKind(result.reason)}).`,
        );
      }
    }
    return claims.length;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const tick = this.tick();
      this.activeTick = tick;
      void tick.finally(() => {
        if (this.activeTick === tick) this.activeTick = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Account-recovery delivery polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(POLL_INTERVAL_MS);
    }
  }

  private async claim(): Promise<readonly RecoveryDeliveryClaim[]> {
    const lockedUntil = new Date(Date.now() + LEASE_MS);
    return this.prisma.withAuth(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."auth_recovery_deliveries" delivery
        SET "status" = 'EXPIRED',
            "payload_ciphertext" = NULL,
            "payload_key_id" = NULL,
            "payload_format_version" = NULL,
            "locked_by" = NULL,
            "locked_until" = NULL,
            "last_error_code" = 'ACTION_TOKEN_INACTIVE',
            "updated_at" = CURRENT_TIMESTAMP
        FROM public."auth_action_tokens" action
        WHERE action."id" = delivery."action_token_id"
          AND delivery."status" IN ('PENDING', 'PROCESSING')
          AND (
            delivery."expires_at" <= CURRENT_TIMESTAMP
            OR action."expires_at" <= CURRENT_TIMESTAMP
            OR action."consumed_at" IS NOT NULL
            OR action."revoked_at" IS NOT NULL
          )
      `);
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."auth_action_tokens" action
        SET "delivery_status" = 'FAILED',
            "last_delivery_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
        FROM public."auth_recovery_deliveries" delivery
        WHERE delivery."tenant_id" = action."tenant_id"
          AND delivery."action_token_id" = action."id"
          AND delivery."status" = 'EXPIRED'
          AND action."delivery_status" = 'PENDING'
      `);
      return transaction.$queryRaw<RecoveryDeliveryClaim[]>(Prisma.sql`
        WITH candidates AS (
          SELECT delivery."id"
          FROM public."auth_recovery_deliveries" delivery
          JOIN public."auth_action_tokens" action
            ON action."tenant_id" = delivery."tenant_id"
           AND action."id" = delivery."action_token_id"
          WHERE delivery."status" IN ('PENDING', 'PROCESSING')
            AND delivery."available_at" <= CURRENT_TIMESTAMP
            AND (
              delivery."status" = 'PENDING'
              OR delivery."locked_until" <= CURRENT_TIMESTAMP
            )
            AND delivery."expires_at" > CURRENT_TIMESTAMP
            AND action."expires_at" > CURRENT_TIMESTAMP
            AND action."consumed_at" IS NULL
            AND action."revoked_at" IS NULL
          ORDER BY delivery."available_at", delivery."created_at", delivery."id"
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT ${BATCH_SIZE}
        )
        UPDATE public."auth_recovery_deliveries" delivery
        SET "status" = 'PROCESSING',
            "attempts" = delivery."attempts" + 1,
            "locked_by" = ${this.workerId},
            "locked_until" = ${lockedUntil},
            "last_error_code" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
        FROM candidates
        WHERE delivery."id" = candidates."id"
        RETURNING delivery."id",
                  delivery."tenant_id" AS "tenantId",
                  delivery."action_token_id" AS "actionTokenId",
                  delivery."payload_ciphertext" AS "payloadCiphertext",
                  delivery."attempts",
                  delivery."expires_at" AS "expiresAt"
      `);
    });
  }

  private async process(claim: RecoveryDeliveryClaim): Promise<void> {
    let status: AuthRecoveryDeliveryStatus = 'FAILED';
    let errorCode: string | null = null;
    try {
      const payload = parsePayload(
        this.vault.decrypt(claim.payloadCiphertext, {
          tenantId: claim.tenantId,
          resourceId: claim.id,
          purpose: 'AUTH_RECOVERY_DELIVERY',
        }),
      );
      status = await this.notifications.sendPasswordReset(payload);
      if (status === 'FAILED') errorCode = 'PROVIDER_REJECTED';
    } catch (error) {
      errorCode = errorKind(error).slice(0, 120);
    }

    const retryAt =
      status === 'FAILED' && claim.attempts < MAX_ATTEMPTS
        ? nextRetryAt(claim.attempts, claim.expiresAt)
        : null;
    const deliveryStatus = retryAt === null ? status : 'PENDING';
    await this.prisma.withAuth(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."auth_recovery_deliveries"
        SET "status" = ${deliveryStatus},
            "payload_ciphertext" = CASE
              WHEN ${deliveryStatus} = 'PENDING' THEN "payload_ciphertext"
              ELSE NULL
            END,
            "payload_key_id" = CASE
              WHEN ${deliveryStatus} = 'PENDING' THEN "payload_key_id"
              ELSE NULL
            END,
            "payload_format_version" = CASE
              WHEN ${deliveryStatus} = 'PENDING' THEN "payload_format_version"
              ELSE NULL
            END,
            "available_at" = ${retryAt ?? new Date()},
            "locked_by" = NULL,
            "locked_until" = NULL,
            "last_error_code" = ${errorCode},
            "delivered_at" = CASE
              WHEN ${status} IN ('SENT', 'NOT_CONFIGURED') THEN CURRENT_TIMESTAMP
              ELSE "delivered_at"
            END,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${claim.tenantId}::uuid
          AND "id" = ${claim.id}::uuid
          AND "status" = 'PROCESSING'
          AND "locked_by" = ${this.workerId}
      `);
      if (updated !== 1) return;
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."auth_action_tokens"
        SET "delivery_status" = ${deliveryStatus},
            "delivery_attempts" = ${claim.attempts},
            "last_delivery_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${claim.tenantId}::uuid
          AND "id" = ${claim.actionTokenId}::uuid
          AND "consumed_at" IS NULL
          AND "revoked_at" IS NULL
      `);
    });
  }
}

function parsePayload(value: string): RecoveryDeliveryPayload {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schemaVersion' in parsed) ||
    parsed.schemaVersion !== 1 ||
    !('email' in parsed) ||
    typeof parsed.email !== 'string' ||
    !('displayName' in parsed) ||
    typeof parsed.displayName !== 'string' ||
    !('tenantName' in parsed) ||
    typeof parsed.tenantName !== 'string' ||
    !('token' in parsed) ||
    typeof parsed.token !== 'string'
  ) {
    throw new Error('Stored account-recovery delivery payload is invalid.');
  }
  return parsed as RecoveryDeliveryPayload;
}

function nextRetryAt(attempt: number, expiresAt: Date): Date | null {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const retryAt = new Date(Date.now() + delayMs);
  return retryAt < expiresAt ? retryAt : null;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
