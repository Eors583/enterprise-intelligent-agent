import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../../database/prisma.service.js';
import { AuthorizationDecisionService } from '../../../authorization/authorization-decision.service.js';
import type { KnowledgeRetrievalGateway } from '../../../knowledge-gateway/knowledge-gateway.port.js';
import type { EmployeeCollaborationContextPort } from '../../../people-organization/employee-collaboration-context.port.js';
import {
  exceedsConservativeInputBudget,
  isAgentVersionExecutableForRun,
  PrismaAgentRunRepository,
  shouldRequireGroundedOutput,
} from './prisma-agent-run.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const RUN_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';
const AGENT_ID = '00000000-0000-7000-8000-000000000004';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000005';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000006';
const VERSION_ID = '00000000-0000-7000-8000-000000000007';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000008';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000009';
const TASK_ID = '00000000-0000-7000-8000-000000000010';
const OTHER_TASK_ID = '00000000-0000-7000-8000-000000000011';

describe('isAgentVersionExecutableForRun', () => {
  it('allows a superseded version only for its existing immutable Assignment snapshot', () => {
    const assignmentId = '00000000-0000-7000-8000-000000000009';
    expect(
      isAgentVersionExecutableForRun({
        status: 'RETIRED',
        retryOfRunId: null,
        assignmentRequired: true,
        assignmentId,
        policySnapshot: { snapshotSchemaVersion: 2, roleAssignmentId: assignmentId },
      }),
    ).toBe(true);
    expect(
      isAgentVersionExecutableForRun({
        status: 'RETIRED',
        retryOfRunId: null,
        assignmentRequired: true,
        assignmentId,
        policySnapshot: {
          snapshotSchemaVersion: 2,
          roleAssignmentId: '00000000-0000-7000-8000-000000000010',
        },
      }),
    ).toBe(false);
  });

  it('keeps retired personal and legacy Agents unavailable for new Runs', () => {
    expect(
      isAgentVersionExecutableForRun({
        status: 'RETIRED',
        retryOfRunId: null,
        assignmentRequired: false,
        assignmentId: null,
        policySnapshot: { snapshotSchemaVersion: 2 },
      }),
    ).toBe(false);
    expect(
      isAgentVersionExecutableForRun({
        status: 'RETIRED',
        retryOfRunId: null,
        assignmentRequired: true,
        assignmentId: '00000000-0000-7000-8000-000000000009',
        policySnapshot: {},
      }),
    ).toBe(false);
  });

  it('preserves a governed retry that was explicitly pinned to its source Run', () => {
    expect(
      isAgentVersionExecutableForRun({
        status: 'RETIRED',
        retryOfRunId: RUN_ID,
        assignmentRequired: false,
        assignmentId: null,
        policySnapshot: { snapshotSchemaVersion: 2, retryPinnedToSourceVersion: true },
      }),
    ).toBe(true);
  });
});

