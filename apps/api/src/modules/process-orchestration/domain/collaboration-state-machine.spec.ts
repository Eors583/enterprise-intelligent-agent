import {
  collaborationDetailResponseSchema,
  collaborationMessageSchema,
  collaborationSchema,
  type CollaborationMessage,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  validateCollaborationMessage,
  type CollaborationMessageContext,
} from './collaboration-state-machine.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const COLLABORATION_ID = '00000000-0000-7000-8000-000000000002';
const CORRELATION_ID = '00000000-0000-7000-8000-000000000003';
const OBJECTIVE_ID = '00000000-0000-7000-8000-000000000004';
const TASK_ID = '00000000-0000-7000-8000-000000000005';
const REQUESTER_ID = '00000000-0000-7000-8000-000000000006';
const RECIPIENT_ID = '00000000-0000-7000-8000-000000000007';
const REQUESTER_USER_ID = '00000000-0000-7000-8000-000000000020';
const RECIPIENT_USER_ID = '00000000-0000-7000-8000-000000000021';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000011';
const CONTENT_HASH = 'a'.repeat(64);
const NOW = new Date('2026-07-28T07:00:00.000Z');

const COLLABORATION = collaborationSchema.parse({
  id: COLLABORATION_ID,
  tenantId: TENANT_ID,
  correlationId: CORRELATION_ID,
  objectiveId: OBJECTIVE_ID,
  taskId: TASK_ID,
  requesterRoleAssignmentId: REQUESTER_ID,
  recipientRoleAssignmentIds: [RECIPIENT_ID],
  status: 'REQUESTED',
  revision: 1,
  commonGoal: 'Deliver the accepted customer solution.',
  requestedInput: 'Provide a verified solution proposal.',
  expectedOutputSchema: { type: 'object', required: ['documentId'] },
  dueAt: '2026-07-29T06:00:00.000Z',
  permissionLabels: ['internal.project-alpha'],
  createdAt: '2026-07-28T06:00:00.000Z',
  updatedAt: '2026-07-28T06:00:00.000Z',
});

function message(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  const parsed = collaborationMessageSchema.parse({
    id: '00000000-0000-7000-8000-000000000008',
    tenantId: TENANT_ID,
    collaborationId: COLLABORATION_ID,
    schemaVersion: 1,
    revision: 2,
    correlationId: CORRELATION_ID,
    causationId: null,
    senderRoleAssignmentId: RECIPIENT_ID,
    recipientRoleAssignmentIds: [REQUESTER_ID],
    objectiveId: OBJECTIVE_ID,
    taskId: TASK_ID,
    permissionLabels: ['internal.project-alpha'],
    occurredAt: '2026-07-28T06:05:00.000Z',
    idempotencyKey: 'collaboration:commit:2',
    type: 'COMMIT',
    payload: {
      committedDueAt: '2026-07-29T05:00:00.000Z',
      outputSchema: { type: 'object', required: ['documentId'] },
      conditions: [],
    },
  });
  return { ...parsed, ...overrides } as CollaborationMessage;
}

function context(
  senderRoleAssignmentId: string,
  overrides: Partial<CollaborationMessageContext> = {},
): CollaborationMessageContext {
  const requester = senderRoleAssignmentId === REQUESTER_ID;
  const userId = requester ? REQUESTER_USER_ID : RECIPIENT_USER_ID;
  return {
    actor: {
      type: 'USER',
      tenantId: TENANT_ID,
      userId,
      agentId: null,
      roleAssignment: {
        id: senderRoleAssignmentId,
        tenantId: TENANT_ID,
        userId,
        agentId: requester
          ? '00000000-0000-7000-8000-000000000022'
          : '00000000-0000-7000-8000-000000000023',
        status: 'ACTIVE',
        employmentStatus: 'ACTIVE',
        orgUnitStatus: 'ACTIVE',
        roleVersionStatus: 'PUBLISHED',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      },
    },
    expectedCausationId: null,
    resolvedDecisionRoleAssignmentIds: [],
    currentDeliveredReference: null,
    deliverable: null,
    acceptance: null,
    evidence: [],
    now: NOW,
    ...overrides,
  };
}

