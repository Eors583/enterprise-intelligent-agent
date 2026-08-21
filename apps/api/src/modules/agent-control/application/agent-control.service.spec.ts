import type { TenantContext } from '../../../common/context/tenant-context.js';
import { AuthorizationDecisionService } from '../../authorization/authorization-decision.service.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import type { MemberAgent } from '../domain/agent.models.js';
import type { AgentRepository } from '../domain/agent.repository.js';
import { AgentControlService } from './agent-control.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000101';

describe('AgentControlService authorization integration', () => {
  it('returns tenant-visible personal Agents and only actively assigned Role Agents', async () => {
    const repository = {
      listMemberAgents: vi.fn().mockResolvedValue([
        agent({ id: 'personal', requiresActiveAssignment: false, assignedToPrincipal: false }),
        agent({ id: 'assigned-role', requiresActiveAssignment: true, assignedToPrincipal: true }),
        agent({
          id: 'unassigned-role',
          requiresActiveAssignment: true,
          assignedToPrincipal: false,
        }),
      ]),
    };
    const context = {
      current: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: 'MEMBER',
        authenticationSource: 'session',
      },
    } as TenantContext;
    const authorization = new AuthorizationService(context, new AuthorizationDecisionService());
    const service = new AgentControlService(
      context,
      repository as unknown as AgentRepository,
      authorization,
    );

    await expect(service.listMemberAgents()).resolves.toMatchObject([
      { id: 'personal' },
      { id: 'assigned-role' },
    ]);
  });
});

function agent(overrides: Partial<MemberAgent>): MemberAgent {
  return {
    id: 'agent',
    tenantId: TENANT_ID,
    ownerUserId: '00000000-0000-7000-8000-000000000999',
    name: 'Role Agent',
    status: 'online',
    versionStatus: 'published',
    visibility: 'tenant',
    assignedToPrincipal: false,
    requiresActiveAssignment: false,
    ...overrides,
  };
}
