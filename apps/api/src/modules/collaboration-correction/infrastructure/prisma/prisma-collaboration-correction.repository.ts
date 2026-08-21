import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  correctionCaseSchema,
  type Collaboration,
  type CollaborationCandidate,
  type CollaborationCommandRequest,
  type CollaborationDetailResponse,
  type CollaborationMessage,
  type CorrectionCase,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import type {
  RuntimeCursorPage,
  RuntimeMutationResult,
} from '../../../process-orchestration/application/runtime-mutation-result.js';
import {
  appendRuntimeAuditAndOutbox,
  databaseErrorText,
  decodeRuntimeCursor,
  encodeRuntimeCursor,
  isDatabaseConflict,
  isDatabaseRejection,
  jsonArray,
  jsonObject,
  runtimeHash,
  stringArray,
  withProcessTenant,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import type { AuthorizedRuntimeTaskScope } from '../../collaboration-correction-authorization.port.js';
import {
  CollaborationCorrectionRepository,
  type ApplyCollaborationCommandInput,
  type ApplyCorrectionFeedbackInput,
  type CreateCollaborationInput,
} from '../../collaboration-correction.repository.js';

@Injectable()
export class PrismaCollaborationCorrectionRepository extends CollaborationCorrectionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async listCollaborationCandidates(
    scope: AuthorizedRuntimeTaskScope,
  ): Promise<readonly CollaborationCandidate[]> {
    return this.prisma.withTenant(scope.tenantId, async (transaction) => {
      const task = await findTaskContext(transaction, scope, false);
      if (task === null) return [];
      const candidates = await loadEligibleCollaborationAssignments(
        transaction,
        task,
        scope.userId,
      );
      return candidates.map((candidate) => ({
        roleAssignmentId: candidate.role_assignment_id,
        userId: candidate.user_id,
        userName: candidate.user_name,
        roleName: candidate.role_name,
        orgUnitName: candidate.org_unit_name,
        canActAsRequester:
          candidate.user_id === scope.userId &&
          (scope.managementBypass ||
            scope.roleAssignmentIds.includes(candidate.role_assignment_id)),
      }));
    });
  }

  async createCollaboration(
    input: CreateCollaborationInput,
  ): Promise<RuntimeMutationResult<CollaborationDetailResponse>> {
    if (!coherentMutationIdentity(input)) {
      return invariantRejection(
        'Trusted principal and collaboration authorization scope are inconsistent.',
      );
    }
    const requestHash = collaborationCreateRequestHash(input);
    try {
      return await withProcessTenant(this.prisma, input.scope.tenantId, async (transaction) => {
        const existing = await findCollaborationByIdempotencyKey(
          transaction,
          input.scope.tenantId,
          input.request.idempotencyKey,
        );
        if (existing !== null) {
          if (existing.task_id !== input.scope.taskId || existing.request_hash !== requestHash) {
            return { kind: 'IDEMPOTENCY_CONFLICT' };
          }
          const value = await loadCollaborationDetailInTransaction(
            transaction,
            input.scope,
            existing.id,
          );
          return value === null
            ? invariantRejection('The persisted Collaboration trace is incomplete.')
            : { kind: 'IDEMPOTENT_REPLAY', value };
        }

        const task = await findTaskContext(transaction, input.scope, true);
        if (task === null) return { kind: 'NOT_FOUND' };
        if (!ACTIVE_COLLABORATION_TASK_STATUSES.has(task.status)) {
          return invariantRejection('A Collaboration can only be created for an active Task.');
        }

        const now = await databaseNow(transaction);
        const dueAt = new Date(input.request.dueAt);
        if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= now.getTime()) {
          return invariantRejection('Collaboration dueAt must be later than server time.');
        }

        const eligible = await loadEligibleCollaborationAssignments(
          transaction,
          task,
          input.scope.userId,
        );
        const acting = chooseRequesterAssignment(input, eligible);
        if (acting === null) {
          return invariantRejection(
            'The current user has no unique active Role Assignment authorized to execute this Task.',
          );
        }
        const recipients = resolveExactAssignments(
          eligible,
          input.request.recipientRoleAssignmentIds,
        );
        if (
          recipients === null ||
          !assignmentsHaveIndependentIdentities([acting, ...(recipients ?? [])])
        ) {
          return invariantRejection(
            'Every Collaboration participant must resolve to a distinct active user and agent identity for this Task.',
          );
        }

        const collaborationId = randomUUID();
        const correlationId = randomUUID();
        const messageId = randomUUID();
        const permissionLabels = stringArray(task.permission_labels);
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."collaborations" (
            "id", "tenant_id", "correlation_id",
            "objective_id", "objective_version", "task_id", "task_version",
            "requester_role_assignment_id", "status", "revision",
            "common_goal", "requested_input", "expected_output_schema", "due_at",
            "permission_labels", "idempotency_key", "request_hash",
            "created_at", "updated_at"
          ) VALUES (
            ${collaborationId}::uuid,
            ${input.scope.tenantId}::uuid,
            ${correlationId}::uuid,
            ${task.objective_id}::uuid,
            ${task.objective_version},
            ${task.id}::uuid,
            ${task.version},
            ${acting.role_assignment_id}::uuid,
            'REQUESTED'::public."CollaborationStatus",
            0,
            ${input.request.commonGoal},
            ${input.request.requestedInput},
            ${JSON.stringify(input.request.expectedOutputSchema)}::jsonb,
            ${dueAt},
            ${JSON.stringify(permissionLabels)}::jsonb,
            ${input.request.idempotencyKey},
            ${requestHash},
            ${now},
            ${now}
          )
        `);
        await insertCollaborationParticipant(
          transaction,
          input.scope.tenantId,
          collaborationId,
          acting,
          'REQUESTER',
        );
        for (const recipient of recipients) {
          await insertCollaborationParticipant(
            transaction,
            input.scope.tenantId,
            collaborationId,
            recipient,
            'RECIPIENT',
          );
        }

        const recipientIds = recipients.map((recipient) => recipient.role_assignment_id).sort();
        const payload = {
          background: input.request.background,
          commonGoal: input.request.commonGoal,
          requestedInput: input.request.requestedInput,
          dueAt: dueAt.toISOString(),
          expectedOutputSchema: input.request.expectedOutputSchema,
          contextRefs: input.request.contextRefs,
        };
        const messageHash = collaborationMessageHash({
          id: messageId,
          collaborationId,
          revision: 1,
          type: 'REQUEST',
          senderRoleAssignmentId: acting.role_assignment_id,
          recipientRoleAssignmentIds: recipientIds,
          payload,
          previousHash: null,
          occurredAt: now,
        });
        await insertCollaborationMessage(transaction, {
          id: messageId,
          tenantId: input.scope.tenantId,
          collaborationId,
          revision: 1,
          correlationId,
          causationId: null,
          type: 'REQUEST',
          senderUserId: input.principal.userId,
          senderRoleAssignmentId: acting.role_assignment_id,
          recipientRoleAssignmentIds: recipientIds,
          objectiveId: task.objective_id,
          objectiveVersion: task.objective_version,
          taskId: task.id,
          taskVersion: task.version,
          permissionLabels,
          payload,
          occurredAt: now,
          idempotencyKey: requestMessageKey(input.request.idempotencyKey),
          previousHash: null,
          messageHash,
        });
        await insertCollaborationMessageRecipients(
          transaction,
          input.scope.tenantId,
          messageId,
          recipientIds,
        );

        const value = await loadCollaborationDetailInTransaction(
          transaction,
          input.scope,
          collaborationId,
        );
        if (
          value === null ||
          value.collaboration.revision !== 1 ||
          value.messages.at(-1)?.id !== messageId
        ) {
          throw new Error('The Collaboration REQUEST did not advance its immutable trace.');
        }
        const eventPayload = {
          collaboration: value.collaboration,
          message: value.messages.at(-1),
          requestHash,
        };
        await insertCollaborationBusinessEvent(transaction, {
          id: randomUUID(),
          scope: input.scope,
          task,
          collaborationId,
          correlationId,
          messageId,
          revision: 1,
          eventType: 'Collaboration.Requested',
          idempotencyKey: collaborationEventKey(
            `create:${task.id}:${input.request.idempotencyKey}`,
          ),
          payload: eventPayload,
          evidence: [],
          occurredAt: now,
          causationId: null,
        });
        await appendRuntimeAuditAndOutbox(transaction, input.principal, {
          action: 'collaboration.create',
          resourceType: 'COLLABORATION',
          resourceId: collaborationId,
          eventType: 'Collaboration.Requested',
          payload: eventPayload,
          occurredAt: now,
        });
        return { kind: 'APPLIED', value };
      });
    } catch (error) {
      return mapCollaborationMutationError(error, 0);
    }
  }

  async applyCollaborationCommand(
    input: ApplyCollaborationCommandInput,
  ): Promise<RuntimeMutationResult<CollaborationDetailResponse>> {
    if (!coherentMutationIdentity(input)) {
      return invariantRejection(
        'Trusted principal and collaboration authorization scope are inconsistent.',
      );
    }
    const requestHash = collaborationCommandRequestHash(input);
    try {
      return await withProcessTenant(this.prisma, input.scope.tenantId, async (transaction) => {
        const prior = await findCollaborationMessageByIdempotencyKey(
          transaction,
          input.scope.tenantId,
          input.request.idempotencyKey,
        );
        if (prior !== null) {
          const priorRequestHash = await loadCollaborationEventRequestHash(
            transaction,
            input.scope.tenantId,
            prior.id,
          );
          if (
            prior.collaboration_id !== input.collaborationId ||
            prior.type !== input.request.type ||
            prior.revision !== input.request.expectedRevision + 1 ||
            prior.sender_user_id !== input.principal.userId ||
            priorRequestHash !== requestHash
          ) {
            return { kind: 'IDEMPOTENCY_CONFLICT' };
          }
          const value = await loadCollaborationDetailInTransaction(
            transaction,
            input.scope,
            input.collaborationId,
          );
          return value === null
            ? invariantRejection('The persisted Collaboration command trace is incomplete.')
            : { kind: 'IDEMPOTENT_REPLAY', value };
        }

        const current = await findCollaborationForMutation(
          transaction,
          input.scope,
          input.collaborationId,
        );
        if (current === null) return { kind: 'NOT_FOUND' };
        if (current.revision !== input.request.expectedRevision) {
          return { kind: 'STALE_REVISION', currentRevision: current.revision };
        }
        const task = await findTaskContext(transaction, input.scope, false);
        if (
          task === null ||
          task.version !== current.task_version ||
          task.objective_id !== current.objective_id ||
          task.objective_version !== current.objective_version
        ) {
          return invariantRejection(
            'The Collaboration no longer resolves to its immutable Task version.',
          );
        }
        const sender = await chooseCommandSender(transaction, input, current);
        if (sender === null) {
          return invariantRejection(
            'The current user is not an active Collaboration participant for this command.',
          );
        }

        if (input.request.type === 'ESCALATE') {
          const decisionRoleAssignmentId = input.request.payload.decisionRoleAssignmentId;
          const candidates = await loadEligibleCollaborationAssignments(
            transaction,
            task,
            input.scope.userId,
          );
          const decision = candidates.find(
            (candidate) => candidate.role_assignment_id === decisionRoleAssignmentId,
          );
          if (decision === undefined) {
            return invariantRejection(
              'The requested decision Role Assignment is not authorized for this Task.',
            );
          }
          const participantIds = await loadParticipantAssignmentIds(
            transaction,
            input.scope.tenantId,
            input.collaborationId,
          );
          if (participantIds.includes(decision.role_assignment_id)) {
            return invariantRejection(
              'The decision Role Assignment must be independent from existing participants.',
            );
          }
          await insertCollaborationParticipant(
            transaction,
            input.scope.tenantId,
            input.collaborationId,
            decision,
            'DECISION',
          );
        }

        const recipientIds = await loadCommandRecipientIds(
          transaction,
          input.scope.tenantId,
          input.collaborationId,
          sender.role_assignment_id,
          input.request.type,
        );
        if (recipientIds.length === 0) {
          return invariantRejection('The Collaboration command has no authorized recipient.');
        }
        const evidence = await loadCommandEvidence(transaction, input.scope, input.request);
        if (evidence === null) {
          return invariantRejection(
            'Collaboration evidence must resolve to exact active verified tenant-owned versions.',
          );
        }
        const payload = commandPayloadWithTrustedEvidence(input.request, evidence);
        const now = await databaseNow(transaction);
        const messageId = randomUUID();
        const nextRevision = current.revision + 1;
        const messageHash = collaborationMessageHash({
          id: messageId,
          collaborationId: current.id,
          revision: nextRevision,
          type: input.request.type,
          senderRoleAssignmentId: sender.role_assignment_id,
          recipientRoleAssignmentIds: recipientIds,
          payload,
          previousHash: current.latest_message_hash,
          occurredAt: now,
        });
        await insertCollaborationMessage(transaction, {
          id: messageId,
          tenantId: input.scope.tenantId,
          collaborationId: current.id,
          revision: nextRevision,
          correlationId: current.correlation_id,
          causationId: current.latest_message_id,
          type: input.request.type,
          senderUserId: input.principal.userId,
          senderRoleAssignmentId: sender.role_assignment_id,
          recipientRoleAssignmentIds: recipientIds,
          objectiveId: current.objective_id,
          objectiveVersion: current.objective_version,
          taskId: current.task_id,
          taskVersion: current.task_version,
          permissionLabels: stringArray(current.permission_labels),
          payload,
          occurredAt: now,
          idempotencyKey: input.request.idempotencyKey,
          previousHash: current.latest_message_hash,
          messageHash,
        });
        await insertCollaborationMessageRecipients(
          transaction,
          input.scope.tenantId,
          messageId,
          recipientIds,
        );
        await insertCollaborationMessageEvidence(
          transaction,
          input.scope.tenantId,
          messageId,
          evidence,
        );

        const value = await loadCollaborationDetailInTransaction(
          transaction,
          input.scope,
          input.collaborationId,
        );
        if (
          value === null ||
          value.collaboration.revision !== nextRevision ||
          value.messages.at(-1)?.id !== messageId
        ) {
          throw new Error('The Collaboration command did not advance its immutable trace.');
        }
        const previousEventId = await findCollaborationEventIdForMessage(
          transaction,
          input.scope.tenantId,
          current.latest_message_id,
        );
        const eventPayload = {
          collaboration: value.collaboration,
          message: value.messages.at(-1),
          requestHash,
        };
        const eventType = collaborationEventType(input.request.type);
        await insertCollaborationBusinessEvent(transaction, {
          id: randomUUID(),
          scope: input.scope,
          task,
          collaborationId: current.id,
          correlationId: current.correlation_id,
          messageId,
          revision: nextRevision,
          eventType,
          idempotencyKey: collaborationEventKey(
            `command:${current.id}:${input.request.idempotencyKey}`,
          ),
          payload: eventPayload,
          evidence,
          occurredAt: now,
          causationId: previousEventId,
        });
        await appendRuntimeAuditAndOutbox(transaction, input.principal, {
          action: `collaboration.${input.request.type.toLowerCase()}`,
          resourceType: 'COLLABORATION',
          resourceId: current.id,
          eventType,
          payload: eventPayload,
          occurredAt: now,
        });
        return { kind: 'APPLIED', value };
      });
    } catch (error) {
      return mapCollaborationMutationError(error, input.request.expectedRevision);
    }
  }

  async listCollaborations(
    scope: AuthorizedRuntimeTaskScope,
    page: { readonly cursor: string | null; readonly limit: number },
  ): Promise<RuntimeCursorPage<Collaboration>> {
    const cursor = decodeRuntimeCursor(page.cursor);
    return this.prisma.withTenant(scope.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<CollaborationRow[]>(Prisma.sql`
        SELECT *
        FROM public."collaborations"
        WHERE "tenant_id" = ${scope.tenantId}::uuid
          AND "task_id" = ${scope.taskId}::uuid
          AND ${labelPredicate(scope)}
          ${
            cursor === null
              ? Prisma.empty
              : Prisma.sql`
                AND ("updated_at", "id") <
                    (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)
              `
          }
        ORDER BY "updated_at" DESC, "id" DESC
        LIMIT ${page.limit + 1}
      `);
      const visible = rows.slice(0, page.limit);
      const recipients = await loadCollaborationRecipients(
        transaction,
        scope.tenantId,
        visible.map((row) => row.id),
      );
      const last = visible.at(-1);
      return {
        items: visible.map((row) => mapCollaborationRow(row, recipients.get(row.id) ?? [])),
        nextCursor:
          rows.length > page.limit && last !== undefined
            ? encodeRuntimeCursor(last.updated_at, last.id)
            : null,
      };
    });
  }

  async findCollaboration(
    scope: AuthorizedRuntimeTaskScope,
    collaborationId: string,
  ): Promise<CollaborationDetailResponse | null> {
    return this.prisma.withTenant(scope.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<CollaborationRow[]>(Prisma.sql`
        SELECT *
        FROM public."collaborations"
        WHERE "tenant_id" = ${scope.tenantId}::uuid
          AND "task_id" = ${scope.taskId}::uuid
          AND "id" = ${collaborationId}::uuid
          AND ${labelPredicate(scope)}
        LIMIT 1
      `);
      const row = rows[0];
      if (row === undefined) return null;
      const [recipients, messages] = await Promise.all([
        loadCollaborationRecipients(transaction, scope.tenantId, [row.id]),
        transaction.$queryRaw<CollaborationMessageRow[]>(Prisma.sql`
          SELECT *
          FROM public."collaboration_messages"
          WHERE "tenant_id" = ${scope.tenantId}::uuid
            AND "collaboration_id" = ${row.id}::uuid
          ORDER BY "revision" ASC, "id" ASC
        `),
      ]);
      return {
        collaboration: mapCollaborationRow(row, recipients.get(row.id) ?? []),
        messages: messages.map(mapCollaborationMessageRow),
      };
    });
  }

  async listCorrections(
    scope: AuthorizedRuntimeTaskScope,
    page: { readonly cursor: string | null; readonly limit: number },
  ): Promise<RuntimeCursorPage<CorrectionCase>> {
    const cursor = decodeRuntimeCursor(page.cursor);
    return this.prisma.withTenant(scope.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<CorrectionCaseRow[]>(Prisma.sql`
        SELECT *
        FROM public."correction_cases"
        WHERE "tenant_id" = ${scope.tenantId}::uuid
          AND "task_id" = ${scope.taskId}::uuid
          AND ${labelPredicate(scope)}
          ${
            cursor === null
              ? Prisma.empty
              : Prisma.sql`
                AND ("updated_at", "id") <
                    (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)
              `
          }
        ORDER BY "updated_at" DESC, "id" DESC
        LIMIT ${page.limit + 1}
      `);
      const visible = rows.slice(0, page.limit);
      const last = visible.at(-1);
      return {
        items: visible.map(mapCorrectionCaseRow),
        nextCursor:
          rows.length > page.limit && last !== undefined
            ? encodeRuntimeCursor(last.updated_at, last.id)
            : null,
      };
    });
  }

  async findCorrectionForFeedback(
    scope: AuthorizedRuntimeTaskScope,
    correctionId: string,
  ): Promise<CorrectionCase | null> {
    return this.prisma.withTenant(scope.tenantId, async (transaction) => {
      const row = await findCorrection(transaction, scope, correctionId, false);
      return row === null ? null : mapCorrectionCaseRow(row);
    });
  }

  async applyCorrectionFeedback(
    input: ApplyCorrectionFeedbackInput,
  ): Promise<RuntimeMutationResult<CorrectionCase>> {
    if (
      input.principal.tenantId !== input.scope.tenantId ||
      input.principal.userId !== input.scope.userId
    ) {
      return {
        kind: 'REJECTED',
        reason: 'INVARIANT_VIOLATION',
        detail: 'Trusted principal and authorization scope are inconsistent.',
      };
    }
    try {
      return await withProcessTenant(this.prisma, input.scope.tenantId, async (transaction) => {
        const prior = await findFeedbackByIdempotencyKey(
          transaction,
          input.scope.tenantId,
          input.feedback.idempotencyKey,
        );
        if (prior !== null) {
          if (!sameFeedback(prior, input)) {
            return { kind: 'IDEMPOTENCY_CONFLICT' };
          }
          const snapshot = await loadFeedbackResultSnapshot(
            transaction,
            input.scope.tenantId,
            input.feedback.idempotencyKey,
          );
          if (snapshot !== null) {
            return { kind: 'IDEMPOTENT_REPLAY', value: snapshot };
          }
          const current = await findCorrection(transaction, input.scope, input.correctionId, false);
          return current === null
            ? { kind: 'NOT_FOUND' }
            : {
                kind: 'IDEMPOTENT_REPLAY',
                value: mapCorrectionCaseRow(current),
              };
        }

        const current = await findCorrection(transaction, input.scope, input.correctionId, true);
        if (current === null) return { kind: 'NOT_FOUND' };
        if (current.revision !== input.feedback.expectedRevision) {
          return {
            kind: 'STALE_REVISION',
            currentRevision: current.revision,
          };
        }

        const effectiveAt = new Date(input.feedback.effectiveAt);
        const evidence = await loadFeedbackEvidence(
          transaction,
          input.scope,
          input.correctionId,
          input.feedback.evidenceIds,
          effectiveAt,
        );
        if (evidence.length !== input.feedback.evidenceIds.length) {
          return {
            kind: 'REJECTED',
            reason: 'INVARIANT_VIOLATION',
            detail: 'Correction feedback evidence must resolve to exact tenant-owned versions.',
          };
        }

        const feedbackId = randomUUID();
        await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."correction_feedback" (
              "id", "tenant_id", "correction_case_id", "revision", "action",
              "actor_user_id", "actor_role_assignment_id", "comment",
              "evidence_ids", "occurred_at", "idempotency_key"
            ) VALUES (
              ${feedbackId}::uuid,
              ${input.scope.tenantId}::uuid,
              ${input.correctionId}::uuid,
              ${input.feedback.expectedRevision + 1},
              ${input.feedback.action}::public."CorrectionFeedbackAction",
              ${input.scope.userId}::uuid,
              ${input.trustedActorRoleAssignmentId}::uuid,
              ${input.feedback.comment},
              ${JSON.stringify(input.feedback.evidenceIds)}::jsonb,
              ${effectiveAt},
              ${input.feedback.idempotencyKey}
            )
          `);
        for (const item of evidence) {
          await transaction.$executeRaw(Prisma.sql`
              INSERT INTO public."correction_feedback_evidence" (
                "tenant_id", "correction_feedback_id", "evidence_id",
                "evidence_version", "content_hash"
              ) VALUES (
                ${input.scope.tenantId}::uuid,
                ${feedbackId}::uuid,
                ${item.id}::uuid,
                ${item.version},
                ${item.content_hash}
              )
            `);
        }

        const updated = await findCorrection(transaction, input.scope, input.correctionId, false);
        if (updated === null) {
          throw new Error('Correction feedback was accepted without an updated Correction Case.');
        }
        const value = mapCorrectionCaseRow(updated);
        if (
          value.revision !== input.feedback.expectedRevision + 1 ||
          value.status !== input.nextStatus
        ) {
          throw new Error('Correction feedback produced an inconsistent aggregate state.');
        }

        const eventPayload = {
          correction: value,
          feedbackId,
          action: input.feedback.action,
          actorRoleAssignmentId: input.trustedActorRoleAssignmentId,
          comment: input.feedback.comment,
          evidenceIds: input.feedback.evidenceIds,
        };
        await insertCorrectionFeedbackEvent(transaction, {
          id: randomUUID(),
          scope: input.scope,
          correction: updated,
          feedbackId,
          idempotencyKey: input.feedback.idempotencyKey,
          payload: eventPayload,
          occurredAt: effectiveAt,
        });
        await appendRuntimeAuditAndOutbox(transaction, input.principal, {
          action: 'correction.feedback.submit',
          resourceType: 'CORRECTION',
          resourceId: input.correctionId,
          eventType: 'Correction.FeedbackSubmitted',
          payload: eventPayload,
          occurredAt: effectiveAt,
        });
        return { kind: 'APPLIED', value };
      });
    } catch (error) {
      const text = databaseErrorText(error);
      if (text.includes('revision_cas') || text.includes('40001')) {
        return {
          kind: 'STALE_REVISION',
          currentRevision: input.feedback.expectedRevision,
        };
      }
      if (isDatabaseConflict(error)) {
        return { kind: 'IDEMPOTENCY_CONFLICT' };
      }
      if (isDatabaseRejection(error)) {
        return {
          kind: 'REJECTED',
          reason: 'INVARIANT_VIOLATION',
          detail: text.slice(0, 2_000),
        };
      }
      throw error;
    }
  }
}

