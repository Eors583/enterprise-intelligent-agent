import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
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
import { AgentOperationalReadinessService } from '../ai-safety-model-routing/agent-operational-readiness.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
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
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(AgentOperationalReadinessService)
    private readonly operationalReadiness: AgentOperationalReadinessService,
  ) {}

  async list(): Promise<ConversationListResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.list',
      resourceTenantId: user.tenantId,
      risk: 'LOW',
    });
    const items = await this.conversations.listForUser(user.tenantId, user.id);
    return { items: [...items] };
  }

  async create(request: CreateConversationRequest): Promise<Conversation> {
    const { tenant, user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.create',
      resourceTenantId: tenant.id,
      risk: 'MEDIUM',
    });
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
      await this.requireOperationalAgents(tenant.id, [agentA.id, agentB.id]);
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
    await this.requireOperationalAgents(tenant.id, [target.id]);
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
    this.authorization.requireCurrent({
      action: 'conversation.read',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'LOW',
    });
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
    this.authorization.requireCurrent({
      action: 'conversation.message.create',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'MEDIUM',
    });
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

  private async requireOperationalAgents(
    tenantId: string,
    agentIds: readonly string[],
  ): Promise<void> {
    const availability = await this.operationalReadiness.inspectAgents(tenantId, agentIds);
    const unavailableAgentIds = agentIds.filter(
      (agentId) => availability.get(agentId)?.status !== 'AVAILABLE',
    );
    if (unavailableAgentIds.length > 0) {
      throw new ServiceUnavailableException({
        code: 'AGENT_OPERATIONAL_NOT_READY',
        message:
          'The target agent configuration is enabled, but verified model availability is not ready.',
        agentIds: unavailableAgentIds,
      });
    }
  }
}

export function isExecutableAgent(agent: {
  readonly status: 'online' | 'offline' | 'disabled';
  readonly versionStatus: 'draft' | 'testing' | 'published' | 'retired';
  readonly assignedToPrincipal: boolean;
  readonly requiresActiveAssignment: boolean;
}): boolean {
  return (
    agent.status === 'online' &&
    (agent.versionStatus === 'published' ||
      (agent.versionStatus === 'retired' &&
        agent.requiresActiveAssignment &&
        agent.assignedToPrincipal))
  );
}
