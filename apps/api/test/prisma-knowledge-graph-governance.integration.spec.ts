import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  adminOrganizationResponseSchema,
  authSessionResponseSchema,
  changePasswordResponseSchema,
  knowledgeBaseSchema,
  knowledgeGraphCorrectionSchema,
  knowledgeGraphGovernanceOverviewSchema,
  knowledgeGraphConflictSchema,
  knowledgeOntologySchema,
  knowledgeOntologyVersionSchema,
  type KnowledgeGraphCorrection,
} from '@enterprise/contracts';
import request from 'supertest';

import { createTestApp } from '../src/testing/create-test-app.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(enabled)('PostgreSQL knowledge graph governance integration', () => {
  const administrator = new PrismaClient();
  const tenantSlug = `graph-governance-${randomUUID().slice(0, 8)}`;
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await administrator.$disconnect();
  });

  it('discovers the forced-RLS, composite-FK and least-privilege schema boundary', async () => {
    const governedTables = [
      'knowledge_ontologies',
      'knowledge_ontology_versions',
      'knowledge_ontology_entity_types',
      'knowledge_ontology_predicates',
      'knowledge_graph_corrections',
      'knowledge_graph_conflicts',
      'knowledge_graph_projections',
      'knowledge_entity_merges',
      'knowledge_entity_aliases',
      'knowledge_entity_source_identities',
      'knowledge_relation_governance',
      'knowledge_graph_commands',
    ];
    const tables = await administrator.$queryRaw<
      Array<{ tableName: string; rlsEnabled: boolean; rlsForced: boolean }>
    >`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced"
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY(${governedTables}::text[])
      ORDER BY relation.relname
    `;
    expect(tables).toHaveLength(governedTables.length);
    expect(tables.every((table) => table.rlsEnabled && table.rlsForced)).toBe(true);

    const nonCompositeTenantForeignKeys = await administrator.$queryRaw<
      Array<{ constraintName: string }>
    >`
      SELECT constraint_row.conname AS "constraintName"
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = child.relnamespace
      WHERE namespace.nspname = 'public'
        AND child.relname = ANY(${governedTables}::text[])
        AND constraint_row.contype = 'f'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class parent
          JOIN pg_catalog.pg_attribute parent_tenant
            ON parent_tenant.attrelid = parent.oid
           AND parent_tenant.attname = 'tenant_id'
           AND parent_tenant.attnum > 0
           AND NOT parent_tenant.attisdropped
          WHERE parent.oid = constraint_row.confrelid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(constraint_row.conkey, constraint_row.confkey)
            WITH ORDINALITY AS key_pair(child_number, parent_number, ordinality)
          JOIN pg_catalog.pg_attribute child_column
            ON child_column.attrelid = constraint_row.conrelid
           AND child_column.attnum = key_pair.child_number
          JOIN pg_catalog.pg_attribute parent_column
            ON parent_column.attrelid = constraint_row.confrelid
           AND parent_column.attnum = key_pair.parent_number
          WHERE child_column.attname = 'tenant_id'
            AND parent_column.attname = 'tenant_id'
        )
    `;
    expect(nonCompositeTenantForeignKeys).toEqual([]);

    const privileges = await administrator.$queryRaw<
      Array<{ relationName: string; privilege: string }>
    >`
      SELECT table_name AS "relationName", privilege_type AS privilege
      FROM information_schema.role_table_grants
      WHERE grantee = 'enterprise_agent_app'
        AND table_schema = 'public'
        AND (
          table_name = ANY(${governedTables}::text[])
          OR table_name = 'knowledge_graph_retrieval_relations'
        )
      ORDER BY table_name, privilege_type
    `;
    expect(privileges).toEqual([
      {
        relationName: 'knowledge_entity_aliases',
        privilege: 'SELECT',
      },
      {
        relationName: 'knowledge_graph_projections',
        privilege: 'SELECT',
      },
      {
        relationName: 'knowledge_graph_retrieval_relations',
        privilege: 'SELECT',
      },
    ]);

    const canonicalFunction = await administrator.$queryRaw<
      Array<{ settings: string[] | null; publicExecute: boolean }>
    >`
      SELECT
        procedure.proconfig::text[] AS settings,
        has_function_privilege(
          'public',
          procedure.oid,
          'EXECUTE'
        ) AS "publicExecute"
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = 'knowledge_graph_resolve_canonical_entity'
    `;
    expect(canonicalFunction).toHaveLength(1);
    expect(canonicalFunction[0]?.settings?.map((item) => item.replaceAll(' ', ''))).toContain(
      'search_path=pg_catalog,public',
    );
    expect(canonicalFunction[0]?.publicExecute).toBe(false);
  });

  it('runs ontology review, governed retrieval, conflict resolution and canonical merge lineage', async () => {
    const owner = authSessionResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/register-tenant')
          .send({
            tenantName: 'Knowledge Graph Governance Integration',
            tenantSlug,
            organizationName: 'Knowledge Graph Governance Integration',
            displayName: 'Graph Owner',
            email: `owner@${tenantSlug}.integration`,
            password: 'GraphOwner!2026',
            sessionLabel: 'knowledge graph owner',
          })
          .expect(201)
      ).body,
    );
    const ownerAuthorization = bearer(owner.accessToken);
    const organization = adminOrganizationResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/admin/organization')
          .set(ownerAuthorization)
          .expect(200)
      ).body,
    );
    const root = organization.orgUnits.find((orgUnit) => orgUnit.parentId === null);
    if (root === undefined) throw new Error('Expected a root organizational unit.');

    const checkerEmail = `checker@${tenantSlug}.integration`;
    const checkerTemporaryPassword = 'GraphCheckerTemp!2026';
    const checkerPassword = 'GraphCheckerFinal!2026';
    const checkerMember = (
      await request(app.getHttpServer())
        .post('/api/v1/admin/members')
        .set(ownerAuthorization)
        .send({
          email: checkerEmail,
          displayName: 'Graph Checker',
          password: checkerTemporaryPassword,
          role: 'ADMIN',
          orgUnitId: root.id,
          title: 'Knowledge Graph Reviewer',
        })
        .expect(201)
    ).body as { id: string };
    const checker = authSessionResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({
            tenantSlug,
            email: checkerEmail,
            password: checkerTemporaryPassword,
            sessionLabel: 'knowledge graph checker',
          })
          .expect(200)
      ).body,
    );
    expect(checker.account.role).toBe('ADMIN');
    expect(checker.account.passwordChangeRequired).toBe(true);
    expect(
      changePasswordResponseSchema.parse(
        (
          await request(app.getHttpServer())
            .post('/api/v1/auth/change-password')
            .set(bearer(checker.accessToken))
            .send({
              currentPassword: checkerTemporaryPassword,
              newPassword: checkerPassword,
            })
            .expect(200)
        ).body,
      ).account.passwordChangeRequired,
    ).toBe(false);
    const checkerAuthorization = bearer(checker.accessToken);

    const knowledgeBase = knowledgeBaseSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/knowledge-bases')
          .set(ownerAuthorization)
          .send({
            key: 'governed-enterprise-graph',
            name: 'Governed Enterprise Graph',
            description: 'Ontology, temporal validity, lineage and conflict acceptance.',
            status: 'DRAFT',
            orgUnitIds: [],
          })
          .expect(201)
      ).body,
    );
    const ontologyRequest = {
      code: 'ENTERPRISE_CORE',
      name: 'Enterprise Core',
      description: 'Employee-to-department enterprise semantics.',
      changeSummary: 'Create initial reviewed ontology.',
      entityTypes: [
        { key: 'EMPLOYEE', name: 'Employee' },
        { key: 'DEPARTMENT', name: 'Department' },
      ],
      predicates: [
        {
          key: 'BELONGS_TO',
          predicate: 'BELONGS_TO',
          label: 'belongs to',
          domainTypeKey: 'EMPLOYEE',
          rangeTypeKey: 'DEPARTMENT',
          functional: true,
        },
      ],
      idempotencyKey: 'graph-ontology-create-0001',
    };
    const ontology = knowledgeOntologySchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph-governance/ontologies`)
          .set(ownerAuthorization)
          .send(ontologyRequest)
          .expect(201)
      ).body,
    );
    const replayedOntology = knowledgeOntologySchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph-governance/ontologies`)
          .set(ownerAuthorization)
          .send(ontologyRequest)
          .expect(201)
      ).body,
    );
    expect(replayedOntology.id).toBe(ontology.id);
    const draftVersion = ontology.versions[0];
    if (draftVersion === undefined) throw new Error('Expected the initial ontology version.');

    const submittedVersion = knowledgeOntologyVersionSchema.parse(
      (
        await transitionOntologyVersion(
          ownerAuthorization,
          knowledgeBase.id,
          draftVersion.id,
          draftVersion.revision,
          'SUBMIT',
          'graph-ontology-submit-0001',
        ).expect(201)
      ).body,
    );
    expect(submittedVersion.status).toBe('IN_REVIEW');
    await transitionOntologyVersion(
      ownerAuthorization,
      knowledgeBase.id,
      submittedVersion.id,
      submittedVersion.revision,
      'PUBLISH',
      'graph-ontology-self-publish-0001',
    ).expect(409);
    const publishedVersion = knowledgeOntologyVersionSchema.parse(
      (
        await transitionOntologyVersion(
          checkerAuthorization,
          knowledgeBase.id,
          submittedVersion.id,
          submittedVersion.revision,
          'PUBLISH',
          'graph-ontology-publish-0001',
        ).expect(201)
      ).body,
    );
    expect(publishedVersion).toMatchObject({
      status: 'PUBLISHED',
      createdByUserId: owner.account.userId,
      reviewedByUserId: checkerMember.id,
    });
    const predicate = publishedVersion.predicates.find((item) => item.key === 'BELONGS_TO');
    if (predicate === undefined) throw new Error('Expected BELONGS_TO predicate.');

    const sourceEmployee = await administrator.knowledgeEntity.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        entityType: 'EMPLOYEE',
        canonicalName: 'Employee source identity',
        normalizedName: 'employee source identity',
      },
    });
    const canonicalEmployee = await administrator.knowledgeEntity.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        entityType: 'EMPLOYEE',
        canonicalName: 'Employee canonical identity',
        normalizedName: 'employee canonical identity',
      },
    });
    const department = await administrator.knowledgeEntity.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        entityType: 'DEPARTMENT',
        canonicalName: 'Platform Department',
        normalizedName: 'platform department',
      },
    });
    const relation = await administrator.knowledgeRelation.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        subjectEntityId: sourceEmployee.id,
        objectEntityId: department.id,
        predicate: 'BELONGS_TO',
        normalizedPredicate: 'BELONGS_TO',
      },
    });
    const sourceDocument = await administrator.knowledgeDocument.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        title: 'Governed relationship evidence',
        sourceType: 'TEXT',
        contentText: 'Employee source identity belongs to Platform Department.',
        status: 'READY',
        documentVersion: 1,
        createdById: owner.account.userId,
      },
    });
    const sourceVersion = await administrator.knowledgeDocumentVersion.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        documentId: sourceDocument.id,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'Employee source identity belongs to Platform Department.',
        status: 'READY',
        createdById: owner.account.userId,
      },
    });
    const sourceChunk = await administrator.knowledgeChunk.create({
      data: {
        tenantId: owner.account.tenantId,
        knowledgeBaseId: knowledgeBase.id,
        documentId: sourceDocument.id,
        documentVersionId: sourceVersion.id,
        chunkIndex: 0,
        content: 'Employee source identity belongs to Platform Department.',
        tokenCount: 8,
        contentHash: 'a'.repeat(64),
      },
    });
    const activeProjectionId = randomUUID();
    await administrator.$executeRaw`
      INSERT INTO public."knowledge_graph_projections"(
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "document_version_id", "graph_hash", "relation_count",
        "evidence_count", "created_by_user_id"
      ) VALUES (
        ${activeProjectionId}::uuid,
        ${owner.account.tenantId}::uuid,
        ${knowledgeBase.id}::uuid,
        ${sourceDocument.id}::uuid,
        ${sourceVersion.id}::uuid,
        ${'b'.repeat(64)},
        1,
        1,
        ${owner.account.userId}::uuid
      )
    `;
    await administrator.$executeRaw`
      UPDATE public."knowledge_graph_projections"
      SET "status" = 'ACTIVE', "activated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${activeProjectionId}::uuid
    `;
    await administrator.$executeRaw`
      INSERT INTO public."knowledge_relation_evidence"(
        "tenant_id", "knowledge_base_id", "projection_id", "relation_id",
        "document_id", "document_version_id", "chunk_id", "excerpt",
        "confidence", "extractor"
      ) VALUES (
        ${owner.account.tenantId}::uuid,
        ${knowledgeBase.id}::uuid,
        ${activeProjectionId}::uuid,
        ${relation.id}::uuid,
        ${sourceDocument.id}::uuid,
        ${sourceVersion.id}::uuid,
        ${sourceChunk.id}::uuid,
        'Employee source identity belongs to Platform Department.',
        1,
        'governance_integration_fixture'
      )
    `;

    const relationCorrection = await createAndApproveCorrection(
      ownerAuthorization,
      checkerAuthorization,
      knowledgeBase.id,
      {
        action: 'UPSERT_RELATION_VALIDITY',
        patch: {
          relationId: relation.id,
          ontologyVersionId: publishedVersion.id,
          predicateDefinitionId: predicate.id,
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
        },
        evidence: [{ source: 'approved-employment-register', row: 1 }],
        idempotencyKey: 'graph-relation-validity-create-0001',
      },
      'relation-validity-0001',
    );
    expect(relationCorrection.status).toBe('APPLIED');
    expect(await readEligibleRelations(owner.account.tenantId)).toEqual([
      {
        id: relation.id,
        subjectEntityId: sourceEmployee.id,
        objectEntityId: department.id,
      },
    ]);
    expect(await readEligibleRelations(randomUUID())).toEqual([]);

    const conflict = knowledgeGraphConflictSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph-governance/conflicts`)
          .set(ownerAuthorization)
          .send({
            targetType: 'RELATION',
            targetId: relation.id,
            conflictKey: `relation:${relation.id}:employment-source`,
            conflictType: 'SOURCE_DISAGREEMENT',
            details: { reason: 'HR and directory sources disagree.' },
            evidence: [{ source: 'directory' }, { source: 'hris' }],
            idempotencyKey: 'graph-conflict-create-0001',
          })
          .expect(201)
      ).body,
    );
    expect(conflict.status).toBe('OPEN');
    expect(await readEligibleRelations(owner.account.tenantId)).toEqual([]);

    await createAndApproveCorrection(
      ownerAuthorization,
      checkerAuthorization,
      knowledgeBase.id,
      {
        action: 'RESOLVE_CONFLICT',
        patch: {
          conflictId: conflict.id,
          resolution: 'The signed HR register is authoritative.',
        },
        evidence: [{ source: 'signed-hr-register', checksum: 'acceptance' }],
        idempotencyKey: 'graph-conflict-resolution-create-0001',
      },
      'conflict-resolution-0001',
    );
    expect(await readEligibleRelations(owner.account.tenantId)).toHaveLength(1);

    await createAndApproveCorrection(
      ownerAuthorization,
      checkerAuthorization,
      knowledgeBase.id,
      {
        action: 'MERGE_ENTITY',
        patch: {
          sourceEntityId: sourceEmployee.id,
          targetEntityId: canonicalEmployee.id,
          reason: 'Both source records identify the same employee.',
        },
        evidence: [{ source: 'identity-review', reviewed: true }],
        idempotencyKey: 'graph-entity-merge-create-0001',
      },
      'entity-merge-0001',
    );
    expect(await readEligibleRelations(owner.account.tenantId)).toEqual([
      {
        id: relation.id,
        subjectEntityId: canonicalEmployee.id,
        objectEntityId: department.id,
      },
    ]);

    const cycleCandidate = await createAndApproveCorrection(
      ownerAuthorization,
      checkerAuthorization,
      knowledgeBase.id,
      {
        action: 'MERGE_ENTITY',
        patch: {
          sourceEntityId: canonicalEmployee.id,
          targetEntityId: sourceEmployee.id,
          reason: 'This reverse merge must be rejected as a cycle.',
        },
        evidence: [{ source: 'negative-acceptance-test' }],
        idempotencyKey: 'graph-entity-cycle-create-0001',
      },
      'entity-cycle-0001',
      false,
    );
    await transitionCorrection(
      ownerAuthorization,
      knowledgeBase.id,
      cycleCandidate.id,
      cycleCandidate.revision,
      'APPLY',
      'entity-cycle-0001-apply',
    ).expect(422);
    const overview = knowledgeGraphGovernanceOverviewSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph-governance`)
          .set(ownerAuthorization)
          .expect(200)
      ).body,
    );
    expect(overview).toMatchObject({
      retrieval: {
        eligibleRelationCount: 1,
        excludedConflictCount: 0,
        mergedEntityCount: 1,
        publishedOntologyVersionCount: 1,
      },
    });
    expect(overview.corrections.find((item) => item.id === cycleCandidate.id)?.status).toBe(
      'APPROVED',
    );

    const [auditCount, outboxCount, commandCount] = await Promise.all([
      administrator.auditEvent.count({
        where: {
          tenantId: owner.account.tenantId,
          action: { startsWith: 'knowledge.graph.' },
        },
      }),
      administrator.outboxEvent.count({
        where: {
          tenantId: owner.account.tenantId,
          eventType: { startsWith: 'knowledge.graph.' },
        },
      }),
      administrator.knowledgeGraphCommand.count({
        where: { tenantId: owner.account.tenantId, knowledgeBaseId: knowledgeBase.id },
      }),
    ]);
    expect(auditCount).toBeGreaterThanOrEqual(14);
    expect(outboxCount).toBe(auditCount);
    expect(commandCount).toBe(auditCount);
  });

  function transitionOntologyVersion(
    authorization: Record<string, string>,
    knowledgeBaseId: string,
    versionId: string,
    expectedRevision: number,
    action: 'SUBMIT' | 'PUBLISH',
    idempotencyKey: string,
  ) {
    return request(app.getHttpServer())
      .post(
        `/api/v1/admin/knowledge-bases/${knowledgeBaseId}/graph-governance/ontology-versions/${versionId}/transitions`,
      )
      .set(authorization)
      .send({
        expectedRevision,
        action,
        comment: `${action} integration acceptance.`,
        idempotencyKey,
      });
  }

  async function createAndApproveCorrection(
    ownerAuthorization: Record<string, string>,
    checkerAuthorization: Record<string, string>,
    knowledgeBaseId: string,
    body: Record<string, unknown>,
    keyPrefix: string,
    apply = true,
  ): Promise<KnowledgeGraphCorrection> {
    const created = knowledgeGraphCorrectionSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBaseId}/graph-governance/corrections`)
          .set(ownerAuthorization)
          .send(body)
          .expect(201)
      ).body,
    );
    const submitted = knowledgeGraphCorrectionSchema.parse(
      (
        await transitionCorrection(
          ownerAuthorization,
          knowledgeBaseId,
          created.id,
          created.revision,
          'SUBMIT',
          `${keyPrefix}-submit`,
        ).expect(201)
      ).body,
    );
    const approved = knowledgeGraphCorrectionSchema.parse(
      (
        await transitionCorrection(
          checkerAuthorization,
          knowledgeBaseId,
          submitted.id,
          submitted.revision,
          'APPROVE',
          `${keyPrefix}-approve`,
        ).expect(201)
      ).body,
    );
    if (!apply) return approved;
    return knowledgeGraphCorrectionSchema.parse(
      (
        await transitionCorrection(
          ownerAuthorization,
          knowledgeBaseId,
          approved.id,
          approved.revision,
          'APPLY',
          `${keyPrefix}-apply`,
        ).expect(201)
      ).body,
    );
  }

  function transitionCorrection(
    authorization: Record<string, string>,
    knowledgeBaseId: string,
    correctionId: string,
    expectedRevision: number,
    action: 'SUBMIT' | 'APPROVE' | 'APPLY',
    idempotencyKey: string,
  ) {
    return request(app.getHttpServer())
      .post(
        `/api/v1/admin/knowledge-bases/${knowledgeBaseId}/graph-governance/corrections/${correctionId}/transitions`,
      )
      .set(authorization)
      .send({
        expectedRevision,
        action,
        comment: `${action} integration acceptance.`,
        idempotencyKey,
      });
  }

  async function readEligibleRelations(
    tenantId: string,
  ): Promise<Array<{ id: string; subjectEntityId: string; objectEntityId: string }>> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`
        SELECT set_config('app.tenant_id', ${tenantId}, true)
      `;
      return transaction.$queryRaw<
        Array<{ id: string; subjectEntityId: string; objectEntityId: string }>
      >`
        SELECT
          id,
          subject_entity_id AS "subjectEntityId",
          object_entity_id AS "objectEntityId"
        FROM public.knowledge_graph_retrieval_relations
        ORDER BY id
      `;
    });
  }
});

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}
