import type { ToolRiskClass } from '@enterprise/contracts';

export type ToolPolicyDecisionKind = 'allow' | 'deny' | 'pending';

export type ToolPolicyReasonCode =
  | 'ALLOW_DRY_RUN'
  | 'ALLOW_TOOL_EXECUTION'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_REQUIRED'
  | 'ASSIGNMENT_ACTION_DENIED'
  | 'ASSIGNMENT_INACTIVE'
  | 'ASSIGNMENT_NOT_EFFECTIVE'
  | 'ASSIGNMENT_TASK_SCOPE_DENIED'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_REQUIRED'
  | 'CROSS_TENANT'
  | 'DATA_CLASSIFICATION_DENIED'
  | 'DRY_RUN_UNSUPPORTED'
  | 'EMPLOYMENT_INACTIVE'
  | 'ORG_UNIT_INACTIVE'
  | 'ROLE_VERSION_NOT_USABLE'
  | 'INVALID_INPUT'
  | 'TASK_INACTIVE'
  | 'TASK_MEMBERSHIP_DENIED'
  | 'TOOL_FORBIDDEN'
  | 'TOOL_NOT_EFFECTIVE'
  | 'TOOL_NOT_PUBLISHED';

export interface TrustedToolAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
  readonly employmentActive: boolean;
  readonly orgUnitActive: boolean;
  readonly roleVersionStatus: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
  readonly permissionActions: readonly string[];
  readonly taskIds: readonly string[];
  readonly dataLabels: readonly string[];
  readonly maxDataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
}

export interface TrustedToolTask {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
  readonly participantRoleAssignmentIds: readonly string[];
  readonly reviewerRoleAssignmentIds: readonly string[];
  readonly dataLabels: readonly string[];
}

export interface TrustedToolConfirmation {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly requesterUserId: string;
  readonly requesterRoleAssignmentId: string;
  readonly toolVersionId: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly confirmedAt: Date | string;
  readonly expiresAt: Date | string;
}

export interface TrustedToolApproval {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly approverUserId: string;
  readonly approverActorType: 'USER' | 'AGENT' | 'SYSTEM';
  readonly toolVersionId: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly approvedAt: Date | string;
  readonly expiresAt: Date | string;
  readonly approved: boolean;
  readonly assignment: TrustedToolAssignment;
}

export interface ToolInvocationPolicyInput {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly requesterUserId: string;
  readonly tool: {
    readonly id: string;
    readonly tenantId: string;
    readonly key: string;
    readonly status: string;
    readonly riskClass: ToolRiskClass;
    readonly dataClassification: TrustedToolAssignment['maxDataClassification'];
    readonly dryRunMode: 'NATIVE' | 'VALIDATE_ONLY' | 'UNSUPPORTED';
    readonly effectiveFrom: Date | string;
    readonly effectiveTo: Date | string | null;
  };
  readonly task: TrustedToolTask;
  readonly assignment: TrustedToolAssignment;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly dryRun: boolean;
  readonly confirmation?: TrustedToolConfirmation | null;
  readonly approval?: TrustedToolApproval | null;
  readonly now?: Date;
}

export interface ToolInvocationPolicyDecision {
  readonly kind: ToolPolicyDecisionKind;
  readonly reasonCode: ToolPolicyReasonCode;
  readonly obligations: readonly (
    | 'EXECUTE_THROUGH_GATEWAY_ONLY'
    | 'DO_NOT_DISPATCH_PROVIDER'
    | 'ENFORCE_DRAFT_ONLY_RESULT'
    | 'ENFORCE_NATIVE_DRY_RUN'
    | 'PERSIST_AUDIT_AND_OUTBOX'
    | 'REQUIRE_INDEPENDENT_APPROVAL'
    | 'REQUIRE_REQUESTER_CONFIRMATION'
    | 'RESOLVE_AND_PIN_PUBLIC_IP'
    | 'VALIDATE_INPUT_SCHEMA'
    | 'VALIDATE_OUTPUT_SCHEMA'
  )[];
}

const ACTIVE_TASK_STATUSES = new Set(['READY', 'IN_PROGRESS']);
const CLASSIFICATION_RANK = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
} as const;