const ACTIVE_COLLABORATION_TASK_STATUSES = new Set(['READY', 'IN_PROGRESS', 'BLOCKED']);

function coherentMutationIdentity(
  input: CreateCollaborationInput | ApplyCollaborationCommandInput,
): boolean {
  return (
    input.principal.tenantId === input.scope.tenantId &&
    input.principal.userId === input.scope.userId
  );
}

function invariantRejection(detail: string): RuntimeMutationResult<never> {
  return {
    kind: 'REJECTED',
    reason: 'INVARIANT_VIOLATION',
    detail,
  };
}

function collaborationCreateRequestHash(input: CreateCollaborationInput): string {
  return runtimeHash({
    taskId: input.scope.taskId,
    requesterUserId: input.principal.userId,
    request: input.request,
  });
}

function collaborationCommandRequestHash(input: ApplyCollaborationCommandInput): string {
  return runtimeHash({
    taskId: input.scope.taskId,
    collaborationId: input.collaborationId,
    actorUserId: input.principal.userId,
    request: input.request,
  });
}

function requestMessageKey(idempotencyKey: string): string {
  return `collaboration-request:${runtimeHash(idempotencyKey)}`;
}

function collaborationEventKey(value: string): string {
  return `collaboration-event:${runtimeHash(value)}`;
}

