import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  adminOrganizationResponseSchema,
  authSessionResponseSchema,
  bootstrapResponseSchema,
  changePasswordResponseSchema,
  feishuDirectorySyncRunListSchema,
  feishuOrganizationSyncStatusSchema,
  issueMemberInvitationResponseSchema,
  knowledgeBaseListResponseSchema,
  knowledgeBaseSchema,
  knowledgeDocumentSchema,
  resetMemberPasswordResponseSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import { validateEnvironment, type EnvironmentVariables } from '../src/config/environment.js';
import { OutboxPrismaService } from '../src/database/outbox-prisma.service.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import { KnowledgeIngestionAvailabilityService } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion-availability.service.js';
import { FeishuDirectoryClient } from '../src/modules/admin/feishu/feishu-directory.client.js';
import { FeishuDirectorySyncWorker } from '../src/modules/admin/feishu-directory-sync.worker.js';
import type { FeishuDirectorySnapshot } from '../src/modules/admin/feishu/feishu-directory.models.js';
import { KnowledgeIngestionProcessor } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeIngestionWorker } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.worker.js';
import { PrismaKnowledgeIngestionJobRepository } from '../src/modules/knowledge-ingestion/infrastructure/prisma-knowledge-ingestion-job.repository.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantSlug = 'admin-http-integration';
const ownerEmail = 'owner@admin-http.integration';
const memberEmail = 'member@admin-http.integration';
const importedRemoteEmail = 'alice.remote@admin-http.integration';
const importedLoginEmail = 'alice.login@admin-http.integration';
const importedChangedEmail = 'alice.changed@admin-http.integration';
const password = 'IntegrationPassword!2026';
const legacySharedImportedPassword = '1234567890';
const activatedImportedPassword = 'AliceActivatedPassword!2026';
const memberTemporaryPassword = 'MemberTemporaryPassword!2026';
const changedMemberPassword = 'MemberChangedPassword!2026';

type FeishuSyncCounters = {
  readonly departments: {
    readonly created: number;
    readonly updated: number;
    readonly archived: number;
    readonly unchanged: number;
    readonly failed: number;
  };
  readonly members: {
    readonly created: number;
    readonly updated: number;
    readonly deactivated: number;
    readonly unchanged: number;
    readonly failed: number;
  };
  readonly conflictCount: number;
};

