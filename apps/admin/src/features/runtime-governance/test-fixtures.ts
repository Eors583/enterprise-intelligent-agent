import {
  businessEventDeliverySchema,
  businessEventEnvelopeSchema,
  processInstanceSchema,
  processStepInstanceSchema,
  type BusinessEventDelivery,
  type BusinessEventEnvelope,
  type ProcessInstance,
  type ProcessStepInstance,
} from '@enterprise/contracts';

export const runtimeId = (number: number): string =>
  `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`;

export function processInstanceFixture(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
  return processInstanceSchema.parse({
    id: runtimeId(1),
    tenantId: runtimeId(2),
    processDefinitionId: runtimeId(3),
    processVersionId: runtimeId(4),
    processVersion: 2,
    objectiveId: runtimeId(5),
    taskId: runtimeId(6),
    triggerEventId: runtimeId(7),
    correlationId: runtimeId(8),
    status: 'RUNNING',
    revision: 3,
    input: { taskCode: 'TASK.RETENTION.REVIEW' },
    output: null,
    failureCode: null,
    failureDetail: null,
    startedAt: '2026-07-28T08:01:00.000Z',
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    compensationStartedAt: null,
    compensationCompletedAt: null,
    idempotencyKey: 'process:retention-review:1',
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T08:02:00.000Z',
    ...overrides,
  });
}

export function processStepFixture(
  overrides: Partial<ProcessStepInstance> = {},
): ProcessStepInstance {
  return processStepInstanceSchema.parse({
    id: runtimeId(11),
    tenantId: runtimeId(2),
    processInstanceId: runtimeId(1),
    processNodeId: runtimeId(12),
    processNodeCode: 'REVIEW.RISK',
    attempt: 1,
    status: 'RUNNING',
    revision: 2,
    resolvedRoleAssignmentId: runtimeId(13),
    resolvedAgentId: null,
    assignmentSnapshot: { roleCode: 'CUSTOMER_SUCCESS' },
    input: { customerGroup: 'high-risk' },
    output: null,
    availableAt: '2026-07-28T08:00:30.000Z',
    claimedAt: '2026-07-28T08:00:45.000Z',
    startedAt: '2026-07-28T08:01:00.000Z',
    dueAt: '2026-07-29T08:00:30.000Z',
    completedAt: null,
    timedOutAt: null,
    failureCode: null,
    failureDetail: null,
    compensationForStepId: null,
    idempotencyKey: 'process-step:review-risk:1',
    createdAt: '2026-07-28T08:00:30.000Z',
    updatedAt: '2026-07-28T08:02:00.000Z',
    ...overrides,
  });
}

export function businessEventFixture(
  overrides: Partial<BusinessEventEnvelope> = {},
): BusinessEventEnvelope {
  return businessEventEnvelopeSchema.parse({
    eventId: runtimeId(21),
    tenantId: runtimeId(2),
    eventType: 'TaskStrategicDeviationDetected',
    schemaVersion: 1,
    aggregate: { type: 'TASK', id: runtimeId(6), version: 3 },
    subject: { type: 'TASK', id: runtimeId(6), version: 3 },
    occurredAt: '2026-07-28T08:03:00.000Z',
    producedAt: '2026-07-28T08:03:01.000Z',
    organizationScope: {
      orgUnitIds: [],
      projectIds: [],
      customerIds: [],
      dataLabels: ['internal.strategy'],
    },
    payload: { trigger: 'milestone deviation', thresholdDays: 3 },
    correlationId: runtimeId(8),
    causationId: runtimeId(7),
    idempotencyKey: 'event:task-deviation:3',
    sensitivity: 'SENSITIVE',
    retention: {
      retainUntil: '2033-07-28T08:03:01.000Z',
      action: 'ARCHIVE',
      legalHold: false,
    },
    source: {
      system: 'task-service',
      recordId: 'TASK.RETENTION.REVIEW',
      version: '3',
      producer: 'business-event-service',
    },
    evidenceRefs: [],
    ...overrides,
  });
}

export function deliveryFixture(
  overrides: Partial<BusinessEventDelivery> = {},
): BusinessEventDelivery {
  return businessEventDeliverySchema.parse({
    id: runtimeId(31),
    tenantId: runtimeId(2),
    businessEventId: runtimeId(21),
    consumerName: 'correction-detector',
    status: 'DEAD_LETTERED',
    revision: 3,
    attempts: 5,
    availableAt: '2026-07-28T08:03:02.000Z',
    lockedBy: null,
    lockedUntil: null,
    processedAt: null,
    deadLetteredAt: '2026-07-28T08:10:00.000Z',
    lastErrorCode: 'CORRECTION_RULE_TIMEOUT',
    lastErrorDetail: 'Rule evaluation exceeded the configured deadline.',
    replayCount: 0,
    replayedAt: null,
    replayedByUserId: null,
    replayReason: null,
    createdAt: '2026-07-28T08:03:02.000Z',
    updatedAt: '2026-07-28T08:10:00.000Z',
    ...overrides,
  });
}