export function decideToolInvocationPolicy(
  input: ToolInvocationPolicyInput,
): ToolInvocationPolicyDecision {
  const now = input.now ?? new Date();
  if (
    !nonEmpty(input.tenantId) ||
    !nonEmpty(input.invocationId) ||
    !nonEmpty(input.requesterUserId) ||
    !nonEmpty(input.tool.id) ||
    !nonEmpty(input.task.id) ||
    !/^[a-f0-9]{64}$/u.test(input.inputHash) ||
    !nonEmpty(input.policyDecisionId)
  ) {
    return deny('INVALID_INPUT');
  }
  if (
    input.tool.tenantId !== input.tenantId ||
    input.task.tenantId !== input.tenantId ||
    input.assignment.tenantId !== input.tenantId
  ) {
    return deny('CROSS_TENANT');
  }
  if (input.tool.status !== 'PUBLISHED') return deny('TOOL_NOT_PUBLISHED');
  if (!isEffective(input.tool.effectiveFrom, input.tool.effectiveTo, now)) {
    return deny('TOOL_NOT_EFFECTIVE');
  }
  if (input.tool.riskClass === 'FORBIDDEN') return deny('TOOL_FORBIDDEN');
  if (!input.assignment.employmentActive) return deny('EMPLOYMENT_INACTIVE');
  if (!input.assignment.orgUnitActive) return deny('ORG_UNIT_INACTIVE');
  if (
    input.assignment.roleVersionStatus !== 'PUBLISHED' &&
    input.assignment.roleVersionStatus !== 'RETIRED'
  ) {
    return deny('ROLE_VERSION_NOT_USABLE');
  }
  if (input.assignment.status !== 'ACTIVE') return deny('ASSIGNMENT_INACTIVE');
  if (!isEffective(input.assignment.effectiveFrom, input.assignment.effectiveTo, now)) {
    return deny('ASSIGNMENT_NOT_EFFECTIVE');
  }
  if (input.assignment.userId !== input.requesterUserId) {
    return deny('ASSIGNMENT_INACTIVE');
  }
  if (!hasAction(input.assignment.permissionActions, 'tool.invoke', input.tool.key)) {
    return deny('ASSIGNMENT_ACTION_DENIED');
  }
  if (input.assignment.taskIds.length === 0 || !input.assignment.taskIds.includes(input.task.id)) {
    return deny('ASSIGNMENT_TASK_SCOPE_DENIED');
  }
  if (!ACTIVE_TASK_STATUSES.has(input.task.status)) return deny('TASK_INACTIVE');
  if (!input.task.participantRoleAssignmentIds.includes(input.assignment.id)) {
    return deny('TASK_MEMBERSHIP_DENIED');
  }
  if (
    CLASSIFICATION_RANK[input.tool.dataClassification] >
      CLASSIFICATION_RANK[input.assignment.maxDataClassification] ||
    input.task.dataLabels.some((label) => !input.assignment.dataLabels.includes(label))
  ) {
    return deny('DATA_CLASSIFICATION_DENIED');
  }

  if (input.dryRun && input.tool.dryRunMode === 'UNSUPPORTED') {
    return deny('DRY_RUN_UNSUPPORTED');
  }

  if (
    input.tool.riskClass === 'CONFIRM_REQUIRED' ||
    input.tool.riskClass === 'HIGH_RISK_APPROVAL'
  ) {
    if (input.confirmation === undefined || input.confirmation === null) {
      return pending('CONFIRMATION_REQUIRED', ['REQUIRE_REQUESTER_CONFIRMATION']);
    }
    if (!isValidConfirmation(input, input.confirmation, now)) {
      return deny('CONFIRMATION_INVALID');
    }
  }

  if (input.tool.riskClass === 'HIGH_RISK_APPROVAL') {
    if (input.approval === undefined || input.approval === null) {
      return pending('APPROVAL_REQUIRED', ['REQUIRE_INDEPENDENT_APPROVAL']);
    }
    if (!isValidApproval(input, input.approval, now)) {
      return deny('APPROVAL_INVALID');
    }
  }
  if (input.dryRun) {
    const dryRunMode = input.tool.dryRunMode;
    if (dryRunMode === 'UNSUPPORTED') return deny('DRY_RUN_UNSUPPORTED');
    return allowDryRun(dryRunMode);
  }
  return allowExecution(input.tool.riskClass);
}

function isValidConfirmation(
  input: ToolInvocationPolicyInput,
  confirmation: TrustedToolConfirmation,
  now: Date,
): boolean {
  return (
    confirmation.invocationId === input.invocationId &&
    confirmation.tenantId === input.tenantId &&
    confirmation.requesterUserId === input.requesterUserId &&
    confirmation.requesterRoleAssignmentId === input.assignment.id &&
    confirmation.toolVersionId === input.tool.id &&
    confirmation.taskId === input.task.id &&
    confirmation.inputHash === input.inputHash &&
    confirmation.policyDecisionId === input.policyDecisionId &&
    isFreshProof(confirmation.confirmedAt, confirmation.expiresAt, now)
  );
}