describe('validateCollaborationMessage', () => {
  it('accepts a recipient Commit and advances the authoritative state', () => {
    expect(validateCollaborationMessage(COLLABORATION, message(), context(RECIPIENT_ID))).toEqual({
      valid: true,
      nextStatus: 'COMMITTED',
      errors: [],
    });
  });

  it('fails closed on tenant, trace, revision, permission and actor mismatches', () => {
    const result = validateCollaborationMessage(
      COLLABORATION,
      message({
        tenantId: '00000000-0000-7000-8000-000000000099',
        taskId: '00000000-0000-7000-8000-000000000098',
        revision: 4,
        permissionLabels: ['internal.other'],
        senderRoleAssignmentId: REQUESTER_ID,
        recipientRoleAssignmentIds: [RECIPIENT_ID],
      }),
      context(REQUESTER_ID),
    );
    expect(result.valid).toBe(false);
    expect(result.nextStatus).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'The collaboration message tenant does not match.',
        'The collaboration Objective and Task trace does not match.',
        'The collaboration message revision is stale or out of sequence.',
        'The collaboration message permission labels do not match.',
        'COMMIT must be sent by a recipient.',
      ]),
    );
  });

  it('allows only a recipient to reject a request and only the requester to reject a delivery', () => {
    const rejectRequest = collaborationMessageSchema.parse({
      ...message(),
      type: 'REJECT',
      idempotencyKey: 'collaboration:reject:2',
      payload: {
        acceptanceId: null,
        acceptanceVersion: null,
        nonConformities: ['Capacity is unavailable.'],
        requiredChanges: ['Choose another eligible role assignment.'],
      },
    });
    expect(
      validateCollaborationMessage(COLLABORATION, rejectRequest, context(RECIPIENT_ID)),
    ).toMatchObject({
      valid: true,
      nextStatus: 'REJECTED',
    });

    const delivered = { ...COLLABORATION, status: 'DELIVERED' as const, revision: 3 };
    const deliverableId = '00000000-0000-7000-8000-000000000050';
    const acceptanceId = '00000000-0000-7000-8000-000000000051';
    const requesterReject = collaborationMessageSchema.parse({
      ...rejectRequest,
      revision: 4,
      senderRoleAssignmentId: REQUESTER_ID,
      recipientRoleAssignmentIds: [RECIPIENT_ID],
      payload: {
        ...rejectRequest.payload,
        acceptanceId,
        acceptanceVersion: 1,
      },
    }) as Extract<CollaborationMessage, { type: 'REJECT' }>;
    const rejectionContext = context(REQUESTER_ID, {
      currentDeliveredReference: { deliverableId, deliverableVersion: 1 },
      acceptance: {
        id: acceptanceId,
        version: 1,
        tenantId: TENANT_ID,
        taskId: TASK_ID,
        deliverableId,
        deliverableVersion: 1,
        status: 'ACTIVE',
        decision: 'REJECTED',
        evidenceSealed: true,
        evidenceRefs: [{ evidenceId: EVIDENCE_ID, version: 1 }],
      },
      evidence: [
        {
          id: EVIDENCE_ID,
          version: 1,
          tenantId: TENANT_ID,
          contentHash: CONTENT_HASH,
          active: true,
          sealed: true,
          visibleToActor: true,
        },
      ],
    });
    expect(
      validateCollaborationMessage(delivered, requesterReject, rejectionContext),
    ).toMatchObject({
      valid: true,
      nextStatus: 'REJECTED',
    });
    expect(
      validateCollaborationMessage(
        delivered,
        {
          ...requesterReject,
          senderRoleAssignmentId: RECIPIENT_ID,
          recipientRoleAssignmentIds: [REQUESTER_ID],
        },
        { ...rejectionContext, actor: context(RECIPIENT_ID).actor },
      ),
    ).toMatchObject({ valid: false, nextStatus: null });
  });

  it('requires escalation to address the independent decision role', () => {
    const decisionRoleId = '00000000-0000-7000-8000-000000000010';
    const escalation = collaborationMessageSchema.parse({
      ...message(),
      type: 'ESCALATE',
      idempotencyKey: 'collaboration:escalate:2',
      recipientRoleAssignmentIds: [decisionRoleId],
      payload: {
        decisionRoleAssignmentId: decisionRoleId,
        reason: 'RESOURCE',
        impact: 'The committed date is at risk.',
        requestedDecision: 'Assign additional delivery capacity.',
        evidenceRefs: [
          {
            evidenceId: EVIDENCE_ID,
            version: 1,
            contentHash: CONTENT_HASH,
          },
        ],
      },
    });
    const escalationContext = context(RECIPIENT_ID, {
      resolvedDecisionRoleAssignmentIds: [decisionRoleId],
      evidence: [
        {
          id: EVIDENCE_ID,
          version: 1,
          tenantId: TENANT_ID,
          contentHash: CONTENT_HASH,
          active: true,
          sealed: true,
          visibleToActor: true,
        },
      ],
    });
    expect(
      validateCollaborationMessage(COLLABORATION, escalation, escalationContext),
    ).toMatchObject({
      valid: true,
      nextStatus: 'ESCALATED',
    });
    expect(
      validateCollaborationMessage(
        COLLABORATION,
        {
          ...escalation,
          recipientRoleAssignmentIds: [REQUESTER_ID],
        },
        escalationContext,
      ),
    ).toMatchObject({ valid: false, nextStatus: null });
  });

  it('rejects a second Request against an existing collaboration', () => {
    const request = collaborationMessageSchema.parse({
      ...message(),
      type: 'REQUEST',
      senderRoleAssignmentId: REQUESTER_ID,
      recipientRoleAssignmentIds: [RECIPIENT_ID],
      idempotencyKey: 'collaboration:request:2',
      payload: {
        background: 'Customer commitment requires a solution review.',
        commonGoal: COLLABORATION.commonGoal,
        requestedInput: COLLABORATION.requestedInput,
        dueAt: COLLABORATION.dueAt,
        expectedOutputSchema: COLLABORATION.expectedOutputSchema,
        contextRefs: [{ type: 'TASK', id: TASK_ID, version: 1 }],
      },
    });
    expect(
      validateCollaborationMessage(COLLABORATION, request, context(REQUESTER_ID)),
    ).toMatchObject({
      valid: false,
      nextStatus: null,
    });
  });

  it('binds the claimed sender to the trusted authenticated assignment', () => {
    expect(
      validateCollaborationMessage(
        COLLABORATION,
        message({
          senderRoleAssignmentId: REQUESTER_ID,
          recipientRoleAssignmentIds: [RECIPIENT_ID],
        }),
        context(RECIPIENT_ID),
      ),
    ).toMatchObject({
      valid: false,
      nextStatus: null,
      errors: expect.arrayContaining([
        'The authenticated actor cannot use the claimed sender Role Assignment.',
      ]),
    });
  });

  it('requires exact independent escalation recipients and rejects recipient expansion', () => {
    const decisionRoleId = '00000000-0000-7000-8000-000000000030';
    const arbitraryRoleId = '00000000-0000-7000-8000-000000000031';
    const escalation = collaborationMessageSchema.parse({
      ...message(),
      type: 'ESCALATE',
      idempotencyKey: 'collaboration:escalate:expanded',
      recipientRoleAssignmentIds: [decisionRoleId, arbitraryRoleId],
      payload: {
        decisionRoleAssignmentId: decisionRoleId,
        reason: 'QUALITY',
        impact: 'The decision changes an externally committed outcome.',
        requestedDecision: 'Resolve the independent quality decision.',
        evidenceRefs: [{ evidenceId: EVIDENCE_ID, version: 1, contentHash: CONTENT_HASH }],
      },
    });
    expect(
      validateCollaborationMessage(
        COLLABORATION,
        escalation,
        context(RECIPIENT_ID, {
          resolvedDecisionRoleAssignmentIds: [decisionRoleId],
          evidence: [
            {
              id: EVIDENCE_ID,
              version: 1,
              tenantId: TENANT_ID,
              contentHash: CONTENT_HASH,
              active: true,
              sealed: true,
              visibleToActor: true,
            },
          ],
        }),
      ),
    ).toMatchObject({ valid: false, nextStatus: null });
  });

  it('rejects substituted deliverables and acceptances outside the trusted Task trace', () => {
    const deliverableId = '00000000-0000-7000-8000-000000000040';
    const acceptanceId = '00000000-0000-7000-8000-000000000041';
    const deliver = collaborationMessageSchema.parse({
      ...message(),
      type: 'DELIVER',
      revision: 3,
      idempotencyKey: 'collaboration:deliver:3',
      payload: {
        deliverableId,
        deliverableVersion: 1,
        evidenceRefs: [{ evidenceId: EVIDENCE_ID, version: 1, contentHash: CONTENT_HASH }],
        summary: 'The submitted deliverable is sealed and ready for review.',
      },
    });
    const committed = { ...COLLABORATION, status: 'COMMITTED' as const, revision: 2 };
    const trustedEvidence = {
      id: EVIDENCE_ID,
      version: 1,
      tenantId: TENANT_ID,
      contentHash: CONTENT_HASH,
      active: true,
      sealed: true,
      visibleToActor: true,
    };
    expect(
      validateCollaborationMessage(
        committed,
        deliver,
        context(RECIPIENT_ID, {
          deliverable: {
            id: deliverableId,
            version: 1,
            tenantId: TENANT_ID,
            taskId: '00000000-0000-7000-8000-000000000099',
            status: 'SUBMITTED',
            evidenceSealed: true,
            evidenceRefs: [{ evidenceId: EVIDENCE_ID, version: 1 }],
          },
          evidence: [trustedEvidence],
        }),
      ),
    ).toMatchObject({ valid: false, nextStatus: null });

    const accept = collaborationMessageSchema.parse({
      ...message({
        senderRoleAssignmentId: REQUESTER_ID,
        recipientRoleAssignmentIds: [RECIPIENT_ID],
      }),
      type: 'ACCEPT',
      revision: 4,
      idempotencyKey: 'collaboration:accept:4',
      payload: {
        acceptanceId,
        acceptanceVersion: 1,
        comment: 'The independently verified artifact meets the committed criteria.',
      },
    });
    const delivered = { ...COLLABORATION, status: 'DELIVERED' as const, revision: 3 };
    expect(
      validateCollaborationMessage(
        delivered,
        accept,
        context(REQUESTER_ID, {
          currentDeliveredReference: { deliverableId, deliverableVersion: 1 },
          acceptance: {
            id: acceptanceId,
            version: 1,
            tenantId: TENANT_ID,
            taskId: '00000000-0000-7000-8000-000000000099',
            deliverableId,
            deliverableVersion: 1,
            status: 'ACTIVE',
            decision: 'ACCEPTED',
            evidenceSealed: true,
            evidenceRefs: [{ evidenceId: EVIDENCE_ID, version: 1 }],
          },
          evidence: [trustedEvidence],
        }),
      ),
    ).toMatchObject({ valid: false, nextStatus: null });
  });

  it('rejects a trace when a middle message is hidden', () => {
    const request = collaborationMessageSchema.parse({
      ...message(),
      id: '00000000-0000-7000-8000-000000000060',
      revision: 1,
      causationId: null,
      senderRoleAssignmentId: REQUESTER_ID,
      recipientRoleAssignmentIds: [RECIPIENT_ID],
      occurredAt: COLLABORATION.createdAt,
      idempotencyKey: 'collaboration:request:1',
      type: 'REQUEST',
      payload: {
        background: 'The collaboration requires a complete replayable trace.',
        commonGoal: COLLABORATION.commonGoal,
        requestedInput: COLLABORATION.requestedInput,
        dueAt: COLLABORATION.dueAt,
        expectedOutputSchema: COLLABORATION.expectedOutputSchema,
        contextRefs: [{ type: 'TASK', id: TASK_ID, version: 1 }],
      },
    });
    const commit = collaborationMessageSchema.parse({
      ...message(),
      id: '00000000-0000-7000-8000-000000000061',
      revision: 2,
      causationId: request.id,
      idempotencyKey: 'collaboration:commit:2',
    });
    const deliver = collaborationMessageSchema.parse({
      ...message(),
      id: '00000000-0000-7000-8000-000000000062',
      revision: 3,
      causationId: commit.id,
      occurredAt: '2026-07-28T06:10:00.000Z',
      idempotencyKey: 'collaboration:deliver:3',
      type: 'DELIVER',
      payload: {
        deliverableId: '00000000-0000-7000-8000-000000000063',
        deliverableVersion: 1,
        evidenceRefs: [{ evidenceId: EVIDENCE_ID, version: 1, contentHash: CONTENT_HASH }],
        summary: 'The complete artifact and Evidence set are ready for review.',
      },
    });
    const collaboration = {
      ...COLLABORATION,
      status: 'DELIVERED' as const,
      revision: 3,
      updatedAt: deliver.occurredAt,
    };

    expect(() =>
      collaborationDetailResponseSchema.parse({
        collaboration,
        messages: [request, commit, deliver],
      }),
    ).not.toThrow();
    expect(() =>
      collaborationDetailResponseSchema.parse({
        collaboration,
        messages: [request, deliver],
      }),
    ).toThrow();
  });
});