describe.runIf(enabled)('PostgreSQL admin HTTP integration', () => {
  const administrator = new PrismaClient();
  const queueClient = createQueueClient();
  let app: INestApplication;
  let feishuWorker: FeishuDirectorySyncWorker;
  let knowledgeWorker: KnowledgeIngestionWorker;
  let accessToken: string;
  let feishuSnapshot: FeishuDirectorySnapshot;
  let feishuSyncRequestSequence = 0;

  beforeAll(async () => {
    await cleanup();
    // The database runner intentionally enables a low authentication throttle
    // for prisma-auth. This suite verifies member lifecycle instead, so replace
    // only the limiter boundary rather than sharing that mutable test fixture.
    app = await createTestApp({ loginAttemptLimiter: disabledLoginAttemptLimiter() });
    feishuWorker = await app.resolve(FeishuDirectorySyncWorker);
    await queueClient.onModuleInit();
    knowledgeWorker = new KnowledgeIngestionWorker(
      createWorkerConfig(),
      new PrismaKnowledgeIngestionJobRepository(queueClient),
      app.get(KnowledgeIngestionProcessor),
      app.get(KnowledgeIngestionAvailabilityService),
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
          email: importedRemoteEmail,
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
    await runKnowledgeWorkerUntilClaimed();
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
    expect(document.versions[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);

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
    await runKnowledgeWorkerUntilClaimed();
    const updated = knowledgeDocumentSchema.parse(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/admin/knowledge-bases/${knowledgeBase.id}/documents/${document.id}`)
          .set(bearer(accessToken))
          .expect(200)
      ).body,
    );
    expect(updated.documentVersion).toBe(2);
    expect(updated.versions.find((version) => version.versionNumber === 2)).toMatchObject({
      status: 'READY',
      ingestionJob: { status: 'SUCCEEDED', attempts: 1 },
    });

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

    await enqueueFeishuSync();
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
    expect(alice?.email).toBe(importedRemoteEmail);
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
    expect(aliceBinding.user.email).not.toBe(importedRemoteEmail);
    expect(aliceBinding.user.passwordCredential).toBeNull();
    expect(aliceBinding.user.employments).toHaveLength(2);
    expect(aliceBinding.user.employments.filter((employment) => employment.isPrimary)).toHaveLength(
      1,
    );
    const aliceSyntheticEmail = aliceBinding.user.email;

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: aliceSyntheticEmail,
        password: legacySharedImportedPassword,
      })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: importedRemoteEmail,
        password: legacySharedImportedPassword,
      })
      .expect(401);

    const locallyBoundAlice = await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${alice!.id}`)
      .set(bearer(accessToken))
      .send({ email: importedLoginEmail })
      .expect(200);
    expect(locallyBoundAlice.body).toMatchObject({
      id: alice!.id,
      email: importedLoginEmail,
      source: 'FEISHU',
    });
    const locallyBoundIdentity = await administrator.user.findUniqueOrThrow({
      where: { id: alice!.id },
      include: {
        employments: {
          where: { status: { not: 'TERMINATED' } },
          select: { workEmail: true, workEmailOverridden: true },
        },
      },
    });
    expect(locallyBoundIdentity.email).toBe(importedLoginEmail);
    expect(locallyBoundIdentity.emailNormalized).toBe(importedLoginEmail);
    expect(locallyBoundIdentity.employments).toHaveLength(2);
    expect(
      locallyBoundIdentity.employments.every(
        (employment) =>
          employment.workEmail === importedLoginEmail && employment.workEmailOverridden,
      ),
    ).toBe(true);

    const issuedActivation = await request(app.getHttpServer())
      .post(`/api/v1/admin/members/${alice!.id}/invitation`)
      .set(bearer(accessToken))
      .expect(200);
    const activationInvitation = issueMemberInvitationResponseSchema.parse(issuedActivation.body);
    expect(activationInvitation.email).toBe(importedLoginEmail);
    expect(activationInvitation.deliveryTargetEvidence).toBe('ISSUED');
    expect(activationInvitation.deliveryKind).toBe('MANUAL_FALLBACK');
    if (activationInvitation.fallback === null) throw new Error('Manual fallback was expected.');
    const activationUrl = new URL(activationInvitation.fallback.acceptanceUrl);
    const activationToken = new URLSearchParams(activationUrl.hash.split('?')[1]).get('token');
    if (activationToken === null) throw new Error('Invitation token was missing.');
    await request(app.getHttpServer())
      .post('/api/v1/auth/invitations/accept')
      .send({
        token: activationToken,
        newPassword: activatedImportedPassword,
      })
      .expect(200);
    await expect(
      administrator.passwordCredential.findUniqueOrThrow({
        where: { userId: aliceBinding.user.id },
        select: { mustChangePassword: true },
      }),
    ).resolves.toEqual({
      mustChangePassword: false,
    });
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: aliceSyntheticEmail, password: activatedImportedPassword })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: importedRemoteEmail, password: activatedImportedPassword })
      .expect(401);
    const activatedLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: importedLoginEmail, password: activatedImportedPassword })
      .expect(200);
    expect(authSessionResponseSchema.parse(activatedLogin.body).account.email).toBe(
      importedLoginEmail,
    );

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

    await enqueueFeishuSync();
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
      .send({ tenantSlug, email: importedRemoteEmail, password: activatedImportedPassword })
      .expect(401);
    const relogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: importedLoginEmail,
        password: activatedImportedPassword,
      })
      .expect(200);
    expect(authSessionResponseSchema.parse(relogin.body).account).toMatchObject({
      email: importedLoginEmail,
      passwordChangeRequired: false,
    });
    const afterOverrideSync = await administrator.user.findUniqueOrThrow({
      where: { id: alice!.id },
      include: {
        employments: {
          where: { status: { not: 'TERMINATED' } },
          select: { workEmail: true, workEmailOverridden: true },
        },
      },
    });
    expect(afterOverrideSync.email).toBe(importedLoginEmail);
    expect(
      afterOverrideSync.employments.every(
        (employment) =>
          employment.workEmail === importedLoginEmail && employment.workEmailOverridden,
      ),
    ).toBe(true);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/members/${alice!.id}`)
      .set(bearer(accessToken))
      .send({ email: importedChangedEmail })
      .expect(200)
      .expect(({ body }) => expect(body.email).toBe(importedChangedEmail));
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: importedLoginEmail, password: activatedImportedPassword })
      .expect(401);
    const changedEmailLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: importedChangedEmail, password: activatedImportedPassword })
      .expect(200);
    expect(authSessionResponseSchema.parse(changedEmailLogin.body).account.email).toBe(
      importedChangedEmail,
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
          email: importedRemoteEmail,
          active: true,
          departmentExternalIds: ['od-engineering'],
          primaryDepartmentExternalId: 'od-engineering',
          employeeNumber: 'FS-0001',
          jobTitle: '平台工程师',
        },
      ],
    };
    await enqueueFeishuSync();
    const pendingRemoval = await waitForFeishuSync();
    expect(pendingRemoval.status).toBe('SUCCEEDED');
    expect(pendingRemoval.run?.departments.archived).toBe(0);
    expect(pendingRemoval.run?.members.deactivated).toBe(0);
    const afterDepartmentChangeSync = await administrator.user.findUniqueOrThrow({
      where: { id: alice!.id },
      include: {
        employments: {
          where: { status: 'ACTIVE' },
          select: { workEmail: true, workEmailOverridden: true },
        },
      },
    });
    expect(afterDepartmentChangeSync.email).toBe(importedChangedEmail);
    expect(
      afterDepartmentChangeSync.employments.every(
        (employment) =>
          employment.workEmail === importedChangedEmail && employment.workEmailOverridden,
      ),
    ).toBe(true);

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

    await enqueueFeishuSync();
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
    await enqueueFeishuSync();
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
    await enqueueFeishuSync();
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

  async function enqueueFeishuSync(): Promise<void> {
    const preview = await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync/preview')
      .set(bearer(accessToken))
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations/feishu/organization-sync/runs')
      .set(bearer(accessToken))
      .send({
        previewId: String(preview.body.id),
        idempotencyKey: `admin-integration-feishu-sync-${++feishuSyncRequestSequence}`,
      })
      .expect(201)
      .expect(({ body }) => expect(['QUEUED', 'RUNNING']).toContain(body.status));
    await feishuWorker.runOnce();
  }

  async function waitForFeishuSync() {
    let latestRun: unknown;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/integrations/feishu/organization-sync/runs')
        .set(bearer(accessToken))
        .expect(200);
      const [run] = feishuDirectorySyncRunListSchema.parse(response.body).items;
      latestRun = run;
      if (run !== undefined && run.status !== 'QUEUED' && run.status !== 'RUNNING') {
        const summary = (run.summary ?? {}) as Partial<FeishuSyncCounters>;
        return {
          status: run.status,
          run: {
            departments:
              summary.departments ??
              ({ created: 0, updated: 0, archived: 0, unchanged: 0, failed: 0 } as const),
            members:
              summary.members ??
              ({ created: 0, updated: 0, deactivated: 0, unchanged: 0, failed: 0 } as const),
            conflictCount: summary.conflictCount ?? 0,
            errorMessage: run.lastErrorCode,
          },
        };
      }
      await feishuWorker.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for Feishu directory synchronization: ${JSON.stringify(latestRun)}`,
    );
  }

  async function cleanup(): Promise<void> {
    const tenant = await administrator.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    if (!tenant) return;
    const tenantId = tenant.id;
    await cleanupDisposableTenants(administrator, [tenantId]);
  }

  async function runKnowledgeWorkerUntilClaimed(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await knowledgeWorker.runOnce()) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The knowledge ingestion job was not visible to the worker connection.');
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

function disabledLoginAttemptLimiter() {
  return {
    createContext: () => ({ accountKeyHash: 'admin-integration-disabled', networkKeyHash: null }),
    beginAttempt: () => Promise.resolve(),
    clearSuccessfulAttempt: () => Promise.resolve(),
  };
}
