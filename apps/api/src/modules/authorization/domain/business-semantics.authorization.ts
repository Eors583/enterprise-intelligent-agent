import type { TenantRole } from '@enterprise/contracts';
import { randomUUID } from 'node:crypto';

export const BUSINESS_SEMANTIC_RESOURCE_TYPES = [
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
] as const;

export type BusinessSemanticResourceType = (typeof BUSINESS_SEMANTIC_RESOURCE_TYPES)[number];

export const BUSINESS_SEMANTIC_READ_ACTIONS = [
  'business.value.read',
  'business.strategy.read',
  'business.objective.read',
  'business.metric.read',
  'business.process.read',
  'business.task.read',
  'business.deliverable.read',
  'business.acceptance.read',
  'business.evidence.read',
  'business.trace.read',
] as const;

export const BUSINESS_SEMANTIC_WRITE_ACTIONS = [
  'business.value.create',
  'business.value.update',
  'business.value.transition',
  'business.strategy.create',
  'business.strategy.update',
  'business.strategy.transition',
  'business.objective.create',
  'business.objective.update',
  'business.objective.transition',
  'business.metric.create',
  'business.metric.update',
  'business.metric.transition',
  'business.process.create',
  'business.process.update',
  'business.process.transition',
  'business.task.create',
  'business.task.update',
  'business.task.transition',
  'business.deliverable.create',
  'business.deliverable.update',
  'business.deliverable.transition',
  'business.acceptance.create',
  'business.acceptance.update',
  'business.acceptance.transition',
  'business.evidence.create',
  'business.evidence.update',
  'business.evidence.transition',
] as const;

export const BUSINESS_SEMANTIC_EMPLOYEE_WRITE_ACTIONS = [
  'business.task.execute',
  'business.deliverable.submit',
  'business.evidence.contribute',
  'business.acceptance.request',
] as const;

export type BusinessSemanticReadAction = (typeof BUSINESS_SEMANTIC_READ_ACTIONS)[number];
export type BusinessSemanticWriteAction = (typeof BUSINESS_SEMANTIC_WRITE_ACTIONS)[number];
export type BusinessSemanticEmployeeWriteAction =
  (typeof BUSINESS_SEMANTIC_EMPLOYEE_WRITE_ACTIONS)[number];
export type BusinessSemanticAction =
  BusinessSemanticReadAction | BusinessSemanticWriteAction | BusinessSemanticEmployeeWriteAction;

export type BusinessSemanticOwnerType = 'USER' | 'ROLE_ASSIGNMENT' | 'ROLE_BLUEPRINT' | 'ORG_UNIT';

export interface BusinessSemanticOwner {
  readonly type: BusinessSemanticOwnerType;
  readonly id: string;
}

export type BusinessSemanticEmploymentStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';

export type BusinessSemanticOrgUnitStatus = 'ACTIVE' | 'ARCHIVED';

export interface BusinessSemanticEmployment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly status: BusinessSemanticEmploymentStatus;
  readonly orgUnitStatus: BusinessSemanticOrgUnitStatus;
  readonly effectiveFrom?: Date | string;
  readonly effectiveTo?: Date | string | null;
  readonly organizationIds?: readonly string[];
  readonly orgUnitIds?: readonly string[];
}

export type BusinessSemanticAssignmentStatus =
  'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';

export type BusinessSemanticRoleVersionStatus = 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';

export interface BusinessSemanticOrganizationScope {
  readonly organizationIds?: readonly string[];
  readonly includeDescendants?: boolean;
}

export interface BusinessSemanticRoleAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly employmentId: string;
  readonly roleBlueprintId: string;
  /**
   * Status of the immutable Role/Agent version captured by this assignment.
   * RETIRED remains usable by an already-effective assignment; assignment
   * creation is responsible for accepting only PUBLISHED versions.
   */
  readonly roleVersionStatus: BusinessSemanticRoleVersionStatus;
  readonly status: BusinessSemanticAssignmentStatus;
  readonly effectiveFrom?: Date | string;
  readonly effectiveTo?: Date | string | null;
  readonly organizationScope?: BusinessSemanticOrganizationScope;
  readonly projectIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly permissionLabels?: readonly string[];
  readonly permissionActions?: readonly string[];
}

export interface BusinessSemanticPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly tenantRole: TenantRole;
}

export interface BusinessSemanticResource {
  readonly id: string;
  readonly tenantId: string;
  readonly type: BusinessSemanticResourceType;
  readonly owner?: BusinessSemanticOwner | null;
  readonly ownerOrganizationAncestorIds?: readonly string[];
  readonly responsibleRoleAssignmentIds?: readonly string[];
  readonly organizationId?: string | null;
  readonly organizationAncestorIds?: readonly string[];
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly permissionLabels?: readonly string[];
}

export interface BusinessSemanticMutation {
  readonly proposedTenantId?: string;
  readonly proposedOwner?: BusinessSemanticOwner | null;
  readonly proposedResponsibleRoleAssignmentIds?: readonly string[];
  readonly proposedPermissionLabels?: readonly string[];
  readonly proposedOrganizationId?: string | null;
  readonly proposedProjectId?: string | null;
  readonly proposedTaskId?: string | null;
}

