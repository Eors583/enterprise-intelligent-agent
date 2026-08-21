import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateEvidenceRequest,
  CreateMetricDefinitionRequest,
  CreateObjectiveRequest,
  CreateProcessDefinitionRequest,
  CreateProcessVersionRequest,
  CreateStrategyRequest,
  CreateTaskRequest,
  CreateValueDefinitionRequest,
  CreateValueVersionRequest,
  Evidence,
  MetricDefinition,
  Objective,
  ProcessDefinition,
  ProcessVersion,
  Strategy,
  Task,
  TransitionEvidenceRequest,
  TransitionMetricDefinitionRequest,
  TransitionObjectiveRequest,
  TransitionProcessVersionRequest,
  TransitionStrategyRequest,
  TransitionTaskRequest,
  TransitionValueVersionRequest,
  UpdateEvidenceRequest,
  UpdateMetricDefinitionRequest,
  UpdateObjectiveRequest,
  UpdateProcessDefinitionRequest,
  UpdateProcessVersionRequest,
  UpdateStrategyRequest,
  UpdateTaskRequest,
  UpdateValueDefinitionRequest,
  UpdateValueVersionRequest,
  ValueDefinition,
  ValueVersion,
} from '@enterprise/contracts';
import {
  Prisma,
  type MetricDefinition as DbMetricDefinition,
  type Objective as DbObjective,
  type ProcessVersion as DbProcessVersion,
  type Strategy as DbStrategy,
  type Task as DbTask,
  type ValueVersion as DbValueVersion,
} from '@prisma/client';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import {
  mapEvidence,
  mapMetricDefinition,
  mapObjective,
  mapProcessDefinition,
  mapProcessVersion,
  mapStrategy,
  mapTask,
  mapValueDefinition,
  mapValueVersion,
  ownerColumns,
  verifierColumns,
} from './business-semantics.mapper.js';
import {
  BusinessSemanticsPolicyService,
  semanticResource,
} from './business-semantics-policy.service.js';
import {
  assertIdempotentReplay,
  idempotencyIdentity,
  isConstraintConflict,
  isUniqueConflict,
  lockIdempotency,
  recordBusinessMutation,
  toJson,
} from './business-semantics.mutation.js';

@Injectable()
export class TaskAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listTasks(): Promise<{ items: Task[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.task.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ dueAt: 'asc' }, { code: 'asc' }, { version: 'desc' }],
          take: 5_000,
        })
      ).map(mapTask),
    }));
  }

  async createTask(request: CreateTaskRequest, suppliedKey?: string): Promise<Task> {
    if (request.processRef.instanceId !== null) {
      throw new ConflictException(
        'Process runtime instances are not accepted until the runtime layer is installed.',
      );
    }
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'task', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.task.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.task.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return mapTask(replay);
        }
        const references = await resolveTaskReferences(transaction, principal.tenantId, request);
        const created = await transaction.task.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            ...references,
            processInstanceId: null,
            title: request.title,
            description: request.description,
            priority: request.priority,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: dateOrNull(request.effectiveTo),
            dueAt: new Date(request.dueAt),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.task.created',
          'task',
          created.id,
          {
            code: created.code,
            version: created.version,
            objectiveId: created.objectiveId,
            valueVersionId: created.valueVersionId,
            processVersionId: created.processVersionId,
          },
        );
        return mapTask(created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Task');
    }
  }

  async updateTask(id: string, request: UpdateTaskRequest): Promise<Task> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'tasks', principal.tenantId, id);
      const current = await transaction.task.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Task');
      if (current.revision !== request.expectedRevision) throw stale('Task');
      await this.policy.requireWrite(transaction, principal, 'business.task.update', {
        resource: semanticResource('TASK', current, { taskId: current.id }),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
          proposedTaskId: current.id,
        },
      });
      const merged = taskRequestFromPatch(current, request);
      const references = await resolveTaskReferences(transaction, principal.tenantId, merged);
      if (current.status !== 'PLANNED') {
        if (!['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(current.status)) {
          throw new ConflictException(
            'Only terminal Tasks may be superseded by a new definition version.',
          );
        }
        const claimed = await transaction.task.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: { revision: { increment: 1 } },
        });
        if (claimed.count !== 1) throw stale('Task');
        const identity = idempotencyIdentity({ id, ...request });
        const created = await transaction.task.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: merged.code,
            version: current.version + 1,
            previousVersionId: current.id,
            previousVersionNumber: current.version,
            ...references,
            processInstanceId: null,
            title: merged.title,
            description: merged.description,
            priority: merged.priority,
            ...ownerColumns(merged.owner),
            permissionLabels: toJson(merged.permissionLabels),
            effectiveFrom: new Date(merged.effectiveFrom),
            effectiveTo: dateOrNull(merged.effectiveTo),
            dueAt: new Date(merged.dueAt),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.task.version_created',
          'task',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        return mapTask(created);
      }
      const result = await transaction.task.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: 'PLANNED',
        },
        data: {
          code: merged.code,
          ...references,
          title: merged.title,
          description: merged.description,
          priority: merged.priority,
          ...ownerColumns(merged.owner),
          permissionLabels: toJson(merged.permissionLabels),
          effectiveFrom: new Date(merged.effectiveFrom),
          effectiveTo: dateOrNull(merged.effectiveTo),
          dueAt: new Date(merged.dueAt),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw stale('Task');
      const updated = await transaction.task.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.task.updated',
        'task',
        id,
        { version: updated.version, revision: updated.revision },
      );
      return mapTask(updated);
    });
  }

  async transitionTask(id: string, request: TransitionTaskRequest): Promise<Task> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'tasks', principal.tenantId, id);
      const current = await transaction.task.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Task');
      if (current.revision !== request.expectedRevision) throw stale('Task');
      await this.policy.requireWrite(transaction, principal, 'business.task.transition', {
        resource: semanticResource('TASK', current, { taskId: current.id }),
        mutation: { proposedTaskId: current.id },
      });
      await assertTaskTransitionEvidence(transaction, principal.tenantId, current, request.action);
      const at = new Date(request.effectiveAt);
      const data = taskTransitionData(current, request.action, at);
      const result = await transaction.task.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: current.status,
        },
        data: { ...data, revision: { increment: 1 } },
      });
      if (result.count !== 1) throw stale('Task');
      const updated = await transaction.task.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        `business_semantics.task.${request.action.toLowerCase()}`,
        'task',
        id,
        { reason: request.reason, version: updated.version, revision: updated.revision },
      );
      return mapTask(updated);
    });
  }
}

