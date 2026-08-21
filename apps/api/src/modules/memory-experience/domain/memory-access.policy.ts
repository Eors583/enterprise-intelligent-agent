import type { MemoryRecord, MemoryScope, MemoryStatus } from '@enterprise/contracts';

export type MemoryAccessOperation = 'READ' | 'CREATE' | 'TRANSITION' | 'GOVERN';

export interface TrustedMemoryAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly roleTemplateId: string;
  readonly roleVersionId: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly employmentStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  readonly orgUnitStatus: 'ACTIVE' | 'ARCHIVED';
  readonly roleVersionStatus: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export interface TrustedMemoryGrant {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly scope: MemoryScope | 'GOVERNANCE';
  readonly roleAssignmentId: string | null;
  readonly roleTemplateId: string | null;
  readonly roleVersionId: string | null;
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly permissionLabels: readonly string[];
  readonly assignment: TrustedMemoryAssignment | null;
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export interface TrustedMemoryAccessContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly operation: MemoryAccessOperation;
  readonly purpose: string | null;
  readonly grants: readonly TrustedMemoryGrant[];
  readonly now: Date;
}

export interface MemoryAccessResource extends Pick<
  MemoryRecord,
  | 'tenantId'
  | 'scope'
  | 'status'
  | 'ownerUserId'
  | 'roleTemplateId'
  | 'roleVersionId'
  | 'roleAssignmentId'
  | 'taskId'
  | 'conversationId'
  | 'permissionLabels'
  | 'consent'
  | 'effectiveFrom'
  | 'effectiveTo'
  | 'expiresAt'
> {}

export type MemoryAccessDenialReason =
  | 'INVALID_CONTEXT'
  | 'TENANT_MISMATCH'
  | 'INACTIVE_MEMORY'
  | 'OUTSIDE_EFFECTIVE_WINDOW'
  | 'CONSENT_PURPOSE_MISMATCH'
  | 'NO_EXACT_SCOPE_GRANT'
  | 'LABEL_SCOPE_MISMATCH';

export type MemoryAccessDecision =
  | {
      readonly allowed: true;
      readonly grantId: string;
    }
  | {
      readonly allowed: false;
      readonly reason: MemoryAccessDenialReason;
    };

const READABLE_STATUSES = new Set<MemoryStatus>(['ACTIVE', 'SEALED']);
const GOVERNABLE_STATUSES = new Set<MemoryStatus>(['CANDIDATE', 'ACTIVE', 'ARCHIVED', 'SEALED']);

export function decideMemoryAccess(
  context: TrustedMemoryAccessContext,
  resource: MemoryAccessResource,
): MemoryAccessDecision {
  if (
    context.userId.length === 0 ||
    context.tenantId.length === 0 ||
    !Number.isFinite(context.now.getTime())
  ) {
    return deny('INVALID_CONTEXT');
  }
  if (resource.tenantId !== context.tenantId) {
    return deny('TENANT_MISMATCH');
  }
  if (!statusAllowed(context.operation, resource.status)) {
    return deny('INACTIVE_MEMORY');
  }
  if (
    !insideWindow(resource.effectiveFrom, resource.effectiveTo, resource.expiresAt, context.now)
  ) {
    return deny('OUTSIDE_EFFECTIVE_WINDOW');
  }
  if (
    resource.scope === 'EMPLOYEE_PRIVATE' &&
    (resource.ownerUserId !== context.userId ||
      resource.consent.grantedByUserId !== context.userId ||
      resource.consent.purpose === null ||
      normalizePurpose(resource.consent.purpose) !== normalizePurpose(context.purpose))
  ) {
    return deny('CONSENT_PURPOSE_MISMATCH');
  }

  let foundExactScope = false;
  for (const grant of context.grants) {
    if (!grantUsable(grant, context)) continue;
    if (!grantMatchesResource(grant, resource, context)) continue;
    foundExactScope = true;
    if (labelsCoveredBySingleGrant(resource.permissionLabels, grant.permissionLabels)) {
      return { allowed: true, grantId: grant.id };
    }
  }
  return deny(foundExactScope ? 'LABEL_SCOPE_MISMATCH' : 'NO_EXACT_SCOPE_GRANT');
}

