import {
  adminMemberSchema,
  adminOrgUnitSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  createKnowledgeBaseRequestSchema,
  feishuOrganizationSyncStatusSchema,
  knowledgeBaseIndexReadinessSchema,
  knowledgeBaseSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentVersionDetailSchema,
} from '@enterprise/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./client', () => ({ request: requestMock }));

import {
  archiveKnowledgeDocument,
  changePassword,
  createKnowledgeBase,
  getFeishuOrganizationSyncStatus,
  getKnowledgeDocument,
  getKnowledgeDocumentVersion,
  getKnowledgeBaseReadiness,
  publishKnowledgeDocumentVersion,
  rollbackKnowledgeDocumentVersion,
  startFeishuOrganizationSync,
  uploadKnowledgeDocument,
  uploadKnowledgeDocumentVersion,
} from './admin-api';

const syncStatus = {
  status: 'SUCCEEDED',
  tenantName: '未来协作飞书企业',
  lastSuccessfulAt: '2026-07-15T08:00:00.000Z',
  run: {
    id: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
    status: 'SUCCEEDED',
    startedAt: '2026-07-15T07:59:00.000Z',
    finishedAt: '2026-07-15T08:00:00.000Z',
    departments: { created: 2, updated: 1, archived: 0, unchanged: 4, failed: 0 },
    members: { created: 3, updated: 2, deactivated: 1, unchanged: 7, failed: 0 },
    conflictCount: 0,
    errorMessage: null,
  },
} as const;

