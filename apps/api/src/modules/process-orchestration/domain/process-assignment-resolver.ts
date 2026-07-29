export type ProcessAssignmentStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';

export type ProcessEmploymentStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
export type ProcessRoleVersionStatus = 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
export type ProcessOrgUnitStatus = 'ACTIVE' | 'ARCHIVED';

export interface ProcessAssignmentCandidate {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly employmentId: string;
  readonly employmentStatus: ProcessEmploymentStatus;
  readonly orgUnitStatus: ProcessOrgUnitStatus;
  readonly roleBlueprintId: string;
  readonly roleVersionStatus: ProcessRoleVersionStatus;
  readonly status: ProcessAssignmentStatus;
  readonly agentId: string;
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
  readonly organizationIds: readonly string[];
  readonly includeOrganizationDescendants: boolean;
  readonly projectIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly permissionLabels: readonly string[];
  readonly permissionActions: readonly string[];
}

export interface ProcessStepRoutingContext {
  readonly tenantId: string;
  readonly responsibleRoleBlueprintId: string;
  readonly organizationId: string;
  readonly organizationAncestorIds: readonly string[];
  readonly projectId: string | null;
  readonly taskId: string;
  readonly permissionLabels: readonly string[];
  readonly requiredPermissionAction: string;
}

export interface ResolvedProcessParticipant {
  readonly roleAssignmentId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly employmentId: string;
}

export type ProcessAssignmentResolution =
  | {
      readonly eligible: true;
      readonly participants: readonly ResolvedProcessParticipant[];
      readonly evaluatedAt: string;
    }
  | {
      readonly eligible: false;
      readonly reason:
        | 'NO_ACTIVE_ASSIGNMENT'
        | 'ORG_UNIT_NOT_ACTIVE'
        | 'ACTION_SCOPE_DENIED'
        | 'ORGANIZATION_SCOPE_DENIED'
        | 'PROJECT_SCOPE_DENIED'
        | 'TASK_SCOPE_DENIED'
        | 'PERMISSION_LABEL_SCOPE_DENIED';
      readonly evaluatedAt: string;
    };

/**
 * Resolves a process node to current effective appointments. It never trusts a
 * requested employee or Agent ID: both are derived from an eligible immutable
 * Role Assignment. Retired role versions remain valid only through an existing
 * active assignment, which preserves historical in-flight process behavior.
 */
export function resolveProcessStepParticipants(
  context: ProcessStepRoutingContext,
  candidates: readonly ProcessAssignmentCandidate[],
  now: Date,
): ProcessAssignmentResolution {
  const evaluatedAt = now.toISOString();
  const roleCandidates = candidates.filter(
    (candidate) =>
      candidate.tenantId === context.tenantId &&
      candidate.roleBlueprintId === context.responsibleRoleBlueprintId &&
      candidate.status === 'ACTIVE' &&
      candidate.employmentStatus === 'ACTIVE' &&
      (candidate.roleVersionStatus === 'PUBLISHED' || candidate.roleVersionStatus === 'RETIRED') &&
      isEffective(candidate.effectiveFrom, candidate.effectiveTo, now),
  );
  if (roleCandidates.length === 0) {
    return { eligible: false, reason: 'NO_ACTIVE_ASSIGNMENT', evaluatedAt };
  }

  const activeOrganizationCandidates = roleCandidates.filter(
    (candidate) => candidate.orgUnitStatus === 'ACTIVE',
  );
  if (activeOrganizationCandidates.length === 0) {
    return { eligible: false, reason: 'ORG_UNIT_NOT_ACTIVE', evaluatedAt };
  }

  const actionCandidates = activeOrganizationCandidates.filter((candidate) =>
    allowsAction(candidate.permissionActions, context.requiredPermissionAction),
  );
  if (actionCandidates.length === 0) {
    return { eligible: false, reason: 'ACTION_SCOPE_DENIED', evaluatedAt };
  }

  const organizationCandidates = actionCandidates.filter((candidate) =>
    matchesOrganization(candidate, context),
  );
  if (organizationCandidates.length === 0) {
    return { eligible: false, reason: 'ORGANIZATION_SCOPE_DENIED', evaluatedAt };
  }

  const projectCandidates = organizationCandidates.filter(
    (candidate) => context.projectId === null || candidate.projectIds.includes(context.projectId),
  );
  if (projectCandidates.length === 0) {
    return { eligible: false, reason: 'PROJECT_SCOPE_DENIED', evaluatedAt };
  }

  const taskCandidates = projectCandidates.filter((candidate) =>
    candidate.taskIds.includes(context.taskId),
  );
  if (taskCandidates.length === 0) {
    return { eligible: false, reason: 'TASK_SCOPE_DENIED', evaluatedAt };
  }

  const labelCandidates = taskCandidates.filter((candidate) =>
    context.permissionLabels.every((label) => candidate.permissionLabels.includes(label)),
  );
  if (labelCandidates.length === 0) {
    return { eligible: false, reason: 'PERMISSION_LABEL_SCOPE_DENIED', evaluatedAt };
  }

  const participants = labelCandidates
    .map((candidate) => ({
      roleAssignmentId: candidate.id,
      userId: candidate.userId,
      agentId: candidate.agentId,
      employmentId: candidate.employmentId,
    }))
    .sort((left, right) => left.roleAssignmentId.localeCompare(right.roleAssignmentId));
  return { eligible: true, participants, evaluatedAt };
}

function isEffective(
  effectiveFrom: Date | string,
  effectiveTo: Date | string | null,
  now: Date,
): boolean {
  const start = effectiveFrom instanceof Date ? effectiveFrom : new Date(effectiveFrom);
  const end =
    effectiveTo === null ? null : effectiveTo instanceof Date ? effectiveTo : new Date(effectiveTo);
  return (
    Number.isFinite(start.getTime()) &&
    start.getTime() <= now.getTime() &&
    (end === null || (Number.isFinite(end.getTime()) && end.getTime() > now.getTime()))
  );
}

function matchesOrganization(
  candidate: ProcessAssignmentCandidate,
  context: ProcessStepRoutingContext,
): boolean {
  if (candidate.organizationIds.includes(context.organizationId)) return true;
  if (!candidate.includeOrganizationDescendants) return false;
  return context.organizationAncestorIds.some((id) => candidate.organizationIds.includes(id));
}

function allowsAction(actions: readonly string[], requiredAction: string): boolean {
  const namespace = requiredAction.split('.')[0];
  return (
    requiredAction.trim().length > 0 &&
    (actions.includes('*') ||
      actions.includes(requiredAction) ||
      (namespace !== undefined && actions.includes(`${namespace}.*`)))
  );
}
