import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  BreakGlassActivateRequest,
  BreakGlassDecisionRequest,
  BreakGlassRequest,
  BreakGlassRevokeRequest,
  BreakGlassScope,
  CloseBreakGlassReviewRequest,
  CreateBreakGlassRequest,
} from '@enterprise/contracts';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';

@Injectable()
export class BreakGlassService {
  constructor(@Inject(AdminPrismaService) private readonly prisma: AdminPrismaService) {}

  async listMine(principal: AuthenticatedPrincipal): Promise<{ items: BreakGlassRequest[] }> {
    const snapshot = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const asOf = await expireDueRequests(transaction, principal.tenantId);
      const rows = await transaction.$queryRaw<BreakGlassRow[]>`
        SELECT *
        FROM public."identity_break_glass_requests"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "requester_user_id" = ${principal.userId}::uuid
        ORDER BY "created_at" DESC, "id"
      `;
      return { rows, asOf };
    });
    return {
      items: snapshot.rows.map((row) => mapBreakGlassRequest(row, snapshot.asOf)),
    };
  }

  async listForAdministration(
    principal: AuthenticatedPrincipal,
  ): Promise<{ items: BreakGlassRequest[] }> {
    requireAdmin(principal);
    const snapshot = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const asOf = await expireDueRequests(transaction, principal.tenantId);
      const rows = await transaction.$queryRaw<BreakGlassRow[]>`
        SELECT *
        FROM public."identity_break_glass_requests"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
        ORDER BY
          CASE "status"
            WHEN 'PENDING_APPROVAL' THEN 0
            WHEN 'REVIEW_PENDING' THEN 1
            WHEN 'APPROVED' THEN 2
            WHEN 'ACTIVE' THEN 3
            ELSE 4
          END,
          "created_at" DESC,
          "id"
      `;
      return { rows, asOf };
    });
    return {
      items: snapshot.rows.map((row) => mapBreakGlassRequest(row, snapshot.asOf)),
    };
  }

  async request(
    input: CreateBreakGlassRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<BreakGlassRequest> {
    const requestHash = hashJson({ action: 'REQUEST', ...input });
    const snapshot = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const now = await readDatabaseClock(transaction);
      const replay = await findReplay(
        transaction,
        principal.tenantId,
        input.idempotencyKey,
        requestHash,
        'REQUEST',
      );
      if (replay !== null) return { row: replay, asOf: now };

      const requestId = randomUUID();
      const rows = await transaction.$queryRaw<BreakGlassRow[]>`
        INSERT INTO public."identity_break_glass_requests" (
          "id", "tenant_id", "requester_user_id", "scopes", "reason",
          "requested_duration_seconds", "status", "revision", "created_at", "updated_at"
        ) VALUES (
          ${requestId}::uuid, ${principal.tenantId}::uuid, ${principal.userId}::uuid,
          ${[...new Set(input.scopes)]}, ${input.reason},
          ${input.requestedDurationSeconds}, 'PENDING_APPROVAL', 1, ${now}, ${now}
        )
        RETURNING *
      `;
      await insertEvent(transaction, {
        tenantId: principal.tenantId,
        requestId,
        action: 'REQUEST',
        fromStatus: null,
        toStatus: 'PENDING_APPROVAL',
        actorType: 'USER',
        actorUserId: principal.userId,
        actorSessionId: principal.sessionId,
        expectedRevision: 0,
        resultRevision: 1,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        reason: input.reason,
        occurredAt: now,
      });
      return { row: rows[0]!, asOf: now };
    });
    return mapBreakGlassRequest(snapshot.row, snapshot.asOf);
  }

  approve(
    requestId: string,
    input: BreakGlassDecisionRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<BreakGlassRequest> {
    requireAdmin(principal);
    return this.transition(
      requestId,
      'APPROVE',
      input,
      principal,
      async (transaction, current, now) => {
        if (current.status !== 'PENDING_APPROVAL') {
          throw new ConflictException('Only a pending break-glass request can be approved.');
        }
        if (current.requester_user_id === principal.userId) {
          throw new ForbiddenException(
            'Break-glass requester and approving checker must be different people.',
          );
        }
        await requireRecentMfa(transaction, principal, now);
        return transaction.$queryRaw<BreakGlassRow[]>`
          UPDATE public."identity_break_glass_requests"
          SET "status" = 'APPROVED',
              "approved_by_user_id" = ${principal.userId}::uuid,
              "approval_comment" = ${input.comment},
              "approved_at" = ${now},
              "revision" = "revision" + 1,
              "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${requestId}::uuid
            AND "revision" = ${input.expectedRevision}
          RETURNING *
        `;
      },
      input.comment,
    );
  }

  reject(
    requestId: string,
    input: BreakGlassDecisionRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<BreakGlassRequest> {
    requireAdmin(principal);
    return this.transition(
      requestId,
      'REJECT',
      input,
      principal,
      async (transaction, current, now) => {
        if (current.status !== 'PENDING_APPROVAL') {
          throw new ConflictException('Only a pending break-glass request can be rejected.');
        }
        if (current.requester_user_id === principal.userId) {
          throw new ForbiddenException(
            'Break-glass requester and rejecting checker must be different people.',
          );
        }
        return transaction.$queryRaw<BreakGlassRow[]>`
          UPDATE public."identity_break_glass_requests"
          SET "status" = 'REJECTED',
              "rejected_by_user_id" = ${principal.userId}::uuid,
              "rejection_reason" = ${input.comment},
              "rejected_at" = ${now},
              "revision" = "revision" + 1,
              "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${requestId}::uuid
            AND "revision" = ${input.expectedRevision}
          RETURNING *
        `;
      },
      input.comment,
    );
  }

  activate(
    requestId: string,
    input: BreakGlassActivateRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<BreakGlassRequest> {
    return this.transition(
      requestId,
      'ACTIVATE',
      input,
      principal,
      async (transaction, current, now) => {
        if (current.status !== 'APPROVED') {
          throw new ConflictException('Break-glass access must be independently approved first.');
        }
        if (current.requester_user_id !== principal.userId) {
          throw new ForbiddenException('Only the original requester may activate this grant.');
        }
        await requireRecentMfa(transaction, principal, now);
        const activeUntil = new Date(now.getTime() + current.requested_duration_seconds * 1_000);
        return transaction.$queryRaw<BreakGlassRow[]>`
          UPDATE public."identity_break_glass_requests"
          SET "status" = 'ACTIVE',
              "activated_at" = ${now},
              "active_until" = ${activeUntil},
              "revision" = "revision" + 1,
              "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${requestId}::uuid
            AND "revision" = ${input.expectedRevision}
          RETURNING *
        `;
      },
      null,
    );
  }

  revoke(
    requestId: string,
    input: BreakGlassRevokeRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<BreakGlassRequest> {
    return this.transition(
      requestId,
      'REVOKE',
      input,
      principal,
      async (transaction, current, now) => {
        if (current.status !== 'ACTIVE') {
          throw new ConflictException('Only active break-glass access can be revoked.');
        }
        if (current.requester_user_id !== principal.userId && !isAdmin(principal)) {
          throw new ForbiddenException(
            'Only the requester or an administrator may revoke break-glass access.',
          );
        }
        await requireRecentMfa(transaction, principal, now);
        return transaction.$queryRaw<BreakGlassRow[]>`
          UPDATE public."identity_break_glass_requests"
          SET "status" = 'REVIEW_PENDING',
              "termination_kind" = 'REVOKED',
              "terminated_at" = ${now},
              "revoked_by_user_id" = ${principal.userId}::uuid,
              "revocation_reason" = ${input.reason},
              "revision" = "revision" + 1,
              "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${requestId}::uuid
            AND "revision" = ${input.expectedRevision}
          RETURNING *
        `;
      },
      input.reason,
    );
  }

  closeReview(
    requestId: string,
    input: CloseBreakGlassReviewRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<BreakGlassRequest> {
    requireAdmin(principal);
    return this.transition(
      requestId,
      'REVIEW_CLOSE',
      input,
      principal,
      async (transaction, current, now) => {
        if (current.status !== 'REVIEW_PENDING') {
          throw new ConflictException('Only a terminated grant can complete post-access review.');
        }
        if (current.requester_user_id === principal.userId) {
          throw new ForbiddenException('The requester cannot close their own break-glass review.');
        }
        await requireRecentMfa(transaction, principal, now);
        return transaction.$queryRaw<BreakGlassRow[]>`
          UPDATE public."identity_break_glass_requests"
          SET "status" = 'CLOSED',
              "reviewed_by_user_id" = ${principal.userId}::uuid,
              "review_outcome" = ${input.outcome},
              "review_summary" = ${input.summary},
              "reviewed_at" = ${now},
              "closed_at" = ${now},
              "revision" = "revision" + 1,
              "updated_at" = ${now}
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${requestId}::uuid
            AND "revision" = ${input.expectedRevision}
          RETURNING *
        `;
      },
      input.summary,
    );
  }

  async hasActiveGrant(
    scope: BreakGlassScope,
    principal: AuthenticatedPrincipal,
  ): Promise<boolean> {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ active: boolean }>>`
        SELECT public.has_active_break_glass_grant(
          ${principal.sessionId}::uuid,
          ${scope}
        ) AS "active"
      `;
      return rows[0]?.active ?? false;
    });
  }

  async assertActiveGrant(
    scope: BreakGlassScope,
    principal: AuthenticatedPrincipal,
  ): Promise<void> {
    if (!(await this.hasActiveGrant(scope, principal))) {
      throw new ForbiddenException('No active break-glass grant covers this operation.');
    }
  }

  private async transition(
    requestId: string,
    action: UserAction,
    input: TransitionInput,
    principal: AuthenticatedPrincipal,
    mutate: (
      transaction: Prisma.TransactionClient,
      current: BreakGlassRow,
      now: Date,
    ) => Promise<BreakGlassRow[]>,
    reason: string | null,
  ): Promise<BreakGlassRequest> {
    const requestHash = hashJson({ action, requestId, ...input });
    const snapshot = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const now = await expireDueRequests(transaction, principal.tenantId);
      const replay = await findReplay(
        transaction,
        principal.tenantId,
        input.idempotencyKey,
        requestHash,
        action,
      );
      if (replay !== null) return { row: replay, asOf: now };

      const current = await lockRequest(transaction, principal.tenantId, requestId);
      if (current.revision !== input.expectedRevision) {
        throw new ConflictException('Break-glass request changed; refresh and retry.');
      }
      const rows = await mutate(transaction, current, now);
      const next = rows[0];
      if (next === undefined) {
        throw new ConflictException('Break-glass request changed; refresh and retry.');
      }
      await insertEvent(transaction, {
        tenantId: principal.tenantId,
        requestId,
        action,
        fromStatus: current.status,
        toStatus: next.status,
        actorType: 'USER',
        actorUserId: principal.userId,
        actorSessionId: principal.sessionId,
        expectedRevision: current.revision,
        resultRevision: next.revision,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        reason,
        occurredAt: now,
      });
      return { row: next, asOf: now };
    });
    return mapBreakGlassRequest(snapshot.row, snapshot.asOf);
  }
}

