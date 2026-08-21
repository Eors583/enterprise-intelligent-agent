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
  lockSemanticGraph,
  recordBusinessMutation,
  toJson,
} from './business-semantics.mutation.js';

@Injectable()
export class ObjectiveAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listObjectives(): Promise<{ items: Objective[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const records = await transaction.objective.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
        take: 2_000,
      });
      return {
        items: await Promise.all(records.map((record) => hydrateObjective(transaction, record))),
      };
    });
  }

  async createObjective(request: CreateObjectiveRequest, suppliedKey?: string): Promise<Objective> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'objective', identity.key);
        await lockSemanticGraph(transaction, principal.tenantId, 'objective-parent');
        await this.policy.requireWrite(transaction, principal, 'business.objective.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedResponsibleRoleAssignmentIds: request.responsibleRoleAssignmentIds,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.objective.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return hydrateObjective(transaction, replay);
        }
        const strategy = await transaction.strategy.findFirst({
          where: { tenantId: principal.tenantId, id: request.strategyId },
        });
        if (strategy === null) throw notFound('Strategy');
        const parent =
          request.parentObjectiveId === null
            ? null
            : await transaction.objective.findFirst({
                where: {
                  tenantId: principal.tenantId,
                  id: request.parentObjectiveId,
                  strategyId: strategy.id,
                  strategyVersion: strategy.version,
                },
              });
        if (request.parentObjectiveId !== null && parent === null) {
          throw new ConflictException('Parent Objective must belong to the selected Strategy.');
        }
        const created = await transaction.objective.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            strategyId: strategy.id,
            strategyVersion: strategy.version,
            parentObjectiveId: parent?.id ?? null,
            parentObjectiveVersion: parent?.version ?? null,
            name: request.name,
            description: request.description,
            bscPerspective: request.bscPerspective,
            indicatorType: request.indicatorType,
            weight: request.weight,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: dateOrNull(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await replaceObjectiveLinks(transaction, principal.tenantId, created, request);
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.objective.created',
          'objective',
          created.id,
          { code: created.code, strategyId: strategy.id, version: created.version },
        );
        return hydrateObjective(transaction, created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Objective');
    }
  }

  async transitionObjective(id: string, request: TransitionObjectiveRequest): Promise<Objective> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'objectives', principal.tenantId, id);
      const current = await transaction.objective.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Objective');
      if (current.revision !== request.expectedRevision) throw stale('Objective');
      const currentLinks = await objectiveLinkIds(transaction, principal.tenantId, current);
      await this.policy.requireWrite(transaction, principal, 'business.objective.transition', {
        resource: semanticResource('OBJECTIVE', current, {
          responsibleRoleAssignmentIds: currentLinks.responsibleRoleAssignmentIds,
        }),
        mutation: {},
      });
      const at = new Date(request.effectiveAt);
      const expectedStatuses =
        request.action === 'ACTIVATE'
          ? ['DRAFT']
          : request.action === 'MARK_AT_RISK'
            ? ['ACTIVE']
            : request.action === 'RESTORE'
              ? ['AT_RISK']
              : request.action === 'ACHIEVE'
                ? ['ACTIVE', 'AT_RISK']
                : ['DRAFT', 'ACTIVE', 'AT_RISK'];
      if (!expectedStatuses.includes(current.status)) {
        throw illegalTransition('Objective');
      }
      const data: Prisma.ObjectiveUpdateInput =
        request.action === 'ACTIVATE'
          ? { status: 'ACTIVE', activatedAt: at }
          : request.action === 'MARK_AT_RISK'
            ? { status: 'AT_RISK' }
            : request.action === 'RESTORE'
              ? { status: 'ACTIVE' }
              : request.action === 'ACHIEVE'
                ? { status: 'ACHIEVED', achievedAt: at }
                : { status: 'CANCELLED', cancelledAt: at };
      const result = await transaction.objective.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: current.status,
        },
        data: { ...data, revision: { increment: 1 } },
      });
      if (result.count !== 1) throw stale('Objective');
      const updated = await transaction.objective.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        `business_semantics.objective.${request.action.toLowerCase()}`,
        'objective',
        id,
        { reason: request.reason, version: updated.version, revision: updated.revision },
      );
      return hydrateObjective(transaction, updated);
    });
  }

  async updateObjective(id: string, request: UpdateObjectiveRequest): Promise<Objective> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockSemanticGraph(transaction, principal.tenantId, 'objective-parent');
      await lockEntity(transaction, 'objectives', principal.tenantId, id);
      const current = await transaction.objective.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Objective');
      if (current.revision !== request.expectedRevision) throw stale('Objective');
      const currentLinks = await objectiveLinkIds(transaction, principal.tenantId, current);
      await this.policy.requireWrite(transaction, principal, 'business.objective.update', {
        resource: semanticResource('OBJECTIVE', current, {
          responsibleRoleAssignmentIds: currentLinks.responsibleRoleAssignmentIds,
        }),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.responsibleRoleAssignmentIds === undefined
            ? {}
            : {
                proposedResponsibleRoleAssignmentIds: request.responsibleRoleAssignmentIds,
              }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      if (current.status !== 'DRAFT') {
        throw new ConflictException(
          'Active Objectives are immutable; create a new Objective version.',
        );
      }
      const strategy =
        request.strategyId === undefined
          ? await transaction.strategy.findFirstOrThrow({
              where: {
                tenantId: principal.tenantId,
                id: current.strategyId,
                version: current.strategyVersion,
              },
            })
          : await transaction.strategy.findFirst({
              where: { tenantId: principal.tenantId, id: request.strategyId },
            });
      if (strategy === null) throw notFound('Strategy');
      const parentId =
        request.parentObjectiveId === undefined
          ? current.parentObjectiveId
          : request.parentObjectiveId;
      const parent =
        parentId === null
          ? null
          : await transaction.objective.findFirst({
              where: {
                tenantId: principal.tenantId,
                id: parentId,
                strategyId: strategy.id,
                strategyVersion: strategy.version,
              },
            });
      if (parentId !== null && parent === null) {
        throw new ConflictException('Parent Objective must belong to the selected Strategy.');
      }
      const result = await transaction.objective.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: 'DRAFT',
        },
        data: {
          ...(request.code === undefined ? {} : { code: request.code }),
          strategyId: strategy.id,
          strategyVersion: strategy.version,
          parentObjectiveId: parent?.id ?? null,
          parentObjectiveVersion: parent?.version ?? null,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.bscPerspective === undefined
            ? {}
            : { bscPerspective: request.bscPerspective }),
          ...(request.indicatorType === undefined ? {} : { indicatorType: request.indicatorType }),
          ...(request.weight === undefined ? {} : { weight: request.weight }),
          ...(request.owner === undefined ? {} : ownerColumns(request.owner)),
          ...(request.permissionLabels === undefined
            ? {}
            : { permissionLabels: toJson(request.permissionLabels) }),
          ...(request.effectiveFrom === undefined
            ? {}
            : { effectiveFrom: new Date(request.effectiveFrom) }),
          ...(request.effectiveTo === undefined
            ? {}
            : { effectiveTo: dateOrNull(request.effectiveTo) }),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw stale('Objective');
      const updated = await transaction.objective.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      if (
        request.valueVersionIds !== undefined ||
        request.metricDefinitionIds !== undefined ||
        request.responsibleRoleAssignmentIds !== undefined ||
        strategy.id !== current.strategyId
      ) {
        await replaceObjectiveLinks(transaction, principal.tenantId, updated, {
          valueVersionIds: request.valueVersionIds ?? currentLinks.valueVersionIds,
          metricDefinitionIds: request.metricDefinitionIds ?? currentLinks.metricDefinitionIds,
          responsibleRoleAssignmentIds:
            request.responsibleRoleAssignmentIds ?? currentLinks.responsibleRoleAssignmentIds,
        });
      }
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.objective.updated',
        'objective',
        id,
        { version: updated.version, revision: updated.revision },
      );
      return hydrateObjective(transaction, updated);
    });
  }
}

