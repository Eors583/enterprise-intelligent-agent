import { describe, expect, it } from 'vitest';

import {
  businessEventDeliverySchema,
  businessEventDetailResponseSchema,
  collaborationDetailResponseSchema,
  correctionFeedbackRequestSchema,
  processCommandSchema,
  processInstanceSchema,
  processStepCommandSchema,
  processStepInstanceSchema,
} from '../src/process-runtime.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const INSTANCE_ID = '00000000-0000-7000-8000-000000000002';
const STEP_ID = '00000000-0000-7000-8000-000000000003';
const DEFINITION_ID = '00000000-0000-7000-8000-000000000004';
const VERSION_ID = '00000000-0000-7000-8000-000000000005';
const NODE_ID = '00000000-0000-7000-8000-000000000006';
const OBJECTIVE_ID = '00000000-0000-7000-8000-000000000007';
const TASK_ID = '00000000-0000-7000-8000-000000000008';
const EVENT_ID = '00000000-0000-7000-8000-000000000009';
const CORRELATION_ID = '00000000-0000-7000-8000-000000000010';

describe('process runtime contracts', () => {
  it('accepts a version-pinned, traceable running Process Instance', () => {
    expect(
      processInstanceSchema.parse({
        id: INSTANCE_ID,
        tenantId: TENANT_ID,
        processDefinitionId: DEFINITION_ID,
        processVersionId: VERSION_ID,
        processVersion: 3,
        objectiveId: OBJECTIVE_ID,
        taskId: TASK_ID,
        triggerEventId: EVENT_ID,
        correlationId: CORRELATION_ID,
        status: 'RUNNING',
        revision: 2,
        input: { customerId: 'C-001' },
        output: null,
        failureCode: null,
        failureDetail: null,
        startedAt: '2026-07-28T06:00:01.000Z',
        pausedAt: null,
        completedAt: null,
        cancelledAt: null,
        compensationStartedAt: null,
        compensationCompletedAt: null,
        idempotencyKey: 'process:start:C-001',
        createdAt: '2026-07-28T06:00:00.000Z',
        updatedAt: '2026-07-28T06:00:01.000Z',
      }),
    ).toMatchObject({ status: 'RUNNING', processVersion: 3 });
  });

  it('rejects lifecycle states without their authoritative timestamps', () => {
    const result = processInstanceSchema.safeParse({
      id: INSTANCE_ID,
      tenantId: TENANT_ID,
      processDefinitionId: DEFINITION_ID,
      processVersionId: VERSION_ID,
      processVersion: 1,
      objectiveId: OBJECTIVE_ID,
      taskId: TASK_ID,
      triggerEventId: null,
      correlationId: CORRELATION_ID,
      status: 'COMPENSATED',
      revision: 1,
      input: {},
      output: {},
      failureCode: null,
      failureDetail: null,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      cancelledAt: null,
      compensationStartedAt: null,
      compensationCompletedAt: null,
      idempotencyKey: 'process:compensated:invalid',
      createdAt: '2026-07-28T06:00:00.000Z',
      updatedAt: '2026-07-28T06:00:01.000Z',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['startedAt', 'compensationStartedAt', 'compensationCompletedAt']),
    );
  });

  it('validates step attempt, resolved identity, SLA, terminal state and failure details', () => {
    const parsed = processStepInstanceSchema.parse({
      id: STEP_ID,
      tenantId: TENANT_ID,
      processInstanceId: INSTANCE_ID,
      processNodeId: NODE_ID,
      processNodeCode: 'SOLUTION.REVIEW',
      attempt: 1,
      status: 'COMPLETED',
      revision: 4,
      resolvedRoleAssignmentId: '00000000-0000-7000-8000-000000000011',
      resolvedAgentId: null,
      assignmentSnapshot: { roleVersion: 3 },
      input: { documentId: 'D-001' },
      output: { approved: true },
      availableAt: '2026-07-28T06:00:00.000Z',
      claimedAt: '2026-07-28T06:00:01.000Z',
      startedAt: '2026-07-28T06:00:02.000Z',
      dueAt: '2026-07-28T07:00:00.000Z',
      completedAt: '2026-07-28T06:10:00.000Z',
      timedOutAt: null,
      failureCode: null,
      failureDetail: null,
      compensationForStepId: null,
      idempotencyKey: 'process-step:solution-review:1',
      createdAt: '2026-07-28T06:00:00.000Z',
      updatedAt: '2026-07-28T06:10:00.000Z',
    });
    expect(parsed.status).toBe('COMPLETED');

    expect(() =>
      processStepInstanceSchema.parse({
        ...parsed,
        status: 'FAILED',
        completedAt: null,
      }),
    ).toThrow();
  });

  it('requires failure metadata only for failure commands', () => {
    const command = {
      processInstanceId: INSTANCE_ID,
      expectedRevision: 2,
      command: 'FAIL' as const,
      reason: 'Provider timeout exhausted.',
      effectiveAt: '2026-07-28T06:10:00.000Z',
      idempotencyKey: 'process:fail:2',
      failureCode: 'PROVIDER_TIMEOUT',
      failureDetail: 'The bounded retry policy was exhausted.',
    };
    expect(processCommandSchema.parse(command).command).toBe('FAIL');
    expect(() =>
      processCommandSchema.parse({
        ...command,
        command: 'PAUSE',
      }),
    ).toThrow();
    expect(() =>
      processCommandSchema.parse({
        ...command,
        command: 'PAUSE',
        failureDetail: undefined,
      }),
    ).toThrow();
  });

  it('requires an actor Role Assignment for actor-executed step commands', () => {
    const command = {
      stepInstanceId: STEP_ID,
      expectedRevision: 2,
      command: 'COMPLETE' as const,
      actorRoleAssignmentId: '00000000-0000-7000-8000-000000000011',
      reason: 'The assigned human reviewer completed the approval.',
      effectiveAt: '2026-07-28T06:10:00.000Z',
      idempotencyKey: 'process-step:complete:2',
      output: { approved: true },
    };
    expect(processStepCommandSchema.parse(command).command).toBe('COMPLETE');
    expect(() =>
      processStepCommandSchema.parse({
        ...command,
        actorRoleAssignmentId: null,
      }),
    ).toThrow();
  });
});