interface TaskReferences {
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly objectiveId: string;
  readonly objectiveVersion: number;
  readonly valueDefinitionId: string;
  readonly valueVersionId: string;
  readonly valueVersionNumber: number;
  readonly processDefinitionId: string;
  readonly processDefinitionCode: string;
  readonly processVersionId: string;
  readonly processVersion: number;
  readonly processNodeId: string;
  readonly processNodeCode: string;
}

async function resolveTaskReferences(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  request: CreateTaskRequest,
): Promise<TaskReferences> {
  const objective = await transaction.objective.findFirst({
    where: { tenantId, id: request.objectiveId },
  });
  if (objective === null) throw notFound('Objective');
  const valueLink = await transaction.objectiveValueVersion.findFirst({
    where: {
      tenantId,
      objectiveId: objective.id,
      objectiveVersion: objective.version,
      strategyId: objective.strategyId,
      strategyVersion: objective.strategyVersion,
      valueDefinitionId: request.valueDefinitionId,
      valueVersionId: request.valueVersionId,
    },
  });
  if (valueLink === null) {
    throw new ConflictException('Task Value Version must be linked by its Objective and Strategy.');
  }
  const [strategy, valueVersion, processDefinition, processVersion, processNode] =
    await Promise.all([
      transaction.strategy.findFirst({
        where: {
          tenantId,
          id: objective.strategyId,
          version: objective.strategyVersion,
        },
      }),
      transaction.valueVersion.findFirst({
        where: {
          tenantId,
          id: valueLink.valueVersionId,
          version: valueLink.valueVersionNumber,
          valueDefinitionId: valueLink.valueDefinitionId,
        },
      }),
      transaction.processDefinition.findFirst({
        where: {
          tenantId,
          id: request.processRef.definitionId,
          code: request.processRef.definitionCode,
        },
      }),
      transaction.processVersion.findFirst({
        where: {
          tenantId,
          id: request.processRef.versionId,
          processDefinitionId: request.processRef.definitionId,
          version: request.processRef.version,
        },
      }),
      transaction.processNode.findFirst({
        where: {
          tenantId,
          id: request.processRef.nodeId,
          processDefinitionId: request.processRef.definitionId,
          processVersionId: request.processRef.versionId,
          processVersion: request.processRef.version,
          code: request.processRef.nodeCode,
        },
      }),
    ]);
  if (
    strategy?.status !== 'ACTIVE' ||
    !['ACTIVE', 'AT_RISK'].includes(objective.status) ||
    valueVersion?.status !== 'PUBLISHED' ||
    processDefinition?.status !== 'ACTIVE' ||
    processVersion?.status !== 'PUBLISHED' ||
    processNode === null
  ) {
    throw new ConflictException(
      'Task requires active Objective/Strategy and published Value/Process references.',
    );
  }
  const taskPeriod = {
    effectiveFrom: new Date(request.effectiveFrom),
    effectiveTo: dateOrNull(request.effectiveTo),
    dueAt: new Date(request.dueAt),
  };
  for (const reference of [strategy, objective, valueVersion, processDefinition, processVersion]) {
    if (!containsTaskPeriod(reference, taskPeriod)) {
      throw new ConflictException(
        'Task effective period must fit every referenced business version.',
      );
    }
  }
  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    objectiveId: objective.id,
    objectiveVersion: objective.version,
    valueDefinitionId: valueLink.valueDefinitionId,
    valueVersionId: valueLink.valueVersionId,
    valueVersionNumber: valueLink.valueVersionNumber,
    processDefinitionId: processDefinition.id,
    processDefinitionCode: processDefinition.code,
    processVersionId: processVersion.id,
    processVersion: processVersion.version,
    processNodeId: processNode.id,
    processNodeCode: processNode.code,
  };
}

