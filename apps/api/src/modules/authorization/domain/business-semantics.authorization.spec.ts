import { describe, expect, it } from 'vitest';

import {
  BUSINESS_SEMANTIC_READ_ACTIONS,
  BUSINESS_SEMANTIC_RESOURCE_TYPES,
  BUSINESS_SEMANTIC_WRITE_ACTIONS,
  businessSemanticFiltersFromDecision,
  evaluateBusinessSemanticAuthorization,
  evaluateBusinessSemanticTraceAuthorization,
  filterBusinessSemanticResources,
  filterCompleteBusinessSemanticTrace,
  type BusinessSemanticAuthorizationDecision,
  type BusinessSemanticAuthorizationInput,
  type BusinessSemanticEmployment,
  type BusinessSemanticResource,
  type BusinessSemanticResourceType,
  type BusinessSemanticRoleAssignment,
} from './business-semantics.authorization.js';

const NOW = new Date('2026-07-28T08:00:00.000Z');
const TENANT_ID = 'tenant-alpha';
const OTHER_TENANT_ID = 'tenant-beta';
const USER_ID = 'user-employee';
const EMPLOYMENT_ID = 'employment-active';
const ASSIGNMENT_ID = 'assignment-sales';
const ROLE_BLUEPRINT_ID = 'role-blueprint-sales';
const ORGANIZATION_ID = 'org-sales-east';
const ORGANIZATION_ANCESTOR_ID = 'org-sales';
const PROJECT_ID = 'project-alpha';
const TASK_ID = 'task-alpha';
const PERMISSION_LABEL = 'internal.strategy';

const FAMILY_CASES = [
  ['business.value.read', 'VALUE'],
  ['business.strategy.read', 'STRATEGY'],
  ['business.objective.read', 'OBJECTIVE'],
  ['business.metric.read', 'METRIC'],
  ['business.process.read', 'PROCESS'],
  ['business.task.read', 'TASK'],
  ['business.deliverable.read', 'DELIVERABLE'],
  ['business.acceptance.read', 'ACCEPTANCE'],
  ['business.evidence.read', 'EVIDENCE'],
] as const;

const activeEmployment: BusinessSemanticEmployment = {
  id: EMPLOYMENT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: 'ACTIVE',
  orgUnitStatus: 'ACTIVE',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: '2027-01-01T00:00:00.000Z',
  organizationIds: [ORGANIZATION_ANCESTOR_ID],
  orgUnitIds: [ORGANIZATION_ANCESTOR_ID],
};

const activeAssignment: BusinessSemanticRoleAssignment = {
  id: ASSIGNMENT_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
  employmentId: EMPLOYMENT_ID,
  roleBlueprintId: ROLE_BLUEPRINT_ID,
  roleVersionStatus: 'PUBLISHED',
  status: 'ACTIVE',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: '2027-01-01T00:00:00.000Z',
  organizationScope: {
    organizationIds: [ORGANIZATION_ANCESTOR_ID],
    includeDescendants: true,
  },
  projectIds: [PROJECT_ID],
  taskIds: [TASK_ID],
  permissionLabels: [PERMISSION_LABEL],
  permissionActions: ['business.*'],
};

function resource(
  type: BusinessSemanticResourceType = 'OBJECTIVE',
  overrides: Partial<BusinessSemanticResource> = {},
): BusinessSemanticResource {
  return {
    id: type === 'TASK' ? TASK_ID : `${type.toLowerCase()}-alpha`,
    tenantId: TENANT_ID,
    type,
    owner: { type: 'ROLE_ASSIGNMENT', id: ASSIGNMENT_ID },
    responsibleRoleAssignmentIds: [ASSIGNMENT_ID],
    organizationId: ORGANIZATION_ID,
    organizationAncestorIds: [ORGANIZATION_ANCESTOR_ID],
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    permissionLabels: [PERMISSION_LABEL],
    ...overrides,
  };
}

