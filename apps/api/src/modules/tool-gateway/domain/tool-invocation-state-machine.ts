import type { ToolInvocationStatus, ToolRiskClass } from '@enterprise/contracts';

export type ToolInvocationCommand =
  | 'DENY'
  | 'REQUEST_CONFIRMATION'
  | 'CONFIRM'
  | 'REQUEST_APPROVAL'
  | 'APPROVE'
  | 'REJECT'
  | 'START'
  | 'SUCCEED'
  | 'FAIL'
  | 'MARK_UNKNOWN'
  | 'CANCEL_CONFIRMED'
  | 'BEGIN_COMPENSATION'
  | 'COMPLETE_COMPENSATION'
  | 'FAIL_COMPENSATION';

export interface TrustedToolTransitionRoleAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  readonly employmentActive: boolean;
  readonly orgUnitActive: boolean;
  readonly roleVersionStatus: 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED';
  readonly permissionActions: readonly string[];
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

export interface TrustedToolTransitionActor {
  readonly type: 'USER' | 'SYSTEM' | 'PROVIDER';
  readonly tenantId: string;
  readonly userId: string | null;
  readonly servicePrincipalId: string | null;
  readonly roleAssignment: TrustedToolTransitionRoleAssignment | null;
  readonly capabilityActions: readonly string[];
}

export interface TrustedToolPolicyTransitionProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly riskClass: ToolRiskClass;
  readonly dryRun: boolean;
  readonly decision: 'DENY' | 'REQUIRE_CONFIRMATION' | 'REQUIRE_APPROVAL' | 'ALLOW';
}

export interface TrustedToolConfirmationTransitionProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly requesterUserId: string;
  readonly requesterRoleAssignmentId: string;
  readonly confirmed: boolean;
}

export interface TrustedToolApprovalTransitionProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly approverUserId: string;
  readonly approverRoleAssignmentId: string;
  readonly actorType: 'USER' | 'AGENT' | 'SYSTEM';
  readonly decision: 'APPROVED' | 'REJECTED';
}

export interface TrustedToolProviderTransitionProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly inputHash: string;
  readonly providerRequestId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
}

export interface TrustedToolCompensationTransitionProof {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly toolVersionId: string;
  readonly inputHash: string;
  readonly compensationInvocationId: string;
  readonly compensationToolVersionId: string;
  readonly compensationInputHash: string;
  readonly originalProviderRequestId: string;
  readonly originalOutputHash: string;
  readonly compensationReceiptHash: string | null;
  readonly authorizedCommand: 'BEGIN_COMPENSATION' | 'COMPLETE_COMPENSATION' | 'FAIL_COMPENSATION';
}

export interface ToolInvocationTransitionInput {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly inputHash: string;
  readonly policyDecisionId: string;
  readonly dryRun: boolean;
  readonly status: ToolInvocationStatus;
  readonly command: ToolInvocationCommand;
  readonly riskClass: ToolRiskClass;
  readonly requesterUserId: string;
  readonly requesterRoleAssignmentId: string;
  readonly approvalPermissionAction?: string;
  readonly actor: TrustedToolTransitionActor;
  readonly policyProof?: TrustedToolPolicyTransitionProof | null;
  readonly confirmationProof?: TrustedToolConfirmationTransitionProof | null;
  readonly approvalProof?: TrustedToolApprovalTransitionProof | null;
  readonly providerProof?: TrustedToolProviderTransitionProof | null;
  readonly compensationProof?: TrustedToolCompensationTransitionProof | null;
  readonly now: Date;
}

export interface ToolInvocationTransitionDecision {
  readonly allowed: boolean;
  readonly nextStatus: ToolInvocationStatus;
  readonly reasonCode:
    | 'ALLOW'
    | 'ACTOR_CAPABILITY_DENIED'
    | 'ACTOR_NOT_TRUSTED'
    | 'APPROVER_NOT_INDEPENDENT'
    | 'APPROVAL_PROOF_INVALID'
    | 'CANCELLATION_ACTOR_DENIED'
    | 'COMPENSATION_PROOF_INVALID'
    | 'CONFIRMATION_ACTOR_MISMATCH'
    | 'CONFIRMATION_PROOF_INVALID'
    | 'INVALID_TRANSITION'
    | 'POLICY_PROOF_INVALID'
    | 'PROVIDER_PROOF_INVALID';
}

