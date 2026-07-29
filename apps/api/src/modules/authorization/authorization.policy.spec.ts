import { evaluateAuthorization } from './authorization.policy.js';
import type { AuthorizationInput } from './authorization.types.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000101';
const AGENT_ID = '00000000-0000-7000-8000-000000000201';
const NOW = new Date('2026-07-28T08:00:00.000Z');

describe('evaluateAuthorization', () => {
  it('denies a resource in another tenant and emits an auditable decision id', () => {
    const decision = evaluateAuthorization(
      baseInput({
        resourceTenantId: OTHER_TENANT_ID,
      }),
      { now: NOW, decisionId: 'authz_cross_tenant' },
    );

    expect(decision).toMatchObject({
      decisionId: 'authz_cross_tenant',
      effect: 'deny',
      allowed: false,
      reasonCode: 'CROSS_TENANT',
      evaluatedAt: NOW.toISOString(),
    });
    expect(decision.obligations).toContainEqual({
      type: 'RECORD_AUDIT_DECISION',
      parameters: { decisionId: 'authz_cross_tenant' },
    });
  });

  it.each([
    {
      label: 'has no assignment',
      assignment: null,
      reasonCode: 'ASSIGNMENT_REQUIRED',
    },
    {
      label: 'has a non-active assignment',
      assignment: activeAssignment({ status: 'SUSPENDED' }),
      reasonCode: 'ASSIGNMENT_NOT_ACTIVE',
    },
    {
      label: 'has an expired assignment window',
      assignment: activeAssignment({ effectiveTo: '2026-07-28T07:59:59.000Z' }),
      reasonCode: 'ASSIGNMENT_EXPIRED',
    },
  ])('denies Agent use when the employee $label', ({ assignment, reasonCode }) => {
    const decision = evaluateAuthorization(
      baseInput({
        action: 'agent.use',
        assignment,
        taskContext: {
          assignmentRequired: true,
          resourceAgentId: AGENT_ID,
        },
      }),
      { now: NOW },
    );

    expect(decision).toMatchObject({ effect: 'deny', reasonCode });
  });

  it('allows a descendant organization in scope and denies an unrelated organization', () => {
    const inScope = evaluateAuthorization(
      baseInput({
        action: 'agent.use',
        assignment: activeAssignment({
          organizationScope: {
            organizationIds: ['org-sales'],
            includeDescendants: true,
          },
        }),
        organization: {
          resourceOrganizationId: 'org-sales-east',
          resourceAncestorOrganizationIds: ['org-sales'],
        },
        taskContext: {
          assignmentRequired: true,
          resourceAgentId: AGENT_ID,
        },
      }),
      { now: NOW },
    );
    const outOfScope = evaluateAuthorization(
      baseInput({
        action: 'agent.use',
        assignment: activeAssignment({
          organizationScope: {
            organizationIds: ['org-sales'],
            includeDescendants: true,
          },
        }),
        organization: {
          resourceOrganizationId: 'org-finance',
          resourceAncestorOrganizationIds: ['org-corporate'],
        },
        taskContext: {
          assignmentRequired: true,
          resourceAgentId: AGENT_ID,
        },
      }),
      { now: NOW },
    );

    expect(inScope).toMatchObject({ effect: 'allow', reasonCode: 'ALLOW_ASSIGNED_AGENT' });
    expect(outOfScope).toMatchObject({
      effect: 'deny',
      reasonCode: 'ORGANIZATION_SCOPE_DENIED',
    });
  });

  it('requires a separate approval for a high-risk action', () => {
    const decision = evaluateAuthorization(
      baseInput({
        action: 'tenant.manage',
        tenantRole: 'OWNER',
        risk: 'HIGH',
      }),
      { now: NOW },
    );

    expect(decision).toMatchObject({
      effect: 'deny',
      reasonCode: 'HIGH_RISK_APPROVAL_REQUIRED',
    });
    expect(decision.obligations).toContainEqual({ type: 'REQUIRE_RISK_APPROVAL' });
  });

  it('keeps management authority separate from employee Agent assignment', () => {
    const memberManagement = evaluateAuthorization(
      baseInput({ action: 'tenant.manage', tenantRole: 'MEMBER' }),
      { now: NOW },
    );
    const ownerWithoutAssignment = evaluateAuthorization(
      baseInput({
        action: 'agent.use',
        tenantRole: 'OWNER',
        assignment: null,
        taskContext: {
          assignmentRequired: true,
          resourceAgentId: AGENT_ID,
        },
      }),
      { now: NOW },
    );

    expect(memberManagement.reasonCode).toBe('MANAGEMENT_ROLE_REQUIRED');
    expect(ownerWithoutAssignment.reasonCode).toBe('ASSIGNMENT_REQUIRED');
  });

  it('denies an unregistered action by default', () => {
    const decision = evaluateAuthorization(baseInput({ action: 'future.unreviewed.action' }), {
      now: NOW,
    });

    expect(decision).toMatchObject({
      effect: 'deny',
      allowed: false,
      reasonCode: 'ACTION_NOT_REGISTERED',
    });
  });

  it('returns concrete knowledge filters from the active role assignment', () => {
    const decision = evaluateAuthorization(
      baseInput({
        action: 'knowledge.retrieve',
        assignment: activeAssignment({
          organizationScope: {
            organizationIds: ['org-hr'],
            includeDescendants: true,
          },
          projectIds: ['project-people'],
          taskIds: ['task-onboarding'],
          dataLabels: ['role:hr', 'classification:internal'],
          permissionActions: ['knowledge.retrieve'],
        }),
        taskContext: { taskId: 'task-onboarding' },
      }),
      { now: NOW },
    );

    expect(decision).toMatchObject({ effect: 'allow', reasonCode: 'ALLOW_WITH_RESOURCE_FILTERS' });
    expect(decision.obligations).toEqual(
      expect.arrayContaining([
        {
          type: 'FILTER_ORGANIZATION_SCOPE',
          parameters: {
            organizationIds: ['org-hr'],
            includeDescendants: true,
            assignmentScoped: true,
          },
        },
        { type: 'FILTER_PROJECT_SCOPE', parameters: { projectIds: ['project-people'] } },
        { type: 'FILTER_TASK_SCOPE', parameters: { taskIds: ['task-onboarding'] } },
        {
          type: 'ENFORCE_DATA_LABEL_SCOPE',
          parameters: { principalLabels: ['role:hr', 'classification:internal'] },
        },
        { type: 'REVALIDATE_ASSIGNMENT' },
        { type: 'REVALIDATE_KNOWLEDGE_ACCESS' },
      ]),
    );
  });
});

function baseInput(overrides: Partial<AuthorizationInput> = {}): AuthorizationInput {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    tenantRole: 'MEMBER',
    action: 'tenant.read',
    resourceTenantId: TENANT_ID,
    risk: 'LOW',
    ...overrides,
  };
}

function activeAssignment(
  overrides: Partial<NonNullable<AuthorizationInput['assignment']>> = {},
): NonNullable<AuthorizationInput['assignment']> {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    agentInstanceId: AGENT_ID,
    status: 'ACTIVE',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: '2026-08-01T00:00:00.000Z',
    employmentActive: true,
    ...overrides,
  };
}
