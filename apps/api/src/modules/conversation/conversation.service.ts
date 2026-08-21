import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  Conversation,
  ConversationListQuery,
  ConversationListResponse,
  CreateConversationRequest,
  CreateMessageRequest,
  MarkConversationReadRequest,
  Message,
  MessageListQuery,
  MessageListResponse,
  MessageSearchQuery,
  MessageSearchResponse,
  UpdateConversationStateRequest,
  UpdateGroupMembersRequest,
  UpdateGroupRequest,
} from '@enterprise/contracts';

import { AgentControlService } from '../agent-control/application/agent-control.service.js';
import { AgentRunWorker } from '../agent-run/application/agent-run.worker.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { IdentityService } from '../identity/application/identity.service.js';
import { IdentityRepository } from '../identity/domain/identity.repository.js';
import {
  AgentUnavailableForRunError,
  ConversationResponseTargetUnavailableError,
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
    @Optional()
    @Inject(AgentRunWorker)
    private readonly agentRuns?: AgentRunWorker,
  ) {}

  async list(
    query: ConversationListQuery = { includeArchived: false },
  ): Promise<ConversationListResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.list',
      resourceTenantId: user.tenantId,
      risk: 'LOW',
    });
    const items = await this.conversations.listForUser(user.tenantId, user.id, {
      includeArchived: query.includeArchived,
      ...(query.query === undefined ? {} : { query: query.query }),
    });
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

    if (request.type === 'group') {
      if (request.memberUserIds.includes(user.id)) {
        throw new BadRequestException('The current user is added to a group automatically.');
      }
      const members = await Promise.all(
        request.memberUserIds.map((memberUserId) =>
          this.identities.findUserById(tenant.id, memberUserId),
        ),
      );
      if (members.some((member) => member === null || member.status !== 'active')) {
        throw new NotFoundException('One or more group members are unavailable.');
      }
      const availableAgents = await this.listAvailableAgents();
      const selectedAgents = request.agentIds.map((agentId) =>
        availableAgents.find((agent) => agent.id === agentId),
      );
      if (selectedAgents.some((agent) => agent === undefined || !isExecutableAgent(agent))) {
        throw new NotFoundException('One or more group Agents are unavailable.');
      }
      return this.conversations.createGroup({
        tenantId: tenant.id,
        actorUserId: user.id,
        title: request.title,
        participants: [
          { ...currentParticipant, role: 'owner' },
          ...members.map((member) => ({
            type: 'user' as const,
            id: member!.id,
            name: member!.name,
            role: 'member' as const,
          })),
          ...selectedAgents.map((agent) => ({
            type: 'agent' as const,
            id: agent!.id,
            name: agent!.name,
            role: 'member' as const,
          })),
        ],
        ...(request.agentIds.length === 2
          ? {
              relay: {
                agentAId: request.agentIds[0]!,
                agentBId: request.agentIds[1]!,
                turnLimit: 4,
              },
            }
          : {}),
      });
    }

    if (request.target.type === 'human') {
      if (request.target.userId === user.id) {
        throw new BadRequestException('A direct conversation cannot target the current user.');
      }
      const target = await this.identities.findUserById(tenant.id, request.target.userId);
      if (target === null || target.status !== 'active') {
        throw new NotFoundException('The target user is unavailable.');
      }
      const availableAgents = await this.agents.listMemberAgents();
      const memberAgent = availableAgents.find(
        (agent) => agent.ownerUserId === target.id && isExecutableAgent(agent),
      );
      return this.conversations.createDirect({
        tenantId: tenant.id,
        actorUserId: user.id,
        directKey: memberChannelKey(user.id, target.id),
        title: target.name,
        participants: [
          currentParticipant,
          { type: 'user', id: target.id, name: target.name },
          ...(memberAgent === undefined
            ? []
            : [
                {
                  type: 'agent' as const,
                  id: memberAgent.id,
                  name: `${target.name}的智能体`,
                },
              ]),
        ],
        preserveExistingParticipants: true,
      });
    }

    const availableAgents = await this.listAvailableAgents();
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
    if (!('ownerUserId' in target)) {
      return this.conversations.createDirect({
        tenantId: tenant.id,
        actorUserId: user.id,
        directKey: `department-assistant:${user.id}:${target.id}`,
        title: target.name,
        participants: [currentParticipant, { type: 'agent', id: target.id, name: target.name }],
        preserveExistingParticipants: true,
      });
    }
    const owner = await this.identities.findUserById(tenant.id, target.ownerUserId);
    if (owner === null || owner.status !== 'active') {
      throw new NotFoundException('The Agent owner is unavailable.');
    }
    return this.conversations.createDirect({
      tenantId: tenant.id,
      actorUserId: user.id,
      directKey: memberChannelKey(user.id, owner.id),
      title: owner.name,
      participants: [
        currentParticipant,
        ...(owner.id === user.id
          ? []
          : [{ type: 'user' as const, id: owner.id, name: owner.name }]),
        { type: 'agent', id: target.id, name: `${owner.name}的智能体` },
      ],
      preserveExistingParticipants: true,
    });
  }

  async listMessages(
    conversationId: string,
    page: MessageListQuery = { limit: 50 },
  ): Promise<MessageListResponse> {
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
      { limit: page.limit, ...(page.before === undefined ? {} : { before: page.before }) },
    );
    if (snapshot === null) throw this.conversationNotFound();
    return {
      items: [...snapshot.items],
      runs: [...snapshot.runs],
      nextCursor: snapshot.nextCursor,
      hasMore: snapshot.hasMore,
    };
  }

  async markRead(
    conversationId: string,
    request: MarkConversationReadRequest,
  ): Promise<Conversation> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.state.update',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'LOW',
    });
    const conversation = await this.conversations.markRead(
      user.tenantId,
      user.id,
      conversationId,
      request.lastMessageId,
    );
    if (conversation === null) throw this.conversationNotFound();
    return conversation;
  }

  async updateState(
    conversationId: string,
    request: UpdateConversationStateRequest,
  ): Promise<Conversation> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.state.update',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'MEDIUM',
    });
    const conversation = await this.conversations.updateState(
      user.tenantId,
      user.id,
      conversationId,
      request,
    );
    if (conversation === null) throw this.conversationNotFound();
    return conversation;
  }

  async searchMessages(
    conversationId: string,
    query: MessageSearchQuery,
  ): Promise<MessageSearchResponse> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.search',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'LOW',
    });
    const messages = await this.conversations.searchMessages(
      user.tenantId,
      user.id,
      conversationId,
      query.query,
      query.limit,
    );
    if (messages === null) throw this.conversationNotFound();
    return { items: [...messages] };
  }

  async renameGroup(conversationId: string, request: UpdateGroupRequest): Promise<Conversation> {
    const { user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.group.manage',
      resourceTenantId: user.tenantId,
      taskContext: { taskId: conversationId },
      risk: 'MEDIUM',
    });
    const conversation = await this.conversations.renameGroup(
      user.tenantId,
      user.id,
      conversationId,
      request.title,
    );
    if (conversation === null) throw this.conversationNotFound();
    return conversation;
  }

  async updateGroupMembers(
    conversationId: string,
    request: UpdateGroupMembersRequest,
  ): Promise<Conversation> {
    const { tenant, user } = await this.identity.getCurrentIdentity();
    this.authorization.requireCurrent({
      action: 'conversation.group.manage',
      resourceTenantId: tenant.id,
      taskContext: { taskId: conversationId },
      risk: 'MEDIUM',
    });
    const addedUsers = await Promise.all(
      request.addUserIds.map((userId) => this.identities.findUserById(tenant.id, userId)),
    );
    if (addedUsers.some((member) => member === null || member.status !== 'active')) {
      throw new NotFoundException('One or more group members are unavailable.');
    }
    const availableAgents = await this.listAvailableAgents();
    const addedAgents = request.addAgentIds.map((agentId) =>
      availableAgents.find((agent) => agent.id === agentId),
    );
    if (addedAgents.some((agent) => agent === undefined || !isExecutableAgent(agent))) {
      throw new NotFoundException('One or more group Agents are unavailable.');
    }
    try {
      const conversation = await this.conversations.updateGroupMembers({
        tenantId: tenant.id,
        conversationId,
        actorUserId: user.id,
        add: [
          ...addedUsers.map((member) => ({
            type: 'user' as const,
            id: member!.id,
            name: member!.name,
            role: 'member' as const,
          })),
          ...addedAgents.map((agent) => ({
            type: 'agent' as const,
            id: agent!.id,
            name: agent!.name,
            role: 'member' as const,
          })),
        ],
        remove: [
          ...request.removeUserIds.map((id) => ({ type: 'user' as const, id })),
          ...request.removeAgentIds.map((id) => ({ type: 'agent' as const, id })),
        ],
      });
      if (conversation === null) throw this.conversationNotFound();
      return conversation;
    } catch (error) {
      if (
        error instanceof Error &&
        /group owner|at least two active members/i.test(error.message)
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
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
        ...(request.responseTarget === undefined ? {} : { responseTarget: request.responseTarget }),
      });
      if (message === null) throw this.conversationNotFound();
      // createUserMessage commits the message, Agent Run and Outbox atomically.
      // Wake the co-located worker only after that commit is visible; periodic
      // polling still covers separately deployed workers and process failures.
      this.agentRuns?.notifyWorkAvailable();
      return message;
    } catch (error) {
      if (
        error instanceof MessageIdempotencyConflictError ||
        error instanceof AgentUnavailableForRunError ||
        error instanceof ConversationResponseTargetUnavailableError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  private conversationNotFound(): NotFoundException {
    return new NotFoundException('Conversation was not found.');
  }

  private async listAvailableAgents() {
    const [memberAgents, departmentAgents] = await Promise.all([
      this.agents.listMemberAgents(),
      this.agents.listDepartmentAgents(),
    ]);
    return [...memberAgents, ...departmentAgents];
  }
}

function memberChannelKey(requesterUserId: string, ownerUserId: string): string {
  return `member-assistant:${requesterUserId}:${ownerUserId}`;
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
