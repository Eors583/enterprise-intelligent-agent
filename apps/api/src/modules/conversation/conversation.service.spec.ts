import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

import type { AgentControlService } from '../agent-control/application/agent-control.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { IdentityService } from '../identity/application/identity.service.js';
import type { IdentityRepository } from '../identity/domain/identity.repository.js';
import type { ConversationRepository } from './domain/conversation.repository.js';
import { ConversationService, isExecutableAgent } from './conversation.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';

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
