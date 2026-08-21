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
  versionPublished = false,
): DirectoryAgentProvisioningPlan {
  return {
    tenantId,
    actorUserId,
    versionId: '00000000-0000-7000-8000-000000000701',
    versionPublished,
    agentsByOwner,
  };
}

describe('DirectoryPersonalAgentProvisioner.reconcileMember', () => {
  it('creates an unpublished fallback version when no governed version exists', async () => {
    const createVersion = vi.fn().mockResolvedValue({
      id: '00000000-0000-7000-8000-000000000701',
    });
    const transaction = {
      agentTemplate: {
        upsert: vi.fn().mockResolvedValue({ id: '00000000-0000-7000-8000-000000000601' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      agentVersion: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ version: 2 }),
        create: createVersion,
      },
      agentInstance: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Prisma.TransactionClient;

    const prepared = await new DirectoryPersonalAgentProvisioner().prepare(transaction, {
      tenantId,
      actorUserId,
    });

    expect(prepared.versionPublished).toBe(false);
    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          reviewStatus: 'NOT_SUBMITTED',
          createdById: actorUserId,
        }),
      }),
    );
    expect(createVersion.mock.calls[0]?.[0]?.data).not.toHaveProperty('publishedAt');
  });

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
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'OFFLINE' }),
      }),
    );
    expect(provisioningPlan.agentsByOwner.get(userId)).toEqual(created);
  });

  it('only brings a managed member agent online after its governed version is published', async () => {
    const update = vi.fn();
    const transaction = {
      agentInstance: { update, create: vi.fn() },
    } as unknown as Prisma.TransactionClient;
    const agents = new Map([
      [
        userId,
        {
          id: '00000000-0000-7000-8000-000000000301',
          key: `feishu-personal-${userId}`,
          ownerUserId: userId,
        },
      ],
    ]);

    await new DirectoryPersonalAgentProvisioner().reconcileMember(transaction, plan(agents, true), {
      userId,
      displayName: '鎴愬憳涓€',
      active: true,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          versionId: '00000000-0000-7000-8000-000000000701',
          status: 'ONLINE',
        }),
      }),
    );
  });
});