describe('PrismaAgentRunRepository prepare', () => {
  it('uses a fail-closed UTF-8 upper bound before reserving generation tokens', () => {
    const prepared = {
      id: RUN_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      requesterUserId: USER_ID,
      requesterRole: 'MEMBER',
      agentId: AGENT_ID,
      agentName: 'Policy assistant',
      agentVersionId: VERSION_ID,
      agentVersion: 1,
      systemPrompt: 'Answer safely.',
      externalRunId: null,
      turnIndex: 1,
      turnLimit: 1,
      maxInputTokens: 16_000,
      maxOutputTokens: 4_000,
      messages: [{ senderType: 'USER', senderId: USER_ID, senderName: 'Requester', text: 'Hello' }],
      knowledgeSources: [],
      knowledgeGroundingRequired: false,
    } as const;

    expect(exceedsConservativeInputBudget(prepared)).toBe(false);
    expect(
      exceedsConservativeInputBudget({
        ...prepared,
        messages: [{ ...prepared.messages[0], text: '问'.repeat(6_000) }],
      }),
    ).toBe(true);
  });

  it('leaves a queued Run untouched when out-of-transaction knowledge retrieval fails', async () => {
    const baseRun = queuedRun();
    const run = {
      ...baseRun,
      agentVersion: {
        ...baseRun.agentVersion,
        knowledgeScope: { mode: 'owner-authorized' },
      },
    } as const;
    const findFirst = vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(null);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst,
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      tenant: {
        findFirst: vi.fn().mockResolvedValue({
          agentRunConcurrencyLimit: 4,
          agentRunRateLimitPerMinute: 60,
          agentRunMonthlyTokenLimit: 100_000_000n,
        }),
      },
      conversationParticipant: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'USER', userId: USER_ID, agentId: null },
          { type: 'AGENT', userId: null, agentId: AGENT_ID },
        ]),
      },
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: MESSAGE_ID,
            senderType: 'USER',
            senderUserId: USER_ID,
            senderAgentId: null,
            senderName: 'Requester',
            content: { type: 'text', text: 'What is the leave policy?' },
            createdAt: run.inputMessage.createdAt,
          },
        ]),
      },
      aiSafetyDecisionRecord: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      auditEvent: { create: vi.fn() },
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const retrieval = {
      resolveAccessibleKnowledgeBaseIds: vi.fn().mockResolvedValue([KNOWLEDGE_BASE_ID]),
      search: vi.fn().mockRejectedValue(new Error('embedding provider unavailable')),
      areChunksAccessible: vi.fn(),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalGateway,
      new AuthorizationDecisionService(),
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).rejects.toThrow(
      'embedding provider unavailable',
    );

    expect(prisma.withTenant).toHaveBeenCalledOnce();
    expect(retrieval.resolveAccessibleKnowledgeBaseIds).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      authorization: {
        tenantRole: 'MEMBER',
        assignment: null,
        taskContext: {
          assignmentRequired: false,
          resourceAgentId: AGENT_ID,
          resourceOwnerUserId: null,
          resourceVisibility: 'tenant',
          requesterUserId: USER_ID,
          participantUserIds: [USER_ID],
          enforceActorMembership: true,
        },
      },
    });
    expect(retrieval.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      authorization: {
        tenantRole: 'MEMBER',
        assignment: null,
        taskContext: {
          assignmentRequired: false,
          resourceAgentId: AGENT_ID,
          resourceOwnerUserId: null,
          resourceVisibility: 'tenant',
          requesterUserId: USER_ID,
          participantUserIds: [USER_ID],
          enforceActorMembership: true,
        },
      },
      query: 'What is the leave policy?',
      maximumOutboundClassification: 'INTERNAL',
    });
    expect(transaction.agentRun.update).not.toHaveBeenCalled();
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    expect(run.status).toBe('QUEUED');
  });

  it('fails closed when a queued Role Agent relation remains but its marker is malformed', async () => {
    const baseRun = queuedRun();
    const run = {
      ...baseRun,
      agent: {
        ...baseRun.agent,
        ownerUserId: USER_ID,
        settings: {
          visibility: 'owner',
          roleAssignmentId: '',
        },
        _count: { roleAssignments: 1 },
      },
    } as const;
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(null),
        update: vi.fn().mockResolvedValue({}),
      },
      conversationParticipant: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'USER', userId: USER_ID, agentId: null },
          { type: 'AGENT', userId: null, agentId: AGENT_ID },
        ]),
      },
      roleAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      agentRunStreamEvent: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const retrieval = {
      search: vi.fn(),
      areChunksAccessible: vi.fn(),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalGateway,
      new AuthorizationDecisionService(),
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).resolves.toEqual({
      kind: 'terminal',
      status: 'FAILED',
      externalRunId: null,
      errorCode: 'AGENT_ASSIGNMENT_INACTIVE',
    });
    expect(transaction.roleAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        agentInstanceId: AGENT_ID,
        userId: USER_ID,
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        tenantId: true,
        userId: true,
        agentInstanceId: true,
        roleTemplateId: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        organizationScope: true,
        permissionScope: true,
        employment: { select: { status: true, userId: true } },
      },
    });
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'AGENT_ASSIGNMENT_INACTIVE',
      }),
    });
    expect(retrieval.search).not.toHaveBeenCalled();
  });

  it('uses the trusted business Task id for task-scoped Role Agent execution and retrieval', async () => {
    const run = roleAgentRun(TASK_ID);
    const transaction = prepareTransaction(run, activeTaskScopedAssignment());
    const prisma = tenantPrisma(transaction);
    const retrieval = {
      search: vi.fn().mockRejectedValue(new Error('stop after authorization')),
      areChunksAccessible: vi.fn(),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalGateway,
      new AuthorizationDecisionService(),
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).rejects.toThrow('stop after authorization');

    expect(retrieval.search).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          assignment: expect.objectContaining({
            id: ASSIGNMENT_ID,
            taskIds: [TASK_ID],
          }),
          taskContext: expect.objectContaining({ taskId: TASK_ID }),
        }),
      }),
    );
    expect(retrieval.search.mock.calls[0]?.[0]?.authorization.taskContext.taskId).not.toBe(RUN_ID);
  });

  it('denies a task-scoped Role Agent when the Run has no trusted business Task id', async () => {
    const run = roleAgentRun(null);
    const transaction = prepareTransaction(run, activeTaskScopedAssignment());
    const prisma = tenantPrisma(transaction);
    const retrieval = {
      search: vi.fn(),
      areChunksAccessible: vi.fn(),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalGateway,
      new AuthorizationDecisionService(),
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).resolves.toEqual({
      kind: 'terminal',
      status: 'FAILED',
      externalRunId: null,
      errorCode: 'AGENT_TASK_SCOPE_DENIED',
    });
    expect(retrieval.search).not.toHaveBeenCalled();
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'AGENT_TASK_SCOPE_DENIED',
      }),
    });
  });

  it('denies a task-scoped Role Agent when the Run is bound to another business Task', async () => {
    const run = roleAgentRun(OTHER_TASK_ID);
    const transaction = prepareTransaction(run, activeTaskScopedAssignment());
    const prisma = tenantPrisma(transaction);
    const retrieval = {
      search: vi.fn(),
      areChunksAccessible: vi.fn(),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalGateway,
      new AuthorizationDecisionService(),
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED',
      errorCode: 'AGENT_TASK_SCOPE_DENIED',
    });
    expect(retrieval.search).not.toHaveBeenCalled();
  });

  it('resumes a known RUNNING execution for reconciliation without reserving or dispatching again', async () => {
    const externalRunId = '00000000-0000-7000-8000-000000000009';
    const collaborationSnapshot = collaborationContextSnapshot('b'.repeat(64));
    const run = {
      ...queuedRun(),
      status: 'RUNNING',
      externalRunId,
      dispatchStartedAt: new Date('2026-07-21T00:00:01.000Z'),
      startedAt: new Date('2026-07-21T00:00:02.000Z'),
      reservedTokens: 20_000,
      modelRoutePolicyVersionId: '00000000-0000-7000-8000-000000000010',
      modelRouteSnapshot: {
        schemaVersion: 1,
        policyVersionId: '00000000-0000-7000-8000-000000000010',
        policyVersion: 1,
        policyHash: 'a'.repeat(64),
        taskClass: 'GENERAL_QA',
        maximumClassification: 'INTERNAL',
        requiredCapabilities: ['chat'],
        maximumAttempts: 1,
        circuitFailureThreshold: 3,
        circuitOpenSeconds: 60,
        candidates: [
          {
            ordinal: 1,
            catalogVersionId: '00000000-0000-7000-8000-000000000011',
            routeKey: 'GENERAL_PRIMARY',
            provider: 'OPENAI_COMPATIBLE',
            model: 'enterprise-chat',
            credentialReference: 'vault://ai/providers/general',
          },
        ],
      },
      collaborationContextSnapshot: collaborationSnapshot,
      agent: {
        ...queuedRun().agent,
        kind: 'MEMBER',
        ownerUserId: '00000000-0000-7000-8000-000000000012',
      },
      inputMessage: {
        ...queuedRun().inputMessage,
        content: { type: 'text', text: '今天方便吗？' },
      },
    } as const;
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(run),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
      conversationParticipant: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'USER', userId: USER_ID, agentId: null },
          { type: 'AGENT', userId: null, agentId: AGENT_ID },
        ]),
      },
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: MESSAGE_ID,
            senderType: 'USER',
            senderUserId: USER_ID,
            senderAgentId: null,
            senderName: 'Requester',
            content: { type: 'text', text: 'What is the leave policy?' },
            createdAt: run.inputMessage.createdAt,
          },
        ]),
      },
      aiSafetyDecisionRecord: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      aiModelCatalogVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-7000-8000-000000000011',
            routeKey: 'GENERAL_PRIMARY',
            provider: 'OPENAI_COMPATIBLE',
            modelName: 'enterprise-chat',
            credentialReference: 'vault://ai/providers/general',
            maximumClassification: 'INTERNAL',
          },
        ]),
      },
      auditEvent: { create: vi.fn() },
      agentRunStreamEvent: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const retrieval = {
      search: vi.fn().mockResolvedValue({ items: [] }),
      areChunksAccessible: vi.fn().mockResolvedValue(true),
    };
    const employeeCollaboration = {
      resolve: vi.fn().mockResolvedValue(collaborationSnapshot),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalGateway,
      new AuthorizationDecisionService(),
      employeeCollaboration as unknown as EmployeeCollaborationContextPort,
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).resolves.toMatchObject({
      kind: 'ready',
      run: { id: RUN_ID, externalRunId },
    });
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled();
    expect(transaction.agentRun.update).not.toHaveBeenCalled();

    employeeCollaboration.resolve.mockResolvedValue(collaborationContextSnapshot('c'.repeat(64)));
    await expect(repository.prepare(TENANT_ID, RUN_ID)).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED',
      errorCode: 'EMPLOYEE_COLLABORATION_ACCESS_CHANGED',
    });
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'EMPLOYEE_COLLABORATION_ACCESS_CHANGED',
      }),
    });
  });
});

