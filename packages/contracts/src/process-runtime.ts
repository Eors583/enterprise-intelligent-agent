import { z } from 'zod';

import {
  businessEventEnvelopeSchema,
  collaborationMessageSchema,
  collaborationSchema,
  correctionCaseSchema,
  isCollaborationTransitionAllowed,
  type CollaborationMessage,
  type CollaborationStatus,
} from './business-events.js';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const POSITIVE_INT = z.number().int().positive();
const NON_NEGATIVE_INT = z.number().int().nonnegative();
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const JSON_OBJECT = z.record(z.string(), z.unknown());

export const processInstanceStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED',
]);

export const processStepStatusSchema = z.enum([
  'WAITING',
  'READY',
  'RUNNING',
  'COMPLETED',
  'REJECTED',
  'TIMED_OUT',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED',
  'SKIPPED',
]);

export const processInstanceSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    processDefinitionId: UUID,
    processVersionId: UUID,
    processVersion: POSITIVE_INT,
    objectiveId: UUID,
    taskId: UUID,
    triggerEventId: UUID.nullable(),
    correlationId: UUID,
    status: processInstanceStatusSchema,
    revision: POSITIVE_INT,
    input: JSON_OBJECT,
    output: JSON_OBJECT.nullable(),
    failureCode: z.string().trim().min(1).max(160).nullable(),
    failureDetail: LONG_TEXT.nullable(),
    startedAt: TIMESTAMP.nullable(),
    pausedAt: TIMESTAMP.nullable(),
    completedAt: TIMESTAMP.nullable(),
    cancelledAt: TIMESTAMP.nullable(),
    compensationStartedAt: TIMESTAMP.nullable(),
    compensationCompletedAt: TIMESTAMP.nullable(),
    idempotencyKey: z.string().trim().min(1).max(200),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((instance, context) => {
    if (Date.parse(instance.updatedAt) < Date.parse(instance.createdAt)) {
      issue(context, ['updatedAt'], 'updatedAt cannot precede createdAt.');
    }
    if (
      instance.startedAt !== null &&
      Date.parse(instance.startedAt) < Date.parse(instance.createdAt)
    ) {
      issue(context, ['startedAt'], 'startedAt cannot precede createdAt.');
    }
    if (
      [
        'RUNNING',
        'PAUSED',
        'COMPLETED',
        'FAILED',
        'COMPENSATING',
        'COMPENSATED',
        'COMPENSATION_FAILED',
      ].includes(instance.status) &&
      instance.startedAt === null
    ) {
      issue(context, ['startedAt'], 'A started Process Instance requires startedAt.');
    }
    if (instance.status === 'PAUSED' && instance.pausedAt === null) {
      issue(context, ['pausedAt'], 'A paused Process Instance requires pausedAt.');
    }
    if (instance.status === 'COMPLETED' && instance.completedAt === null) {
      issue(context, ['completedAt'], 'A completed Process Instance requires completedAt.');
    }
    if (instance.status === 'CANCELLED' && instance.cancelledAt === null) {
      issue(context, ['cancelledAt'], 'A cancelled Process Instance requires cancelledAt.');
    }
    if (
      ['COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED'].includes(instance.status) &&
      instance.compensationStartedAt === null
    ) {
      issue(
        context,
        ['compensationStartedAt'],
        'A compensating Process Instance requires compensationStartedAt.',
      );
    }
    if (instance.status === 'COMPENSATED' && instance.compensationCompletedAt === null) {
      issue(
        context,
        ['compensationCompletedAt'],
        'A compensated Process Instance requires compensationCompletedAt.',
      );
    }
    if (
      (instance.failureCode === null) !== (instance.failureDetail === null) ||
      (['FAILED', 'COMPENSATION_FAILED'].includes(instance.status) && instance.failureCode === null)
    ) {
      issue(
        context,
        ['failureCode'],
        'Failure code and detail are required together for failed Process Instances.',
      );
    }
  });