export function decideToolInvocationTransition(
  input: ToolInvocationTransitionInput,
): ToolInvocationTransitionDecision {
  if (!actorIsTrusted(input.actor, input.tenantId, input.now)) {
    return deny(input.status, 'ACTOR_NOT_TRUSTED');
  }

  if (!commandMatchesRiskPhase(input)) {
    return deny(input.status, 'INVALID_TRANSITION');
  }

  if (['DENY', 'REQUEST_CONFIRMATION', 'REQUEST_APPROVAL', 'START'].includes(input.command)) {
    if (
      input.actor.type !== 'SYSTEM' ||
      !hasActorCapability(input.actor, 'tool.policy.transition') ||
      !policyProofMatchesCommand(input)
    ) {
      return deny(input.status, 'POLICY_PROOF_INVALID');
    }
    if (input.command === 'REQUEST_APPROVAL' && !confirmationProofMatches(input)) {
      return deny(input.status, 'CONFIRMATION_PROOF_INVALID');
    }
  }

  if (input.command === 'CONFIRM') {
    if (
      input.actor.type !== 'USER' ||
      input.actor.userId !== input.requesterUserId ||
      input.actor.roleAssignment?.id !== input.requesterRoleAssignmentId
    ) {
      return deny(input.status, 'CONFIRMATION_ACTOR_MISMATCH');
    }
    if (!confirmationProofMatches(input)) {
      return deny(input.status, 'CONFIRMATION_PROOF_INVALID');
    }
  }

  if (input.command === 'APPROVE' || input.command === 'REJECT') {
    const assignment = input.actor.roleAssignment;
    const approvalPermissionAction = input.approvalPermissionAction;
    if (
      input.actor.type !== 'USER' ||
      input.actor.userId === input.requesterUserId ||
      assignment === null ||
      assignment.id === input.requesterRoleAssignmentId ||
      approvalPermissionAction === undefined ||
      !/^tool\.approve:[a-z][a-z0-9_.-]{2,99}$/u.test(approvalPermissionAction) ||
      !hasAction(assignment.permissionActions, approvalPermissionAction)
    ) {
      return deny(input.status, 'APPROVER_NOT_INDEPENDENT');
    }
    if (!approvalProofMatches(input)) {
      return deny(input.status, 'APPROVAL_PROOF_INVALID');
    }
  }

  if (['SUCCEED', 'FAIL', 'MARK_UNKNOWN'].includes(input.command)) {
    if (
      !['SYSTEM', 'PROVIDER'].includes(input.actor.type) ||
      !hasActorCapability(input.actor, 'tool.provider.transition') ||
      !providerProofMatches(input)
    ) {
      return deny(input.status, 'PROVIDER_PROOF_INVALID');
    }
  }

  if (input.command === 'CANCEL_CONFIRMED') {
    if (input.status === 'EXECUTING') {
      if (
        !['SYSTEM', 'PROVIDER'].includes(input.actor.type) ||
        !hasActorCapability(input.actor, 'tool.provider.transition') ||
        !providerProofMatches(input)
      ) {
        return deny(input.status, 'PROVIDER_PROOF_INVALID');
      }
    } else if (
      input.actor.type !== 'SYSTEM' &&
      !(
        input.actor.type === 'USER' &&
        input.actor.userId === input.requesterUserId &&
        input.actor.roleAssignment?.id === input.requesterRoleAssignmentId
      )
    ) {
      return deny(input.status, 'CANCELLATION_ACTOR_DENIED');
    } else if (input.actor.type === 'SYSTEM' && !hasActorCapability(input.actor, 'tool.cancel')) {
      return deny(input.status, 'ACTOR_CAPABILITY_DENIED');
    }
  }

  if (
    ['BEGIN_COMPENSATION', 'COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'].includes(input.command) &&
    (input.actor.type !== 'SYSTEM' ||
      !hasActorCapability(input.actor, 'tool.compensate') ||
      !compensationProofMatches(input))
  ) {
    return deny(input.status, 'COMPENSATION_PROOF_INVALID');
  }

  const nextStatus = transition(input);
  return nextStatus === null
    ? deny(input.status, 'INVALID_TRANSITION')
    : { allowed: true, nextStatus, reasonCode: 'ALLOW' };
}

