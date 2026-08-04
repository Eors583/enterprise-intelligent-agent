import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../../database/prisma.service.js';
import { AgentUnavailableForRunError } from '../../domain/conversation.repository.js';
import {
  isAgentVisibleToUser,
  parseStoredTextContent,
  PrismaConversationRepository,
} from './prisma-conversation.repository.js';

describe('parseStoredTextContent', () => {
  it('normalizes a legacy knowledge citation instead of breaking historical message reads', () => {
    const content = parseStoredTextContent({
      type: 'text',
      text: '历史答案 [来源1]',
      citations: [
        {
          documentId: '00000000-0000-7000-8000-000000000501',
          knowledgeBaseId: '00000000-0000-7000-8000-000000000504',
          title: '请假制度',
          excerpt: '年假申请需提前发起。',
        },
      ],
    });

    expect(content.citations?.[0]).toMatchObject({
      verificationStatus: 'LEGACY',
      documentVersionId: null,
      chunkId: null,
      documentVersion: null,
      updatedAt: null,
    });
  });

  it('does not downgrade a partially populated new citation to a legacy citation', () => {
    expect(() =>
      parseStoredTextContent({
        type: 'text',
        text: '损坏的引用',
        citations: [
          {
            documentId: '00000000-0000-7000-8000-000000000501',
            knowledgeBaseId: '00000000-0000-7000-8000-000000000504',
            title: '请假制度',
            excerpt: '年假申请需提前发起。',
            chunkId: '00000000-0000-7000-8000-000000000503',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('Role Agent execution visibility', () => {
  const userId = '00000000-0000-7000-8000-000000000101';

  it('does not let the legacy owner fallback bypass an inactive assignment', () => {
    const settings = {
      visibility: 'owner',
      roleAssignmentId: '00000000-0000-7000-8000-000000000201',
    };

    expect(isAgentVisibleToUser(settings, userId, userId, false)).toBe(false);
    expect(isAgentVisibleToUser(settings, userId, userId, true)).toBe(true);
  });

  it('preserves owner visibility for historical personal Agents', () => {
    expect(isAgentVisibleToUser({ visibility: 'owner' }, userId, userId, false)).toBe(true);
  });

  it('fails closed when the Role Agent marker is malformed or only the relation remains', () => {
    expect(
      isAgentVisibleToUser({ visibility: 'owner', roleAssignmentId: '' }, userId, userId, false),
    ).toBe(false);
    expect(isAgentVisibleToUser({ visibility: 'owner' }, userId, userId, false, true)).toBe(false);
  });
});

describe('Conversation Agent Run stream capability', () => {
  it('maps a trusted Manus route to terminal-only before the terminal event exists', async () => {
    const tenantId = '00000000-0000-7000-8000-000000000901';
    const userId = '00000000-0000-7000-8000-000000000902';
    const conversationId = '00000000-0000-7000-8000-000000000903';
    const runId = '00000000-0000-7000-8000-000000000904';
    const transaction = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: conversationId,
          relayAgentAId: null,
          relayAgentBId: null,
          relayTurnLimit: null,
        }),
      },
      message: { findMany: vi.fn().mockResolvedValue([]) },
      agentRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: runId,
            inputMessageId: '00000000-0000-7000-8000-000000000905',
            outputMessageId: null,
            agentId: '00000000-0000-7000-8000-000000000906',
            agent: { name: '异步任务助手' },
            modelRouteSnapshot: {
              schemaVersion: 1,
              policyVersionId: '00000000-0000-7000-8000-000000000907',
              policyVersion: 1,
              policyHash: 'a'.repeat(64),
              taskClass: 'GENERAL',
              maximumClassification: 'INTERNAL',
              requiredCapabilities: ['chat'],
              maximumAttempts: 1,
              circuitFailureThreshold: 3,
              circuitOpenSeconds: 60,
              candidates: [
                {
                  ordinal: 1,
                  catalogVersionId: '00000000-0000-7000-8000-000000000908',
                  routeKey: 'MANUS-PRIMARY',
                  provider: 'MANUS',
                  model: 'manus-1',
                  credentialReference: 'vault://ai/providers/manus',
                },
              ],
            },
            streamEvents: [],
            status: 'RUNNING',
            errorCode: null,
            errorMessage: null,
            createdAt: new Date('2026-07-29T06:00:00.000Z'),
            startedAt: new Date('2026-07-29T06:00:01.000Z'),
            finishedAt: null,
          },
        ]),
      },
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (value: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const repository = new PrismaConversationRepository(prisma as unknown as PrismaService);

    const snapshot = await repository.listMessagesForUser(tenantId, userId, conversationId);

    expect(snapshot?.runs).toEqual([
      expect.objectContaining({ id: runId, streamMode: 'terminal_only' }),
    ]);
    expect(transaction.agentRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          streamEvents: expect.objectContaining({ take: 1 }),
        }),
      }),
    );
  });
});