function mapCollaborationMutationError(
  error: unknown,
  expectedRevision: number,
): RuntimeMutationResult<CollaborationDetailResponse> {
  const text = databaseErrorText(error);
  if (text.includes('revision_cas') || text.includes('40001')) {
    return { kind: 'STALE_REVISION', currentRevision: expectedRevision };
  }
  if (isDatabaseConflict(error)) {
    return { kind: 'IDEMPOTENCY_CONFLICT' };
  }
  if (isDatabaseRejection(error)) {
    return {
      kind: 'REJECTED',
      reason: text.includes('transition') ? 'INVALID_TRANSITION' : 'INVARIANT_VIOLATION',
      detail: text.slice(0, 2_000),
    };
  }
  throw error;
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('Database clock did not return a timestamp.');
  return now;
}

async function findTaskContext(
  transaction: Prisma.TransactionClient,
  scope: AuthorizedRuntimeTaskScope,
  lock: boolean,
): Promise<CollaborationTaskRow | null> {
  const rows = await transaction.$queryRaw<CollaborationTaskRow[]>(Prisma.sql`
    SELECT
      "tenant_id", "id", "version", "objective_id", "objective_version", "status",
      "owner_user_id", "owner_role_assignment_id", "owner_role_template_id",
      "owner_org_unit_id", "permission_labels"
    FROM public."tasks"
    WHERE "tenant_id" = ${scope.tenantId}::uuid
      AND "id" = ${scope.taskId}::uuid
      AND ${labelPredicate(scope)}
    ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

async function loadEligibleCollaborationAssignments(
  transaction: Prisma.TransactionClient,
  task: CollaborationTaskRow,
  currentUserId: string,
): Promise<CollaborationAssignmentRow[]> {
  return transaction.$queryRaw<CollaborationAssignmentRow[]>(Prisma.sql`
    SELECT
      assignment."id" AS "role_assignment_id",
      assignment."user_id",
      assignment."agent_instance_id" AS "agent_id",
      actor."display_name" AS "user_name",
      template."name" AS "role_name",
      unit."name" AS "org_unit_name"
    FROM public."role_assignments" assignment
    JOIN public."users" actor
      ON actor."tenant_id" = assignment."tenant_id"
     AND actor."id" = assignment."user_id"
     AND actor."status" = 'ACTIVE'
    JOIN public."employments" employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
     AND employment."user_id" = assignment."user_id"
     AND employment."status" = 'ACTIVE'
    JOIN public."org_units" unit
      ON unit."tenant_id" = employment."tenant_id"
     AND unit."id" = employment."org_unit_id"
     AND unit."organization_id" = employment."organization_id"
     AND unit."status" = 'ACTIVE'
    JOIN public."agent_templates" template
      ON template."tenant_id" = assignment."tenant_id"
     AND template."id" = assignment."role_template_id"
    JOIN public."agent_versions" role_version
      ON role_version."tenant_id" = assignment."tenant_id"
     AND role_version."template_id" = assignment."role_template_id"
     AND role_version."id" = assignment."role_version_id"
     AND role_version."status" IN ('PUBLISHED', 'RETIRED')
    WHERE assignment."tenant_id" = ${task.tenant_id}::uuid
      AND assignment."status" = 'ACTIVE'
      AND assignment."effective_from" <= CURRENT_TIMESTAMP
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > CURRENT_TIMESTAMP
      )
      AND (
        assignment."id" = ${task.owner_role_assignment_id}::uuid
        OR assignment."role_template_id" = ${task.owner_role_template_id}::uuid
        OR assignment."user_id" = ${task.owner_user_id}::uuid
        OR EXISTS (
          SELECT 1
          FROM public."objective_role_assignments" objective_assignment
          WHERE objective_assignment."tenant_id" = assignment."tenant_id"
            AND objective_assignment."objective_id" = ${task.objective_id}::uuid
            AND objective_assignment."objective_version" = ${task.objective_version}
            AND objective_assignment."role_assignment_id" = assignment."id"
        )
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(assignment."permission_scope"->'actions') = 'array'
              THEN assignment."permission_scope"->'actions'
            ELSE '[]'::jsonb
          END
        ) action(value)
        WHERE action.value IN (
          '*', 'business.*', 'business.task.*', 'business.task.execute'
        )
      )
      AND (
        assignment."permission_scope"->'taskIds'
        @> jsonb_build_array(${task.id}::text)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${JSON.stringify(
          stringArray(task.permission_labels),
        )}::jsonb) required_label(value)
        WHERE NOT (
          CASE
            WHEN jsonb_typeof(assignment."permission_scope"->'dataLabels') = 'array'
              THEN assignment."permission_scope"->'dataLabels'
            WHEN jsonb_typeof(assignment."permission_scope"->'permissionLabels') = 'array'
              THEN assignment."permission_scope"->'permissionLabels'
            ELSE '[]'::jsonb
          END
          @> jsonb_build_array(required_label.value)
        )
      )
    ORDER BY
      (assignment."user_id" = ${currentUserId}::uuid) DESC,
      actor."display_name" ASC,
      template."name" ASC,
      assignment."id" ASC
  `);
}

function chooseRequesterAssignment(
  input: CreateCollaborationInput,
  candidates: readonly CollaborationAssignmentRow[],
): CollaborationAssignmentRow | null {
  const own = candidates.filter(
    (candidate) =>
      candidate.user_id === input.principal.userId &&
      (input.scope.managementBypass ||
        input.scope.roleAssignmentIds.includes(candidate.role_assignment_id)),
  );
  if (input.request.actingRoleAssignmentId !== undefined) {
    return (
      own.find(
        (candidate) => candidate.role_assignment_id === input.request.actingRoleAssignmentId,
      ) ?? null
    );
  }
  return own.length === 1 ? own[0]! : null;
}

function resolveExactAssignments(
  candidates: readonly CollaborationAssignmentRow[],
  assignmentIds: readonly string[],
): CollaborationAssignmentRow[] | null {
  const byId = new Map(candidates.map((candidate) => [candidate.role_assignment_id, candidate]));
  const resolved = assignmentIds.map((id) => byId.get(id));
  if (resolved.some((item) => item === undefined)) return null;
  return (resolved as CollaborationAssignmentRow[]).sort((left, right) =>
    left.role_assignment_id.localeCompare(right.role_assignment_id),
  );
}

function assignmentsHaveIndependentIdentities(
  assignments: readonly CollaborationAssignmentRow[],
): boolean {
  return (
    new Set(assignments.map((assignment) => assignment.user_id)).size === assignments.length &&
    new Set(assignments.map((assignment) => assignment.agent_id)).size === assignments.length
  );
}

async function insertCollaborationParticipant(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  collaborationId: string,
  assignment: CollaborationAssignmentRow,
  participantRole: 'REQUESTER' | 'RECIPIENT' | 'DECISION',
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."collaboration_participants" (
      "tenant_id", "collaboration_id", "role_assignment_id",
      "user_id", "agent_id", "participant_role",
      "assignment_snapshot", "permission_labels", "active"
    ) VALUES (
      ${tenantId}::uuid,
      ${collaborationId}::uuid,
      ${assignment.role_assignment_id}::uuid,
      ${assignment.user_id}::uuid,
      ${assignment.agent_id}::uuid,
      ${participantRole}::public."CollaborationParticipantRole",
      '{}'::jsonb,
      '[]'::jsonb,
      true
    )
  `);
}

