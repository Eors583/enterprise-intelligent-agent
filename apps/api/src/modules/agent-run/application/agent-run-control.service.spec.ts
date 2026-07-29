import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../database/prisma.service.js';
import type { AuthorizationService } from '../../authorization/authorization.service.js';
import type { IdentityService } from '../../identity/application/identity.service.js';
import type { AgentRuntimeClient } from '../domain/agent-runtime.client.js';
import { buildAgentRunPolicySnapshot } from '../domain/agent-run-policy-snapshot.js';
import { AgentRunControlService } from './agent-run-control.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000003';
const RUN_ID = '00000000-0000-7000-8000-000000000004';
const EXTERNAL_RUN_ID = '00000000-0000-7000-8000-000000000005';
const SOURCE_VERSION_ID = '00000000-0000-7000-8000-000000000006';
const CURRENT_VERSION_ID = '00000000-0000-7000-8000-000000000007';
const TEMPLATE_ID = '00000000-0000-7000-8000-000000000008';
const TASK_ID = '00000000-0000-7000-8000-000000000012';

describe('AgentRunControlService cancellation', () => {
  it('keeps a running Run and its reservation when Runtime cancellation is not confirmed', async () => {
    const fixture = createFixture();
    fixture.runtime.cancel.mockRejectedValue(new Error('runtime unavailable'));

    await expect(fixture.service.cancel(CONVERSATION_ID, RUN_ID)).rejects.toMatchObject({
      status: 503,
    });
    expect(fixture.authorization.requireCurrent).toHaveBeenCalledWith({
      action: 'agent.run.cancel',
      resourceTenantId: TENANT_ID,
      taskContext: { taskId: RUN_ID },
      risk: 'MEDIUM',
    });
    expect(fixture.transaction.agentRun.update).not.toHaveBeenCalled();
  });

  it('persists CANCELLED only after Runtime confirmation and reconciles UNKNOWN at sequence 10001', async () => {
    const fixture = createFixture();
    fixture.runtime.cancel.mockResolvedValue({
      runId: EXTERNAL_RUN_ID,
      status: 'cancelled',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        costMicros: 0,
        tokensReported: false,
        costReported: false,
      },
    });

    await expect(fixture.service.cancel(CONVERSATION_ID, RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: 'cancelled',
    });
    expect(fixture.transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({
        status: 'CANCELLED',
        toolCalls: 0,
        tokenEvidence: 'QUOTA_UPPER_BOUND',
        quotaChargedTokens: 20_000,
        quotaSettledAt: expect.any(Date),
        reservedTokens: 0,
      }),
    });
    const update = fixture.transaction.agentRun.update.mock.calls[0]?.[0];
    expect(update?.data).not.toHaveProperty('usageRecordedAt');
    expect(update?.data).not.toHaveProperty('inputTokens');
    expect(update?.data).not.toHaveProperty('outputTokens');
    expect(update?.data).not.toHaveProperty('totalTokens');
    expect(fixture.transaction.agentRunStreamEvent.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        runId: RUN_ID,
        type: { in: ['TERMINAL', 'TERMINAL_ONLY', 'TERMINAL_RECONCILED'] },
      },
      orderBy: { sequence: 'asc' },
    });
    const streamInsert = fixture.transaction.$executeRaw.mock.calls[0]?.[0] as
      { values?: unknown[] } | undefined;
    expect(streamInsert?.values).toEqual([
      TENANT_ID,
      RUN_ID,
      10_001,
      `${RUN_ID}:10001`,
      'TERMINAL_RECONCILED',
      'CANCELLED',
      update?.data.finishedAt,
    ]);
  });
});

