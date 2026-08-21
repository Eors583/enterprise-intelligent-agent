import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  authSessionResponseSchema,
  knowledgeBaseSchema,
  knowledgeDocumentSchema,
  knowledgeGraphOverviewSchema,
  knowledgeGraphResponseSchema,
  knowledgeRetrievalTestResponseSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import { validateEnvironment, type EnvironmentVariables } from '../src/config/environment.js';
import { OutboxPrismaService } from '../src/database/outbox-prisma.service.js';
import { KnowledgeIngestionAvailabilityService } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion-availability.service.js';
import { KnowledgeIngestionProcessor } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeIngestionWorker } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.worker.js';
import { PrismaKnowledgeIngestionJobRepository } from '../src/modules/knowledge-ingestion/infrastructure/prisma-knowledge-ingestion-job.repository.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import { LocalKnowledgeObjectStore } from '../src/modules/knowledge-ingestion/infrastructure/local-knowledge-object.store.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantSlug = 'knowledge-ingestion-integration';

describe.runIf(enabled)('PostgreSQL knowledge ingestion HTTP integration', () => {
  const administrator = new PrismaClient();
  const queueClient = createQueueClient();
  let app: INestApplication;
  let worker: KnowledgeIngestionWorker;

  beforeAll(async () => {
    await cleanup(administrator);
    app = await createTestApp();
    await queueClient.onModuleInit();
    worker = new KnowledgeIngestionWorker(
      createWorkerConfig(),
      new PrismaKnowledgeIngestionJobRepository(queueClient),
      app.get(KnowledgeIngestionProcessor),
      app.get(KnowledgeIngestionAvailabilityService),
    );
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await queueClient.onModuleDestroy();
    await cleanup(administrator);
    await administrator.$disconnect();
  });

  it('uploads, chunks, permission-filters, retrieves, and archives a Markdown document', async () => {
    const registration = await request(app.getHttpServer())
      .post('/api/v1/auth/register-tenant')
      .send({
        tenantName: 'Knowledge ingestion integration',
        tenantSlug,
        organizationName: 'Knowledge ingestion integration organization',
        displayName: 'Knowledge Owner',
        email: 'owner@knowledge-ingestion.integration',
        password: 'KnowledgeIntegration!2026',
        sessionLabel: 'knowledge ingestion integration',
      })
      .expect(201);
    const session = authSessionResponseSchema.parse(registration.body);
    const authorization = { Authorization: `Bearer ${session.accessToken}` };
    const tenantId = session.account.tenantId;
    const knowledgeBase = knowledgeBaseSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/admin/knowledge-bases')
          .set(authorization)
          .send({
            key: 'employee-lifecycle',
            name: '员工生命周期制度',
            description: '用于验证文档摄取和权限优先检索。',
            status: 'DRAFT',
            orgUnitIds: [],
          })
          .expect(201)
      ).body,
    );
    const draftResponse = await request(app.getHttpServer())
      .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
      .set(authorization)
      .send({
        title: '待审核草稿',
        sourceType: 'MARKDOWN',
        contentText: '# 草稿\n\nLEGACYPOLICYALPHA 尚未发布的内容。',
        status: 'DRAFT',
      });
    if (draftResponse.status !== 201) {
      throw new Error(`Draft creation failed: ${JSON.stringify(draftResponse.body)}`);
    }
    const unpublishedDraft = knowledgeDocumentSchema.parse(draftResponse.body);
    expect(unpublishedDraft).toMatchObject({ status: 'DRAFT', currentVersionId: null });
    expect(unpublishedDraft.versions[0]).toMatchObject({
      status: 'DRAFT',
      chunkCount: 0,
      ingestionJob: null,
    });

    const beforeDraftPublish = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'LEGACYPOLICYALPHA', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(beforeDraftPublish.items.some((item) => item.documentId === unpublishedDraft.id)).toBe(
      false,
    );

    const firstQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
          .set(authorization)
          /*
          .send({
            title: '寰呭鏍歌崏绋?,
            sourceType: 'MARKDOWN',
            contentText: '# 鑽夌\n\nLEGACYPOLICYALPHA 灏氭湭鍙戝竷鐨勫唴瀹广€?,
            status: 'READY',
          })
          */
          .send({
            title: 'Published policy draft',
            sourceType: 'MARKDOWN',
            contentText:
              '# Legacy policy\n\nLEGACYPOLICYALPHA is visible only after governed publication.',
            status: 'READY',
          })
          .expect(201)
      ).body,
    );
    const draft = firstQueued;
    expect(firstQueued.versions[0]).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    const firstIndexed = await processDocument(
      authorization,
      knowledgeBase.id,
      draft.id,
      firstQueued.versions[0]?.id,
    );
    const firstPublished = await publishIndexedDocument(
      authorization,
      knowledgeBase.id,
      draft.id,
      firstIndexed.versions[0]?.id,
    );
    const firstPublishedVersion = firstPublished.versions.find(
      (version) => version.id === firstPublished.currentVersionId,
    );
    expect(firstPublishedVersion).toMatchObject({
      versionNumber: 1,
      status: 'READY',
      chunkCount: 1,
      ingestionJob: { status: 'SUCCEEDED' },
    });
    const firstGraphOverview = knowledgeGraphOverviewSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph-overview`)
          .set(authorization)
          .expect(200)
      ).body,
    );
    expect(firstGraphOverview).toMatchObject({
      status: 'DEGRADED',
      publishedChunkCount: 1,
      linkedChunkCount: 1,
      mentionCoverage: 1,
      evidenceCoverage: 1,
      diagnostics: expect.arrayContaining(['NO_PUBLISHED_ONTOLOGY', 'OPEN_GRAPH_CONFLICTS']),
    });
    expect(firstGraphOverview.entityCount).toBeGreaterThan(0);
    expect(firstGraphOverview.relationCount).toBeGreaterThan(0);
    expect(firstGraphOverview.evidenceCount).toBeGreaterThan(0);
    const firstGraph = knowledgeGraphResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph?limit=50`)
          .set(authorization)
          .expect(200)
      ).body,
    );
    expect(firstGraph.entities.length).toBeGreaterThan(0);
    expect(firstGraph.relations.length).toBeGreaterThan(0);

    const activatedKnowledgeBase = knowledgeBaseSchema.parse(
      (
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}`)
          .set(authorization)
          .send({ status: 'ACTIVE', expectedVersion: knowledgeBase.version })
          .expect(200)
      ).body,
    );
    expect(activatedKnowledgeBase).toMatchObject({ status: 'ACTIVE', version: 2 });

    const relationshipSeedQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
          .set(authorization)
          .send({
            title: '关系检索入口',
            sourceType: 'MARKDOWN',
            contentText:
              '# 关系入口\n\n关系验收口令 GRAPHSEEDTOKEN2026。\n安全平台主管负责应急响应流程。',
            status: 'READY',
          })
          .expect(201)
      ).body,
    );
    const relationshipSeed = await processAndPublishDocument(
      authorization,
      knowledgeBase.id,
      relationshipSeedQueued.id,
      relationshipSeedQueued.versions[0]?.id,
    );
    const relationshipTargetQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
          .set(authorization)
          .send({
            title: '应急系统依赖',
            sourceType: 'MARKDOWN',
            contentText: '# 应急依赖\n\n应急响应流程依赖统一告警系统。',
            status: 'READY',
          })
          .expect(201)
      ).body,
    );
    const relationshipTarget = await processAndPublishDocument(
      authorization,
      knowledgeBase.id,
      relationshipTargetQueued.id,
      relationshipTargetQueued.versions[0]?.id,
    );
    const sameTitleDocuments = [];
    for (const suffix of ['甲', '乙']) {
      const queued = knowledgeDocumentSchema.parse(
        (
          await request(app.getHttpServer())
            .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
            .set(authorization)
            .send({
              title: '同名管理制度',
              sourceType: 'MARKDOWN',
              contentText: `# 总则\n\n负责人：平台组\n同名制度${suffix}的专属内容。`,
              status: 'READY',
            })
            .expect(201)
        ).body,
      );
      sameTitleDocuments.push(
        await processAndPublishDocument(
          authorization,
          knowledgeBase.id,
          queued.id,
          queued.versions[0]?.id,
        ),
      );
    }
    const sameTitleDocumentEntities = await administrator.$queryRaw<
      Array<{ readonly externalKey: string | null }>
    >`
      SELECT entity."external_key" AS "externalKey"
      FROM public."knowledge_entities" AS entity
      WHERE entity."tenant_id" = ${tenantId}::uuid
        AND entity."knowledge_base_id" = ${knowledgeBase.id}::uuid
        AND entity."entity_type" = 'DOCUMENT'
        AND entity."canonical_name" = '同名管理制度'
      ORDER BY entity."external_key"
    `;
    expect(sameTitleDocumentEntities.map((entity) => entity.externalKey)).toEqual(
      sameTitleDocuments
        .map((document) => `document:${document.id}`)
        .sort((left, right) => left.localeCompare(right)),
    );
    const sameTitleSections = await administrator.$queryRaw<
      Array<{ readonly externalKey: string | null }>
    >`
      SELECT entity."external_key" AS "externalKey"
      FROM public."knowledge_entities" AS entity
      WHERE entity."tenant_id" = ${tenantId}::uuid
        AND entity."knowledge_base_id" = ${knowledgeBase.id}::uuid
        AND entity."entity_type" = 'SECTION'
        AND entity."canonical_name" = '同名管理制度 / 总则'
    `;
    expect(sameTitleSections).toHaveLength(2);
    expect(new Set(sameTitleSections.map((entity) => entity.externalKey)).size).toBe(2);
    const sharedSemanticEntities = await administrator.$queryRaw<
      Array<{ readonly id: string; readonly documentIds: string[] }>
    >`
      SELECT
        entity."id"::text AS id,
        array_agg(DISTINCT mention."document_id"::text ORDER BY mention."document_id"::text)
          AS "documentIds"
      FROM public."knowledge_entities" AS entity
      JOIN public."knowledge_entity_mentions" AS mention
        ON mention."tenant_id" = entity."tenant_id"
       AND mention."knowledge_base_id" = entity."knowledge_base_id"
       AND mention."entity_id" = entity."id"
      WHERE entity."tenant_id" = ${tenantId}::uuid
        AND entity."knowledge_base_id" = ${knowledgeBase.id}::uuid
        AND entity."entity_type" = 'PERSON'
        AND entity."normalized_name" = '平台组'
        AND entity."external_key" IS NULL
      GROUP BY entity."id"
    `;
    expect(sharedSemanticEntities).toHaveLength(1);
    expect(new Set(sharedSemanticEntities[0]?.documentIds)).toEqual(
      new Set(sameTitleDocuments.map((document) => document.id)),
    );

    const sourceDocument = sameTitleDocuments[0];
    if (sourceDocument === undefined) throw new Error('Expected a source document to rename.');
    const renamedQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${sourceDocument.id}`)
          .set(authorization)
          .send({
            title: '同名管理制度（修订版）',
            contentText: '# 总则\n\n负责人：平台组\n同名制度甲的修订内容。',
            status: 'READY',
            expectedVersion: sourceDocument.documentVersion,
          })
          .expect(200)
      ).body,
    );
    const renamedVersion = renamedQueued.versions.find(
      (version) => version.versionNumber === sourceDocument.documentVersion + 1,
    );
    await processAndPublishDocument(
      authorization,
      knowledgeBase.id,
      sourceDocument.id,
      renamedVersion?.id,
    );
    const renamedSourceEntities = await administrator.$queryRaw<
      Array<{
        readonly canonicalName: string;
        readonly aliases: string[];
      }>
    >`
      SELECT
        entity."canonical_name" AS "canonicalName",
        entity."aliases"
      FROM public."knowledge_entities" AS entity
      WHERE entity."tenant_id" = ${tenantId}::uuid
        AND entity."knowledge_base_id" = ${knowledgeBase.id}::uuid
        AND entity."entity_type" = 'DOCUMENT'
        AND entity."external_key" = ${`document:${sourceDocument.id}`}
    `;
    expect(renamedSourceEntities).toEqual([
      expect.objectContaining({
        canonicalName: '同名管理制度（修订版）',
        aliases: expect.arrayContaining(['同名管理制度']),
      }),
    ]);
    const renamedAliases = renamedSourceEntities[0]?.aliases ?? [];
    expect(renamedAliases).not.toContain('同名管理制度（修订版）');
    expect(new Set(renamedAliases).size).toBe(renamedAliases.length);
    expect(renamedAliases.length).toBeLessThanOrEqual(32);
    expect(renamedAliases.every((alias) => alias.length <= 160)).toBe(true);

    const relationshipRetrieval = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'GRAPHSEEDTOKEN2026 关联', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(
      relationshipRetrieval.relationshipCandidateCount,
      JSON.stringify(relationshipRetrieval.diagnostics),
    ).toBeGreaterThan(0);
    expect(relationshipRetrieval.relationshipExpandedCount).toBeGreaterThan(0);
    expect(relationshipRetrieval.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'RELATIONSHIP',
          status: 'APPLIED',
          code: 'KNOWLEDGE_RELATIONSHIP_EXPANSION_APPLIED',
        }),
      ]),
    );
    const relationshipSeedResult = relationshipRetrieval.items.find(
      (item) => item.documentId === relationshipSeed.id,
    );
    expect(relationshipSeedResult).toMatchObject({
      documentVersionId: relationshipSeed.currentVersionId,
      relationshipScore: 0,
      relationshipEvidence: [],
    });
    expect(relationshipSeed.currentVersionId).not.toBeNull();
    expect(relationshipTarget.currentVersionId).not.toBeNull();

    const aliasUpdate = await administrator.knowledgeEntity.updateMany({
      where: {
        tenantId,
        knowledgeBaseId: knowledgeBase.id,
        canonicalName: '安全平台主管',
        status: 'ACTIVE',
      },
      data: { aliases: ['ROOTGRAPHALIAS-2026'] },
    });
    expect(aliasUpdate.count).toBeGreaterThan(0);
    const directEntitySeedRetrieval = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'ROOTGRAPHALIAS-2026 关系', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(directEntitySeedRetrieval.relationshipCandidateCount).toBeGreaterThan(0);
    expect(directEntitySeedRetrieval.relationshipExpandedCount).toBeGreaterThan(0);
    expect(directEntitySeedRetrieval.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'RELATIONSHIP',
          status: 'APPLIED',
          code: 'KNOWLEDGE_RELATIONSHIP_EXPANSION_APPLIED',
        }),
      ]),
    );

    const secondDraft = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${draft.id}`)
          .set(authorization)
          .send({
            contentText: '# 新制度\n\nDRAFTPOLICYOMEGA 仅在发布后可检索。',
            status: 'READY',
            expectedVersion: firstPublished.documentVersion,
          })
          .expect(200)
      ).body,
    );
    const secondDraftVersion = secondDraft.versions.find((version) => version.versionNumber === 2);
    expect(secondDraftVersion).toMatchObject({
      status: 'PROCESSING',
      chunkCount: 0,
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    if (secondDraftVersion === undefined || firstPublishedVersion === undefined) {
      throw new Error('Expected both publication test versions.');
    }

    const beforeSecondPublish = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'DRAFTPOLICYOMEGA', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(
      beforeSecondPublish.items.some((item) => item.documentVersionId === secondDraftVersion.id),
    ).toBe(false);
    expect(
      beforeSecondPublish.items.some((item) => item.excerpt.includes('DRAFTPOLICYOMEGA')),
    ).toBe(false);

    const secondPublished = await processAndPublishDocument(
      authorization,
      knowledgeBase.id,
      draft.id,
      secondDraftVersion.id,
    );
    expect(secondPublished).toMatchObject({
      currentVersionId: secondDraftVersion.id,
      documentVersion: 2,
      status: 'READY',
    });

    const afterSecondPublish = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'DRAFTPOLICYOMEGA', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(afterSecondPublish.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: draft.id,
          documentVersionId: secondDraftVersion.id,
        }),
      ]),
    );

    const rollbackCandidateDocument = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${draft.id}/versions/${firstPublishedVersion.id}/rollback`,
          )
          .set(authorization)
          .send({ expectedCurrentVersionId: secondDraftVersion.id })
          .expect(201)
      ).body,
    );
    expect(rollbackCandidateDocument).toMatchObject({
      currentVersionId: secondDraftVersion.id,
      documentVersion: 2,
    });
    const rollbackCandidate = rollbackCandidateDocument.versions.find(
      (version) => version.versionNumber === 3,
    );
    if (rollbackCandidate === undefined) {
      throw new Error('Expected a rollback candidate version.');
    }
    const [rollbackClock] = await administrator.$queryRaw<
      Array<{ databaseDefaultClock: boolean; retrievalEligible: boolean }>
    >`
      SELECT
        version."effective_from" = version."created_at" AS "databaseDefaultClock",
        version."effective_from" <= statement_timestamp() AS "retrievalEligible"
      FROM public."knowledge_document_versions" AS version
      WHERE version."tenant_id" = ${tenantId}::uuid
        AND version."id" = ${rollbackCandidate.id}::uuid
    `;
    expect(rollbackClock).toEqual({
      databaseDefaultClock: true,
      retrievalEligible: true,
    });
    const rolledBack = await publishIndexedDocument(
      authorization,
      knowledgeBase.id,
      draft.id,
      rollbackCandidate.id,
    );
    expect(rolledBack.documentVersion).toBe(3);
    expect(rolledBack.currentVersionId).not.toBe(firstPublishedVersion.id);
    expect(rolledBack.currentVersionId).not.toBe(secondDraftVersion.id);
    expect(rolledBack.versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
    const rollbackSnapshot = rolledBack.versions.find(
      (version) => version.id === rolledBack.currentVersionId,
    );
    expect(rollbackSnapshot).toMatchObject({
      versionNumber: 3,
      status: 'READY',
      chunkCount: firstPublishedVersion.chunkCount,
      changeSummary: 'Rollback from current to v1',
    });

    const afterRollbackOldContent = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'LEGACYPOLICYALPHA', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(afterRollbackOldContent.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: draft.id,
          documentVersionId: rolledBack.currentVersionId,
        }),
      ]),
    );
    const afterRollbackNewContent = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: 'DRAFTPOLICYOMEGA', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(
      afterRollbackNewContent.items
        .filter((item) => item.documentId === draft.id)
        .every((item) => item.documentVersionId === rolledBack.currentVersionId),
    ).toBe(true);
    expect(
      afterRollbackNewContent.items.some((item) => item.excerpt.includes('DRAFTPOLICYOMEGA')),
    ).toBe(false);
    const rebuiltGraph = await request(app.getHttpServer())
      .post(
        `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${draft.id}/versions/${rolledBack.currentVersionId}/rebuild-graph`,
      )
      .set(authorization)
      .expect(409);
    expect(rebuiltGraph.body).toMatchObject({
      code: 'CONFLICT',
      message: 'An active graph projection is immutable. Create and govern a new document version.',
    });
    const rollbackGraph = knowledgeGraphResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/graph?limit=50`)
          .set(authorization)
          .expect(200)
      ).body,
    );
    expect(
      rollbackGraph.relations
        .flatMap((relation) => relation.evidence)
        .filter((evidence) => evidence.documentId === draft.id)
        .every((evidence) => evidence.documentVersionId === rolledBack.currentVersionId),
    ).toBe(true);

    const uploadedQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/upload`)
          .set(authorization)
          .field('title', '员工离职账户回收规范')
          .field('changeSummary', '首版试点资料')
          .attach(
            'file',
            Buffer.from(
              '# 账号回收\n\n员工离职后，管理员应在二十四小时内停用企业账号并回收访问权限。',
              'utf8',
            ),
            { filename: 'employee-offboarding.md', contentType: 'text/markdown' },
          )
          .expect(201)
      ).body,
    );
    expect(uploadedQueued).toMatchObject({ status: 'PROCESSING', sourceType: 'FILE' });
    expect(uploadedQueued.versions[0]).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    const uploaded = await processAndPublishDocument(
      authorization,
      knowledgeBase.id,
      uploadedQueued.id,
      uploadedQueued.versions[0]?.id,
    );

    expect(uploaded).toMatchObject({
      status: 'READY',
      sourceType: 'FILE',
      documentVersion: 1,
    });
    expect(uploaded.currentVersionId).toBe(uploaded.versions[0]?.id);
    expect(uploaded.versions[0]).toMatchObject({
      status: 'READY',
      chunkCount: 1,
      ingestionJob: { status: 'SUCCEEDED', stage: 'READY', progress: 100 },
    });

    const retrieval = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: '员工离职后如何回收企业账号', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(retrieval.noAnswer).toBe(false);
    expect(retrieval.accessibleKnowledgeBaseIds).toEqual([knowledgeBase.id]);
    expect(retrieval.items[0]).toMatchObject({
      documentId: uploaded.id,
      documentVersionId: uploaded.currentVersionId,
      title: '员工离职账户回收规范',
      headingPath: ['账号回收'],
    });

    const revisedQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${uploaded.id}/versions/upload`,
          )
          .set(authorization)
          .field('changeSummary', '更新账号回收时限')
          .attach(
            'file',
            Buffer.from(
              '# 账号回收\n\n员工离职后，管理员应在十二小时内停用企业账号并回收访问权限。',
              'utf8',
            ),
            { filename: 'employee-offboarding-2026.md', contentType: 'text/markdown' },
          )
          .expect(201)
      ).body,
    );
    const queuedRevision = revisedQueued.versions.find((version) => version.versionNumber === 2);
    expect(queuedRevision).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    const revised = await processAndPublishDocument(
      authorization,
      knowledgeBase.id,
      uploaded.id,
      queuedRevision?.id,
    );
    expect(revised).toMatchObject({
      id: uploaded.id,
      status: 'READY',
      sourceType: 'FILE',
      documentVersion: 2,
      fileName: 'employee-offboarding-2026.md',
    });
    expect(revised.currentVersionId).not.toBe(uploaded.currentVersionId);
    expect(revised.versions.map((version) => version.versionNumber)).toEqual([2, 1]);

    const revisedVersion = revised.versions.find(
      (version) => version.id === revised.currentVersionId,
    );
    if (revisedVersion === undefined) throw new Error('Expected the current revised version.');
    await administrator.knowledgeDocumentVersion.update({
      where: { id: revisedVersion.id },
      data: { status: 'FAILED' },
    });
    const retryPath = `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${revised.id}/versions/${revisedVersion.id}/retry`;
    const [retryA, retryB] = await Promise.all([
      request(app.getHttpServer()).post(retryPath).set(authorization),
      request(app.getHttpServer()).post(retryPath).set(authorization),
    ]);
    expect([retryA.status, retryB.status].sort()).toEqual([201, 409]);
    const successfulRetry = retryA.status === 201 ? retryA : retryB;
    const conflictedRetry = retryA.status === 409 ? retryA : retryB;
    expect(knowledgeDocumentSchema.parse(successfulRetry.body).versions[0]).toMatchObject({
      id: revisedVersion.id,
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    expect(conflictedRetry.body).toMatchObject({
      code: 'CONFLICT',
      message: 'The document version is already being processed.',
    });
    const retried = await processDocument(
      authorization,
      knowledgeBase.id,
      revised.id,
      revisedVersion.id,
    );
    expect(retried.versions[0]).toMatchObject({
      id: revisedVersion.id,
      status: 'READY',
      ingestionJob: { status: 'SUCCEEDED', attempts: 1 },
    });

    const archived = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .delete(
            `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${uploaded.id}?expectedVersion=${revised.documentVersion}`,
          )
          .set(authorization)
          .expect(200)
      ).body,
    );
    expect(archived).toMatchObject({ status: 'ARCHIVED', documentVersion: 2 });

    const afterArchive = knowledgeRetrievalTestResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/retrieval-test`)
          .set(authorization)
          .send({ query: '员工离职后如何回收企业账号', limit: 8 })
          .expect(201)
      ).body,
    );
    expect(afterArchive).toMatchObject({ noAnswer: true, items: [] });

    const failedUploadQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/upload`)
          .set(authorization)
          .field('title', '无法解析的文件')
          .attach('file', Buffer.from('unsupported document', 'utf8'), {
            filename: 'unsupported.bin',
            contentType: 'application/octet-stream',
          })
          .expect(201)
      ).body,
    );
    const failedUpload = await processDocument(
      authorization,
      knowledgeBase.id,
      failedUploadQueued.id,
      failedUploadQueued.versions[0]?.id,
    );
    const failedVersion = failedUpload.versions[0];
    expect(failedUpload.status).toBe('FAILED');
    expect(failedVersion).toMatchObject({
      status: 'FAILED',
      ingestionJob: { status: 'FAILED', attempts: 1 },
    });
    if (failedVersion === undefined) throw new Error('Expected a failed document version.');

    const storedFailedVersion = await administrator.knowledgeDocumentVersion.findUniqueOrThrow({
      where: { id: failedVersion.id },
      select: { objectKey: true },
    });
    if (storedFailedVersion.objectKey === null) throw new Error('Expected a stored source object.');
    await new LocalKnowledgeObjectStore().delete(storedFailedVersion.objectKey);

    const failedRetryQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${failedUpload.id}/versions/${failedVersion.id}/retry`,
          )
          .set(authorization)
          .expect(201)
      ).body,
    );
    expect(failedRetryQueued.versions[0]).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    const failedRetry = await processDocument(
      authorization,
      knowledgeBase.id,
      failedUpload.id,
      failedVersion.id,
    );
    expect(failedRetry.status).toBe('FAILED');
    expect(failedRetry.versions[0]).toMatchObject({
      status: 'FAILED',
      ingestionJob: { status: 'FAILED', attempts: 1 },
    });
  });

  async function processAndPublishDocument(
    authorization: Record<string, string>,
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string | undefined,
  ) {
    await processDocument(authorization, knowledgeBaseId, documentId, documentVersionId);
    return publishIndexedDocument(authorization, knowledgeBaseId, documentId, documentVersionId);
  }

  async function publishIndexedDocument(
    authorization: Record<string, string>,
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string | undefined,
  ) {
    if (documentVersionId === undefined) throw new Error('Expected a document version id.');
    return knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/versions/${documentVersionId}/publish`,
          )
          .set(authorization)
          .send({})
          .expect(201)
      ).body,
    );
  }

  async function processDocument(
    authorization: Record<string, string>,
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string | undefined,
  ) {
    if (documentVersionId === undefined) throw new Error('Expected a document version id.');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      // The repository uses a separate worker connection. Poll the target
      // version instead of assuming its just-committed queue row must be the
      // first row visible to a single immediate claim.
      await worker.runOnce();
      const document = knowledgeDocumentSchema.parse(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/admin/knowledge-bases/${knowledgeBaseId}/documents/${documentId}`)
            .set(authorization)
            .expect(200)
        ).body,
      );
      const version = document.versions.find((candidate) => candidate.id === documentVersionId);
      if (version !== undefined && version.status !== 'PROCESSING') return document;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Document version ${documentVersionId} did not reach a terminal state.`);
  }
});