export const processStepInstanceSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    processInstanceId: UUID,
    processNodeId: UUID,
    processNodeCode: z.string().trim().min(1).max(100),
    attempt: POSITIVE_INT.max(100),
    status: processStepStatusSchema,
    revision: POSITIVE_INT,
    resolvedRoleAssignmentId: UUID.nullable(),
    resolvedAgentId: UUID.nullable(),
    assignmentSnapshot: JSON_OBJECT.nullable(),
    input: JSON_OBJECT,
    output: JSON_OBJECT.nullable(),
    availableAt: TIMESTAMP,
    claimedAt: TIMESTAMP.nullable(),
    startedAt: TIMESTAMP.nullable(),
    dueAt: TIMESTAMP.nullable(),
    completedAt: TIMESTAMP.nullable(),
    timedOutAt: TIMESTAMP.nullable(),
    failureCode: z.string().trim().min(1).max(160).nullable(),
    failureDetail: LONG_TEXT.nullable(),
    compensationForStepId: UUID.nullable(),
    idempotencyKey: z.string().trim().min(1).max(200),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((step, context) => {
    if (Date.parse(step.updatedAt) < Date.parse(step.createdAt)) {
      issue(context, ['updatedAt'], 'updatedAt cannot precede createdAt.');
    }
    if (step.dueAt !== null && Date.parse(step.dueAt) <= Date.parse(step.availableAt)) {
      issue(context, ['dueAt'], 'dueAt must be later than availableAt.');
    }
    if (
      [
        'RUNNING',
        'COMPLETED',
        'REJECTED',
        'FAILED',
        'COMPENSATING',
        'COMPENSATED',
        'COMPENSATION_FAILED',
      ].includes(step.status) &&
      step.startedAt === null
    ) {
      issue(context, ['startedAt'], 'A started Process Step requires startedAt.');
    }
    if (
      ['COMPLETED', 'REJECTED', 'COMPENSATED'].includes(step.status) &&
      step.completedAt === null
    ) {
      issue(context, ['completedAt'], 'A terminal Process Step requires completedAt.');
    }
    if (step.status === 'TIMED_OUT' && step.timedOutAt === null) {
      issue(context, ['timedOutAt'], 'A timed out Process Step requires timedOutAt.');
    }
    if (
      (step.failureCode === null) !== (step.failureDetail === null) ||
      (['FAILED', 'COMPENSATION_FAILED'].includes(step.status) && step.failureCode === null)
    ) {
      issue(
        context,
        ['failureCode'],
        'Failure code and detail are required together for failed Process Steps.',
      );
    }
  });

export const processCommandSchema = z
  .object({
    processInstanceId: UUID,
    expectedRevision: POSITIVE_INT,
    command: z.enum([
      'START',
      'PAUSE',
      'RESUME',
      'COMPLETE',
      'FAIL',
      'CANCEL',
      'BEGIN_COMPENSATION',
      'COMPLETE_COMPENSATION',
      'FAIL_COMPENSATION',
    ]),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
    idempotencyKey: z.string().trim().min(1).max(200),
    output: JSON_OBJECT.optional(),
    failureCode: z.string().trim().min(1).max(160).optional(),
    failureDetail: LONG_TEXT.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    const failureCommand = command.command === 'FAIL' || command.command === 'FAIL_COMPENSATION';
    const hasAnyFailure = command.failureCode !== undefined || command.failureDetail !== undefined;
    const hasCompleteFailure =
      command.failureCode !== undefined && command.failureDetail !== undefined;
    if ((failureCommand && !hasCompleteFailure) || (!failureCommand && hasAnyFailure)) {
      issue(
        context,
        ['failureCode'],
        'Failure commands require both failureCode and failureDetail; other commands forbid them.',
      );
    }
  });

