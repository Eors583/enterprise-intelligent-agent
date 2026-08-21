import type { Prisma } from '@prisma/client';

import type {
  BusinessSemanticEmployment,
  BusinessSemanticOrganizationScope,
  BusinessSemanticPrincipal,
  BusinessSemanticRoleAssignment,
} from './domain/business-semantics.authorization.js';

export interface BusinessSemanticAuthorizationIdentity {
  readonly employments: readonly BusinessSemanticEmployment[];
  readonly assignments: readonly BusinessSemanticRoleAssignment[];
}

/**
 * Loads authorization identity from the tenant-scoped transaction. Request
 * payloads must never be used as proof of employment, assignment, role, or
 * organization membership.
 */
export async function loadBusinessSemanticAuthorizationIdentity(
  transaction: Prisma.TransactionClient,
  principal: BusinessSemanticPrincipal,
): Promise<BusinessSemanticAuthorizationIdentity> {
  const employments = await transaction.employment.findMany({
    where: {
      tenantId: principal.tenantId,
      userId: principal.userId,
    },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      organizationId: true,
      orgUnitId: true,
      status: true,
      orgUnit: {
        select: {
          status: true,
        },
      },
    },
  });
  const assignments = await transaction.roleAssignment.findMany({
    where: {
      tenantId: principal.tenantId,
      userId: principal.userId,
    },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      employmentId: true,
      roleTemplateId: true,
      status: true,
      effectiveFrom: true,
      effectiveTo: true,
      organizationScope: true,
      permissionScope: true,
      roleVersion: {
        select: {
          status: true,
        },
      },
    },
  });

  return {
    employments: employments.map((employment) => ({
      id: employment.id,
      tenantId: employment.tenantId,
      userId: employment.userId,
      status: employment.status,
      orgUnitStatus: employment.orgUnit.status,
      organizationIds: [employment.organizationId],
      orgUnitIds: [employment.orgUnitId],
    })),
    assignments: assignments.map((assignment) => {
      const organizationScope = readOrganizationScope(assignment.organizationScope);
      const permissionScope = readPermissionScope(assignment.permissionScope);
      return {
        id: assignment.id,
        tenantId: assignment.tenantId,
        userId: assignment.userId,
        employmentId: assignment.employmentId,
        roleBlueprintId: assignment.roleTemplateId,
        roleVersionStatus: assignment.roleVersion.status,
        status: assignment.status,
        effectiveFrom: assignment.effectiveFrom,
        effectiveTo: assignment.effectiveTo,
        ...(organizationScope === undefined ? {} : { organizationScope }),
        projectIds: permissionScope.projectIds,
        taskIds: permissionScope.taskIds,
        permissionLabels: permissionScope.permissionLabels,
        permissionActions: permissionScope.permissionActions,
      };
    }),
  };
}

function readOrganizationScope(
  value: Prisma.JsonValue,
): BusinessSemanticOrganizationScope | undefined {
  if (!isRecord(value)) return denyAllOrganizationScope();
  const hasOrganizationIds = hasOwn(value, 'organizationIds');
  const hasLegacyOrgUnitIds = hasOwn(value, 'orgUnitIds');
  const hasIncludeDescendants = hasOwn(value, 'includeDescendants');
  const hasLegacyIncludeChildren = hasOwn(value, 'includeChildren');
  if (
    !hasOrganizationIds &&
    !hasLegacyOrgUnitIds &&
    !hasIncludeDescendants &&
    !hasLegacyIncludeChildren
  ) {
    return undefined;
  }

  let organizationIds: string[] = [];
  if (hasOrganizationIds) {
    const canonicalIds = strictStringArray(value.organizationIds);
    if (canonicalIds === null) return denyAllOrganizationScope();
    organizationIds = canonicalIds;
    if (organizationIds.length === 0 && hasLegacyOrgUnitIds) {
      const legacyIds = strictStringArray(value.orgUnitIds);
      if (legacyIds === null) return denyAllOrganizationScope();
      organizationIds = legacyIds;
    }
  } else if (hasLegacyOrgUnitIds) {
    organizationIds = strictStringArray(value.orgUnitIds) ?? [];
  }

  return {
    organizationIds,
    includeDescendants: value.includeDescendants === true || value.includeChildren === true,
  };
}

function readPermissionScope(value: Prisma.JsonValue): {
  readonly projectIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly permissionLabels: readonly string[];
  readonly permissionActions: readonly string[];
} {
  if (!isRecord(value)) {
    return {
      projectIds: [],
      taskIds: [],
      permissionLabels: [],
      permissionActions: [],
    };
  }
  return {
    projectIds: strictStringArray(value.projectIds) ?? [],
    taskIds: strictStringArray(value.taskIds) ?? [],
    permissionLabels: strictStringArray(value.dataLabels) ?? [],
    permissionActions: strictStringArray(value.actions) ?? [],
  };
}

function denyAllOrganizationScope(): BusinessSemanticOrganizationScope {
  return {
    organizationIds: [],
    includeDescendants: false,
  };
}

function strictStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    return null;
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
