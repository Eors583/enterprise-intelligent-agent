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
export class StrategyAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listStrategies(): Promise<{ items: Strategy[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const records = await transaction.strategy.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
        take: 500,
      });
      const links = await transaction.strategyValueVersion.findMany({
        where: { tenantId: principal.tenantId },
      });
      return {
        items: records.map((record) =>
          mapStrategy(
            record,
            links
              .filter(
                (link) => link.strategyId === record.id && link.strategyVersion === record.version,
              )
              .map((link) => link.valueVersionId),
          ),
        ),
      };
    });
  }

  async createStrategy(request: CreateStrategyRequest, suppliedKey?: string): Promise<Strategy> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'strategy', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.strategy.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.strategy.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return hydrateStrategy(transaction, replay);
        }
        const created = await transaction.strategy.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            name: request.name,
            description: request.description,
            budgetAmount: request.budget?.amount ?? null,
            budgetCurrency: request.budget?.currency ?? null,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: dateOrNull(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await replaceStrategyValues(
          transaction,
          principal.tenantId,
          created,
          request.valueVersionIds,
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.strategy.created',
          'strategy',
          created.id,
          { code: created.code, version: created.version },
        );
        return hydrateStrategy(transaction, created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Strategy');
    }
  }

  async updateStrategy(id: string, request: UpdateStrategyRequest): Promise<Strategy> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'strategies', principal.tenantId, id);
      const current = await transaction.strategy.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Strategy');
      if (current.revision !== request.expectedRevision) throw stale('Strategy');
      await this.policy.requireWrite(transaction, principal, 'business.strategy.update', {
        resource: semanticResource('STRATEGY', current),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      if (current.status !== 'DRAFT') {
        const claimed = await transaction.strategy.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: current.status,
          },
          data: { revision: { increment: 1 } },
        });
        if (claimed.count !== 1) throw stale('Strategy');
        const identity = idempotencyIdentity({ id, ...request });
        const created = await transaction.strategy.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code ?? current.code,
            version: current.version + 1,
            previousVersionId: current.id,
            previousVersionNumber: current.version,
            name: request.name ?? current.name,
            description: request.description ?? current.description,
            budgetAmount:
              request.budget === undefined
                ? current.budgetAmount
                : (request.budget?.amount ?? null),
            budgetCurrency:
              request.budget === undefined
                ? current.budgetCurrency
                : (request.budget?.currency ?? null),
            ...ownerColumns(request.owner ?? mapOwner(current)),
            permissionLabels:
              request.permissionLabels === undefined
                ? toJson(current.permissionLabels)
                : toJson(request.permissionLabels),
            effectiveFrom:
              request.effectiveFrom === undefined
                ? current.effectiveFrom
                : new Date(request.effectiveFrom),
            effectiveTo:
              request.effectiveTo === undefined
                ? current.effectiveTo
                : dateOrNull(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        const existingLinks = await transaction.strategyValueVersion.findMany({
          where: {
            tenantId: principal.tenantId,
            strategyId: current.id,
            strategyVersion: current.version,
          },
        });
        await replaceStrategyValues(
          transaction,
          principal.tenantId,
          created,
          request.valueVersionIds ?? existingLinks.map((link) => link.valueVersionId),
        );
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.strategy.version_created',
          'strategy',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        return hydrateStrategy(transaction, created);
      }
      const result = await transaction.strategy.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: 'DRAFT',
        },
        data: {
          ...(request.code === undefined ? {} : { code: request.code }),
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.budget === undefined
            ? {}
            : {
                budgetAmount: request.budget?.amount ?? null,
                budgetCurrency: request.budget?.currency ?? null,
              }),
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
      if (result.count !== 1) throw stale('Strategy');
      const updated = await transaction.strategy.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      if (request.valueVersionIds !== undefined) {
        await replaceStrategyValues(
          transaction,
          principal.tenantId,
          updated,
          request.valueVersionIds,
        );
      }
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.strategy.updated',
        'strategy',
        id,
        { version: updated.version, revision: updated.revision },
      );
      return hydrateStrategy(transaction, updated);
    });
  }

  async transitionStrategy(id: string, request: TransitionStrategyRequest): Promise<Strategy> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'strategies', principal.tenantId, id);
      const current = await transaction.strategy.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Strategy');
      if (current.revision !== request.expectedRevision) throw stale('Strategy');
      await this.policy.requireWrite(transaction, principal, 'business.strategy.transition', {
        resource: semanticResource('STRATEGY', current),
        mutation: {},
      });
      const at = new Date(request.effectiveAt);
      const transition =
        request.action === 'ACTIVATE'
          ? {
              expected: ['DRAFT'],
              data: { status: 'ACTIVE' as const, activatedAt: at },
            }
          : request.action === 'CLOSE'
            ? {
                expected: ['ACTIVE'],
                data: { status: 'CLOSED' as const, closedAt: at },
              }
            : {
                expected: ['DRAFT', 'ACTIVE'],
                data: { status: 'CANCELLED' as const, cancelledAt: at },
              };
      if (!transition.expected.includes(current.status)) throw illegalTransition('Strategy');
      const updated = await transaction.strategy.update({
        where: { id },
        data: { ...transition.data, revision: { increment: 1 } },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        `business_semantics.strategy.${request.action.toLowerCase()}`,
        'strategy',
        id,
        { reason: request.reason, version: updated.version, revision: updated.revision },
      );
      return hydrateStrategy(transaction, updated);
    });
  }
}

async function hydrateStrategy(
  transaction: Prisma.TransactionClient,
  record: DbStrategy,
): Promise<Strategy> {
  const links = await transaction.strategyValueVersion.findMany({
    where: {
      tenantId: record.tenantId,
      strategyId: record.id,
      strategyVersion: record.version,
    },
    orderBy: [{ valueVersionId: 'asc' }],
  });
  return mapStrategy(
    record,
    links.map((link) => link.valueVersionId),
  );
}

async function replaceStrategyValues(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  strategy: DbStrategy,
  valueVersionIds: readonly string[],
): Promise<void> {
  const versions = await transaction.valueVersion.findMany({
    where: { tenantId, id: { in: [...valueVersionIds] } },
  });
  if (versions.length !== valueVersionIds.length) {
    throw new ConflictException('Strategy references a missing Value Version.');
  }
  await transaction.strategyValueVersion.deleteMany({
    where: {
      tenantId,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
    },
  });
  await transaction.strategyValueVersion.createMany({
    data: versions.map((version) => ({
      tenantId,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      valueDefinitionId: version.valueDefinitionId,
      valueVersionId: version.id,
      valueVersionNumber: version.version,
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
