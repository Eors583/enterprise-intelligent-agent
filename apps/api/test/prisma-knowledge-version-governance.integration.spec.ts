import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { PrismaAiEvaluationRepository } from '../src/modules/ai-evaluation/infrastructure/prisma-ai-evaluation.repository.js';
import { KnowledgeBoundaryReadService } from '../src/modules/knowledge-gateway/knowledge-boundary-read.service.js';
import {
  type KnowledgeResourceAuthorizationFilters,
  knowledgeVersionResourcePolicySql,
} from '../src/modules/knowledge-retrieval/knowledge-resource-authorization.js';
import {
  seedPassingEvaluationRun,
  seedPublishedEvaluationDataset,
} from './ai-evaluation-test-fixture.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const administrator = new PrismaClient();
const tenantId = randomUUID();
const makerId = randomUUID();
const ownerId = randomUUID();
const reviewerId = randomUUID();
const knowledgeBaseId = randomUUID();
const tenantFilters: KnowledgeResourceAuthorizationFilters = {
  assignmentOrganizationScoped: false,
  organizationIds: [],
  includeOrganizationDescendants: false,
  projectIds: [],
  taskIds: [],
  roleTemplateIds: [],
  principalDataLabels: [],
};

describe.runIf(enabled)('PostgreSQL Knowledge Version governance integration', () => {
  beforeAll(async () => {
    await administrator.tenant.create({
      data: {
        id: tenantId,
        slug: `knowledge-governance-${tenantId.slice(0, 8)}`,
        name: 'Knowledge Version Governance Integration',
      },
    });
    await administrator.user.createMany({
      data: [user(makerId, 'maker'), user(ownerId, 'owner'), user(reviewerId, 'reviewer')],
    });
    await administrator.knowledgeBase.create({
      data: {
        id: knowledgeBaseId,
        tenantId,
        key: 'governed-policy',
        name: 'Governed Policy',
        status: 'ACTIVE',
        spaceTargetId: tenantId,
        spaceTargetName: 'Knowledge Version Governance Integration',
        createdById: makerId,
      },
    });
  });

  afterAll(async () => {
    await cleanupDisposableTenants(administrator, [tenantId]);
    await administrator.$disconnect();
  });

  it('keeps the existing forced-RLS/table ACL boundary and locks down governance helpers', async () => {
    const [table] = await administrator.$queryRaw<
      Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        appSelect: boolean;
        appInsert: boolean;
        appUpdate: boolean;
        appDelete: boolean;
      }>
    >(Prisma.sql`
      SELECT
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        has_table_privilege(
          'enterprise_agent_app',
          'public.knowledge_document_versions',
          'SELECT'
        ) AS "appSelect",
        has_table_privilege(
          'enterprise_agent_app',
          'public.knowledge_document_versions',
          'INSERT'
        ) AS "appInsert",
        has_table_privilege(
          'enterprise_agent_app',
          'public.knowledge_document_versions',
          'UPDATE'
        ) AS "appUpdate",
        has_table_privilege(
          'enterprise_agent_app',
          'public.knowledge_document_versions',
          'DELETE'
        ) AS "appDelete"
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'knowledge_document_versions'
    `);
    expect(table).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      appSelect: true,
      appInsert: false,
      appUpdate: false,
      appDelete: false,
    });

    const functions = await administrator.$queryRaw<
      Array<{
        functionName: string;
        isStrict: boolean;
        securityDefiner: boolean;
        settings: string[] | null;
        publicExecute: boolean;
        appExecute: boolean;
        adminExecute: boolean;
        processExecute: boolean;
      }>
    >(Prisma.sql`
      SELECT
        procedure.proname AS "functionName",
        procedure.proisstrict AS "isStrict",
        procedure.prosecdef AS "securityDefiner",
        procedure.proconfig::text[] AS settings,
        has_function_privilege('public', procedure.oid, 'EXECUTE') AS "publicExecute",
        has_function_privilege(
          'enterprise_agent_app',
          procedure.oid,
          'EXECUTE'
        ) AS "appExecute",
        has_function_privilege(
          'enterprise_agent_admin',
          procedure.oid,
          'EXECUTE'
        ) AS "adminExecute",
        has_function_privilege(
          'enterprise_agent_process',
          procedure.oid,
          'EXECUTE'
        ) AS "processExecute"
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = ANY(ARRAY[
          'knowledge_governance_uuid_array_valid',
          'knowledge_governance_text_array_valid',
          'knowledge_document_version_governance_hash',
          'knowledge_document_version_governance_guard'
        ]::text[])
      ORDER BY procedure.proname
    `);
    expect(functions).toHaveLength(4);
    expect(functions.every((procedure) => !procedure.publicExecute)).toBe(true);
    for (const procedure of functions) {
      const expectedExecute = procedure.functionName.startsWith('knowledge_governance_');
      expect(procedure).toMatchObject({
        appExecute: expectedExecute,
        adminExecute: expectedExecute,
        processExecute: expectedExecute,
      });
    }
    expect(
      functions.find(
        ({ functionName }) => functionName === 'knowledge_document_version_governance_hash',
      ),
    ).toMatchObject({
      isStrict: false,
      securityDefiner: false,
    });
    expect(
      functions.find(
        ({ functionName }) => functionName === 'knowledge_document_version_governance_guard',
      ),
    ).toMatchObject({
      isStrict: false,
      securityDefiner: true,
    });
    for (const procedure of functions) {
      expect(procedure.settings?.map((setting) => setting.replaceAll(' ', ''))).toContain(
        procedure.functionName.startsWith('knowledge_governance_')
          ? 'search_path=pg_catalog'
          : 'search_path=pg_catalog,public',
      );
    }
  });

  it('completes a safe tenant policy for legacy writes and rejects illegal or forged policy shapes', async () => {
    const documentId = await createDocument('Legacy policy fallback');
    const fallbackVersionId = randomUUID();
    await administrator.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_document_versions" (
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "version_number", "source_type", "status", "created_by_id"
      ) VALUES (
        ${fallbackVersionId}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        ${documentId}::uuid, 1, 'MARKDOWN'::public."KnowledgeSourceType",
        'READY'::public."KnowledgeDocumentVersionStatus", ${makerId}::uuid
      )
    `);
    const [fallback] = await administrator.$queryRaw<
      Array<{
        ownerUserId: string;
        classification: string;
        scopeMode: string;
        reviewStatus: string;
        policyHash: string;
      }>
    >(Prisma.sql`
      SELECT
        "governance_owner_user_id"::text AS "ownerUserId",
        "classification",
        "scope_mode" AS "scopeMode",
        "governance_review_status" AS "reviewStatus",
        btrim("governance_hash") AS "policyHash"
      FROM public."knowledge_document_versions"
      WHERE "id" = ${fallbackVersionId}::uuid
    `);
    expect(fallback).toMatchObject({
      ownerUserId: makerId,
      classification: 'INTERNAL',
      scopeMode: 'TENANT',
      reviewStatus: 'PENDING',
    });
    expect(fallback?.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(fallback?.policyHash).not.toBe('0'.repeat(64));

    const invalidClassification = await captureDatabaseError(() =>
      insertVersion({
        id: randomUUID(),
        documentId,
        versionNumber: 2,
        classification: 'TOP_SECRET',
      }),
    );
    expect(invalidClassification).toMatchObject({ prismaCode: 'P2010', sqlState: '23514' });
    expect(invalidClassification.databaseMessage).toContain(
      'knowledge_document_versions_classification_check',
    );

    const tenantWithRestrictedScope = await captureDatabaseError(() =>
      insertVersion({
        id: randomUUID(),
        documentId,
        versionNumber: 2,
        classification: 'INTERNAL',
        scopeMode: 'TENANT',
        organizationScopeIds: [randomUUID()],
      }),
    );
    expect(tenantWithRestrictedScope.databaseMessage).toContain(
      'knowledge_document_versions_governance_scope_check',
    );

    const restrictedWithoutScope = await captureDatabaseError(() =>
      insertVersion({
        id: randomUUID(),
        documentId,
        versionNumber: 2,
        classification: 'CONFIDENTIAL',
        scopeMode: 'RESTRICTED',
      }),
    );
    expect(restrictedWithoutScope.databaseMessage).toContain(
      'knowledge_document_versions_governance_scope_check',
    );

    const restrictedVersionId = randomUUID();
    await insertVersion({
      id: restrictedVersionId,
      documentId,
      versionNumber: 2,
      classification: 'CONFIDENTIAL',
      scopeMode: 'RESTRICTED',
      dataLabels: ['CLASSIFICATION:CONFIDENTIAL'],
    });
    await expect(
      administrator.knowledgeDocumentVersion.count({ where: { id: restrictedVersionId } }),
    ).resolves.toBe(1);

    const directlyPublishedVersionId = randomUUID();
    await insertVersion({
      id: directlyPublishedVersionId,
      documentId,
      versionNumber: 3,
      publishedAt: new Date(),
    });
    await expect(
      administrator.knowledgeDocumentVersion.findUniqueOrThrow({
        where: { id: directlyPublishedVersionId },
        select: { governanceReviewStatus: true, publishedAt: true },
      }),
    ).resolves.toMatchObject({
      governanceReviewStatus: 'PENDING',
      publishedAt: expect.any(Date),
    });

    const forgedInitialApproval = await captureDatabaseError(() =>
      insertVersion({
        id: randomUUID(),
        documentId,
        versionNumber: 3,
        review: {
          status: 'APPROVED',
          reviewedById: reviewerId,
          reviewedAt: new Date(),
        },
      }),
    );
    expect(forgedInitialApproval.databaseMessage).toContain(
      'KNOWLEDGE_GOVERNANCE_INITIAL_REVIEW_STATUS_INVALID',
    );
  });

  it('enforces maker-owner-checker separation, immutable published policy, and expiry in the recall predicate', async () => {
    const expiringDocumentId = await createDocument('Expiring governed policy');
    const expiringVersionId = randomUUID();
    const expiringAt = new Date(Date.now() + 5_000);
    await insertVersion({
      id: expiringVersionId,
      documentId: expiringDocumentId,
      versionNumber: 1,
      ownerUserId: ownerId,
      effectiveFrom: new Date(Date.now() - 60_000),
      expiresAt: expiringAt,
    });
    await createChunk(expiringDocumentId, expiringVersionId, 'EXPIRING_GOVERNED_POLICY');

    const makerSelfApproval = await captureDatabaseError(() =>
      approveVersion(expiringVersionId, makerId),
    );
    expect(makerSelfApproval.databaseMessage).toContain(
      'knowledge_document_versions_governance_review_shape_check',
    );

    const ownerSelfApproval = await captureDatabaseError(() =>
      approveVersion(expiringVersionId, ownerId),
    );
    expect(ownerSelfApproval.databaseMessage).toContain(
      'knowledge_document_versions_governance_review_shape_check',
    );

    await approveVersion(expiringVersionId, reviewerId);
    const approved = await administrator.knowledgeDocumentVersion.findUniqueOrThrow({
      where: { id: expiringVersionId },
      select: {
        governanceReviewStatus: true,
        governanceReviewedById: true,
        governanceRevision: true,
      },
    });
    expect(approved).toEqual({
      governanceReviewStatus: 'APPROVED',
      governanceReviewedById: reviewerId,
      governanceRevision: 2,
    });

    await publishVersion({
      documentId: expiringDocumentId,
      versionId: expiringVersionId,
      versionNumber: 1,
    });
    const immutablePolicy = await captureDatabaseError(() =>
      administrator.$executeRaw(Prisma.sql`
          UPDATE public."knowledge_document_versions"
          SET "classification" = 'PUBLIC',
              "governance_revision" = "governance_revision" + 1
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "id" = ${expiringVersionId}::uuid
        `),
    );
    expect(immutablePolicy.databaseMessage).toContain('KNOWLEDGE_PUBLISHED_GOVERNANCE_IMMUTABLE');

    const activeDocumentId = await createDocument('Active governed policy');
    const activeVersionId = randomUUID();
    await insertVersion({
      id: activeVersionId,
      documentId: activeDocumentId,
      versionNumber: 1,
      ownerUserId: ownerId,
      effectiveFrom: new Date(Date.now() - 60_000),
    });
    await createChunk(activeDocumentId, activeVersionId, 'ACTIVE_GOVERNED_POLICY');
    await approveVersion(activeVersionId, reviewerId);
    await publishVersion({
      documentId: activeDocumentId,
      versionId: activeVersionId,
      versionNumber: 1,
    });

    const beforeExpiry = await recalledVersionIds();
    expect(beforeExpiry).toEqual(expect.arrayContaining([expiringVersionId, activeVersionId]));

    const [expiryClock] = await administrator.$queryRaw<
      Array<{ expiresAt: Date; databaseNow: Date }>
    >(Prisma.sql`
      SELECT
        version."expires_at" AS "expiresAt",
        clock_timestamp() AS "databaseNow"
      FROM public."knowledge_document_versions" version
      WHERE version."tenant_id" = ${tenantId}::uuid
        AND version."id" = ${expiringVersionId}::uuid
    `);
    if (expiryClock === undefined) {
      throw new Error('Expected the governed version expiry clock fixture.');
    }
    const delayMs = Math.max(
      0,
      expiryClock.expiresAt.getTime() - expiryClock.databaseNow.getTime() + 500,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const [expiryState] = await administrator.$queryRaw<Array<{ expired: boolean }>>(Prisma.sql`
      SELECT version."expires_at" <= statement_timestamp() AS expired
      FROM public."knowledge_document_versions" version
      WHERE version."tenant_id" = ${tenantId}::uuid
        AND version."id" = ${expiringVersionId}::uuid
    `);
    expect(expiryState?.expired).toBe(true);
    const afterExpiry = await recalledVersionIds();
    expect(afterExpiry).toContain(activeVersionId);
    expect(afterExpiry).not.toContain(expiringVersionId);
  }, 30_000);

  function user(id: string, label: string) {
    const email = `${label}-${tenantId.slice(0, 8)}@knowledge-governance.integration`;
    return {
      id,
      tenantId,
      email,
      emailNormalized: email,
      displayName: `Knowledge ${label}`,
      role: 'ADMIN' as const,
    };
  }

  async function createDocument(title: string): Promise<string> {
    const document = await administrator.knowledgeDocument.create({
      data: {
        tenantId,
        knowledgeBaseId,
        title,
        sourceType: 'MARKDOWN',
        status: 'READY',
        createdById: makerId,
      },
      select: { id: true },
    });
    return document.id;
  }

  async function createChunk(
    documentId: string,
    documentVersionId: string,
    content: string,
  ): Promise<void> {
    const parent = await administrator.knowledgeParentChunk.create({
      data: {
        tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
        parentIndex: 0,
        content,
        tokenCount: 4,
        contentHash: 'b'.repeat(64),
      },
    });
    await administrator.knowledgeChunk.create({
      data: {
        tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
        parentChunkId: parent.id,
        chunkIndex: 0,
        content,
        tokenCount: 4,
        contentHash: 'a'.repeat(64),
      },
    });
  }

  async function insertVersion(input: {
    readonly id: string;
    readonly documentId: string;
    readonly versionNumber: number;
    readonly ownerUserId?: string;
    readonly classification?: string;
    readonly scopeMode?: 'TENANT' | 'RESTRICTED';
    readonly organizationScopeIds?: readonly string[];
    readonly dataLabels?: readonly string[];
    readonly effectiveFrom?: Date;
    readonly expiresAt?: Date | null;
    readonly publishedAt?: Date | null;
    readonly review?: {
      readonly status: 'PENDING' | 'APPROVED' | 'REJECTED';
      readonly reviewedById: string | null;
      readonly reviewedAt: Date | null;
    };
  }): Promise<void> {
    await administrator.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_document_versions" (
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "version_number", "source_type", "status", "created_by_id",
        "governance_owner_user_id", "classification", "scope_mode",
        "organization_scope_ids", "project_scope_ids", "task_scope_ids",
        "role_template_scope_ids", "data_labels", "effective_from", "expires_at",
        "retention_action", "governance_revision", "governance_review_status",
        "governance_reviewed_by_id", "governance_reviewed_at", "published_at"
      ) VALUES (
        ${input.id}::uuid, ${tenantId}::uuid, ${knowledgeBaseId}::uuid,
        ${input.documentId}::uuid, ${input.versionNumber},
        'MARKDOWN'::public."KnowledgeSourceType",
        'READY'::public."KnowledgeDocumentVersionStatus", ${makerId}::uuid,
        ${input.ownerUserId ?? makerId}::uuid, ${input.classification ?? 'INTERNAL'},
        ${input.scopeMode ?? 'TENANT'},
        ${uuidArray(input.organizationScopeIds ?? [])}, ARRAY[]::uuid[], ARRAY[]::uuid[],
        ARRAY[]::uuid[], ${textArray(input.dataLabels ?? [])},
        ${input.effectiveFrom ?? new Date(Date.now() - 60_000)},
        ${input.expiresAt ?? null}, 'ARCHIVE', 1,
        ${input.review?.status ?? 'PENDING'},
        ${input.review?.reviewedById ?? null}::uuid,
        ${input.review?.reviewedAt ?? null},
        ${input.publishedAt ?? null}
      )
    `);
  }

  async function approveVersion(versionId: string, approverId: string): Promise<void> {
    await administrator.$executeRaw(Prisma.sql`
      UPDATE public."knowledge_document_versions"
      SET "governance_review_status" = 'APPROVED',
          "governance_reviewed_by_id" = ${approverId}::uuid,
          "governance_reviewed_at" = statement_timestamp(),
          "governance_review_note" = 'Independent governance approval.',
          "governance_revision" = "governance_revision" + 1
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${versionId}::uuid
    `);
  }

  async function publishVersion(input: {
    readonly documentId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  }): Promise<void> {
    const fixtureName = `GOVERNANCE-${input.versionId}`;
    const fixture = await seedPublishedEvaluationDataset({
      prisma: administrator,
      tenantId,
      submitterUserId: makerId,
      reviewerUserId: reviewerId,
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: input.versionId,
      subjectVersion: input.versionNumber,
      fixtureName,
    });
    const knowledgePrisma = {
      withTenant: <T>(
        scopedTenantId: string,
        operation: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) =>
        administrator.$transaction(async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT set_config('app.tenant_id', ${scopedTenantId}, true)`,
          );
          return operation(transaction);
        }),
    } as never;
    const repository = new PrismaAiEvaluationRepository(
      knowledgePrisma,
      new KnowledgeBoundaryReadService(knowledgePrisma),
    );
    const principal = {
      tenantId,
      userId: reviewerId,
      role: 'ADMIN' as const,
      authenticationSource: 'trusted-proxy' as const,
    };
    const snapshot = await repository.loadReadiness(principal, {
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: input.versionId,
      subjectVersion: input.versionNumber,
      datasetVersionId: fixture.datasetVersionId,
      currentSnapshotHash: '0'.repeat(64),
    });
    const evaluationRunId = await seedPassingEvaluationRun({
      prisma: administrator,
      tenantId,
      submitterUserId: makerId,
      reviewerUserId: reviewerId,
      subjectType: 'KNOWLEDGE_VERSION',
      subjectId: input.versionId,
      subjectVersion: input.versionNumber,
      fixtureName,
      datasetVersionId: fixture.datasetVersionId,
      evidenceId: fixture.evidenceId,
      caseIds: fixture.caseIds,
      subjectSnapshotHash: snapshot.currentSnapshotHash,
    });
    await repository.recordReadiness(
      principal,
      {
        subjectType: 'KNOWLEDGE_VERSION',
        subjectId: input.versionId,
        subjectVersion: input.versionNumber,
        datasetVersionId: fixture.datasetVersionId,
        currentSnapshotHash: snapshot.currentSnapshotHash,
        evaluationRunId,
      },
      {
        ready: true,
        passingRunId: evaluationRunId,
        evaluatedSnapshotHash: snapshot.currentSnapshotHash,
        blockers: [],
        checkedAt: new Date().toISOString(),
      },
    );
    await administrator.$executeRaw(Prisma.sql`
      UPDATE public."knowledge_document_versions"
      SET "published_at" = statement_timestamp(),
          "evaluation_run_id" = ${evaluationRunId}::uuid,
          "evaluation_dataset_version_id" = ${fixture.datasetVersionId}::uuid,
          "evaluation_snapshot_hash" = ${snapshot.currentSnapshotHash}
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${input.versionId}::uuid
    `);
    await administrator.knowledgeDocument.update({
      where: { id: input.documentId },
      data: {
        currentVersionId: input.versionId,
        status: 'READY',
        documentVersion: input.versionNumber,
      },
    });
  }

  async function recalledVersionIds(): Promise<string[]> {
    const policy = knowledgeVersionResourcePolicySql(Prisma.sql`version`, tenantFilters);
    const rows = await administrator.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT version."id"::text AS id
      FROM public."knowledge_chunks" chunk
      JOIN public."knowledge_documents" document
        ON document."tenant_id" = chunk."tenant_id"
       AND document."knowledge_base_id" = chunk."knowledge_base_id"
       AND document."id" = chunk."document_id"
       AND document."status" = 'READY'
       AND document."current_version_id" = chunk."document_version_id"
      JOIN public."knowledge_document_versions" version
        ON version."tenant_id" = chunk."tenant_id"
       AND version."knowledge_base_id" = chunk."knowledge_base_id"
       AND version."document_id" = chunk."document_id"
       AND version."id" = chunk."document_version_id"
       AND version."status" = 'READY'
      WHERE chunk."tenant_id" = ${tenantId}::uuid
        AND chunk."knowledge_base_id" = ${knowledgeBaseId}::uuid
        AND ${policy}
      ORDER BY version."id"
    `);
    return rows.map(({ id }) => id);
  }
});

function uuidArray(values: readonly string[]): Prisma.Sql {
  return values.length === 0
    ? Prisma.sql`ARRAY[]::uuid[]`
    : Prisma.sql`ARRAY[${Prisma.join(values.map((value) => Prisma.sql`${value}::uuid`))}]::uuid[]`;
}

function textArray(values: readonly string[]): Prisma.Sql {
  return values.length === 0
    ? Prisma.sql`ARRAY[]::text[]`
    : Prisma.sql`ARRAY[${Prisma.join(values.map((value) => Prisma.sql`${value}::text`))}]::text[]`;
}

async function captureDatabaseError(
  operation: () => Promise<unknown>,
): Promise<{ prismaCode: string; sqlState: string; databaseMessage: string }> {
  try {
    await operation();
  } catch (error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
    const metadata = error.meta as { code?: unknown; message?: unknown } | undefined;
    return {
      prismaCode: error.code,
      sqlState: String(metadata?.code),
      databaseMessage: String(metadata?.message),
    };
  }
  throw new Error('Expected the database operation to be rejected.');
}
