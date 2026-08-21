import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  ProcessCommand,
  ProcessInstance,
  ProcessInstanceDetailResponse,
  ProcessStepCommand,
  ProcessStepInstance,
  ProcessStepStatus,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service.js';
import {
  nextProcessStepAttempt,
  transitionProcessInstance,
  transitionStepInstance,
  type ProcessCompletionStep,
  type ProcessNodeType,
  type TrustedProcessStepActor,
} from '../../../process-orchestration/domain/process-state-machine.js';
import {
  appendRuntimeAuditAndOutbox,
  databaseErrorText,
  decodeRuntimeCursor,
  encodeRuntimeCursor,
  isDatabaseConflict,
  isDatabaseRejection,
  jsonObject,
  nullableJsonObject,
  runtimeHash,
  stringArray,
  withProcessTenant,
} from '../../../process-orchestration/infrastructure/prisma/runtime-prisma.support.js';
import type {
  RuntimeCursorPage,
  RuntimeMutationResult,
} from '../../../process-orchestration/application/runtime-mutation-result.js';
import {
  ProcessRuntimeRepository,
  type ProcessRuntimeCommandInput,
  type ProcessStepRuntimeCommandInput,
} from '../../process-runtime.repository.js';

@Injectable()
export class PrismaProcessRuntimeRepository extends ProcessRuntimeRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async listInstances(
    principal: ProcessRuntimeCommandInput['principal'],
    page: { readonly cursor: string | null; readonly limit: number },
  ): Promise<RuntimeCursorPage<ProcessInstance>> {
    const cursor = decodeRuntimeCursor(page.cursor);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await transaction.$queryRaw<ProcessInstanceRow[]>(Prisma.sql`
        SELECT *
        FROM public."process_instances"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
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
        items: visible.map(mapProcessInstanceRow),
        nextCursor:
          rows.length > page.limit && last !== undefined
            ? encodeRuntimeCursor(last.updated_at, last.id)
            : null,
      };
    });
  }

  async findInstance(
    principal: ProcessRuntimeCommandInput['principal'],
    processInstanceId: string,
  ): Promise<ProcessInstanceDetailResponse | null> {
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const instances = await transaction.$queryRaw<ProcessInstanceRow[]>`
        SELECT *
        FROM public."process_instances"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${processInstanceId}::uuid
        LIMIT 1
      `;
      const instance = instances[0];
      if (instance === undefined) return null;
      const steps = await transaction.$queryRaw<ProcessStepRow[]>`
        SELECT *
        FROM public."process_step_instances"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "process_instance_id" = ${processInstanceId}::uuid
        ORDER BY "created_at" ASC, "attempt" ASC, "id" ASC
      `;
      return {
        instance: mapProcessInstanceRow(instance),
        steps: steps.map(mapProcessStepRow),
      };
    });
  }

  async executeProcessCommand(
    input: ProcessRuntimeCommandInput,
  ): Promise<RuntimeMutationResult<ProcessInstance>> {
    try {
      return await withProcessTenant(this.prisma, input.principal.tenantId, async (transaction) => {
        const replay = await findProcessCommandReplay(
          transaction,
          input.principal.tenantId,
          input.command,
        );
        if (replay === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
        if (replay === 'MATCH') {
          const current = await lockProcessInstance(
            transaction,
            input.principal.tenantId,
            input.command.processInstanceId,
          );
          return current === null
            ? { kind: 'NOT_FOUND' }
            : { kind: 'IDEMPOTENT_REPLAY', value: mapProcessInstanceRow(current) };
        }

        const current = await lockProcessInstance(
          transaction,
          input.principal.tenantId,
          input.command.processInstanceId,
        );
        if (current === null) return { kind: 'NOT_FOUND' };
        if (current.revision !== input.command.expectedRevision) {
          return {
            kind: 'STALE_REVISION',
            currentRevision: current.revision,
          };
        }
        const taskStatus = await loadProcessTaskStatus(
          transaction,
          input.principal.tenantId,
          current.task_id,
          current.task_version,
        );
        if (
          (taskStatus === null || !ACTIVE_PROCESS_TASK_STATUSES.has(taskStatus)) &&
          !PROCESS_TASK_TERMINATION_COMMANDS.has(input.command.command)
        ) {
          return {
            kind: 'REJECTED',
            reason: 'INVARIANT_VIOLATION',
            detail:
              taskStatus === null
                ? 'Process Instance cannot advance because its Task snapshot is missing.'
                : `Task status ${taskStatus} permits only cancellation or compensation commands.`,
          };
        }

        const completion =
          input.command.command === 'COMPLETE'
            ? await loadCompletionContext(
                transaction,
                input.principal.tenantId,
                current.id,
                current.process_version_id,
              )
            : undefined;
        let nextStatus: ProcessInstance['status'];
        try {
          nextStatus = transitionProcessInstance(current.status, input.command.command, completion);
        } catch (error) {
          return {
            kind: 'REJECTED',
            reason: 'INVALID_TRANSITION',
            detail: error instanceof Error ? error.message : 'Invalid process transition.',
          };
        }

        const updatedRows = await transaction.$queryRaw<ProcessInstanceRow[]>(Prisma.sql`
            UPDATE public."process_instances"
            SET "status" = ${nextStatus}::public."ProcessInstanceStatus",
                "revision" = "revision" + 1,
                "output" = CASE
                  WHEN ${input.command.output === undefined}
                    THEN "output"
                  ELSE ${JSON.stringify(input.command.output ?? {})}::jsonb
                END,
                "failure_code" = ${input.command.failureCode ?? null},
                "failure_detail" = ${input.command.failureDetail ?? null},
                "started_at" = CASE
                  WHEN ${input.command.command === 'START'}
                    THEN ${new Date(input.command.effectiveAt)}
                  ELSE "started_at"
                END,
                "paused_at" = CASE
                  WHEN ${input.command.command === 'PAUSE'}
                    THEN ${new Date(input.command.effectiveAt)}
                  ELSE "paused_at"
                END,
                "completed_at" = CASE
                  WHEN ${input.command.command === 'COMPLETE'}
                    THEN ${new Date(input.command.effectiveAt)}
                  ELSE "completed_at"
                END,
                "cancelled_at" = CASE
                  WHEN ${input.command.command === 'CANCEL'}
                    THEN ${new Date(input.command.effectiveAt)}
                  ELSE "cancelled_at"
                END,
                "compensation_started_at" = CASE
                  WHEN ${input.command.command === 'BEGIN_COMPENSATION'}
                    THEN ${new Date(input.command.effectiveAt)}
                  ELSE "compensation_started_at"
                END,
                "compensation_completed_at" = CASE
                  WHEN ${input.command.command === 'COMPLETE_COMPENSATION'}
                    THEN ${new Date(input.command.effectiveAt)}
                  ELSE "compensation_completed_at"
                END
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "id" = ${current.id}::uuid
              AND "revision" = ${input.command.expectedRevision}
            RETURNING *
          `);
        const updated = updatedRows[0];
        if (updated === undefined) {
          return {
            kind: 'STALE_REVISION',
            currentRevision: current.revision,
          };
        }
        await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."process_commands" (
              "id", "tenant_id", "process_instance_id", "command",
              "expected_revision", "result_revision", "actor_type",
              "actor_user_id", "actor_agent_id", "actor_service_id",
              "actor_role_assignment_id", "reason", "payload",
              "effective_at", "idempotency_key"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${input.principal.tenantId}::uuid,
              ${current.id}::uuid,
              ${input.command.command}::public."ProcessCommandType",
              ${input.command.expectedRevision},
              ${updated.revision},
              'USER'::public."ProcessActorType",
              ${input.principal.userId}::uuid,
              NULL,
              NULL,
              NULL,
              ${input.command.reason},
              ${JSON.stringify(commandPayload(input.command))}::jsonb,
              ${new Date(input.command.effectiveAt)},
              ${input.command.idempotencyKey}
            )
          `);
        await insertProcessBusinessEvent(transaction, input, updated);
        await appendRuntimeAuditAndOutbox(transaction, input.principal, {
          action: `process.instance.${input.command.command.toLowerCase()}`,
          resourceType: 'PROCESS_INSTANCE',
          resourceId: updated.id,
          eventType: `ProcessInstance.${nextStatus}`,
          payload: {
            processInstanceId: updated.id,
            taskId: updated.task_id,
            command: input.command.command,
            revision: updated.revision,
            correlationId: updated.correlation_id,
          },
          occurredAt: new Date(input.command.effectiveAt),
        });
        return { kind: 'APPLIED', value: mapProcessInstanceRow(updated) };
      });
    } catch (error) {
      return mapProcessDatabaseError(error);
    }
  }

  async executeStepCommand(
    input: ProcessStepRuntimeCommandInput,
  ): Promise<RuntimeMutationResult<ProcessStepInstance>> {
    try {
      return await withProcessTenant(this.prisma, input.principal.tenantId, async (transaction) => {
        const replay = await findStepCommandReplay(
          transaction,
          input.principal.tenantId,
          input.processInstanceId,
          input.command,
        );
        if (replay === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
        if (replay === 'MATCH') {
          const current = await lockProcessStep(
            transaction,
            input.principal.tenantId,
            input.processInstanceId,
            input.command.stepInstanceId,
          );
          return current === null
            ? { kind: 'NOT_FOUND' }
            : { kind: 'IDEMPOTENT_REPLAY', value: mapProcessStepRow(current) };
        }

        const current = await lockProcessStep(
          transaction,
          input.principal.tenantId,
          input.processInstanceId,
          input.command.stepInstanceId,
        );
        if (current === null) return { kind: 'NOT_FOUND' };
        if (current.revision !== input.command.expectedRevision) {
          return {
            kind: 'STALE_REVISION',
            currentRevision: current.revision,
          };
        }
        const transitionContext = await loadStepTransitionContext(transaction, input, current);
        let nextStatus: ProcessStepStatus;
        let nextAttempt: number;
        try {
          nextStatus = transitionStepInstance(
            current.status,
            input.command.command,
            transitionContext,
          );
          nextAttempt = nextProcessStepAttempt(current.attempt, input.command.command);
        } catch (error) {
          return {
            kind: 'REJECTED',
            reason: 'INVALID_TRANSITION',
            detail: error instanceof Error ? error.message : 'Invalid Process Step transition.',
          };
        }

        const effectiveAt = new Date(input.command.effectiveAt);
        const updatedRows = await transaction.$queryRaw<ProcessStepRow[]>(Prisma.sql`
            UPDATE public."process_step_instances"
            SET "status" = ${nextStatus}::public."ProcessStepStatus",
                "revision" = "revision" + 1,
                "attempt" = ${nextAttempt},
                "output" = CASE
                  WHEN ${input.command.output === undefined}
                    THEN "output"
                  ELSE ${JSON.stringify(input.command.output ?? {})}::jsonb
                END,
                "failure_code" = ${input.command.failureCode ?? null},
                "failure_detail" = ${input.command.failureDetail ?? null},
                "claimed_at" = CASE
                  WHEN ${input.command.command === 'CLAIM'} THEN ${effectiveAt}
                  WHEN ${input.command.command === 'RETRY'} THEN NULL
                  ELSE "claimed_at"
                END,
                "started_at" = CASE
                  WHEN ${input.command.command === 'CLAIM'} THEN ${effectiveAt}
                  WHEN ${input.command.command === 'BEGIN_COMPENSATION'}
                    THEN COALESCE("started_at", ${effectiveAt})
                  ELSE "started_at"
                END,
                "completed_at" = CASE
                  WHEN ${['COMPLETE', 'REJECT', 'COMPLETE_COMPENSATION'].includes(
                    input.command.command,
                  )} THEN ${effectiveAt}
                  ELSE "completed_at"
                END,
                "timed_out_at" = CASE
                  WHEN ${input.command.command === 'TIMEOUT'} THEN ${effectiveAt}
                  WHEN ${input.command.command === 'RETRY'} THEN NULL
                  ELSE "timed_out_at"
                END
            WHERE "tenant_id" = ${input.principal.tenantId}::uuid
              AND "process_instance_id" = ${input.processInstanceId}::uuid
              AND "id" = ${current.id}::uuid
              AND "revision" = ${input.command.expectedRevision}
            RETURNING *
          `);
        const updated = updatedRows[0];
        if (updated === undefined) {
          return {
            kind: 'STALE_REVISION',
            currentRevision: current.revision,
          };
        }
        const serviceActor = input.command.actorRoleAssignmentId === null;
        await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."process_step_commands" (
              "id", "tenant_id", "process_step_instance_id", "command",
              "expected_revision", "result_revision", "actor_type",
              "actor_user_id", "actor_agent_id", "actor_service_id",
              "actor_role_assignment_id", "reason", "payload",
              "effective_at", "idempotency_key"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${input.principal.tenantId}::uuid,
              ${current.id}::uuid,
              ${input.command.command}::public."ProcessStepCommandType",
              ${input.command.expectedRevision},
              ${updated.revision},
              ${serviceActor ? 'SERVICE' : 'USER'}::public."ProcessActorType",
              ${serviceActor ? null : input.principal.userId}::uuid,
              NULL,
              ${serviceActor ? 'admin-runtime-governance' : null},
              ${input.command.actorRoleAssignmentId}::uuid,
              ${input.command.reason},
              ${JSON.stringify(stepCommandPayload(input.command))}::jsonb,
              ${effectiveAt},
              ${input.command.idempotencyKey}
            )
          `);
        await insertStepBusinessEvent(transaction, input, updated);
        await appendRuntimeAuditAndOutbox(transaction, input.principal, {
          action: `process.step.${input.command.command.toLowerCase()}`,
          resourceType: 'PROCESS_STEP',
          resourceId: updated.id,
          eventType: `ProcessStep.${nextStatus}`,
          payload: {
            processInstanceId: input.processInstanceId,
            stepInstanceId: updated.id,
            command: input.command.command,
            revision: updated.revision,
          },
          occurredAt: effectiveAt,
        });
        return { kind: 'APPLIED', value: mapProcessStepRow(updated) };
      });
    } catch (error) {
      return mapProcessDatabaseError(error);
    }
  }
}

async function lockProcessInstance(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<ProcessInstanceRow | null> {
  const rows = await transaction.$queryRaw<ProcessInstanceRow[]>`
    SELECT *
    FROM public."process_instances"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "id" = ${id}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockProcessStep(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  processInstanceId: string,
  id: string,
): Promise<ProcessStepRow | null> {
  const rows = await transaction.$queryRaw<ProcessStepRow[]>`
    SELECT *
    FROM public."process_step_instances"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "process_instance_id" = ${processInstanceId}::uuid
      AND "id" = ${id}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function findProcessCommandReplay(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  command: ProcessCommand,
): Promise<'NONE' | 'MATCH' | 'CONFLICT'> {
  const rows = await transaction.$queryRaw<ProcessCommandRow[]>`
    SELECT *
    FROM public."process_commands"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "idempotency_key" = ${command.idempotencyKey}
    LIMIT 1
  `;
  const existing = rows[0];
  if (existing === undefined) return 'NONE';
  return existing.process_instance_id === command.processInstanceId &&
    existing.command === command.command &&
    existing.expected_revision === command.expectedRevision &&
    existing.reason === command.reason &&
    existing.effective_at.toISOString() === new Date(command.effectiveAt).toISOString() &&
    runtimeHash(existing.payload) === runtimeHash(commandPayload(command))
    ? 'MATCH'
    : 'CONFLICT';
}

async function findStepCommandReplay(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  processInstanceId: string,
  command: ProcessStepCommand,
): Promise<'NONE' | 'MATCH' | 'CONFLICT'> {
  const rows = await transaction.$queryRaw<ProcessStepCommandRow[]>`
    SELECT command.*, step."process_instance_id"
    FROM public."process_step_commands" command
    JOIN public."process_step_instances" step
      ON step."tenant_id" = command."tenant_id"
     AND step."id" = command."process_step_instance_id"
    WHERE command."tenant_id" = ${tenantId}::uuid
      AND command."idempotency_key" = ${command.idempotencyKey}
    LIMIT 1
  `;
  const existing = rows[0];
  if (existing === undefined) return 'NONE';
  return existing.process_instance_id === processInstanceId &&
    existing.process_step_instance_id === command.stepInstanceId &&
    existing.command === command.command &&
    existing.expected_revision === command.expectedRevision &&
    existing.actor_role_assignment_id === command.actorRoleAssignmentId &&
    existing.reason === command.reason &&
    existing.effective_at.toISOString() === new Date(command.effectiveAt).toISOString() &&
    runtimeHash(existing.payload) === runtimeHash(stepCommandPayload(command))
    ? 'MATCH'
    : 'CONFLICT';
}

async function loadCompletionContext(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  instanceId: string,
  processVersionId: string,
) {
  const rows = await transaction.$queryRaw<CompletionRow[]>`
    SELECT DISTINCT ON (node."id")
      step."id",
      node."type"::text AS node_type,
      step."status"::text AS status,
      COALESCE((node."configuration"->>'required')::boolean, true) AS required
    FROM public."process_nodes" node
    LEFT JOIN public."process_step_instances" step
      ON step."tenant_id" = node."tenant_id"
     AND step."process_instance_id" = ${instanceId}::uuid
     AND step."process_node_id" = node."id"
    WHERE node."tenant_id" = ${tenantId}::uuid
      AND node."process_version_id" = ${processVersionId}::uuid
      AND node."type" <> 'START'
    ORDER BY node."id", step."attempt" DESC NULLS LAST
  `;
  const steps: ProcessCompletionStep[] = rows.map((row) => ({
    id: row.id ?? `missing:${row.node_type}`,
    nodeType: normalizeNodeType(row.node_type),
    status: (row.status ?? 'WAITING') as ProcessStepStatus,
    requiredForCompletion: row.required,
  }));
  return {
    reachedEnd: rows.some((row) => row.node_type === 'END' && row.status === 'COMPLETED'),
    steps,
  };
}

async function loadStepTransitionContext(
  transaction: Prisma.TransactionClient,
  input: ProcessStepRuntimeCommandInput,
  current: ProcessStepRow,
) {
  const nodes = await transaction.$queryRaw<Array<{ type: string }>>`
    SELECT "type"::text AS type
    FROM public."process_nodes"
    WHERE "tenant_id" = ${input.principal.tenantId}::uuid
      AND "id" = ${current.process_node_id}::uuid
    LIMIT 1
  `;
  const actor: TrustedProcessStepActor =
    input.command.actorRoleAssignmentId === null
      ? {
          type: 'SYSTEM',
          tenantId: input.principal.tenantId,
          userId: null,
          agentId: null,
          roleAssignment: null,
        }
      : await loadTrustedUserStepActor(
          transaction,
          input.principal.tenantId,
          input.principal.userId,
          input.command.actorRoleAssignmentId,
        );
  const evidenceIds = jsonObject(input.command.output ?? {}).evidenceIds;
  return {
    tenantId: input.principal.tenantId,
    nodeType: normalizeNodeType(nodes[0]?.type ?? ''),
    resolvedRoleAssignmentId: current.resolved_role_assignment_id,
    resolvedAgentId: current.resolved_agent_id,
    actor,
    evidenceSealed: Array.isArray(evidenceIds) && evidenceIds.length > 0,
    skipAuthorized: true,
    now: new Date(input.command.effectiveAt),
  };
}

async function loadTrustedUserStepActor(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  roleAssignmentId: string,
): Promise<TrustedProcessStepActor> {
  const rows = await transaction.$queryRaw<TrustedStepAssignmentRow[]>`
    SELECT
      assignment."id",
      assignment."tenant_id",
      assignment."user_id",
      assignment."agent_instance_id",
      assignment."status"::text AS status,
      employment."status"::text AS employment_status,
      unit."status"::text AS org_unit_status,
      version."status"::text AS role_version_status,
      assignment."effective_from",
      assignment."effective_to"
    FROM public."role_assignments" assignment
    JOIN public."employments" employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
    JOIN public."organization_units" unit
      ON unit."tenant_id" = employment."tenant_id"
     AND unit."id" = employment."org_unit_id"
    JOIN public."agent_versions" version
      ON version."tenant_id" = assignment."tenant_id"
     AND version."id" = assignment."role_version_id"
    WHERE assignment."tenant_id" = ${tenantId}::uuid
      AND assignment."id" = ${roleAssignmentId}::uuid
      AND assignment."user_id" = ${userId}::uuid
    LIMIT 1
  `;
  const row = rows[0];
  return {
    type: 'USER',
    tenantId,
    userId,
    agentId: null,
    roleAssignment:
      row === undefined
        ? null
        : {
            id: row.id,
            tenantId: row.tenant_id,
            userId: row.user_id,
            agentId: row.agent_instance_id,
            status: row.status as 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED',
            employmentStatus: row.employment_status as
              'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED',
            orgUnitStatus: row.org_unit_status as 'ACTIVE' | 'ARCHIVED',
            roleVersionStatus: row.role_version_status as
              'DRAFT' | 'TESTING' | 'PUBLISHED' | 'RETIRED',
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
          },
  };
}

async function insertProcessBusinessEvent(
  transaction: Prisma.TransactionClient,
  input: ProcessRuntimeCommandInput,
  instance: ProcessInstanceRow,
): Promise<void> {
  const eventId = randomUUID();
  const payload = {
    processInstanceId: instance.id,
    taskId: instance.task_id,
    command: input.command.command,
    status: instance.status,
    revision: instance.revision,
  };
  await insertBusinessEvent(transaction, {
    id: eventId,
    tenantId: input.principal.tenantId,
    eventType: `ProcessInstance.${instance.status}`,
    aggregateType: 'PROCESS_INSTANCE',
    aggregateId: instance.id,
    aggregateVersion: instance.revision,
    subjectType: 'TASK',
    subjectId: instance.task_id,
    subjectVersion: instance.task_version,
    occurredAt: new Date(input.command.effectiveAt),
    organizationScope: emptyOrganizationScope(instance.permission_labels),
    payload,
    correlationId: instance.correlation_id,
    idempotencyKey: `runtime-event:${runtimeHash(`process:${input.command.idempotencyKey}`)}`,
    sourceRecordId: instance.id,
    sourceVersion: String(instance.revision),
    permissionLabels: stringArray(instance.permission_labels),
  });
}

async function insertStepBusinessEvent(
  transaction: Prisma.TransactionClient,
  input: ProcessStepRuntimeCommandInput,
  step: ProcessStepRow,
): Promise<void> {
  const instances = await transaction.$queryRaw<ProcessInstanceRow[]>`
    SELECT *
    FROM public."process_instances"
    WHERE "tenant_id" = ${input.principal.tenantId}::uuid
      AND "id" = ${input.processInstanceId}::uuid
    LIMIT 1
  `;
  const instance = instances[0];
  if (instance === undefined) throw new Error('Process Instance disappeared.');
  const payload = {
    processInstanceId: instance.id,
    stepInstanceId: step.id,
    taskId: instance.task_id,
    command: input.command.command,
    status: step.status,
    revision: step.revision,
  };
  await insertBusinessEvent(transaction, {
    id: randomUUID(),
    tenantId: input.principal.tenantId,
    eventType: `ProcessStep.${step.status}`,
    aggregateType: 'PROCESS_INSTANCE',
    aggregateId: instance.id,
    aggregateVersion: instance.revision,
    subjectType: 'TASK',
    subjectId: instance.task_id,
    subjectVersion: instance.task_version,
    occurredAt: new Date(input.command.effectiveAt),
    organizationScope: emptyOrganizationScope(instance.permission_labels),
    payload,
    correlationId: instance.correlation_id,
    idempotencyKey: `runtime-event:${runtimeHash(`step:${input.command.idempotencyKey}`)}`,
    sourceRecordId: step.id,
    sourceVersion: String(step.revision),
    permissionLabels: stringArray(instance.permission_labels),
  });
}

async function insertBusinessEvent(
  transaction: Prisma.TransactionClient,
  event: {
    readonly id: string;
    readonly tenantId: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly subjectVersion: number;
    readonly occurredAt: Date;
    readonly organizationScope: Record<string, unknown>;
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly sourceRecordId: string;
    readonly sourceVersion: string;
    readonly permissionLabels: readonly string[];
  },
): Promise<void> {
  const producedAt = new Date(Math.max(event.occurredAt.getTime(), Date.now()));
  const retainUntil = new Date(producedAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 1);
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
      ${event.id}::uuid,
      ${event.tenantId}::uuid,
      ${event.eventType},
      1,
      ${event.aggregateType}::public."BusinessEventSubjectType",
      ${event.aggregateId}::uuid,
      ${event.aggregateVersion},
      ${event.subjectType}::public."BusinessEventSubjectType",
      ${event.subjectId}::uuid,
      ${event.subjectVersion},
      ${event.occurredAt},
      ${producedAt},
      ${JSON.stringify(event.organizationScope)}::jsonb,
      ${JSON.stringify(event.payload)}::jsonb,
      '[]'::jsonb,
      ${event.correlationId}::uuid,
      NULL,
      ${event.idempotencyKey},
      'INTERNAL'::public."BusinessEventSensitivity",
      ${retainUntil},
      'ARCHIVE'::public."BusinessEventRetentionAction",
      false,
      'enterprise-api',
      ${event.sourceRecordId},
      ${event.sourceVersion},
      'process-runtime',
      ${JSON.stringify(event.permissionLabels)}::jsonb,
      ${runtimeHash(event)}
    )
  `);
}

function commandPayload(command: ProcessCommand): Record<string, unknown> {
  return {
    ...(command.output === undefined ? {} : { output: command.output }),
    ...(command.failureCode === undefined
      ? {}
      : {
          failureCode: command.failureCode,
          failureDetail: command.failureDetail,
        }),
  };
}

function stepCommandPayload(command: ProcessStepCommand): Record<string, unknown> {
  return commandPayload({
    processInstanceId: command.stepInstanceId,
    expectedRevision: command.expectedRevision,
    command:
      command.command === 'FAIL_COMPENSATION'
        ? 'FAIL_COMPENSATION'
        : command.command === 'FAIL'
          ? 'FAIL'
          : 'START',
    reason: command.reason,
    effectiveAt: command.effectiveAt,
    idempotencyKey: command.idempotencyKey,
    ...(command.output === undefined ? {} : { output: command.output }),
    ...(command.failureCode === undefined
      ? {}
      : {
          failureCode: command.failureCode,
          failureDetail: command.failureDetail,
        }),
  });
}

function emptyOrganizationScope(permissionLabels: unknown): Record<string, unknown> {
  return {
    orgUnitIds: [],
    projectIds: [],
    customerIds: [],
    dataLabels: stringArray(permissionLabels),
  };
}

function normalizeNodeType(value: string): ProcessNodeType {
  if (
    value === 'START' ||
    value === 'HUMAN_APPROVAL' ||
    value === 'AGENT_EXECUTION' ||
    value === 'CONDITION' ||
    value === 'COMPENSATION' ||
    value === 'END'
  ) {
    return value;
  }
  if (value === 'TIMER' || value === 'ACTIVITY' || value === 'DECISION' || value === 'MILESTONE') {
    return 'CONDITION';
  }
  throw new Error('Process Step references an unsupported node type.');
}

function mapProcessDatabaseError(error: unknown): RuntimeMutationResult<never> {
  if (isDatabaseConflict(error)) {
    return { kind: 'IDEMPOTENCY_CONFLICT' };
  }
  if (isDatabaseRejection(error)) {
    return {
      kind: 'REJECTED',
      reason: 'INVARIANT_VIOLATION',
      detail: databaseErrorText(error).slice(0, 2_000),
    };
  }
  throw error;
}

function mapProcessInstanceRow(row: ProcessInstanceRow): ProcessInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    processDefinitionId: row.process_definition_id,
    processVersionId: row.process_version_id,
    processVersion: row.process_version,
    objectiveId: row.objective_id,
    taskId: row.task_id,
    triggerEventId: row.trigger_event_id,
    correlationId: row.correlation_id,
    status: row.status,
    revision: row.revision,
    input: jsonObject(row.input),
    output: nullableJsonObject(row.output),
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    startedAt: iso(row.started_at),
    pausedAt: iso(row.paused_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    compensationStartedAt: iso(row.compensation_started_at),
    compensationCompletedAt: iso(row.compensation_completed_at),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapProcessStepRow(row: ProcessStepRow): ProcessStepInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    processInstanceId: row.process_instance_id,
    processNodeId: row.process_node_id,
    processNodeCode: row.process_node_code,
    attempt: row.attempt,
    status: row.status,
    revision: row.revision,
    resolvedRoleAssignmentId: row.resolved_role_assignment_id,
    resolvedAgentId: row.resolved_agent_id,
    assignmentSnapshot: nullableJsonObject(row.assignment_snapshot),
    input: jsonObject(row.input),
    output: nullableJsonObject(row.output),
    availableAt: row.available_at.toISOString(),
    claimedAt: iso(row.claimed_at),
    startedAt: iso(row.started_at),
    dueAt: iso(row.due_at),
    completedAt: iso(row.completed_at),
    timedOutAt: iso(row.timed_out_at),
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    compensationForStepId: row.compensation_for_step_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

interface ProcessInstanceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly process_definition_id: string;
  readonly process_version_id: string;
  readonly process_version: number;
  readonly objective_id: string;
  readonly objective_version: number;
  readonly task_id: string;
  readonly task_version: number;
  readonly trigger_event_id: string | null;
  readonly correlation_id: string;
  readonly status: ProcessInstance['status'];
  readonly revision: number;
  readonly input: unknown;
  readonly output: unknown | null;
  readonly failure_code: string | null;
  readonly failure_detail: string | null;
  readonly permission_labels: unknown;
  readonly started_at: Date | null;
  readonly paused_at: Date | null;
  readonly completed_at: Date | null;
  readonly cancelled_at: Date | null;
  readonly compensation_started_at: Date | null;
  readonly compensation_completed_at: Date | null;
  readonly idempotency_key: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProcessStepRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly process_instance_id: string;
  readonly process_definition_id: string;
  readonly process_version_id: string;
  readonly process_version: number;
  readonly process_node_id: string;
  readonly process_node_code: string;
  readonly attempt: number;
  readonly status: ProcessStepStatus;
  readonly revision: number;
  readonly resolved_role_assignment_id: string | null;
  readonly resolved_agent_id: string | null;
  readonly assignment_snapshot: unknown | null;
  readonly input: unknown;
  readonly output: unknown | null;
  readonly available_at: Date;
  readonly claimed_at: Date | null;
  readonly started_at: Date | null;
  readonly due_at: Date | null;
  readonly completed_at: Date | null;
  readonly timed_out_at: Date | null;
  readonly failure_code: string | null;
  readonly failure_detail: string | null;
  readonly compensation_for_step_id: string | null;
  readonly idempotency_key: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProcessCommandRow {
  readonly process_instance_id: string;
  readonly command: ProcessCommand['command'];
  readonly expected_revision: number;
  readonly reason: string;
  readonly payload: unknown;
  readonly effective_at: Date;
}

interface ProcessStepCommandRow {
  readonly process_instance_id: string;
  readonly process_step_instance_id: string;
  readonly command: ProcessStepCommand['command'];
  readonly expected_revision: number;
  readonly actor_role_assignment_id: string | null;
  readonly reason: string;
  readonly payload: unknown;
  readonly effective_at: Date;
}

interface CompletionRow {
  readonly id: string | null;
  readonly node_type: string;
  readonly status: string | null;
  readonly required: boolean;
}

interface TrustedStepAssignmentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly agent_instance_id: string;
  readonly status: string;
  readonly employment_status: string;
  readonly org_unit_status: string;
  readonly role_version_status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

const ACTIVE_PROCESS_TASK_STATUSES = new Set(['READY', 'IN_PROGRESS', 'BLOCKED']);
const PROCESS_TASK_TERMINATION_COMMANDS = new Set<ProcessCommand['command']>([
  'CANCEL',
  'BEGIN_COMPENSATION',
  'COMPLETE_COMPENSATION',
  'FAIL_COMPENSATION',
]);

async function loadProcessTaskStatus(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
  taskVersion: number,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ status: string }>>`
    SELECT task."status"::text AS status
    FROM public."tasks" task
    WHERE task."tenant_id" = ${tenantId}::uuid
      AND task."id" = ${taskId}::uuid
      AND task."version" = ${taskVersion}
    FOR SHARE
  `;
  return rows[0]?.status ?? null;
}
