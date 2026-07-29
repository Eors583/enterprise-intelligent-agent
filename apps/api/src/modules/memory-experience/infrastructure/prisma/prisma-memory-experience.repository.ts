import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  experienceCandidateSchema,
  experiencePublishPayloadSchema,
  experienceReviewPayloadSchema,
  experienceValidatePayloadSchema,
  memoryRecordSchema,
  type ExperienceCandidate,
  type ExperienceListQuery,
  type ExperienceTransitionRequest,
  type MemoryListQuery,
  type MemoryRecord,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  MemoryExperienceRepository,
  type CreateExperienceInput,
  type CreateMemoryInput,
  type TransitionExperienceInput,
  type TransitionMemoryInput,
} from '../../memory-experience.repository.js';
import { PrismaService } from '../../../../database/prisma.service.js';
import type { TrustedRuntimePrincipal } from '../../../process-orchestration/application/runtime-identity.port.js';
import type {
  RuntimeCursorPage,
  RuntimeMutationResult,
} from '../../../process-orchestration/application/runtime-mutation-result.js';
import {
  databaseErrorText,
  isDatabaseConflict,
  isDatabaseRejection,
  runtimeHash,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';

@Injectable()
export class PrismaMemoryExperienceRepository extends MemoryExperienceRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async currentTime(principal: TrustedRuntimePrincipal): Promise<Date> {
    return withMemoryTenant(this.prisma, principal, 'enterprise_agent_app', null, databaseNow);
  }

  async listMemories(
    principal: TrustedRuntimePrincipal,
    query: MemoryListQuery,
  ): Promise<RuntimeCursorPage<MemoryRecord>> {
    return withMemoryTenant(
      this.prisma,
      principal,
      'enterprise_agent_app',
      query.purpose ?? null,
      async (transaction) => {
        const conditions: Prisma.Sql[] = [
          Prisma.sql`memory."tenant_id" = ${principal.tenantId}::uuid`,
          Prisma.sql`memory."status" IN ('ACTIVE', 'SEALED')`,
        ];
        if (query.cursor !== undefined) {
          conditions.push(Prisma.sql`memory."id" < ${query.cursor}::uuid`);
        }
        if (query.scope !== undefined) {
          conditions.push(Prisma.sql`memory."scope" = ${query.scope}::public."MemoryScope"`);
        }
        if (query.status !== undefined) {
          conditions.push(Prisma.sql`memory."status" = ${query.status}::public."MemoryStatus"`);
        }
        const rows = await transaction.$queryRaw<MemoryRow[]>(Prisma.sql`
          ${memorySelect()}
          WHERE ${Prisma.join(conditions, ' AND ')}
          ORDER BY memory."id" DESC
          LIMIT ${query.limit + 1}
        `);
        return memoryPage(rows, query.limit);
      },
    );
  }

  async findMemory(
    principal: TrustedRuntimePrincipal,
    memoryId: string,
    purpose: string | null,
    operation: 'READ' | 'TRANSITION',
  ): Promise<MemoryRecord | null> {
    return withMemoryTenant(
      this.prisma,
      principal,
      'enterprise_agent_app',
      operation === 'TRANSITION' ? '__MEMORY_MANAGE__' : purpose,
      async (transaction) => {
        const rows = await transaction.$queryRaw<MemoryRow[]>(Prisma.sql`
          ${memorySelect()}
          WHERE memory."tenant_id" = ${principal.tenantId}::uuid
            AND memory."id" = ${memoryId}::uuid
            AND (
              ${operation} = 'TRANSITION'
              OR memory."status" IN ('ACTIVE', 'SEALED')
            )
          LIMIT 1
        `);
        return rows[0] === undefined ? null : mapMemoryRow(rows[0]);
      },
    );
  }

  async createMemory(input: CreateMemoryInput): Promise<RuntimeMutationResult<MemoryRecord>> {
    try {
      return await withMemoryTenant(
        this.prisma,
        input.principal,
        'enterprise_agent_app',
        input.request.consentPurpose ?? null,
        async (transaction) => {
          const now = await databaseNow(transaction);
          const requestHash = runtimeHash(input.request);
          const replay = await findMemoryByIdempotency(
            transaction,
            input.principal.tenantId,
            input.request.idempotencyKey,
          );
          if (replay !== null) {
            return replay.request_hash === requestHash
              ? { kind: 'IDEMPOTENT_REPLAY', value: mapMemoryRow(replay) }
              : { kind: 'IDEMPOTENCY_CONFLICT' };
          }
          const memoryId = randomUUID();
          const privateMemory = input.request.scope === 'EMPLOYEE_PRIVATE';
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."memory_records" (
              "id", "tenant_id", "scope", "status", "version", "revision",
              "title", "summary", "content_hash", "source_type", "source_id",
              "source_version", "source_evidence_count",
              "owner_user_id", "role_template_id", "role_version_id",
              "role_assignment_id", "task_id", "conversation_id", "permission_labels",
              "sensitivity", "consent_required", "consent_granted_by_user_id",
              "consent_granted_at", "consent_purpose", "effective_from", "effective_to",
              "expires_at", "retention_action", "created_by_user_id",
              "idempotency_key", "request_hash", "created_at", "updated_at"
            ) VALUES (
              ${memoryId}::uuid,
              ${input.principal.tenantId}::uuid,
              ${input.request.scope}::public."MemoryScope",
              'CANDIDATE',
              1,
              1,
              ${input.request.title},
              ${input.request.summary},
              ${input.request.contentHash},
              ${input.request.sourceType}::public."MemorySourceType",
              ${input.request.sourceId}::uuid,
              ${input.request.sourceVersion},
              ${input.request.sourceEvidenceIds.length},
              ${privateMemory ? input.principal.userId : null}::uuid,
              ${input.request.roleTemplateId ?? null}::uuid,
              ${input.request.roleVersionId ?? null}::uuid,
              ${input.request.roleAssignmentId ?? null}::uuid,
              ${input.request.taskId ?? null}::uuid,
              ${input.request.conversationId ?? null}::uuid,
              ${JSON.stringify(input.request.permissionLabels)}::jsonb,
              ${input.request.sensitivity}::public."MemorySensitivity",
              ${privateMemory},
              ${privateMemory ? input.principal.userId : null}::uuid,
              ${privateMemory ? now : null},
              ${input.request.consentPurpose ?? null},
              ${now},
              NULL,
              ${input.request.expiresAt === undefined ? null : new Date(input.request.expiresAt)},
              ${input.request.retentionAction}::public."MemoryRetentionAction",
              ${input.principal.userId}::uuid,
              ${input.request.idempotencyKey},
              ${requestHash},
              ${now},
              ${now}
            )
          `);
          for (const evidenceId of input.request.sourceEvidenceIds) {
            await transaction.$executeRaw(Prisma.sql`
              INSERT INTO public."memory_source_evidence" (
                "tenant_id", "memory_id", "evidence_id", "evidence_version", "created_at"
              )
              SELECT
                ${input.principal.tenantId}::uuid,
                ${memoryId}::uuid,
                evidence."id",
                evidence."version",
                ${now}
              FROM public."evidence" evidence
              WHERE evidence."tenant_id" = ${input.principal.tenantId}::uuid
                AND evidence."id" = ${evidenceId}::uuid
                AND evidence."status" = 'ACTIVE'
                AND evidence."trust_level" = 'VERIFIED'
                AND evidence."verified_at" IS NOT NULL
            `);
          }
          await appendAuditAndOutbox(transaction, input.principal, {
            action: 'memory.candidate.created',
            resourceType: 'MEMORY',
            resourceId: memoryId,
            eventType: 'MemoryCandidateCreated',
            payload: {
              memoryId,
              scope: input.request.scope,
              sourceType: input.request.sourceType,
            },
            occurredAt: now,
          });
          const created = await findMemoryById(transaction, input.principal.tenantId, memoryId);
          if (created === null) return rejected('Created Memory could not be read back.');
          return { kind: 'APPLIED', value: mapMemoryRow(created) };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async transitionMemory(
    input: TransitionMemoryInput,
  ): Promise<RuntimeMutationResult<MemoryRecord>> {
    try {
      return await withMemoryTenant(
        this.prisma,
        input.principal,
        'enterprise_agent_app',
        input.access.purpose,
        async (transaction) => {
          const requestHash = runtimeHash({
            memoryId: input.memoryId,
            ...input.request,
          });
          const commandRows = await transaction.$queryRaw<
            Array<{ request_hash: string; memory_id: string }>
          >(Prisma.sql`
            SELECT "request_hash", "memory_id"
            FROM public."memory_commands"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "idempotency_key" = ${input.request.idempotencyKey}
            LIMIT 1
          `);
          const replay = commandRows[0];
          if (replay !== undefined) {
            if (replay.request_hash !== requestHash || replay.memory_id !== input.memoryId) {
              return { kind: 'IDEMPOTENCY_CONFLICT' };
            }
            const current = await findMemoryById(
              transaction,
              input.principal.tenantId,
              input.memoryId,
            );
            return current === null
              ? { kind: 'NOT_FOUND' }
              : { kind: 'IDEMPOTENT_REPLAY', value: mapMemoryRow(current) };
          }
          const current = await findMemoryById(
            transaction,
            input.principal.tenantId,
            input.memoryId,
          );
          if (current === null) return { kind: 'NOT_FOUND' };
          if (current.revision !== input.request.expectedRevision) {
            return { kind: 'STALE_REVISION', currentRevision: current.revision };
          }
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."memory_commands" (
              "id", "tenant_id", "memory_id", "revision", "expected_revision",
              "action", "target_status", "actor_user_id", "reason",
              "idempotency_key", "request_hash", "occurred_at"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${input.principal.tenantId}::uuid,
              ${input.memoryId}::uuid,
              ${input.request.expectedRevision + 1},
              ${input.request.expectedRevision},
              ${input.request.action}::public."MemoryTransitionAction",
              ${input.nextStatus}::public."MemoryStatus",
              ${input.principal.userId}::uuid,
              ${input.request.reason},
              ${input.request.idempotencyKey},
              ${requestHash},
              ${input.now}
            )
          `);
          await appendAuditAndOutbox(transaction, input.principal, {
            action: `memory.${input.request.action.toLowerCase()}`,
            resourceType: 'MEMORY',
            resourceId: input.memoryId,
            eventType: `Memory${titleCase(input.request.action)}`,
            payload: {
              memoryId: input.memoryId,
              status: input.nextStatus,
              revision: input.request.expectedRevision + 1,
            },
            occurredAt: input.now,
          });
          const updated = await findMemoryById(
            transaction,
            input.principal.tenantId,
            input.memoryId,
          );
          if (updated === null) return rejected('Transitioned Memory could not be read back.');
          return { kind: 'APPLIED', value: mapMemoryRow(updated) };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async listExperiences(
    principal: TrustedRuntimePrincipal,
    query: ExperienceListQuery,
  ): Promise<RuntimeCursorPage<ExperienceCandidate>> {
    return withMemoryTenant(
      this.prisma,
      principal,
      'enterprise_agent_admin',
      null,
      async (transaction) => {
        const conditions: Prisma.Sql[] = [
          Prisma.sql`candidate."tenant_id" = ${principal.tenantId}::uuid`,
        ];
        if (query.cursor !== undefined) {
          conditions.push(Prisma.sql`candidate."id" < ${query.cursor}::uuid`);
        }
        if (query.status !== undefined) {
          conditions.push(
            Prisma.sql`candidate."status" = ${query.status}::public."ExperienceStatus"`,
          );
        }
        const rows = await transaction.$queryRaw<ExperienceRow[]>(Prisma.sql`
          ${experienceSelect()}
          WHERE ${Prisma.join(conditions, ' AND ')}
          ORDER BY candidate."id" DESC
          LIMIT ${query.limit + 1}
        `);
        return experiencePage(rows, query.limit);
      },
    );
  }

  async listExperiencesByContributor(
    principal: TrustedRuntimePrincipal,
    query: ExperienceListQuery,
  ): Promise<RuntimeCursorPage<ExperienceCandidate>> {
    return withMemoryTenant(
      this.prisma,
      principal,
      'enterprise_agent_employee_insights',
      null,
      async (transaction) => {
        const conditions: Prisma.Sql[] = [
          Prisma.sql`candidate."tenant_id" = ${principal.tenantId}::uuid`,
          Prisma.sql`candidate."contributor_user_id" = ${principal.userId}::uuid`,
        ];
        if (query.cursor !== undefined) {
          conditions.push(Prisma.sql`candidate."id" < ${query.cursor}::uuid`);
        }
        if (query.status !== undefined) {
          conditions.push(
            Prisma.sql`candidate."status" = ${query.status}::public."ExperienceStatus"`,
          );
        }
        const rows = await transaction.$queryRaw<ExperienceRow[]>(Prisma.sql`
          ${experienceSelect()}
          WHERE ${Prisma.join(conditions, ' AND ')}
          ORDER BY candidate."id" DESC
          LIMIT ${query.limit + 1}
        `);
        return experiencePage(rows, query.limit);
      },
    );
  }

  async findExperience(
    principal: TrustedRuntimePrincipal,
    experienceId: string,
  ): Promise<ExperienceCandidate | null> {
    return withMemoryTenant(
      this.prisma,
      principal,
      'enterprise_agent_admin',
      null,
      async (transaction) => {
        const row = await findExperienceById(transaction, principal.tenantId, experienceId);
        return row === null ? null : mapExperienceRow(row);
      },
    );
  }

  async createExperience(
    input: CreateExperienceInput,
  ): Promise<RuntimeMutationResult<ExperienceCandidate>> {
    try {
      return await withMemoryTenant(
        this.prisma,
        input.principal,
        input.enforceContributorTaskScope
          ? 'enterprise_agent_employee_insights'
          : 'enterprise_agent_admin',
        null,
        async (transaction) => {
          const requestHash = runtimeHash(input.request);
          const existing = await findExperienceByIdempotency(
            transaction,
            input.principal.tenantId,
            input.request.idempotencyKey,
          );
          if (existing !== null) {
            return existing.request_hash === requestHash
              ? { kind: 'IDEMPOTENT_REPLAY', value: mapExperienceRow(existing) }
              : { kind: 'IDEMPOTENCY_CONFLICT' };
          }
          if (input.enforceContributorTaskScope) {
            const validSources = await employeeExperienceSourcesValid(transaction, input);
            if (!validSources) {
              return rejected(
                'Experience sources must be active, verified and bound to a Task the contributor may access.',
              );
            }
          }
          const experienceId = randomUUID();
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."experience_candidates" (
              "id", "tenant_id", "status", "revision", "title",
              "contributor_user_id", "contributor_role_assignment_id",
              "source_task_id", "source_deliverable_count", "source_evidence_count",
              "raw_input_hash", "candidate_summary",
              "permission_labels", "sensitivity", "idempotency_key",
              "request_hash", "created_at", "updated_at"
            ) VALUES (
              ${experienceId}::uuid,
              ${input.principal.tenantId}::uuid,
              'CANDIDATE',
              1,
              ${input.request.title},
              ${input.actor.userId}::uuid,
              ${input.actor.roleAssignmentId}::uuid,
              ${input.request.sourceTaskId}::uuid,
              ${input.request.sourceDeliverableIds.length},
              ${input.request.sourceEvidenceIds.length},
              ${input.request.rawInputHash},
              ${input.request.candidateSummary},
              ${JSON.stringify(input.request.permissionLabels)}::jsonb,
              ${input.request.sensitivity}::public."MemorySensitivity",
              ${input.request.idempotencyKey},
              ${requestHash},
              ${input.now},
              ${input.now}
            )
          `);
          for (const deliverableId of input.request.sourceDeliverableIds) {
            await transaction.$executeRaw(Prisma.sql`
              INSERT INTO public."experience_source_deliverables" (
                "tenant_id", "experience_id", "deliverable_id",
                "deliverable_version", "created_at"
              )
              SELECT
                ${input.principal.tenantId}::uuid,
                ${experienceId}::uuid,
                deliverable."id",
                deliverable."version",
                ${input.now}
              FROM public."deliverables" deliverable
              WHERE deliverable."tenant_id" = ${input.principal.tenantId}::uuid
                AND deliverable."id" = ${deliverableId}::uuid
                AND deliverable."task_id" = ${input.request.sourceTaskId}::uuid
                AND deliverable."status" IN ('SUBMITTED', 'ACCEPTED')
                AND deliverable."evidence_sealed_at" IS NOT NULL
            `);
          }
          for (const evidenceId of input.request.sourceEvidenceIds) {
            await transaction.$executeRaw(Prisma.sql`
              INSERT INTO public."experience_source_evidence" (
                "tenant_id", "experience_id", "evidence_id",
                "evidence_version", "created_at"
              )
              SELECT
                ${input.principal.tenantId}::uuid,
                ${experienceId}::uuid,
                evidence."id",
                evidence."version",
                ${input.now}
              FROM public."evidence" evidence
              WHERE evidence."tenant_id" = ${input.principal.tenantId}::uuid
                AND evidence."id" = ${evidenceId}::uuid
                AND evidence."status" = 'ACTIVE'
                AND evidence."trust_level" = 'VERIFIED'
                AND evidence."verified_at" IS NOT NULL
            `);
          }
          await appendAuditAndOutbox(transaction, input.principal, {
            action: 'experience.candidate.created',
            resourceType: 'EXPERIENCE',
            resourceId: experienceId,
            eventType: 'ExperienceCandidateCreated',
            payload: {
              experienceId,
              sourceTaskId: input.request.sourceTaskId,
            },
            occurredAt: input.now,
          });
          const created = await findExperienceById(
            transaction,
            input.principal.tenantId,
            experienceId,
          );
          if (created === null) return rejected('Created Experience could not be read back.');
          return { kind: 'APPLIED', value: mapExperienceRow(created) };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async transitionExperience(
    input: TransitionExperienceInput,
  ): Promise<RuntimeMutationResult<ExperienceCandidate>> {
    try {
      return await withMemoryTenant(
        this.prisma,
        input.principal,
        'enterprise_agent_admin',
        null,
        async (transaction) => {
          const requestHash = runtimeHash({
            experienceId: input.experienceId,
            ...input.request,
          });
          const commandRows = await transaction.$queryRaw<
            Array<{ request_hash: string; experience_id: string }>
          >(Prisma.sql`
            SELECT "request_hash", "experience_id"
            FROM public."experience_commands"
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "idempotency_key" = ${input.request.idempotencyKey}
            LIMIT 1
          `);
          const replay = commandRows[0];
          if (replay !== undefined) {
            if (
              replay.request_hash !== requestHash ||
              replay.experience_id !== input.experienceId
            ) {
              return { kind: 'IDEMPOTENCY_CONFLICT' };
            }
            const current = await findExperienceById(
              transaction,
              input.principal.tenantId,
              input.experienceId,
            );
            return current === null
              ? { kind: 'NOT_FOUND' }
              : { kind: 'IDEMPOTENT_REPLAY', value: mapExperienceRow(current) };
          }
          const current = await findExperienceById(
            transaction,
            input.principal.tenantId,
            input.experienceId,
          );
          if (current === null) return { kind: 'NOT_FOUND' };
          if (current.revision !== input.request.expectedRevision) {
            return { kind: 'STALE_REVISION', currentRevision: current.revision };
          }

          await persistExperienceEvidence(transaction, input);
          const enrichedPayload = enrichExperiencePayload(input);
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."experience_commands" (
              "id", "tenant_id", "experience_id", "revision", "expected_revision",
              "action", "target_status", "actor_user_id", "actor_role_assignment_id",
              "reason", "payload", "idempotency_key", "request_hash", "occurred_at"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${input.principal.tenantId}::uuid,
              ${input.experienceId}::uuid,
              ${input.request.expectedRevision + 1},
              ${input.request.expectedRevision},
              ${input.request.action}::public."ExperienceTransitionAction",
              ${input.nextStatus}::public."ExperienceStatus",
              ${input.actor.userId}::uuid,
              ${input.actor.roleAssignmentId}::uuid,
              ${input.request.reason},
              ${JSON.stringify(enrichedPayload)}::jsonb,
              ${input.request.idempotencyKey},
              ${requestHash},
              ${input.now}
            )
          `);
          await appendAuditAndOutbox(transaction, input.principal, {
            action: `experience.${input.request.action.toLowerCase()}`,
            resourceType: 'EXPERIENCE',
            resourceId: input.experienceId,
            eventType: `Experience${titleCase(input.request.action)}`,
            payload: {
              experienceId: input.experienceId,
              status: input.nextStatus,
              revision: input.request.expectedRevision + 1,
            },
            occurredAt: input.now,
          });
          const updated = await findExperienceById(
            transaction,
            input.principal.tenantId,
            input.experienceId,
          );
          if (updated === null) return rejected('Transitioned Experience could not be read back.');
          return { kind: 'APPLIED', value: mapExperienceRow(updated) };
        },
      );
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('Database clock did not return a timestamp.');
  return now;
}

async function withMemoryTenant<T>(
  prisma: PrismaService,
  principal: TrustedRuntimePrincipal,
  role: 'enterprise_agent_app' | 'enterprise_agent_admin' | 'enterprise_agent_employee_insights',
  purpose: string | null,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!prisma.enabled) {
    throw new Error('Prisma Memory and Experience access is disabled for the current adapter.');
  }
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`;
    await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
    await transaction.$queryRaw`SELECT set_config('app.memory_purpose', ${purpose ?? ''}, true)`;
    return operation(transaction);
  });
}

function memorySelect(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      memory.*,
      COALESCE(
        (
          SELECT jsonb_agg(link."evidence_id" ORDER BY link."evidence_id")
          FROM public."memory_source_evidence" link
          WHERE link."tenant_id" = memory."tenant_id"
            AND link."memory_id" = memory."id"
        ),
        '[]'::jsonb
      ) AS source_evidence_ids
    FROM public."memory_records" memory
  `;
}

function experienceSelect(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      candidate.*,
      COALESCE(
        (
          SELECT jsonb_agg(link."deliverable_id" ORDER BY link."deliverable_id")
          FROM public."experience_source_deliverables" link
          WHERE link."tenant_id" = candidate."tenant_id"
            AND link."experience_id" = candidate."id"
        ),
        '[]'::jsonb
      ) AS source_deliverable_ids,
      COALESCE(
        (
          SELECT jsonb_agg(link."evidence_id" ORDER BY link."evidence_id")
          FROM public."experience_source_evidence" link
          WHERE link."tenant_id" = candidate."tenant_id"
            AND link."experience_id" = candidate."id"
        ),
        '[]'::jsonb
      ) AS source_evidence_ids
    FROM public."experience_candidates" candidate
  `;
}

async function findMemoryById(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  memoryId: string,
): Promise<MemoryRow | null> {
  const rows = await transaction.$queryRaw<MemoryRow[]>(Prisma.sql`
    ${memorySelect()}
    WHERE memory."tenant_id" = ${tenantId}::uuid
      AND memory."id" = ${memoryId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function findMemoryByIdempotency(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<MemoryRow | null> {
  const rows = await transaction.$queryRaw<MemoryRow[]>(Prisma.sql`
    ${memorySelect()}
    WHERE memory."tenant_id" = ${tenantId}::uuid
      AND memory."idempotency_key" = ${idempotencyKey}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function findExperienceById(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  experienceId: string,
): Promise<ExperienceRow | null> {
  const rows = await transaction.$queryRaw<ExperienceRow[]>(Prisma.sql`
    ${experienceSelect()}
    WHERE candidate."tenant_id" = ${tenantId}::uuid
      AND candidate."id" = ${experienceId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function findExperienceByIdempotency(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<ExperienceRow | null> {
  const rows = await transaction.$queryRaw<ExperienceRow[]>(Prisma.sql`
    ${experienceSelect()}
    WHERE candidate."tenant_id" = ${tenantId}::uuid
      AND candidate."idempotency_key" = ${idempotencyKey}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function employeeExperienceSourcesValid(
  transaction: Prisma.TransactionClient,
  input: CreateExperienceInput,
): Promise<boolean> {
  const taskRows = await transaction.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
    SELECT public.employee_insights_task_authorized(
      ${input.principal.tenantId}::uuid,
      ${input.actor.userId}::uuid,
      ${input.request.sourceTaskId}::uuid,
      ${input.now}
    ) AS allowed
  `);
  if (taskRows[0]?.allowed !== true) return false;

  if (input.request.sourceDeliverableIds.length > 0) {
    const deliverableIds = Prisma.join(
      input.request.sourceDeliverableIds.map((id) => Prisma.sql`${id}::uuid`),
    );
    const deliverableRows = await transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS count
      FROM public."deliverables" deliverable
      WHERE deliverable."tenant_id" = ${input.principal.tenantId}::uuid
        AND deliverable."id" IN (${deliverableIds})
        AND deliverable."task_id" = ${input.request.sourceTaskId}::uuid
        AND deliverable."status" IN ('SUBMITTED', 'ACCEPTED')
        AND deliverable."evidence_sealed_at" IS NOT NULL
        AND public.employee_insights_deliverable_authorized(
          deliverable."tenant_id",
          ${input.actor.userId}::uuid,
          ${input.request.sourceTaskId}::uuid,
          deliverable."id",
          deliverable."version",
          ${input.now}
        )
    `);
    if (deliverableRows[0]?.count !== input.request.sourceDeliverableIds.length) return false;
  }

  const evidenceIds = Prisma.join(
    input.request.sourceEvidenceIds.map((id) => Prisma.sql`${id}::uuid`),
  );
  const evidenceRows = await transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count
    FROM public."evidence" evidence
    WHERE evidence."tenant_id" = ${input.principal.tenantId}::uuid
      AND evidence."id" IN (${evidenceIds})
      AND evidence."status" = 'ACTIVE'
      AND evidence."trust_level" = 'VERIFIED'
      AND evidence."verified_at" IS NOT NULL
      AND evidence."effective_from" <= ${input.now}
      AND (evidence."effective_to" IS NULL OR evidence."effective_to" > ${input.now})
      AND public.employee_insights_evidence_authorized(
        evidence."tenant_id",
        ${input.actor.userId}::uuid,
        ${input.request.sourceTaskId}::uuid,
        evidence."id",
        evidence."version",
        ${input.now}
      )
  `);
  return evidenceRows[0]?.count === input.request.sourceEvidenceIds.length;
}

async function persistExperienceEvidence(
  transaction: Prisma.TransactionClient,
  input: TransitionExperienceInput,
): Promise<void> {
  if (input.request.action === 'APPROVE' || input.request.action === 'REJECT') {
    const payload = experienceReviewPayloadSchema.parse(input.request.payload);
    for (const evidenceId of payload.evidenceIds) {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."experience_review_evidence" (
          "tenant_id", "experience_id", "command_revision",
          "evidence_id", "evidence_version", "created_at"
        )
        SELECT
          ${input.principal.tenantId}::uuid,
          ${input.experienceId}::uuid,
          ${input.request.expectedRevision + 1},
          evidence."id",
          evidence."version",
          ${input.now}
        FROM public."evidence" evidence
        WHERE evidence."tenant_id" = ${input.principal.tenantId}::uuid
          AND evidence."id" = ${evidenceId}::uuid
          AND evidence."status" = 'ACTIVE'
          AND evidence."trust_level" = 'VERIFIED'
          AND evidence."verified_at" IS NOT NULL
      `);
    }
  }
  if (input.request.action === 'VALIDATE') {
    const payload = experienceValidatePayloadSchema.parse(input.request.payload);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."experience_validations" (
        "id", "tenant_id", "experience_id", "command_revision",
        "validation_run_id", "dataset_version_id", "passed", "score", "threshold",
        "side_effects", "validated_by_user_id", "validated_by_role_assignment_id",
        "validated_at"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${input.principal.tenantId}::uuid,
        ${input.experienceId}::uuid,
        ${input.request.expectedRevision + 1},
        ${payload.validationRunId}::uuid,
        ${payload.datasetVersionId}::uuid,
        true,
        ${payload.score},
        ${payload.threshold},
        ${JSON.stringify(payload.sideEffects)}::jsonb,
        ${input.actor.userId}::uuid,
        ${input.actor.roleAssignmentId}::uuid,
        ${input.now}
      )
    `);
  }
  if (input.request.action === 'PUBLISH') {
    const payload = experiencePublishPayloadSchema.parse(input.request.payload);
    const publicationId = randomUUID();
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."experience_publications" (
        "id", "tenant_id", "experience_id", "command_revision",
        "knowledge_base_id", "document_id", "document_version_id",
        "document_version", "publication_hash", "published_by_user_id",
        "published_by_role_assignment_id", "published_at"
      ) VALUES (
        ${publicationId}::uuid,
        ${input.principal.tenantId}::uuid,
        ${input.experienceId}::uuid,
        ${input.request.expectedRevision + 1},
        ${payload.knowledgeBaseId}::uuid,
        ${payload.documentId}::uuid,
        ${payload.documentVersionId}::uuid,
        ${payload.documentVersion},
        ${payload.publicationHash},
        ${input.actor.userId}::uuid,
        ${input.actor.roleAssignmentId}::uuid,
        ${input.now}
      )
    `);
    for (const roleTemplateId of payload.targetRoleTemplateIds) {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."experience_publication_role_targets" (
          "tenant_id", "publication_id", "role_template_id", "created_at"
        ) VALUES (
          ${input.principal.tenantId}::uuid,
          ${publicationId}::uuid,
          ${roleTemplateId}::uuid,
          ${input.now}
        )
      `);
    }
    for (const orgUnitId of payload.targetOrgUnitIds) {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."experience_publication_org_targets" (
          "tenant_id", "publication_id", "org_unit_id", "created_at"
        ) VALUES (
          ${input.principal.tenantId}::uuid,
          ${publicationId}::uuid,
          ${orgUnitId}::uuid,
          ${input.now}
        )
      `);
    }
  }
}

export function enrichExperiencePayload(input: TransitionExperienceInput): Record<string, unknown> {
  const payload = { ...input.request.payload };
  if (input.request.action === 'SANITIZE') {
    return { ...payload, sanitizedByUserId: input.actor.userId, sanitizedAt: input.now };
  }
  if (input.request.action === 'APPROVE' || input.request.action === 'REJECT') {
    return {
      ...payload,
      reviewerUserId: input.actor.userId,
      reviewerRoleAssignmentId: input.actor.roleAssignmentId,
      decision: input.request.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reason: input.request.reason,
      decidedAt: input.now,
    };
  }
  if (input.request.action === 'VALIDATE') {
    return { ...payload, validatedByUserId: input.actor.userId, validatedAt: input.now };
  }
  if (input.request.action === 'PUBLISH') {
    return { ...payload, publishedByUserId: input.actor.userId, publishedAt: input.now };
  }
  return payload;
}

async function appendAuditAndOutbox(
  transaction: Prisma.TransactionClient,
  principal: TrustedRuntimePrincipal,
  input: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."audit_events" (
      "id", "tenant_id", "actor_type", "actor_id", "action",
      "resource_type", "resource_id", "metadata", "occurred_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${principal.tenantId}::uuid,
      'USER',
      ${principal.userId}::uuid,
      ${input.action},
      ${input.resourceType},
      ${input.resourceId}::uuid,
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.occurredAt}
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."outbox_events" (
      "id", "tenant_id", "aggregate_type", "aggregate_id",
      "event_type", "payload", "available_at", "created_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${principal.tenantId}::uuid,
      ${input.resourceType},
      ${input.resourceId}::uuid,
      ${input.eventType},
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.occurredAt},
      ${input.occurredAt}
    )
  `);
}

function memoryPage(rows: MemoryRow[], limit: number): RuntimeCursorPage<MemoryRecord> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: visible.map(mapMemoryRow),
    nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
  };
}

function experiencePage(
  rows: ExperienceRow[],
  limit: number,
): RuntimeCursorPage<ExperienceCandidate> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: visible.map(mapExperienceRow),
    nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
  };
}

function mapMemoryRow(row: MemoryRow): MemoryRecord {
  return memoryRecordSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    status: row.status,
    version: row.version,
    revision: row.revision,
    title: row.title,
    summary: row.summary,
    contentHash: row.content_hash,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sourceEvidenceIds: row.source_evidence_ids,
    ownerUserId: row.owner_user_id,
    roleTemplateId: row.role_template_id,
    roleVersionId: row.role_version_id,
    roleAssignmentId: row.role_assignment_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    permissionLabels: row.permission_labels,
    sensitivity: row.sensitivity,
    consent: {
      required: row.consent_required,
      grantedByUserId: row.consent_granted_by_user_id,
      grantedAt: iso(row.consent_granted_at),
      purpose: row.consent_purpose,
    },
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: iso(row.effective_to),
    expiresAt: iso(row.expires_at),
    retentionAction: row.retention_action,
    sealedAt: iso(row.sealed_at),
    deletedAt: iso(row.deleted_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapExperienceRow(row: ExperienceRow): ExperienceCandidate {
  return experienceCandidateSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    revision: row.revision,
    title: row.title,
    contributorUserId: row.contributor_user_id,
    contributorRoleAssignmentId: row.contributor_role_assignment_id,
    sourceTaskId: row.source_task_id,
    sourceDeliverableIds: row.source_deliverable_ids,
    sourceEvidenceIds: row.source_evidence_ids,
    rawInputHash: row.raw_input_hash,
    candidateSummary: row.candidate_summary,
    sanitization: row.sanitization,
    structuredContent: row.structured_content,
    structuredHash: row.structured_hash,
    review: row.review,
    validation: row.validation,
    publication: row.publication,
    permissionLabels: row.permission_labels,
    sensitivity: row.sensitivity,
    monitoredUseCount: row.monitored_use_count,
    monitoredAdoptionCount: row.monitored_adoption_count,
    monitoredComplaintCount: row.monitored_complaint_count,
    expiresAt: iso(row.expires_at),
    retiredAt: iso(row.retired_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapDatabaseError<T>(error: unknown): RuntimeMutationResult<T> {
  if (isDatabaseConflict(error)) return { kind: 'IDEMPOTENCY_CONFLICT' };
  if (isDatabaseRejection(error)) return rejected(databaseErrorText(error).slice(0, 2_000));
  throw error;
}

function rejected<T>(detail: string): RuntimeMutationResult<T> {
  return { kind: 'REJECTED', reason: 'INVARIANT_VIOLATION', detail };
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function titleCase(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/(^|_)([a-z])/gu, (_match, _prefix: string, letter: string) =>
      letter.toLocaleUpperCase('en-US'),
    );
}

interface MemoryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly scope: MemoryRecord['scope'];
  readonly status: MemoryRecord['status'];
  readonly version: number;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly content_hash: string;
  readonly source_type: MemoryRecord['sourceType'];
  readonly source_id: string;
  readonly source_version: number;
  readonly source_evidence_ids: unknown;
  readonly owner_user_id: string | null;
  readonly role_template_id: string | null;
  readonly role_version_id: string | null;
  readonly role_assignment_id: string | null;
  readonly task_id: string | null;
  readonly conversation_id: string | null;
  readonly permission_labels: unknown;
  readonly sensitivity: MemoryRecord['sensitivity'];
  readonly consent_required: boolean;
  readonly consent_granted_by_user_id: string | null;
  readonly consent_granted_at: Date | null;
  readonly consent_purpose: string | null;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly expires_at: Date | null;
  readonly retention_action: MemoryRecord['retentionAction'];
  readonly sealed_at: Date | null;
  readonly deleted_at: Date | null;
  readonly created_by_user_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ExperienceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: ExperienceCandidate['status'];
  readonly revision: number;
  readonly title: string;
  readonly contributor_user_id: string;
  readonly contributor_role_assignment_id: string;
  readonly source_task_id: string;
  readonly source_deliverable_ids: unknown;
  readonly source_evidence_ids: unknown;
  readonly raw_input_hash: string;
  readonly candidate_summary: string;
  readonly sanitization: unknown | null;
  readonly structured_content: unknown | null;
  readonly structured_hash: string | null;
  readonly review: unknown | null;
  readonly validation: unknown | null;
  readonly publication: unknown | null;
  readonly permission_labels: unknown;
  readonly sensitivity: ExperienceCandidate['sensitivity'];
  readonly monitored_use_count: number;
  readonly monitored_adoption_count: number;
  readonly monitored_complaint_count: number;
  readonly expires_at: Date | null;
  readonly retired_at: Date | null;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}