describe('Role Agent Run snapshot creation', () => {
  it('stores a human response target and does not create an Agent Run', async () => {
    const fixture = conversationRunFixture(true);
    const responseTarget = {
      type: 'human' as const,
      userId: '00000000-0000-7000-8000-000000000399',
    };

    await fixture.repository.createUserMessage({ ...fixture.input, responseTarget });

    expect(fixture.transaction.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        responseTargetType: 'HUMAN',
        responseTargetId: responseTarget.userId,
      }),
    });
    expect(fixture.transaction.agentRun.create).not.toHaveBeenCalled();
    expect(fixture.transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ responseTarget }),
      }),
    });
  });

  it('creates an Agent Run only for the explicitly selected Agent participant', async () => {
    const fixture = conversationRunFixture(true);
    const responseTarget = {
      type: 'agent' as const,
      agentId: '00000000-0000-7000-8000-000000000305',
    };

    await fixture.repository.createUserMessage({ ...fixture.input, responseTarget });

    expect(fixture.transaction.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        responseTargetType: 'AGENT',
        responseTargetId: responseTarget.agentId,
      }),
    });
    expect(fixture.transaction.agentRun.create).toHaveBeenCalledTimes(1);
  });

  it('copies the effective Assignment and immutable role/prompt evidence into the Run snapshot', async () => {
    const fixture = conversationRunFixture(true);

    await expect(fixture.repository.createUserMessage(fixture.input)).resolves.toMatchObject({
      id: fixture.messageId,
    });

    const create = fixture.transaction.agentRun.create.mock.calls[0]?.[0];
    expect(create?.data).toMatchObject({
      agentVersionId: fixture.versionId,
      policySnapshot: {
        snapshotSchemaVersion: 2,
        agentVersionId: fixture.versionId,
        agentVersion: 4,
        roleAssignmentId: fixture.assignmentId,
        systemPrompt: 'Follow the approved HR role policy.',
        systemPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        role: {
          templateId: fixture.templateId,
          versionId: fixture.versionId,
          version: 4,
          key: 'hr-specialist',
          name: 'HR specialist',
        },
      },
    });
  });

  it('does not create a Run or snapshot when the Role Agent has no effective Assignment', async () => {
    const fixture = conversationRunFixture(false);

    await expect(fixture.repository.createUserMessage(fixture.input)).rejects.toBeInstanceOf(
      AgentUnavailableForRunError,
    );
    expect(fixture.transaction.agentRun.create).not.toHaveBeenCalled();
  });

  it('keeps an existing active assignment executable after its immutable version is superseded', async () => {
    const fixture = conversationRunFixture(true, 'RETIRED');

    await expect(fixture.repository.createUserMessage(fixture.input)).resolves.toMatchObject({
      id: fixture.messageId,
    });
    expect(fixture.transaction.agentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentVersionId: fixture.versionId,
        policySnapshot: expect.objectContaining({
          snapshotSchemaVersion: 2,
          roleAssignmentId: fixture.assignmentId,
          agentVersionId: fixture.versionId,
        }),
      }),
    });
  });

  it('does not make an unassigned retired Agent executable', async () => {
    const fixture = conversationRunFixture(false, 'RETIRED');

    await expect(fixture.repository.createUserMessage(fixture.input)).rejects.toBeInstanceOf(
      AgentUnavailableForRunError,
    );
    expect(fixture.transaction.agentRun.create).not.toHaveBeenCalled();
  });
});

function conversationRunFixture(
  assignmentActive: boolean,
  versionStatus: 'PUBLISHED' | 'RETIRED' = 'PUBLISHED',
) {
  const tenantId = '00000000-0000-7000-8000-000000000301';
  const userId = '00000000-0000-7000-8000-000000000302';
  const conversationId = '00000000-0000-7000-8000-000000000303';
  const messageId = '00000000-0000-7000-8000-000000000304';
  const agentId = '00000000-0000-7000-8000-000000000305';
  const assignmentId = '00000000-0000-7000-8000-000000000306';
  const templateId = '00000000-0000-7000-8000-000000000307';
  const versionId = '00000000-0000-7000-8000-000000000308';
  const createdAt = new Date('2026-07-28T04:00:00.000Z');
  const input = {
    tenantId,
    conversationId,
    senderUserId: userId,
    senderName: 'Employee',
    clientMessageId: 'role-run-snapshot-1',
    content: { type: 'text' as const, text: 'What is the leave policy?' },
  };
  const message = {
    id: messageId,
    tenantId,
    conversationId,
    senderType: 'USER',
    senderUserId: userId,
    senderAgentId: null,
    senderKey: `user:${userId}`,
    senderName: 'Employee',
    clientMessageId: input.clientMessageId,
    contentType: 'TEXT',
    content: input.content,
    createdAt,
  };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    conversation: {
      findFirst: vi.fn().mockResolvedValue({
        id: conversationId,
        relayAgentAId: null,
        relayAgentBId: null,
        relayTurnLimit: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(message),
    },
    conversationParticipant: {
      findFirst: vi.fn().mockResolvedValue({ id: 'participant-agent' }),
      findMany: vi.fn().mockResolvedValue([{ type: 'AGENT', userId: null, agentId }]),
    },
    agentInstance: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: agentId,
          tenantId,
          versionId,
          ownerUserId: userId,
          status: 'ONLINE',
          settings: { visibility: 'owner', roleAssignmentId: assignmentId },
          _count: { roleAssignments: 1 },
          roleAssignments: assignmentActive
            ? [
                {
                  id: assignmentId,
                  roleTemplateId: templateId,
                  roleVersionId: versionId,
                },
              ]
            : [],
          version: {
            id: versionId,
            tenantId,
            templateId,
            version: 4,
            status: versionStatus,
            systemPrompt: 'Follow the approved HR role policy.',
            modelPolicy: { provider: 'internal' },
            toolPolicy: { allowedTools: [] },
            knowledgeScope: { knowledgeBaseIds: ['kb-hr'] },
            template: {
              id: templateId,
              key: 'hr-specialist',
              name: 'HR specialist',
            },
          },
        },
      ]),
    },
    employment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue(null),
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
  return {
    repository: new PrismaConversationRepository(prisma as unknown as PrismaService),
    transaction,
    input,
    messageId,
    assignmentId,
    templateId,
    versionId,
  };
}