type BreakGlassStatus =
  'PENDING_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'REVIEW_PENDING' | 'CLOSED' | 'REJECTED';
type UserAction = 'APPROVE' | 'REJECT' | 'ACTIVATE' | 'REVOKE' | 'REVIEW_CLOSE';
type TransitionInput =
  | BreakGlassDecisionRequest
  | BreakGlassActivateRequest
  | BreakGlassRevokeRequest
  | CloseBreakGlassReviewRequest;

interface BreakGlassRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly requester_user_id: string;
  readonly scopes: BreakGlassScope[];
  readonly reason: string;
  readonly requested_duration_seconds: number;
  readonly status: BreakGlassStatus;
  readonly approved_by_user_id: string | null;
  readonly approval_comment: string | null;
  readonly approved_at: Date | null;
  readonly rejected_by_user_id: string | null;
  readonly rejection_reason: string | null;
  readonly rejected_at: Date | null;
  readonly activated_at: Date | null;
  readonly active_until: Date | null;
  readonly termination_kind: 'EXPIRED' | 'REVOKED' | null;
  readonly terminated_at: Date | null;
  readonly revoked_by_user_id: string | null;
  readonly revocation_reason: string | null;
  readonly reviewed_by_user_id: string | null;
  readonly review_outcome: 'NO_ISSUE' | 'FOLLOW_UP_REQUIRED' | 'CONTROL_GAP_FOUND' | null;
  readonly review_summary: string | null;
  readonly reviewed_at: Date | null;
  readonly closed_at: Date | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface EventInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly action: 'REQUEST' | UserAction | 'EXPIRE';
  readonly fromStatus: BreakGlassStatus | null;
  readonly toStatus: BreakGlassStatus;
  readonly actorType: 'USER' | 'SYSTEM';
  readonly actorUserId: string | null;
  readonly actorSessionId: string | null;
  readonly expectedRevision: number;
  readonly resultRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

