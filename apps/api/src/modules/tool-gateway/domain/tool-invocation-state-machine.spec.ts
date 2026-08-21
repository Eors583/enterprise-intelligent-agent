import { describe, expect, it } from 'vitest';

import {
  decideToolInvocationTransition,
  type ToolInvocationTransitionInput,
} from './tool-invocation-state-machine.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const REQUESTER = '00000000-0000-7000-8000-000000000002';
const APPROVER = '00000000-0000-7000-8000-000000000003';
const REQUESTER_ASSIGNMENT = '00000000-0000-7000-8000-000000000004';
const APPROVER_ASSIGNMENT = '00000000-0000-7000-8000-000000000005';
const INVOCATION_ID = '00000000-0000-7000-8000-000000000006';
const TOOL_VERSION_ID = '00000000-0000-7000-8000-000000000007';
const COMPENSATION_INVOCATION_ID = '00000000-0000-7000-8000-000000000008';
const COMPENSATION_TOOL_VERSION_ID = '00000000-0000-7000-8000-000000000009';
const INPUT_HASH = 'a'.repeat(64);
const COMPENSATION_INPUT_HASH = 'b'.repeat(64);
const OUTPUT_HASH = 'c'.repeat(64);
const POLICY_DECISION_ID = 'policy-decision-1';

describe('Tool Invocation state machine', () => {
  it('routes a bound high-risk confirmation into independent approval', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_CONFIRMATION',
          command: 'CONFIRM',
          riskClass: 'HIGH_RISK_APPROVAL',
          actor: userActor(REQUESTER, REQUESTER_ASSIGNMENT),
          confirmationProof: confirmationProof(),
        }),
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'PENDING_APPROVAL' });
  });

  it('does not let another user confirm or replay another invocation proof', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_CONFIRMATION',
          command: 'CONFIRM',
          actor: userActor(APPROVER, APPROVER_ASSIGNMENT),
          confirmationProof: confirmationProof(),
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'CONFIRMATION_ACTOR_MISMATCH' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_CONFIRMATION',
          command: 'CONFIRM',
          actor: userActor(REQUESTER, REQUESTER_ASSIGNMENT),
          confirmationProof: {
            ...confirmationProof(),
            invocationId: '00000000-0000-7000-8000-000000000099',
          },
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'CONFIRMATION_PROOF_INVALID' });
  });

  it('requires a bound independent human approval proof', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_APPROVAL',
          command: 'APPROVE',
          riskClass: 'HIGH_RISK_APPROVAL',
          actor: userActor(REQUESTER, APPROVER_ASSIGNMENT),
          approvalProof: approvalProof(REQUESTER, APPROVER_ASSIGNMENT),
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'APPROVER_NOT_INDEPENDENT' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_APPROVAL',
          command: 'APPROVE',
          riskClass: 'HIGH_RISK_APPROVAL',
          actor: userActor(APPROVER, APPROVER_ASSIGNMENT),
          approvalProof: {
            ...approvalProof(APPROVER, APPROVER_ASSIGNMENT),
            actorType: 'AGENT',
          },
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'APPROVAL_PROOF_INVALID' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_APPROVAL',
          command: 'APPROVE',
          riskClass: 'HIGH_RISK_APPROVAL',
          actor: userActor(APPROVER, APPROVER_ASSIGNMENT),
          approvalProof: approvalProof(APPROVER, APPROVER_ASSIGNMENT),
        }),
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'APPROVED' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_APPROVAL',
          command: 'APPROVE',
          riskClass: 'HIGH_RISK_APPROVAL',
          actor: userActor(APPROVER, APPROVER_ASSIGNMENT, ['tool.approve:crm.customer.read']),
          approvalProof: approvalProof(APPROVER, APPROVER_ASSIGNMENT),
        }),
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'APPROVED' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'PENDING_APPROVAL',
          command: 'APPROVE',
          riskClass: 'HIGH_RISK_APPROVAL',
          actor: userActor(APPROVER, APPROVER_ASSIGNMENT, ['tool.approve:finance.payment.send']),
          approvalProof: approvalProof(APPROVER, APPROVER_ASSIGNMENT),
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'APPROVER_NOT_INDEPENDENT' });
  });

  it('requires a policy proof bound to this invocation before execution', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'APPROVED',
          command: 'START',
          policyProof: { ...policyProof('ALLOW'), inputHash: 'b'.repeat(64) },
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'POLICY_PROOF_INVALID' });
  });

  it('cannot skip required confirmation and approval by presenting an allow proof', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'REQUESTED',
          command: 'START',
          riskClass: 'HIGH_RISK_APPROVAL',
          policyProof: {
            ...policyProof('ALLOW'),
            riskClass: 'HIGH_RISK_APPROVAL',
          },
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'INVALID_TRANSITION' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'REQUESTED',
          command: 'CONFIRM',
          riskClass: 'READ_ONLY',
          actor: userActor(REQUESTER, REQUESTER_ASSIGNMENT),
          confirmationProof: confirmationProof(),
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'INVALID_TRANSITION' });
  });

  it('limits service principals to their declared transition capability', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'EXECUTING',
          command: 'SUCCEED',
          actor: systemActor('unrelated-worker', ['tool.cancel']),
          providerProof: providerProof('SUCCEEDED'),
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'PROVIDER_PROOF_INVALID' });
  });

  it('requires a bound provider outcome and cancellation receipt', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'EXECUTING',
          command: 'SUCCEED',
          actor: systemActor('provider-worker'),
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'PROVIDER_PROOF_INVALID' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'EXECUTING',
          command: 'CANCEL_CONFIRMED',
          actor: systemActor('gateway-worker'),
          providerProof: providerProof('CANCELLED'),
        }),
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'CANCELLED' });
  });

  it('only resolves UNKNOWN through a bound provider success or failure proof', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'UNKNOWN',
          command: 'SUCCEED',
          actor: systemActor('reconciliation-worker'),
          providerProof: providerProof('SUCCEEDED'),
        }),
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'SUCCEEDED' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'UNKNOWN',
          command: 'FAIL',
          actor: systemActor('reconciliation-worker'),
          providerProof: null,
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'PROVIDER_PROOF_INVALID' });
  });

  it('supports compensation only with a bound system authorization', () => {
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'SUCCEEDED',
          command: 'BEGIN_COMPENSATION',
          compensationProof: {
            tenantId: TENANT_ID,
            invocationId: INVOCATION_ID,
            toolVersionId: TOOL_VERSION_ID,
            inputHash: INPUT_HASH,
            compensationInvocationId: COMPENSATION_INVOCATION_ID,
            compensationToolVersionId: COMPENSATION_TOOL_VERSION_ID,
            compensationInputHash: COMPENSATION_INPUT_HASH,
            originalProviderRequestId: 'provider-request-1',
            originalOutputHash: OUTPUT_HASH,
            compensationReceiptHash: null,
            authorizedCommand: 'BEGIN_COMPENSATION',
          },
        }),
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'COMPENSATING' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'SUCCEEDED',
          command: 'BEGIN_COMPENSATION',
          compensationProof: null,
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'COMPENSATION_PROOF_INVALID' });
    expect(
      decideToolInvocationTransition(
        transition({
          status: 'COMPENSATING',
          command: 'COMPLETE_COMPENSATION',
          compensationProof: {
            tenantId: TENANT_ID,
            invocationId: INVOCATION_ID,
            toolVersionId: TOOL_VERSION_ID,
            inputHash: INPUT_HASH,
            compensationInvocationId: COMPENSATION_INVOCATION_ID,
            compensationToolVersionId: COMPENSATION_TOOL_VERSION_ID,
            compensationInputHash: COMPENSATION_INPUT_HASH,
            originalProviderRequestId: 'provider-request-1',
            originalOutputHash: OUTPUT_HASH,
            compensationReceiptHash: null,
            authorizedCommand: 'COMPLETE_COMPENSATION',
          },
        }),
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'COMPENSATION_PROOF_INVALID' });
  });
});