describe('PrismaAgentRunRepository provider-backed cancellation', () => {
  it('attaches a late Runtime id without forging RUNNING after cancellation was requested', async () => {
    const externalRunId = '00000000-0000-7000-8000-000000000012';
    const requestedAt = new Date('2026-07-29T01:00:00.000Z');
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...queuedRun(),
          status: 'DISPATCHING',
          cancellationRequestedAt: requestedAt,
          cancellationReason: 'ROLE_ASSIGNMENT_REVOKED',
          cancellationConfirmedAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const repository = cancellationRepository(transaction);

    await expect(repository.attachExternalRun(TENANT_ID, RUN_ID, externalRunId)).resolves.toBe(
      'cancellation_required',
    );
    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: {
        externalRunId,
        version: { increment: 1 },
      },
    });
    expect(transaction.agentRun.update.mock.calls[0]?.[0].data).not.toHaveProperty('status');
    expect(transaction.agentRun.update.mock.calls[0]?.[0].data).not.toHaveProperty('startedAt');
  });

  it('records a raced terminal Run as cancellation-complete without backdating confirmation', async () => {
    const requestedAt = new Date(Date.now() - 1_000);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'SUCCEEDED',
          externalRunId: '00000000-0000-7000-8000-000000000012',
          finishedAt: new Date(requestedAt.getTime() - 1_000),
          cancellationRequestedAt: requestedAt,
          cancellationConfirmedAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const repository = cancellationRepository(transaction);

    await expect(repository.prepareCancellation(TENANT_ID, RUN_ID)).resolves.toEqual({
      kind: 'complete',
      externalRunId: '00000000-0000-7000-8000-000000000012',
    });
    const confirmedAt = transaction.agentRun.update.mock.calls[0]?.[0].data
      .cancellationConfirmedAt as Date;
    expect(confirmedAt.getTime()).toBeGreaterThanOrEqual(requestedAt.getTime());
  });

  it('keeps UNKNOWN and its reservation while recording a confirmed remote stop', async () => {
    const externalRunId = '00000000-0000-7000-8000-000000000012';
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'UNKNOWN',
          externalRunId,
          conversationId: CONVERSATION_ID,
          reservedTokens: 20_000,
          cancellationRequestedAt: new Date('2026-07-29T01:00:00.000Z'),
          cancellationReason: 'IDENTITY_DEPROVISIONED',
          cancellationConfirmedAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const repository = cancellationRepository(transaction);

    await repository.confirmCancellation(TENANT_ID, RUN_ID, externalRunId);

    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        cancellationConfirmedAt: expect.any(Date),
        version: { increment: 1 },
      }),
    });
    const update = transaction.agentRun.update.mock.calls[0]?.[0].data;
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('finishedAt');
    expect(update).not.toHaveProperty('reservedTokens');
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'agent.run.cancellation_confirmed_after_unknown',
        metadata: expect.objectContaining({
          cancellationReason: 'IDENTITY_DEPROVISIONED',
          latencyMs: null,
        }),
      }),
    });
  });

  it('treats a legacy QUEUED Run with a provider id as provider-backed cancellation', async () => {
    const externalRunId = '00000000-0000-7000-8000-000000000012';
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'QUEUED',
          externalRunId,
          conversationId: CONVERSATION_ID,
          reservedTokens: 20_000,
          cancellationRequestedAt: new Date('2026-07-29T01:00:00.000Z'),
          cancellationReason: 'IDENTITY_DEPROVISIONED',
          cancellationConfirmedAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      agentRunStreamEvent: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const repository = cancellationRepository(transaction);

    await repository.confirmCancellation(TENANT_ID, RUN_ID, externalRunId);

    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        status: 'CANCELLED',
        errorCode: 'IDENTITY_DEPROVISIONED',
        cancellationConfirmedAt: expect.any(Date),
        version: { increment: 1 },
      }),
    });
    expect(transaction.agentRun.update.mock.calls[0]?.[0].data).toMatchObject({
      tokenEvidence: 'QUOTA_UPPER_BOUND',
      quotaChargedTokens: 20_000,
      quotaSettledAt: expect.any(Date),
      reservedTokens: 0,
    });
    expect(transaction.agentRun.update.mock.calls[0]?.[0].data).not.toHaveProperty(
      'usageRecordedAt',
    );
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'agent.run.cancel_confirmed',
      }),
    });
  });
});

