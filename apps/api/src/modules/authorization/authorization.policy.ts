import { randomUUID } from 'node:crypto';

import type {
  AuthorizationDecision,
  AuthorizationInput,
  AuthorizationObligation,
  AuthorizationReasonCode,
} from './authorization.types.js';

const MANAGEMENT_ACTIONS = new Set([
  'agent.manage',
  'agent.run.reconcile',
  'authorization.review',
  'knowledge.manage',
  'role-assignment.manage',
  'tenant.manage',
]);

const EMPLOYEE_ACTIONS = new Set([
  'agent.list',
  'agent.run.cancel',
  'agent.run.execute',
  'agent.run.retry',
  'agent.use',
  'conversation.create',
  'conversation.list',
  'conversation.message.create',
  'conversation.read',
  'conversation.search',
  'conversation.state.update',
  'conversation.group.manage',
  'knowledge.retrieve',
  'tenant.read',
]);

const REGISTERED_ACTIONS = new Set([...MANAGEMENT_ACTIONS, ...EMPLOYEE_ACTIONS]);
const VALID_RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const VALID_TENANT_ROLES = new Set(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN', 'MEMBER']);

export interface AuthorizationEvaluationOptions {
  readonly decisionId?: string;
  readonly now?: Date;
}

/**
 * In-process, fail-closed policy foundation. This is deliberately not described
 * as an OpenFGA integration; a future external PDP can implement this same
 * input/output contract without weakening the current checks.
 */
export function evaluateAuthorization(
  input: AuthorizationInput,
  options: AuthorizationEvaluationOptions = {},
): AuthorizationDecision {
  const now = options.now ?? new Date();
  const decisionId = options.decisionId ?? `authz_${randomUUID()}`;
  const baseObligations: AuthorizationObligation[] = [
    { type: 'RECORD_AUDIT_DECISION', parameters: { decisionId } },
  ];
  const decide = (
    effect: AuthorizationDecision['effect'],
    reasonCode: AuthorizationReasonCode,
    obligations: readonly AuthorizationObligation[] = [],
  ): AuthorizationDecision => ({
    decisionId,
    effect,
    allowed: effect === 'allow',
    reasonCode,
    obligations: [...baseObligations, ...obligations],
    evaluatedAt: now.toISOString(),
  });

  if (
    input.tenantId.trim().length === 0 ||
    input.userId.trim().length === 0 ||
    input.resourceTenantId.trim().length === 0 ||
    input.action.trim().length === 0 ||
    !VALID_RISKS.has(input.risk) ||
    !VALID_TENANT_ROLES.has(input.tenantRole)
  ) {
    return decide('deny', 'INVALID_INPUT');
  }
  if (input.resourceTenantId !== input.tenantId) {
    return decide('deny', 'CROSS_TENANT');
  }
  if (!REGISTERED_ACTIONS.has(input.action)) {
    return decide('deny', 'ACTION_NOT_REGISTERED');
  }
  if (input.risk === 'CRITICAL') {
    return decide('deny', 'CRITICAL_RISK_DENIED', [{ type: 'REQUIRE_RISK_APPROVAL' }]);
  }
  if (input.risk === 'HIGH' && input.taskContext?.riskApprovalGranted !== true) {
    return decide('deny', 'HIGH_RISK_APPROVAL_REQUIRED', [{ type: 'REQUIRE_RISK_APPROVAL' }]);
  }

  if (MANAGEMENT_ACTIONS.has(input.action)) {
    const allowedRoles =
      input.action === 'knowledge.manage'
        ? new Set(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN'])
        : new Set(['OWNER', 'ADMIN']);
    return allowedRoles.has(input.tenantRole)
      ? decide('allow', 'ALLOW_MANAGEMENT_ROLE')
      : decide('deny', 'MANAGEMENT_ROLE_REQUIRED');
  }

  const assignmentDenial = validateAssignment(input, now);
  if (assignmentDenial !== null) return decide('deny', assignmentDenial);

  const organizationDenial = validateOrganizationScope(input);
  if (organizationDenial !== null) return decide('deny', organizationDenial);

  const projectDenial = validateProjectScope(input);
  if (projectDenial !== null) return decide('deny', projectDenial);

  const dataLabelDenial = validateDataLabelScope(input);
  if (dataLabelDenial !== null) return decide('deny', dataLabelDenial);

  if (!isActorInTaskScope(input)) {
    return decide('deny', 'TASK_CONTEXT_DENIED');
  }

  if (input.action === 'agent.use' || input.action === 'agent.run.execute') {
    const obligations: AuthorizationObligation[] = [];
    if (input.assignment !== undefined && input.assignment !== null) {
      obligations.push({ type: 'REVALIDATE_ASSIGNMENT' });
      if ((input.assignment.organizationScope?.organizationIds?.length ?? 0) > 0) {
        obligations.push({
          type: 'FILTER_ORGANIZATION_SCOPE',
          parameters: {
            organizationIds: input.assignment.organizationScope?.organizationIds ?? [],
            includeDescendants: input.assignment.organizationScope?.includeDescendants === true,
          },
        });
      }
      if ((input.assignment.projectIds?.length ?? 0) > 0) {
        obligations.push({
          type: 'FILTER_PROJECT_SCOPE',
          parameters: { projectIds: input.assignment.projectIds ?? [] },
        });
      }
      if (input.action === 'agent.run.execute') {
        obligations.push({ type: 'VERIFY_RESOURCE_MEMBERSHIP' });
        obligations.push({ type: 'REVALIDATE_KNOWLEDGE_ACCESS' });
      }
      return decide('allow', 'ALLOW_ASSIGNED_AGENT', obligations);
    }
    if (input.action === 'agent.run.execute') {
      obligations.push({ type: 'VERIFY_RESOURCE_MEMBERSHIP' });
      obligations.push({ type: 'REVALIDATE_KNOWLEDGE_ACCESS' });
    }
    if (input.taskContext?.resourceOwnerUserId === input.userId) {
      return decide('allow', 'ALLOW_PERSONAL_AGENT', obligations);
    }
    if (input.taskContext?.resourceVisibility === 'tenant') {
      return decide('allow', 'ALLOW_TENANT_MEMBER', obligations);
    }
    return decide('deny', 'RESOURCE_VISIBILITY_DENIED');
  }

  if (input.action === 'agent.list') {
    return decide('allow', 'ALLOW_WITH_RESOURCE_FILTERS', [
      { type: 'FILTER_AGENT_VISIBILITY' },
      { type: 'FILTER_ACTIVE_ASSIGNMENTS' },
    ]);
  }

  if (input.action.startsWith('conversation.')) {
    return decide('allow', 'ALLOW_WITH_RESOURCE_FILTERS', [{ type: 'VERIFY_RESOURCE_MEMBERSHIP' }]);
  }

  if (input.action === 'agent.run.cancel' || input.action === 'agent.run.retry') {
    return decide('allow', 'ALLOW_WITH_RESOURCE_FILTERS', [{ type: 'VERIFY_RESOURCE_MEMBERSHIP' }]);
  }

  if (input.action === 'knowledge.retrieve') {
    const organizationScope = input.assignment?.organizationScope;
    const projectIds = input.assignment?.projectIds ?? input.project?.assignedProjectIds ?? [];
    const taskIds =
      input.taskContext?.taskId === undefined
        ? []
        : input.assignment?.taskIds === undefined || input.assignment.taskIds.length === 0
          ? [input.taskContext.taskId]
          : input.assignment.taskIds.filter((taskId) => taskId === input.taskContext?.taskId);
    const principalLabels = input.assignment?.dataLabels ?? input.dataLabels?.principalLabels ?? [];
    return decide('allow', 'ALLOW_WITH_RESOURCE_FILTERS', [
      {
        type: 'FILTER_ORGANIZATION_SCOPE',
        parameters: {
          organizationIds: organizationScope?.organizationIds ?? [],
          includeDescendants: organizationScope?.includeDescendants === true,
          assignmentScoped: organizationScope !== undefined,
        },
      },
      { type: 'FILTER_PROJECT_SCOPE', parameters: { projectIds } },
      { type: 'FILTER_TASK_SCOPE', parameters: { taskIds } },
      { type: 'ENFORCE_DATA_LABEL_SCOPE', parameters: { principalLabels } },
      ...(input.assignment === undefined || input.assignment === null
        ? []
        : [{ type: 'REVALIDATE_ASSIGNMENT' as const }]),
      { type: 'REVALIDATE_KNOWLEDGE_ACCESS' },
    ]);
  }

  return decide('allow', 'ALLOW_TENANT_MEMBER');
}

function validateAssignment(input: AuthorizationInput, now: Date): AuthorizationReasonCode | null {
  const assignment = input.assignment;
  if (assignment === undefined || assignment === null) {
    return input.taskContext?.assignmentRequired === true ? 'ASSIGNMENT_REQUIRED' : null;
  }
  if (assignment.tenantId !== input.tenantId) return 'ASSIGNMENT_TENANT_MISMATCH';
  if (assignment.userId !== input.userId) return 'ASSIGNMENT_USER_MISMATCH';
  if (
    input.taskContext?.resourceAgentId !== undefined &&
    assignment.agentInstanceId !== input.taskContext.resourceAgentId
  ) {
    return 'ASSIGNMENT_RESOURCE_MISMATCH';
  }
  if (assignment.status === 'EXPIRED') return 'ASSIGNMENT_EXPIRED';
  if (assignment.status !== 'ACTIVE') return 'ASSIGNMENT_NOT_ACTIVE';
  if (assignment.employmentActive === false) return 'ASSIGNMENT_EMPLOYMENT_INACTIVE';

  const effectiveFrom = parseTime(assignment.effectiveFrom);
  if (effectiveFrom === 'invalid') return 'ASSIGNMENT_TIME_INVALID';
  if (effectiveFrom !== null && now.getTime() < effectiveFrom) {
    return 'ASSIGNMENT_NOT_EFFECTIVE';
  }
  const effectiveTo = parseTime(assignment.effectiveTo);
  if (effectiveTo === 'invalid') return 'ASSIGNMENT_TIME_INVALID';
  if (effectiveTo !== null && now.getTime() >= effectiveTo) {
    return 'ASSIGNMENT_EXPIRED';
  }
  if (
    assignment.permissionActions !== undefined &&
    assignment.permissionActions.length > 0 &&
    !assignment.permissionActions.includes('*') &&
    !assignment.permissionActions.includes(input.action)
  ) {
    return 'ASSIGNMENT_ACTION_DENIED';
  }
  return null;
}

function validateOrganizationScope(input: AuthorizationInput): AuthorizationReasonCode | null {
  const resourceId = input.organization?.resourceOrganizationId;
  if (resourceId === undefined || resourceId === null) return null;

  const assignmentScope = input.assignment?.organizationScope;
  const assignmentIds = assignmentScope?.organizationIds;
  if (assignmentIds !== undefined && assignmentIds.length > 0) {
    const descendantAllowed =
      assignmentScope?.includeDescendants === true &&
      input.organization?.resourceAncestorOrganizationIds?.some((id) =>
        assignmentIds.includes(id),
      ) === true;
    if (!assignmentIds.includes(resourceId) && !descendantAllowed) {
      return 'ORGANIZATION_SCOPE_DENIED';
    }
  }

  const allowedIds = input.organization?.allowedOrganizationIds;
  if (allowedIds !== undefined && !allowedIds.includes(resourceId)) {
    return 'ORGANIZATION_SCOPE_DENIED';
  }
  return null;
}

function validateProjectScope(input: AuthorizationInput): AuthorizationReasonCode | null {
  const resourceId = input.project?.resourceProjectId;
  if (resourceId === undefined || resourceId === null) return null;
  const allowedIds = input.assignment?.projectIds ?? input.project?.assignedProjectIds;
  return allowedIds !== undefined && !allowedIds.includes(resourceId)
    ? 'PROJECT_SCOPE_DENIED'
    : null;
}

function validateDataLabelScope(input: AuthorizationInput): AuthorizationReasonCode | null {
  const resourceLabels = input.dataLabels?.resourceLabels;
  if (resourceLabels === undefined || resourceLabels.length === 0) return null;
  const principalLabels = new Set(input.dataLabels?.principalLabels ?? []);
  return resourceLabels.some((label) => !principalLabels.has(label))
    ? 'DATA_LABEL_SCOPE_DENIED'
    : null;
}

function isActorInTaskScope(input: AuthorizationInput): boolean {
  const task = input.taskContext;
  const assignmentTaskIds = input.assignment?.taskIds;
  if (
    assignmentTaskIds !== undefined &&
    assignmentTaskIds.length > 0 &&
    (task?.taskId === undefined || !assignmentTaskIds.includes(task.taskId))
  ) {
    return false;
  }
  if (task?.enforceActorMembership !== true) return true;
  const scopedUserIds = new Set(
    [task.requesterUserId, task.ownerUserId, ...(task.participantUserIds ?? [])].filter(
      (value): value is string => value !== undefined,
    ),
  );
  return scopedUserIds.size === 0 || scopedUserIds.has(input.userId);
}

function parseTime(value: Date | string | null | undefined): number | 'invalid' | null {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}