function taskRequestFromPatch(current: DbTask, request: UpdateTaskRequest): CreateTaskRequest {
  return {
    code: request.code ?? current.code,
    objectiveId: request.objectiveId ?? current.objectiveId,
    valueDefinitionId: request.valueDefinitionId ?? current.valueDefinitionId,
    valueVersionId: request.valueVersionId ?? current.valueVersionId,
    processRef: request.processRef ?? {
      definitionId: current.processDefinitionId,
      definitionCode: current.processDefinitionCode,
      versionId: current.processVersionId,
      version: current.processVersion,
      nodeId: current.processNodeId,
      nodeCode: current.processNodeCode,
      instanceId: current.processInstanceId,
    },
    title: request.title ?? current.title,
    description: request.description ?? current.description,
    owner: request.owner ?? mapOwner(current),
    priority: request.priority ?? current.priority,
    effectiveFrom: request.effectiveFrom ?? current.effectiveFrom.toISOString(),
    effectiveTo:
      request.effectiveTo === undefined
        ? (current.effectiveTo?.toISOString() ?? null)
        : request.effectiveTo,
    dueAt: request.dueAt ?? current.dueAt.toISOString(),
    permissionLabels: request.permissionLabels ?? stringArray(current.permissionLabels),
  };
}

export function taskTransitionData(
  current: DbTask,
  action: TransitionTaskRequest['action'],
  at: Date,
): Prisma.TaskUpdateInput {
  switch (action) {
    case 'MAKE_READY':
      if (current.status !== 'PLANNED') throw illegalTransition('Task');
      return { status: 'READY', readyAt: at };
    case 'START':
      if (!['READY', 'BLOCKED'].includes(current.status)) throw illegalTransition('Task');
      return { status: 'IN_PROGRESS', readyAt: current.readyAt ?? at, startedAt: at };
    case 'BLOCK':
      if (!['READY', 'IN_PROGRESS'].includes(current.status)) throw illegalTransition('Task');
      return { status: 'BLOCKED' };
    case 'UNBLOCK':
      if (current.status !== 'BLOCKED') throw illegalTransition('Task');
      return current.startedAt === null ? { status: 'READY' } : { status: 'IN_PROGRESS' };
    case 'DELIVER':
      if (current.status !== 'IN_PROGRESS') throw illegalTransition('Task');
      return { status: 'DELIVERED', deliveredAt: at };
    case 'ACCEPT':
      if (current.status !== 'DELIVERED') throw illegalTransition('Task');
      return { status: 'ACCEPTED', completedAt: at };
    case 'REJECT':
      if (current.status !== 'DELIVERED') throw illegalTransition('Task');
      return { status: 'REJECTED', completedAt: at };
    case 'CANCEL':
      if (['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(current.status)) {
        throw illegalTransition('Task');
      }
      return { status: 'CANCELLED', cancelledAt: at };
  }
}

export async function assertTaskTransitionEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  task: Pick<DbTask, 'id' | 'version'>,
  action: TransitionTaskRequest['action'],
): Promise<void> {
  if (!['DELIVER', 'ACCEPT', 'REJECT'].includes(action)) return;
  const deliverables = await transaction.deliverable.findMany({
    where: {
      tenantId,
      taskId: task.id,
      taskVersion: task.version,
      status:
        action === 'DELIVER'
          ? { in: ['SUBMITTED', 'ACCEPTED', 'REJECTED'] }
          : action === 'ACCEPT'
            ? 'ACCEPTED'
            : 'REJECTED',
      evidenceSealedAt: { not: null },
    },
    select: { id: true, version: true },
  });
  if (deliverables.length === 0) {
    throw new ConflictException(
      'Task transition requires a matching non-Draft Deliverable with sealed Evidence.',
    );
  }
  const evidenceLinks = await transaction.deliverableEvidence.findMany({
    where: {
      tenantId,
      OR: deliverables.map((deliverable) => ({
        deliverableId: deliverable.id,
        deliverableVersion: deliverable.version,
      })),
    },
    select: { deliverableId: true, deliverableVersion: true },
  });
  const evidencedDeliverables = new Set(
    evidenceLinks.map((link) => `${link.deliverableId}:${link.deliverableVersion}`),
  );
  const completeDeliverables = deliverables.filter((deliverable) =>
    evidencedDeliverables.has(`${deliverable.id}:${deliverable.version}`),
  );
  if (completeDeliverables.length === 0) {
    throw new ConflictException(
      'Task transition requires a Deliverable with nonempty sealed Evidence.',
    );
  }
  if (action === 'DELIVER') return;
  const acceptances = await transaction.acceptance.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      evidenceSealedAt: { not: null },
      decision: action === 'ACCEPT' ? 'ACCEPTED' : { in: ['REJECTED', 'CHANGES_REQUESTED'] },
      OR: completeDeliverables.map((deliverable) => ({
        deliverableId: deliverable.id,
        deliverableVersion: deliverable.version,
      })),
    },
    select: { id: true, version: true },
  });
  if (acceptances.length === 0) {
    throw new ConflictException('Terminal Task transition requires a matching active Acceptance.');
  }
  const acceptanceEvidence = await transaction.acceptanceEvidence.count({
    where: {
      tenantId,
      OR: acceptances.map((acceptance) => ({
        acceptanceId: acceptance.id,
        acceptanceVersion: acceptance.version,
      })),
    },
  });
  if (acceptanceEvidence === 0) {
    throw new ConflictException(
      'Terminal Task transition requires nonempty sealed Acceptance Evidence.',
    );
  }
}