function transition(input: ToolInvocationTransitionInput): ToolInvocationStatus | null {
  const key = `${input.status}:${input.command}`;
  const direct: Partial<Record<string, ToolInvocationStatus>> = {
    'REQUESTED:DENY': 'POLICY_DENIED',
    'REQUESTED:REQUEST_CONFIRMATION': 'PENDING_CONFIRMATION',
    'REQUESTED:REQUEST_APPROVAL': 'PENDING_APPROVAL',
    'REQUESTED:START': 'APPROVED',
    'PENDING_APPROVAL:APPROVE': 'APPROVED',
    'PENDING_APPROVAL:REJECT': 'REJECTED',
    'APPROVED:START': 'EXECUTING',
    'EXECUTING:SUCCEED': 'SUCCEEDED',
    'EXECUTING:FAIL': 'FAILED',
    'EXECUTING:MARK_UNKNOWN': 'UNKNOWN',
    'UNKNOWN:SUCCEED': 'SUCCEEDED',
    'UNKNOWN:FAIL': 'FAILED',
    'PENDING_CONFIRMATION:CANCEL_CONFIRMED': 'CANCELLED',
    'PENDING_APPROVAL:CANCEL_CONFIRMED': 'CANCELLED',
    'APPROVED:CANCEL_CONFIRMED': 'CANCELLED',
    'EXECUTING:CANCEL_CONFIRMED': 'CANCELLED',
    'SUCCEEDED:BEGIN_COMPENSATION': 'COMPENSATING',
    'COMPENSATING:COMPLETE_COMPENSATION': 'COMPENSATED',
    'COMPENSATING:FAIL_COMPENSATION': 'COMPENSATION_FAILED',
  };
  if (key === 'PENDING_CONFIRMATION:CONFIRM') {
    return input.riskClass === 'HIGH_RISK_APPROVAL' ? 'PENDING_APPROVAL' : 'APPROVED';
  }
  return direct[key] ?? null;
}

function commandMatchesRiskPhase(input: ToolInvocationTransitionInput): boolean {
  if (input.riskClass === 'FORBIDDEN') return input.command === 'DENY';
  if (input.command === 'REQUEST_CONFIRMATION' || input.command === 'CONFIRM') {
    return input.riskClass === 'CONFIRM_REQUIRED' || input.riskClass === 'HIGH_RISK_APPROVAL';
  }
  if (
    input.command === 'REQUEST_APPROVAL' ||
    input.command === 'APPROVE' ||
    input.command === 'REJECT'
  ) {
    return input.riskClass === 'HIGH_RISK_APPROVAL';
  }
  if (input.command === 'START' && input.status === 'REQUESTED') {
    return input.riskClass === 'READ_ONLY' || input.riskClass === 'DRAFT_ONLY';
  }
  return true;
}

function actorIsTrusted(actor: TrustedToolTransitionActor, tenantId: string, now: Date): boolean {
  if (actor.tenantId !== tenantId || !Number.isFinite(now.getTime())) return false;
  if (actor.type === 'SYSTEM' || actor.type === 'PROVIDER') {
    return (
      actor.userId === null &&
      actor.roleAssignment === null &&
      actor.servicePrincipalId !== null &&
      actor.servicePrincipalId.trim().length > 0
    );
  }
  const assignment = actor.roleAssignment;
  const start = assignment === null ? null : time(assignment.effectiveFrom);
  const end = assignment?.effectiveTo === null ? null : time(assignment?.effectiveTo ?? null);
  return (
    actor.userId !== null &&
    actor.servicePrincipalId === null &&
    assignment !== null &&
    assignment.tenantId === tenantId &&
    assignment.userId === actor.userId &&
    assignment.status === 'ACTIVE' &&
    assignment.employmentActive &&
    assignment.orgUnitActive &&
    (assignment.roleVersionStatus === 'PUBLISHED' || assignment.roleVersionStatus === 'RETIRED') &&
    start !== null &&
    start <= now.getTime() &&
    (assignment.effectiveTo === null || (end !== null && end > now.getTime()))
  );
}

function hasActorCapability(actor: TrustedToolTransitionActor, capability: string): boolean {
  return (
    actor.capabilityActions.includes(capability) ||
    actor.capabilityActions.includes('tool.*') ||
    actor.capabilityActions.includes('*')
  );
}

