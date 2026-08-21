import type {
  BusinessEventDelivery,
  BusinessEventEnvelope,
  Collaboration,
  CollaborationDetailResponse,
  CorrectionCase,
  ProcessCommand,
  ProcessInstance,
  ProcessInstanceDetailResponse,
  ProcessStepCommand,
  ProcessStepInstance,
} from '@enterprise/contracts';

import type { TrustedRuntimePrincipal } from '../application/runtime-identity.port.js';

export const TENANT_ID = '00000000-0000-7000-8000-000000000001';
export const USER_ID = '00000000-0000-7000-8000-000000000002';
export const INSTANCE_ID = '00000000-0000-7000-8000-000000000101';
export const STEP_ID = '00000000-0000-7000-8000-000000000102';
export const PROCESS_DEFINITION_ID = '00000000-0000-7000-8000-000000000103';
export const PROCESS_VERSION_ID = '00000000-0000-7000-8000-000000000104';
export const PROCESS_NODE_ID = '00000000-0000-7000-8000-000000000105';
export const OBJECTIVE_ID = '00000000-0000-7000-8000-000000000106';
export const TASK_ID = '00000000-0000-7000-8000-000000000107';
export const ROLE_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000108';
export const RECIPIENT_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000109';
export const AGENT_ID = '00000000-0000-7000-8000-000000000110';
export const EVENT_ID = '00000000-0000-7000-8000-000000000201';
export const DELIVERY_ID = '00000000-0000-7000-8000-000000000202';
export const CORRELATION_ID = '00000000-0000-7000-8000-000000000203';
export const COLLABORATION_ID = '00000000-0000-7000-8000-000000000301';
export const COLLABORATION_MESSAGE_ID = '00000000-0000-7000-8000-000000000302';
export const CORRECTION_ID = '00000000-0000-7000-8000-000000000401';

export const CREATED_AT = '2026-07-28T01:00:00.000Z';
export const UPDATED_AT = '2026-07-28T01:05:00.000Z';
export const NEXT_UPDATED_AT = '2026-07-28T01:10:00.000Z';

export const ADMIN_PRINCIPAL: TrustedRuntimePrincipal = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  tenantRole: 'ADMIN',
  authenticationSource: 'session',
};

export const MEMBER_PRINCIPAL: TrustedRuntimePrincipal = {
  ...ADMIN_PRINCIPAL,
  tenantRole: 'MEMBER',
};

