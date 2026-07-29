import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  IdentitySecurityOverview,
  RevokeIdentityResourceRequest,
  RevokeIdentityResourceResponse,
} from '@enterprise/contracts';

import { AuthPrismaService } from '../../database/auth-prisma.service.js';
import { MfaService } from '../auth/application/mfa.service.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';

@Injectable()
export class IdentityAccessService {
  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(MfaService) private readonly mfa: MfaService,
  ) {}

  async overview(principal: AuthenticatedPrincipal): Promise<IdentitySecurityOverview> {
    const [mfa, metadata] = await Promise.all([
      this.mfa.status(principal),
      this.prisma.withAuth(async (transaction) => {
        await setTenant(transaction, principal.tenantId);
        const [devices, sessions] = await Promise.all([
          transaction.$queryRaw<DeviceRow[]>`
            SELECT "id", "label", "platform", "device_class", "status",
                   "first_seen_at", "last_seen_at", "revoked_at",
                   "revoke_reason", "revision"
            FROM public."identity_device_metadata"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "user_id" = ${principal.userId}::uuid
            ORDER BY "last_seen_at" DESC, "id"
          `,
          transaction.$queryRaw<SessionRow[]>`
            SELECT "id", "device_id", "label", "access_expires_at",
                   "refresh_expires_at", "last_used_at", "last_mfa_at",
                   "last_mfa_method", "refresh_generation",
                   "refresh_replay_detected_at", "revoked_at", "revoked_reason",
                   "created_at", "version"
            FROM public."identity_session_metadata"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "user_id" = ${principal.userId}::uuid
            ORDER BY "last_used_at" DESC, "id"
          `,
        ]);
        return {
          devices: devices.map(mapDevice),
          sessions: sessions.map((session) => ({
            id: session.id,
            deviceId: session.device_id,
            label: session.label,
            accessExpiresAt: session.access_expires_at.toISOString(),
            refreshExpiresAt: session.refresh_expires_at.toISOString(),
            lastUsedAt: session.last_used_at.toISOString(),
            lastMfaAt: session.last_mfa_at?.toISOString() ?? null,
            lastMfaMethod: session.last_mfa_method,
            refreshGeneration: session.refresh_generation,
            refreshReplayDetectedAt: session.refresh_replay_detected_at?.toISOString() ?? null,
            revokedAt: session.revoked_at?.toISOString() ?? null,
            revokedReason: session.revoked_reason,
            createdAt: session.created_at.toISOString(),
            current: session.id === principal.sessionId,
            version: session.version,
          })),
        };
      }),
    ]);
    return { mfa, ...metadata };
  }

  async revokeSession(
    sessionId: string,
    request: RevokeIdentityResourceRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<RevokeIdentityResourceResponse> {
    const now = new Date();
    return this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, principal.tenantId);
      const updated = await transaction.$queryRaw<Array<{ version: number }>>`
        UPDATE public."auth_sessions"
        SET "revoked_at" = ${now},
            "revoked_reason" = ${request.reason},
            "version" = "version" + 1
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "id" = ${sessionId}::uuid
          AND "revoked_at" IS NULL
          AND "version" = ${request.expectedRevision}
        RETURNING "version"
      `;
      if (updated.length === 0) {
        await assertOwnedSession(transaction, principal, sessionId);
        throw new ConflictException('The session changed; refresh and retry.');
      }
      await audit(transaction, principal, 'auth.session_revoked', 'auth_session', sessionId, {
        reason: request.reason,
      });
      return {
        revokedAt: now.toISOString(),
        revokedSessionCount: 1,
        revision: updated[0]!.version,
      };
    });
  }

  async revokeDevice(
    deviceId: string,
    request: RevokeIdentityResourceRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<RevokeIdentityResourceResponse> {
    const now = new Date();
    return this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, principal.tenantId);
      const activeSessions = await transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS "count"
        FROM public."auth_sessions"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "device_id" = ${deviceId}::uuid
          AND "revoked_at" IS NULL
      `;
      const updated = await transaction.$queryRaw<Array<{ revision: number }>>`
        UPDATE public."identity_devices"
        SET "status" = 'REVOKED',
            "revoked_at" = ${now},
            "revoked_by_user_id" = ${principal.userId}::uuid,
            "revoke_reason" = ${request.reason},
            "revision" = "revision" + 1,
            "updated_at" = ${now}
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "id" = ${deviceId}::uuid
          AND "status" = 'ACTIVE'
          AND "revision" = ${request.expectedRevision}
        RETURNING "revision"
      `;
      if (updated.length === 0) {
        const owned = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM public."identity_device_metadata"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "user_id" = ${principal.userId}::uuid
            AND "id" = ${deviceId}::uuid
        `;
        if (owned.length === 0) throw new NotFoundException('Device was not found.');
        throw new ConflictException('The device changed; refresh and retry.');
      }
      await audit(transaction, principal, 'auth.device_revoked', 'identity_device', deviceId, {
        reason: request.reason,
      });
      return {
        revokedAt: now.toISOString(),
        revokedSessionCount: Number(activeSessions[0]?.count ?? 0),
        revision: updated[0]!.revision,
      };
    });
  }
}

interface DeviceRow {
  readonly id: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly device_class: string | null;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
  readonly revoked_at: Date | null;
  readonly revoke_reason: string | null;
  readonly revision: number;
}

interface SessionRow {
  readonly id: string;
  readonly device_id: string | null;
  readonly label: string | null;
  readonly access_expires_at: Date;
  readonly refresh_expires_at: Date;
  readonly last_used_at: Date;
  readonly last_mfa_at: Date | null;
  readonly last_mfa_method: 'TOTP' | 'RECOVERY_CODE' | null;
  readonly refresh_generation: number;
  readonly refresh_replay_detected_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
  readonly created_at: Date;
  readonly version: number;
}

function mapDevice(device: DeviceRow): IdentitySecurityOverview['devices'][number] {
  return {
    id: device.id,
    label: device.label,
    platform: device.platform,
    deviceClass: device.device_class,
    status: device.status,
    firstSeenAt: device.first_seen_at.toISOString(),
    lastSeenAt: device.last_seen_at.toISOString(),
    revokedAt: device.revoked_at?.toISOString() ?? null,
    revokeReason: device.revoke_reason,
    revision: device.revision,
  };
}

async function setTenant(transaction: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

async function assertOwnedSession(
  transaction: Prisma.TransactionClient,
  principal: AuthenticatedPrincipal,
  sessionId: string,
): Promise<void> {
  const owned = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM public."identity_session_metadata"
    WHERE "tenant_id" = ${principal.tenantId}::uuid
      AND "user_id" = ${principal.userId}::uuid
      AND "id" = ${sessionId}::uuid
  `;
  if (owned.length === 0) throw new NotFoundException('Session was not found.');
}

async function audit(
  transaction: Prisma.TransactionClient,
  principal: AuthenticatedPrincipal,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId: principal.tenantId,
      actorType: 'USER',
      actorId: principal.userId,
      action,
      resourceType,
      resourceId,
      metadata,
    },
  });
}
