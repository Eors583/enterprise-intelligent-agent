import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Conversation, Message } from '@enterprise/contracts';

import {
  ConversationRepository,
  type ConversationMessagesSnapshot,
  type CreateDirectConversationInput,
  type CreateUserMessageInput,
  MessageIdempotencyConflictError,
} from '../../domain/conversation.repository.js';

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

  async listForUser(tenantId: string, userId: string): Promise<readonly Conversation[]> {
    return this.conversations
      .filter(
        (conversation) =>
          this.belongsToTenant(conversation.id, tenantId) &&
          this.hasUserParticipant(conversation, userId),
      )
      .sort((left, right) =>
        (right.lastMessageAt ?? right.updatedAt).localeCompare(
          left.lastMessageAt ?? left.updatedAt,
        ),
      )
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
      if (existing !== undefined) return this.withViewerTitle(existing, input.actorUserId);
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
    this.recordEvents(input.tenantId, conversation.id, 'conversation.created');
    return this.withViewerTitle(conversation, input.actorUserId);
  }

  async listMessagesForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationMessagesSnapshot | null> {
    const conversation = await this.findForUser(tenantId, userId, conversationId);
    if (conversation === null) return null;
    return {
      items: this.messages
        .filter((message) => message.conversationId === conversationId)
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        ),
      runs: [],
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
      if (existing.content.text !== input.content.text) {
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
      createdAt: timestamp,
    };
    this.messages.push(message);
    this.conversations = this.conversations.map((item) =>
      item.id === input.conversationId
        ? { ...item, lastMessageAt: timestamp, updatedAt: timestamp }
        : item,
    );
    this.recordEvents(input.tenantId, message.id, 'message.created');
    return message;
  }

  private readonly tenantByConversation = new Map<string, string>();
  private readonly directKeys = new Map<string, string>();

  private belongsToTenant(conversationId: string, tenantId: string): boolean {
    return this.tenantByConversation.get(conversationId) === tenantId;
  }

  private hasUserParticipant(conversation: Conversation, userId: string): boolean {
    return conversation.participants.some(
      (participant) => participant.type === 'user' && participant.id === userId,
    );
  }

  private withViewerTitle(conversation: Conversation, userId: string): Conversation {
    const otherParticipant = conversation.participants.find(
      (participant) => participant.type !== 'user' || participant.id !== userId,
    );
    return {
      ...conversation,
      title: otherParticipant?.name ?? conversation.title,
    };
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