async function lockRequest(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  requestId: string,
): Promise<BreakGlassRow> {
  const rows = await transaction.$queryRaw<BreakGlassRow[]>`
    SELECT *
    FROM public."identity_break_glass_requests"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${requestId}::uuid
    FOR UPDATE
  `;
  if (rows[0] === undefined) throw new NotFoundException('Break-glass request was not found.');
  return rows[0];
}

async function findReplay(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
  action: string,
): Promise<BreakGlassRow | null> {
  const rows = await transaction.$queryRaw<
    Array<{ action: string; request_hash: string; request_id: string }>
  >`
    SELECT "action", "request_hash", "request_id"
    FROM public."identity_break_glass_events"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "idempotency_key" = ${idempotencyKey}
  `;
  const event = rows[0];
  if (event === undefined) return null;
  if (event.action !== action || event.request_hash !== requestHash) {
    throw new ConflictException('Idempotency key was reused with a different request.');
  }
  return lockRequest(transaction, tenantId, event.request_id);
}

async function insertEvent(
  transaction: Prisma.TransactionClient,
  input: EventInput,
): Promise<void> {
  await transaction.$executeRaw`
    INSERT INTO public."identity_break_glass_events" (
      "tenant_id", "request_id", "action", "from_status", "to_status",
      "actor_type", "actor_user_id", "actor_session_id",
      "expected_revision", "result_revision", "idempotency_key",
      "request_hash", "reason", "occurred_at"
    ) VALUES (
      ${input.tenantId}::uuid, ${input.requestId}::uuid, ${input.action},
      ${input.fromStatus}::public."BreakGlassRequestStatus",
      ${input.toStatus}::public."BreakGlassRequestStatus",
      ${input.actorType}, ${input.actorUserId}::uuid, ${input.actorSessionId}::uuid,
      ${input.expectedRevision}, ${input.resultRevision}, ${input.idempotencyKey},
      ${input.requestHash}, ${input.reason}, ${input.occurredAt}
    )
  `;
}

