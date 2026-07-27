import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Conversation,
  ConversationListResponse,
  CreateConversationRequest,
  CreateMessageRequest,
  Message,
  MessageListResponse,
} from '@enterprise/contracts';

import { AgentControlService } from '../agent-control/application/agent-control.service.js';
import { IdentityService } from '../identity/application/identity.service.js';
import { IdentityRepository } from '../identity/domain/identity.repository.js';
import {
  ActiveAgentRunConflictError,
  AgentUnavailableForRunError,
  ConversationRepository,
  MessageIdempotencyConflictError,
} from './domain/conversation.repository.js';

@Injectable()
export class ConversationService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(IdentityRepository) private readonly identities: IdentityRepository,
    @Inject(AgentControlService) private readonly agents: AgentControlService,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
  ) {}

  async list(): Promise<ConversationListResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    const items = await this.conversations.listForUser(user.tenantId, user.id);
    return { items: [...items] };
  }

  async create(request: CreateConversationRequest): Promise<Conversation> {
    const { tenant, user } = await this.identity.getCurrentIdentity();
    const currentParticipant = { type: 'user' as const, id: user.id, name: user.name };

    if (request.target.type === 'human') {
      if (request.target.userId === user.id) {
        throw new BadRequestException('A direct conversation cannot target the current user.');
      }
      const target = await this.identities.findUserById(tenant.id, request.target.userId);
      if (target === null || target.status !== 'active') {
        throw new NotFoundException('The target user is unavailable.');
      }
      const directKey = `human:${[user.id, target.id].sort().join(':')}`;
      return this.conversations.createDirect({
        tenantId: tenant.id,
        actorUserId: user.id,
        directKey,
        title: target.name,
        participants: [currentParticipant, { type: 'user', id: target.id, name: target.name }],
      });
    }

    const availableAgents = await this.agents.listMemberAgents();
    if (request.target.type === 'agent_pair') {
      const [agentAId, agentBId] = request.target.agentIds;
      const agentA = availableAgents.find((agent) => agent.id === agentAId);
      const agentB = availableAgents.find((agent) => agent.id === agentBId);
      if (
        agentA === undefined ||
        agentB === undefined ||
        !isExecutableAgent(agentA) ||
        !isExecutableAgent(agentB)
      ) {
        throw new NotFoundException('One or more target agents are unavailable.');
      }
      return this.conversations.createDirect({
        tenantId: tenant.id,
        actorUserId: user.id,
        directKey:
          `agent-pair:${user.id}:${agentA.id}:${agentB.id}:` + `turns:${request.target.turnLimit}`,
        title: `${agentA.name} ↔ ${agentB.name}`,
        participants: [
          currentParticipant,
          { type: 'agent', id: agentA.id, name: agentA.name },
          { type: 'agent', id: agentB.id, name: agentB.name },
        ],
        relay: {
          agentAId: agentA.id,
          agentBId: agentB.id,
          turnLimit: request.target.turnLimit,
        },
      });
    }

    const agentId = request.target.agentId;
    const target = availableAgents.find((agent) => agent.id === agentId);
    if (target === undefined || !isExecutableAgent(target)) {
      throw new NotFoundException('The target agent is unavailable.');
    }
    return this.conversations.createDirect({
      tenantId: tenant.id,
      actorUserId: user.id,
      directKey: `agent:${user.id}:${target.id}`,
      title: target.name,
      participants: [currentParticipant, { type: 'agent', id: target.id, name: target.name }],
    });
  }

  async listMessages(conversationId: string): Promise<MessageListResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    const snapshot = await this.conversations.listMessagesForUser(
      user.tenantId,
      user.id,
      conversationId,
    );
    if (snapshot === null) throw this.conversationNotFound();
    return { items: [...snapshot.items], runs: [...snapshot.runs] };
  }

  async createMessage(conversationId: string, request: CreateMessageRequest): Promise<Message> {
    const { user } = await this.identity.getCurrentIdentity();
    try {
      const message = await this.conversations.createUserMessage({
        tenantId: user.tenantId,
        conversationId,
        senderUserId: user.id,
        senderName: user.name,
        clientMessageId: request.clientMessageId,
        content: request.content,
      });
      if (message === null) throw this.conversationNotFound();
      return message;
    } catch (error) {
      if (
        error instanceof MessageIdempotencyConflictError ||
        error instanceof ActiveAgentRunConflictError ||
        error instanceof AgentUnavailableForRunError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  private conversationNotFound(): NotFoundException {
    return new NotFoundException('Conversation was not found.');
  }
}

function isExecutableAgent(agent: {
  readonly status: 'online' | 'offline' | 'disabled';
  readonly versionStatus: 'draft' | 'published' | 'retired';
}): boolean {
  return agent.status === 'online' && agent.versionStatus === 'published';
}