describe('shouldRequireGroundedOutput', () => {
  it('does not turn a knowledge-enabled Agent confirmation into a knowledge claim', () => {
    expect(
      shouldRequireGroundedOutput(
        '[自动验收][修复复测] 请用一句话回复：模型调用已恢复。不要调用工具，不要引用企业事实。',
        0,
        'SELF_ASSISTANCE',
      ),
    ).toBe(false);
  });

  it.each([
    ['请根据公司年假制度回答有几天', undefined],
    ['周睿今天方便吗？', 'AVAILABILITY_QUERY' as const],
    ['周睿负责的项目进度怎么样？', 'WORK_PROGRESS_QUERY' as const],
  ])('keeps evidence-free enterprise facts fail closed: %s', (query, purpose) => {
    expect(shouldRequireGroundedOutput(query, 0, purpose)).toBe(true);
  });

  it('requires citations whenever authorized evidence enters the model context', () => {
    expect(shouldRequireGroundedOutput('请给我一个通用建议', 1)).toBe(true);
  });

  it('does not turn a conversation-memory question into an enterprise-knowledge claim', () => {
    expect(shouldRequireGroundedOutput('你知道我刚刚问了什么问题吗', 3)).toBe(false);
    expect(shouldRequireGroundedOutput('你还记得我们刚才聊了什么吗？', 2)).toBe(false);
  });
});