async function hydrateObjective(
  transaction: Prisma.TransactionClient,
  record: DbObjective,
): Promise<Objective> {
  const links = await objectiveLinkIds(transaction, record.tenantId, record);
  return mapObjective(
    record,
    links.valueVersionIds,
    links.metricDefinitionIds,
    links.responsibleRoleAssignmentIds,
  );
}

async function objectiveLinkIds(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  objective: Pick<DbObjective, 'id' | 'version'>,
) {
  const [values, metrics, assignments] = await Promise.all([
    transaction.objectiveValueVersion.findMany({
      where: {
        tenantId,
        objectiveId: objective.id,
        objectiveVersion: objective.version,
      },
      orderBy: { valueVersionId: 'asc' },
    }),
    transaction.objectiveMetricDefinition.findMany({
      where: {
        tenantId,
        objectiveId: objective.id,
        objectiveVersion: objective.version,
      },
      orderBy: { metricDefinitionId: 'asc' },
    }),
    transaction.objectiveRoleAssignment.findMany({
      where: {
        tenantId,
        objectiveId: objective.id,
        objectiveVersion: objective.version,
      },
      orderBy: { roleAssignmentId: 'asc' },
    }),
  ]);
  return {
    valueVersionIds: values.map((link) => link.valueVersionId),
    metricDefinitionIds: metrics.map((link) => link.metricDefinitionId),
    responsibleRoleAssignmentIds: assignments.map((link) => link.roleAssignmentId),
  };
}