function hasAction(actions: readonly string[], action: string): boolean {
  const baseAction = action.split(':', 1)[0];
  return (
    actions.includes(action) ||
    (baseAction !== undefined && actions.includes(baseAction)) ||
    actions.includes('tool.*') ||
    actions.includes('*')
  );
}

function policyProofMatchesCommand(input: ToolInvocationTransitionInput): boolean {
  const proof = input.policyProof;
  if (
    proof === undefined ||
    proof === null ||
    !baseProofMatches(input, proof) ||
    proof.policyDecisionId !== input.policyDecisionId ||
    proof.riskClass !== input.riskClass ||
    proof.dryRun !== input.dryRun
  ) {
    return false;
  }
  const expected: Partial<
    Record<ToolInvocationCommand, TrustedToolPolicyTransitionProof['decision']>
  > = {
    DENY: 'DENY',
    REQUEST_CONFIRMATION: 'REQUIRE_CONFIRMATION',
    REQUEST_APPROVAL: 'REQUIRE_APPROVAL',
    START: 'ALLOW',
  };
  return proof.decision === expected[input.command];
}

function confirmationProofMatches(input: ToolInvocationTransitionInput): boolean {
  const proof = input.confirmationProof;
  return (
    proof !== undefined &&
    proof !== null &&
    proof.confirmed &&
    baseProofMatches(input, proof) &&
    proof.policyDecisionId === input.policyDecisionId &&
    proof.requesterUserId === input.requesterUserId &&
    proof.requesterRoleAssignmentId === input.requesterRoleAssignmentId
  );
}

function approvalProofMatches(input: ToolInvocationTransitionInput): boolean {
  const proof = input.approvalProof;
  const expectedDecision = input.command === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  return (
    proof !== undefined &&
    proof !== null &&
    proof.actorType === 'USER' &&
    proof.decision === expectedDecision &&
    baseProofMatches(input, proof) &&
    proof.policyDecisionId === input.policyDecisionId &&
    proof.approverUserId === input.actor.userId &&
    proof.approverRoleAssignmentId === input.actor.roleAssignment?.id
  );
}

function providerProofMatches(input: ToolInvocationTransitionInput): boolean {
  const proof = input.providerProof;
  const expected: Partial<
    Record<ToolInvocationCommand, TrustedToolProviderTransitionProof['outcome']>
  > = {
    SUCCEED: 'SUCCEEDED',
    FAIL: 'FAILED',
    MARK_UNKNOWN: 'UNKNOWN',
    CANCEL_CONFIRMED: 'CANCELLED',
  };
  return (
    proof !== undefined &&
    proof !== null &&
    proof.providerRequestId.trim().length > 0 &&
    baseProofMatches(input, proof) &&
    proof.outcome === expected[input.command]
  );
}

function compensationProofMatches(input: ToolInvocationTransitionInput): boolean {
  const proof = input.compensationProof;
  const completing =
    input.command === 'COMPLETE_COMPENSATION' || input.command === 'FAIL_COMPENSATION';
  return (
    proof !== undefined &&
    proof !== null &&
    baseProofMatches(input, proof) &&
    proof.compensationInvocationId !== input.invocationId &&
    proof.toolVersionId.trim().length > 0 &&
    proof.compensationToolVersionId.trim().length > 0 &&
    /^[a-f0-9]{64}$/u.test(proof.compensationInputHash) &&
    proof.originalProviderRequestId.trim().length > 0 &&
    /^[a-f0-9]{64}$/u.test(proof.originalOutputHash) &&
    (completing
      ? proof.compensationReceiptHash !== null &&
        /^[a-f0-9]{64}$/u.test(proof.compensationReceiptHash)
      : proof.compensationReceiptHash === null) &&
    proof.authorizedCommand === input.command
  );
}

function baseProofMatches(
  input: ToolInvocationTransitionInput,
  proof: {
    readonly tenantId: string;
    readonly invocationId: string;
    readonly inputHash: string;
  },
): boolean {
  return (
    proof.tenantId === input.tenantId &&
    proof.invocationId === input.invocationId &&
    proof.inputHash === input.inputHash
  );
}

function time(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deny(
  status: ToolInvocationStatus,
  reasonCode: Exclude<ToolInvocationTransitionDecision['reasonCode'], 'ALLOW'>,
): ToolInvocationTransitionDecision {
  return { allowed: false, nextStatus: status, reasonCode };
}