function queuedRun() {
  const createdAt = new Date('2026-07-21T00:00:00.000Z');
  return {
    id: RUN_ID,
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    inputMessageId: MESSAGE_ID,
    requesterUserId: USER_ID,
    agentId: AGENT_ID,
    agentVersionId: VERSION_ID,
    taskId: null,
    parentRunId: null,
    outputMessageId: null,
    trigger: 'USER_MESSAGE',
    turnIndex: 1,
    turnLimit: 1,
    status: 'QUEUED',
    idempotencyKey: 'direct:test',
    externalRunId: null,
    attempts: 0,
    version: 0,
    reservedTokens: 0,
    policySnapshot: {},
    memoryContextSnapshot: null,
    collaborationContextSnapshot: null,
    errorCode: null,
    errorMessage: null,
    dispatchStartedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt,
    updatedAt: createdAt,
    requester: {
      id: USER_ID,
      tenantId: TENANT_ID,
      status: 'ACTIVE',
      role: 'MEMBER',
    },
    agent: {
      id: AGENT_ID,
      tenantId: TENANT_ID,
      name: 'Policy assistant',
      status: 'ONLINE',
      ownerUserId: null,
      kind: 'MEMBER',
      settings: { visibility: 'tenant' },
      _count: { roleAssignments: 0 },
    },
    agentVersion: {
      id: VERSION_ID,
      tenantId: TENANT_ID,
      version: 1,
      status: 'PUBLISHED',
      systemPrompt: 'Answer from enterprise knowledge.',
      knowledgeScope: { knowledgeBaseIds: [KNOWLEDGE_BASE_ID] },
    },
    conversation: {
      id: CONVERSATION_ID,
      tenantId: TENANT_ID,
      relayAgentAId: null,
      relayAgentBId: null,
      relayTurnLimit: null,
    },
    inputMessage: {
      id: MESSAGE_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      createdAt,
      content: { type: 'text', text: 'What is the leave policy?' },
    },
  } as const;
}