async function replaceObjectiveLinks(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  objective: DbObjective,
  request: {
    readonly valueVersionIds: readonly string[];
    readonly metricDefinitionIds: readonly string[];
    readonly responsibleRoleAssignmentIds: readonly string[];
  },
): Promise<void> {
  const [strategyValues, metrics, assignments] = await Promise.all([
    transaction.strategyValueVersion.findMany({
      where: {
        tenantId,
        strategyId: objective.strategyId,
        strategyVersion: objective.strategyVersion,
        valueVersionId: { in: [...request.valueVersionIds] },
      },
    }),
    transaction.metricDefinition.findMany({
      where: { tenantId, id: { in: [...request.metricDefinitionIds] } },
    }),
    transaction.roleAssignment.findMany({
      where: { tenantId, id: { in: [...request.responsibleRoleAssignmentIds] } },
    }),
  ]);
  if (strategyValues.length !== request.valueVersionIds.length) {
    throw new ConflictException(
      'Every Objective Value Version must already be linked by its Strategy.',
    );
  }
  if (metrics.length !== request.metricDefinitionIds.length) {
    throw new ConflictException('Objective references a missing Metric Definition.');
  }
  if (assignments.length !== request.responsibleRoleAssignmentIds.length) {
    throw new ConflictException('Objective references a missing Role Assignment.');
  }
  await Promise.all([
    transaction.objectiveValueVersion.deleteMany({
      where: {
        tenantId,
        objectiveId: objective.id,
        objectiveVersion: objective.version,
      },
    }),
    transaction.objectiveMetricDefinition.deleteMany({
      where: {
        tenantId,
        objectiveId: objective.id,
        objectiveVersion: objective.version,
      },
    }),
    transaction.objectiveRoleAssignment.deleteMany({
      where: {
        tenantId,
        objectiveId: objective.id,
        objectiveVersion: objective.version,
      },
    }),
  ]);
  await transaction.objectiveValueVersion.createMany({
    data: strategyValues.map((link) => ({
      tenantId,
      objectiveId: objective.id,
      objectiveVersion: objective.version,
      strategyId: objective.strategyId,
      strategyVersion: objective.strategyVersion,
      valueDefinitionId: link.valueDefinitionId,
      valueVersionId: link.valueVersionId,
      valueVersionNumber: link.valueVersionNumber,
    })),
  });
  await transaction.objectiveMetricDefinition.createMany({
    data: metrics.map((metric) => ({
      tenantId,
      objectiveId: objective.id,
      objectiveVersion: objective.version,
      metricDefinitionId: metric.id,
      metricDefinitionVersion: metric.version,
    })),
  });
  await transaction.objectiveRoleAssignment.createMany({
    data: assignments.map((assignment) => ({
      tenantId,
      objectiveId: objective.id,
      objectiveVersion: objective.version,
      roleAssignmentId: assignment.id,
    })),
  });
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
