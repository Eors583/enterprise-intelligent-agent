import {
  collaborationDetailResponseSchema,
  collaborationSchema,
  correctionCaseSchema,
  type Collaboration,
  type CollaborationDetailResponse,
  type CorrectionCase,
} from '@enterprise/contracts';

import { taskFixture } from './test-fixtures';

const tenantId = '10000000-0000-7000-8000-000000000001';

export const interactionId = (number: number): string =>
  `00000000-0000-7000-8000-${String(number).padStart(12, '0')}`;

export function collaborationFixture(overrides: Partial<Collaboration> = {}): Collaboration {
  return collaborationSchema.parse({
    id: interactionId(201),
    tenantId,
    correlationId: interactionId(202),
    objectiveId: interactionId(30),
    taskId: taskFixture().id,
    requesterRoleAssignmentId: interactionId(203),
    recipientRoleAssignmentIds: [interactionId(204)],
    status: 'REQUESTED',
    revision: 1,
    commonGoal: '恢复客户留存目标并按期交付风险清单。',
    requestedInput: '提供已校验的高风险客户分群与处理建议。',
    expectedOutputSchema: {
      type: 'object',
      required: ['artifactUri', 'evidenceIds'],
    },
    dueAt: '2026-07-30T09:00:00.000Z',
    permissionLabels: ['internal.customer-success'],
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...overrides,
  });
}

export function collaborationDetailFixture(
  collaboration = collaborationFixture(),
): CollaborationDetailResponse {
  const requestMessage = {
    id: interactionId(205),
    tenantId,
    collaborationId: collaboration.id,
    schemaVersion: 1,
    revision: 1,
    correlationId: collaboration.correlationId,
    causationId: null,
    senderRoleAssignmentId: collaboration.requesterRoleAssignmentId,
    recipientRoleAssignmentIds: collaboration.recipientRoleAssignmentIds,
    objectiveId: collaboration.objectiveId,
    taskId: collaboration.taskId,
    permissionLabels: collaboration.permissionLabels,
    occurredAt: '2026-07-28T09:00:00.000Z',
    idempotencyKey: 'collaboration:retention:request:1',
    type: 'REQUEST' as const,
    payload: {
      background: '客户留存指标偏离目标。',
      commonGoal: collaboration.commonGoal,
      requestedInput: collaboration.requestedInput,
      dueAt: collaboration.dueAt,
      expectedOutputSchema: collaboration.expectedOutputSchema,
      contextRefs: [
        {
          type: 'TASK' as const,
          id: collaboration.taskId,
          version: taskFixture().version,
        },
      ],
    },
  };
  const messages: unknown[] = [requestMessage];

  if (
    collaboration.status === 'COMMITTED' ||
    collaboration.status === 'DELIVERED' ||
    collaboration.status === 'ACCEPTED'
  ) {
    messages.push({
      ...requestMessage,
      id: interactionId(206),
      revision: 2,
      causationId: requestMessage.id,
      senderRoleAssignmentId: collaboration.recipientRoleAssignmentIds[0],
      recipientRoleAssignmentIds: [collaboration.requesterRoleAssignmentId],
      occurredAt: '2026-07-28T09:00:00.000Z',
      idempotencyKey: 'collaboration:retention:commit:2',
      type: 'COMMIT',
      payload: {
        committedDueAt: collaboration.dueAt,
        outputSchema: collaboration.expectedOutputSchema,
        conditions: [],
      },
    });
  }
  if (collaboration.status === 'DELIVERED' || collaboration.status === 'ACCEPTED') {
    messages.push({
      ...requestMessage,
      id: interactionId(207),
      revision: 3,
      causationId: interactionId(206),
      senderRoleAssignmentId: collaboration.recipientRoleAssignmentIds[0],
      recipientRoleAssignmentIds: [collaboration.requesterRoleAssignmentId],
      occurredAt: '2026-07-28T09:00:00.000Z',
      idempotencyKey: 'collaboration:retention:deliver:3',
      type: 'DELIVER',
      payload: {
        deliverableId: interactionId(209),
        deliverableVersion: 1,
        evidenceRefs: [{ evidenceId: interactionId(210), version: 1, contentHash: null }],
        summary: 'Validated retention-risk customer segments and recommended actions.',
      },
    });
  }
  if (collaboration.status === 'ACCEPTED') {
    messages.push({
      ...requestMessage,
      id: interactionId(208),
      revision: 4,
      causationId: interactionId(207),
      senderRoleAssignmentId: collaboration.requesterRoleAssignmentId,
      recipientRoleAssignmentIds: collaboration.recipientRoleAssignmentIds,
      occurredAt: '2026-07-28T09:00:00.000Z',
      idempotencyKey: 'collaboration:retention:accept:4',
      type: 'ACCEPT',
      payload: {
        acceptanceId: interactionId(220),
        acceptanceVersion: 1,
        comment: 'The delivered retention-risk analysis meets the requested contract.',
      },
    });
  }

  return collaborationDetailResponseSchema.parse({
    collaboration,
    messages,
  });
}

export function correctionFixture(overrides: Partial<CorrectionCase> = {}): CorrectionCase {
  return correctionCaseSchema.parse({
    id: interactionId(211),
    tenantId,
    correlationId: interactionId(202),
    subject: { type: 'TASK', id: taskFixture().id, version: taskFixture().version },
    roleAssignmentId: interactionId(203),
    objectiveId: interactionId(30),
    taskId: taskFixture().id,
    processInstanceId: interactionId(212),
    trigger: '客户留存任务已偏离承诺里程碑。',
    category: 'OBJECTIVE_DEVIATION',
    severity: 'HIGH',
    confidence: 0.91,
    ruleFindings: ['关键交付物在截止日前仍未提交。'],
    modelFinding: '当前活动对留存目标的贡献度不足。',
    evidenceRefs: [
      {
        evidenceId: interactionId(213),
        version: 1,
        contentHash: null,
      },
    ],
    impact: '客户留存目标可能无法在承诺日期前达成。',
    suggestedActions: ['暂停非关键工作并完成高风险客户干预清单。'],
    requiredRoleAssignmentIds: [interactionId(204)],
    status: 'OPEN',
    revision: 2,
    permissionLabels: ['internal.customer-success'],
    createdAt: '2026-07-28T09:05:00.000Z',
    updatedAt: '2026-07-28T09:05:00.000Z',
    ...overrides,
  });
}

export function runtimePage<T>(items: T[]): {
  items: T[];
  pageInfo: { nextCursor: null; hasMore: false };
} {
  return { items, pageInfo: { nextCursor: null, hasMore: false } };
}
