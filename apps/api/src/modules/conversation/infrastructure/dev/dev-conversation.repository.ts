import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Conversation, Message } from '@enterprise/contracts';

import {
  ConversationRepository,
  type ConversationListOptions,
  type ConversationMessagePage,
  type ConversationMessagesSnapshot,
  type CreateDirectConversationInput,
  type CreateGroupConversationInput,
  type CreateUserMessageInput,
  MessageIdempotencyConflictError,
  type UpdateGroupMembersInput,
} from '../../domain/conversation.repository.js';
import type { UpdateConversationStateRequest } from '@enterprise/contracts';

interface MemoryConversationState {
  unreadCount: number;
  lastReadMessageId: string | null;
  pinnedAt: string | null;
  archivedAt: string | null;
  mutedUntil: string | null;
}

interface MemoryEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly createdAt: string;
}

/** Development/test ledger. Production data must use PrismaConversationRepository. */
@Injectable()
export class DevConversationRepository extends ConversationRepository {
  private conversations: Conversation[] = [];
  private readonly messages: Message[] = [];
  private readonly outbox: MemoryEvent[] = [];
  private readonly audit: MemoryEvent[] = [];

  async listForUser(
    tenantId: string,
    userId: string,
    options: ConversationListOptions = { includeArchived: false },
  ): Promise<readonly Conversation[]> {
    const query = options.query?.toLocaleLowerCase();
    return this.conversations
      .filter(
        (conversation) =>
          this.belongsToTenant(conversation.id, tenantId) &&
          this.hasUserParticipant(conversation, userId) &&
          (options.includeArchived || this.state(conversation.id, userId).archivedAt === null) &&
          (query === undefined ||
            conversation.title?.toLocaleLowerCase().includes(query) === true ||
            conversation.participants.some((participant) =>
              participant.name.toLocaleLowerCase().includes(query),
            )),
      )
      .sort((left, right) => {
        const leftPinned = this.state(left.id, userId).pinnedAt;
        const rightPinned = this.state(right.id, userId).pinnedAt;
        if (leftPinned !== rightPinned)
          return rightPinned === null
            ? -1
            : leftPinned === null
              ? 1
              : rightPinned.localeCompare(leftPinned);
        return (right.lastMessageAt ?? right.updatedAt).localeCompare(
          left.lastMessageAt ?? left.updatedAt,
        );
      })
      .map((conversation) => this.withViewerTitle(conversation, userId));
  }

  async findForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<Conversation | null> {
    const conversation = this.conversations.find(
      (candidate) =>
        candidate.id === conversationId &&
        this.belongsToTenant(candidate.id, tenantId) &&
        this.hasUserParticipant(candidate, userId),
    );
    return conversation === undefined ? null : this.withViewerTitle(conversation, userId);
  }

  async createDirect(input: CreateDirectConversationInput): Promise<Conversation> {
    const existingId = this.directKeys.get(this.key(input.tenantId, input.directKey));
    if (existingId !== undefined) {
      const existing = this.conversations.find((item) => item.id === existingId);
      if (existing !== undefined) {
        if (input.preserveExistingParticipants === true) {
          const byKey = new Map(
            existing.participants.map((participant) => [
              `${participant.type}:${participant.id}`,
              participant,
            ]),
          );
          for (const participant of input.participants) {
            byKey.set(`${participant.type}:${participant.id}`, participant);
          }
          const merged = { ...existing, participants: [...byKey.values()] };
          this.conversations = this.conversations.map((item) =>
            item.id === existing.id ? merged : item,
          );
          return this.withViewerTitle(merged, input.actorUserId);
        }
        return this.withViewerTitle(existing, input.actorUserId);
      }
    }

    const timestamp = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      type: 'direct',
      title: input.title,
      participants: [...input.participants],
      lastMessageAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.conversations.push(conversation);
    this.tenantByConversation.set(conversation.id, input.tenantId);
    this.directKeys.set(this.key(input.tenantId, input.directKey), conversation.id);
    this.initializeStates(conversation);
    this.recordEvents(input.tenantId, conversation.id, 'conversation.created');
    return this.withViewerTitle(conversation, input.actorUserId);
  }

  async createGroup(input: CreateGroupConversationInput): Promise<Conversation> {
    const timestamp = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      type: 'group',
      title: input.title,
      participants: [...input.participants],
      lastMessageAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.conversations.push(conversation);
    this.tenantByConversation.set(conversation.id, input.tenantId);
    this.initializeStates(conversation);
    this.recordEvents(input.tenantId, conversation.id, 'conversation.created');
    return this.withViewerTitle(conversation, input.actorUserId);
  }

