import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const administrator = new PrismaClient();
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const makerId = randomUUID();
const reviewerId = randomUUID();
const roleTemplateId = randomUUID();
const otherRoleTemplateId = randomUUID();
const knowledgeBaseId = randomUUID();
const documentId = randomUUID();
const documentVersionId = randomUUID();
const parentChunkId = randomUUID();
const chunkId = randomUUID();
const embeddingIndexVersionId = randomUUID();
const experienceId = randomUUID();
const projectionId = randomUUID();

describe.runIf(enabled)('PostgreSQL Experience to Knowledge projection integration', () => {
  beforeAll(async () => {
    await administrator.tenant.createMany({
      data: [
        {
          id: tenantId,
          slug: `experience-projection-${tenantId.slice(0, 8)}`,
          name: 'Experience Projection Integration',
        },
        {
          id: otherTenantId,
          slug: `experience-projection-other-${otherTenantId.slice(0, 8)}`,
          name: 'Experience Projection Other Tenant',
        },
      ],
    });
    await administrator.user.createMany({
      data: [user(makerId, 'maker'), user(reviewerId, 'reviewer')],
    });
    await seedGovernedProjectionFixtures();
  });

  afterAll(async () => {
    await cleanupDisposableTenants(administrator, [tenantId, otherTenantId]);
    await administrator.$disconnect();
  });

  it('enforces exact Experience revision, actor identity, and target scope', async () => {
    await expect(
      asTenantAdmin(
        Prisma.sql`
          INSERT INTO public."experience_knowledge_projections" (
            "id", "tenant_id", "experience_id", "expected_experience_revision",
            "knowledge_base_id", "target_role_template_ids", "publication_hash",
            "status", "idempotency_key", "request_hash", "lease_token",
            "lease_expires_at", "created_by_user_id"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantId}::uuid, ${experienceId}::uuid, 4,
            ${knowledgeBaseId}::uuid, ARRAY[${roleTemplateId}::uuid],
            ${'a'.repeat(64)}, 'CREATING', ${`stale:${randomUUID()}`},
            ${'b'.repeat(64)}, ${randomUUID()}::uuid,
            statement_timestamp() + interval '5 minutes', ${makerId}::uuid
          )
        `,
      ),
    ).rejects.toThrow(/EXPERIENCE_PROJECTION_CREATION_NOT_AUTHORIZED/);

    await expect(
      asTenantAdmin(
        Prisma.sql`
          INSERT INTO public."experience_knowledge_projections" (
            "id", "tenant_id", "experience_id", "expected_experience_revision",
            "knowledge_base_id", "target_role_template_ids", "publication_hash",
            "status", "idempotency_key", "request_hash", "lease_token",
            "lease_expires_at", "created_by_user_id"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantId}::uuid, ${experienceId}::uuid, 5,
            ${knowledgeBaseId}::uuid, ARRAY[${randomUUID()}::uuid],
            ${'a'.repeat(64)}, 'CREATING', ${`invalid-target:${randomUUID()}`},
            ${'b'.repeat(64)}, ${randomUUID()}::uuid,
            statement_timestamp() + interval '5 minutes', ${makerId}::uuid
          )
        `,
      ),
    ).rejects.toThrow(/EXPERIENCE_PROJECTION_TARGET_SCOPE_INVALID/);

    await asTenantAdmin(Prisma.sql`
      INSERT INTO public."experience_knowledge_projections" (
        "id", "tenant_id", "experience_id", "expected_experience_revision",
        "knowledge_base_id", "target_role_template_ids", "publication_hash",
        "status", "idempotency_key", "request_hash", "lease_token",
        "lease_expires_at", "created_by_user_id"
      ) VALUES (
        ${projectionId}::uuid, ${tenantId}::uuid, ${experienceId}::uuid, 5,
        ${knowledgeBaseId}::uuid, ARRAY[${roleTemplateId}::uuid],
        ${'a'.repeat(64)}, 'CREATING', ${`valid:${projectionId}`},
        ${'b'.repeat(64)}, ${randomUUID()}::uuid,
        statement_timestamp() + interval '5 minutes', ${makerId}::uuid
      )
    `);
  });

  it('rejects a materialized Knowledge Version with a different governed audience', async () => {
    await expect(
      asTenantAdmin(Prisma.sql`
        UPDATE public."experience_knowledge_projections"
        SET "document_id" = ${documentId}::uuid,
            "document_version_id" = ${documentVersionId}::uuid,
            "document_version" = 1,
            "status" = 'PROCESSING',
            "lease_token" = NULL,
            "lease_expires_at" = NULL
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${projectionId}::uuid
      `),
    ).rejects.toThrow(/EXPERIENCE_PROJECTION_KNOWLEDGE_SCOPE_MISMATCH/);

    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."knowledge_document_versions"
        SET "role_template_scope_ids" = ARRAY[${roleTemplateId}::uuid]
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${documentVersionId}::uuid
      `);
    });

    await asTenantAdmin(Prisma.sql`
      UPDATE public."experience_knowledge_projections"
      SET "document_id" = ${documentId}::uuid,
          "document_version_id" = ${documentVersionId}::uuid,
          "document_version" = 1,
          "status" = 'PROCESSING',
          "lease_token" = NULL,
          "lease_expires_at" = NULL
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${projectionId}::uuid
    `);
  });

  it('requires non-empty complete embeddings before READY and exact publication before PUBLISHED', async () => {
    await expect(
      asTenantAdmin(Prisma.sql`
        UPDATE public."experience_knowledge_projections"
        SET "status" = 'READY'
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${projectionId}::uuid
      `),
    ).rejects.toThrow(/EXPERIENCE_PROJECTION_KNOWLEDGE_NOT_READY/);

    await administrator.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_chunk_embeddings" (
        "id", "tenant_id", "chunk_id", "embedding_index_version_id", "embedding_model",
        "embedding_dimension", "content_hash", "embedding"
      ) VALUES (
        ${randomUUID()}::uuid, ${tenantId}::uuid, ${chunkId}::uuid,
        ${embeddingIndexVersionId}::uuid,
        'experience-projection-integration', 1536, ${'c'.repeat(64)},
        array_fill(0::real, ARRAY[1536])::vector
      )
    `);
    await asTenantAdmin(Prisma.sql`
      UPDATE public."experience_knowledge_projections"
      SET "status" = 'READY'
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${projectionId}::uuid
    `);

    await expect(
      asTenantAdmin(Prisma.sql`
        UPDATE public."experience_knowledge_projections"
        SET "status" = 'PUBLISHED'
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${projectionId}::uuid
      `),
    ).rejects.toThrow(/EXPERIENCE_PROJECTION_KNOWLEDGE_NOT_PUBLISHED/);

    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."knowledge_document_versions"
        SET "published_at" = statement_timestamp(),
            "evaluation_run_id" = ${randomUUID()}::uuid,
            "evaluation_dataset_version_id" = ${randomUUID()}::uuid,
            "evaluation_snapshot_hash" = ${'9'.repeat(64)}
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${documentVersionId}::uuid
      `);
      await transaction.$executeRaw(Prisma.sql`
        UPDATE public."knowledge_documents"
        SET "status" = 'READY',
            "document_version" = 1,
            "current_version_id" = ${documentVersionId}::uuid
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "id" = ${documentId}::uuid
      `);
    });

    await asTenantAdmin(Prisma.sql`
      UPDATE public."experience_knowledge_projections"
      SET "status" = 'PUBLISHED'
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${projectionId}::uuid
    `);
    const rows = await readAsTenantAdmin<Array<{ status: string }>>(Prisma.sql`
      SELECT "status"
      FROM public."experience_knowledge_projections"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${projectionId}::uuid
    `);
    expect(rows).toEqual([{ status: 'PUBLISHED' }]);
  });

  it('keeps the projection invisible under a different tenant context', async () => {
    const rows = await readAsTenantAdmin<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"::text AS "id"
        FROM public."experience_knowledge_projections"
        WHERE "id" = ${projectionId}::uuid
      `,
      otherTenantId,
      null,
    );
    expect(rows).toEqual([]);
  });
});