export const processStepCommandSchema = z
  .object({
    stepInstanceId: UUID,
    expectedRevision: POSITIVE_INT,
    command: z.enum([
      'ACTIVATE',
      'CLAIM',
      'COMPLETE',
      'REJECT',
      'TIMEOUT',
      'FAIL',
      'RETRY',
      'CANCEL',
      'SKIP',
      'BEGIN_COMPENSATION',
      'COMPLETE_COMPENSATION',
      'FAIL_COMPENSATION',
    ]),
    actorRoleAssignmentId: UUID.nullable(),
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
    idempotencyKey: z.string().trim().min(1).max(200),
    output: JSON_OBJECT.optional(),
    failureCode: z.string().trim().min(1).max(160).optional(),
    failureDetail: LONG_TEXT.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    const failureCommand = command.command === 'FAIL' || command.command === 'FAIL_COMPENSATION';
    const hasAnyFailure = command.failureCode !== undefined || command.failureDetail !== undefined;
    const hasCompleteFailure =
      command.failureCode !== undefined && command.failureDetail !== undefined;
    if ((failureCommand && !hasCompleteFailure) || (!failureCommand && hasAnyFailure)) {
      issue(
        context,
        ['failureCode'],
        'Failure commands require both failureCode and failureDetail; other commands forbid them.',
      );
    }
    if (
      ['CLAIM', 'COMPLETE', 'REJECT', 'FAIL'].includes(command.command) &&
      command.actorRoleAssignmentId === null
    ) {
      issue(
        context,
        ['actorRoleAssignmentId'],
        'Actor-executed step commands require a Role Assignment identity.',
      );
    }
  });

export const businessEventDeliveryStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'RETRY_SCHEDULED',
  'DEAD_LETTERED',
]);

export const businessEventDeliverySchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    businessEventId: UUID,
    consumerName: z.string().trim().min(1).max(160),
    status: businessEventDeliveryStatusSchema,
    revision: POSITIVE_INT,
    attempts: NON_NEGATIVE_INT.max(1_000),
    availableAt: TIMESTAMP,
    lockedBy: z.string().trim().min(1).max(160).nullable(),
    lockedUntil: TIMESTAMP.nullable(),
    processedAt: TIMESTAMP.nullable(),
    deadLetteredAt: TIMESTAMP.nullable(),
    lastErrorCode: z.string().trim().min(1).max(160).nullable(),
    lastErrorDetail: LONG_TEXT.nullable(),
    replayCount: NON_NEGATIVE_INT,
    replayedAt: TIMESTAMP.nullable(),
    replayedByUserId: UUID.nullable(),
    replayReason: SHORT_TEXT.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((delivery, context) => {
    if ((delivery.lockedBy === null) !== (delivery.lockedUntil === null)) {
      issue(context, ['lockedUntil'], 'A delivery lease requires both lockedBy and lockedUntil.');
    }
    if (delivery.status === 'PROCESSING' && delivery.lockedUntil === null) {
      issue(context, ['lockedUntil'], 'A processing delivery requires a lease.');
    }
    if (delivery.status === 'PROCESSED' && delivery.processedAt === null) {
      issue(context, ['processedAt'], 'A processed delivery requires processedAt.');
    }
    if (delivery.status === 'DEAD_LETTERED' && delivery.deadLetteredAt === null) {
      issue(context, ['deadLetteredAt'], 'A dead-lettered delivery requires deadLetteredAt.');
    }
    if (
      (delivery.lastErrorCode === null) !== (delivery.lastErrorDetail === null) ||
      (['RETRY_SCHEDULED', 'DEAD_LETTERED'].includes(delivery.status) &&
        delivery.lastErrorCode === null)
    ) {
      issue(
        context,
        ['lastErrorCode'],
        'Retry and dead-letter states require an error code and detail.',
      );
    }
    const hasReplayAttribution =
      delivery.replayedAt !== null &&
      delivery.replayedByUserId !== null &&
      delivery.replayReason !== null;
    if (
      (delivery.replayCount === 0 && hasReplayAttribution) ||
      (delivery.replayCount > 0 && !hasReplayAttribution) ||
      (delivery.replayedAt === null) !== (delivery.replayedByUserId === null) ||
      (delivery.replayedAt === null) !== (delivery.replayReason === null)
    ) {
      issue(
        context,
        ['replayCount'],
        'Replay attribution must be complete exactly when replayCount is positive.',
      );
    }
  });

