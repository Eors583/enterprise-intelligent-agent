import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  trustedModelRouteSnapshotSchema,
  textMessageContentSchema,
  type Conversation,
  type ConversationAgentRun,
  type Message,
  type TextMessageContent,
  type UpdateConversationStateRequest,
} from '@enterprise/contracts';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../../database/prisma.service.js';
import { hasRoleAgentAssignmentMarker } from '../../../agent-control/domain/role-agent-assignment.policy.js';
import { buildAgentRunPolicySnapshot } from '../../../agent-run/domain/agent-run-policy-snapshot.js';
import {
  AgentUnavailableForRunError,
  type ConversationListOptions,
  type ConversationMessagePage,
  ConversationResponseTargetUnavailableError,
  ConversationRepository,
  type ConversationMessagesSnapshot,
  type CreateDirectConversationInput,
  type CreateGroupConversationInput,
  type CreateUserMessageInput,
  MessageIdempotencyConflictError,
  type UpdateGroupMembersInput,
} from '../../domain/conversation.repository.js';

type ConversationWithParticipants = Prisma.ConversationGetPayload<{
  include: { participants: true; userStates: true };
}>;

@Injectable()
export class PrismaConversationRepository extends ConversationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  listForUser(
    tenantId: string,
    userId: string,
    options: ConversationListOptions = { includeArchived: false },
  ): Promise<readonly Conversation[]> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversations = await transaction.conversation.findMany({
        where: {
          tenantId,
          participants: {
            some: { tenantId, type: 'USER', userId, leftAt: null },
          },
          userStates: {
            some: {
              tenantId,
              userId,
              ...(options.includeArchived ? {} : { archivedAt: null }),
            },
          },
          ...(options.query === undefined
            ? {}
            : {
                OR: [
                  { title: { contains: options.query, mode: 'insensitive' as const } },
                  {
                    participants: {
                      some: {
                        tenantId,
                        leftAt: null,
                        displayName: { contains: options.query, mode: 'insensitive' as const },
                      },
                    },
                  },
                ],
              }),
        },
        include: {
          participants: { where: { tenantId, leftAt: null } },
          userStates: { where: { tenantId, userId } },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
      });
      return conversations
        .map((conversation) => mapConversation(conversation, userId))
        .sort(compareConversationListOrder);
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
        include: {
          participants: { where: { tenantId, leftAt: null } },
          userStates: { where: { tenantId, userId } },
        },
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
        include: {
          participants: { where: { tenantId: input.tenantId } },
          userStates: { where: { tenantId: input.tenantId, userId: input.actorUserId } },
        },
      });
      if (existing !== null) {
        assertRelayConfiguration(existing, input);
        const expectedKeys = new Set(
          input.participants.map((participant) => `${participant.type}:${participant.id}`),
        );
        if (
          input.preserveExistingParticipants !== true &&
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
          include: {
            participants: { where: { tenantId: input.tenantId, leftAt: null } },
            userStates: { where: { tenantId: input.tenantId, userId: input.actorUserId } },
          },
        });
        if (
          reopened === null ||
          (input.preserveExistingParticipants === true
            ? reopened.participants.length < input.participants.length
            : reopened.participants.length !== input.participants.length)
        ) {
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
              role: 'MEMBER',
              participantKey: `${participant.type}:${participant.id}`,
              userId: participant.type === 'user' ? participant.id : null,
              agentId: participant.type === 'agent' ? participant.id : null,
              displayName: participant.name,
            })),
          },
        },
        include: {
          participants: true,
          userStates: { where: { tenantId: input.tenantId, userId: input.actorUserId } },
        },
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

  createGroup(input: CreateGroupConversationInput): Promise<Conversation> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      const conversationId = randomUUID();
      const conversation = await transaction.conversation.create({
        data: {
          id: conversationId,
          tenantId: input.tenantId,
          type: 'GROUP',
          directKey: `group:${conversationId}`,
          title: input.title,
          createdById: input.actorUserId,
          relayAgentAId: input.relay?.agentAId ?? null,
          relayAgentBId: input.relay?.agentBId ?? null,
          relayTurnLimit: input.relay?.turnLimit ?? null,
          participants: {
            create: input.participants.map((participant) => ({
              type: participant.type === 'user' ? ('USER' as const) : ('AGENT' as const),
              role:
                participant.type === 'user' && participant.id === input.actorUserId
                  ? ('OWNER' as const)
                  : ('MEMBER' as const),
              participantKey: `${participant.type}:${participant.id}`,
              userId: participant.type === 'user' ? participant.id : null,
              agentId: participant.type === 'agent' ? participant.id : null,
              displayName: participant.name,
            })),
          },
        },
        include: {
          participants: true,
          userStates: { where: { tenantId: input.tenantId, userId: input.actorUserId } },
        },
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
              type: 'group',
              title: input.title,
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
            action: 'conversation.group.create',
            resourceType: 'conversation',
            resourceId: conversation.id,
            metadata: {
              participantCount: input.participants.length,
              brainstorming: input.relay !== undefined,
            },
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
    page: ConversationMessagePage = { limit: 50 },
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
          type: true,
          relayAgentAId: true,
          relayAgentBId: true,
          relayTurnLimit: true,
        },
      });
      if (conversation === null) return null;

      const cursor =
        page.before === undefined
          ? null
          : await transaction.message.findFirst({
              where: { tenantId, conversationId, id: page.before },
              select: { id: true, sequence: true },
            });
      if (page.before !== undefined && cursor === null) return null;

      const newestFirst = await transaction.message.findMany({
        where: {
          tenantId,
          conversationId,
          ...(cursor === null
            ? {}
            : {
                sequence: { lt: cursor.sequence },
              }),
        },
        orderBy: [{ sequence: 'desc' }],
        take: page.limit + 1,
      });
      const hasMore = newestFirst.length > page.limit;
      const messages = newestFirst.slice(0, page.limit).reverse();
      const messageIds = messages.map((message) => message.id);
      const runs = await transaction.agentRun.findMany({
        where: {
          tenantId,
          conversationId,
          ...(messageIds.length === 0
            ? {}
            : {
                OR: [
                  { inputMessageId: { in: messageIds } },
                  { outputMessageId: { in: messageIds } },
                ],
              }),
        },
        include: {
          agent: { select: { name: true } },
          streamEvents: {
            select: { type: true },
            orderBy: { sequence: 'desc' },
            take: 1,
          },
        },
        orderBy: [
          { conversationSequence: 'asc' },
          { turnIndex: 'asc' },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
      });
      return {
        items: messages.map(mapMessage),
        runs: runs.map(mapConversationRun),
        nextCursor: hasMore ? (messages[0]?.id ?? null) : null,
        hasMore,
      };
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
        if (
          parseStoredTextContent(existing.content).text !== input.content.text ||
          !sameResponseTarget(storedResponseTarget(existing), input.responseTarget)
        ) {
          throw new MessageIdempotencyConflictError();
        }
        return mapMessage(existing);
      });
    }
  }

  markRead(
    tenantId: string,
    userId: string,
    conversationId: string,
    lastMessageId?: string,
  ): Promise<Conversation | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversation = await findConversationForUser(
        transaction,
        tenantId,
        userId,
        conversationId,
      );
      if (conversation === null) return null;
      const lastMessage =
        lastMessageId === undefined
          ? await transaction.message.findFirst({
              where: { tenantId, conversationId },
              select: { id: true, createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            })
          : await transaction.message.findFirst({
              where: { tenantId, conversationId, id: lastMessageId },
              select: { id: true, createdAt: true },
            });
      if (lastMessageId !== undefined && lastMessage === null) return null;
      await transaction.conversationUserState.upsert({
        where: { tenantId_conversationId_userId: { tenantId, conversationId, userId } },
        create: {
          tenantId,
          conversationId,
          userId,
          unreadCount: 0,
          lastReadMessageId: lastMessage?.id ?? null,
          lastReadAt: lastMessage?.createdAt ?? new Date(),
        },
        update: {
          unreadCount: 0,
          lastReadMessageId: lastMessage?.id ?? null,
          lastReadAt: lastMessage?.createdAt ?? new Date(),
        },
      });
      return findConversationForUser(transaction, tenantId, userId, conversationId);
    });
  }

  updateState(
    tenantId: string,
    userId: string,
    conversationId: string,
    request: UpdateConversationStateRequest,
  ): Promise<Conversation | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversation = await findConversationForUser(
        transaction,
        tenantId,
        userId,
        conversationId,
      );
      if (conversation === null) return null;
      const now = new Date();
      await transaction.conversationUserState.upsert({
        where: { tenantId_conversationId_userId: { tenantId, conversationId, userId } },
        create: {
          tenantId,
          conversationId,
          userId,
          ...(request.pinned === true ? { pinnedAt: now } : {}),
          ...(request.archived === true ? { archivedAt: now } : {}),
          ...(request.mutedUntil === undefined
            ? {}
            : { mutedUntil: request.mutedUntil === null ? null : new Date(request.mutedUntil) }),
        },
        update: {
          ...(request.pinned === undefined ? {} : { pinnedAt: request.pinned ? now : null }),
          ...(request.archived === undefined ? {} : { archivedAt: request.archived ? now : null }),
          ...(request.mutedUntil === undefined
            ? {}
            : { mutedUntil: request.mutedUntil === null ? null : new Date(request.mutedUntil) }),
        },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId,
          actorType: 'USER',
          actorId: userId,
          action: 'conversation.state.update',
          resourceType: 'conversation',
          resourceId: conversationId,
          metadata: {
            pinned: request.pinned ?? null,
            archived: request.archived ?? null,
            mutedUntil: request.mutedUntil ?? null,
          },
        },
      });
      return findConversationForUser(transaction, tenantId, userId, conversationId);
    });
  }

  searchMessages(
    tenantId: string,
    userId: string,
    conversationId: string,
    query: string,
    limit: number,
  ): Promise<readonly Message[] | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const conversation = await findConversationForUser(
        transaction,
        tenantId,
        userId,
        conversationId,
      );
      if (conversation === null) return null;
      const messages = await transaction.message.findMany({
        where: {
          tenantId,
          conversationId,
          content: { path: ['text'], string_contains: query, mode: 'insensitive' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return messages.map(mapMessage);
    });
  }

  renameGroup(
    tenantId: string,
    actorUserId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation | null> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const group = await transaction.conversation.findFirst({
        where: {
          tenantId,
          id: conversationId,
          type: 'GROUP',
          participants: {
            some: {
              tenantId,
              userId: actorUserId,
              type: 'USER',
              role: { in: ['OWNER', 'ADMIN'] },
              leftAt: null,
            },
          },
        },
        select: { id: true },
      });
      if (group === null) return null;
      await transaction.conversation.updateMany({
        where: { tenantId, id: conversationId, type: 'GROUP' },
        data: { title },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId,
          actorType: 'USER',
          actorId: actorUserId,
          action: 'conversation.group.rename',
          resourceType: 'conversation',
          resourceId: conversationId,
          metadata: { title },
        },
      });
      return findConversationForUser(transaction, tenantId, actorUserId, conversationId);
    });
  }

  updateGroupMembers(input: UpdateGroupMembersInput): Promise<Conversation | null> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      const group = await transaction.conversation.findFirst({
        where: {
          tenantId: input.tenantId,
          id: input.conversationId,
          type: 'GROUP',
          participants: {
            some: {
              tenantId: input.tenantId,
              userId: input.actorUserId,
              type: 'USER',
              role: { in: ['OWNER', 'ADMIN'] },
              leftAt: null,
            },
          },
        },
        include: { participants: { where: { tenantId: input.tenantId, leftAt: null } } },
      });
      if (group === null) return null;
      const owner = group.participants.find((participant) => participant.role === 'OWNER');
      if (
        owner !== undefined &&
        input.remove.some(
          (participant) => participant.type === 'user' && participant.id === owner.userId,
        )
      ) {
        throw new Error('The group owner cannot be removed.');
      }

      for (const participant of input.add) {
        const participantKey = `${participant.type}:${participant.id}`;
        await transaction.conversationParticipant.upsert({
          where: {
            tenantId_conversationId_participantKey: {
              tenantId: input.tenantId,
              conversationId: input.conversationId,
              participantKey,
            },
          },
          create: {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            type: participant.type === 'user' ? 'USER' : 'AGENT',
            role: 'MEMBER',
            participantKey,
            userId: participant.type === 'user' ? participant.id : null,
            agentId: participant.type === 'agent' ? participant.id : null,
            displayName: participant.name,
          },
          update: { leftAt: null, role: 'MEMBER', displayName: participant.name },
        });
      }
      for (const participant of input.remove) {
        await transaction.conversationParticipant.updateMany({
          where: {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            participantKey: `${participant.type}:${participant.id}`,
            role: { not: 'OWNER' },
            leftAt: null,
          },
          data: { leftAt: new Date() },
        });
      }
      const activeUserCount = await transaction.conversationParticipant.count({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          type: 'USER',
          leftAt: null,
        },
      });
      if (activeUserCount < 2) throw new Error('A group requires at least two active members.');
      await transaction.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: 'USER',
          actorId: input.actorUserId,
          action: 'conversation.group.members.update',
          resourceType: 'conversation',
          resourceId: input.conversationId,
          metadata: {
            added: input.add.map((participant) => ({
              type: participant.type,
              id: participant.id,
            })),
            removed: input.remove,
          },
        },
      });
      return findConversationForUser(
        transaction,
        input.tenantId,
        input.actorUserId,
        input.conversationId,
      );
    });
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
          type: true,
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
        if (
          existingContent.text !== input.content.text ||
          !sameResponseTarget(storedResponseTarget(existing), input.responseTarget)
        ) {
          throw new MessageIdempotencyConflictError();
        }
        return mapMessage(existing);
      }

      // Allocate the message and its initial Run while holding the same durable
      // conversation lock used by terminal Run writes. Every question is
      // accepted; the lock only establishes a database order and never waits
      // for model execution.
      const conversationLockKey = `${input.tenantId}:${input.conversationId}:agent-run`;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${conversationLockKey}, 0))::text AS lock_token
      `;

      if (input.responseTarget !== undefined) {
        const responseParticipant = await transaction.conversationParticipant.findFirst({
          where: {
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            leftAt: null,
            ...(input.responseTarget.type === 'human'
              ? { type: 'USER' as const, userId: input.responseTarget.userId }
              : { type: 'AGENT' as const, agentId: input.responseTarget.agentId }),
          },
          select: { participantKey: true },
        });
        if (
          responseParticipant === null ||
          (input.responseTarget.type === 'human' &&
            input.responseTarget.userId === input.senderUserId)
        ) {
          throw new ConversationResponseTargetUnavailableError();
        }
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
          responseTargetType:
            input.responseTarget === undefined
              ? null
              : input.responseTarget.type === 'human'
                ? 'HUMAN'
                : 'AGENT',
          responseTargetId:
            input.responseTarget === undefined
              ? null
              : input.responseTarget.type === 'human'
                ? input.responseTarget.userId
                : input.responseTarget.agentId,
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
              conversationType: conversation.type === 'GROUP' ? 'group' : 'direct',
              sender: { type: 'user', id: input.senderUserId },
              recipients: recipients.map((recipient) => ({
                type: recipient.type === 'USER' ? 'user' : 'agent',
                id: recipient.userId ?? recipient.agentId,
              })),
              content: { type: 'text', text: input.content.text },
              responseTarget: input.responseTarget ?? null,
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
      await enqueueInitialAgentRun(
        transaction,
        input,
        conversation,
        message.id,
        recipients,
        input.responseTarget,
      );
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
  readonly modelRouteSnapshot: Prisma.JsonValue | null;
  readonly streamEvents: ReadonlyArray<{
    readonly type: 'DELTA' | 'TERMINAL' | 'TERMINAL_ONLY' | 'TERMINAL_RECONCILED';
  }>;
  readonly status:
    'QUEUED' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly supersededByRunId: string | null;
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
    streamMode: resolveConversationRunStreamMode(run.modelRouteSnapshot, run.streamEvents),
    status: run.status,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    supersededByRunId: run.supersededByRunId,
    retryable: run.status === 'FAILED' || run.status === 'CANCELLED',
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function resolveConversationRunStreamMode(
  modelRouteSnapshot: Prisma.JsonValue | null,
  streamEvents: ReadonlyArray<{
    readonly type: 'DELTA' | 'TERMINAL' | 'TERMINAL_ONLY' | 'TERMINAL_RECONCILED';
  }>,
): ConversationAgentRun['streamMode'] {
  const latestEvent = streamEvents[0]?.type;
  if (latestEvent === 'DELTA' || latestEvent === 'TERMINAL') return 'live';
  if (latestEvent === 'TERMINAL_ONLY') return 'terminal_only';

  const route = trustedModelRouteSnapshotSchema.safeParse(modelRouteSnapshot);
  if (!route.success) return null;
  const firstCandidate = route.data.candidates.reduce((first, candidate) =>
    candidate.ordinal < first.ordinal ? candidate : first,
  );
  return firstCandidate.provider === 'MANUS' ? 'terminal_only' : 'live';
}

async function findConversationForUser(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const conversation = await transaction.conversation.findFirst({
    where: {
      tenantId,
      id: conversationId,
      participants: { some: { tenantId, type: 'USER', userId, leftAt: null } },
    },
    include: {
      participants: { where: { tenantId, leftAt: null } },
      userStates: { where: { tenantId, userId } },
    },
  });
  return conversation === null ? null : mapConversation(conversation, userId);
}

function mapConversation(source: ConversationWithParticipants, viewerUserId: string): Conversation {
  const participants = source.participants.map((participant) => ({
    type: participant.type === 'USER' ? ('user' as const) : ('agent' as const),
    id: participant.userId ?? participant.agentId ?? participant.id,
    name: participant.displayName,
    role: participant.role.toLowerCase() as 'owner' | 'admin' | 'member',
  }));
  const state = source.userStates?.[0];
  const otherParticipant =
    participants.find(
      (participant) => participant.type === 'user' && participant.id !== viewerUserId,
    ) ??
    participants.find(
      (participant) => participant.type !== 'user' || participant.id !== viewerUserId,
    );
  return {
    id: source.id,
    type: source.type === 'GROUP' ? 'group' : 'direct',
    title:
      source.type === 'GROUP' || source.relayAgentAId !== null
        ? source.title
        : (otherParticipant?.name ?? source.title),
    participants,
    lastMessageAt: source.lastMessageAt?.toISOString() ?? null,
    unreadCount: state?.unreadCount ?? 0,
    pinnedAt: state?.pinnedAt?.toISOString() ?? null,
    archivedAt: state?.archivedAt?.toISOString() ?? null,
    mutedUntil: state?.mutedUntil?.toISOString() ?? null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function compareConversationListOrder(left: Conversation, right: Conversation): number {
  if (left.pinnedAt !== right.pinnedAt) {
    if (left.pinnedAt === null || left.pinnedAt === undefined) return 1;
    if (right.pinnedAt === null || right.pinnedAt === undefined) return -1;
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  return (right.lastMessageAt ?? right.updatedAt).localeCompare(
    left.lastMessageAt ?? left.updatedAt,
  );
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
  responseTarget: CreateUserMessageInput['responseTarget'],
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
  } else if (responseTarget?.type === 'human') {
    return;
  } else if (responseTarget?.type === 'agent') {
    agentId = agentRecipients.includes(responseTarget.agentId) ? responseTarget.agentId : null;
  } else if (agentRecipients.length === 1) {
    agentId = agentRecipients[0] ?? null;
  }

  if (agentId === null) return;
  const requiredAgentIds =
    turnLimit > 1 && conversation.relayAgentAId !== null && conversation.relayAgentBId !== null
      ? [conversation.relayAgentAId, conversation.relayAgentBId]
      : [agentId];
  const now = new Date();
  const executableAgents = await transaction.agentInstance.findMany({
    where: { id: { in: requiredAgentIds }, tenantId: input.tenantId },
    include: {
      version: { include: { template: true } },
      _count: { select: { roleAssignments: true } },
      roleAssignments: {
        where: {
          tenantId: input.tenantId,
          userId: input.senderUserId,
          status: 'ACTIVE',
          effectiveFrom: { lte: now },
          AND: [
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
            { employment: { is: { userId: input.senderUserId, status: 'ACTIVE' } } },
          ],
        },
        select: {
          id: true,
          roleTemplateId: true,
          roleVersionId: true,
        },
        take: 1,
      },
    },
  });
  const activeEmploymentOrgUnitIds = new Set(
    (
      await transaction.employment.findMany({
        where: {
          tenantId: input.tenantId,
          userId: input.senderUserId,
          status: 'ACTIVE',
        },
        select: { orgUnitId: true },
      })
    ).map((employment) => employment.orgUnitId),
  );
  if (
    executableAgents.length !== new Set(requiredAgentIds).size ||
    executableAgents.some(
      (candidate) =>
        candidate.status !== 'ONLINE' ||
        (candidate.version.status !== 'PUBLISHED' &&
          !(
            candidate.version.status === 'RETIRED' &&
            candidate.roleAssignments.length > 0 &&
            candidate._count.roleAssignments > 0
          )) ||
        (candidate.kind === 'DEPARTMENT' &&
          (candidate.orgUnitId === null || !activeEmploymentOrgUnitIds.has(candidate.orgUnitId))) ||
        !isAgentVisibleToUser(
          candidate.settings,
          candidate.ownerUserId,
          input.senderUserId,
          candidate.roleAssignments.length > 0,
          candidate._count.roleAssignments > 0,
        ),
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
      policySnapshot: buildAgentRunPolicySnapshot({
        agentVersion: agent.version,
        roleAssignment: agent.roleAssignments[0] ?? null,
        knowledgeScopeOverride: effectiveAgentKnowledgeScope(
          agent.settings,
          agent.version.knowledgeScope,
        ),
        extra: { relay: turnLimit > 1 },
      }),
    },
  });
  const superseded = await transaction.agentRun.updateMany({
    where: {
      tenantId: input.tenantId,
      conversationId: conversation.id,
      status: 'UNKNOWN',
      supersededByRunId: null,
      id: { not: runId },
    },
    data: {
      supersededByRunId: runId,
      supersededAt: now,
      version: { increment: 1 },
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
        supersededUnknownRunCount: superseded.count,
      },
    },
  });
}

export function isAgentVisibleToUser(
  settings: Prisma.JsonValue,
  ownerUserId: string | null,
  userId: string,
  hasActiveAssignment = false,
  hasAnyRoleAssignment = hasActiveAssignment,
): boolean {
  if (hasRoleAgentAssignmentMarker(settings) || hasAnyRoleAssignment) return hasActiveAssignment;
  if (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    (settings.visibility === 'tenant' || settings.visibility === 'department')
  ) {
    return true;
  }
  return ownerUserId !== null && ownerUserId === userId;
}

function effectiveAgentKnowledgeScope(
  settings: Prisma.JsonValue,
  versionScope: Prisma.JsonValue,
): Prisma.JsonValue {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    Array.isArray(settings) ||
    !Array.isArray(settings.knowledgeBaseIdsOverride)
  ) {
    return versionScope;
  }
  const knowledgeBaseIds = [
    ...new Set(
      settings.knowledgeBaseIdsOverride.filter((id): id is string => typeof id === 'string'),
    ),
  ]
    .sort()
    .slice(0, 50);
  const base =
    typeof versionScope === 'object' && versionScope !== null && !Array.isArray(versionScope)
      ? (JSON.parse(JSON.stringify(versionScope)) as Prisma.JsonObject)
      : {};
  return { ...base, knowledgeBaseIds };
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
    responseTarget: storedResponseTarget(source) ?? null,
    createdAt: source.createdAt.toISOString(),
  };
}

function storedResponseTarget(source: {
  readonly responseTargetType: string | null;
  readonly responseTargetId: string | null;
}): CreateUserMessageInput['responseTarget'] | undefined {
  if (source.responseTargetType === 'HUMAN' && source.responseTargetId !== null) {
    return { type: 'human', userId: source.responseTargetId };
  }
  if (source.responseTargetType === 'AGENT' && source.responseTargetId !== null) {
    return { type: 'agent', agentId: source.responseTargetId };
  }
  return undefined;
}

function sameResponseTarget(
  left: CreateUserMessageInput['responseTarget'],
  right: CreateUserMessageInput['responseTarget'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.type !== right.type) return false;
  return left.type === 'human'
    ? left.userId === (right.type === 'human' ? right.userId : null)
    : left.agentId === (right.type === 'agent' ? right.agentId : null);
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