  async listMessagesForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
    page: ConversationMessagePage = { limit: 50 },
  ): Promise<ConversationMessagesSnapshot | null> {
    const conversation = await this.findForUser(tenantId, userId, conversationId);
    if (conversation === null) return null;
    const sorted = this.messages
      .filter((message) => message.conversationId === conversationId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
    const cursorIndex =
      page.before === undefined
        ? sorted.length
        : sorted.findIndex((message) => message.id === page.before);
    if (page.before !== undefined && cursorIndex < 0) return null;
    const start = Math.max(0, cursorIndex - page.limit);
    const items = sorted.slice(start, cursorIndex);
    return {
      items,
      runs: [],
      nextCursor: start > 0 ? (items[0]?.id ?? null) : null,
      hasMore: start > 0,
    };
  }

  async createUserMessage(input: CreateUserMessageInput): Promise<Message | null> {
    const conversation = await this.findForUser(
      input.tenantId,
      input.senderUserId,
      input.conversationId,
    );
    if (conversation === null) return null;

    const existing = this.messages.find(
      (message) =>
        message.conversationId === input.conversationId &&
        message.sender.type === 'user' &&
        message.sender.id === input.senderUserId &&
        message.clientMessageId === input.clientMessageId,
    );
    if (existing !== undefined) {
      if (
        existing.content.text !== input.content.text ||
        !sameResponseTarget(existing.responseTarget, input.responseTarget)
      ) {
        throw new MessageIdempotencyConflictError();
      }
      return existing;
    }

    const timestamp = new Date().toISOString();
    const message: Message = {
      id: randomUUID(),
      conversationId: input.conversationId,
      sender: { type: 'user', id: input.senderUserId, name: input.senderName },
      clientMessageId: input.clientMessageId,
      content: input.content,
      responseTarget: input.responseTarget ?? null,
      createdAt: timestamp,
    };
    this.messages.push(message);
    for (const participant of conversation.participants) {
      if (participant.type !== 'user') continue;
      const state = this.state(conversation.id, participant.id);
      this.states.set(this.stateKey(conversation.id, participant.id), {
        ...state,
        unreadCount: participant.id === input.senderUserId ? 0 : state.unreadCount + 1,
        lastReadMessageId:
          participant.id === input.senderUserId ? message.id : state.lastReadMessageId,
        archivedAt: participant.id === input.senderUserId ? state.archivedAt : null,
      });
    }
    this.conversations = this.conversations.map((item) =>
      item.id === input.conversationId
        ? { ...item, lastMessageAt: timestamp, updatedAt: timestamp }
        : item,
    );
    this.recordEvents(input.tenantId, message.id, 'message.created');
    return message;
  }

  async markRead(
    tenantId: string,
    userId: string,
    conversationId: string,
    lastMessageId?: string,
  ): Promise<Conversation | null> {
    const conversation = await this.findForUser(tenantId, userId, conversationId);
    if (conversation === null) return null;
    if (
      lastMessageId !== undefined &&
      !this.messages.some(
        (message) => message.id === lastMessageId && message.conversationId === conversationId,
      )
    ) {
      return null;
    }
    const latest =
      lastMessageId ??
      this.messages.filter((message) => message.conversationId === conversationId).at(-1)?.id ??
      null;
    this.states.set(this.stateKey(conversationId, userId), {
      ...this.state(conversationId, userId),
      unreadCount: 0,
      lastReadMessageId: latest,
    });
    return this.findForUser(tenantId, userId, conversationId);
  }

  async updateState(
    tenantId: string,
    userId: string,
    conversationId: string,
    request: UpdateConversationStateRequest,
  ): Promise<Conversation | null> {
    const conversation = await this.findForUser(tenantId, userId, conversationId);
    if (conversation === null) return null;
    const current = this.state(conversationId, userId);
    this.states.set(this.stateKey(conversationId, userId), {
      ...current,
      ...(request.pinned === undefined
        ? {}
        : { pinnedAt: request.pinned ? new Date().toISOString() : null }),
      ...(request.archived === undefined
        ? {}
        : { archivedAt: request.archived ? new Date().toISOString() : null }),
      ...(request.mutedUntil === undefined ? {} : { mutedUntil: request.mutedUntil }),
    });
    return this.findForUser(tenantId, userId, conversationId);
  }

  async searchMessages(
    tenantId: string,
    userId: string,
    conversationId: string,
    query: string,
    limit: number,
  ): Promise<readonly Message[] | null> {
    if ((await this.findForUser(tenantId, userId, conversationId)) === null) return null;
    const normalized = query.toLocaleLowerCase();
    return this.messages
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          message.content.text.toLocaleLowerCase().includes(normalized),
      )
      .slice(-limit)
      .reverse();
  }

  async renameGroup(
    tenantId: string,
    actorUserId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation | null> {
    const current = await this.findForUser(tenantId, actorUserId, conversationId);
    if (current === null || current.type !== 'group') return null;
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, title, updatedAt: new Date().toISOString() }
        : conversation,
    );
    return this.findForUser(tenantId, actorUserId, conversationId);
  }

  async updateGroupMembers(input: UpdateGroupMembersInput): Promise<Conversation | null> {
    const current = await this.findForUser(input.tenantId, input.actorUserId, input.conversationId);
    if (current === null || current.type !== 'group') return null;
    const removed = new Set(
      input.remove.map((participant) => `${participant.type}:${participant.id}`),
    );
    const participants = current.participants.filter(
      (participant) => !removed.has(`${participant.type}:${participant.id}`),
    );
    const byKey = new Map(
      participants.map((participant) => [`${participant.type}:${participant.id}`, participant]),
    );
    for (const participant of input.add) {
      byKey.set(`${participant.type}:${participant.id}`, participant);
    }
    const updated = {
      ...current,
      participants: [...byKey.values()],
      updatedAt: new Date().toISOString(),
    };
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === input.conversationId ? updated : conversation,
    );
    this.initializeStates(updated);
    return this.findForUser(input.tenantId, input.actorUserId, input.conversationId);
  }

  private readonly tenantByConversation = new Map<string, string>();
  private readonly directKeys = new Map<string, string>();
  private readonly states = new Map<string, MemoryConversationState>();

  private belongsToTenant(conversationId: string, tenantId: string): boolean {
    return this.tenantByConversation.get(conversationId) === tenantId;
  }

  private hasUserParticipant(conversation: Conversation, userId: string): boolean {
    return conversation.participants.some(
      (participant) => participant.type === 'user' && participant.id === userId,
    );
  }

  private withViewerTitle(conversation: Conversation, userId: string): Conversation {
    const state = this.state(conversation.id, userId);
    if (conversation.type === 'group') {
      return {
        ...conversation,
        unreadCount: state.unreadCount,
        pinnedAt: state.pinnedAt,
        archivedAt: state.archivedAt,
        mutedUntil: state.mutedUntil,
      };
    }
    const otherParticipant =
      conversation.participants.find(
        (participant) => participant.type === 'user' && participant.id !== userId,
      ) ??
      conversation.participants.find(
        (participant) => participant.type !== 'user' || participant.id !== userId,
      );
    return {
      ...conversation,
      title: otherParticipant?.name ?? conversation.title,
      unreadCount: state.unreadCount,
      pinnedAt: state.pinnedAt,
      archivedAt: state.archivedAt,
      mutedUntil: state.mutedUntil,
    };
  }

  private initializeStates(conversation: Conversation): void {
    for (const participant of conversation.participants) {
      if (participant.type === 'user') this.state(conversation.id, participant.id);
    }
  }

  private state(conversationId: string, userId: string): MemoryConversationState {
    const key = this.stateKey(conversationId, userId);
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const created: MemoryConversationState = {
      unreadCount: 0,
      lastReadMessageId: null,
      pinnedAt: null,
      archivedAt: null,
      mutedUntil: null,
    };
    this.states.set(key, created);
    return created;
  }

  private stateKey(conversationId: string, userId: string): string {
    return `${conversationId}:${userId}`;
  }

  private key(tenantId: string, directKey: string): string {
    return `${tenantId}:${directKey}`;
  }

  private recordEvents(tenantId: string, aggregateId: string, type: string): void {
    const event = {
      id: randomUUID(),
      tenantId,
      aggregateId,
      type,
      createdAt: new Date().toISOString(),
    };
    this.outbox.push(event);
    this.audit.push({ ...event, id: randomUUID() });
  }
}

function sameResponseTarget(
  left: Message['responseTarget'],
  right: CreateUserMessageInput['responseTarget'],
): boolean {
  const normalizedLeft = left ?? undefined;
  if (normalizedLeft === undefined || right === undefined) return normalizedLeft === right;
  if (normalizedLeft.type !== right.type) return false;
  return normalizedLeft.type === 'human'
    ? normalizedLeft.userId === (right.type === 'human' ? right.userId : null)
    : normalizedLeft.agentId === (right.type === 'agent' ? right.agentId : null);
}