export const replayBusinessEventDeliveryRequestSchema = z
  .object({
    expectedStatus: z.literal('DEAD_LETTERED'),
    reason: SHORT_TEXT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const correctionFeedbackRequestSchema = z
  .object({
    expectedRevision: POSITIVE_INT,
    action: z.enum(['ACKNOWLEDGE', 'ACCEPT', 'REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE', 'CANCEL']),
    comment: LONG_TEXT,
    evidenceIds: z.array(UUID).max(500).refine(uniqueStrings, 'Evidence IDs must be unique.'),
    effectiveAt: TIMESTAMP,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(
    (feedback) =>
      !['REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE'].includes(feedback.action) ||
      feedback.evidenceIds.length > 0,
    {
      message: 'This correction feedback action requires evidence.',
      path: ['evidenceIds'],
    },
  );

export const runtimeCursorPageInfoSchema = z
  .object({
    nextCursor: z.string().trim().min(1).max(2_000).nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .refine((page) => page.hasMore === (page.nextCursor !== null), {
    message: 'hasMore and nextCursor must agree.',
    path: ['nextCursor'],
  });

export const processInstanceListResponseSchema = z
  .object({
    items: z.array(processInstanceSchema).max(500),
    pageInfo: runtimeCursorPageInfoSchema,
  })
  .strict();

export const processInstanceDetailResponseSchema = z
  .object({
    instance: processInstanceSchema,
    steps: z.array(processStepInstanceSchema).max(10_000),
  })
  .strict()
  .refine(
    (response) =>
      response.steps.every(
        (step) =>
          step.tenantId === response.instance.tenantId &&
          step.processInstanceId === response.instance.id,
      ),
    {
      message: 'Every Process Step must belong to the Process Instance.',
      path: ['steps'],
    },
  );

export const businessEventListResponseSchema = z
  .object({
    items: z.array(businessEventEnvelopeSchema).max(500),
    pageInfo: runtimeCursorPageInfoSchema,
  })
  .strict();

export const businessEventDetailResponseSchema = z
  .object({
    event: businessEventEnvelopeSchema,
    deliveries: z.array(businessEventDeliverySchema).max(5_000),
  })
  .strict()
  .refine(
    (response) =>
      response.deliveries.every(
        (delivery) =>
          delivery.tenantId === response.event.tenantId &&
          delivery.businessEventId === response.event.eventId,
      ),
    {
      message: 'Every delivery must belong to the Business Event.',
      path: ['deliveries'],
    },
  );

export const collaborationListResponseSchema = z
  .object({
    items: z.array(collaborationSchema).max(500),
    pageInfo: runtimeCursorPageInfoSchema,
  })
  .strict();

export const collaborationDetailResponseSchema = z
  .object({
    collaboration: collaborationSchema,
    messages: z.array(collaborationMessageSchema).max(10_000),
  })
  .strict()
  .superRefine((response, context) => {
    const { collaboration, messages } = response;
    if (
      messages.length !== collaboration.revision ||
      messages.length === 0 ||
      messages.some(
        (message) =>
          message.tenantId !== collaboration.tenantId ||
          message.collaborationId !== collaboration.id ||
          message.correlationId !== collaboration.correlationId ||
          message.objectiveId !== collaboration.objectiveId ||
          message.taskId !== collaboration.taskId ||
          !sameStringSet(message.permissionLabels, collaboration.permissionLabels),
      )
    ) {
      issue(context, ['messages'], 'The complete Collaboration trace is required.');
      return;
    }
    if (
      !uniqueStrings(messages.map((message) => message.id)) ||
      !uniqueStrings(messages.map((message) => message.idempotencyKey))
    ) {
      issue(context, ['messages'], 'Collaboration trace identities must be unique.');
    }

    let status: CollaborationStatus | null = null;
    for (const [index, message] of messages.entries()) {
      const previous = messages[index - 1];
      if (message.revision !== index + 1) {
        issue(context, ['messages', index, 'revision'], 'Message revisions must be contiguous.');
      }
      if (index === 0) {
        if (
          message.type !== 'REQUEST' ||
          message.causationId !== null ||
          message.senderRoleAssignmentId !== collaboration.requesterRoleAssignmentId ||
          !sameStringSet(
            message.recipientRoleAssignmentIds,
            collaboration.recipientRoleAssignmentIds,
          )
        ) {
          issue(
            context,
            ['messages', index],
            'A Collaboration trace must begin with its authoritative Request.',
          );
        } else {
          status = 'REQUESTED';
        }
        continue;
      }
      if (
        previous === undefined ||
        message.causationId !== previous.id ||
        Date.parse(message.occurredAt) < Date.parse(previous.occurredAt)
      ) {
        issue(
          context,
          ['messages', index, 'causationId'],
          'Collaboration messages must form one monotonic causation chain.',
        );
      }
      const nextStatus = collaborationMessageStatus(message);
      if (
        message.type === 'REQUEST' ||
        status === null ||
        !isCollaborationTransitionAllowed(status, nextStatus)
      ) {
        issue(
          context,
          ['messages', index, 'type'],
          'The Collaboration trace contains an illegal state transition.',
        );
      } else {
        status = nextStatus;
      }
    }
    const latest = messages.at(-1);
    if (
      status !== collaboration.status ||
      latest === undefined ||
      Date.parse(collaboration.updatedAt) < Date.parse(latest.occurredAt)
    ) {
      issue(
        context,
        ['collaboration', 'status'],
        'Collaboration state must equal the final complete trace state.',
      );
    }
  });

export const correctionCaseListResponseSchema = z
  .object({
    items: z.array(correctionCaseSchema).max(500),
    pageInfo: runtimeCursorPageInfoSchema,
  })
  .strict();

export type ProcessInstance = z.infer<typeof processInstanceSchema>;
export type ProcessInstanceStatus = z.infer<typeof processInstanceStatusSchema>;
export type ProcessStepInstance = z.infer<typeof processStepInstanceSchema>;
export type ProcessStepStatus = z.infer<typeof processStepStatusSchema>;
export type ProcessCommand = z.infer<typeof processCommandSchema>;
export type ProcessStepCommand = z.infer<typeof processStepCommandSchema>;
export type BusinessEventDelivery = z.infer<typeof businessEventDeliverySchema>;
export type CorrectionFeedbackRequest = z.infer<typeof correctionFeedbackRequestSchema>;
export type ProcessInstanceListResponse = z.infer<typeof processInstanceListResponseSchema>;
export type ProcessInstanceDetailResponse = z.infer<typeof processInstanceDetailResponseSchema>;
export type BusinessEventListResponse = z.infer<typeof businessEventListResponseSchema>;
export type BusinessEventDetailResponse = z.infer<typeof businessEventDetailResponseSchema>;
export type CollaborationListResponse = z.infer<typeof collaborationListResponseSchema>;
export type CollaborationDetailResponse = z.infer<typeof collaborationDetailResponseSchema>;
export type CorrectionCaseListResponse = z.infer<typeof correctionCaseListResponseSchema>;

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function collaborationMessageStatus(message: CollaborationMessage): CollaborationStatus {
  switch (message.type) {
    case 'REQUEST':
      return 'REQUESTED';
    case 'COMMIT':
      return 'COMMITTED';
    case 'DELIVER':
      return 'DELIVERED';
    case 'ACCEPT':
      return 'ACCEPTED';
    case 'REJECT':
      return 'REJECTED';
    case 'ESCALATE':
      return 'ESCALATED';
    case 'CANCEL':
      return 'CANCELLED';
  }
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}