describe('AgentRunControlService retry', () => {
  it('pins the retry to the source Run version instead of the Agent current version', async () => {
    const assignmentId = '00000000-0000-7000-8000-000000000011';
    const sourcePolicySnapshot = buildAgentRunPolicySnapshot({
      agentVersion: {
        id: SOURCE_VERSION_ID,
        templateId: TEMPLATE_ID,
        version: 3,
        systemPrompt: 'Use the original snapshotted policy.',
        modelPolicy: { model: 'snapshot-model' },
        toolPolicy: { allowedTools: ['snapshot-tool'] },
        knowledgeScope: { knowledgeBaseIds: ['kb-snapshot'] },
        template: {
          id: TEMPLATE_ID,
          key: 'policy-specialist',
          name: 'Policy specialist',
        },
      },
      roleAssignment: {
        id: assignmentId,
        roleTemplateId: TEMPLATE_ID,
        roleVersionId: SOURCE_VERSION_ID,
      },
    });
    const sourceRun = {
      id: RUN_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      inputMessageId: '00000000-0000-7000-8000-000000000009',
      requesterUserId: USER_ID,
      agentId: '00000000-0000-7000-8000-000000000010',
      agentVersionId: SOURCE_VERSION_ID,
      taskId: TASK_ID,
      retryOfRunId: null,
      trigger: 'USER_MESSAGE',
      turnIndex: 1,
      turnLimit: 1,
      status: 'FAILED',
      policySnapshot: sourcePolicySnapshot,
      agent: {
        id: '00000000-0000-7000-8000-000000000010',
        versionId: CURRENT_VERSION_ID,
        status: 'ONLINE',
      },
      agentVersion: {
        id: SOURCE_VERSION_ID,
        templateId: TEMPLATE_ID,
        version: 3,
        status: 'RETIRED',
        systemPrompt: 'Drifted DB prompt that must not be retried.',
        modelPolicy: { model: 'drifted-db-model' },
        toolPolicy: { allowedTools: ['drifted-db-tool'] },
        knowledgeScope: { knowledgeBaseIds: ['kb-drifted-db'] },
        template: {
          id: TEMPLATE_ID,
          key: 'policy-specialist',
          name: 'Policy specialist',
        },
      },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(sourceRun)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        create: vi.fn().mockResolvedValue({}),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const identity = {
      getCurrentIdentity: vi.fn().mockResolvedValue({
        user: { id: USER_ID, tenantId: TENANT_ID },
      }),
    };
    const authorization = { requireCurrent: vi.fn() };
    const service = new AgentRunControlService(
      prisma as unknown as PrismaService,
      identity as unknown as IdentityService,
      {} as AgentRuntimeClient,
      authorization as unknown as AuthorizationService,
    );

    await expect(service.retry(CONVERSATION_ID, RUN_ID)).resolves.toMatchObject({
      status: 'queued',
    });

    const created = transaction.agentRun.create.mock.calls[0]?.[0]?.data;
    expect(created).toMatchObject({
      agentVersionId: SOURCE_VERSION_ID,
      taskId: TASK_ID,
      retryOfRunId: RUN_ID,
      policySnapshot: {
        snapshotSchemaVersion: 2,
        agentVersionId: SOURCE_VERSION_ID,
        agentVersion: 3,
        systemPrompt: 'Use the original snapshotted policy.',
        modelPolicy: { model: 'snapshot-model' },
        toolPolicy: { allowedTools: ['snapshot-tool'] },
        knowledgeScope: { knowledgeBaseIds: ['kb-snapshot'] },
        roleAssignmentId: assignmentId,
        retryOfRunId: RUN_ID,
        retryPinnedToSourceVersion: true,
      },
    });
    expect(created.agentVersionId).not.toBe(CURRENT_VERSION_ID);
  });
});

function createFixture() {
  const run = {
    id: RUN_ID,
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    status: 'RUNNING',
    externalRunId: EXTERNAL_RUN_ID,
    reservedTokens: 20_000,
  };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    agentRun: {
      findFirst: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockResolvedValue(run),
    },
    agentRunStreamEvent: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sequence: 10_000 } }),
      findFirst: vi.fn().mockResolvedValue({ id: 'reconciliation-delta' }),
      findMany: vi.fn().mockResolvedValue([
        {
          sequence: 1,
          type: 'TERMINAL_ONLY',
          terminalStatus: 'UNKNOWN',
        },
      ]),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withTenant: vi.fn(
      (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(transaction as unknown as Prisma.TransactionClient),
    ),
  };
  const identity = {
    getCurrentIdentity: vi.fn().mockResolvedValue({
      user: { id: USER_ID, tenantId: TENANT_ID },
    }),
  };
  const runtime = {
    cancel: vi.fn(),
  };
  const authorization = {
    requireCurrent: vi.fn(),
  };
  return {
    service: new AgentRunControlService(
      prisma as unknown as PrismaService,
      identity as unknown as IdentityService,
      runtime as unknown as AgentRuntimeClient,
      authorization as unknown as AuthorizationService,
    ),
    transaction,
    runtime,
    authorization,
  };
}
