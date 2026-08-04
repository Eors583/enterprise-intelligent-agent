import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

import type { AgentControlService } from '../agent-control/application/agent-control.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { IdentityService } from '../identity/application/identity.service.js';
import type { IdentityRepository } from '../identity/domain/identity.repository.js';
import type { ConversationRepository } from './domain/conversation.repository.js';
import { ConversationService, isExecutableAgent } from './conversation.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const TARGET_USER_ID = '00000000-0000-7000-8000-000000000102';
const AGENT_ID = '00000000-0000-7000-8000-000000000201';

describe('ConversationService authorization integration', () => {
  it('requires a decision before loading conversations', async () => {
    const conversations = { listForUser: vi.fn() };
    const authorization = {
      requireCurrent: vi.fn(() => {
        throw new ForbiddenException('denied');
      }),
    };
    const service = new ConversationService(
      {
        getCurrentIdentity: vi.fn().mockResolvedValue({
          user: { id: USER_ID, tenantId: TENANT_ID },
        }),
      } as unknown as IdentityService,
      {} as IdentityRepository,
      {} as AgentControlService,
      conversations as unknown as ConversationRepository,
      authorization as unknown as AuthorizationService,
      { inspectAgents: vi.fn() } as never,
    );

    await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorization.requireCurrent).toHaveBeenCalledWith({
      action: 'conversation.list',
      resourceTenantId: TENANT_ID,
      risk: 'LOW',
    });
    expect(conversations.listForUser).not.toHaveBeenCalled();
  });
});

describe('ConversationService operational Agent boundary', () => {
  it('rejects conversation creation when configuration is online but model evidence is not ready', async () => {
    const conversations = { createDirect: vi.fn() };
    const service = new ConversationService(
      {
        getCurrentIdentity: vi.fn().mockResolvedValue({
          tenant: { id: TENANT_ID },
          user: { id: USER_ID, tenantId: TENANT_ID, name: 'Requester' },
        }),
      } as unknown as IdentityService,
      {} as IdentityRepository,
      {
        listMemberAgents: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-7000-8000-000000000201',
            status: 'online',
            versionStatus: 'published',
            assignedToPrincipal: false,
            requiresActiveAssignment: false,
            name: 'Operations Agent',
          },
        ]),
        listDepartmentAgents: vi.fn().mockResolvedValue([]),
      } as unknown as AgentControlService,
      conversations as unknown as ConversationRepository,
      { requireCurrent: vi.fn() } as unknown as AuthorizationService,
      {
        inspectAgents: vi.fn().mockResolvedValue(
          new Map([
            [
              '00000000-0000-7000-8000-000000000201',
              {
                status: 'UNKNOWN',
                evidenceStatus: 'INSUFFICIENT_EVIDENCE',
                reasonCodes: ['RUNTIME_READINESS_UNAVAILABLE'],
                checkedAt: null,
              },
            ],
          ]),
        ),
      } as never,
    );

    await expect(
      service.create({
        type: 'direct',
        target: {
          type: 'agent',
          agentId: '00000000-0000-7000-8000-000000000201',
        },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(conversations.createDirect).not.toHaveBeenCalled();
  });
});

