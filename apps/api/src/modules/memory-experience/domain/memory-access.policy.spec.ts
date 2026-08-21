import type { MemoryRecord } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  decideMemoryAccess,
  type TrustedMemoryAccessContext,
  type TrustedMemoryGrant,
} from './memory-access.policy.js';

const NOW = new Date('2026-07-28T06:00:00.000Z');
const TENANT = '00000000-0000-7000-8000-000000000001';
const USER = '00000000-0000-7000-8000-000000000002';
const ASSIGNMENT = '00000000-0000-7000-8000-000000000003';
const ROLE = '00000000-0000-7000-8000-000000000004';
const ROLE_VERSION = '00000000-0000-7000-8000-000000000005';

describe('memory access policy', () => {
  it('allows role memory through one exact active assignment grant', () => {
    const decision = decideMemoryAccess(context([roleGrant(['policy', 'delivery'])]), {
      ...resource('ROLE'),
      roleTemplateId: ROLE,
      roleVersionId: ROLE_VERSION,
      permissionLabels: ['policy', 'delivery'],
    });
    expect(decision).toEqual({ allowed: true, grantId: 'role-grant' });
  });

  it('never unions labels from separate grants', () => {
    const decision = decideMemoryAccess(
      context([roleGrant(['policy'], 'grant-a'), roleGrant(['delivery'], 'grant-b')]),
      {
        ...resource('ROLE'),
        roleTemplateId: ROLE,
        roleVersionId: ROLE_VERSION,
        permissionLabels: ['policy', 'delivery'],
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'LABEL_SCOPE_MISMATCH' });
  });

  it('revokes role and private memory immediately with the assignment', () => {
    const revoked = roleGrant(['private']);
    const decision = decideMemoryAccess(
      {
        ...context([
          {
            ...revoked,
            scope: 'EMPLOYEE_PRIVATE',
            assignment: { ...revoked.assignment!, status: 'REVOKED' },
          },
        ]),
        purpose: 'Personal assistance in this assignment',
      },
      {
        ...resource('EMPLOYEE_PRIVATE'),
        ownerUserId: USER,
        roleTemplateId: ROLE,
        roleVersionId: ROLE_VERSION,
        roleAssignmentId: ASSIGNMENT,
        permissionLabels: ['private'],
        consent: {
          required: true,
          grantedByUserId: USER,
          grantedAt: NOW.toISOString(),
          purpose: 'Personal assistance in this assignment',
        },
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'NO_EXACT_SCOPE_GRANT' });
  });

  it('requires an exact purpose for employee-private memory', () => {
    const grant = roleGrant(['private']);
    const decision = decideMemoryAccess(
      {
        ...context([{ ...grant, scope: 'EMPLOYEE_PRIVATE' }]),
        purpose: 'Performance evaluation',
      },
      {
        ...resource('EMPLOYEE_PRIVATE'),
        ownerUserId: USER,
        roleTemplateId: ROLE,
        roleVersionId: ROLE_VERSION,
        roleAssignmentId: ASSIGNMENT,
        permissionLabels: ['private'],
        consent: {
          required: true,
          grantedByUserId: USER,
          grantedAt: NOW.toISOString(),
          purpose: 'Personal assistance in this assignment',
        },
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'CONSENT_PURPOSE_MISMATCH' });
  });

  it('keeps employee-private memory hidden from governance grants', () => {
    const decision = decideMemoryAccess(
      { ...context([governanceGrant()]), operation: 'GOVERN' },
      {
        ...resource('EMPLOYEE_PRIVATE'),
        ownerUserId: USER,
        roleTemplateId: ROLE,
        roleVersionId: ROLE_VERSION,
        roleAssignmentId: ASSIGNMENT,
        consent: {
          required: true,
          grantedByUserId: USER,
          grantedAt: NOW.toISOString(),
          purpose: 'Personal assistance in this assignment',
        },
      },
    );
    expect(decision.allowed).toBe(false);
  });

  it('requires exact task and conversation memberships and honors TTL', () => {
    const taskId = '00000000-0000-7000-8000-000000000010';
    const conversationId = '00000000-0000-7000-8000-000000000011';
    const taskGrant: TrustedMemoryGrant = {
      ...enterpriseGrant(),
      id: 'task-grant',
      scope: 'TASK',
      taskId,
    };
    const conversationGrant: TrustedMemoryGrant = {
      ...enterpriseGrant(),
      id: 'conversation-grant',
      scope: 'CONVERSATION',
      conversationId,
    };
    expect(
      decideMemoryAccess(context([taskGrant]), {
        ...resource('TASK'),
        taskId,
      }).allowed,
    ).toBe(true);
    expect(
      decideMemoryAccess(context([conversationGrant]), {
        ...resource('CONVERSATION'),
        conversationId,
        expiresAt: '2026-07-28T05:59:59.000Z',
      }),
    ).toEqual({ allowed: false, reason: 'OUTSIDE_EFFECTIVE_WINDOW' });
  });
});

function context(grants: readonly TrustedMemoryGrant[]): TrustedMemoryAccessContext {
  return {
    tenantId: TENANT,
    userId: USER,
    operation: 'READ',
    purpose: null,
    grants,
    now: NOW,
  };
}

function enterpriseGrant(): TrustedMemoryGrant {
  return {
    id: 'enterprise-grant',
    tenantId: TENANT,
    userId: USER,
    scope: 'ENTERPRISE',
    roleAssignmentId: null,
    roleTemplateId: null,
    roleVersionId: null,
    taskId: null,
    conversationId: null,
    permissionLabels: [],
    assignment: null,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  };
}

function governanceGrant(): TrustedMemoryGrant {
  return {
    ...enterpriseGrant(),
    id: 'governance-grant',
    scope: 'GOVERNANCE',
  };
}

function roleGrant(labels: readonly string[], id = 'role-grant'): TrustedMemoryGrant {
  return {
    id,
    tenantId: TENANT,
    userId: USER,
    scope: 'ROLE',
    roleAssignmentId: ASSIGNMENT,
    roleTemplateId: ROLE,
    roleVersionId: ROLE_VERSION,
    taskId: null,
    conversationId: null,
    permissionLabels: labels,
    assignment: {
      id: ASSIGNMENT,
      tenantId: TENANT,
      userId: USER,
      roleTemplateId: ROLE,
      roleVersionId: ROLE_VERSION,
      status: 'ACTIVE',
      employmentStatus: 'ACTIVE',
      orgUnitStatus: 'ACTIVE',
      roleVersionStatus: 'PUBLISHED',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  };
}

function resource(scope: MemoryRecord['scope']) {
  return {
    tenantId: TENANT,
    scope,
    status: 'ACTIVE' as const,
    ownerUserId: null,
    roleTemplateId: null,
    roleVersionId: null,
    roleAssignmentId: null,
    taskId: null,
    conversationId: null,
    permissionLabels: [] as string[],
    consent: {
      required: false,
      grantedByUserId: null,
      grantedAt: null,
      purpose: null,
    },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    expiresAt: null,
  };
}
