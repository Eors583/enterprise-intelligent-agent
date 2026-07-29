import type { TenantRole } from '@enterprise/contracts';

export type AuthorizationEffect = 'allow' | 'deny';
export type AuthorizationRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AuthorizationAssignmentStatus =
  'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';

export interface AuthorizationOrganizationScope {
  readonly organizationIds?: readonly string[];
  readonly includeDescendants?: boolean;
}

export interface AuthorizationAssignment {
  readonly id?: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly agentInstanceId?: string;
  readonly status: AuthorizationAssignmentStatus;
  readonly effectiveFrom?: Date | string;
  readonly effectiveTo?: Date | string | null;
  readonly employmentActive?: boolean;
  readonly organizationScope?: AuthorizationOrganizationScope;
  readonly roleTemplateId?: string;
  readonly projectIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly dataLabels?: readonly string[];
  readonly permissionActions?: readonly string[];
}

export interface AuthorizationOrganizationContext {
  readonly resourceOrganizationId?: string | null;
  readonly resourceAncestorOrganizationIds?: readonly string[];
  readonly memberOrganizationIds?: readonly string[];
  readonly allowedOrganizationIds?: readonly string[];
}

export interface AuthorizationProjectContext {
  readonly resourceProjectId?: string | null;
  readonly assignedProjectIds?: readonly string[];
}

export interface AuthorizationDataLabelContext {
  readonly principalLabels?: readonly string[];
  readonly resourceLabels?: readonly string[];
}

export interface AuthorizationTaskContext {
  readonly taskId?: string;
  readonly resourceAgentId?: string;
  readonly resourceOwnerUserId?: string | null;
  readonly resourceVisibility?: 'tenant' | 'owner';
  readonly requesterUserId?: string;
  readonly ownerUserId?: string;
  readonly participantUserIds?: readonly string[];
  readonly enforceActorMembership?: boolean;
  readonly assignmentRequired?: boolean;
  readonly riskApprovalGranted?: boolean;
}

export interface AuthorizationInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly tenantRole: TenantRole;
  readonly action: string;
  readonly resourceTenantId: string;
  readonly assignment?: AuthorizationAssignment | null;
  readonly organization?: AuthorizationOrganizationContext;
  readonly project?: AuthorizationProjectContext;
  readonly dataLabels?: AuthorizationDataLabelContext;
  readonly taskContext?: AuthorizationTaskContext;
  readonly risk: AuthorizationRisk;
}

export type AuthorizationReasonCode =
  | 'ALLOW_ASSIGNED_AGENT'
  | 'ALLOW_MANAGEMENT_ROLE'
  | 'ALLOW_PERSONAL_AGENT'
  | 'ALLOW_TENANT_MEMBER'
  | 'ALLOW_WITH_RESOURCE_FILTERS'
  | 'ACTION_NOT_REGISTERED'
  | 'ASSIGNMENT_ACTION_DENIED'
  | 'ASSIGNMENT_EMPLOYMENT_INACTIVE'
  | 'ASSIGNMENT_EXPIRED'
  | 'ASSIGNMENT_NOT_ACTIVE'
  | 'ASSIGNMENT_NOT_EFFECTIVE'
  | 'ASSIGNMENT_REQUIRED'
  | 'ASSIGNMENT_RESOURCE_MISMATCH'
  | 'ASSIGNMENT_TENANT_MISMATCH'
  | 'ASSIGNMENT_TIME_INVALID'
  | 'ASSIGNMENT_USER_MISMATCH'
  | 'CRITICAL_RISK_DENIED'
  | 'CROSS_TENANT'
  | 'DATA_LABEL_SCOPE_DENIED'
  | 'HIGH_RISK_APPROVAL_REQUIRED'
  | 'INVALID_INPUT'
  | 'MANAGEMENT_ROLE_REQUIRED'
  | 'ORGANIZATION_SCOPE_DENIED'
  | 'PROJECT_SCOPE_DENIED'
  | 'RESOURCE_VISIBILITY_DENIED'
  | 'TASK_CONTEXT_DENIED';

export type AuthorizationObligationType =
  | 'ENFORCE_DATA_LABEL_SCOPE'
  | 'FILTER_ACTIVE_ASSIGNMENTS'
  | 'FILTER_AGENT_VISIBILITY'
  | 'FILTER_ORGANIZATION_SCOPE'
  | 'FILTER_PROJECT_SCOPE'
  | 'FILTER_TASK_SCOPE'
  | 'RECORD_AUDIT_DECISION'
  | 'REQUIRE_RISK_APPROVAL'
  | 'REVALIDATE_ASSIGNMENT'
  | 'REVALIDATE_KNOWLEDGE_ACCESS'
  | 'VERIFY_RESOURCE_MEMBERSHIP';

export interface AuthorizationObligation {
  readonly type: AuthorizationObligationType;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationDecision {
  readonly decisionId: string;
  readonly effect: AuthorizationEffect;
  readonly allowed: boolean;
  readonly reasonCode: AuthorizationReasonCode;
  readonly obligations: readonly AuthorizationObligation[];
  readonly evaluatedAt: string;
}

export type CurrentAuthorizationInput = Omit<
  AuthorizationInput,
  'tenantId' | 'userId' | 'tenantRole'
>;