async function expireDueRequests(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<Date> {
  const now = await readDatabaseClock(transaction);
  const due = await transaction.$queryRaw<BreakGlassRow[]>`
    SELECT *
    FROM public."identity_break_glass_requests"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "status" = 'ACTIVE'
      AND "active_until" <= ${now}
    ORDER BY "active_until", "id"
    FOR UPDATE
  `;
  for (const current of due) {
    const rows = await transaction.$queryRaw<BreakGlassRow[]>`
      UPDATE public."identity_break_glass_requests"
      SET "status" = 'REVIEW_PENDING',
          "termination_kind" = 'EXPIRED',
          "terminated_at" = ${now},
          "revision" = "revision" + 1,
          "updated_at" = ${now}
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${current.id}::uuid
        AND "status" = 'ACTIVE'
        AND "revision" = ${current.revision}
      RETURNING *
    `;
    const expired = rows[0];
    if (expired === undefined) continue;
    const idempotencyKey = `break-glass-expire:${current.id}:${current.revision}`;
    await insertEvent(transaction, {
      tenantId,
      requestId: current.id,
      action: 'EXPIRE',
      fromStatus: 'ACTIVE',
      toStatus: 'REVIEW_PENDING',
      actorType: 'SYSTEM',
      actorUserId: null,
      actorSessionId: null,
      expectedRevision: current.revision,
      resultRevision: expired.revision,
      idempotencyKey,
      requestHash: hashJson({
        action: 'EXPIRE',
        requestId: current.id,
        activeUntil: current.active_until?.toISOString(),
        expectedRevision: current.revision,
      }),
      reason: 'Approved break-glass duration elapsed.',
      occurredAt: now,
    });
  }
  return now;
}

async function readDatabaseClock(transaction: Prisma.TransactionClient): Promise<Date> {
  // Expiry is enforced by SQL, so transition timestamps and API projections
  // must use the same clock authority rather than the API host clock.
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('Unable to read the database clock.');
  return now;
}

async function requireRecentMfa(
  transaction: Prisma.TransactionClient,
  principal: AuthenticatedPrincipal,
  now: Date,
): Promise<void> {
  const rows = await transaction.$queryRaw<
    Array<{ last_mfa_at: Date | null; max_age_seconds: number }>
  >`
    SELECT session."last_mfa_at",
           COALESCE(policy."recent_mfa_max_age_seconds", 300) AS "max_age_seconds"
    FROM public."auth_sessions" AS session
    LEFT JOIN public."enterprise_identity_policies" AS policy
      ON policy."tenant_id" = session."tenant_id"
     AND policy."publication_status" = 'PUBLISHED'
    WHERE session."tenant_id" = ${principal.tenantId}::uuid
      AND session."id" = ${principal.sessionId}::uuid
      AND session."user_id" = ${principal.userId}::uuid
      AND session."revoked_at" IS NULL
      AND session."access_expires_at" > ${now}
  `;
  const evidence = rows[0];
  if (
    evidence?.last_mfa_at === null ||
    evidence?.last_mfa_at === undefined ||
    evidence.last_mfa_at.getTime() < now.getTime() - evidence.max_age_seconds * 1_000
  ) {
    throw new ForbiddenException('This break-glass action requires recent MFA verification.');
  }
}

function mapBreakGlassRequest(row: BreakGlassRow, asOf: Date): BreakGlassRequest {
  const now = asOf.getTime();
  return {
    id: row.id,
    requesterUserId: row.requester_user_id,
    scopes: row.scopes,
    reason: row.reason,
    requestedDurationSeconds: row.requested_duration_seconds,
    status: row.status,
    approvedByUserId: row.approved_by_user_id,
    approvalComment: row.approval_comment,
    approvedAt: row.approved_at?.toISOString() ?? null,
    rejectedByUserId: row.rejected_by_user_id,
    rejectionReason: row.rejection_reason,
    rejectedAt: row.rejected_at?.toISOString() ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    activeUntil: row.active_until?.toISOString() ?? null,
    effective:
      row.status === 'ACTIVE' &&
      row.activated_at !== null &&
      row.activated_at.getTime() <= now &&
      row.active_until !== null &&
      row.active_until.getTime() > now,
    terminationKind: row.termination_kind,
    terminatedAt: row.terminated_at?.toISOString() ?? null,
    revokedByUserId: row.revoked_by_user_id,
    revocationReason: row.revocation_reason,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewOutcome: row.review_outcome,
    reviewSummary: row.review_summary,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function requireAdmin(principal: AuthenticatedPrincipal): void {
  if (!isAdmin(principal)) {
    throw new ForbiddenException('Break-glass approval requires an owner or administrator.');
  }
}

function isAdmin(principal: AuthenticatedPrincipal): boolean {
  return principal.role === 'OWNER' || principal.role === 'ADMIN';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
