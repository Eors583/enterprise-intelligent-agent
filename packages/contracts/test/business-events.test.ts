import { describe, expect, it } from 'vitest';

import {
  businessEventEnvelopeSchema,
  collaborationCommandRequestSchema,
  collaborationMessageSchema,
  collaborationSchema,
  correctionCaseSchema,
  createCollaborationRequestSchema,
  isCollaborationTransitionAllowed,
  isCorrectionTransitionAllowed,
} from '../src/business-events.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const EVENT_ID = '00000000-0000-7000-8000-000000000002';
const CORRELATION_ID = '00000000-0000-7000-8000-000000000003';
const TASK_ID = '00000000-0000-7000-8000-000000000004';
const OBJECTIVE_ID = '00000000-0000-7000-8000-000000000005';
const REQUESTER_ID = '00000000-0000-7000-8000-000000000006';
const RECIPIENT_ID = '00000000-0000-7000-8000-000000000007';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000008';
const COLLABORATION_ID = '00000000-0000-7000-8000-000000000009';

describe('businessEventEnvelopeSchema', () => {
  it('accepts a versioned, scoped, evidence-bearing event envelope', () => {
    expect(
      businessEventEnvelopeSchema.parse({
        eventId: EVENT_ID,
        tenantId: TENANT_ID,
        eventType: 'TaskStrategicDeviationDetected',
        schemaVersion: 1,
        aggregate: { type: 'TASK', id: TASK_ID, version: 3 },
        subject: { type: 'TASK', id: TASK_ID, version: 3 },
        occurredAt: '2026-07-28T05:00:00.000Z',
        producedAt: '2026-07-28T05:00:01.000Z',
        organizationScope: {
          orgUnitIds: [],
          projectIds: [],
          customerIds: [],
          dataLabels: ['internal.strategy'],
        },
        payload: { trigger: 'Milestone deviation detected.', thresholdDays: 3 },
        correlationId: CORRELATION_ID,
        causationId: null,
        idempotencyKey: 'task:T-001:deviation:3',
        sensitivity: 'SENSITIVE',
        retention: {
          retainUntil: '2033-07-28T05:00:01.000Z',
          action: 'ARCHIVE',
          legalHold: false,
        },
        source: {
          system: 'task-service',
          recordId: 'T-001',
          version: '3',
          producer: 'business-event-service',
        },
        evidenceRefs: [
          {
            evidenceId: EVIDENCE_ID,
            version: 1,
            contentHash: 'a'.repeat(64),
          },
        ],
      }),
    ).toMatchObject({
      eventId: EVENT_ID,
      schemaVersion: 1,
      correlationId: CORRELATION_ID,
    });
  });

  it('rejects empty payloads, self-causation, and invalid event time ordering', () => {
    const base = {
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      eventType: 'TaskChanged',
      schemaVersion: 1,
      aggregate: { type: 'TASK' as const, id: TASK_ID, version: 1 },
      subject: { type: 'TASK' as const, id: TASK_ID, version: 1 },
      occurredAt: '2026-07-28T05:00:01.000Z',
      producedAt: '2026-07-28T05:00:00.000Z',
      organizationScope: {
        orgUnitIds: [],
        projectIds: [],
        customerIds: [],
        dataLabels: [],
      },
      payload: {},
      correlationId: CORRELATION_ID,
      causationId: EVENT_ID,
      idempotencyKey: 'task:T-001:changed:1',
      sensitivity: 'INTERNAL' as const,
      retention: {
        retainUntil: '2026-07-28T05:00:00.000Z',
        action: 'DELETE' as const,
        legalHold: false,
      },
      source: {
        system: 'task-service',
        recordId: 'T-001',
        version: '1',
        producer: 'task-service',
      },
      evidenceRefs: [],
    };

    const result = businessEventEnvelopeSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['payload', 'producedAt', 'causationId', 'retention.retainUntil']),
    );
  });
});

