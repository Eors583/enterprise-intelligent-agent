import { describe, expect, it } from 'vitest';

import type { MemberAgent } from './agent.models.js';
import { canContactMemberAgent } from './agent-access.policy.js';

const principal = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  userId: '00000000-0000-7000-8000-000000000101',
};

function agent(overrides: Partial<MemberAgent> = {}): MemberAgent {
  return {
    id: '00000000-0000-7000-8000-000000000301',
    tenantId: principal.tenantId,
    ownerUserId: '00000000-0000-7000-8000-000000000102',
    name: '测试智能体',
    status: 'online',
    versionStatus: 'published',
    visibility: 'tenant',
    ...overrides,
  };
}

describe('canContactMemberAgent', () => {
  it('allows tenant-visible and owner-visible agents', () => {
    expect(canContactMemberAgent(principal, agent())).toBe(true);
    expect(
      canContactMemberAgent(
        principal,
        agent({ visibility: 'owner', ownerUserId: principal.userId }),
      ),
    ).toBe(true);
  });

  it('denies cross-tenant, disabled and private agents owned by another user', () => {
    expect(
      canContactMemberAgent(principal, agent({ tenantId: '00000000-0000-7000-8000-000000000009' })),
    ).toBe(false);
    expect(canContactMemberAgent(principal, agent({ status: 'disabled' }))).toBe(false);
    expect(canContactMemberAgent(principal, agent({ visibility: 'owner' }))).toBe(false);
  });
});