function statusAllowed(operation: MemoryAccessOperation, status: MemoryStatus): boolean {
  if (operation === 'CREATE') return status === 'CANDIDATE';
  if (operation === 'GOVERN') return GOVERNABLE_STATUSES.has(status);
  if (operation === 'TRANSITION') return status !== 'DELETED';
  return READABLE_STATUSES.has(status);
}

function grantUsable(grant: TrustedMemoryGrant, context: TrustedMemoryAccessContext): boolean {
  if (
    grant.tenantId !== context.tenantId ||
    grant.userId !== context.userId ||
    !insideWindow(grant.effectiveFrom, grant.effectiveTo, null, context.now)
  ) {
    return false;
  }
  if (grant.assignment === null) return grant.roleAssignmentId === null;
  const assignment = grant.assignment;
  return (
    assignment.id === grant.roleAssignmentId &&
    assignment.tenantId === context.tenantId &&
    assignment.userId === context.userId &&
    assignment.roleTemplateId === grant.roleTemplateId &&
    assignment.roleVersionId === grant.roleVersionId &&
    assignment.status === 'ACTIVE' &&
    assignment.employmentStatus === 'ACTIVE' &&
    assignment.orgUnitStatus === 'ACTIVE' &&
    (assignment.roleVersionStatus === 'PUBLISHED' || assignment.roleVersionStatus === 'RETIRED') &&
    insideWindow(assignment.effectiveFrom, assignment.effectiveTo, null, context.now)
  );
}

function grantMatchesResource(
  grant: TrustedMemoryGrant,
  resource: MemoryAccessResource,
  context: TrustedMemoryAccessContext,
): boolean {
  if (grant.scope === 'GOVERNANCE') {
    return context.operation === 'GOVERN' && resource.scope !== 'EMPLOYEE_PRIVATE';
  }
  if (grant.scope !== resource.scope) return false;
  switch (resource.scope) {
    case 'ENTERPRISE':
      return (
        grant.roleAssignmentId === null &&
        grant.roleTemplateId === null &&
        grant.roleVersionId === null &&
        grant.taskId === null &&
        grant.conversationId === null
      );
    case 'ROLE':
      return (
        grant.assignment !== null &&
        grant.roleTemplateId === resource.roleTemplateId &&
        grant.roleVersionId === resource.roleVersionId &&
        resource.roleAssignmentId === null &&
        resource.taskId === null &&
        resource.conversationId === null
      );
    case 'EMPLOYEE_PRIVATE':
      return (
        grant.assignment !== null &&
        resource.ownerUserId === context.userId &&
        grant.roleAssignmentId === resource.roleAssignmentId &&
        grant.roleTemplateId === resource.roleTemplateId &&
        grant.roleVersionId === resource.roleVersionId &&
        resource.taskId === null &&
        resource.conversationId === null
      );
    case 'TASK':
      return (
        grant.taskId === resource.taskId &&
        resource.taskId !== null &&
        grant.conversationId === null
      );
    case 'CONVERSATION':
      return (
        grant.conversationId === resource.conversationId &&
        resource.conversationId !== null &&
        grant.taskId === null
      );
  }
}

function labelsCoveredBySingleGrant(
  required: readonly string[],
  available: readonly string[],
): boolean {
  const grantLabels = new Set(available);
  return grantLabels.has('*') || required.every((label) => grantLabels.has(label));
}

function insideWindow(
  effectiveFrom: Date | string,
  effectiveTo: Date | string | null,
  expiresAt: Date | string | null,
  now: Date,
): boolean {
  const start = timestamp(effectiveFrom);
  const end = timestamp(effectiveTo);
  const expiry = timestamp(expiresAt);
  const current = now.getTime();
  return (
    start !== null &&
    start <= current &&
    (effectiveTo === null || (end !== null && end > current)) &&
    (expiresAt === null || (expiry !== null && expiry > current))
  );
}

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePurpose(value: string | null): string {
  return value?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US') ?? '';
}

function deny(reason: MemoryAccessDenialReason): MemoryAccessDecision {
  return { allowed: false, reason };
}
