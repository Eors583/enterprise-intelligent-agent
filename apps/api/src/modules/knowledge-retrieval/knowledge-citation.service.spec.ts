import { NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../../database/prisma.service.js';
import { AuthorizationDecisionService } from '../authorization/authorization-decision.service.js';
import type { IdentityService } from '../identity/application/identity.service.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const OTHER_USER_ID = '00000000-0000-7000-8000-000000000102';
const ORGANIZATION_ID = '00000000-0000-7000-8000-000000000200';
const MEMBER_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000201';
const PARENT_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000202';
const OTHER_ORG_UNIT_ID = '00000000-0000-7000-8000-000000000203';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000301';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000401';
const VERSION_ID = '00000000-0000-7000-8000-000000000501';
const CHUNK_ID = '00000000-0000-7000-8000-000000000601';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000701';
const RUN_ID = '00000000-0000-7000-8000-000000000702';
const AGENT_ID = '00000000-0000-7000-8000-000000000703';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000704';
const TASK_ID = '00000000-0000-7000-8000-000000000705';
const PROJECT_ID = '00000000-0000-7000-8000-000000000706';

describe('KnowledgeCitationService', () => {
  it('returns the exact message-bound source after revalidating current role, task and labels', async () => {
    const fixture = createFixture({
      chunk: chunkCandidate({
        knowledgeBaseStatus: 'ARCHIVED',
        documentStatus: 'ARCHIVED',
        versionStatus: 'ARCHIVED',
        scopes: [{ orgUnitId: PARENT_ORG_UNIT_ID, includeChildren: true }],
      }),
    });

    await expect(fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID)).resolves.toEqual({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      knowledgeBaseName: '企业制度库',
      documentId: DOCUMENT_ID,
      documentTitle: '请假制度',
      documentVersionId: VERSION_ID,
      documentVersion: 3,
      chunkId: CHUNK_ID,
      headingPath: ['人事制度', '年假'],
      sourceType: 'MARKDOWN',
      content: '年假申请需至少提前一天发起。',
      updatedAt: '2026-07-20T02:00:00.000Z',
    });
    expect(fixture.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(fixture.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'knowledge.citation.read',
        resourceId: MESSAGE_ID,
        metadata: expect.objectContaining({
          agentRunId: RUN_ID,
          documentVersionId: VERSION_ID,
          chunkId: CHUNK_ID,
          authorizationDecisionId: expect.any(String),
        }),
      }),
    });
  });

  it('returns 404 when a caller guesses lineage without the bound output message', async () => {
    const fixture = createFixture({ message: null });

    await expect(
      fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectDeniedAudit(fixture.auditCreate, 'BINDING_INVALID');
  });

  it('returns 404 immediately after the bound role assignment is revoked', async () => {
    const fixture = createFixture({
      assignment: assignmentCandidate({ status: 'REVOKED' }),
    });

    await expect(
      fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectDeniedAudit(fixture.auditCreate, 'ASSIGNMENT_NOT_ACTIVE');
  });

  it.each([
    {
      name: 'project',
      permissionScope: {
        actions: ['knowledge.retrieve'],
        projectIds: ['00000000-0000-7000-8000-000000009001'],
        taskIds: [TASK_ID],
        dataLabels: ['role:hr'],
      },
    },
    {
      name: 'task',
      permissionScope: {
        actions: ['knowledge.retrieve'],
        projectIds: [PROJECT_ID],
        taskIds: ['00000000-0000-7000-8000-000000009002'],
        dataLabels: ['role:hr'],
      },
    },
    {
      name: 'data label',
      permissionScope: {
        actions: ['knowledge.retrieve'],
        projectIds: [PROJECT_ID],
        taskIds: [TASK_ID],
        dataLabels: ['role:finance'],
      },
    },
  ])(
    'returns 404 when current $name scope no longer allows the cited chunk',
    async ({ permissionScope }) => {
      const fixture = createFixture({
        assignment: assignmentCandidate({ permissionScope }),
      });

      await expect(
        fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expectDeniedAudit(fixture.auditCreate);
    },
  );

  it('returns 404 to another role even when it is added to the conversation', async () => {
    const fixture = createFixture({
      message: messageCandidate({ requesterUserId: OTHER_USER_ID }),
    });

    await expect(
      fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectDeniedAudit(fixture.auditCreate, 'BINDING_INVALID');
  });

  it('does not disclose a source returned from another tenant', async () => {
    const fixture = createFixture({
      chunk: chunkCandidate({ tenantId: OTHER_TENANT_ID }),
    });

    await expect(
      fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects inconsistent chunk, version, document and knowledge-base lineage', async () => {
    const inconsistent = chunkCandidate();
    inconsistent.documentVersion.documentId = '00000000-0000-7000-8000-000000000499';
    const fixture = createFixture({ chunk: inconsistent });

    await expect(
      fixture.service.getOriginal(MESSAGE_ID, VERSION_ID, CHUNK_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

interface ChunkCandidateOptions {
  tenantId?: string;
  knowledgeBaseStatus?: 'ACTIVE' | 'ARCHIVED';
  documentStatus?: 'READY' | 'ARCHIVED';
  versionStatus?: 'READY' | 'ARCHIVED';
  scopes?: Array<{ orgUnitId: string; includeChildren: boolean }>;
}

function chunkCandidate(options: ChunkCandidateOptions = {}) {
  const tenantId = options.tenantId ?? TENANT_ID;
  return {
    id: CHUNK_ID,
    tenantId,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    headingPath: ['人事制度', '年假'],
    content: '年假申请需至少提前一天发起。',
    metadata: {
      orgUnitId: MEMBER_ORG_UNIT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      dataLabels: ['role:hr'],
    },
    knowledgeBase: {
      id: KNOWLEDGE_BASE_ID,
      tenantId,
      name: '企业制度库',
      status: options.knowledgeBaseStatus ?? ('ACTIVE' as const),
      orgUnits: options.scopes ?? [],
    },
    document: {
      id: DOCUMENT_ID,
      tenantId,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      title: '请假制度',
      status: options.documentStatus ?? ('READY' as const),
    },
    documentVersion: {
      id: VERSION_ID,
      tenantId,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documentId: DOCUMENT_ID,
      createdById: USER_ID,
      versionNumber: 3,
      sourceType: 'MARKDOWN' as const,
      status: options.versionStatus ?? ('READY' as const),
      createdAt: new Date('2026-07-20T01:00:00.000Z'),
      publishedAt: new Date('2026-07-20T02:00:00.000Z'),
      governanceOwnerUserId: USER_ID,
      classification: 'INTERNAL' as const,
      scopeMode: 'RESTRICTED' as const,
      organizationScopeIds: [PARENT_ORG_UNIT_ID],
      projectScopeIds: [PROJECT_ID],
      taskScopeIds: [TASK_ID],
      roleTemplateScopeIds: [],
      dataLabels: ['role:hr'],
      effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
      expiresAt: null,
      retentionUntil: null,
      retentionAction: 'ARCHIVE' as const,
      supersedesVersionId: null,
      governanceReviewStatus: 'APPROVED' as const,
      governanceHash: 'a'.repeat(64),
    },
  };
}

function messageCandidate(options: { requesterUserId?: string } = {}) {
  const requesterUserId = options.requesterUserId ?? USER_ID;
  return {
    id: MESSAGE_ID,
    tenantId: TENANT_ID,
    conversationId: '00000000-0000-7000-8000-000000000707',
    senderType: 'AGENT' as const,
    senderAgentId: AGENT_ID,
    content: {
      type: 'text',
      text: '请参考 [来源1]。',
      citations: [
        {
          documentId: DOCUMENT_ID,
          documentVersionId: VERSION_ID,
          chunkId: CHUNK_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          knowledgeBaseName: '企业制度库',
          title: '请假制度',
          documentVersion: 3,
          headingPath: ['人事制度', '年假'],
          sourceType: 'MARKDOWN',
          excerpt: '年假申请需至少提前一天发起。',
          updatedAt: '2026-07-20T02:00:00.000Z',
        },
      ],
    },
    outputAgentRuns: [
      {
        id: RUN_ID,
        tenantId: TENANT_ID,
        taskId: TASK_ID,
        conversationId: '00000000-0000-7000-8000-000000000707',
        outputMessageId: MESSAGE_ID,
        requesterUserId,
        agentId: AGENT_ID,
        policySnapshot: {
          snapshotSchemaVersion: 2,
          roleAssignmentId: ASSIGNMENT_ID,
        },
        agent: {
          tenantId: TENANT_ID,
          ownerUserId: USER_ID,
          settings: { visibility: 'tenant', roleAssignmentId: ASSIGNMENT_ID },
          _count: { roleAssignments: 1 },
        },
        conversation: {
          participants: [
            { type: 'USER' as const, userId: USER_ID, agentId: null },
            { type: 'USER' as const, userId: OTHER_USER_ID, agentId: null },
            { type: 'AGENT' as const, userId: null, agentId: AGENT_ID },
          ],
        },
      },
    ],
  };
}

function assignmentCandidate(
  options: {
    status?: 'ACTIVE' | 'REVOKED';
    permissionScope?: {
      actions: string[];
      projectIds: string[];
      taskIds: string[];
      dataLabels: string[];
    };
  } = {},
) {
  return {
    id: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    agentInstanceId: AGENT_ID,
    status: options.status ?? ('ACTIVE' as const),
    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    effectiveTo: null,
    organizationScope: {
      organizationIds: [PARENT_ORG_UNIT_ID],
      includeDescendants: true,
    },
    permissionScope: options.permissionScope ?? {
      actions: ['knowledge.retrieve'],
      projectIds: [PROJECT_ID],
      taskIds: [TASK_ID],
      dataLabels: ['role:hr'],
    },
    employment: { status: 'ACTIVE' as const, userId: USER_ID },
  };
}

function createFixture(
  options: {
    chunk?: ReturnType<typeof chunkCandidate> | null;
    message?: ReturnType<typeof messageCandidate> | null;
    assignment?: ReturnType<typeof assignmentCandidate> | null;
    employments?: Array<{ orgUnitId: string }>;
  } = {},
) {
  const auditCreate = vi.fn().mockResolvedValue({});
  const transaction = {
    user: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE', role: 'MEMBER' }) },
    employment: {
      findMany: vi
        .fn()
        .mockResolvedValue(options.employments ?? [{ orgUnitId: MEMBER_ORG_UNIT_ID }]),
    },
    orgUnit: {
      findMany: vi.fn().mockResolvedValue([
        { id: PARENT_ORG_UNIT_ID, parentId: null, organizationId: ORGANIZATION_ID },
        {
          id: MEMBER_ORG_UNIT_ID,
          parentId: PARENT_ORG_UNIT_ID,
          organizationId: ORGANIZATION_ID,
        },
        { id: OTHER_ORG_UNIT_ID, parentId: null, organizationId: ORGANIZATION_ID },
      ]),
    },
    message: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          Object.prototype.hasOwnProperty.call(options, 'message')
            ? options.message
            : messageCandidate(),
        ),
    },
    knowledgeChunk: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          Object.prototype.hasOwnProperty.call(options, 'chunk') ? options.chunk : chunkCandidate(),
        ),
    },
    roleAssignment: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          Object.prototype.hasOwnProperty.call(options, 'assignment')
            ? options.assignment
            : assignmentCandidate(),
        ),
    },
    auditEvent: { create: auditCreate },
  };
  const withTenant = vi.fn(
    async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
  );
  const identity = {
    getCurrentIdentity: vi.fn().mockResolvedValue({
      tenant: { id: TENANT_ID, name: '企业', status: 'active' },
      user: { id: USER_ID, tenantId: TENANT_ID, name: '员工', status: 'active' },
    }),
  } as unknown as IdentityService;
  const prisma = { withTenant } as unknown as PrismaService;
  return {
    service: new KnowledgeCitationService(identity, prisma, new AuthorizationDecisionService()),
    withTenant,
    auditCreate,
  };
}

function expectDeniedAudit(auditCreate: ReturnType<typeof vi.fn>, reasonCode?: string): void {
  expect(auditCreate).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: 'knowledge.citation.read_denied',
      resourceId: MESSAGE_ID,
      metadata:
        reasonCode === undefined
          ? expect.objectContaining({ reasonCode: expect.any(String) })
          : expect.objectContaining({ reasonCode }),
    }),
  });
}
