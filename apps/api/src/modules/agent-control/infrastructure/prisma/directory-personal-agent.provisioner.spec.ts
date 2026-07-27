import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  DirectoryPersonalAgentProvisioner,
  type DirectoryAgentProvisioningPlan,
} from './directory-personal-agent.provisioner.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const actorUserId = '00000000-0000-7000-8000-000000000101';
const userId = '00000000-0000-7000-8000-000000000102';

function plan(
  agentsByOwner = new Map<string, { id: string; key: string; ownerUserId: string | null }>(),
): DirectoryAgentProvisioningPlan {
  return {
    tenantId,
    actorUserId,
    versionId: '00000000-0000-7000-8000-000000000701',
    agentsByOwner,
  };
}

describe('DirectoryPersonalAgentProvisioner.reconcileMember', () => {
  it('preserves a custom member agent owned outside directory provisioning', async () => {
    const update = vi.fn();
    const create = vi.fn();
    const transaction = {
      agentInstance: { update, create },
    } as unknown as Prisma.TransactionClient;
    const agents = new Map([
      [
        userId,
        {
          id: '00000000-0000-7000-8000-000000000301',
          key: 'custom-agent',
          ownerUserId: userId,
        },
      ],
    ]);

    await new DirectoryPersonalAgentProvisioner().reconcileMember(transaction, plan(agents), {
      userId,
      displayName: '成员一',
      active: true,
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a managed agent for a new active directory member', async () => {
    const created = {
      id: '00000000-0000-7000-8000-000000000301',
      key: `feishu-personal-${userId}`,
      ownerUserId: userId,
    };
    const create = vi.fn().mockResolvedValue(created);
    const transaction = {
      agentInstance: { update: vi.fn(), create },
    } as unknown as Prisma.TransactionClient;
    const provisioningPlan = plan();

    await new DirectoryPersonalAgentProvisioner().reconcileMember(transaction, provisioningPlan, {
      userId,
      displayName: '成员一',
      active: true,
    });

    expect(create).toHaveBeenCalledOnce();
    expect(provisioningPlan.agentsByOwner.get(userId)).toEqual(created);
  });
});