describe('business event delivery and correction feedback contracts', () => {
  it('requires a lease for processing and error detail for dead letters', () => {
    const parsed = businessEventDeliverySchema.parse({
      id: STEP_ID,
      tenantId: TENANT_ID,
      businessEventId: EVENT_ID,
      consumerName: 'process-orchestrator',
      status: 'PROCESSING',
      revision: 2,
      attempts: 1,
      availableAt: '2026-07-28T06:00:00.000Z',
      lockedBy: 'worker-a',
      lockedUntil: '2026-07-28T06:01:00.000Z',
      processedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      replayCount: 0,
      replayedAt: null,
      replayedByUserId: null,
      replayReason: null,
      createdAt: '2026-07-28T06:00:00.000Z',
      updatedAt: '2026-07-28T06:00:01.000Z',
    });
    expect(parsed.status).toBe('PROCESSING');
    expect(() =>
      businessEventDeliverySchema.parse({
        ...parsed,
        lockedBy: null,
        lockedUntil: null,
      }),
    ).toThrow();
  });

  it('requires complete replay attribution whenever replayCount is positive', () => {
    const replayed = {
      id: STEP_ID,
      tenantId: TENANT_ID,
      businessEventId: EVENT_ID,
      consumerName: 'process-orchestrator',
      status: 'PENDING' as const,
      revision: 3,
      attempts: 1,
      availableAt: '2026-07-28T06:02:00.000Z',
      lockedBy: null,
      lockedUntil: null,
      processedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      replayCount: 1,
      replayedAt: '2026-07-28T06:02:00.000Z',
      replayedByUserId: '00000000-0000-7000-8000-000000000099',
      replayReason: 'Administrator approved a bounded retry.',
      createdAt: '2026-07-28T06:00:00.000Z',
      updatedAt: '2026-07-28T06:02:00.000Z',
    };
    expect(businessEventDeliverySchema.parse(replayed).replayCount).toBe(1);
    expect(() =>
      businessEventDeliverySchema.parse({ ...replayed, replayedByUserId: null }),
    ).toThrow();
  });

  it('fails closed when event deliveries or collaboration messages cross traces', () => {
    const event = {
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      eventType: 'TaskChanged',
      schemaVersion: 1,
      aggregate: { type: 'TASK' as const, id: TASK_ID, version: 1 },
      subject: { type: 'TASK' as const, id: TASK_ID, version: 1 },
      occurredAt: '2026-07-28T06:00:00.000Z',
      producedAt: '2026-07-28T06:00:01.000Z',
      organizationScope: {
        orgUnitIds: [],
        projectIds: [],
        customerIds: [],
        dataLabels: [],
      },
      payload: { status: 'READY' },
      correlationId: CORRELATION_ID,
      causationId: null,
      idempotencyKey: 'event:task-changed:1',
      sensitivity: 'INTERNAL' as const,
      retention: {
        retainUntil: '2033-07-28T06:00:01.000Z',
        action: 'ARCHIVE' as const,
        legalHold: false,
      },
      source: {
        system: 'task-service',
        recordId: TASK_ID,
        version: '1',
        producer: 'task-service',
      },
      evidenceRefs: [],
    };
    const delivery = {
      id: STEP_ID,
      tenantId: TENANT_ID,
      businessEventId: '00000000-0000-7000-8000-000000000099',
      consumerName: 'process-orchestrator',
      status: 'PENDING' as const,
      revision: 1,
      attempts: 0,
      availableAt: '2026-07-28T06:00:01.000Z',
      lockedBy: null,
      lockedUntil: null,
      processedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      replayCount: 0,
      replayedAt: null,
      replayedByUserId: null,
      replayReason: null,
      createdAt: '2026-07-28T06:00:01.000Z',
      updatedAt: '2026-07-28T06:00:01.000Z',
    };
    expect(() =>
      businessEventDetailResponseSchema.parse({ event, deliveries: [delivery] }),
    ).toThrow();

    const collaboration = {
      id: INSTANCE_ID,
      tenantId: TENANT_ID,
      correlationId: CORRELATION_ID,
      objectiveId: OBJECTIVE_ID,
      taskId: TASK_ID,
      requesterRoleAssignmentId: '00000000-0000-7000-8000-000000000011',
      recipientRoleAssignmentIds: ['00000000-0000-7000-8000-000000000012'],
      status: 'REQUESTED' as const,
      revision: 1,
      commonGoal: 'Complete the customer delivery.',
      requestedInput: 'Provide the verified solution.',
      expectedOutputSchema: { type: 'object', required: ['uri'] },
      dueAt: '2026-07-29T06:00:00.000Z',
      permissionLabels: [],
      createdAt: '2026-07-28T06:00:00.000Z',
      updatedAt: '2026-07-28T06:00:00.000Z',
    };
    const message = {
      id: '00000000-0000-7000-8000-000000000013',
      tenantId: TENANT_ID,
      collaborationId: '00000000-0000-7000-8000-000000000098',
      schemaVersion: 1,
      revision: 2,
      correlationId: CORRELATION_ID,
      causationId: null,
      senderRoleAssignmentId: collaboration.recipientRoleAssignmentIds[0],
      recipientRoleAssignmentIds: [collaboration.requesterRoleAssignmentId],
      objectiveId: OBJECTIVE_ID,
      taskId: TASK_ID,
      permissionLabels: [],
      occurredAt: '2026-07-28T06:01:00.000Z',
      idempotencyKey: 'collaboration:commit:2',
      type: 'COMMIT' as const,
      payload: {
        committedDueAt: '2026-07-29T05:00:00.000Z',
        outputSchema: { type: 'object', required: ['uri'] },
        conditions: [],
      },
    };
    expect(() =>
      collaborationDetailResponseSchema.parse({ collaboration, messages: [message] }),
    ).toThrow();
  });

  it('requires evidence for high-impact correction feedback', () => {
    const base = {
      expectedRevision: 3,
      action: 'EXPLAIN' as const,
      comment: 'The delay is caused by a missing upstream customer approval.',
      evidenceIds: ['00000000-0000-7000-8000-000000000012'],
      effectiveAt: '2026-07-28T06:20:00.000Z',
      idempotencyKey: 'correction:explain:3',
    };
    expect(correctionFeedbackRequestSchema.parse(base).action).toBe('EXPLAIN');
    expect(() =>
      correctionFeedbackRequestSchema.parse({
        ...base,
        evidenceIds: [],
      }),
    ).toThrow();
  });
});
