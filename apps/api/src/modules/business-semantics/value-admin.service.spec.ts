import { ForbiddenException } from '@nestjs/common';
import type { CreateValueDefinitionRequest } from '@enterprise/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { AdminAccessService } from '../admin/admin-access.service.js';
import type { BusinessSemanticsPolicyService } from './business-semantics-policy.service.js';
import { ValueAdminService } from './value-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000002';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000003';

describe('ValueAdminService authorization boundary', () => {
  it('checks the trusted mutation policy before replay lookup or business writes', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      valueDefinition: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      auditEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const prisma = {
      withTenant: vi.fn(
        async (tenantId: string, operation: (client: typeof transaction) => Promise<unknown>) => {
          expect(tenantId).toBe(TENANT_ID);
          return operation(transaction);
        },
      ),
    };
    const access = {
      requireDirectoryWrite: vi.fn().mockReturnValue({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        role: 'ADMIN',
      }),
    };
    const policy = {
      requireWrite: vi
        .fn()
        .mockRejectedValue(new ForbiddenException({ reasonCode: 'SELF_ELEVATION_DENIED' })),
    };
    const service = new ValueAdminService(
      prisma as unknown as AdminPrismaService,
      access as unknown as AdminAccessService,
      policy as unknown as BusinessSemanticsPolicyService,
    );
    const request = {
      code: 'VALUE.CUSTOMER_TRUST',
      type: 'CUSTOMER',
      name: 'Customer trust',
      description: 'Trust earned through reliable delivery.',
      owner: { type: 'ROLE_ASSIGNMENT', id: ASSIGNMENT_ID },
      permissionLabels: ['internal.strategy'],
      effectiveFrom: '2026-07-28T00:00:00.000Z',
      effectiveTo: null,
    } satisfies CreateValueDefinitionRequest;

    await expect(service.createValue(request, 'request-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(policy.requireWrite).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ tenantId: TENANT_ID, userId: ADMIN_ID }),
      'business.value.create',
      {
        mutation: {
          proposedOwner: request.owner,
          proposedPermissionLabels: request.permissionLabels,
        },
      },
    );
    expect(transaction.valueDefinition.findFirst).not.toHaveBeenCalled();
    expect(transaction.valueDefinition.create).not.toHaveBeenCalled();
    expect(transaction.auditEvent.create).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });
});
