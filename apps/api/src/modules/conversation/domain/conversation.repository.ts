import type {
  Conversation,
  ConversationAgentRun,
  ConversationParticipant,
  CreateTextMessageContent,
  Message,
  MessageResponseTarget,
  UpdateConversationStateRequest,
} from '@enterprise/contracts';

export interface ConversationListOptions {
  readonly query?: string;
  readonly includeArchived: boolean;
}

export interface CreateDirectConversationInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly directKey: string;
  readonly title: string;
  readonly participants: readonly ConversationParticipant[];
  /** Shared member channels may add the member's Agent without evicting an existing participant. */
  readonly preserveExistingParticipants?: boolean;
  readonly relay?: {
    readonly agentAId: string;
    readonly agentBId: string;
    readonly turnLimit: number;
  };
}

export interface CreateGroupConversationInput {
  readonly tenantId: string;
  readonly actorUserId: string;
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
  readonly responseTarget?: MessageResponseTarget;
}

export interface ConversationMessagesSnapshot {
  readonly items: readonly Message[];
  readonly runs: readonly ConversationAgentRun[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ConversationMessagePage {
  readonly before?: string;
  readonly limit: number;
}

export interface UpdateGroupMembersInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly actorUserId: string;
  readonly add: readonly ConversationParticipant[];
  readonly remove: readonly { type: 'user' | 'agent'; id: string }[];
}

export class MessageIdempotencyConflictError extends Error {
  constructor() {
    super('clientMessageId has already been used with different content.');
  }
}

export class AgentUnavailableForRunError extends Error {
  constructor() {
    super('One or more conversation Agents are not currently executable.');
  }
}

export class ConversationResponseTargetUnavailableError extends Error {
  constructor() {
    super('The selected responder is not an active participant in this conversation.');
  }
}

export abstract class ConversationRepository {
  abstract listForUser(
    tenantId: string,
    userId: string,
    options?: ConversationListOptions,
  ): Promise<readonly Conversation[]>;

  abstract findForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<Conversation | null>;

  abstract createDirect(input: CreateDirectConversationInput): Promise<Conversation>;

  abstract createGroup(input: CreateGroupConversationInput): Promise<Conversation>;

  abstract listMessagesForUser(
    tenantId: string,
    userId: string,
    conversationId: string,
    page?: ConversationMessagePage,
  ): Promise<ConversationMessagesSnapshot | null>;

  abstract createUserMessage(input: CreateUserMessageInput): Promise<Message | null>;

  abstract markRead(
    tenantId: string,
    userId: string,
    conversationId: string,
    lastMessageId?: string,
  ): Promise<Conversation | null>;

  abstract updateState(
    tenantId: string,
    userId: string,
    conversationId: string,
    request: UpdateConversationStateRequest,
  ): Promise<Conversation | null>;

  abstract searchMessages(
    tenantId: string,
    userId: string,
    conversationId: string,
    query: string,
    limit: number,
  ): Promise<readonly Message[] | null>;

  abstract renameGroup(
    tenantId: string,
    actorUserId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation | null>;

  abstract updateGroupMembers(input: UpdateGroupMembersInput): Promise<Conversation | null>;
}