describe('collaboration contracts', () => {
  it('requires a common goal, expected output schema, deadline, and distinct role assignments', () => {
    const parsed = collaborationSchema.parse({
      id: COLLABORATION_ID,
      tenantId: TENANT_ID,
      correlationId: CORRELATION_ID,
      objectiveId: OBJECTIVE_ID,
      taskId: TASK_ID,
      requesterRoleAssignmentId: REQUESTER_ID,
      recipientRoleAssignmentIds: [RECIPIENT_ID],
      status: 'REQUESTED',
      revision: 1,
      commonGoal: 'Restore the customer knowledge accuracy target.',
      requestedInput: 'Provide the validated regression report.',
      expectedOutputSchema: {
        type: 'object',
        required: ['reportUri', 'passRate'],
      },
      dueAt: '2026-07-29T05:00:00.000Z',
      permissionLabels: ['internal.project-alpha'],
      createdAt: '2026-07-28T05:00:00.000Z',
      updatedAt: '2026-07-28T05:00:00.000Z',
    });
    expect(parsed.status).toBe('REQUESTED');

    expect(() =>
      collaborationSchema.parse({
        ...parsed,
        recipientRoleAssignmentIds: [REQUESTER_ID],
      }),
    ).toThrow();
  });

  it('validates a structured Deliver message with evidence and identity context', () => {
    expect(
      collaborationMessageSchema.parse({
        id: EVENT_ID,
        tenantId: TENANT_ID,
        collaborationId: COLLABORATION_ID,
        schemaVersion: 1,
        revision: 3,
        correlationId: CORRELATION_ID,
        causationId: null,
        senderRoleAssignmentId: RECIPIENT_ID,
        recipientRoleAssignmentIds: [REQUESTER_ID],
        objectiveId: OBJECTIVE_ID,
        taskId: TASK_ID,
        permissionLabels: ['internal.project-alpha'],
        occurredAt: '2026-07-28T06:00:00.000Z',
        idempotencyKey: 'collaboration:C-001:deliver:3',
        type: 'DELIVER',
        payload: {
          deliverableId: '00000000-0000-7000-8000-000000000010',
          deliverableVersion: 1,
          evidenceRefs: [
            {
              evidenceId: EVIDENCE_ID,
              version: 1,
              contentHash: null,
            },
          ],
          summary: 'The regression report is complete and all mandatory cases pass.',
        },
      }),
    ).toMatchObject({ type: 'DELIVER', revision: 3 });
  });

  it('accepts only intent fields for create and command requests', () => {
    const createRequest = {
      actingRoleAssignmentId: REQUESTER_ID,
      recipientRoleAssignmentIds: [RECIPIENT_ID],
      background: 'Customer knowledge accuracy is below the committed threshold.',
      commonGoal: 'Restore the customer knowledge accuracy target.',
      requestedInput: 'Provide the validated regression report.',
      expectedOutputSchema: {
        type: 'object',
        required: ['reportUri', 'passRate'],
      },
      dueAt: '2026-07-29T05:00:00.000Z',
      contextRefs: [{ type: 'TASK' as const, id: TASK_ID, version: 3 }],
      idempotencyKey: 'collaboration:create:1',
    };
    expect(createCollaborationRequestSchema.parse(createRequest)).toEqual(createRequest);
    expect(
      createCollaborationRequestSchema.safeParse({
        ...createRequest,
        senderUserId: '00000000-0000-7000-8000-000000000099',
      }).success,
    ).toBe(false);

    const command = {
      expectedRevision: 1,
      type: 'COMMIT' as const,
      payload: {
        committedDueAt: '2026-07-29T05:00:00.000Z',
        outputSchema: { type: 'object', required: ['reportUri'] },
        conditions: ['Evidence must be sealed before delivery.'],
      },
      idempotencyKey: 'collaboration:commit:2',
    };
    expect(collaborationCommandRequestSchema.parse(command)).toEqual(command);
    expect(
      collaborationCommandRequestSchema.safeParse({
        ...command,
        senderRoleAssignmentId: REQUESTER_ID,
      }).success,
    ).toBe(false);
  });

  it('enforces the explicit collaboration state machine', () => {
    expect(isCollaborationTransitionAllowed('REQUESTED', 'COMMITTED')).toBe(true);
    expect(isCollaborationTransitionAllowed('COMMITTED', 'DELIVERED')).toBe(true);
    expect(isCollaborationTransitionAllowed('DELIVERED', 'ACCEPTED')).toBe(true);
    expect(isCollaborationTransitionAllowed('ACCEPTED', 'DELIVERED')).toBe(false);
    expect(isCollaborationTransitionAllowed('CANCELLED', 'COMMITTED')).toBe(false);
  });
});

describe('correctionCaseSchema', () => {
  it('requires evidence, impact, suggestions, confidence, and a feedback state', () => {
    const parsed = correctionCaseSchema.parse({
      id: EVENT_ID,
      tenantId: TENANT_ID,
      correlationId: CORRELATION_ID,
      subject: { type: 'TASK', id: TASK_ID, version: 3 },
      roleAssignmentId: REQUESTER_ID,
      objectiveId: OBJECTIVE_ID,
      taskId: TASK_ID,
      processInstanceId: null,
      trigger: 'The task has spent three days outside the critical path.',
      category: 'OBJECTIVE_DEVIATION',
      severity: 'MEDIUM',
      confidence: 0.86,
      ruleFindings: ['The accuracy milestone remains blocked.'],
      modelFinding: 'Current work has weak contribution to the active objective.',
      evidenceRefs: [
        {
          evidenceId: EVIDENCE_ID,
          version: 1,
          contentHash: null,
        },
      ],
      impact: 'The customer accuracy target is likely to miss its committed date.',
      suggestedActions: ['Pause non-critical UI work and execute the top-error regression plan.'],
      requiredRoleAssignmentIds: [RECIPIENT_ID],
      status: 'OPEN',
      revision: 1,
      permissionLabels: ['internal.project-alpha'],
      createdAt: '2026-07-28T05:00:00.000Z',
      updatedAt: '2026-07-28T05:00:00.000Z',
    });
    expect(parsed.confidence).toBe(0.86);

    expect(() => correctionCaseSchema.parse({ ...parsed, evidenceRefs: [] })).toThrow();
    expect(() => correctionCaseSchema.parse({ ...parsed, suggestedActions: [] })).toThrow();
  });

  it('enforces an explicit feedback lifecycle with terminal resolution', () => {
    expect(isCorrectionTransitionAllowed('OPEN', 'ACKNOWLEDGED')).toBe(true);
    expect(isCorrectionTransitionAllowed('ACKNOWLEDGED', 'EXPLAINED')).toBe(true);
    expect(isCorrectionTransitionAllowed('EXPLAINED', 'RESOLVED')).toBe(true);
    expect(isCorrectionTransitionAllowed('OPEN', 'RESOLVED')).toBe(false);
    expect(isCorrectionTransitionAllowed('RESOLVED', 'OPEN')).toBe(false);
    expect(isCorrectionTransitionAllowed('CANCELLED', 'ACKNOWLEDGED')).toBe(false);
  });
});
