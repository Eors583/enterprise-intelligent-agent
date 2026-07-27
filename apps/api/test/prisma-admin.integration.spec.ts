import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  adminOrganizationResponseSchema,
  authSessionResponseSchema,
  bootstrapResponseSchema,
  changePasswordResponseSchema,
  feishuOrganizationSyncStatusSchema,
  knowledgeBaseListResponseSchema,
  knowledgeBaseSchema,
  knowledgeDocumentSchema,
  resetMemberPasswordResponseSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import { validateEnvironment, type EnvironmentVariables } from '../src/config/environment.js';
import { OutboxPrismaService } from '../src/database/outbox-prisma.service.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import { FeishuDirectoryClient } from '../src/modules/admin/feishu/feishu-directory.client.js';
import type { FeishuDirectorySnapshot } from '../src/modules/admin/feishu/feishu-directory.models.js';
import { KnowledgeIngestionProcessor } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeIngestionWorker } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.worker.js';
import { PrismaKnowledgeIngestionJobRepository } from '../src/modules/knowledge-ingestion/infrastructure/prisma-knowledge-ingestion-job.repository.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantSlug = 'admin-http-integration';
const ownerEmail = 'owner@admin-http.integration';
const memberEmail = 'member@admin-http.integration';
const password = 'IntegrationPassword!2026';
const importedPassword = '1234567890';
const changedImportedPassword = 'AliceChangedPassword!2026';
const memberTemporaryPassword = 'MemberTemporaryPassword!2026';
const changedMemberPassword = 'MemberChangedPassword!2026';