function createQueueClient(): OutboxPrismaService {
  return new OutboxPrismaService(createWorkerConfig());
}

function createWorkerConfig(): ConfigService<EnvironmentVariables, true> {
  const databaseUrl =
    process.env.DATABASE_URL ??
    (enabled ? undefined : 'postgresql://skipped:skipped@127.0.0.1:1/skipped');
  const values = validateEnvironment({
    NODE_ENV: 'test',
    REPOSITORY_DRIVER: 'prisma',
    DATABASE_URL: databaseUrl,
    OUTBOX_DATABASE_URL: process.env.OUTBOX_DATABASE_URL ?? databaseUrl,
    KNOWLEDGE_INGESTION_WORKER_ENABLED: 'true',
    KNOWLEDGE_INGESTION_BATCH_SIZE: '1',
    KNOWLEDGE_INGESTION_MAX_ATTEMPTS: '1',
    KNOWLEDGE_INGESTION_RETRY_BASE_MS: '1',
    KNOWLEDGE_INGESTION_RETRY_MAX_MS: '1',
  });
  return new ConfigService<EnvironmentVariables, true>(values);
}

async function cleanup(administrator: PrismaClient): Promise<void> {
  const tenant = await administrator.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true },
  });
  if (tenant === null) return;
  const tenantId = tenant.id;

  const storedVersions = await administrator.knowledgeDocumentVersion.findMany({
    where: { tenantId, objectKey: { not: null } },
    select: { objectKey: true },
  });
  const objects = new LocalKnowledgeObjectStore();
  for (const version of storedVersions) {
    if (version.objectKey !== null) await objects.delete(version.objectKey);
  }

  await cleanupDisposableTenants(administrator, [tenantId]);
}