describe('admin API', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(syncStatus);
  });

  it('loads sync state independently with an abort signal', async () => {
    const controller = new AbortController();

    await expect(getFeishuOrganizationSyncStatus(controller.signal)).resolves.toEqual(syncStatus);
    expect(requestMock).toHaveBeenCalledWith('/admin/integrations/feishu/organization-sync', {
      schema: feishuOrganizationSyncStatusSchema,
      signal: controller.signal,
    });
  });

  it('starts a sync with the same response contract', async () => {
    await expect(startFeishuOrganizationSync()).resolves.toEqual(syncStatus);
    expect(requestMock).toHaveBeenCalledWith('/admin/integrations/feishu/organization-sync', {
      method: 'POST',
      schema: feishuOrganizationSyncStatusSchema,
    });
  });

  it('validates non-negative result counts', () => {
    expect(feishuOrganizationSyncStatusSchema.parse(syncStatus)).toEqual(syncStatus);
    expect(
      feishuOrganizationSyncStatusSchema.safeParse({
        ...syncStatus,
        run: {
          ...syncStatus.run,
          departments: { ...syncStatus.run.departments, failed: -1 },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects contradictory top-level and run states', () => {
    expect(
      feishuOrganizationSyncStatusSchema.safeParse({
        ...syncStatus,
        status: 'READY',
      }).success,
    ).toBe(false);
    expect(
      feishuOrganizationSyncStatusSchema.safeParse({
        ...syncStatus,
        run: { ...syncStatus.run, status: 'RUNNING' },
      }).success,
    ).toBe(false);
  });

  it('fails closed when organization source ownership is missing', () => {
    const orgUnit = {
      id: 'f5643c90-0f0f-4df8-a2b5-42c9a9c97736',
      organizationId: 'b39eb6b8-d537-4e83-b096-25375c4c6f51',
      parentId: null,
      name: '产品部',
      sortOrder: 0,
      status: 'ACTIVE',
      version: 1,
      memberCount: 0,
    };
    const member = {
      id: '83ceae87-554e-451d-b411-c336f1d02bf9',
      email: 'member@example.com',
      displayName: '本地成员',
      status: 'ACTIVE',
      role: 'MEMBER',
      employment: null,
    };

    expect(adminOrgUnitSchema.safeParse(orgUnit).success).toBe(false);
    expect(adminMemberSchema.safeParse(member).success).toBe(false);
  });

  it('changes the current account password through the authenticated endpoint', async () => {
    const response = {
      account: {
        sessionId: 'd9428888-122b-4b7f-82cd-34e3f4f622b1',
        tenantId: 'b39eb6b8-d537-4e83-b096-25375c4c6f51',
        tenantSlug: 'future-work',
        tenantName: '未来协作',
        userId: '83ceae87-554e-451d-b411-c336f1d02bf9',
        email: 'admin@example.com',
        displayName: '管理员',
        role: 'ADMIN',
        accessExpiresAt: '2026-07-16T09:00:00.000Z',
        refreshExpiresAt: '2026-07-23T08:00:00.000Z',
        passwordChangeRequired: false,
      },
      revokedSessionCount: 2,
    } as const;
    requestMock.mockResolvedValueOnce(response);

    await expect(
      changePassword({ currentPassword: '1234567890', newPassword: 'new-password-123' }),
    ).resolves.toEqual(response);
    expect(requestMock).toHaveBeenCalledWith('/auth/change-password', {
      method: 'POST',
      body: changePasswordRequestSchema.parse({
        currentPassword: '1234567890',
        newPassword: 'new-password-123',
      }),
      schema: changePasswordResponseSchema,
    });
  });

  it('uploads a new file version through the stable document route', async () => {
    const file = new File(['updated policy'], 'policy-2026.txt', { type: 'text/plain' });
    requestMock.mockResolvedValueOnce({ id: 'document-id' });

    await uploadKnowledgeDocumentVersion('knowledge/base', 'document/id', {
      file,
      changeSummary: '  Annual update  ',
    });

    expect(requestMock).toHaveBeenCalledWith(
      '/admin/knowledge-bases/knowledge%2Fbase/documents/document%2Fid/versions/upload',
      expect.objectContaining({
        method: 'POST',
        schema: knowledgeDocumentSchema,
      }),
    );
    const body = requestMock.mock.calls.at(-1)?.[1]?.body as FormData;
    expect(body.get('file')).toMatchObject({
      name: 'policy-2026.txt',
      size: file.size,
      type: 'text/plain',
    });
    expect(body.get('changeSummary')).toBe('Annual update');
    expect(body.has('title')).toBe(false);
  });

  it('creates a typed knowledge base for the file-first import flow', async () => {
    const input = {
      key: 'import-enterprise-policy',
      name: '企业制度知识库',
      description: null,
      status: 'DRAFT' as const,
      orgUnitIds: [],
      orgUnitScopes: [],
    };

    await createKnowledgeBase(input);

    expect(requestMock).toHaveBeenCalledWith('/admin/knowledge-bases', {
      method: 'POST',
      body: createKnowledgeBaseRequestSchema.parse(input),
      schema: knowledgeBaseSchema,
    });
  });

  it('loads enterprise readiness with an abortable typed request', async () => {
    const controller = new AbortController();

    await getKnowledgeBaseReadiness('knowledge/base', controller.signal);

    expect(requestMock).toHaveBeenCalledWith('/admin/knowledge-bases/knowledge%2Fbase/readiness', {
      schema: knowledgeBaseIndexReadinessSchema,
      signal: controller.signal,
    });
  });

  it('uploads a source file with its trimmed document title', async () => {
    const file = new File(['policy'], '员工制度.pdf', { type: 'application/pdf' });
    requestMock.mockResolvedValueOnce({ id: 'document-id' });

    await uploadKnowledgeDocument('knowledge/base', {
      file,
      title: '  员工制度.pdf  ',
      changeSummary: '  首次导入  ',
    });

    expect(requestMock).toHaveBeenCalledWith(
      '/admin/knowledge-bases/knowledge%2Fbase/documents/upload',
      expect.objectContaining({
        method: 'POST',
        schema: knowledgeDocumentSchema,
      }),
    );
    const body = requestMock.mock.calls.at(-1)?.[1]?.body as FormData;
    expect(body.get('file')).toMatchObject({
      name: '员工制度.pdf',
      size: file.size,
      type: 'application/pdf',
    });
    expect(body.get('title')).toBe('员工制度.pdf');
    expect(body.get('changeSummary')).toBe('首次导入');
  });

  it('loads full document and version text only from explicit detail routes', async () => {
    await getKnowledgeDocument('knowledge/base', 'document/id');
    expect(requestMock).toHaveBeenLastCalledWith(
      '/admin/knowledge-bases/knowledge%2Fbase/documents/document%2Fid',
      { schema: knowledgeDocumentSchema },
    );

    await getKnowledgeDocumentVersion('knowledge/base', 'document/id', 'version/id');
    expect(requestMock).toHaveBeenLastCalledWith(
      '/admin/knowledge-bases/knowledge%2Fbase/documents/document%2Fid/versions/version%2Fid',
      { schema: knowledgeDocumentVersionDetailSchema },
    );
  });

  it('parses archive responses as knowledge documents', async () => {
    await archiveKnowledgeDocument('knowledge-base', 'document-id', 3);

    expect(requestMock).toHaveBeenCalledWith(
      '/admin/knowledge-bases/knowledge-base/documents/document-id?expectedVersion=3',
      { method: 'DELETE', schema: knowledgeDocumentSchema },
    );
  });

  it('publishes drafts and rolls back with the expected-current guard', async () => {
    await publishKnowledgeDocumentVersion('knowledge/base', 'document/id', 'version/id');
    expect(requestMock).toHaveBeenLastCalledWith(
      '/admin/knowledge-bases/knowledge%2Fbase/documents/document%2Fid/versions/version%2Fid/publish',
      { method: 'POST', schema: knowledgeDocumentSchema },
    );

    const expectedCurrentVersionId = '00000000-0000-7000-8000-000000000201';
    await rollbackKnowledgeDocumentVersion('knowledge/base', 'document/id', 'version/id', {
      expectedCurrentVersionId,
    });
    expect(requestMock).toHaveBeenLastCalledWith(
      '/admin/knowledge-bases/knowledge%2Fbase/documents/document%2Fid/versions/version%2Fid/rollback',
      {
        method: 'POST',
        body: { expectedCurrentVersionId },
        schema: knowledgeDocumentSchema,
      },
    );
  });
});
