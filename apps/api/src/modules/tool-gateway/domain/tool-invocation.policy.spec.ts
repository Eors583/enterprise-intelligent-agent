import { describe, expect, it } from 'vitest';

import {
  decideToolInvocationPolicy,
  type ToolInvocationPolicyInput,
  type TrustedToolApproval,
} from './tool-invocation.policy.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const APPROVER_ID = '00000000-0000-7000-8000-000000000003';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000004';
const APPROVER_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000005';
const TOOL_VERSION_ID = '00000000-0000-7000-8000-000000000006';
const TASK_ID = '00000000-0000-7000-8000-000000000007';
const INVOCATION_ID = '00000000-0000-7000-8000-000000000008';
const INPUT_HASH = 'a'.repeat(64);
const POLICY_DECISION_ID = 'policy-decision-1';

describe('decideToolInvocationPolicy', () => {
  it('allows a scoped read-only invocation and emits execution obligations', () => {
    expect(decideToolInvocationPolicy(policyInput())).toEqual({
      kind: 'allow',
      reasonCode: 'ALLOW_TOOL_EXECUTION',
      obligations: [
        'VALIDATE_INPUT_SCHEMA',
        'EXECUTE_THROUGH_GATEWAY_ONLY',
        'RESOLVE_AND_PIN_PUBLIC_IP',
        'VALIDATE_OUTPUT_SCHEMA',
        'PERSIST_AUDIT_AND_OUTBOX',
      ],
    });
  });

  it('fails closed when a Role Assignment has no explicit Task scope', () => {
    expect(
      decideToolInvocationPolicy({
        ...policyInput(),
        assignment: { ...policyInput().assignment, taskIds: [] },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'ASSIGNMENT_TASK_SCOPE_DENIED' });
  });

  it('requires trusted requester confirmation for confirmation-class tools', () => {
    expect(
      decideToolInvocationPolicy({
        ...policyInput(),
        tool: { ...policyInput().tool, riskClass: 'CONFIRM_REQUIRED' },
      }),
    ).toMatchObject({ kind: 'pending', reasonCode: 'CONFIRMATION_REQUIRED' });
    expect(
      decideToolInvocationPolicy({
        ...policyInput(),
        tool: { ...policyInput().tool, riskClass: 'CONFIRM_REQUIRED' },
        confirmation: {
          ...confirmation(),
          tenantId: TENANT_ID,
          requesterUserId: USER_ID,
          toolVersionId: TOOL_VERSION_ID,
          taskId: TASK_ID,
          inputHash: 'b'.repeat(64),
        },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'CONFIRMATION_INVALID' });
  });

  it('requires a different active human Assignment to approve high-risk execution', () => {
    const base = highRiskPolicyInput();
    expect(decideToolInvocationPolicy(base)).toMatchObject({
      kind: 'pending',
      reasonCode: 'APPROVAL_REQUIRED',
    });
    expect(
      decideToolInvocationPolicy({
        ...base,
        approval: {
          ...approval(),
          approverUserId: USER_ID,
          assignment: {
            ...approval().assignment,
            userId: USER_ID,
          },
        },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'APPROVAL_INVALID' });
    expect(decideToolInvocationPolicy({ ...base, approval: approval() })).toMatchObject({
      kind: 'allow',
      reasonCode: 'ALLOW_TOOL_EXECUTION',
    });
    expect(
      decideToolInvocationPolicy({
        ...base,
        approval: { ...approval(), approverActorType: 'AGENT' },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'APPROVAL_INVALID' });
  });

  it('does not let native dry-run bypass confirmation or independent approval', () => {
    const { confirmation: _confirmation, ...withoutConfirmation } = highRiskPolicyInput();
    expect(
      decideToolInvocationPolicy({
        ...withoutConfirmation,
        dryRun: true,
      }),
    ).toMatchObject({ kind: 'pending', reasonCode: 'CONFIRMATION_REQUIRED' });
    expect(
      decideToolInvocationPolicy({
        ...highRiskPolicyInput(),
        dryRun: true,
      }),
    ).toMatchObject({ kind: 'pending', reasonCode: 'APPROVAL_REQUIRED' });
    expect(
      decideToolInvocationPolicy({
        ...highRiskPolicyInput(),
        dryRun: true,
        approval: approval(),
      }),
    ).toMatchObject({
      kind: 'allow',
      reasonCode: 'ALLOW_DRY_RUN',
      obligations: expect.arrayContaining(['ENFORCE_NATIVE_DRY_RUN']),
    });
    expect(
      decideToolInvocationPolicy({
        ...withoutConfirmation,
        dryRun: true,
        assignment: { ...policyInput().assignment, taskIds: [] },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'ASSIGNMENT_TASK_SCOPE_DENIED' });
  });

  it('never dispatches a validate-only dry run to the provider', () => {
    expect(
      decideToolInvocationPolicy({
        ...policyInput(),
        dryRun: true,
        tool: { ...policyInput().tool, dryRunMode: 'VALIDATE_ONLY' },
      }),
    ).toEqual({
      kind: 'allow',
      reasonCode: 'ALLOW_DRY_RUN',
      obligations: [
        'VALIDATE_INPUT_SCHEMA',
        'DO_NOT_DISPATCH_PROVIDER',
        'PERSIST_AUDIT_AND_OUTBOX',
      ],
    });
  });

  it('rejects replayed confirmation or approval proofs from another invocation', () => {
    expect(
      decideToolInvocationPolicy({
        ...highRiskPolicyInput(),
        confirmation: {
          ...confirmation(),
          invocationId: '00000000-0000-7000-8000-000000000099',
        },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'CONFIRMATION_INVALID' });
    expect(
      decideToolInvocationPolicy({
        ...highRiskPolicyInput(),
        approval: {
          ...approval(),
          invocationId: '00000000-0000-7000-8000-000000000099',
        },
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'APPROVAL_INVALID' });
  });
});

function policyInput(): ToolInvocationPolicyInput {
  return {
    invocationId: INVOCATION_ID,
    tenantId: TENANT_ID,
    requesterUserId: USER_ID,
    tool: {
      id: TOOL_VERSION_ID,
      tenantId: TENANT_ID,
      key: 'crm.customer.read',
      status: 'PUBLISHED',
      riskClass: 'READ_ONLY',
      dataClassification: 'CONFIDENTIAL',
      dryRunMode: 'NATIVE',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
    },
    task: {
      id: TASK_ID,
      tenantId: TENANT_ID,
      status: 'IN_PROGRESS',
      participantRoleAssignmentIds: [ASSIGNMENT_ID],
      reviewerRoleAssignmentIds: [APPROVER_ASSIGNMENT_ID],
      dataLabels: ['customer:assigned'],
    },
    assignment: {
      id: ASSIGNMENT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      status: 'ACTIVE',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
      employmentActive: true,
      orgUnitActive: true,
      roleVersionStatus: 'PUBLISHED',
      permissionActions: ['tool.invoke:crm.customer.read'],
      taskIds: [TASK_ID],
      dataLabels: ['customer:assigned'],
      maxDataClassification: 'CONFIDENTIAL',
    },
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    dryRun: false,
    now: new Date('2026-07-28T00:05:00.000Z'),
  };
}

function highRiskPolicyInput(): ToolInvocationPolicyInput {
  return {
    ...policyInput(),
    tool: { ...policyInput().tool, riskClass: 'HIGH_RISK_APPROVAL' },
    confirmation: confirmation(),
  };
}

function confirmation() {
  return {
    invocationId: INVOCATION_ID,
    tenantId: TENANT_ID,
    requesterUserId: USER_ID,
    requesterRoleAssignmentId: ASSIGNMENT_ID,
    toolVersionId: TOOL_VERSION_ID,
    taskId: TASK_ID,
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    confirmedAt: '2026-07-28T00:00:01.000Z',
    expiresAt: '2026-07-28T00:10:00.000Z',
  };
}

function approval(): TrustedToolApproval {
  return {
    invocationId: INVOCATION_ID,
    tenantId: TENANT_ID,
    approverUserId: APPROVER_ID,
    approverActorType: 'USER',
    toolVersionId: TOOL_VERSION_ID,
    taskId: TASK_ID,
    inputHash: INPUT_HASH,
    policyDecisionId: POLICY_DECISION_ID,
    approvedAt: '2026-07-28T00:00:02.000Z',
    expiresAt: '2026-07-28T00:10:00.000Z',
    approved: true,
    assignment: {
      id: APPROVER_ASSIGNMENT_ID,
      tenantId: TENANT_ID,
      userId: APPROVER_ID,
      status: 'ACTIVE',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
      employmentActive: true,
      orgUnitActive: true,
      roleVersionStatus: 'PUBLISHED',
      permissionActions: ['tool.approve:crm.customer.read'],
      taskIds: [TASK_ID],
      dataLabels: ['customer:assigned'],
      maxDataClassification: 'RESTRICTED',
    },
  };
}
