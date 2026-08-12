import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  knowledgeVersionResourcePolicyAllowed,
  knowledgeVersionResourcePolicySnapshotSql,
  knowledgeVersionResourcePolicySql,
  type KnowledgeResourceAuthorizationFilters,
} from './knowledge-resource-authorization.js';

const NOW = new Date('2026-07-28T12:00:00.000Z');

describe('knowledge version resource authorization', () => {
  it('allows pending initial content while failing closed for malformed, rejected and expired policies', () => {
    expect(knowledgeVersionResourcePolicyAllowed({}, unrestricted(), NOW)).toBe(false);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        policy({ reviewStatus: 'PENDING' }),
        unrestricted(),
        NOW,
      ),
    ).toBe(true);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        policy({ reviewStatus: 'REJECTED' }),
        unrestricted(),
        NOW,
      ),
    ).toBe(false);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        policy({ expiresAt: '2026-07-28T11:59:59.000Z' }),
        unrestricted(),
        NOW,
      ),
    ).toBe(false);
  });

  it('requires an explicit tenant-wide policy instead of inferring access from empty metadata', () => {
    expect(knowledgeVersionResourcePolicyAllowed(policy(), unrestricted(), NOW)).toBe(true);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        policy({
          scopeMode: 'TENANT',
          organizationScopeIds: ['00000000-0000-7000-8000-000000000101'],
        }),
        unrestricted(),
        NOW,
      ),
    ).toBe(false);
  });

  it('intersects every populated restricted dimension and enforces data labels', () => {
    const restrictedPolicy = policy({
      scopeMode: 'RESTRICTED',
      organizationScopeIds: ['00000000-0000-7000-8000-000000000101'],
      projectScopeIds: ['00000000-0000-7000-8000-000000000201'],
      taskScopeIds: ['00000000-0000-7000-8000-000000000301'],
      roleTemplateScopeIds: ['00000000-0000-7000-8000-000000000401'],
      dataLabels: ['role:finance'],
    });
    expect(
      knowledgeVersionResourcePolicyAllowed(
        restrictedPolicy,
        {
          ...unrestricted(),
          organizationIds: ['00000000-0000-7000-8000-000000000101'],
          projectIds: ['00000000-0000-7000-8000-000000000201'],
          taskIds: ['00000000-0000-7000-8000-000000000301'],
          roleTemplateIds: ['00000000-0000-7000-8000-000000000401'],
          principalDataLabels: ['role:finance'],
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        restrictedPolicy,
        {
          ...unrestricted(),
          organizationIds: ['00000000-0000-7000-8000-000000000101'],
          projectIds: ['00000000-0000-7000-8000-000000000201'],
          taskIds: ['00000000-0000-7000-8000-000000000301'],
          roleTemplateIds: ['00000000-0000-7000-8000-000000000401'],
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('requires explicit classification clearance for sensitive and confidential knowledge', () => {
    const sensitive = policy({
      classification: 'SENSITIVE',
      scopeMode: 'RESTRICTED',
      dataLabels: ['finance'],
    });
    expect(
      knowledgeVersionResourcePolicyAllowed(
        sensitive,
        { ...unrestricted(), principalDataLabels: ['finance'] },
        NOW,
      ),
    ).toBe(false);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        sensitive,
        {
          ...unrestricted(),
          principalDataLabels: ['finance', 'CLASSIFICATION:SENSITIVE'],
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('allows any explicitly selected member without requiring every selected member identity', () => {
    const memberRestricted = policy({
      scopeMode: 'RESTRICTED',
      dataLabels: [
        'USER:00000000-0000-7000-8000-000000000501',
        'USER:00000000-0000-7000-8000-000000000502',
      ],
    });
    expect(
      knowledgeVersionResourcePolicyAllowed(
        memberRestricted,
        {
          ...unrestricted(),
          principalDataLabels: ['USER:00000000-0000-7000-8000-000000000502'],
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        memberRestricted,
        {
          ...unrestricted(),
          principalDataLabels: ['USER:00000000-0000-7000-8000-000000000503'],
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('treats selected departments and selected members as alternative people scopes', () => {
    const departmentOrMember = policy({
      scopeMode: 'RESTRICTED',
      organizationScopeIds: ['00000000-0000-7000-8000-000000000510'],
      dataLabels: ['USER:00000000-0000-7000-8000-000000000511'],
    });
    expect(
      knowledgeVersionResourcePolicyAllowed(
        departmentOrMember,
        {
          ...unrestricted(),
          organizationIds: ['00000000-0000-7000-8000-000000000510'],
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      knowledgeVersionResourcePolicyAllowed(
        departmentOrMember,
        {
          ...unrestricted(),
          principalDataLabels: ['USER:00000000-0000-7000-8000-000000000511'],
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('builds pre-retrieval SQL from version governance columns, not chunk metadata', () => {
    const predicate = knowledgeVersionResourcePolicySql(Prisma.sql`version`, unrestricted()).sql;
    const snapshot = knowledgeVersionResourcePolicySnapshotSql(Prisma.sql`version`).sql;
    expect(predicate).toContain('governance_review_status');
    expect(predicate).toContain('effective_from');
    expect(predicate).toContain('scope_mode');
    expect(predicate).toContain('USER:%');
    expect(predicate).not.toContain('metadata');
    expect(snapshot).toContain('governance_hash');
  });
});

function unrestricted(): KnowledgeResourceAuthorizationFilters {
  return {
    assignmentOrganizationScoped: false,
    organizationIds: [],
    includeOrganizationDescendants: false,
    projectIds: [],
    taskIds: [],
    roleTemplateIds: [],
    principalDataLabels: [],
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: '00000000-0000-7000-8000-000000000001',
    classification: 'INTERNAL',
    scopeMode: 'TENANT',
    organizationScopeIds: [],
    projectScopeIds: [],
    taskScopeIds: [],
    roleTemplateScopeIds: [],
    dataLabels: [],
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: null,
    retentionUntil: null,
    retentionAction: 'ARCHIVE',
    supersedesVersionId: null,
    reviewStatus: 'APPROVED',
    policyHash: 'a'.repeat(64),
    ...overrides,
  };
}