export function processInstance(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
  return {
    id: INSTANCE_ID,
    tenantId: TENANT_ID,
    processDefinitionId: PROCESS_DEFINITION_ID,
    processVersionId: PROCESS_VERSION_ID,
    processVersion: 1,
    objectiveId: OBJECTIVE_ID,
    taskId: TASK_ID,
    triggerEventId: null,
    correlationId: CORRELATION_ID,
    status: 'PENDING',
    revision: 1,
    input: { objective: 'Launch' },
    output: null,
    failureCode: null,
    failureDetail: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    compensationStartedAt: null,
    compensationCompletedAt: null,
    idempotencyKey: 'process-instance:create:1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function processStep(overrides: Partial<ProcessStepInstance> = {}): ProcessStepInstance {
  return {
    id: STEP_ID,
    tenantId: TENANT_ID,
    processInstanceId: INSTANCE_ID,
    processNodeId: PROCESS_NODE_ID,
    processNodeCode: 'APPROVE',
    attempt: 1,
    status: 'READY',
    revision: 1,
    resolvedRoleAssignmentId: ROLE_ASSIGNMENT_ID,
    resolvedAgentId: null,
    assignmentSnapshot: { role: 'Approver' },
    input: { request: 'Approve' },
    output: null,
    availableAt: CREATED_AT,
    claimedAt: null,
    startedAt: null,
    dueAt: '2026-07-29T01:00:00.000Z',
    completedAt: null,
    timedOutAt: null,
    failureCode: null,
    failureDetail: null,
    compensationForStepId: null,
    idempotencyKey: 'process-step:create:1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function processDetail(): ProcessInstanceDetailResponse {
  return {
    instance: processInstance(),
    steps: [processStep()],
  };
}

export const START_PROCESS_COMMAND: ProcessCommand = {
  processInstanceId: INSTANCE_ID,
  expectedRevision: 1,
  command: 'START',
  reason: 'Start approved process.',
  effectiveAt: UPDATED_AT,
  idempotencyKey: 'process-command:start:1',
};

export const CLAIM_STEP_COMMAND: ProcessStepCommand = {
  stepInstanceId: STEP_ID,
  expectedRevision: 1,
  command: 'CLAIM',
  actorRoleAssignmentId: ROLE_ASSIGNMENT_ID,
  reason: 'Claim approval work.',
  effectiveAt: UPDATED_AT,
  idempotencyKey: 'step-command:claim:1',
};

export function businessEvent(): BusinessEventEnvelope {
  return {
    eventId: EVENT_ID,
    tenantId: TENANT_ID,
    eventType: 'Process.Started',
    schemaVersion: 1,
    aggregate: { type: 'PROCESS_INSTANCE', id: INSTANCE_ID, version: 2 },
    subject: { type: 'TASK', id: TASK_ID, version: 1 },
    occurredAt: CREATED_AT,
    producedAt: UPDATED_AT,
    organizationScope: {
      orgUnitIds: [],
      projectIds: [],
      customerIds: [],
      dataLabels: ['internal'],
    },
    payload: { status: 'RUNNING' },
    correlationId: CORRELATION_ID,
    causationId: null,
    idempotencyKey: 'event:process-started:1',
    sensitivity: 'INTERNAL',
    retention: {
      retainUntil: '2027-07-28T01:05:00.000Z',
      action: 'ARCHIVE',
      legalHold: false,
    },
    source: {
      system: 'enterprise-api',
      recordId: INSTANCE_ID,
      version: '2',
      producer: 'process-runtime',
    },
    evidenceRefs: [],
  };
}

export function delivery(overrides: Partial<BusinessEventDelivery> = {}): BusinessEventDelivery {
  return {
    id: DELIVERY_ID,
    tenantId: TENANT_ID,
    businessEventId: EVENT_ID,
    consumerName: 'process-worker',
    status: 'DEAD_LETTERED',
    revision: 3,
    attempts: 5,
    availableAt: CREATED_AT,
    lockedBy: null,
    lockedUntil: null,
    processedAt: null,
    deadLetteredAt: UPDATED_AT,
    lastErrorCode: 'PROVIDER_TIMEOUT',
    lastErrorDetail: 'The downstream provider timed out.',
    replayCount: 0,
    replayedAt: null,
    replayedByUserId: null,
    replayReason: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

export function collaboration(overrides: Partial<Collaboration> = {}): Collaboration {
  return {
    id: COLLABORATION_ID,
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    objectiveId: OBJECTIVE_ID,
    taskId: TASK_ID,
    requesterRoleAssignmentId: ROLE_ASSIGNMENT_ID,
    recipientRoleAssignmentIds: [RECIPIENT_ASSIGNMENT_ID],
    status: 'REQUESTED',
    revision: 1,
    commonGoal: 'Complete the launch review.',
    requestedInput: 'Review the launch checklist.',
    expectedOutputSchema: { type: 'object' },
    dueAt: '2026-07-29T01:00:00.000Z',
    permissionLabels: ['internal'],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function collaborationDetail(): CollaborationDetailResponse {
  return {
    collaboration: collaboration(),
    messages: [
      {
        id: COLLABORATION_MESSAGE_ID,
        tenantId: TENANT_ID,
        collaborationId: COLLABORATION_ID,
        schemaVersion: 1,
        revision: 1,
        correlationId: CORRELATION_ID,
        causationId: null,
        senderRoleAssignmentId: ROLE_ASSIGNMENT_ID,
        recipientRoleAssignmentIds: [RECIPIENT_ASSIGNMENT_ID],
        objectiveId: OBJECTIVE_ID,
        taskId: TASK_ID,
        permissionLabels: ['internal'],
        occurredAt: CREATED_AT,
        idempotencyKey: 'collaboration:request:1',
        type: 'REQUEST',
        payload: {
          background: 'Launch preparation is complete.',
          commonGoal: 'Complete the launch review.',
          requestedInput: 'Review the launch checklist.',
          dueAt: '2026-07-29T01:00:00.000Z',
          expectedOutputSchema: { type: 'object' },
          contextRefs: [],
        },
      },
    ],
  };
}

export function correction(overrides: Partial<CorrectionCase> = {}): CorrectionCase {
  return {
    id: CORRECTION_ID,
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    subject: { type: 'TASK', id: TASK_ID, version: 1 },
    roleAssignmentId: ROLE_ASSIGNMENT_ID,
    objectiveId: OBJECTIVE_ID,
    taskId: TASK_ID,
    processInstanceId: INSTANCE_ID,
    trigger: 'A required approval is missing.',
    category: 'HARD_CONSTRAINT',
    severity: 'MEDIUM',
    confidence: 0.95,
    ruleFindings: ['Approval evidence is missing.'],
    modelFinding: null,
    evidenceRefs: [
      {
        evidenceId: EVENT_ID,
        version: 1,
        contentHash: null,
      },
    ],
    impact: 'The launch cannot proceed.',
    suggestedActions: ['Acknowledge and provide approval evidence.'],
    requiredRoleAssignmentIds: [RECIPIENT_ASSIGNMENT_ID],
    status: 'OPEN',
    revision: 1,
    permissionLabels: ['internal'],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}