export interface BusinessSemanticAuthorizationInput {
  readonly principal: BusinessSemanticPrincipal;
  readonly action: string;
  readonly resourceTenantId: string;
  readonly resource?: BusinessSemanticResource | null;
  readonly employments: readonly BusinessSemanticEmployment[];
  readonly assignments: readonly BusinessSemanticRoleAssignment[];
  readonly mutation?: BusinessSemanticMutation;
}

export type BusinessSemanticAuthorizationEffect = 'allow' | 'deny';

export type BusinessSemanticAuthorizationReasonCode =
  | 'ALLOW_MANAGEMENT_READ'
  | 'ALLOW_MANAGEMENT_WRITE'
  | 'ALLOW_ASSIGNMENT_WRITE'
  | 'ALLOW_RESOURCE_RELATION'
  | 'ALLOW_WITH_FILTERS'
  | 'ACTION_NOT_REGISTERED'
  | 'ASSIGNMENT_ACTION_DENIED'
  | 'ASSIGNMENT_EMPLOYMENT_INACTIVE'
  | 'ASSIGNMENT_EXPIRED'
  | 'ASSIGNMENT_NOT_ACTIVE'
  | 'ASSIGNMENT_NOT_EFFECTIVE'
  | 'ASSIGNMENT_REQUIRED'
  | 'CROSS_TENANT'
  | 'EMPLOYMENT_EXPIRED'
  | 'EMPLOYMENT_NOT_ACTIVE'
  | 'EMPLOYMENT_NOT_EFFECTIVE'
  | 'EMPLOYMENT_REQUIRED'
  | 'INVALID_INPUT'
  | 'MANAGEMENT_ROLE_REQUIRED'
  | 'ORG_UNIT_NOT_ACTIVE'
  | 'ORGANIZATION_SCOPE_DENIED'
  | 'PERMISSION_LABEL_SCOPE_DENIED'
  | 'PROJECT_SCOPE_DENIED'
  | 'RESOURCE_RELATION_DENIED'
  | 'RESOURCE_TYPE_MISMATCH'
  | 'ROLE_VERSION_NOT_USABLE'
  | 'SELF_ELEVATION_DENIED'
  | 'TASK_SCOPE_DENIED'
  | 'TRACE_ACCESS_DENIED';

export type BusinessSemanticAuthorizationObligationType =
  | 'FILTER_ACCESS_GRANTS'
  | 'FILTER_ACTIVE_ASSIGNMENTS'
  | 'FILTER_ACTIVE_EMPLOYMENTS'
  | 'FILTER_ORGANIZATIONS'
  | 'FILTER_OWNER_RELATIONS'
  | 'FILTER_PERMISSION_LABELS'
  | 'FILTER_PROJECTS'
  | 'FILTER_RESPONSIBLE_RELATIONS'
  | 'FILTER_TASKS'
  | 'FILTER_TENANT'
  | 'PREVENT_SELF_ELEVATION'
  | 'RECORD_AUTHORIZATION_DECISION'
  | 'REQUIRE_COMPLETE_TRACE_VISIBILITY'
  | 'VERIFY_WRITE_TARGET_TENANT';