async function insertCollaborationMessage(
  transaction: Prisma.TransactionClient,
  input: CollaborationMessageInsert,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."collaboration_messages" (
      "id", "tenant_id", "collaboration_id", "schema_version", "revision",
      "correlation_id", "causation_id", "type",
      "sender_type", "sender_user_id", "sender_agent_id",
      "sender_role_assignment_id", "recipient_role_assignment_ids",
      "objective_id", "objective_version", "task_id", "task_version",
      "permission_labels", "payload", "occurred_at", "idempotency_key",
      "previous_hash", "message_hash"
    ) VALUES (
      ${input.id}::uuid,
      ${input.tenantId}::uuid,
      ${input.collaborationId}::uuid,
      1,
      ${input.revision},
      ${input.correlationId}::uuid,
      ${input.causationId}::uuid,
      ${input.type}::public."CollaborationMessageType",
      'USER'::public."ProcessActorType",
      ${input.senderUserId}::uuid,
      NULL,
      ${input.senderRoleAssignmentId}::uuid,
      ${JSON.stringify(input.recipientRoleAssignmentIds)}::jsonb,
      ${input.objectiveId}::uuid,
      ${input.objectiveVersion},
      ${input.taskId}::uuid,
      ${input.taskVersion},
      ${JSON.stringify(input.permissionLabels)}::jsonb,
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.occurredAt},
      ${input.idempotencyKey},
      ${input.previousHash},
      ${input.messageHash}
    )
  `);
}

async function insertCollaborationMessageRecipients(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  messageId: string,
  recipientIds: readonly string[],
): Promise<void> {
  for (const recipientId of recipientIds) {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."collaboration_message_recipients" (
        "tenant_id", "collaboration_message_id", "role_assignment_id"
      ) VALUES (
        ${tenantId}::uuid,
        ${messageId}::uuid,
        ${recipientId}::uuid
      )
    `);
  }
}

