import type {
  Conversation,
  ConversationAgentRun,
  ConversationParticipant,
  CreateTextMessageContent,
  Message,
} from '@enterprise/contracts';

export interface CreateDirectConversationInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly directKey: string;
  readonly title: string;
  readonly participants: readonly ConversationParticipant[];
  readonly relay?: {
    readonly agentAId: string;
    readonly agentBId: string;
    readonly turnLimit: number;
  };
}

export interface CreateUserMessageInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly senderUserId: string;
  readonly senderName: string;
  readonly clientMessageId: string;
  readonly content: CreateTextMessageContent;
}

export interface ConversationMessagesSnapshot {
  readonly items: readonly Message[];
  readonly runs: readonly ConversationAgentRun[];
}

export class MessageIdempotencyConflictError extends Error {
  constructor() {
    super('clientMessageId has already been used with different content.');
  }
}

export class ActiveAgentRunConflictError extends Error {
  constructor() {
    super('This conversation already has an active Agent Run.');
  }
}

export class AgentUnavailableForRunError extends Error {
  constructor() {
    super('One or more conversation Agents are not currently executable.');
  }
}

export abstract class ConversationRepository {
  abstract listForUser(tenantId: string, userId: string): Promise<readonly Conversation[]>;

  abstract findForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<Conversation | null>;

  abstract createDirect(input: CreateDirectConversationInput): Promise<Conversation>;

  abstract listMessagesForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationMessagesSnapshot | null>;

  abstract createUserMessage(input: CreateUserMessageInput): Promise<Message | null>;
}
