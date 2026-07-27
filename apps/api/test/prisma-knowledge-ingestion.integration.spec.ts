import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  authSessionResponseSchema,
  knowledgeBaseSchema,
  knowledgeDocumentSchema,
  knowledgeRetrievalTestResponseSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import { validateEnvironment, type EnvironmentVariables } from '../src/config/environment.js';
import { OutboxPrismaService } from '../src/database/outbox-prisma.service.js';
import { KnowledgeIngestionProcessor } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeIngestionWorker } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.worker.js';
import { PrismaKnowledgeIngestionJobRepository } from '../src/modules/knowledge-ingestion/infrastructure/prisma-knowledge-ingestion-job.repository.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import { LocalKnowledgeObjectStore } from '../src/modules/knowledge-ingestion/infrastructure/local-knowledge-object.store.js';

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

    const draft = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
          .set(authorization)
          .send({
            title: '待审核草稿',
            sourceType: 'MARKDOWN',
            contentText: '# 草稿\n\nLEGACYPOLICYALPHA 尚未发布的内容。',
            status: 'DRAFT',
          })
          .expect(201)
      ).body,
    );
    expect(draft).toMatchObject({ status: 'DRAFT', currentVersionId: null });
    expect(draft.versions[0]).toMatchObject({
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
    expect(beforeDraftPublish.items.some((item) => item.documentId === draft.id)).toBe(false);

    const firstQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${draft.id}/versions/${draft.versions[0]?.id}/publish`,
          )
          .set(authorization)
          .expect(201)
      ).body,
    );
    expect(firstQueued.versions[0]).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    const firstPublished = await processDocument(
      authorization,
      knowledgeBase.id,
      draft.id,
      draft.versions[0]?.id,
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

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}`)
      .set(authorization)
      .send({ status: 'ACTIVE', expectedVersion: knowledgeBase.version })
      .expect(409);
    // This ingestion/RLS fixture deliberately runs without an external
    // Embedding or Reranker provider, so the enterprise readiness gate must
    // reject API activation. Promote only the isolated fixture directly to
    // continue exercising lexical retrieval and version publication below.
    await administrator.knowledgeBase.update({
      where: { id: knowledgeBase.id },
      data: { status: 'ACTIVE' },
    });

    const secondDraft = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${draft.id}`)
          .set(authorization)
          .send({
            contentText: '# 新制度\n\nDRAFTPOLICYOMEGA 仅在发布后可检索。',
            status: 'DRAFT',
            expectedVersion: firstPublished.documentVersion,
          })
          .expect(200)
      ).body,
    );
    const secondDraftVersion = secondDraft.versions.find((version) => version.versionNumber === 2);
    expect(secondDraftVersion).toMatchObject({ status: 'DRAFT', chunkCount: 0 });
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

    const secondQueued = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${draft.id}/versions/${secondDraftVersion.id}/publish`,
          )
          .set(authorization)
          .expect(201)
      ).body,
    );
    expect(
      secondQueued.versions.find((version) => version.id === secondDraftVersion.id),
    ).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    const secondPublished = await processDocument(
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

    const rolledBack = knowledgeDocumentSchema.parse(
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
    const uploaded = await processDocument(
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
    const revised = await processDocument(
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

  async function processDocument(
    authorization: Record<string, string>,
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string | undefined,
  ) {
    if (documentVersionId === undefined) throw new Error('Expected a document version id.');
    await expect(worker.runOnce()).resolves.toBe(1);
    for (let attempt = 0; attempt < 20; attempt += 1) {
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

  await administrator.directoryEmploymentBinding.deleteMany({ where: { tenantId } });
  await administrator.directoryOrgUnitBinding.deleteMany({ where: { tenantId } });
  await administrator.directoryUserBinding.deleteMany({ where: { tenantId } });
  await administrator.directoryIntegration.deleteMany({ where: { tenantId } });
  await administrator.agentRun.deleteMany({ where: { tenantId } });
  await administrator.outboxEvent.deleteMany({ where: { tenantId } });
  await administrator.message.deleteMany({ where: { tenantId } });
  await administrator.conversationParticipant.deleteMany({ where: { tenantId } });
  await administrator.conversation.deleteMany({ where: { tenantId } });
  await administrator.agentInstance.deleteMany({ where: { tenantId } });
  await administrator.agentVersion.deleteMany({ where: { tenantId } });
  await administrator.agentTemplate.deleteMany({ where: { tenantId } });
  await administrator.knowledgeIngestionJob.deleteMany({ where: { tenantId } });
  await administrator.knowledgeChunk.deleteMany({ where: { tenantId } });
  await administrator.knowledgeDocument.updateMany({
    where: { tenantId },
    data: { currentVersionId: null },
  });
  await administrator.knowledgeDocumentVersion.deleteMany({ where: { tenantId } });
  await administrator.knowledgeDocument.deleteMany({ where: { tenantId } });
  await administrator.knowledgeBaseOrgUnit.deleteMany({ where: { tenantId } });
  await administrator.knowledgeBase.deleteMany({ where: { tenantId } });
  await administrator.auditEvent.deleteMany({ where: { tenantId } });
  await administrator.managerRelation.deleteMany({ where: { tenantId } });
  await administrator.employment.deleteMany({ where: { tenantId } });
  await administrator.position.deleteMany({ where: { tenantId } });
  await administrator.authSession.deleteMany({ where: { tenantId } });
  await administrator.passwordCredential.deleteMany({ where: { tenantId } });
  await administrator.orgUnit.deleteMany({ where: { tenantId } });
  await administrator.organization.deleteMany({ where: { tenantId } });
  await administrator.user.deleteMany({ where: { tenantId } });
  await administrator.tenant.delete({ where: { id: tenantId } });
}