function input(
  overrides: Partial<BusinessSemanticAuthorizationInput> = {},
): BusinessSemanticAuthorizationInput {
  return {
    principal: {
      tenantId: TENANT_ID,
      userId: USER_ID,
      tenantRole: 'MEMBER',
    },
    action: 'business.objective.read',
    resourceTenantId: TENANT_ID,
    resource: resource(),
    employments: [activeEmployment],
    assignments: [activeAssignment],
    ...overrides,
  };
}

function evaluate(overrides: Partial<BusinessSemanticAuthorizationInput> = {}) {
  return evaluateBusinessSemanticAuthorization(input(overrides), {
    now: NOW,
    decisionId: 'decision-test',
  });
}

function resourceForWriteAction(
  action: (typeof BUSINESS_SEMANTIC_WRITE_ACTIONS)[number],
): BusinessSemanticResource | null {
  if (action.endsWith('.create')) return null;
  return resource(action.split('.')[1]!.toUpperCase() as BusinessSemanticResourceType);
}

describe('business semantic action surface', () => {
  it('registers every P0-2 resource family and no trace mutation action', () => {
    expect(BUSINESS_SEMANTIC_RESOURCE_TYPES).toEqual([
      'VALUE',
      'STRATEGY',
      'OBJECTIVE',
      'METRIC',
      'PROCESS',
      'TASK',
      'DELIVERABLE',
      'ACCEPTANCE',
      'EVIDENCE',
      'TRACE',
    ]);
    expect(BUSINESS_SEMANTIC_READ_ACTIONS).toHaveLength(10);
    expect(BUSINESS_SEMANTIC_WRITE_ACTIONS).toHaveLength(27);
    expect(
      BUSINESS_SEMANTIC_WRITE_ACTIONS.some((action) => action.startsWith('business.trace.')),
    ).toBe(false);
  });

  it.each(FAMILY_CASES)('authorizes an employee relation for %s', (action, type) => {
    expect(evaluate({ action, resource: resource(type) })).toMatchObject({
      effect: 'allow',
      reasonCode: 'ALLOW_RESOURCE_RELATION',
    });
  });

  it('defaults unknown actions and mismatched resource families to deny', () => {
    expect(evaluate({ action: 'business.objective.export' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'ACTION_NOT_REGISTERED',
    });
    expect(
      evaluate({
        action: 'business.strategy.read',
        resource: resource('OBJECTIVE'),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'RESOURCE_TYPE_MISMATCH',
    });
  });
});

describe('business semantic management writes', () => {
  it.each(['MEMBER', 'KNOWLEDGE_ADMIN'] as const)(
    'denies every write action to %s',
    (tenantRole) => {
      for (const action of BUSINESS_SEMANTIC_WRITE_ACTIONS) {
        expect(
          evaluate({
            principal: { tenantId: TENANT_ID, userId: USER_ID, tenantRole },
            action,
            resource: resourceForWriteAction(action),
            mutation: {
              proposedOwner: { type: 'USER', id: 'user-target' },
            },
          }),
        ).toMatchObject({
          effect: 'deny',
          reasonCode: 'MANAGEMENT_ROLE_REQUIRED',
        });
      }
    },
  );

  it.each(['OWNER', 'ADMIN'] as const)(
    'allows every write action to %s when the mutation is not self-elevating',
    (tenantRole) => {
      for (const action of BUSINESS_SEMANTIC_WRITE_ACTIONS) {
        expect(
          evaluate({
            principal: { tenantId: TENANT_ID, userId: USER_ID, tenantRole },
            action,
            resource: resourceForWriteAction(action),
            mutation: {
              proposedTenantId: TENANT_ID,
              proposedOwner: { type: 'USER', id: 'user-target' },
            },
          }),
        ).toMatchObject({
          effect: 'allow',
          reasonCode: 'ALLOW_MANAGEMENT_WRITE',
        });
      }
    },
  );

  it('blocks an administrator from assigning ownership or responsibility to itself', () => {
    const adminPrincipal = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      tenantRole: 'ADMIN' as const,
    };
    const selfOwner = evaluate({
      principal: adminPrincipal,
      action: 'business.strategy.create',
      resource: null,
      mutation: {
        proposedOwner: { type: 'ROLE_ASSIGNMENT', id: ASSIGNMENT_ID },
      },
    });
    const selfResponsible = evaluate({
      principal: adminPrincipal,
      action: 'business.objective.update',
      resource: resource(),
      mutation: {
        proposedResponsibleRoleAssignmentIds: [ASSIGNMENT_ID],
      },
    });

    expect(selfOwner).toMatchObject({
      effect: 'deny',
      reasonCode: 'SELF_ELEVATION_DENIED',
    });
    expect(selfResponsible).toMatchObject({
      effect: 'deny',
      reasonCode: 'SELF_ELEVATION_DENIED',
    });
    expect(selfOwner.obligations).toContainEqual({
      type: 'PREVENT_SELF_ELEVATION',
    });
  });

  it('permits the tenant OWNER to perform the same ownership mutation', () => {
    expect(
      evaluate({
        principal: {
          tenantId: TENANT_ID,
          userId: USER_ID,
          tenantRole: 'OWNER',
        },
        action: 'business.strategy.create',
        resource: null,
        mutation: {
          proposedOwner: { type: 'ROLE_ASSIGNMENT', id: ASSIGNMENT_ID },
        },
      }),
    ).toMatchObject({
      effect: 'allow',
      reasonCode: 'ALLOW_MANAGEMENT_WRITE',
    });
  });

  it('fails closed when a create has no owner or an update omits trusted mutation context', () => {
    expect(
      evaluate({
        principal: {
          tenantId: TENANT_ID,
          userId: 'owner-user',
          tenantRole: 'OWNER',
        },
        action: 'business.strategy.create',
        resource: null,
        mutation: { proposedOwner: null },
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'INVALID_INPUT',
    });
    expect(
      evaluate({
        principal: {
          tenantId: TENANT_ID,
          userId: 'owner-user',
          tenantRole: 'OWNER',
        },
        action: 'business.strategy.update',
        resource: null,
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'INVALID_INPUT',
    });
    expect(
      evaluate({
        principal: {
          tenantId: TENANT_ID,
          userId: 'owner-user',
          tenantRole: 'OWNER',
        },
        action: 'business.strategy.update',
        resource: resource('STRATEGY'),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'INVALID_INPUT',
    });
  });
});

describe('employee identity, relation, and scope enforcement', () => {
  it('denies a resource from another tenant before evaluating relationships', () => {
    expect(
      evaluate({
        resourceTenantId: OTHER_TENANT_ID,
        resource: resource('OBJECTIVE', {
          tenantId: OTHER_TENANT_ID,
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'CROSS_TENANT',
    });
  });

  it('denies an expired assignment', () => {
    expect(
      evaluate({
        assignments: [
          {
            ...activeAssignment,
            effectiveTo: '2026-07-28T07:59:59.999Z',
          },
        ],
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'ASSIGNMENT_EXPIRED',
    });
  });

  it('denies an assignment linked to inactive employment', () => {
    expect(
      evaluate({
        employments: [{ ...activeEmployment, status: 'TERMINATED' }],
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'EMPLOYMENT_NOT_ACTIVE',
    });
  });

  it('denies employment in an archived OrgUnit', () => {
    expect(
      evaluate({
        employments: [{ ...activeEmployment, orgUnitStatus: 'ARCHIVED' }],
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'ORG_UNIT_NOT_ACTIVE',
    });
  });

  it.each(['DRAFT', 'TESTING'] as const)(
    'denies an assignment backed by a %s role version',
    (roleVersionStatus) => {
      expect(
        evaluate({
          assignments: [{ ...activeAssignment, roleVersionStatus }],
        }),
      ).toMatchObject({
        effect: 'deny',
        reasonCode: 'ROLE_VERSION_NOT_USABLE',
      });
    },
  );

  it('keeps an existing effective assignment usable after its immutable role version retires', () => {
    expect(
      evaluate({
        assignments: [{ ...activeAssignment, roleVersionStatus: 'RETIRED' }],
      }),
    ).toMatchObject({
      effect: 'allow',
      reasonCode: 'ALLOW_RESOURCE_RELATION',
    });
  });

  it('does not let a retired version replace the assignment or resource relation', () => {
    expect(evaluate({ assignments: [] })).toMatchObject({
      effect: 'deny',
      reasonCode: 'ASSIGNMENT_REQUIRED',
    });
    expect(
      evaluate({
        assignments: [{ ...activeAssignment, roleVersionStatus: 'RETIRED' }],
        resource: resource('OBJECTIVE', {
          owner: { type: 'ROLE_ASSIGNMENT', id: 'assignment-forged' },
          responsibleRoleAssignmentIds: ['assignment-forged'],
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'RESOURCE_RELATION_DENIED',
    });
  });

  it('denies a resource outside the assignment organization', () => {
    expect(
      evaluate({
        resource: resource('OBJECTIVE', {
          organizationId: 'org-finance',
          organizationAncestorIds: ['org-headquarters'],
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'ORGANIZATION_SCOPE_DENIED',
    });
  });

  it('denies resources outside project and task scopes', () => {
    expect(
      evaluate({
        resource: resource('OBJECTIVE', {
          projectId: 'project-unassigned',
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'PROJECT_SCOPE_DENIED',
    });
    expect(
      evaluate({
        resource: resource('OBJECTIVE', {
          taskId: 'task-unassigned',
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'TASK_SCOPE_DENIED',
    });
  });

  it('denies reads when the assignment grants no matching action', () => {
    expect(
      evaluate({
        assignments: [{ ...activeAssignment, permissionActions: [] }],
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'ASSIGNMENT_ACTION_DENIED',
    });
  });

  it('denies when the active assignment lacks any required permission label', () => {
    expect(
      evaluate({
        resource: resource('EVIDENCE', {
          permissionLabels: [PERMISSION_LABEL, 'restricted.finance'],
        }),
        action: 'business.evidence.read',
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'PERMISSION_LABEL_SCOPE_DENIED',
    });
  });

  it('denies an in-scope resource with no owner or responsible relationship', () => {
    expect(
      evaluate({
        resource: resource('OBJECTIVE', {
          owner: { type: 'ROLE_ASSIGNMENT', id: 'assignment-other' },
          responsibleRoleAssignmentIds: [],
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'RESOURCE_RELATION_DENIED',
    });
  });

  it('uses the owner OrgUnit ancestry, not unrelated resource ancestry, for owner relations', () => {
    expect(
      evaluate({
        resource: resource('OBJECTIVE', {
          owner: { type: 'ORG_UNIT', id: ORGANIZATION_ID },
          ownerOrganizationAncestorIds: [ORGANIZATION_ANCESTOR_ID],
          responsibleRoleAssignmentIds: [],
        }),
      }),
    ).toMatchObject({
      effect: 'allow',
      reasonCode: 'ALLOW_RESOURCE_RELATION',
    });
    expect(
      evaluate({
        resource: resource('OBJECTIVE', {
          owner: { type: 'ORG_UNIT', id: 'org-finance' },
          ownerOrganizationAncestorIds: ['org-headquarters'],
          responsibleRoleAssignmentIds: [],
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'RESOURCE_RELATION_DENIED',
    });
  });

  it('does not combine a relation from one assignment with scope from another', () => {
    const relationOnly: BusinessSemanticRoleAssignment = {
      ...activeAssignment,
      id: 'assignment-relation-only',
      organizationScope: {
        organizationIds: ['org-unrelated'],
        includeDescendants: false,
      },
      projectIds: ['project-unrelated'],
      taskIds: ['task-unrelated'],
      permissionLabels: ['restricted.other'],
    };
    const scopeOnly: BusinessSemanticRoleAssignment = {
      ...activeAssignment,
      id: 'assignment-scope-only',
    };

    expect(
      evaluate({
        assignments: [relationOnly, scopeOnly],
        resource: resource('OBJECTIVE', {
          owner: {
            type: 'ROLE_ASSIGNMENT',
            id: relationOnly.id,
          },
          responsibleRoleAssignmentIds: [],
        }),
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'ORGANIZATION_SCOPE_DENIED',
    });
  });

  it('does not let an Employment OrgUnit bypass explicit assignment organization scope', () => {
    expect(
      evaluate({
        employments: [
          {
            ...activeEmployment,
            organizationIds: ['org-sales'],
            orgUnitIds: [ORGANIZATION_ID],
          },
        ],
        assignments: [
          {
            ...activeAssignment,
            organizationScope: {
              organizationIds: ['org-finance'],
              includeDescendants: false,
            },
          },
        ],
      }),
    ).toMatchObject({
      effect: 'deny',
      reasonCode: 'ORGANIZATION_SCOPE_DENIED',
    });
  });
});

describe('executable semantic filters', () => {
  it('emits and parses coupled tenant, identity, relation, and scope obligations', () => {
    const decision = evaluate({ resource: null });
    expect(decision).toMatchObject({
      effect: 'allow',
      reasonCode: 'ALLOW_WITH_FILTERS',
    });
    expect(decision.obligations.map((obligation) => obligation.type)).toEqual(
      expect.arrayContaining([
        'FILTER_TENANT',
        'FILTER_ACTIVE_EMPLOYMENTS',
        'FILTER_ACTIVE_ASSIGNMENTS',
        'FILTER_OWNER_RELATIONS',
        'FILTER_RESPONSIBLE_RELATIONS',
        'FILTER_ORGANIZATIONS',
        'FILTER_PROJECTS',
        'FILTER_TASKS',
        'FILTER_PERMISSION_LABELS',
        'FILTER_ACCESS_GRANTS',
      ]),
    );

    const filter = businessSemanticFiltersFromDecision(decision);
    expect(filter).toEqual({
      tenantId: TENANT_ID,
      userId: USER_ID,
      managementBypass: false,
      employmentIds: [EMPLOYMENT_ID],
      grants: [
        expect.objectContaining({
          employmentId: EMPLOYMENT_ID,
          assignmentId: ASSIGNMENT_ID,
          roleBlueprintId: ROLE_BLUEPRINT_ID,
          organizationIds: [ORGANIZATION_ANCESTOR_ID],
          includeOrganizationDescendants: true,
          projectIds: [PROJECT_ID],
          taskIds: [TASK_ID],
          permissionLabels: [PERMISSION_LABEL],
        }),
      ],
    });

    expect(
      filterBusinessSemanticResources(
        [
          resource('OBJECTIVE'),
          resource('OBJECTIVE', {
            id: 'objective-hidden',
            tenantId: OTHER_TENANT_ID,
          }),
        ],
        filter,
      ).map((item) => item.id),
    ).toEqual(['objective-alpha']);
  });

  it('fails closed when an allowed decision omits or corrupts an obligation', () => {
    const decision = evaluate({ resource: null });
    const withoutTaskFilter: BusinessSemanticAuthorizationDecision = {
      ...decision,
      obligations: decision.obligations.filter((obligation) => obligation.type !== 'FILTER_TASKS'),
    };
    const malformedGrant: BusinessSemanticAuthorizationDecision = {
      ...decision,
      obligations: decision.obligations.map((obligation) =>
        obligation.type === 'FILTER_ACCESS_GRANTS'
          ? {
              ...obligation,
              parameters: {
                ...(obligation.parameters ?? {}),
                grants: [{ assignmentId: ASSIGNMENT_ID }],
              },
            }
          : obligation,
      ),
    };

    expect(() => businessSemanticFiltersFromDecision(withoutTaskFilter)).toThrow(/FILTER_TASKS/);
    expect(() => businessSemanticFiltersFromDecision(malformedGrant)).toThrow(
      /malformed semantic access grants/,
    );
  });

  it('rejects duplicate obligations and grants bound to another user', () => {
    const decision = evaluate({ resource: null });
    const tenantObligation = decision.obligations.find(
      (obligation) => obligation.type === 'FILTER_TENANT',
    )!;
    const duplicateTenant: BusinessSemanticAuthorizationDecision = {
      ...decision,
      obligations: [...decision.obligations, tenantObligation],
    };
    const wrongGrantUser: BusinessSemanticAuthorizationDecision = {
      ...decision,
      obligations: decision.obligations.map((obligation) => {
        if (obligation.type !== 'FILTER_ACCESS_GRANTS') return obligation;
        const parameters = obligation.parameters!;
        const grants = parameters.grants as readonly Record<string, unknown>[];
        return {
          ...obligation,
          parameters: {
            ...parameters,
            grants: grants.map((grant) => ({
              ...grant,
              userId: 'user-other',
            })),
          },
        };
      }),
    };

    expect(() => businessSemanticFiltersFromDecision(duplicateTenant)).toThrow(
      /duplicate semantic obligation FILTER_TENANT/,
    );
    expect(() => businessSemanticFiltersFromDecision(wrongGrantUser)).toThrow(
      /inconsistent employee semantic access grants/,
    );
  });
});

describe('complete trace authorization', () => {
  const visibleTrace = [
    resource('VALUE'),
    resource('STRATEGY'),
    resource('OBJECTIVE'),
    resource('METRIC'),
    resource('PROCESS'),
    resource('TASK'),
    resource('DELIVERABLE'),
    resource('ACCEPTANCE'),
    resource('EVIDENCE'),
  ] as const;

  it('returns an all-or-nothing trace when every node is visible', () => {
    const decision = evaluateBusinessSemanticTraceAuthorization(
      {
        principal: input().principal,
        action: 'business.trace.read',
        resourceTenantId: TENANT_ID,
        employments: [activeEmployment],
        assignments: [activeAssignment],
        nodes: visibleTrace,
      },
      { now: NOW, decisionId: 'trace-visible' },
    );
    const filter = businessSemanticFiltersFromDecision(decision);

    expect(decision).toMatchObject({
      effect: 'allow',
      reasonCode: 'ALLOW_WITH_FILTERS',
    });
    expect(decision.obligations).toContainEqual({
      type: 'REQUIRE_COMPLETE_TRACE_VISIBILITY',
      parameters: { failClosed: true },
    });
    expect(filterCompleteBusinessSemanticTrace(visibleTrace, filter)).toBe(visibleTrace);
  });

  it('hides the complete trace when one middle node is invisible', () => {
    const hiddenNodeId = 'objective-middle-hidden';
    const nodes = [
      visibleTrace[0],
      resource('OBJECTIVE', {
        id: hiddenNodeId,
        permissionLabels: ['restricted.finance'],
      }),
      visibleTrace[5],
    ] as const;
    const listDecision = evaluate({ resource: null });
    const filter = businessSemanticFiltersFromDecision(listDecision);
    const traceDecision = evaluateBusinessSemanticTraceAuthorization(
      {
        principal: input().principal,
        action: 'business.trace.read',
        resourceTenantId: TENANT_ID,
        employments: [activeEmployment],
        assignments: [activeAssignment],
        nodes,
      },
      { now: NOW, decisionId: 'trace-hidden' },
    );

    expect(filterCompleteBusinessSemanticTrace(nodes, filter)).toBeNull();
    expect(traceDecision).toMatchObject({
      effect: 'deny',
      reasonCode: 'TRACE_ACCESS_DENIED',
    });
    expect(traceDecision.obligations).toEqual([
      {
        type: 'RECORD_AUTHORIZATION_DECISION',
        parameters: { decisionId: 'trace-hidden' },
      },
      {
        type: 'REQUIRE_COMPLETE_TRACE_VISIBILITY',
        parameters: { failClosed: true },
      },
    ]);
    expect(JSON.stringify(traceDecision)).not.toContain(hiddenNodeId);
    expect(JSON.stringify(traceDecision)).not.toContain('restricted.finance');
  });
});
