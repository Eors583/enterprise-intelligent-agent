import { createHash, randomUUID } from 'node:crypto';

import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  experienceKnowledgeProjectionSchema,
  type ExperienceCandidate,
  type ExperienceKnowledgeProjection,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import type { PrepareExperienceKnowledgeProjectionInput } from '../../experience-knowledge-projection.port.js';
import { ExperienceKnowledgeProjectionPort } from '../../experience-knowledge-projection.port.js';
import { AdminPrismaService } from '../../../../database/admin-prisma.service.js';
import type { AdminPrincipal } from '../../../admin/admin-access.service.js';
import { recordAdminAudit } from '../../../admin/admin-audit.js';
import {
  KnowledgeGateway,
  type KnowledgeDocumentMaterialization,
} from '../../../knowledge-gateway/knowledge-gateway.port.js';
import { runtimeHash } from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';

const PREPARATION_LEASE_MS = 5 * 60_000;

@Injectable()
export class PrismaExperienceKnowledgeProjectionAdapter extends ExperienceKnowledgeProjectionPort {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(KnowledgeGateway) private readonly knowledge: KnowledgeGateway,
  ) {
    super();
  }

  async prepare(
    input: PrepareExperienceKnowledgeProjectionInput,
  ): Promise<ExperienceKnowledgeProjection> {
    if (input.candidate.status !== 'VALIDATED') {
      throw new ConflictException(
        'Only a validated Experience Candidate can prepare a Knowledge projection.',
      );
    }
    if (input.candidate.revision !== input.request.expectedRevision) {
      throw new ConflictException('Experience Candidate revision is stale.');
    }
    const documentTitle = projectionDocumentTitle(input);
    const content = renderExperienceKnowledge(input.candidate, documentTitle);
    const publicationHash = sha256(content);
    const leaseToken = randomUUID();
    const projectionId = randomUUID();
    const requestHash = runtimeHash({
      experienceId: input.candidate.id,
      expectedRevision: input.request.expectedRevision,
      knowledgeBaseId: input.request.knowledgeBaseId,
      targetRoleTemplateIds: sortedUnique(input.request.targetRoleTemplateIds),
      targetOrgUnitIds: sortedUnique(input.request.targetOrgUnitIds),
      title: documentTitle,
      publicationHash,
    });
    await this.knowledge.requireActiveKnowledgeBase({
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      knowledgeBaseId: input.request.knowledgeBaseId,
    });
    let ownsLease = false;
    const reserved = await this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${input.principal.userId}, true)`;
      const leaseExpiresAt = new Date(input.now.getTime() + PREPARATION_LEASE_MS);
      const inserted = await transaction.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
        INSERT INTO public."experience_knowledge_projections" (
          "id", "tenant_id", "experience_id", "expected_experience_revision",
          "knowledge_base_id", "target_role_template_ids", "target_org_unit_ids",
          "publication_hash", "status", "idempotency_key", "request_hash",
          "lease_token", "lease_expires_at", "created_by_user_id", "created_at", "updated_at"
        ) VALUES (
          ${projectionId}::uuid,
          ${input.principal.tenantId}::uuid,
          ${input.candidate.id}::uuid,
          ${input.request.expectedRevision},
          ${input.request.knowledgeBaseId}::uuid,
          ${sortedUnique(input.request.targetRoleTemplateIds)}::uuid[],
          ${sortedUnique(input.request.targetOrgUnitIds)}::uuid[],
          ${publicationHash},
          'CREATING',
          ${input.request.idempotencyKey},
          ${requestHash},
          ${leaseToken}::uuid,
          ${leaseExpiresAt},
          ${input.principal.userId}::uuid,
          ${input.now},
          ${input.now}
        )
        ON CONFLICT DO NOTHING
        RETURNING "id"
      `);
      let row = await findProjectionRow(transaction, input.principal.tenantId, input.candidate.id);
      if (row === null || row.request_hash !== requestHash) {
        throw new ConflictException(
          'This Experience already has a different Knowledge projection request.',
        );
      }
      if (inserted.length === 1) {
        await recordProjectionEvent(
          transaction,
          input.principal.tenantId,
          input.principal.userId,
          row.id,
          'admin.experience-knowledge-projection.prepare',
          'experience.knowledge-projection.preparation-requested.v1',
          {
            experienceId: input.candidate.id,
            expectedExperienceRevision: input.request.expectedRevision,
            knowledgeBaseId: input.request.knowledgeBaseId,
            targetRoleTemplateIds: sortedUnique(input.request.targetRoleTemplateIds),
            targetOrgUnitIds: sortedUnique(input.request.targetOrgUnitIds),
            publicationHash,
            requestHash,
          },
        );
      }
      ownsLease = inserted.length === 1 && row.lease_token === leaseToken;
      if (
        !ownsLease &&
        (row.status === 'FAILED' ||
          (row.status === 'CREATING' &&
            (row.lease_expires_at === null ||
              row.lease_expires_at.getTime() <= input.now.getTime())))
      ) {
        const reclaimed = await transaction.$executeRaw(Prisma.sql`
          UPDATE public."experience_knowledge_projections"
          SET "status" = 'CREATING',
              "lease_token" = ${leaseToken}::uuid,
              "lease_expires_at" = ${leaseExpiresAt},
              "error_code" = NULL,
              "updated_at" = ${input.now}
          WHERE "tenant_id" = ${input.principal.tenantId}::uuid
            AND "id" = ${row.id}::uuid
            AND (
              "status" = 'FAILED'
              OR (
                "status" = 'CREATING'
                AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${input.now})
              )
            )
        `);
        ownsLease = reclaimed === 1;
        row =
          (await findProjectionRow(transaction, input.principal.tenantId, input.candidate.id)) ??
          row;
      }
      return row;
    });

    if (!ownsLease || reserved.status !== 'CREATING') {
      return this.requireProjection(input.principal.tenantId, input.candidate.id);
    }

    try {
      await this.materialize(input, reserved, content, leaseToken);
    } catch (error) {
      await this.markFailed(
        input.principal.tenantId,
        input.principal.userId,
        reserved.id,
        leaseToken,
        projectionFailureCode(error),
      );
      throw new BadGatewayException(
        'The Experience Knowledge projection could not be prepared. Retry after the ingestion dependency recovers.',
      );
    }
    return this.requireProjection(input.principal.tenantId, input.candidate.id);
  }

  async find(
    principal: PrepareExperienceKnowledgeProjectionInput['principal'],
    experienceId: string,
  ): Promise<ExperienceKnowledgeProjection | null> {
    return this.refresh(principal.tenantId, principal.userId, experienceId);
  }

  private async materialize(
    input: PrepareExperienceKnowledgeProjectionInput,
    projection: ProjectionRow,
    content: string,
    leaseToken: string,
  ): Promise<void> {
    const marker = projectionMarker(projection.id);
    const recovered = await this.findMaterializedVersion(
      input.principal.tenantId,
      input.principal.userId,
      marker,
    );
    const identity = recovered ?? (await this.createKnowledgeVersion(input, content, marker));
    await this.prisma.withTenant(input.principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${input.principal.userId}, true)`;
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."experience_knowledge_projections"
        SET "document_id" = ${identity.documentId}::uuid,
            "document_version_id" = ${identity.documentVersionId}::uuid,
            "document_version" = ${identity.documentVersion},
            "status" = 'PROCESSING',
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "error_code" = NULL,
            "updated_at" = statement_timestamp()
        WHERE "tenant_id" = ${input.principal.tenantId}::uuid
          AND "id" = ${projection.id}::uuid
          AND "status" = 'CREATING'
          AND "lease_token" = ${leaseToken}::uuid
      `);
      if (updated !== 1) {
        throw new ConflictException('The Experience projection preparation lease was lost.');
      }
      await recordProjectionEvent(
        transaction,
        input.principal.tenantId,
        input.principal.userId,
        projection.id,
        'admin.experience-knowledge-projection.materialize',
        'experience.knowledge-projection.materialized.v1',
        {
          experienceId: input.candidate.id,
          knowledgeBaseId: input.request.knowledgeBaseId,
          documentId: identity.documentId,
          documentVersionId: identity.documentVersionId,
          documentVersion: identity.documentVersion,
          publicationHash: projection.publication_hash.trim(),
        },
      );
    });
  }

  private async createKnowledgeVersion(
    input: PrepareExperienceKnowledgeProjectionInput,
    content: string,
    marker: string,
  ): Promise<MaterializedIdentity> {
    const principal: AdminPrincipal = {
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      role: input.principal.tenantRole,
      authenticationSource: input.principal.authenticationSource,
    };
    const documentId = await this.knowledge.createTextVersionAs({
      principal,
      document: {
        knowledgeBaseId: input.request.knowledgeBaseId,
        title: projectionDocumentTitle(input),
        sourceType: 'MARKDOWN',
        content,
        publish: true,
        changeSummary: marker,
        governance: {
          ownerUserId: input.candidate.contributorUserId,
          classification: knowledgeClassification(input.candidate.sensitivity),
          scopeMode: 'RESTRICTED',
          organizationScopeIds: sortedUnique(input.request.targetOrgUnitIds),
          projectScopeIds: [],
          taskScopeIds: [],
          roleTemplateScopeIds: sortedUnique(input.request.targetRoleTemplateIds),
          dataLabels: sortedUnique(input.candidate.permissionLabels),
          effectiveFrom: input.now.toISOString(),
          expiresAt: input.candidate.expiresAt,
          retentionUntil: input.candidate.expiresAt,
          retentionAction: 'ARCHIVE',
          supersedesVersionId: null,
        },
      },
    });
    const identity = await this.findMaterializedVersion(
      input.principal.tenantId,
      input.principal.userId,
      marker,
      documentId,
    );
    if (identity === null) {
      throw new Error('EXPERIENCE_KNOWLEDGE_VERSION_IDENTITY_MISSING');
    }
    return identity;
  }

  private findMaterializedVersion(
    tenantId: string,
    userId: string,
    marker: string,
    documentId?: string,
  ): Promise<MaterializedIdentity | null> {
    return this.knowledge.findDocumentVersionByChangeSummary({
      tenantId,
      userId,
      changeSummary: marker,
      ...(documentId === undefined ? {} : { documentId }),
    });
  }

  private async requireProjection(
    tenantId: string,
    experienceId: string,
  ): Promise<ExperienceKnowledgeProjection> {
    const projection = await this.refresh(tenantId, null, experienceId);
    if (projection === null) throw new NotFoundException('Experience projection was not found.');
    return projection;
  }

  private async refresh(
    tenantId: string,
    userId: string | null,
    experienceId: string,
  ): Promise<ExperienceKnowledgeProjection | null> {
    const baseRow = await this.prisma.withTenant(tenantId, async (transaction) => {
      if (userId !== null) {
        await transaction.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      }
      return findProjectionRow(transaction, tenantId, experienceId);
    });
    if (baseRow === null) return null;
    const materialization =
      baseRow.document_version_id === null
        ? null
        : await this.knowledge.readDocumentMaterialization({
            tenantId,
            userId: userId ?? baseRow.created_by_user_id,
            documentVersionId: baseRow.document_version_id,
          });
    const row = withMaterialization(baseRow, materialization);
    const next = effectiveProjectionState(row);
    if (next.status === row.status && next.errorCode === row.error_code) {
      return mapProjection(row);
    }
    return this.prisma.withTenant(tenantId, async (transaction) => {
      if (userId !== null) {
        await transaction.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      }
      if (next.status !== row.status || next.errorCode !== row.error_code) {
        const updated = await transaction.$executeRaw(Prisma.sql`
          UPDATE public."experience_knowledge_projections"
          SET "status" = ${next.status},
              "error_code" = ${next.errorCode},
              "lease_token" = NULL,
              "lease_expires_at" = NULL,
              "updated_at" = statement_timestamp()
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "id" = ${row.id}::uuid
        `);
        if (updated === 1) {
          await recordProjectionReconciliationEvent(transaction, row, next);
        }
        const refreshed = await findProjectionRow(transaction, tenantId, experienceId);
        return refreshed === null
          ? null
          : mapProjection(withMaterialization(refreshed, materialization));
      }
      return mapProjection(row);
    });
  }

  private markFailed(
    tenantId: string,
    userId: string,
    projectionId: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<unknown> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE public."experience_knowledge_projections"
        SET "status" = 'FAILED',
            "error_code" = ${errorCode},
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "updated_at" = statement_timestamp()
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${projectionId}::uuid
          AND "status" = 'CREATING'
          AND "lease_token" = ${leaseToken}::uuid
      `);
      if (updated === 1) {
        await recordProjectionEvent(
          transaction,
          tenantId,
          userId,
          projectionId,
          'admin.experience-knowledge-projection.fail',
          'experience.knowledge-projection.failed.v1',
          { errorCode },
        );
      }
      return updated;
    });
  }
}

export function renderExperienceKnowledge(
  candidate: ExperienceCandidate,
  documentTitle = `已验证经验 ${candidate.id.slice(0, 8)}`,
): string {
  const structured = candidate.structuredContent;
  if (structured === null) throw new ConflictException('Structured Experience content is missing.');
  const list = (title: string, values: readonly string[]): string =>
    values.length === 0
      ? ''
      : `\n## ${title}\n\n${values.map((value, index) => `${index + 1}. ${value}`).join('\n')}\n`;
  return [
    `# ${documentTitle}`,
    '',
    `> 经验候选：${candidate.id}`,
    `> 来源任务：${candidate.sourceTaskId}`,
    `> 贡献者：${candidate.contributorUserId}`,
    '',
    '## 场景',
    '',
    structured.scenario,
    '',
    '## 问题',
    '',
    structured.problem,
    list('步骤', structured.steps),
    list('前提条件', structured.preconditions),
    list('反例', structured.counterexamples),
    list('风险', structured.risks),
    list('效果', structured.outcomes),
    list('适用边界', structured.applicabilityBoundaries),
    '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .trim();
}

function effectiveProjectionState(row: ProjectionRow): {
  readonly status: ProjectionRow['status'];
  readonly errorCode: string | null;
} {
  if (
    row.candidate_status === 'RETIRED' ||
    row.document_status === 'ARCHIVED' ||
    row.version_status === 'ARCHIVED'
  ) {
    return { status: 'RETIRED', errorCode: null };
  }
  if (row.status === 'FAILED') {
    return { status: 'FAILED', errorCode: row.error_code };
  }
  if (
    row.published_at !== null &&
    row.document_current_version_id === row.document_version_id &&
    row.document_status === 'READY' &&
    row.version_status === 'READY' &&
    row.chunk_count > 0 &&
    row.embedding_count === row.chunk_count
  ) {
    return { status: 'PUBLISHED', errorCode: null };
  }
  if (
    row.version_status === 'READY' &&
    row.chunk_count > 0 &&
    row.embedding_count === row.chunk_count
  ) {
    return { status: 'READY', errorCode: null };
  }
  if (row.ingestion_status === 'FAILED') {
    return {
      status: 'FAILED',
      errorCode: row.ingestion_error_code ?? 'EXPERIENCE_KNOWLEDGE_INGESTION_FAILED',
    };
  }
  if (
    row.ingestion_status === 'SUCCEEDED' &&
    (row.chunk_count === 0 || row.embedding_count !== row.chunk_count)
  ) {
    return { status: 'FAILED', errorCode: 'EXPERIENCE_EMBEDDING_REQUIRED' };
  }
  if (row.document_version_id !== null) return { status: 'PROCESSING', errorCode: null };
  return { status: row.status, errorCode: row.error_code };
}

async function findProjectionRow(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  experienceId: string,
): Promise<ProjectionRow | null> {
  const rows = await transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
    SELECT
      projection.*,
      candidate."status"::text AS candidate_status,
      NULL::text AS document_status,
      NULL::uuid AS document_current_version_id,
      NULL::text AS version_status,
      NULL::text AS governance_review_status,
      NULL::timestamptz AS published_at,
      NULL::text AS ingestion_status,
      NULL::text AS ingestion_error_code,
      0::int AS chunk_count,
      0::int AS embedding_count
    FROM public."experience_knowledge_projections" projection
    JOIN public."experience_candidates" candidate
      ON candidate."tenant_id" = projection."tenant_id"
     AND candidate."id" = projection."experience_id"
    WHERE projection."tenant_id" = ${tenantId}::uuid
      AND projection."experience_id" = ${experienceId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

function withMaterialization(
  row: ProjectionRow,
  materialization: KnowledgeDocumentMaterialization | null,
): ProjectionRow {
  if (materialization === null) return row;
  return {
    ...row,
    document_status: materialization.documentStatus,
    document_current_version_id: materialization.documentCurrentVersionId,
    version_status: materialization.versionStatus,
    governance_review_status: materialization.governanceReviewStatus,
    published_at: materialization.publishedAt,
    ingestion_status: materialization.ingestionStatus,
    ingestion_error_code: materialization.ingestionErrorCode,
    chunk_count: materialization.chunkCount,
    embedding_count: materialization.embeddingCount,
  };
}

function mapProjection(row: ProjectionRow): ExperienceKnowledgeProjection {
  return experienceKnowledgeProjectionSchema.parse({
    id: row.id,
    experienceId: row.experience_id,
    expectedExperienceRevision: row.expected_experience_revision,
    knowledgeBaseId: row.knowledge_base_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    documentVersion: row.document_version,
    targetRoleTemplateIds: row.target_role_template_ids,
    targetOrgUnitIds: row.target_org_unit_ids,
    publicationHash: row.publication_hash.trim(),
    status: row.status,
    ingestionStatus: row.ingestion_status,
    governanceReviewStatus: row.governance_review_status,
    publishedAt: row.published_at?.toISOString() ?? null,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function knowledgeClassification(
  sensitivity: ExperienceCandidate['sensitivity'],
): 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' {
  if (sensitivity === 'PUBLIC') return 'PUBLIC';
  if (sensitivity === 'INTERNAL') return 'INTERNAL';
  return 'CONFIDENTIAL';
}

function projectionMarker(projectionId: string): string {
  return `EXPERIENCE_KNOWLEDGE_PROJECTION:${projectionId}`;
}

function projectionDocumentTitle(input: PrepareExperienceKnowledgeProjectionInput): string {
  const requested = input.request.title?.trim();
  return requested === undefined || requested === ''
    ? `已验证经验 ${input.candidate.id.slice(0, 8)}`
    : requested;
}

function projectionFailureCode(error: unknown): string {
  if (error instanceof ConflictException) return 'EXPERIENCE_PROJECTION_CONFLICT';
  if (error instanceof NotFoundException) return 'EXPERIENCE_PROJECTION_TARGET_MISSING';
  return 'EXPERIENCE_PROJECTION_DEPENDENCY_FAILED';
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function recordProjectionEvent(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  projectionId: string,
  action: string,
  eventType: string,
  payload: Prisma.InputJsonObject,
): Promise<void> {
  await Promise.all([
    recordAdminAudit(
      transaction,
      { tenantId, userId },
      action,
      'experience_knowledge_projection',
      projectionId,
      payload,
    ),
    transaction.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: 'experience_knowledge_projection',
        aggregateId: projectionId,
        eventType,
        payload,
      },
    }),
  ]);
}

async function recordProjectionReconciliationEvent(
  transaction: Prisma.TransactionClient,
  row: ProjectionRow,
  next: ReturnType<typeof effectiveProjectionState>,
): Promise<void> {
  const payload = {
    experienceId: row.experience_id,
    knowledgeBaseId: row.knowledge_base_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    previousStatus: row.status,
    status: next.status,
    errorCode: next.errorCode,
  } satisfies Prisma.InputJsonObject;
  await Promise.all([
    transaction.auditEvent.create({
      data: {
        tenantId: row.tenant_id,
        actorType: 'SERVICE',
        actorId: row.created_by_user_id,
        action: 'system.experience-knowledge-projection.reconciled',
        resourceType: 'experience_knowledge_projection',
        resourceId: row.id,
        metadata: payload,
      },
    }),
    transaction.outboxEvent.create({
      data: {
        tenantId: row.tenant_id,
        aggregateType: 'experience_knowledge_projection',
        aggregateId: row.id,
        eventType: 'experience.knowledge-projection.status-changed.v1',
        payload,
      },
    }),
  ]);
}

interface MaterializedIdentity {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentVersion: number;
}

interface ProjectionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly experience_id: string;
  readonly expected_experience_revision: number;
  readonly knowledge_base_id: string;
  readonly document_id: string | null;
  readonly document_version_id: string | null;
  readonly document_version: number | null;
  readonly target_role_template_ids: string[];
  readonly target_org_unit_ids: string[];
  readonly publication_hash: string;
  readonly status: 'CREATING' | 'PROCESSING' | 'READY' | 'PUBLISHED' | 'FAILED' | 'RETIRED';
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly error_code: string | null;
  readonly created_by_user_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly candidate_status: string;
  readonly document_status: string | null;
  readonly document_current_version_id: string | null;
  readonly version_status: string | null;
  readonly governance_review_status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MIGRATED' | null;
  readonly published_at: Date | null;
  readonly ingestion_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
  readonly ingestion_error_code: string | null;
  readonly chunk_count: number;
  readonly embedding_count: number;
}
