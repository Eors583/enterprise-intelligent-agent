import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../../database/prisma.service.js';
import type { KnowledgeRetrievalService } from '../../../knowledge-retrieval/knowledge-retrieval.service.js';
import {
  exceedsConservativeInputBudget,
  PrismaAgentRunRepository,
} from './prisma-agent-run.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const RUN_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';
const AGENT_ID = '00000000-0000-7000-8000-000000000004';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000005';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000006';
const VERSION_ID = '00000000-0000-7000-8000-000000000007';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000008';

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
    const run = queuedRun();
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
      auditEvent: { create: vi.fn() },
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const retrieval = {
      search: vi.fn().mockRejectedValue(new Error('embedding provider unavailable')),
      areChunksAccessibleInTransaction: vi.fn(),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalService,
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).rejects.toThrow(
      'embedding provider unavailable',
    );

    expect(prisma.withTenant).toHaveBeenCalledOnce();
    expect(retrieval.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      query: 'What is the leave policy?',
      limit: 8,
    });
    expect(transaction.agentRun.update).not.toHaveBeenCalled();
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    expect(run.status).toBe('QUEUED');
  });

  it('resumes a known RUNNING execution for reconciliation without reserving or dispatching again', async () => {
    const externalRunId = '00000000-0000-7000-8000-000000000009';
    const run = {
      ...queuedRun(),
      status: 'RUNNING',
      externalRunId,
      dispatchStartedAt: new Date('2026-07-21T00:00:01.000Z'),
      startedAt: new Date('2026-07-21T00:00:02.000Z'),
      reservedTokens: 20_000,
    } as const;
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(run),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn(),
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
      auditEvent: { create: vi.fn() },
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const retrieval = {
      search: vi.fn().mockResolvedValue({ items: [] }),
      areChunksAccessibleInTransaction: vi.fn().mockResolvedValue(true),
    };
    const repository = new PrismaAgentRunRepository(
      prisma as unknown as PrismaService,
      retrieval as unknown as KnowledgeRetrievalService,
    );

    await expect(repository.prepare(TENANT_ID, RUN_ID)).resolves.toMatchObject({
      kind: 'ready',
      run: { id: RUN_ID, externalRunId },
    });
    expect(transaction.agentRun.updateMany).not.toHaveBeenCalled();
    expect(transaction.agentRun.update).not.toHaveBeenCalled();
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
    policySnapshot: {},
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
      settings: { visibility: 'tenant' },
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
    },
  } as const;
}