async function seedGovernedProjectionFixtures(): Promise<void> {
  await administrator.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."agent_templates" (
        "id", "tenant_id", "key", "name", "updated_at"
      ) VALUES
        (
          ${roleTemplateId}::uuid, ${tenantId}::uuid,
          'experience-projection-role', 'Experience Projection Role',
          statement_timestamp()
        ),
        (
          ${otherRoleTemplateId}::uuid, ${tenantId}::uuid,
          'experience-projection-other-role', 'Other Projection Role',
          statement_timestamp()
        )
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_bases" (
        "id", "tenant_id", "key", "name", "status",
        "space_target_id", "space_target_name", "created_by_id"
      ) VALUES (
        ${knowledgeBaseId}::uuid, ${tenantId}::uuid,
        'experience-projection', 'Experience Projection', 'ACTIVE',
        ${tenantId}::uuid, 'Experience Projection Tenant',
        ${makerId}::uuid
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_embedding_index_versions" (
        "id", "tenant_id", "knowledge_base_id", "version", "status",
        "provider", "model", "dimensions", "created_by_id", "activated_at"
      ) VALUES (
        ${embeddingIndexVersionId}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        1, 'ACTIVE', 'local_fastembed', 'experience-projection-integration', 1536,
        ${makerId}::uuid, statement_timestamp()
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      UPDATE public."knowledge_bases"
      SET "active_embedding_index_version_id" = ${embeddingIndexVersionId}::uuid
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${knowledgeBaseId}::uuid
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_documents" (
        "id", "tenant_id", "knowledge_base_id", "title", "source_type",
        "status", "document_version", "created_by_id"
      ) VALUES (
        ${documentId}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        'Governed Experience Projection', 'MARKDOWN', 'READY', 1,
        ${makerId}::uuid
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_document_versions" (
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "version_number", "source_type", "status", "content_text",
        "checksum", "created_by_id", "governance_owner_user_id", "classification",
        "scope_mode", "role_template_scope_ids", "governance_review_status",
        "governance_reviewed_by_id", "governance_reviewed_at", "governance_hash"
      ) VALUES (
        ${documentVersionId}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        ${documentId}::uuid, 1, 'MARKDOWN', 'READY',
        '# Governed Experience Projection', ${'a'.repeat(64)},
        ${makerId}::uuid, ${makerId}::uuid,
        'INTERNAL', 'RESTRICTED', ARRAY[${otherRoleTemplateId}::uuid],
        'APPROVED', ${reviewerId}::uuid, statement_timestamp(), ${'d'.repeat(64)}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_parent_chunks" (
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "document_version_id", "parent_index", "content", "token_count",
        "content_hash"
      ) VALUES (
        ${parentChunkId}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        ${documentId}::uuid, ${documentVersionId}::uuid, 0,
        'A validated and governed Experience projection.', 8, ${'c'.repeat(64)}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_chunks" (
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "document_version_id", "parent_chunk_id", "chunk_index", "content",
        "token_count", "content_hash"
      ) VALUES (
        ${chunkId}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        ${documentId}::uuid, ${documentVersionId}::uuid, ${parentChunkId}::uuid, 0,
        'A validated and governed Experience projection.', 8, ${'c'.repeat(64)}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."experience_candidates" (
        "id", "tenant_id", "status", "revision", "title",
        "contributor_user_id", "contributor_role_assignment_id",
        "source_task_id", "source_deliverable_count", "source_evidence_count",
        "raw_input_hash", "candidate_summary", "structured_content",
        "structured_hash", "review", "validation", "permission_labels",
        "sensitivity", "idempotency_key", "request_hash"
      ) VALUES (
        ${experienceId}::uuid, ${tenantId}::uuid, 'VALIDATED', 5,
        'Validated Experience', ${makerId}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 1, 1, ${'e'.repeat(64)},
        'Sanitized fixture summary',
        ${{
          scenario: 'Enterprise pilot',
          problem: 'A repeatable delivery issue',
          steps: ['Collect evidence', 'Apply the governed response'],
          preconditions: ['Authorized role assignment'],
          counterexamples: [],
          risks: ['Stale source'],
          outcomes: ['Verified delivery'],
          applicabilityBoundaries: ['Same governed audience'],
        }},
        ${'f'.repeat(64)}, ${{ decision: 'APPROVED' }},
        ${{ result: 'PASSED' }}, '[]'::jsonb, 'INTERNAL',
        ${`experience-projection:${experienceId}`}, ${'1'.repeat(64)}
      )
    `);
  });
}

async function asTenantAdmin(
  statement: Prisma.Sql,
  contextTenantId = tenantId,
  contextUserId: string | null = makerId,
): Promise<void> {
  return administrator.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${contextTenantId}, true)`;
    if (contextUserId !== null) {
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${contextUserId}, true)`;
    }
    await transaction.$executeRaw(statement);
  });
}

async function readAsTenantAdmin<T>(
  statement: Prisma.Sql,
  contextTenantId = tenantId,
  contextUserId: string | null = makerId,
): Promise<T> {
  return administrator.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${contextTenantId}, true)`;
    if (contextUserId !== null) {
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${contextUserId}, true)`;
    }
    return transaction.$queryRaw<T>(statement);
  });
}

function user(id: string, key: string) {
  const email = `${key}-${id.slice(0, 8)}@experience-projection.invalid`;
  return {
    id,
    tenantId,
    email,
    emailNormalized: email,
    displayName: key,
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
  };
}