function collaborationContextSnapshot(snapshotHash: string) {
  return {
    schemaVersion: 1 as const,
    requesterUserId: USER_ID,
    representedEmployeeId: '00000000-0000-7000-8000-000000000012',
    purpose: 'AVAILABILITY_QUERY' as const,
    relationship: 'SHARED_WORK' as const,
    policyRevision: 1,
    policyHash: 'a'.repeat(64),
    resolvedAt: '2026-08-13T00:00:00.000Z',
    sources: [],
    allowedCapabilities: ['ANSWER_FACTS', 'GIVE_ADVICE', 'DRAFT_ACTION'] as Array<
      'ANSWER_FACTS' | 'GIVE_ADVICE' | 'DRAFT_ACTION'
    >,
    deniedCapabilities: [
      'SEND_MESSAGE',
      'CHANGE_TASK',
      'MAKE_COMMITMENT',
      'ACCEPT',
      'APPROVE',
      'ESCALATE',
    ] as Array<
      'SEND_MESSAGE' | 'CHANGE_TASK' | 'MAKE_COMMITMENT' | 'ACCEPT' | 'APPROVE' | 'ESCALATE'
    >,
    snapshotHash,
  };
}

function cancellationRepository(transaction: Record<string, unknown>) {
  const prisma = {
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(transaction as unknown as Prisma.TransactionClient),
    ),
  };
  const retrieval = {
    search: vi.fn(),
    areChunksAccessible: vi.fn(),
  };
  return new PrismaAgentRunRepository(
    prisma as unknown as PrismaService,
    retrieval as unknown as KnowledgeRetrievalGateway,
    new AuthorizationDecisionService(),
  );
}

function roleAgentRun(taskId: string | null) {
  const run = queuedRun();
  return {
    ...run,
    taskId,
    agent: {
      ...run.agent,
      settings: { visibility: 'tenant', roleAssignmentId: ASSIGNMENT_ID },
      _count: { roleAssignments: 1 },
    },
  } as const;
}

function activeTaskScopedAssignment() {
  return {
    id: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    agentInstanceId: AGENT_ID,
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    effectiveTo: null,
    organizationScope: {},
    permissionScope: {
      taskIds: [TASK_ID],
      actions: ['agent.run.execute'],
    },
    employment: {
      status: 'ACTIVE',
      userId: USER_ID,
    },
  } as const;
}

function prepareTransaction(
  run: ReturnType<typeof roleAgentRun>,
  assignment: ReturnType<typeof activeTaskScopedAssignment>,
) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    agentRun: {
      findFirst: vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(null),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn(),
    },
    agentRunStreamEvent: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sequence: null } }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    tenant: {
      findFirst: vi.fn().mockResolvedValue({
        agentRunConcurrencyLimit: 4,
        agentRunRateLimitPerMinute: 60,
        agentRunMonthlyTokenLimit: 100_000_000n,
      }),
    },
    conversationParticipant: {
      findMany: vi.fn().mockResolvedValue([
        { type: 'USER', userId: USER_ID, agentId: null },
        { type: 'AGENT', userId: null, agentId: AGENT_ID },
      ]),
    },
    roleAssignment: {
      findFirst: vi.fn().mockResolvedValue(assignment),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: MESSAGE_ID,
          senderType: 'USER',
          senderUserId: USER_ID,
          senderAgentId: null,
          senderName: 'Requester',
          content: { type: 'text', text: 'What is the leave policy?' },
          createdAt: run.inputMessage.createdAt,
        },
      ]),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
}

function tenantPrisma(transaction: ReturnType<typeof prepareTransaction>) {
  return {
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(transaction as unknown as Prisma.TransactionClient),
    ),
  };
}
