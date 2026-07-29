import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../../database/prisma.service.js';
import { evaluateBusinessSemanticAuthorization } from '../../../authorization/domain/business-semantics.authorization.js';
import { semanticResource } from '../../../business-semantics/business-semantics-policy.service.js';
import { PrismaCollaborationCorrectionAuthorizationAdapter } from './prisma-collaboration-correction-authorization.adapter.js';

const TENANT_ID = '10000000-0000-7000-8000-000000000001';
const USER_ID = '10000000-0000-7000-8000-000000000101';
const TASK_ID = '10000000-0000-7000-8000-000000000612';
const ASSIGNMENT_ID = '10000000-0000-7000-8000-000000000501';
const task = {
  id: TASK_ID,
  tenantId: TENANT_ID,
  ownerUserId: null,
  ownerRoleAssignmentId: ASSIGNMENT_ID,
  ownerRoleTemplateId: null,
  ownerOrgUnitId: null,
  permissionLabels: ['classification:internal'],
};

describe('PrismaCollaborationCorrectionAuthorizationAdapter', () => {
  it('keeps employee Task execution fail-closed when the required mutation scope is absent', () => {
    const resource = semanticResource('TASK', task, { taskId: TASK_ID });
    const decision = evaluateBusinessSemanticAuthorization({
      principal: { tenantId: TENANT_ID, userId: USER_ID, tenantRole: 'OWNER' },
      action: 'business.task.execute',
      resourceTenantId: TENANT_ID,
      resource,
      employments: [],
      assignments: [],
    });

    expect(decision).toMatchObject({
      allowed: false,
      reasonCode: 'INVALID_INPUT',
    });
  });

  it('derives the execution mutation scope exclusively from the trusted stored Task', async () => {
    const transaction = {
      task: { findFirst: vi.fn().mockResolvedValue(task) },
      employment: { findMany: vi.fn().mockResolvedValue([]) },
      roleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      withTenant: vi.fn(
        (_tenantId: string, operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as unknown as PrismaService;
    const adapter = new PrismaCollaborationCorrectionAuthorizationAdapter(prisma);

    const scope = await adapter.requireTaskAccess({
      principal: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        tenantRole: 'OWNER',
        authenticationSource: 'development-header',
      },
      taskId: TASK_ID,
      action: 'collaboration.create',
    });

    expect(scope).toMatchObject({
      tenantId: TENANT_ID,
      userId: USER_ID,
      taskId: TASK_ID,
      managementBypass: true,
    });
    expect(transaction.task.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, id: TASK_ID },
    });
  });
});