describe('ConversationService shared member and Agent channel', () => {
  const identity = {
    getCurrentIdentity: vi.fn().mockResolvedValue({
      tenant: { id: TENANT_ID },
      user: { id: USER_ID, tenantId: TENANT_ID, name: '林晓' },
    }),
  } as unknown as IdentityService;
  const memberAgent = {
    id: AGENT_ID,
    tenantId: TENANT_ID,
    ownerUserId: TARGET_USER_ID,
    name: '周睿的研发助手',
    status: 'online' as const,
    versionStatus: 'published' as const,
    visibility: 'tenant' as const,
    assignedToPrincipal: false,
    requiresActiveAssignment: false,
  };

  it('opens a human target with the member and their Agent in one conversation', async () => {
    const conversations = {
      createDirect: vi.fn().mockResolvedValue({ id: 'conversation-id' }),
    };
    const service = new ConversationService(
      identity,
      {
        findUserById: vi.fn().mockResolvedValue({
          id: TARGET_USER_ID,
          name: '周睿',
          status: 'active',
        }),
      } as unknown as IdentityRepository,
      {
        listMemberAgents: vi.fn().mockResolvedValue([memberAgent]),
        listDepartmentAgents: vi.fn().mockResolvedValue([]),
      } as unknown as AgentControlService,
      conversations as unknown as ConversationRepository,
      { requireCurrent: vi.fn() } as unknown as AuthorizationService,
      { inspectAgents: vi.fn() } as never,
    );

    await service.create({ type: 'direct', target: { type: 'human', userId: TARGET_USER_ID } });

    expect(conversations.createDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        directKey: `member-assistant:${USER_ID}:${TARGET_USER_ID}`,
        preserveExistingParticipants: true,
        participants: [
          { type: 'user', id: USER_ID, name: '林晓' },
          { type: 'user', id: TARGET_USER_ID, name: '周睿' },
          { type: 'agent', id: AGENT_ID, name: '周睿的智能体' },
        ],
      }),
    );
  });

  it('uses the same channel key when entering through the member Agent', async () => {
    const conversations = {
      createDirect: vi.fn().mockResolvedValue({ id: 'conversation-id' }),
    };
    const service = new ConversationService(
      identity,
      {
        findUserById: vi.fn().mockResolvedValue({
          id: TARGET_USER_ID,
          name: '周睿',
          status: 'active',
        }),
      } as unknown as IdentityRepository,
      {
        listMemberAgents: vi.fn().mockResolvedValue([memberAgent]),
        listDepartmentAgents: vi.fn().mockResolvedValue([]),
      } as unknown as AgentControlService,
      conversations as unknown as ConversationRepository,
      { requireCurrent: vi.fn() } as unknown as AuthorizationService,
      {
        inspectAgents: vi.fn().mockResolvedValue(
          new Map([
            [
              AGENT_ID,
              {
                status: 'AVAILABLE',
                evidenceStatus: 'VERIFIED',
                reasonCodes: [],
                checkedAt: new Date().toISOString(),
              },
            ],
          ]),
        ),
      } as never,
    );

    await service.create({ type: 'direct', target: { type: 'agent', agentId: AGENT_ID } });

    expect(conversations.createDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        directKey: `member-assistant:${USER_ID}:${TARGET_USER_ID}`,
        participants: expect.arrayContaining([
          { type: 'user', id: TARGET_USER_ID, name: '周睿' },
          { type: 'agent', id: AGENT_ID, name: '周睿的智能体' },
        ]),
      }),
    );
  });
});

describe('isExecutableAgent', () => {
  it('keeps an immutable retired version executable only for its existing assignment', () => {
    expect(
      isExecutableAgent({
        status: 'online',
        versionStatus: 'retired',
        requiresActiveAssignment: true,
        assignedToPrincipal: true,
      }),
    ).toBe(true);
    expect(
      isExecutableAgent({
        status: 'online',
        versionStatus: 'retired',
        requiresActiveAssignment: true,
        assignedToPrincipal: false,
      }),
    ).toBe(false);
    expect(
      isExecutableAgent({
        status: 'online',
        versionStatus: 'retired',
        requiresActiveAssignment: false,
        assignedToPrincipal: true,
      }),
    ).toBe(false);
  });
});

describe('ConversationService Agent brainstorming group', () => {
  it('creates an Agent-only group and configures the selected pair for four relay turns', async () => {
    const secondAgentId = '00000000-0000-7000-8000-000000000202';
    const conversations = {
      createGroup: vi.fn().mockResolvedValue({ id: 'brainstorm-conversation' }),
    };
    const service = new ConversationService(
      {
        getCurrentIdentity: vi.fn().mockResolvedValue({
          tenant: { id: TENANT_ID },
          user: { id: USER_ID, tenantId: TENANT_ID, name: 'Requester' },
        }),
      } as unknown as IdentityService,
      { findUserById: vi.fn() } as unknown as IdentityRepository,
      {
        listMemberAgents: vi.fn().mockResolvedValue([
          {
            id: AGENT_ID,
            ownerUserId: TARGET_USER_ID,
            name: '员工智能体',
            status: 'online',
            versionStatus: 'published',
            assignedToPrincipal: false,
            requiresActiveAssignment: false,
          },
        ]),
        listDepartmentAgents: vi.fn().mockResolvedValue([
          {
            id: secondAgentId,
            orgUnitId: '00000000-0000-7000-8000-000000000401',
            name: '部门智能体',
            status: 'online',
            versionStatus: 'published',
            assignedToPrincipal: false,
            requiresActiveAssignment: false,
          },
        ]),
      } as unknown as AgentControlService,
      conversations as unknown as ConversationRepository,
      { requireCurrent: vi.fn() } as unknown as AuthorizationService,
      {
        inspectAgents: vi.fn().mockResolvedValue(
          new Map([
            [AGENT_ID, { status: 'AVAILABLE' }],
            [secondAgentId, { status: 'AVAILABLE' }],
          ]),
        ),
      } as never,
    );

    await service.create({
      type: 'group',
      title: '产品头脑风暴',
      memberUserIds: [],
      agentIds: [AGENT_ID, secondAgentId],
    });

    expect(conversations.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '产品头脑风暴',
        relay: { agentAId: AGENT_ID, agentBId: secondAgentId, turnLimit: 4 },
        participants: expect.arrayContaining([
          { type: 'agent', id: AGENT_ID, name: '员工智能体', role: 'member' },
          { type: 'agent', id: secondAgentId, name: '部门智能体', role: 'member' },
        ]),
      }),
    );
  });
});