export interface BusinessSemanticAuthorizationObligation {
  readonly type: BusinessSemanticAuthorizationObligationType;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface BusinessSemanticAuthorizationDecision {
  readonly decisionId: string;
  readonly effect: BusinessSemanticAuthorizationEffect;
  readonly allowed: boolean;
  readonly reasonCode: BusinessSemanticAuthorizationReasonCode;
  readonly obligations: readonly BusinessSemanticAuthorizationObligation[];
  readonly evaluatedAt: string;
}

export interface BusinessSemanticAccessGrant {
  readonly employmentId: string;
  readonly assignmentId: string;
  readonly roleBlueprintId: string;
  readonly userId: string;
  readonly organizationIds: readonly string[];
  readonly orgUnitIds: readonly string[];
  readonly includeOrganizationDescendants: boolean;
  readonly projectIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly permissionLabels: readonly string[];
}

export interface BusinessSemanticResourceFilter {
  readonly tenantId: string;
  readonly userId: string;
  readonly managementBypass: boolean;
  readonly employmentIds: readonly string[];
  readonly grants: readonly BusinessSemanticAccessGrant[];
}

export interface BusinessSemanticAuthorizationOptions {
  readonly decisionId?: string;
  readonly now?: Date;
}

export interface BusinessSemanticTraceAuthorizationInput extends Omit<
  BusinessSemanticAuthorizationInput,
  'action' | 'resource'
> {
  readonly action: 'business.trace.read';
  readonly nodes: readonly BusinessSemanticResource[];
}

const WRITE_ACTION_SET = new Set<string>(BUSINESS_SEMANTIC_WRITE_ACTIONS);
const EMPLOYEE_WRITE_ACTION_SET = new Set<string>(BUSINESS_SEMANTIC_EMPLOYEE_WRITE_ACTIONS);
const REGISTERED_ACTION_SET = new Set<string>([
  ...BUSINESS_SEMANTIC_READ_ACTIONS,
  ...BUSINESS_SEMANTIC_WRITE_ACTIONS,
  ...BUSINESS_SEMANTIC_EMPLOYEE_WRITE_ACTIONS,
]);
const MANAGEMENT_ROLES = new Set<TenantRole>(['OWNER', 'ADMIN']);
const REQUIRED_FILTER_OBLIGATIONS = new Set<BusinessSemanticAuthorizationObligationType>([
  'FILTER_ACCESS_GRANTS',
  'FILTER_ACTIVE_ASSIGNMENTS',
  'FILTER_ACTIVE_EMPLOYMENTS',
  'FILTER_ORGANIZATIONS',
  'FILTER_OWNER_RELATIONS',
  'FILTER_PERMISSION_LABELS',
  'FILTER_PROJECTS',
  'FILTER_RESPONSIBLE_RELATIONS',
  'FILTER_TASKS',
  'FILTER_TENANT',
]);

const ACTION_RESOURCE_TYPES: Readonly<Record<string, BusinessSemanticResourceType>> = {
  value: 'VALUE',
  strategy: 'STRATEGY',
  objective: 'OBJECTIVE',
  metric: 'METRIC',
  process: 'PROCESS',
  task: 'TASK',
  deliverable: 'DELIVERABLE',
  acceptance: 'ACCEPTANCE',
  evidence: 'EVIDENCE',
  trace: 'TRACE',
};

/**
 * Pure, fail-closed policy for structured enterprise semantics. Callers supply
 * already-loaded identity relationships; this module never trusts request
 * parameters as proof of employment, assignment, ownership, or responsibility.
 */
export function evaluateBusinessSemanticAuthorization(
  input: BusinessSemanticAuthorizationInput,
  options: BusinessSemanticAuthorizationOptions = {},
): BusinessSemanticAuthorizationDecision {
  const now = options.now ?? new Date();
  const decisionId = options.decisionId ?? `authz_${randomUUID()}`;
  const decide = decisionFactory(decisionId, now);
  const inputDenial = validateBaseInput(input);
  if (inputDenial !== null) return decide('deny', inputDenial);

  if (!REGISTERED_ACTION_SET.has(input.action)) {
    return decide('deny', 'ACTION_NOT_REGISTERED');
  }
  if (input.resourceTenantId !== input.principal.tenantId) {
    return decide('deny', 'CROSS_TENANT');
  }
  if (
    input.resource !== undefined &&
    input.resource !== null &&
    input.resource.tenantId !== input.resourceTenantId
  ) {
    return decide('deny', 'CROSS_TENANT');
  }
  const expectedResourceType = resourceTypeForAction(input.action);
  if (
    input.resource !== undefined &&
    input.resource !== null &&
    input.resource.type !== expectedResourceType
  ) {
    return decide('deny', 'RESOURCE_TYPE_MISMATCH');
  }

  if (WRITE_ACTION_SET.has(input.action)) {
    if (!MANAGEMENT_ROLES.has(input.principal.tenantRole)) {
      return decide('deny', 'MANAGEMENT_ROLE_REQUIRED');
    }
    if (input.action.endsWith('.update') && input.mutation === undefined) {
      return decide('deny', 'INVALID_INPUT');
    }
    if (
      input.mutation?.proposedTenantId !== undefined &&
      input.mutation.proposedTenantId !== input.principal.tenantId
    ) {
      return decide('deny', 'CROSS_TENANT');
    }
    if (
      input.action.endsWith('.create') &&
      (input.mutation?.proposedOwner === undefined || input.mutation.proposedOwner === null)
    ) {
      return decide('deny', 'INVALID_INPUT');
    }
    if (
      !input.action.endsWith('.create') &&
      (input.resource === undefined || input.resource === null)
    ) {
      return decide('deny', 'INVALID_INPUT');
    }
    if (input.principal.tenantRole === 'ADMIN' && mutationWouldElevatePrincipal(input, now)) {
      return decide('deny', 'SELF_ELEVATION_DENIED', [{ type: 'PREVENT_SELF_ELEVATION' }]);
    }
    return decide('allow', 'ALLOW_MANAGEMENT_WRITE', [
      {
        type: 'VERIFY_WRITE_TARGET_TENANT',
        parameters: { tenantId: input.principal.tenantId },
      },
      { type: 'PREVENT_SELF_ELEVATION' },
    ]);
  }

  if (EMPLOYEE_WRITE_ACTION_SET.has(input.action)) {
    if (
      input.mutation === undefined ||
      input.mutation.proposedTaskId === undefined ||
      input.mutation.proposedTaskId === null
    ) {
      return decide('deny', 'INVALID_INPUT');
    }
    if (
      input.mutation.proposedTenantId !== undefined &&
      input.mutation.proposedTenantId !== input.principal.tenantId
    ) {
      return decide('deny', 'CROSS_TENANT');
    }
    const filterResult = buildResourceFilter(input, now);
    if (filterResult.filter === null) {
      return decide('deny', filterResult.reasonCode);
    }
    const target =
      input.resource ?? employeeMutationResource(input, resourceTypeForAction(input.action));
    if (target === null) return decide('deny', 'INVALID_INPUT');
    const visibility = explainBusinessSemanticResourceVisibility(target, filterResult.filter);
    if (visibility !== null) return decide('deny', visibility);
    return decide(
      'allow',
      filterResult.filter.managementBypass ? 'ALLOW_MANAGEMENT_WRITE' : 'ALLOW_ASSIGNMENT_WRITE',
      [
        ...filterObligations(filterResult.filter),
        {
          type: 'VERIFY_WRITE_TARGET_TENANT',
          parameters: { tenantId: input.principal.tenantId },
        },
        { type: 'PREVENT_SELF_ELEVATION' },
      ],
    );
  }

  const filterResult = buildResourceFilter(input, now);
  if (filterResult.filter === null) {
    return decide('deny', filterResult.reasonCode);
  }
  const obligations = filterObligations(filterResult.filter);
  if (input.resource === undefined || input.resource === null) {
    return decide(
      'allow',
      filterResult.filter.managementBypass ? 'ALLOW_MANAGEMENT_READ' : 'ALLOW_WITH_FILTERS',
      obligations,
    );
  }

  const visibility = explainBusinessSemanticResourceVisibility(input.resource, filterResult.filter);
  if (visibility !== null) return decide('deny', visibility);
  return decide(
    'allow',
    filterResult.filter.managementBypass ? 'ALLOW_MANAGEMENT_READ' : 'ALLOW_RESOURCE_RELATION',
    obligations,
  );
}

function employeeMutationResource(
  input: BusinessSemanticAuthorizationInput,
  type: BusinessSemanticResourceType,
): BusinessSemanticResource | null {
  const mutation = input.mutation;
  const taskId = mutation?.proposedTaskId;
  const owner = mutation?.proposedOwner;
  if (mutation === undefined || taskId === undefined || taskId === null || owner === undefined) {
    return null;
  }
  return {
    id: taskId,
    tenantId: input.resourceTenantId,
    type,
    owner,
    taskId,
    permissionLabels: mutation.proposedPermissionLabels ?? [],
  };
}

/**
 * A trace is an atomic security boundary: a single invisible middle node makes
 * the entire request indistinguishable from any other forbidden trace.
 */
export function evaluateBusinessSemanticTraceAuthorization(
  input: BusinessSemanticTraceAuthorizationInput,
  options: BusinessSemanticAuthorizationOptions = {},
): BusinessSemanticAuthorizationDecision {
  const baseDecision = evaluateBusinessSemanticAuthorization(
    {
      principal: input.principal,
      action: input.action,
      resourceTenantId: input.resourceTenantId,
      employments: input.employments,
      assignments: input.assignments,
      ...(input.mutation === undefined ? {} : { mutation: input.mutation }),
    },
    options,
  );
  if (!baseDecision.allowed) return baseDecision;
  if (
    input.nodes.length === 0 ||
    input.nodes.some((node) => node.type === 'TRACE') ||
    input.nodes.some((node) => node.tenantId !== input.resourceTenantId)
  ) {
    return traceDenied(baseDecision);
  }

  let filter: BusinessSemanticResourceFilter;
  try {
    filter = businessSemanticFiltersFromDecision(baseDecision);
  } catch {
    return traceDenied(baseDecision);
  }
  if (filterCompleteBusinessSemanticTrace(input.nodes, filter) === null) {
    return traceDenied(baseDecision);
  }
  return {
    ...baseDecision,
    obligations: [
      ...baseDecision.obligations,
      {
        type: 'REQUIRE_COMPLETE_TRACE_VISIBILITY',
        parameters: { failClosed: true },
      },
    ],
  };
}

export function businessSemanticFiltersFromDecision(
  decision: BusinessSemanticAuthorizationDecision,
): BusinessSemanticResourceFilter {
  if (!decision.allowed || decision.effect !== 'allow') {
    throw new Error('A denied decision cannot produce semantic resource filters.');
  }
  const obligations = new Map<
    BusinessSemanticAuthorizationObligationType,
    Readonly<Record<string, unknown>> | undefined
  >();
  for (const obligation of decision.obligations) {
    if (obligations.has(obligation.type)) {
      throw new Error(
        `Authorization decision contains duplicate semantic obligation ${obligation.type}.`,
      );
    }
    obligations.set(obligation.type, obligation.parameters);
  }
  for (const required of REQUIRED_FILTER_OBLIGATIONS) {
    if (!obligations.has(required)) {
      throw new Error(`Authorization decision omitted required semantic filter ${required}.`);
    }
  }
  const parameters = obligations.get('FILTER_ACCESS_GRANTS');
  if (!isRecord(parameters)) {
    throw new Error('Authorization decision has malformed semantic access grants.');
  }
  const tenantId = nonEmptyString(parameters.tenantId);
  const userId = nonEmptyString(parameters.userId);
  const managementBypass = parameters.managementBypass;
  const employmentIds = stringArray(parameters.employmentIds);
  if (
    tenantId === null ||
    userId === null ||
    typeof managementBypass !== 'boolean' ||
    employmentIds === null ||
    !Array.isArray(parameters.grants)
  ) {
    throw new Error('Authorization decision has malformed semantic access grants.');
  }
  const grants: BusinessSemanticAccessGrant[] = [];
  for (const value of parameters.grants) {
    const grant = parseAccessGrant(value);
    if (grant === null) {
      throw new Error('Authorization decision has malformed semantic access grants.');
    }
    grants.push(grant);
  }
  const normalizedEmploymentIds = uniqueStrings(employmentIds);
  const employmentIdSet = new Set(normalizedEmploymentIds);
  const assignmentIds = grants.map((grant) => grant.assignmentId);
  if (
    managementBypass &&
    (!['ALLOW_MANAGEMENT_READ', 'ALLOW_MANAGEMENT_WRITE'].includes(decision.reasonCode) ||
      grants.length > 0 ||
      normalizedEmploymentIds.length > 0)
  ) {
    throw new Error('Management semantic filters contain an invalid bypass.');
  }
  if (
    !managementBypass &&
    (grants.length === 0 ||
      grants.some((grant) => grant.userId !== userId || !employmentIdSet.has(grant.employmentId)) ||
      normalizedEmploymentIds.some(
        (employmentId) => !grants.some((grant) => grant.employmentId === employmentId),
      ) ||
      uniqueStrings(assignmentIds).length !== assignmentIds.length)
  ) {
    throw new Error('Authorization decision has inconsistent employee semantic access grants.');
  }
  const tenantParameters = obligations.get('FILTER_TENANT');
  if (!isRecord(tenantParameters) || tenantParameters.tenantId !== tenantId) {
    throw new Error('Authorization decision has inconsistent tenant filters.');
  }
  return {
    tenantId,
    userId,
    managementBypass,
    employmentIds: normalizedEmploymentIds,
    grants,
  };
}

export function isBusinessSemanticResourceVisible(
  resource: BusinessSemanticResource,
  filter: BusinessSemanticResourceFilter,
): boolean {
  return explainBusinessSemanticResourceVisibility(resource, filter) === null;
}

export function filterBusinessSemanticResources<T extends BusinessSemanticResource>(
  resources: readonly T[],
  filter: BusinessSemanticResourceFilter,
): T[] {
  return resources.filter((resource) => isBusinessSemanticResourceVisible(resource, filter));
}

/**
 * Returns all nodes or no nodes. It deliberately has no partial-result shape.
 */
export function filterCompleteBusinessSemanticTrace<T extends BusinessSemanticResource>(
  nodes: readonly T[],
  filter: BusinessSemanticResourceFilter,
): readonly T[] | null {
  if (nodes.length === 0) return null;
  return nodes.every((node) => isBusinessSemanticResourceVisible(node, filter)) ? nodes : null;
}

function buildResourceFilter(
  input: BusinessSemanticAuthorizationInput,
  now: Date,
):
  | {
      readonly filter: BusinessSemanticResourceFilter;
      readonly reasonCode: null;
    }
  | {
      readonly filter: null;
      readonly reasonCode: BusinessSemanticAuthorizationReasonCode;
    } {
  if (MANAGEMENT_ROLES.has(input.principal.tenantRole)) {
    return {
      filter: {
        tenantId: input.principal.tenantId,
        userId: input.principal.userId,
        managementBypass: true,
        employmentIds: [],
        grants: [],
      },
      reasonCode: null,
    };
  }

  const employments = input.employments.filter(
    (employment) =>
      employment.tenantId === input.principal.tenantId &&
      employment.userId === input.principal.userId,
  );
  const activeEmployments = employments.filter((employment) => isActiveEmployment(employment, now));
  if (activeEmployments.length === 0) {
    return {
      filter: null,
      reasonCode: classifyEmploymentDenial(employments, now),
    };
  }

  const employmentById = new Map(
    activeEmployments.map((employment) => [employment.id, employment]),
  );
  const assignments = input.assignments.filter(
    (assignment) =>
      assignment.tenantId === input.principal.tenantId &&
      assignment.userId === input.principal.userId,
  );
  const activeIdentityAssignments = assignments.filter(
    (assignment) =>
      isActiveAssignment(assignment, now) &&
      roleVersionUsableByExistingAssignment(assignment.roleVersionStatus) &&
      employmentById.has(assignment.employmentId),
  );
  const actionAssignments = activeIdentityAssignments.filter((assignment) =>
    assignmentAllowsAction(assignment, input.action),
  );
  if (actionAssignments.length === 0) {
    return {
      filter: null,
      reasonCode: classifyAssignmentDenial(
        assignments,
        activeIdentityAssignments,
        input.action,
        employmentById,
        now,
      ),
    };
  }

  return {
    filter: {
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      managementBypass: false,
      employmentIds: uniqueStrings(actionAssignments.map((assignment) => assignment.employmentId)),
      grants: actionAssignments.map((assignment) =>
        accessGrant(
          input.principal.userId,
          assignment,
          employmentById.get(assignment.employmentId)!,
        ),
      ),
    },
    reasonCode: null,
  };
}

function explainBusinessSemanticResourceVisibility(
  resource: BusinessSemanticResource,
  filter: BusinessSemanticResourceFilter,
): BusinessSemanticAuthorizationReasonCode | null {
  if (resource.tenantId !== filter.tenantId) return 'CROSS_TENANT';
  if (filter.managementBypass) return null;

  let candidates = filter.grants.filter((grant) =>
    grantEstablishesResourceRelation(grant, resource, filter.userId),
  );
  if (candidates.length === 0) return 'RESOURCE_RELATION_DENIED';

  candidates = candidates.filter((grant) => organizationAllowed(grant, resource));
  if (candidates.length === 0) return 'ORGANIZATION_SCOPE_DENIED';

  candidates = candidates.filter((grant) => projectAllowed(grant, resource));
  if (candidates.length === 0) return 'PROJECT_SCOPE_DENIED';

  candidates = candidates.filter((grant) => taskAllowed(grant, resource));
  if (candidates.length === 0) return 'TASK_SCOPE_DENIED';

  candidates = candidates.filter((grant) => permissionLabelsAllowed(grant, resource));
  return candidates.length === 0 ? 'PERMISSION_LABEL_SCOPE_DENIED' : null;
}

function accessGrant(
  userId: string,
  assignment: BusinessSemanticRoleAssignment,
  employment: BusinessSemanticEmployment,
): BusinessSemanticAccessGrant {
  const assignmentOrganizationIds = cleanStrings(
    assignment.organizationScope?.organizationIds ?? [],
  );
  const employmentOrganizationIds = cleanStrings([
    ...(employment.organizationIds ?? []),
    ...(employment.orgUnitIds ?? []),
  ]);
  const employmentOrgUnitIds = cleanStrings(employment.orgUnitIds ?? []);
  const hasAssignmentOrganizationScope = assignment.organizationScope !== undefined;
  const organizationIds = hasAssignmentOrganizationScope
    ? assignmentOrganizationIds
    : employmentOrganizationIds;
  return {
    employmentId: employment.id,
    assignmentId: assignment.id,
    roleBlueprintId: assignment.roleBlueprintId,
    userId,
    organizationIds,
    orgUnitIds: hasAssignmentOrganizationScope ? [] : employmentOrgUnitIds,
    includeOrganizationDescendants: assignment.organizationScope?.includeDescendants === true,
    projectIds: cleanStrings(assignment.projectIds ?? []),
    taskIds: cleanStrings(assignment.taskIds ?? []),
    permissionLabels: cleanStrings(assignment.permissionLabels ?? []),
  };
}

function grantEstablishesResourceRelation(
  grant: BusinessSemanticAccessGrant,
  resource: BusinessSemanticResource,
  userId: string,
): boolean {
  if (resource.responsibleRoleAssignmentIds?.includes(grant.assignmentId) === true) {
    return true;
  }
  const owner = resource.owner;
  if (owner === undefined || owner === null) return false;
  if (owner.type === 'USER') return owner.id === userId;
  if (owner.type === 'ROLE_ASSIGNMENT') return owner.id === grant.assignmentId;
  if (owner.type === 'ROLE_BLUEPRINT') return owner.id === grant.roleBlueprintId;
  return organizationOwnerAllowed(grant, owner.id, resource);
}

function organizationOwnerAllowed(
  grant: BusinessSemanticAccessGrant,
  ownerOrganizationId: string,
  resource: BusinessSemanticResource,
): boolean {
  if (
    grant.organizationIds.includes(ownerOrganizationId) ||
    grant.orgUnitIds.includes(ownerOrganizationId)
  ) {
    return true;
  }
  return (
    grant.includeOrganizationDescendants &&
    resource.ownerOrganizationAncestorIds?.some((ancestorId) =>
      grant.organizationIds.includes(ancestorId),
    ) === true
  );
}

function organizationAllowed(
  grant: BusinessSemanticAccessGrant,
  resource: BusinessSemanticResource,
): boolean {
  const organizationId = emptyToNull(resource.organizationId);
  if (organizationId === null) return true;
  if (grant.organizationIds.includes(organizationId) || grant.orgUnitIds.includes(organizationId)) {
    return true;
  }
  return (
    grant.includeOrganizationDescendants &&
    resource.organizationAncestorIds?.some((ancestorId) =>
      grant.organizationIds.includes(ancestorId),
    ) === true
  );
}

function projectAllowed(
  grant: BusinessSemanticAccessGrant,
  resource: BusinessSemanticResource,
): boolean {
  const projectId = emptyToNull(resource.projectId);
  return projectId === null || grant.projectIds.includes(projectId);
}

function taskAllowed(
  grant: BusinessSemanticAccessGrant,
  resource: BusinessSemanticResource,
): boolean {
  const taskId =
    emptyToNull(resource.taskId) ?? (resource.type === 'TASK' ? emptyToNull(resource.id) : null);
  return taskId === null || grant.taskIds.includes(taskId);
}

function permissionLabelsAllowed(
  grant: BusinessSemanticAccessGrant,
  resource: BusinessSemanticResource,
): boolean {
  const labels = cleanStrings(resource.permissionLabels ?? []);
  if (labels.length === 0) return true;
  const allowed = new Set(grant.permissionLabels);
  return labels.every((label) => allowed.has(label));
}

function filterObligations(
  filter: BusinessSemanticResourceFilter,
): BusinessSemanticAuthorizationObligation[] {
  const assignmentIds = filter.grants.map((grant) => grant.assignmentId);
  const roleBlueprintIds = filter.grants.map((grant) => grant.roleBlueprintId);
  const organizationGrants = filter.grants.map((grant) => ({
    assignmentId: grant.assignmentId,
    organizationIds: grant.organizationIds,
    orgUnitIds: grant.orgUnitIds,
    includeDescendants: grant.includeOrganizationDescendants,
  }));
  const projectGrants = filter.grants.map((grant) => ({
    assignmentId: grant.assignmentId,
    projectIds: grant.projectIds,
  }));
  const taskGrants = filter.grants.map((grant) => ({
    assignmentId: grant.assignmentId,
    taskIds: grant.taskIds,
  }));
  const labelGrants = filter.grants.map((grant) => ({
    assignmentId: grant.assignmentId,
    permissionLabels: grant.permissionLabels,
  }));
  return [
    {
      type: 'FILTER_TENANT',
      parameters: { tenantId: filter.tenantId },
    },
    {
      type: 'FILTER_ACTIVE_EMPLOYMENTS',
      parameters: { employmentIds: filter.employmentIds },
    },
    {
      type: 'FILTER_ACTIVE_ASSIGNMENTS',
      parameters: { assignmentIds, roleBlueprintIds },
    },
    {
      type: 'FILTER_OWNER_RELATIONS',
      parameters: {
        userId: filter.userId,
        assignmentIds,
        roleBlueprintIds,
        orgUnitIds: uniqueStrings(filter.grants.flatMap((grant) => grant.orgUnitIds)),
      },
    },
    {
      type: 'FILTER_RESPONSIBLE_RELATIONS',
      parameters: { assignmentIds },
    },
    {
      type: 'FILTER_ORGANIZATIONS',
      parameters: { grants: organizationGrants },
    },
    {
      type: 'FILTER_PROJECTS',
      parameters: { grants: projectGrants },
    },
    {
      type: 'FILTER_TASKS',
      parameters: { grants: taskGrants },
    },
    {
      type: 'FILTER_PERMISSION_LABELS',
      parameters: { grants: labelGrants },
    },
    {
      type: 'FILTER_ACCESS_GRANTS',
      parameters: {
        tenantId: filter.tenantId,
        userId: filter.userId,
        managementBypass: filter.managementBypass,
        employmentIds: filter.employmentIds,
        grants: filter.grants,
      },
    },
  ];
}

function mutationWouldElevatePrincipal(
  input: BusinessSemanticAuthorizationInput,
  now: Date,
): boolean {
  const mutation = input.mutation;
  if (mutation === undefined) return false;
  const principalAssignments = input.assignments.filter(
    (assignment) =>
      assignment.tenantId === input.principal.tenantId &&
      assignment.userId === input.principal.userId,
  );
  const assignmentIds = new Set(principalAssignments.map((assignment) => assignment.id));
  const roleBlueprintIds = new Set(
    principalAssignments.map((assignment) => assignment.roleBlueprintId),
  );
  const activeEmployments = input.employments.filter(
    (employment) =>
      employment.tenantId === input.principal.tenantId &&
      employment.userId === input.principal.userId &&
      isActiveEmployment(employment, now),
  );
  const organizationIds = new Set(
    activeEmployments.flatMap((employment) => [
      ...(employment.organizationIds ?? []),
      ...(employment.orgUnitIds ?? []),
    ]),
  );
  const owner = mutation.proposedOwner;
  if (owner !== undefined && owner !== null) {
    if (owner.type === 'USER' && owner.id === input.principal.userId) return true;
    if (owner.type === 'ROLE_ASSIGNMENT' && assignmentIds.has(owner.id)) return true;
    if (owner.type === 'ROLE_BLUEPRINT' && roleBlueprintIds.has(owner.id)) return true;
    if (owner.type === 'ORG_UNIT' && organizationIds.has(owner.id)) return true;
  }
  return (
    mutation.proposedResponsibleRoleAssignmentIds?.some((id) => assignmentIds.has(id)) === true
  );
}

function classifyEmploymentDenial(
  employments: readonly BusinessSemanticEmployment[],
  now: Date,
): BusinessSemanticAuthorizationReasonCode {
  if (employments.length === 0) return 'EMPLOYMENT_REQUIRED';
  if (employments.every((employment) => employment.status !== 'ACTIVE')) {
    return 'EMPLOYMENT_NOT_ACTIVE';
  }
  const activeStatus = employments.filter((employment) => employment.status === 'ACTIVE');
  if (activeStatus.every((employment) => employment.orgUnitStatus !== 'ACTIVE')) {
    return 'ORG_UNIT_NOT_ACTIVE';
  }
  if (
    activeStatus.some((employment) => {
      const start = parseTime(employment.effectiveFrom);
      return typeof start === 'number' && now.getTime() < start;
    })
  ) {
    return 'EMPLOYMENT_NOT_EFFECTIVE';
  }
  return 'EMPLOYMENT_EXPIRED';
}

function classifyAssignmentDenial(
  assignments: readonly BusinessSemanticRoleAssignment[],
  activeIdentityAssignments: readonly BusinessSemanticRoleAssignment[],
  action: string,
  activeEmploymentById: ReadonlyMap<string, BusinessSemanticEmployment>,
  now: Date,
): BusinessSemanticAuthorizationReasonCode {
  if (assignments.length === 0) return 'ASSIGNMENT_REQUIRED';
  if (assignments.every((assignment) => assignment.status !== 'ACTIVE')) {
    return 'ASSIGNMENT_NOT_ACTIVE';
  }
  const activeStatus = assignments.filter((assignment) => assignment.status === 'ACTIVE');
  if (
    activeStatus.some((assignment) => {
      const start = parseTime(assignment.effectiveFrom);
      return typeof start === 'number' && now.getTime() < start;
    })
  ) {
    return 'ASSIGNMENT_NOT_EFFECTIVE';
  }
  if (
    activeStatus.some((assignment) => {
      const end = parseTime(assignment.effectiveTo);
      return typeof end === 'number' && now.getTime() >= end;
    })
  ) {
    return 'ASSIGNMENT_EXPIRED';
  }
  if (activeStatus.every((assignment) => !activeEmploymentById.has(assignment.employmentId))) {
    return 'ASSIGNMENT_EMPLOYMENT_INACTIVE';
  }
  if (
    activeStatus.every(
      (assignment) => !roleVersionUsableByExistingAssignment(assignment.roleVersionStatus),
    )
  ) {
    return 'ROLE_VERSION_NOT_USABLE';
  }
  if (
    activeIdentityAssignments.length > 0 &&
    activeIdentityAssignments.every((assignment) => !assignmentAllowsAction(assignment, action))
  ) {
    return 'ASSIGNMENT_ACTION_DENIED';
  }
  return 'ASSIGNMENT_NOT_ACTIVE';
}

function assignmentAllowsAction(
  assignment: BusinessSemanticRoleAssignment,
  action: string,
): boolean {
  const actions = cleanStrings(assignment.permissionActions ?? []);
  if (actions.length === 0) return false;
  const family = action.split('.')[1];
  return (
    actions.includes('*') ||
    actions.includes('business.*') ||
    actions.includes(action) ||
    (family !== undefined && actions.includes(`business.${family}.*`))
  );
}

function roleVersionUsableByExistingAssignment(status: BusinessSemanticRoleVersionStatus): boolean {
  return status === 'PUBLISHED' || status === 'RETIRED';
}

function isActiveEmployment(employment: BusinessSemanticEmployment, now: Date): boolean {
  return (
    employment.status === 'ACTIVE' &&
    employment.orgUnitStatus === 'ACTIVE' &&
    isEffectiveAt(employment.effectiveFrom, employment.effectiveTo, now)
  );
}

function isActiveAssignment(assignment: BusinessSemanticRoleAssignment, now: Date): boolean {
  return (
    assignment.status === 'ACTIVE' &&
    isEffectiveAt(assignment.effectiveFrom, assignment.effectiveTo, now)
  );
}

function isEffectiveAt(
  effectiveFrom: Date | string | undefined,
  effectiveTo: Date | string | null | undefined,
  now: Date,
): boolean {
  const start = parseTime(effectiveFrom);
  const end = parseTime(effectiveTo);
  if (start === 'invalid' || end === 'invalid') return false;
  return (start === null || now.getTime() >= start) && (end === null || now.getTime() < end);
}

function parseTime(value: Date | string | null | undefined): number | 'invalid' | null {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

function validateBaseInput(
  input: BusinessSemanticAuthorizationInput,
): BusinessSemanticAuthorizationReasonCode | null {
  if (
    emptyToNull(input.principal.tenantId) === null ||
    emptyToNull(input.principal.userId) === null ||
    emptyToNull(input.resourceTenantId) === null ||
    emptyToNull(input.action) === null ||
    !['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN', 'MEMBER'].includes(input.principal.tenantRole)
  ) {
    return 'INVALID_INPUT';
  }
  if (
    input.resource !== undefined &&
    input.resource !== null &&
    (emptyToNull(input.resource.id) === null ||
      !BUSINESS_SEMANTIC_RESOURCE_TYPES.includes(input.resource.type))
  ) {
    return 'INVALID_INPUT';
  }
  return null;
}

function resourceTypeForAction(action: string): BusinessSemanticResourceType {
  const family = action.split('.')[1];
  return ACTION_RESOURCE_TYPES[family ?? ''] ?? 'TRACE';
}

function decisionFactory(decisionId: string, now: Date) {
  return (
    effect: BusinessSemanticAuthorizationEffect,
    reasonCode: BusinessSemanticAuthorizationReasonCode,
    obligations: readonly BusinessSemanticAuthorizationObligation[] = [],
  ): BusinessSemanticAuthorizationDecision => ({
    decisionId,
    effect,
    allowed: effect === 'allow',
    reasonCode,
    obligations: [
      {
        type: 'RECORD_AUTHORIZATION_DECISION',
        parameters: { decisionId },
      },
      ...obligations,
    ],
    evaluatedAt: now.toISOString(),
  });
}

function traceDenied(
  baseDecision: BusinessSemanticAuthorizationDecision,
): BusinessSemanticAuthorizationDecision {
  return {
    decisionId: baseDecision.decisionId,
    effect: 'deny',
    allowed: false,
    reasonCode: 'TRACE_ACCESS_DENIED',
    obligations: [
      {
        type: 'RECORD_AUTHORIZATION_DECISION',
        parameters: { decisionId: baseDecision.decisionId },
      },
      {
        type: 'REQUIRE_COMPLETE_TRACE_VISIBILITY',
        parameters: { failClosed: true },
      },
    ],
    evaluatedAt: baseDecision.evaluatedAt,
  };
}

function parseAccessGrant(value: unknown): BusinessSemanticAccessGrant | null {
  if (!isRecord(value)) return null;
  const employmentId = nonEmptyString(value.employmentId);
  const assignmentId = nonEmptyString(value.assignmentId);
  const roleBlueprintId = nonEmptyString(value.roleBlueprintId);
  const userId = nonEmptyString(value.userId);
  const organizationIds = stringArray(value.organizationIds);
  const orgUnitIds = stringArray(value.orgUnitIds);
  const projectIds = stringArray(value.projectIds);
  const taskIds = stringArray(value.taskIds);
  const permissionLabels = stringArray(value.permissionLabels);
  if (
    employmentId === null ||
    assignmentId === null ||
    roleBlueprintId === null ||
    userId === null ||
    organizationIds === null ||
    orgUnitIds === null ||
    projectIds === null ||
    taskIds === null ||
    permissionLabels === null ||
    typeof value.includeOrganizationDescendants !== 'boolean'
  ) {
    return null;
  }
  return {
    employmentId,
    assignmentId,
    roleBlueprintId,
    userId,
    organizationIds: uniqueStrings(organizationIds),
    orgUnitIds: uniqueStrings(orgUnitIds),
    includeOrganizationDescendants: value.includeOrganizationDescendants,
    projectIds: uniqueStrings(projectIds),
    taskIds: uniqueStrings(taskIds),
    permissionLabels: uniqueStrings(permissionLabels),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    return null;
  }
  return value;
}

function cleanStrings(values: readonly string[]): string[] {
  return uniqueStrings(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