describe.runIf(enabled)('PostgreSQL admin HTTP integration', () => {
  const administrator = new PrismaClient();
  const queueClient = createQueueClient();
  let app: INestApplication;
  let knowledgeWorker: KnowledgeIngestionWorker;
  let accessToken: string;
  let feishuSnapshot: FeishuDirectorySnapshot;

  beforeAll(async () => {
    await cleanup();
    app = await createTestApp();
    await queueClient.onModuleInit();
    knowledgeWorker = new KnowledgeIngestionWorker(
      createWorkerConfig(),
      new PrismaKnowledgeIngestionJobRepository(queueClient),
      app.get(KnowledgeIngestionProcessor),
    );
    feishuSnapshot = {
      departments: [
        { externalId: '0', name: '飞书测试企业', parentExternalId: null, sortOrder: 0 },
        { externalId: 'od-engineering', name: '飞书研发部', parentExternalId: '0', sortOrder: 10 },
        {
          externalId: 'od-platform',
          name: '平台工程组',
          parentExternalId: 'od-engineering',
          sortOrder: 20,
        },
      ],
      users: [
        {
          externalId: 'ou-alice',
          openId: 'open-alice',
          unionId: 'union-alice',
          name: '飞书成员 Alice',
          email: memberEmail,
          active: true,
          departmentExternalIds: ['od-engineering', 'od-platform'],
          primaryDepartmentExternalId: 'od-platform',
          employeeNumber: 'FS-0001',
          jobTitle: '平台工程师',
        },
        {
          externalId: 'ou-no-email',
          name: '无邮箱成员',
          active: true,
          departmentExternalIds: ['od-engineering'],
          primaryDepartmentExternalId: 'od-engineering',
          jobTitle: '研发工程师',
        },
      ],
    };
    vi.spyOn(app.get(FeishuDirectoryClient), 'fetchSnapshot').mockImplementation(
      async () => feishuSnapshot,
    );
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await queueClient.onModuleDestroy();
    await cleanup();
    await administrator.$disconnect();
  });

  it('registers an owner and administers live directory and knowledge data', async () => {
    const registration = await request(app.getHttpServer())
      .post('/api/v1/auth/register-tenant')
      .send({
        tenantName: 'Admin HTTP Integration',
        tenantSlug,
        organizationName: 'Admin HTTP Integration Organization',
        displayName: 'Integration Owner',
        email: ownerEmail,
        password,
        sessionLabel: 'database integration',
      })
      .expect(201);
    const session = authSessionResponseSchema.parse(registration.body);
    accessToken = session.accessToken;
    const ownerEmployment = await administrator.employment.findFirstOrThrow({
      where: { userId: session.account.userId },
      select: { isPrimary: true },
    });
    expect(ownerEmployment.isPrimary).toBe(true);

    const initial = await request(app.getHttpServer())
      .get('/api/v1/admin/organization')
      .set(bearer(accessToken))
      .expect(200);
    const organization = adminOrganizationResponseSchema.parse(initial.body);
    const root = organization.orgUnits.find((unit) => unit.parentId === null);
    expect(root).toBeDefined();

    const createdUnit = await request(app.getHttpServer())
      .post('/api/v1/admin/org-units')
      .set(bearer(accessToken))
      .send({ name: 'Integration Department', parentId: root!.id, sortOrder: 10 })
      .expect(201);
    const orgUnitId = String(createdUnit.body.id);
    expect(createdUnit.body.parentId).toBe(root!.id);

    const createdMember = await request(app.getHttpServer())
      .post('/api/v1/admin/members')
      .set(bearer(accessToken))
      .send({
        email: memberEmail,
        displayName: 'Integration Member',
        password,
        role: 'MEMBER',
        orgUnitId,
        title: 'Integration Engineer',
      })
      .expect(201);
    expect(createdMember.body.employment.orgUnitId).toBe(orgUnitId);
    await expect(
      administrator.passwordCredential.findUniqueOrThrow({
        where: { userId: String(createdMember.body.id) },
        select: { mustChangePassword: true },
      }),
    ).resolves.toEqual({ mustChangePassword: true });

    const bootstrap = await request(app.getHttpServer())
      .get('/api/v1/bootstrap')
      .set(bearer(accessToken))
      .expect(200);
    const liveDirectory = bootstrapResponseSchema.parse(bootstrap.body);
    expect(liveDirectory.departments.some((unit) => unit.id === orgUnitId)).toBe(true);
    expect(liveDirectory.members.some((member) => member.name === 'Integration Member')).toBe(true);

    const createdKnowledgeBase = await request(app.getHttpServer())
      .post('/api/v1/admin/knowledge-bases')
      .set(bearer(accessToken))
      .send({
        key: 'integration-handbook',
        name: 'Integration Handbook',
        description: 'Database-backed knowledge management integration.',
        // Enterprise activation is a separate, readiness-gated operation.
        status: 'DRAFT',
        orgUnitIds: [orgUnitId],
      })
      .expect(201);
    const knowledgeBase = knowledgeBaseSchema.parse(createdKnowledgeBase.body);

    const createdDocument = await request(app.getHttpServer())
      .post(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents`)
      .set(bearer(accessToken))
      .send({
        title: 'Engineering Handbook',
        sourceType: 'MARKDOWN',
        contentText: '# Engineering\n\nDatabase-backed content.',
        status: 'READY',
      })
      .expect(201);
    const queuedDocument = knowledgeDocumentSchema.parse(createdDocument.body);
    expect(queuedDocument.versions[0]).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    await expect(knowledgeWorker.runOnce()).resolves.toBe(1);
    const document = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${queuedDocument.id}`)
          .set(bearer(accessToken))
          .expect(200)
      ).body,
    );
    expect(document.versions[0]).toMatchObject({
      status: 'READY',
      ingestionJob: { status: 'SUCCEEDED', attempts: 1 },
    });
    expect(document.checksum).toMatch(/^[a-f0-9]{64}$/);

    const updatedDocument = await request(app.getHttpServer())
      .patch(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${document.id}`)
      .set(bearer(accessToken))
      .send({
        title: 'Engineering Handbook v2',
        contentText: '# Engineering\n\nUpdated database-backed content.',
        expectedVersion: document.documentVersion,
      })
      .expect(200);
    const queuedUpdate = knowledgeDocumentSchema.parse(updatedDocument.body);
    expect(queuedUpdate.documentVersion).toBe(1);
    expect(queuedUpdate.versions.find((version) => version.versionNumber === 2)).toMatchObject({
      status: 'PROCESSING',
      ingestionJob: { status: 'PENDING', attempts: 0 },
    });
    await expect(knowledgeWorker.runOnce()).resolves.toBe(1);
    const updated = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${document.id}`)
          .set(bearer(accessToken))
          .expect(200)
      ).body,
    );
    expect(updated.documentVersion).toBe(2);

    await request(app.getHttpServer())
      .delete(
        `/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${document.id}?expectedVersion=2`,
      )
      .set(bearer(accessToken))
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('ARCHIVED'));

    const listedKnowledge = await request(app.getHttpServer())
      .get('/api/v1/admin/knowledge-bases')
      .set(bearer(accessToken))
      .expect(200);
    const listed = knowledgeBaseListResponseSchema.parse(listedKnowledge.body);
    expect(listed.items[0]?.documents[0]?.status).toBe('ARCHIVED');

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/org-units/${orgUnitId}?expectedVersion=1`)
      .set(bearer(accessToken))
      .expect(409);

    const memberLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: memberEmail, password, sessionLabel: 'permission check' })
      .expect(200);
    const memberSession = authSessionResponseSchema.parse(memberLogin.body);
    expect(memberSession.account.passwordChangeRequired).toBe(true);
    await request(app.getHttpServer())
      .get('/api/v1/admin/organization')
      .set(bearer(memberSession.accessToken))
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/members/${session.account.userId}/reset-password`)
      .set(bearer(accessToken))
      .send({ temporaryPassword: memberTemporaryPassword })
      .expect(400);

    const resetPassword = await request(app.getHttpServer())
      .post(`/api/v1/admin/members/${createdMember.body.id}/reset-password`)
      .set(bearer(accessToken))
      .send({ temporaryPassword: memberTemporaryPassword })
      .expect(200);
    expect(resetMemberPasswordResponseSchema.parse(resetPassword.body)).toEqual({
      memberId: createdMember.body.id,
      passwordChangeRequired: true,
      revokedSessionCount: 1,
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(bearer(memberSession.accessToken))
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: memberEmail, password })
      .expect(401);

    const temporaryLogin = authSessionResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({
            tenantSlug,
            email: memberEmail,
            password: memberTemporaryPassword,
            sessionLabel: 'reset credential',
          })
          .expect(200)
      ).body,
    );
    expect(temporaryLogin.account.passwordChangeRequired).toBe(true);
    const changedMember = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set(bearer(temporaryLogin.accessToken))
      .send({
        currentPassword: memberTemporaryPassword,
        newPassword: changedMemberPassword,
      })
      .expect(200);
    expect(changePasswordResponseSchema.parse(changedMember.body)).toMatchObject({
      account: { passwordChangeRequired: false },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/members/${session.account.userId}/reset-password`)
      .set(bearer(temporaryLogin.accessToken))
      .send({ temporaryPassword: memberTemporaryPassword })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: memberEmail, password: memberTemporaryPassword })
      .expect(401);

    const passwordResetAudit = await administrator.auditEvent.findFirstOrThrow({
      where: {
        tenantId: session.account.tenantId,
        action: 'admin.member.password_reset',
        resourceId: String(createdMember.body.id),
      },
      orderBy: { occurredAt: 'desc' },
      select: { metadata: true },
    });
    expect(passwordResetAudit.metadata).toEqual({
      passwordChangeRequired: true,
      revokedSessionCount: 1,
    });
    expect(JSON.stringify(passwordResetAudit)).not.toContain(memberTemporaryPassword);

    const initialFeishuStatus = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(200);
    expect(feishuOrganizationSyncStatusSchema.parse(initialFeishuStatus.body).status).toBe('READY');

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('RUNNING'));
    const firstSync = await waitForFeishuSync();
    expect(firstSync.status).toBe('SUCCEEDED');
    expect(firstSync.run?.departments.created).toBe(2);
    expect(firstSync.run?.members.created).toBe(2);
    const tenant = await administrator.tenant.findUniqueOrThrow({
      where: { slug: tenantSlug },
      select: { id: true },
    });

    const synchronized = adminOrganizationResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/admin/organization')
          .set(bearer(accessToken))
          .expect(200)
      ).body,
    );
    const platformDepartment = synchronized.orgUnits.find((unit) => unit.name === '平台工程组');
    const alice = synchronized.members.find((member) => member.displayName === '飞书成员 Alice');
    expect(platformDepartment?.source).toBe('FEISHU');
    expect(alice?.source).toBe('FEISHU');
    expect(alice?.email).toBe(memberEmail);
    expect(alice?.employment?.orgUnitId).toBe(platformDepartment?.id);
    expect(alice?.id).not.toBe(createdMember.body.id);

    const aliceBinding = await administrator.directoryUserBinding.findFirstOrThrow({
      where: { tenantId: tenant.id, externalUserId: 'ou-alice' },
      include: {
        user: {
          include: {
            passwordCredential: true,
            employments: {
              where: { status: 'ACTIVE' },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
      },
    });
    expect(aliceBinding.user.email).toMatch(/^feishu-[a-f0-9]{32}@external\.invalid$/);
    expect(aliceBinding.user.email).not.toBe(memberEmail);
    expect(aliceBinding.user.passwordCredential).toMatchObject({ mustChangePassword: true });
    expect(aliceBinding.user.employments).toHaveLength(2);
    expect(aliceBinding.user.employments.filter((employment) => employment.isPrimary)).toHaveLength(
      1,
    );

    const importedLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: aliceBinding.user.email,
        password: importedPassword,
        sessionLabel: 'Feishu first login',
      })
      .expect(200);
    const importedSession = authSessionResponseSchema.parse(importedLogin.body);
    expect(importedSession.account.role).toBe('MEMBER');
    expect(importedSession.account.passwordChangeRequired).toBe(true);
    const changedPassword = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set(bearer(importedSession.accessToken))
      .send({ currentPassword: importedPassword, newPassword: changedImportedPassword })
      .expect(200);
    expect(changePasswordResponseSchema.parse(changedPassword.body)).toMatchObject({
      account: { passwordChangeRequired: false },
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/org-units/${platformDepartment!.id}`)
      .set(bearer(accessToken))
      .send({ name: '不应允许本地改名', expectedVersion: platformDepartment!.version })
      .expect(409);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${alice!.id}`)
      .set(bearer(accessToken))
      .send({ displayName: '不应允许本地改名' })
      .expect(409);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${alice!.id}`)
      .set(bearer(accessToken))
      .send({ role: 'KNOWLEDGE_ADMIN' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.role).toBe('KNOWLEDGE_ADMIN');
        expect(body.displayName).toBe('飞书成员 Alice');
      });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${alice!.id}`)
      .set(bearer(accessToken))
      .send({ role: 'OWNER' })
      .expect(409);

    const synchronizedBootstrap = bootstrapResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/bootstrap')
          .set(bearer(accessToken))
          .expect(200)
      ).body,
    );
    expect(synchronizedBootstrap.departments.some((unit) => unit.name === '飞书研发部')).toBe(true);
    expect(synchronizedBootstrap.members.some((member) => member.name === '飞书成员 Alice')).toBe(
      true,
    );
    const bootstrapAlice = synchronizedBootstrap.members.find(
      (member) => member.name === '飞书成员 Alice',
    );
    const synchronizedDepartmentIds = synchronized.orgUnits
      .filter((unit) => unit.name === '飞书研发部' || unit.name === '平台工程组')
      .map((unit) => unit.id)
      .sort();
    expect([...(bootstrapAlice?.departmentIds ?? [])].sort()).toEqual(synchronizedDepartmentIds);

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(201);
    const secondSync = await waitForFeishuSync();
    expect(secondSync.status).toBe('SUCCEEDED');
    expect(secondSync.run?.departments.created).toBe(0);
    expect(secondSync.run?.members).toEqual({
      created: 0,
      updated: 0,
      deactivated: 0,
      unchanged: 2,
      failed: 0,
    });
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: aliceBinding.user.email, password: importedPassword })
      .expect(401);
    const relogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: aliceBinding.user.email, password: changedImportedPassword })
      .expect(200);
    expect(authSessionResponseSchema.parse(relogin.body).account.passwordChangeRequired).toBe(
      false,
    );

    feishuSnapshot = {
      departments: [
        { externalId: '0', name: '飞书测试企业', parentExternalId: null, sortOrder: 0 },
        { externalId: 'od-engineering', name: '飞书研发部', parentExternalId: '0', sortOrder: 10 },
      ],
      users: [
        {
          externalId: 'ou-alice',
          openId: 'open-alice',
          unionId: 'union-alice',
          name: '飞书成员 Alice',
          email: memberEmail,
          active: true,
          departmentExternalIds: ['od-engineering'],
          primaryDepartmentExternalId: 'od-engineering',
          employeeNumber: 'FS-0001',
          jobTitle: '平台工程师',
        },
      ],
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(201);
    const pendingRemoval = await waitForFeishuSync();
    expect(pendingRemoval.status).toBe('SUCCEEDED');
    expect(pendingRemoval.run?.departments.archived).toBe(0);
    expect(pendingRemoval.run?.members.deactivated).toBe(0);

    const confirmedMissingSince = new Date(Date.now() - 2 * 60 * 60_000);
    await administrator.directoryEmploymentBinding.updateMany({
      where: { tenantId: tenant.id, missingSinceAt: { not: null } },
      data: { missingSinceAt: confirmedMissingSince },
    });
    await administrator.directoryUserBinding.updateMany({
      where: { tenantId: tenant.id, missingSinceAt: { not: null } },
      data: { missingSinceAt: confirmedMissingSince },
    });
    await administrator.directoryOrgUnitBinding.updateMany({
      where: { tenantId: tenant.id, missingSinceAt: { not: null } },
      data: { missingSinceAt: confirmedMissingSince },
    });

    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(201);
    const confirmedRemoval = await waitForFeishuSync();
    expect(confirmedRemoval.status).toBe('SUCCEEDED');
    expect(confirmedRemoval.run?.departments.archived).toBe(1);
    expect(confirmedRemoval.run?.members.deactivated).toBe(1);

    const removedMember = await administrator.user.findFirstOrThrow({
      where: { tenantId: tenant.id, displayName: '无邮箱成员' },
      select: { status: true },
    });
    expect(removedMember.status).toBe('INACTIVE');
    const afterRemoval = bootstrapResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/bootstrap')
          .set(bearer(accessToken))
          .expect(200)
      ).body,
    );
    expect(afterRemoval.departments.some((unit) => unit.name === '平台工程组')).toBe(false);
    const integration = await administrator.directoryIntegration.findFirstOrThrow({
      where: { tenantId: tenant.id, provider: 'FEISHU' },
      select: { id: true, connectorFingerprint: true },
    });
    expect(integration.connectorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await administrator.directoryIntegration.update({
      where: { id: integration.id },
      data: { connectorFingerprint: null },
    });
    const legacyFingerprintStatus = await request(app.getHttpServer())
      .get('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(200);
    expect(feishuOrganizationSyncStatusSchema.parse(legacyFingerprintStatus.body).status).toBe(
      'SUCCEEDED',
    );
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(201);
    expect((await waitForFeishuSync()).status).toBe('SUCCEEDED');
    await administrator.directoryIntegration.update({
      where: { id: integration.id },
      data: { connectorFingerprint: integration.connectorFingerprint },
    });

    const rootDepartment = synchronized.orgUnits.find((unit) => unit.parentId === null);
    expect(rootDepartment).toBeDefined();
    const unownedEmployment = await administrator.employment.create({
      data: {
        tenantId: tenant.id,
        userId: aliceBinding.userId,
        organizationId: synchronized.organization.id,
        orgUnitId: rootDepartment!.id,
        status: 'ACTIVE',
        isPrimary: false,
      },
    });
    feishuSnapshot = {
      ...feishuSnapshot,
      users: feishuSnapshot.users.map((user) =>
        user.externalId === 'ou-alice'
          ? { ...user, departmentExternalIds: ['od-engineering', '0'] }
          : user,
      ),
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync')
      .set(bearer(accessToken))
      .expect(201);
    const ownershipConflict = await waitForFeishuSync();
    expect(ownershipConflict.status).toBe('FAILED');
    expect(ownershipConflict.run?.errorMessage).toBeTruthy();
    await expect(
      administrator.directoryEmploymentBinding.count({
        where: { tenantId: tenant.id, employmentId: unownedEmployment.id },
      }),
    ).resolves.toBe(0);
    await expect(
      administrator.employment.findUniqueOrThrow({ where: { id: unownedEmployment.id } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', isPrimary: false });
  });

  function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  async function waitForFeishuSync() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/integrations/feishu/organization-sync')
        .set(bearer(accessToken))
        .expect(200);
      const status = feishuOrganizationSyncStatusSchema.parse(response.body);
      if (status.status !== 'RUNNING') return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for Feishu directory synchronization.');
  }

  async function cleanup(): Promise<void> {
    const tenant = await administrator.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    if (!tenant) return;
    const tenantId = tenant.id;
    await administrator.directoryEmploymentBinding.deleteMany({ where: { tenantId } });
    await administrator.directoryOrgUnitBinding.deleteMany({ where: { tenantId } });
    await administrator.directoryUserBinding.deleteMany({ where: { tenantId } });
    await administrator.directoryIntegration.deleteMany({ where: { tenantId } });
    await administrator.authSession.deleteMany({ where: { tenantId } });
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
    await administrator.passwordCredential.deleteMany({ where: { tenantId } });
    await administrator.orgUnit.deleteMany({ where: { tenantId } });
    await administrator.organization.deleteMany({ where: { tenantId } });
    await administrator.user.deleteMany({ where: { tenantId } });
    await administrator.tenant.delete({ where: { id: tenantId } });
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
  });
  return new ConfigService<EnvironmentVariables, true>(values);
}