function transition(
  overrides: Partial<ToolInvocationTransitionInput> = {},
): ToolInvocationTransitionInput {
  return {
    tenantId: TENANT_ID,
    invocationId: INVOCATION_ID,
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    dryRun: false,
    status: 'REQUESTED',
    command: 'START',
    riskClass: 'CONFIRM_REQUIRED',
    requesterUserId: REQUESTER,
    requesterRoleAssignmentId: REQUESTER_ASSIGNMENT,
    approvalPermissionAction: 'tool.approve:crm.customer.read',
    actor: systemActor('tool-policy-worker'),
    policyProof: policyProof('ALLOW'),
    confirmationProof: null,
    approvalProof: null,
    providerProof: null,
    compensationProof: null,
    now: new Date('2026-07-28T00:05:00.000Z'),
    ...overrides,
  };
}

function userActor(
  userId: string,
  assignmentId: string,
  permissionActions: readonly string[] = ['tool.approve'],
) {
  return {
    type: 'USER' as const,
    tenantId: TENANT_ID,
    userId,
    servicePrincipalId: null,
    roleAssignment: {
      id: assignmentId,
      tenantId: TENANT_ID,
      userId,
      status: 'ACTIVE' as const,
      employmentActive: true,
      orgUnitActive: true,
      roleVersionStatus: 'PUBLISHED' as const,
      permissionActions,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    },
    capabilityActions: [],
  };
}

function systemActor(
  servicePrincipalId: string,
  capabilityActions: readonly string[] = ['tool.*'],
) {
  return {
    type: 'SYSTEM' as const,
    tenantId: TENANT_ID,
    userId: null,
    servicePrincipalId,
    roleAssignment: null,
    capabilityActions,
  };
}

function policyProof(decision: 'DENY' | 'REQUIRE_CONFIRMATION' | 'REQUIRE_APPROVAL' | 'ALLOW') {
  return {
    tenantId: TENANT_ID,
    invocationId: INVOCATION_ID,
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    riskClass: 'CONFIRM_REQUIRED' as const,
    dryRun: false,
    decision,
  };
}

function confirmationProof() {
  return {
    tenantId: TENANT_ID,
    invocationId: INVOCATION_ID,
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    requesterUserId: REQUESTER,
    requesterRoleAssignmentId: REQUESTER_ASSIGNMENT,
    confirmed: true,
  };
}

function approvalProof(approverUserId: string, approverRoleAssignmentId: string) {
  return {
    tenantId: TENANT_ID,
    invocationId: INVOCATION_ID,
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    approverUserId,
    approverRoleAssignmentId,
    actorType: 'USER' as const,
    decision: 'APPROVED' as const,
  };
}

function providerProof(outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED') {
  return {
    tenantId: TENANT_ID,
    invocationId: INVOCATION_ID,
    inputHash: INPUT_HASH,
    providerRequestId: 'provider-request-1',
    outcome,
  };
}