function containsTaskPeriod(
  reference: { readonly effectiveFrom: Date; readonly effectiveTo: Date | null },
  task: {
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly dueAt: Date;
  },
): boolean {
  return (
    task.effectiveFrom >= reference.effectiveFrom &&
    (reference.effectiveTo === null ||
      (task.effectiveTo !== null &&
        task.effectiveTo <= reference.effectiveTo &&
        task.dueAt <= reference.effectiveTo))
  );
}

function mapOwner(record: {
  readonly ownerUserId: string | null;
  readonly ownerRoleAssignmentId: string | null;
  readonly ownerRoleTemplateId: string | null;
  readonly ownerOrgUnitId: string | null;
}) {
  if (record.ownerUserId !== null) return { type: 'USER' as const, id: record.ownerUserId };
  if (record.ownerRoleAssignmentId !== null) {
    return { type: 'ROLE_ASSIGNMENT' as const, id: record.ownerRoleAssignmentId };
  }
  if (record.ownerRoleTemplateId !== null) {
    return { type: 'ROLE_BLUEPRINT' as const, id: record.ownerRoleTemplateId };
  }
  if (record.ownerOrgUnitId !== null) {
    return { type: 'ORG_UNIT' as const, id: record.ownerOrgUnitId };
  }
  throw new Error('Business owner columns violate the exactly-one invariant.');
}

async function lockEntity(
  transaction: Prisma.TransactionClient,
  table: string,
  tenantId: string,
  id: string,
): Promise<void> {
  const allowed = new Set([
    'value_definitions',
    'value_versions',
    'strategies',
    'objectives',
    'metric_definitions',
    'process_definitions',
    'process_versions',
    'tasks',
  ]);
  if (!allowed.has(table)) throw new Error('Unsupported semantic entity lock.');
  await transaction.$queryRawUnsafe(
    `SELECT id FROM public."${table}" WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
    tenantId,
    id,
  );
}

function dateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Expected a JSON string array.');
  }
  return [...value];
}

function notFound(resource: string): NotFoundException {
  return new NotFoundException(`${resource} was not found.`);
}

function stale(resource: string): ConflictException {
  return new ConflictException(`${resource} revision is stale.`);
}

function illegalTransition(resource: string): ConflictException {
  return new ConflictException(`${resource} status transition is not allowed.`);
}

function mapWriteError(error: unknown, resource: string): unknown {
  if (error instanceof ConflictException || error instanceof NotFoundException) return error;
  if (isUniqueConflict(error)) {
    return new ConflictException(`${resource} code, version, or idempotency key already exists.`);
  }
  if (isConstraintConflict(error)) {
    return new ConflictException(`${resource} references an invalid tenant-scoped identity.`);
  }
  return error;
}