function isValidApproval(
  input: ToolInvocationPolicyInput,
  approval: TrustedToolApproval,
  now: Date,
): boolean {
  const assignment = approval.assignment;
  return (
    approval.approved &&
    approval.invocationId === input.invocationId &&
    approval.tenantId === input.tenantId &&
    approval.approverActorType === 'USER' &&
    approval.approverUserId !== input.requesterUserId &&
    approval.toolVersionId === input.tool.id &&
    approval.taskId === input.task.id &&
    approval.inputHash === input.inputHash &&
    approval.policyDecisionId === input.policyDecisionId &&
    isFreshProof(approval.approvedAt, approval.expiresAt, now) &&
    input.confirmation !== undefined &&
    input.confirmation !== null &&
    time(approval.approvedAt) !== null &&
    time(input.confirmation.confirmedAt) !== null &&
    time(approval.approvedAt)! >= time(input.confirmation.confirmedAt)! &&
    assignment.tenantId === input.tenantId &&
    assignment.userId === approval.approverUserId &&
    assignment.userId !== input.assignment.userId &&
    assignment.id !== input.assignment.id &&
    assignment.status === 'ACTIVE' &&
    assignment.employmentActive &&
    assignment.orgUnitActive &&
    (assignment.roleVersionStatus === 'PUBLISHED' || assignment.roleVersionStatus === 'RETIRED') &&
    isEffective(assignment.effectiveFrom, assignment.effectiveTo, now) &&
    assignment.taskIds.includes(input.task.id) &&
    input.task.reviewerRoleAssignmentIds.includes(assignment.id) &&
    hasAction(assignment.permissionActions, 'tool.approve', input.tool.key) &&
    CLASSIFICATION_RANK[input.tool.dataClassification] <=
      CLASSIFICATION_RANK[assignment.maxDataClassification] &&
    input.task.dataLabels.every((label) => assignment.dataLabels.includes(label))
  );
}

function hasAction(actions: readonly string[], baseAction: string, toolKey: string): boolean {
  return (
    actions.includes(baseAction) ||
    actions.includes(`${baseAction}:${toolKey}`) ||
    actions.includes('tool.*') ||
    actions.includes('*')
  );
}

function isEffective(
  effectiveFrom: Date | string,
  effectiveTo: Date | string | null,
  now: Date,
): boolean {
  const start = toTime(effectiveFrom);
  const end = effectiveTo === null ? null : toTime(effectiveTo);
  return start !== null && start <= now.getTime() && end !== null
    ? now.getTime() < end
    : start !== null && start <= now.getTime() && effectiveTo === null;
}

function toTime(value: Date | string): number | null {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function time(value: Date | string): number | null {
  return toTime(value);
}

function isFreshProof(issuedAt: Date | string, expiresAt: Date | string, now: Date): boolean {
  const issued = toTime(issuedAt);
  const expires = toTime(expiresAt);
  return (
    Number.isFinite(now.getTime()) &&
    issued !== null &&
    expires !== null &&
    issued <= now.getTime() &&
    now.getTime() < expires &&
    expires > issued
  );
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function deny(reasonCode: ToolPolicyReasonCode): ToolInvocationPolicyDecision {
  return { kind: 'deny', reasonCode, obligations: ['PERSIST_AUDIT_AND_OUTBOX'] };
}

function pending(
  reasonCode: ToolPolicyReasonCode,
  obligations: ToolInvocationPolicyDecision['obligations'],
): ToolInvocationPolicyDecision {
  return {
    kind: 'pending',
    reasonCode,
    obligations: ['PERSIST_AUDIT_AND_OUTBOX', ...obligations],
  };
}

function allowDryRun(
  mode: Exclude<ToolInvocationPolicyInput['tool']['dryRunMode'], 'UNSUPPORTED'>,
): ToolInvocationPolicyDecision {
  return {
    kind: 'allow',
    reasonCode: 'ALLOW_DRY_RUN',
    obligations:
      mode === 'VALIDATE_ONLY'
        ? ['VALIDATE_INPUT_SCHEMA', 'DO_NOT_DISPATCH_PROVIDER', 'PERSIST_AUDIT_AND_OUTBOX']
        : [
            'VALIDATE_INPUT_SCHEMA',
            'EXECUTE_THROUGH_GATEWAY_ONLY',
            'ENFORCE_NATIVE_DRY_RUN',
            'RESOLVE_AND_PIN_PUBLIC_IP',
            'VALIDATE_OUTPUT_SCHEMA',
            'PERSIST_AUDIT_AND_OUTBOX',
          ],
  };
}

function allowExecution(riskClass: ToolRiskClass): ToolInvocationPolicyDecision {
  return {
    kind: 'allow',
    reasonCode: 'ALLOW_TOOL_EXECUTION',
    obligations: [
      'VALIDATE_INPUT_SCHEMA',
      'EXECUTE_THROUGH_GATEWAY_ONLY',
      'RESOLVE_AND_PIN_PUBLIC_IP',
      'VALIDATE_OUTPUT_SCHEMA',
      ...(riskClass === 'DRAFT_ONLY' ? (['ENFORCE_DRAFT_ONLY_RESULT'] as const) : []),
      'PERSIST_AUDIT_AND_OUTBOX',
    ],
  };
}
