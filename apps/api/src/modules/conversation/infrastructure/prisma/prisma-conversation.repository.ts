import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  textMessageContentSchema,
  type Conversation,
  type ConversationAgentRun,
  type Message,
  type TextMessageContent,
} from '@enterprise/contracts';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../../database/prisma.service.js';
import {
  ActiveAgentRunConflictError,
  AgentUnavailableForRunError,
  ConversationRepository,
  type ConversationMessagesSnapshot,
  type CreateDirectConversationInput,
  type CreateUserMessageInput,
  MessageIdempotencyConflictError,
} from '../../domain/conversation.repository.js';

type ConversationWithParticipants = Prisma.ConversationGetPayload<{
  include: { participants: true };
}>;

@Injectable()
export class PrismaConversationRepository extends ConversationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  listForUser(tenantId: string, userId: string): Promise<readonly Conversation[]> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversations = await transaction.conversation.findMany({
        where: {
          tenantId,
          participants: {
            some: { tenantId, type: 'USER', userId, leftAt: null },
          },
        },
        include: { participants: { where: { tenantId, leftAt: null } } },
        orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
      });
      return conversations.map((conversation) => mapConversation(conversation, userId));
    });
  }

  findForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<Conversation | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversation = await transaction.conversation.findFirst({
        where: {
          id: conversationId,
          tenantId,
          participants: {
            some: { tenantId, type: 'USER', userId, leftAt: null },
          },
        },
        include: { participants: { where: { tenantId, leftAt: null } } },
      });
      return conversation === null ? null : mapConversation(conversation, userId);
    });
  }

  createDirect(input: CreateDirectConversationInput): Promise<Conversation> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      const lockKey = `${input.tenantId}:${input.directKey}`;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS lock_token
      `;

      const existing = await transaction.conversation.findFirst({
        where: { tenantId: input.tenantId, directKey: input.directKey },
        include: { participants: { where: { tenantId: input.tenantId } } },
      });
      if (existing !== null) {
        assertRelayConfiguration(existing, input);
        const expectedKeys = new Set(
          input.participants.map((participant) => `${participant.type}:${participant.id}`),
        );
        if (
          existing.participants.some(
            (participant) =>
              participant.leftAt === null && !expectedKeys.has(participant.participantKey),
          )
        ) {
          throw new Error('Stored direct conversation contains an unexpected participant.');
        }

        for (const participant of input.participants) {
          const participantKey = `${participant.type}:${participant.id}`;
          const stored = existing.participants.find(
            (candidate) => candidate.participantKey === participantKey,
          );
          if (stored === undefined) {
            await transaction.conversationParticipant.create({
              data: {
                tenantId: input.tenantId,
                conversationId: existing.id,
                type: participant.type === 'user' ? 'USER' : 'AGENT',
                participantKey,
                userId: participant.type === 'user' ? participant.id : null,
                agentId: participant.type === 'agent' ? participant.id : null,
                displayName: participant.name,
              },
            });
          } else {
            await transaction.conversationParticipant.updateMany({
              where: { id: stored.id, tenantId: input.tenantId },
              data: { leftAt: null, displayName: participant.name },
            });
          }
        }

        const reopened = await transaction.conversation.findFirst({
          where: { id: existing.id, tenantId: input.tenantId },
          include: { participants: { where: { tenantId: input.tenantId, leftAt: null } } },
        });
        if (reopened === null || reopened.participants.length !== input.participants.length) {
          throw new Error('Stored direct conversation could not be reopened safely.');
        }
        return mapConversation(reopened, input.actorUserId);
      }

      const conversation = await transaction.conversation.create({
        data: {
          tenantId: input.tenantId,
          type: 'DIRECT',
          directKey: input.directKey,
          title: input.title,
          createdById: input.actorUserId,
          relayAgentAId: input.relay?.agentAId ?? null,
          relayAgentBId: input.relay?.agentBId ?? null,
          relayTurnLimit: input.relay?.turnLimit ?? null,
          participants: {
            create: input.participants.map((participant) => ({
              type: participant.type === 'user' ? 'USER' : 'AGENT',
              participantKey: `${participant.type}:${participant.id}`,
              userId: participant.type === 'user' ? participant.id : null,
              agentId: participant.type === 'agent' ? participant.id : null,
              displayName: participant.name,
            })),
          },
        },
        include: { participants: true },
      });

      await Promise.all([
        transaction.outboxEvent.create({
          data: {
            tenantId: input.tenantId,
            aggregateType: 'conversation',
            aggregateId: conversation.id,
            eventType: 'conversation.created.v1',
            payload: {
              conversationId: conversation.id,
              type: 'direct',
              participants: input.participants.map((participant) => ({
                type: participant.type,
                id: participant.id,
              })),
            },
          },
        }),
        transaction.auditEvent.create({
          data: {
            tenantId: input.tenantId,
            actorType: 'USER',
            actorId: input.actorUserId,
            action: 'conversation.create',
            resourceType: 'conversation',
            resourceId: conversation.id,
            metadata: { directKey: input.directKey },
          },
        }),
      ]);

      return mapConversation(conversation, input.actorUserId);
    });
  }

  listMessagesForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationMessagesSnapshot | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversation = await transaction.conversation.findFirst({
        where: {
          id: conversationId,
          tenantId,
          participants: {
            some: { tenantId, type: 'USER', userId, leftAt: null },
          },
        },
        select: {
          id: true,
          relayAgentAId: true,
          relayAgentBId: true,
          relayTurnLimit: true,
        },
      });
      if (conversation === null) return null;

      const [messages, runs] = await Promise.all([
        transaction.message.findMany({
          where: { tenantId, conversationId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        transaction.agentRun.findMany({
          where: { tenantId, conversationId },
          include: { agent: { select: { name: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ]);
      return { items: messages.map(mapMessage), runs: runs.map(mapConversationRun) };
    });
  }

  async createUserMessage(input: CreateUserMessageInput): Promise<Message | null> {
    try {
      return await this.createUserMessageTransaction(input);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }

      return this.prisma.withTenant(input.tenantId, async (transaction) => {
        const existing = await transaction.message.findFirst({
          where: {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            senderKey: `user:${input.senderUserId}`,
            clientMessageId: input.clientMessageId,
          },
        });
        if (existing === null) throw error;
        if (parseStoredTextContent(existing.content).text !== input.content.text) {
          throw new MessageIdempotencyConflictError();
        }
        return mapMessage(existing);
      });
    }
  }

  private createUserMessageTransaction(input: CreateUserMessageInput): Promise<Message | null> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      const conversation = await transaction.conversation.findFirst({
        where: {
          id: input.conversationId,
          tenantId: input.tenantId,
          participants: {
            some: {
              tenantId: input.tenantId,
              type: 'USER',
              userId: input.senderUserId,
              leftAt: null,
            },
          },
        },
        select: {
          id: true,
          relayAgentAId: true,
          relayAgentBId: true,
          relayTurnLimit: true,
        },
      });
      if (conversation === null) return null;

      const senderKey = `user:${input.senderUserId}`;
      const lockKey = `${input.tenantId}:${input.conversationId}:${senderKey}:${input.clientMessageId}`;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS lock_token
      `;
      const existing = await transaction.message.findFirst({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          senderKey,
          clientMessageId: input.clientMessageId,
        },
      });
      if (existing !== null) {
        const existingContent = parseStoredTextContent(existing.content);
        if (existingContent.text !== input.content.text) {
          throw new MessageIdempotencyConflictError();
        }
        return mapMessage(existing);
      }

      const activeAgentParticipant = await transaction.conversationParticipant.findFirst({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          type: 'AGENT',
          leftAt: null,
        },
        select: { id: true },
      });
      if (activeAgentParticipant !== null) {
        const relayLockKey = `${input.tenantId}:${input.conversationId}:agent-run`;
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${relayLockKey}, 0))::text AS lock_token
        `;
        const activeRun = await transaction.agentRun.findFirst({
          where: {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] },
          },
          select: { id: true },
        });
        if (activeRun !== null) throw new ActiveAgentRunConflictError();
      }

      const message = await transaction.message.create({
        data: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          senderType: 'USER',
          senderUserId: input.senderUserId,
          senderKey,
          senderName: input.senderName,
          clientMessageId: input.clientMessageId,
          contentType: 'TEXT',
          content: { type: 'text', text: input.content.text },
        },
      });
      const recipients = await transaction.conversationParticipant.findMany({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          leftAt: null,
          NOT: { participantKey: senderKey },
        },
        select: { type: true, userId: true, agentId: true },
        orderBy: { participantKey: 'asc' },
      });
      if (recipients.length === 0) {
        throw new Error('A message event requires at least one active recipient.');
      }
      await transaction.conversation.updateMany({
        // Different client messages intentionally use different idempotency locks and may
        // commit out of order. Never let a later commit move the conversation clock back.
        where: {
          id: input.conversationId,
          tenantId: input.tenantId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }],
        },
        data: { lastMessageAt: message.createdAt },
      });
      await Promise.all([
        transaction.outboxEvent.create({
          data: {
            tenantId: input.tenantId,
            aggregateType: 'message',
            aggregateId: message.id,
            eventType: 'message.created.v1',
            payload: {
              messageId: message.id,
              conversationId: input.conversationId,
              sender: { type: 'user', id: input.senderUserId },
              recipients: recipients.map((recipient) => ({
                type: recipient.type === 'USER' ? 'user' : 'agent',
                id: recipient.userId ?? recipient.agentId,
              })),
              content: { type: 'text', text: input.content.text },
            },
          },
        }),
        transaction.auditEvent.create({
          data: {
            tenantId: input.tenantId,
            actorType: 'USER',
            actorId: input.senderUserId,
            action: 'message.create',
            resourceType: 'message',
            resourceId: message.id,
            metadata: { conversationId: input.conversationId },
          },
        }),
      ]);
      await enqueueInitialAgentRun(transaction, input, conversation, message.id, recipients);
      return mapMessage(message);
    });
  }
}

function mapConversationRun(run: {
  readonly id: string;
  readonly inputMessageId: string;
  readonly outputMessageId: string | null;
  readonly agentId: string;
  readonly agent: { readonly name: string };
  readonly status:
    'QUEUED' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}): ConversationAgentRun {
  return {
    id: run.id,
    inputMessageId: run.inputMessageId,
    outputMessageId: run.outputMessageId,
    agentId: run.agentId,
    agentName: run.agent.name,
    status: run.status,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    retryable: run.status === 'FAILED' || run.status === 'UNKNOWN' || run.status === 'CANCELLED',
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function mapConversation(source: ConversationWithParticipants, viewerUserId: string): Conversation {
  const participants = source.participants.map((participant) => ({
    type: participant.type === 'USER' ? ('user' as const) : ('agent' as const),
    id: participant.userId ?? participant.agentId ?? participant.id,
    name: participant.displayName,
  }));
  const otherParticipant = participants.find(
    (participant) => participant.type !== 'user' || participant.id !== viewerUserId,
  );
  return {
    id: source.id,
    type: 'direct',
    title: source.relayAgentAId !== null ? source.title : (otherParticipant?.name ?? source.title),
    participants,
    lastMessageAt: source.lastMessageAt?.toISOString() ?? null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function assertRelayConfiguration(
  source: {
    readonly relayAgentAId: string | null;
    readonly relayAgentBId: string | null;
    readonly relayTurnLimit: number | null;
  },
  input: CreateDirectConversationInput,
): void {
  const expected = input.relay;
  if (expected === undefined) {
    if (
      source.relayAgentAId !== null ||
      source.relayAgentBId !== null ||
      source.relayTurnLimit !== null
    ) {
      throw new Error('Stored direct conversation unexpectedly contains relay configuration.');
    }
    return;
  }
  if (
    source.relayAgentAId !== expected.agentAId ||
    source.relayAgentBId !== expected.agentBId ||
    source.relayTurnLimit !== expected.turnLimit
  ) {
    throw new Error('Stored relay conversation configuration does not match its direct key.');
  }
}

async function enqueueInitialAgentRun(
  transaction: Prisma.TransactionClient,
  input: CreateUserMessageInput,
  conversation: {
    readonly id: string;
    readonly relayAgentAId: string | null;
    readonly relayAgentBId: string | null;
    readonly relayTurnLimit: number | null;
  },
  messageId: string,
  recipients: readonly {
    readonly type: 'USER' | 'AGENT';
    readonly userId: string | null;
    readonly agentId: string | null;
  }[],
): Promise<void> {
  const agentRecipients = recipients.flatMap((recipient) =>
    recipient.type === 'AGENT' && recipient.agentId !== null ? [recipient.agentId] : [],
  );

  let agentId: string | null = null;
  let turnLimit = 1;
  if (
    conversation.relayAgentAId !== null &&
    conversation.relayAgentBId !== null &&
    conversation.relayTurnLimit !== null
  ) {
    const relayParticipantsAreActive =
      agentRecipients.includes(conversation.relayAgentAId) &&
      agentRecipients.includes(conversation.relayAgentBId);
    if (relayParticipantsAreActive) {
      agentId = conversation.relayAgentAId;
      turnLimit = conversation.relayTurnLimit;
    }
  } else if (agentRecipients.length === 1) {
    agentId = agentRecipients[0] ?? null;
  }

  if (agentId === null) return;
  const requiredAgentIds =
    turnLimit > 1 && conversation.relayAgentAId !== null && conversation.relayAgentBId !== null
      ? [conversation.relayAgentAId, conversation.relayAgentBId]
      : [agentId];
  const executableAgents = await transaction.agentInstance.findMany({
    where: { id: { in: requiredAgentIds }, tenantId: input.tenantId },
    include: { version: true },
  });
  if (
    executableAgents.length !== new Set(requiredAgentIds).size ||
    executableAgents.some(
      (candidate) =>
        candidate.status !== 'ONLINE' ||
        candidate.version.status !== 'PUBLISHED' ||
        !isAgentVisibleToUser(candidate.settings, candidate.ownerUserId, input.senderUserId),
    )
  ) {
    throw new AgentUnavailableForRunError();
  }
  const agent = executableAgents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) throw new AgentUnavailableForRunError();

  const runId = randomUUID();
  await transaction.agentRun.create({
    data: {
      id: runId,
      tenantId: input.tenantId,
      conversationId: conversation.id,
      inputMessageId: messageId,
      requesterUserId: input.senderUserId,
      agentId: agent.id,
      agentVersionId: agent.versionId,
      trigger: 'USER_MESSAGE',
      turnIndex: 1,
      turnLimit,
      idempotencyKey: `message:${messageId}:agent:${agent.id}`,
      policySnapshot: {
        agentVersionId: agent.versionId,
        version: agent.version.version,
        modelPolicy: agent.version.modelPolicy,
        toolPolicy: agent.version.toolPolicy,
        knowledgeScope: agent.version.knowledgeScope,
        relay: turnLimit > 1,
      },
    },
  });
  await transaction.outboxEvent.create({
    data: {
      tenantId: input.tenantId,
      aggregateType: 'agent_run',
      aggregateId: runId,
      eventType: 'agent.run_requested.v1',
      payload: { runId },
    },
  });
  await transaction.auditEvent.create({
    data: {
      tenantId: input.tenantId,
      actorType: 'USER',
      actorId: input.senderUserId,
      action: 'agent.run.request',
      resourceType: 'agent_run',
      resourceId: runId,
      metadata: {
        conversationId: conversation.id,
        inputMessageId: messageId,
        agentId: agent.id,
        turnIndex: 1,
        turnLimit,
      },
    },
  });
}

function isAgentVisibleToUser(
  settings: Prisma.JsonValue,
  ownerUserId: string | null,
  userId: string,
): boolean {
  if (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    settings.visibility === 'tenant'
  ) {
    return true;
  }
  return ownerUserId !== null && ownerUserId === userId;
}

function mapMessage(source: Prisma.MessageGetPayload<Record<string, never>>): Message {
  return {
    id: source.id,
    conversationId: source.conversationId,
    sender: {
      type: source.senderType === 'USER' ? 'user' : 'agent',
      id: source.senderUserId ?? source.senderAgentId ?? source.id,
      name: source.senderName,
    },
    clientMessageId: source.clientMessageId,
    content: parseStoredTextContent(source.content),
    createdAt: source.createdAt.toISOString(),
  };
}

export function parseStoredTextContent(content: Prisma.JsonValue): TextMessageContent {
  if (
    typeof content !== 'object' ||
    content === null ||
    Array.isArray(content) ||
    content.type !== 'text' ||
    typeof content.text !== 'string'
  ) {
    throw new Error('Stored message content is not a supported text payload.');
  }
  return textMessageContentSchema.parse(content);
}