function collaborationMessageHash(input: {
  readonly id: string;
  readonly collaborationId: string;
  readonly revision: number;
  readonly type: CollaborationMessage['type'];
  readonly senderRoleAssignmentId: string;
  readonly recipientRoleAssignmentIds: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previousHash: string | null;
  readonly occurredAt: Date;
}): string {
  return runtimeHash({
    ...input,
    occurredAt: input.occurredAt.toISOString(),
  });
}

async function findCollaborationByIdempotencyKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<CollaborationRow | null> {
  const rows = await transaction.$queryRaw<CollaborationRow[]>`
    SELECT *
    FROM public."collaborations"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "idempotency_key" = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadCollaborationDetailInTransaction(
  transaction: Prisma.TransactionClient,
  scope: AuthorizedRuntimeTaskScope,
  collaborationId: string,
): Promise<CollaborationDetailResponse | null> {
  const rows = await transaction.$queryRaw<CollaborationRow[]>(Prisma.sql`
    SELECT *
    FROM public."collaborations"
    WHERE "tenant_id" = ${scope.tenantId}::uuid
      AND "task_id" = ${scope.taskId}::uuid
      AND "id" = ${collaborationId}::uuid
      AND ${labelPredicate(scope)}
    LIMIT 1
  `);
  const row = rows[0];
  if (row === undefined) return null;
  const [recipients, messages] = await Promise.all([
    loadCollaborationRecipients(transaction, scope.tenantId, [row.id]),
    transaction.$queryRaw<CollaborationMessageRow[]>(Prisma.sql`
      SELECT *
      FROM public."collaboration_messages"
      WHERE "tenant_id" = ${scope.tenantId}::uuid
        AND "collaboration_id" = ${row.id}::uuid
      ORDER BY "revision" ASC, "id" ASC
    `),
  ]);
  return {
    collaboration: mapCollaborationRow(row, recipients.get(row.id) ?? []),
    messages: messages.map(mapCollaborationMessageRow),
  };
}

async function findCollaborationForMutation(
  transaction: Prisma.TransactionClient,
  scope: AuthorizedRuntimeTaskScope,
  collaborationId: string,
): Promise<CollaborationRow | null> {
  const rows = await transaction.$queryRaw<CollaborationRow[]>(Prisma.sql`
    SELECT *
    FROM public."collaborations"
    WHERE "tenant_id" = ${scope.tenantId}::uuid
      AND "task_id" = ${scope.taskId}::uuid
      AND "id" = ${collaborationId}::uuid
      AND ${labelPredicate(scope)}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function findCollaborationMessageByIdempotencyKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<CollaborationMessageRow | null> {
  const rows = await transaction.$queryRaw<CollaborationMessageRow[]>`
    SELECT *
    FROM public."collaboration_messages"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "idempotency_key" = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadCollaborationEventRequestHash(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  messageId: string,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ payload: unknown }>>`
    SELECT "payload"
    FROM public."business_events"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "source_system" = 'enterprise-api'
      AND "source_record_id" = ${messageId}
      AND "producer" = 'collaboration-correction'
    ORDER BY "created_at" DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const value = jsonObject(row.payload).requestHash;
  return typeof value === 'string' ? value : null;
}

async function chooseCommandSender(
  transaction: Prisma.TransactionClient,
  input: ApplyCollaborationCommandInput,
  current: CollaborationRow,
): Promise<CollaborationCommandParticipantRow | null> {
  const allowedRoles = commandSenderRoles(input.request.type, current.status);
  if (allowedRoles.length === 0) return null;
  const rows = await transaction.$queryRaw<CollaborationCommandParticipantRow[]>(
    Prisma.sql`
      SELECT "role_assignment_id", "user_id", "participant_role"
      FROM public."collaboration_participants"
      WHERE "tenant_id" = ${input.scope.tenantId}::uuid
        AND "collaboration_id" = ${input.collaborationId}::uuid
        AND "user_id" = ${input.principal.userId}::uuid
        AND "active"
        AND "participant_role" IN (
          ${Prisma.join(
            allowedRoles.map((role) => Prisma.sql`${role}::public."CollaborationParticipantRole"`),
          )}
      )
      ORDER BY "role_assignment_id" ASC
    `,
  );
  return rows.length === 1 ? rows[0]! : null;
}

function commandSenderRoles(
  type: CollaborationCommandRequest['type'],
  status: Collaboration['status'],
): readonly ('REQUESTER' | 'RECIPIENT')[] {
  switch (type) {
    case 'COMMIT':
      return status === 'REQUESTED' || status === 'REJECTED' ? ['RECIPIENT'] : [];
    case 'DELIVER':
      return status === 'COMMITTED' || status === 'REJECTED' ? ['RECIPIENT'] : [];
    case 'ACCEPT':
      return status === 'DELIVERED' ? ['REQUESTER'] : [];
    case 'REJECT':
      if (status === 'REQUESTED') return ['RECIPIENT'];
      return status === 'DELIVERED' ? ['REQUESTER'] : [];
    case 'ESCALATE':
      return ['REQUESTER', 'RECIPIENT'];
    case 'CANCEL':
      return ['REQUESTER'];
  }
}

async function loadParticipantAssignmentIds(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  collaborationId: string,
): Promise<string[]> {
  const rows = await transaction.$queryRaw<Array<{ role_assignment_id: string }>>`
    SELECT "role_assignment_id"
    FROM public."collaboration_participants"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "collaboration_id" = ${collaborationId}::uuid
      AND "active"
    ORDER BY "role_assignment_id" ASC
  `;
  return rows.map((row) => row.role_assignment_id);
}

async function loadCommandRecipientIds(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  collaborationId: string,
  senderRoleAssignmentId: string,
  type: CollaborationCommandRequest['type'],
): Promise<string[]> {
  const rows = await transaction.$queryRaw<Array<{ role_assignment_id: string }>>(
    Prisma.sql`
      SELECT "role_assignment_id"
      FROM public."collaboration_participants"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "collaboration_id" = ${collaborationId}::uuid
        AND "active"
        AND ${
          type === 'ESCALATE'
            ? Prisma.sql`"participant_role" = 'DECISION'::public."CollaborationParticipantRole"`
            : Prisma.sql`
              "participant_role" IN (
                'REQUESTER'::public."CollaborationParticipantRole",
                'RECIPIENT'::public."CollaborationParticipantRole"
              )
              AND "role_assignment_id" <> ${senderRoleAssignmentId}::uuid
            `
        }
      ORDER BY "role_assignment_id" ASC
    `,
  );
  return rows.map((row) => row.role_assignment_id);
}

async function loadCommandEvidence(
  transaction: Prisma.TransactionClient,
  scope: AuthorizedRuntimeTaskScope,
  request: CollaborationCommandRequest,
): Promise<EvidenceRow[] | null> {
  const references =
    request.type === 'DELIVER' || request.type === 'ESCALATE' ? request.payload.evidenceRefs : [];
  if (references.length === 0) return [];
  const rows = await transaction.$queryRaw<EvidenceRow[]>(Prisma.sql`
    SELECT "id", "version", "content_hash"
    FROM public."evidence"
    WHERE "tenant_id" = ${scope.tenantId}::uuid
      AND "status" = 'ACTIVE'::public."EvidenceStatus"
      AND "verified_at" IS NOT NULL
      AND "effective_from" <= CURRENT_TIMESTAMP
      AND ("effective_to" IS NULL OR "effective_to" > CURRENT_TIMESTAMP)
      AND ${evidenceLabelPredicate(scope)}
      AND (
        ${Prisma.join(
          references.map(
            (reference) =>
              Prisma.sql`("id" = ${reference.evidenceId}::uuid AND "version" = ${reference.version})`,
          ),
          ' OR ',
        )}
      )
    ORDER BY "id" ASC, "version" ASC
    FOR SHARE
  `);
  if (rows.length !== references.length) return null;
  const byIdentity = new Map(rows.map((row) => [`${row.id}:${row.version}`, row]));
  for (const reference of references) {
    const row = byIdentity.get(`${reference.evidenceId}:${reference.version}`);
    if (
      row === undefined ||
      (reference.contentHash !== null && reference.contentHash !== row.content_hash)
    ) {
      return null;
    }
  }
  return rows;
}

function commandPayloadWithTrustedEvidence(
  request: CollaborationCommandRequest,
  evidence: readonly EvidenceRow[],
): Record<string, unknown> {
  if (request.type !== 'DELIVER' && request.type !== 'ESCALATE') {
    return { ...request.payload };
  }
  const byIdentity = new Map(evidence.map((row) => [`${row.id}:${row.version}`, row]));
  return {
    ...request.payload,
    evidenceRefs: request.payload.evidenceRefs.map((reference) => {
      const row = byIdentity.get(`${reference.evidenceId}:${reference.version}`);
      if (row === undefined) {
        throw new Error('Trusted Collaboration evidence disappeared during normalization.');
      }
      return {
        evidenceId: row.id,
        version: row.version,
        contentHash: row.content_hash,
      };
    }),
  };
}

async function insertCollaborationMessageEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  messageId: string,
  evidence: readonly EvidenceRow[],
): Promise<void> {
  for (const item of evidence) {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."collaboration_message_evidence" (
        "tenant_id", "collaboration_message_id", "evidence_id",
        "evidence_version", "content_hash"
      ) VALUES (
        ${tenantId}::uuid,
        ${messageId}::uuid,
        ${item.id}::uuid,
        ${item.version},
        ${item.content_hash}
      )
    `);
  }
}

function collaborationEventType(type: CollaborationCommandRequest['type']): string {
  return {
    COMMIT: 'Collaboration.Committed',
    DELIVER: 'Collaboration.Delivered',
    ACCEPT: 'Collaboration.Accepted',
    REJECT: 'Collaboration.Rejected',
    ESCALATE: 'Collaboration.Escalated',
    CANCEL: 'Collaboration.Cancelled',
  }[type];
}

async function findCollaborationEventIdForMessage(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  messageId: string | null,
): Promise<string | null> {
  if (messageId === null) return null;
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM public."business_events"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "source_system" = 'enterprise-api'
      AND "source_record_id" = ${messageId}
      AND "producer" = 'collaboration-correction'
    ORDER BY "created_at" DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

async function insertCollaborationBusinessEvent(
  transaction: Prisma.TransactionClient,
  input: CollaborationBusinessEventInsert,
): Promise<void> {
  const retainUntil = new Date(input.occurredAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 7);
  const permissionLabels = stringArray(input.task.permission_labels);
  const evidenceRefs = input.evidence.map((item) => ({
    evidenceId: item.id,
    version: item.version,
    contentHash: item.content_hash,
  }));
  const organizationScope = {
    orgUnitIds: input.scope.organizationIds,
    projectIds: input.scope.projectIds,
    customerIds: [],
    dataLabels: permissionLabels,
  };
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."business_events" (
      "id", "tenant_id", "event_type", "schema_version",
      "aggregate_type", "aggregate_id", "aggregate_version",
      "subject_type", "subject_id", "subject_version",
      "occurred_at", "produced_at", "organization_scope", "payload",
      "evidence_refs", "correlation_id", "causation_id", "idempotency_key",
      "sensitivity", "retain_until", "retention_action", "legal_hold",
      "source_system", "source_record_id", "source_version", "producer",
      "permission_labels", "event_hash"
    ) VALUES (
      ${input.id}::uuid,
      ${input.scope.tenantId}::uuid,
      ${input.eventType},
      1,
      'COLLABORATION'::public."BusinessEventSubjectType",
      ${input.collaborationId}::uuid,
      ${input.revision},
      'TASK'::public."BusinessEventSubjectType",
      ${input.task.id}::uuid,
      ${input.task.version},
      ${input.occurredAt},
      ${input.occurredAt},
      ${JSON.stringify(organizationScope)}::jsonb,
      ${JSON.stringify(input.payload)}::jsonb,
      ${JSON.stringify(evidenceRefs)}::jsonb,
      ${input.correlationId}::uuid,
      ${input.causationId}::uuid,
      ${input.idempotencyKey},
      'SENSITIVE'::public."BusinessEventSensitivity",
      ${retainUntil},
      'ARCHIVE'::public."BusinessEventRetentionAction",
      false,
      'enterprise-api',
      ${input.messageId},
      ${String(input.revision)},
      'collaboration-correction',
      ${JSON.stringify(permissionLabels)}::jsonb,
      ${runtimeHash(input)}
    )
  `);
  for (const item of input.evidence) {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."business_event_evidence" (
        "tenant_id", "business_event_id", "evidence_id",
        "evidence_version", "content_hash"
      ) VALUES (
        ${input.scope.tenantId}::uuid,
        ${input.id}::uuid,
        ${item.id}::uuid,
        ${item.version},
        ${item.content_hash}
      )
    `);
  }
}

function labelPredicate(scope: AuthorizedRuntimeTaskScope): Prisma.Sql {
  if (scope.managementBypass) return Prisma.sql`true`;
  if (scope.permissionLabelScopes.length === 0) return Prisma.sql`false`;
  return Prisma.sql`(
    ${Prisma.join(
      scope.permissionLabelScopes.map(
        (labels) => Prisma.sql`"permission_labels" <@ ${JSON.stringify(labels)}::jsonb`,
      ),
      ' OR ',
    )}
  )`;
}

async function loadCollaborationRecipients(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  collaborationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const output = new Map<string, string[]>();
  if (collaborationIds.length === 0) return output;
  const rows = await transaction.$queryRaw<CollaborationParticipantRow[]>(
    Prisma.sql`
      SELECT "collaboration_id", "role_assignment_id"
      FROM public."collaboration_participants"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "participant_role" = 'RECIPIENT'::public."CollaborationParticipantRole"
        AND "collaboration_id" IN (
          ${Prisma.join(collaborationIds.map((id) => Prisma.sql`${id}::uuid`))}
        )
      ORDER BY "collaboration_id" ASC, "role_assignment_id" ASC
    `,
  );
  for (const row of rows) {
    const ids = output.get(row.collaboration_id) ?? [];
    ids.push(row.role_assignment_id);
    output.set(row.collaboration_id, ids);
  }
  return output;
}

async function findCorrection(
  transaction: Prisma.TransactionClient,
  scope: AuthorizedRuntimeTaskScope,
  correctionId: string,
  lock: boolean,
): Promise<CorrectionCaseRow | null> {
  const rows = await transaction.$queryRaw<CorrectionCaseRow[]>(Prisma.sql`
    SELECT *
    FROM public."correction_cases"
    WHERE "tenant_id" = ${scope.tenantId}::uuid
      AND "task_id" = ${scope.taskId}::uuid
      AND "id" = ${correctionId}::uuid
      AND ${labelPredicate(scope)}
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

async function findFeedbackByIdempotencyKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<CorrectionFeedbackRow | null> {
  const rows = await transaction.$queryRaw<CorrectionFeedbackRow[]>`
    SELECT *
    FROM public."correction_feedback"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "idempotency_key" = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function sameFeedback(row: CorrectionFeedbackRow, input: ApplyCorrectionFeedbackInput): boolean {
  return (
    row.correction_case_id === input.correctionId &&
    row.revision === input.feedback.expectedRevision + 1 &&
    row.action === input.feedback.action &&
    row.actor_user_id === input.scope.userId &&
    row.actor_role_assignment_id === input.trustedActorRoleAssignmentId &&
    row.comment === input.feedback.comment &&
    sameStringSet(stringArray(row.evidence_ids), input.feedback.evidenceIds) &&
    row.occurred_at.getTime() === new Date(input.feedback.effectiveAt).getTime()
  );
}

async function loadFeedbackResultSnapshot(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<CorrectionCase | null> {
  const rows = await transaction.$queryRaw<Array<{ payload: unknown }>>`
    SELECT "payload"
    FROM public."business_events"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "idempotency_key" = ${feedbackEventKey(idempotencyKey)}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const payload = jsonObject(row.payload);
  const parsed = correctionCaseSchema.safeParse(payload.correction);
  return parsed.success ? parsed.data : null;
}

async function loadFeedbackEvidence(
  transaction: Prisma.TransactionClient,
  scope: AuthorizedRuntimeTaskScope,
  correctionId: string,
  evidenceIds: readonly string[],
  effectiveAt: Date,
): Promise<EvidenceRow[]> {
  if (evidenceIds.length === 0) return [];
  return transaction.$queryRaw<EvidenceRow[]>(Prisma.sql`
    SELECT evidence."id", evidence."version", evidence."content_hash"
    FROM public."evidence" evidence
    JOIN public."correction_case_evidence" case_evidence
      ON case_evidence."tenant_id" = evidence."tenant_id"
     AND case_evidence."correction_case_id" = ${correctionId}::uuid
     AND case_evidence."evidence_id" = evidence."id"
     AND case_evidence."evidence_version" = evidence."version"
     AND case_evidence."content_hash" = evidence."content_hash"
    WHERE evidence."tenant_id" = ${scope.tenantId}::uuid
      AND evidence."status" = 'ACTIVE'::public."EvidenceStatus"
      AND evidence."effective_from" <= ${effectiveAt}
      AND (
        evidence."effective_to" IS NULL
        OR evidence."effective_to" > ${effectiveAt}
      )
      AND ${evidenceLabelPredicate(scope)}
      AND evidence."id" IN (
        ${Prisma.join(evidenceIds.map((id) => Prisma.sql`${id}::uuid`))}
      )
    FOR SHARE OF evidence, case_evidence
  `);
}

function evidenceLabelPredicate(scope: AuthorizedRuntimeTaskScope): Prisma.Sql {
  if (scope.managementBypass) return Prisma.sql`true`;
  if (scope.permissionLabelScopes.length === 0) return Prisma.sql`false`;
  return Prisma.sql`(
    ${Prisma.join(
      scope.permissionLabelScopes.map(
        (labels) => Prisma.sql`evidence."permission_labels" <@ ${JSON.stringify(labels)}::jsonb`,
      ),
      ' OR ',
    )}
  )`;
}

async function insertCorrectionFeedbackEvent(
  transaction: Prisma.TransactionClient,
  input: {
    readonly id: string;
    readonly scope: AuthorizedRuntimeTaskScope;
    readonly correction: CorrectionCaseRow;
    readonly feedbackId: string;
    readonly idempotencyKey: string;
    readonly payload: Record<string, unknown>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const producedAt = new Date(Math.max(input.occurredAt.getTime(), Date.now()));
  const retainUntil = new Date(producedAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 7);
  const organizationScope = {
    orgUnitIds: input.scope.organizationIds,
    projectIds: input.scope.projectIds,
    customerIds: [],
    dataLabels: stringArray(input.correction.permission_labels),
  };
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."business_events" (
      "id", "tenant_id", "event_type", "schema_version",
      "aggregate_type", "aggregate_id", "aggregate_version",
      "subject_type", "subject_id", "subject_version",
      "occurred_at", "produced_at", "organization_scope", "payload",
      "evidence_refs", "correlation_id", "causation_id", "idempotency_key",
      "sensitivity", "retain_until", "retention_action", "legal_hold",
      "source_system", "source_record_id", "source_version", "producer",
      "permission_labels", "event_hash"
    ) VALUES (
      ${input.id}::uuid,
      ${input.scope.tenantId}::uuid,
      'Correction.FeedbackSubmitted',
      1,
      'CORRECTION'::public."BusinessEventSubjectType",
      ${input.correction.id}::uuid,
      ${input.correction.revision},
      ${input.correction.subject_type}::public."BusinessEventSubjectType",
      ${input.correction.subject_id}::uuid,
      ${input.correction.subject_version},
      ${input.occurredAt},
      ${producedAt},
      ${JSON.stringify(organizationScope)}::jsonb,
      ${JSON.stringify(input.payload)}::jsonb,
      '[]'::jsonb,
      ${input.correction.correlation_id}::uuid,
      NULL,
      ${feedbackEventKey(input.idempotencyKey)},
      'SENSITIVE'::public."BusinessEventSensitivity",
      ${retainUntil},
      'ARCHIVE'::public."BusinessEventRetentionAction",
      false,
      'enterprise-api',
      ${input.feedbackId},
      ${String(input.correction.revision)},
      'collaboration-correction',
      ${JSON.stringify(stringArray(input.correction.permission_labels))}::jsonb,
      ${runtimeHash(input)}
    )
  `);
}

function feedbackEventKey(idempotencyKey: string): string {
  return `correction-feedback:${runtimeHash(idempotencyKey)}`;
}

function mapCollaborationRow(
  row: CollaborationRow,
  recipientRoleAssignmentIds: readonly string[],
): Collaboration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    correlationId: row.correlation_id,
    objectiveId: row.objective_id,
    taskId: row.task_id,
    requesterRoleAssignmentId: row.requester_role_assignment_id,
    recipientRoleAssignmentIds: [...recipientRoleAssignmentIds],
    status: row.status,
    revision: row.revision,
    commonGoal: row.common_goal,
    requestedInput: row.requested_input,
    expectedOutputSchema: jsonObject(row.expected_output_schema),
    dueAt: row.due_at.toISOString(),
    permissionLabels: stringArray(row.permission_labels),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCollaborationMessageRow(row: CollaborationMessageRow): CollaborationMessage {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    collaborationId: row.collaboration_id,
    schemaVersion: row.schema_version,
    revision: row.revision,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    type: row.type,
    senderRoleAssignmentId: row.sender_role_assignment_id,
    recipientRoleAssignmentIds: stringArray(row.recipient_role_assignment_ids),
    objectiveId: row.objective_id,
    taskId: row.task_id,
    permissionLabels: stringArray(row.permission_labels),
    payload: jsonObject(row.payload),
    occurredAt: row.occurred_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  } as CollaborationMessage;
}

function mapCorrectionCaseRow(row: CorrectionCaseRow): CorrectionCase {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    correlationId: row.correlation_id,
    subject: {
      type: row.subject_type,
      id: row.subject_id,
      version: row.subject_version,
    },
    roleAssignmentId: row.role_assignment_id,
    objectiveId: row.objective_id,
    taskId: row.task_id,
    processInstanceId: row.process_instance_id,
    trigger: row.trigger,
    category: row.category,
    severity: row.severity,
    confidence: Number(row.confidence),
    ruleFindings: stringArray(row.rule_findings),
    modelFinding: row.model_finding,
    evidenceRefs: jsonArray(row.evidence_refs) as CorrectionCase['evidenceRefs'],
    impact: row.impact,
    suggestedActions: stringArray(row.suggested_actions),
    requiredRoleAssignmentIds: stringArray(row.required_role_assignment_ids),
    status: row.status,
    revision: row.revision,
    permissionLabels: stringArray(row.permission_labels),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

interface CollaborationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly objective_id: string;
  readonly objective_version: number;
  readonly task_id: string;
  readonly task_version: number;
  readonly requester_role_assignment_id: string;
  readonly status: Collaboration['status'];
  readonly revision: number;
  readonly common_goal: string;
  readonly requested_input: string;
  readonly expected_output_schema: unknown;
  readonly due_at: Date;
  readonly permission_labels: unknown;
  readonly latest_message_id: string | null;
  readonly latest_message_hash: string | null;
  readonly latest_occurred_at: Date | null;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CollaborationParticipantRow {
  readonly collaboration_id: string;
  readonly role_assignment_id: string;
}

interface CollaborationMessageRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly collaboration_id: string;
  readonly schema_version: number;
  readonly revision: number;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly type: CollaborationMessage['type'];
  readonly sender_user_id: string | null;
  readonly sender_role_assignment_id: string;
  readonly recipient_role_assignment_ids: unknown;
  readonly objective_id: string;
  readonly task_id: string;
  readonly permission_labels: unknown;
  readonly payload: unknown;
  readonly occurred_at: Date;
  readonly idempotency_key: string;
}

interface CorrectionCaseRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly subject_type: CorrectionCase['subject']['type'];
  readonly subject_id: string;
  readonly subject_version: number | null;
  readonly role_assignment_id: string;
  readonly objective_id: string;
  readonly task_id: string;
  readonly process_instance_id: string | null;
  readonly trigger: string;
  readonly category: CorrectionCase['category'];
  readonly severity: CorrectionCase['severity'];
  readonly confidence: Prisma.Decimal | number | string;
  readonly rule_findings: unknown;
  readonly model_finding: string | null;
  readonly evidence_refs: unknown;
  readonly impact: string;
  readonly suggested_actions: unknown;
  readonly required_role_assignment_ids: unknown;
  readonly status: CorrectionCase['status'];
  readonly revision: number;
  readonly permission_labels: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CorrectionFeedbackRow {
  readonly correction_case_id: string;
  readonly revision: number;
  readonly action: ApplyCorrectionFeedbackInput['feedback']['action'];
  readonly actor_user_id: string;
  readonly actor_role_assignment_id: string;
  readonly comment: string;
  readonly evidence_ids: unknown;
  readonly occurred_at: Date;
}

interface EvidenceRow {
  readonly id: string;
  readonly version: number;
  readonly content_hash: string;
}

interface CollaborationTaskRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly objective_id: string;
  readonly objective_version: number;
  readonly status: string;
  readonly owner_user_id: string | null;
  readonly owner_role_assignment_id: string | null;
  readonly owner_role_template_id: string | null;
  readonly owner_org_unit_id: string | null;
  readonly permission_labels: unknown;
}

interface CollaborationAssignmentRow {
  readonly role_assignment_id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly user_name: string;
  readonly role_name: string;
  readonly org_unit_name: string;
}

interface CollaborationCommandParticipantRow {
  readonly role_assignment_id: string;
  readonly user_id: string;
  readonly participant_role: 'REQUESTER' | 'RECIPIENT' | 'DECISION';
}

interface CollaborationMessageInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly collaborationId: string;
  readonly revision: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly type: CollaborationMessage['type'];
  readonly senderUserId: string;
  readonly senderRoleAssignmentId: string;
  readonly recipientRoleAssignmentIds: readonly string[];
  readonly objectiveId: string;
  readonly objectiveVersion: number;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly permissionLabels: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
  readonly previousHash: string | null;
  readonly messageHash: string;
}

interface CollaborationBusinessEventInsert {
  readonly id: string;
  readonly scope: AuthorizedRuntimeTaskScope;
  readonly task: CollaborationTaskRow;
  readonly collaborationId: string;
  readonly correlationId: string;
  readonly messageId: string;
  readonly revision: number;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidence: readonly EvidenceRow[];
  readonly occurredAt: Date;
  readonly causationId: string | null;
}
