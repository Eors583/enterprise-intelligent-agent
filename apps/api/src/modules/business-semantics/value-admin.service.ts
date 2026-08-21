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
export class ValueAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listValues(): Promise<{ items: ValueDefinition[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.valueDefinition.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          take: 500,
        })
      ).map(mapValueDefinition),
    }));
  }

  async createValue(
    request: CreateValueDefinitionRequest,
    suppliedKey?: string,
  ): Promise<ValueDefinition> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'value-definition', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.value.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.valueDefinition.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return mapValueDefinition(replay);
        }
        const created = await transaction.valueDefinition.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            type: request.type,
            name: request.name,
            description: request.description,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: dateOrNull(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.value_definition.created',
          'value_definition',
          created.id,
          { code: created.code, version: created.version, revision: created.revision },
        );
        return mapValueDefinition(created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Value Definition');
    }
  }

  async updateValue(id: string, request: UpdateValueDefinitionRequest): Promise<ValueDefinition> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.valueDefinition.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Value Definition');
      await this.policy.requireWrite(transaction, principal, 'business.value.update', {
        resource: semanticResource('VALUE', current),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      const updated = await transaction.valueDefinition.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
        },
        data: {
          ...(request.code === undefined ? {} : { code: request.code }),
          ...(request.type === undefined ? {} : { type: request.type }),
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
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
      if (updated.count !== 1) throw stale('Value Definition');
      const record = await transaction.valueDefinition.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.value_definition.updated',
        'value_definition',
        id,
        { revision: record.revision },
      );
      return mapValueDefinition(record);
    });
  }

  async createValueVersion(
    definitionId: string,
    request: CreateValueVersionRequest,
    suppliedKey?: string,
  ): Promise<ValueVersion> {
    if (request.valueDefinitionId !== definitionId) {
      throw new ConflictException('Path and request Value Definition identities differ.');
    }
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity({ definitionId, request }, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'value-version', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.value.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.valueVersion.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          if (replay.valueDefinitionId !== definitionId) {
            throw new ConflictException(
              'The idempotency key belongs to a different Value Definition.',
            );
          }
          return hydrateValueVersion(transaction, replay);
        }
        await lockEntity(transaction, 'value_definitions', principal.tenantId, definitionId);
        const definition = await transaction.valueDefinition.findFirst({
          where: { tenantId: principal.tenantId, id: definitionId },
        });
        if (definition === null) throw notFound('Value Definition');
        if (definition.revision !== request.expectedDefinitionRevision) {
          throw stale('Value Definition');
        }
        const previous = await transaction.valueVersion.findFirst({
          where: { tenantId: principal.tenantId, valueDefinitionId: definitionId },
          orderBy: [{ version: 'desc' }],
        });
        const version = (previous?.version ?? 0) + 1;
        const versionId = randomUUID();
        const created = await transaction.valueVersion.create({
          data: {
            id: versionId,
            tenantId: principal.tenantId,
            valueDefinitionId: definitionId,
            version,
            previousVersionId: previous?.id ?? null,
            previousVersionNumber: previous?.version ?? null,
            statement: request.statement,
            positiveBehaviors: toJson(request.positiveBehaviors),
            negativeBehaviors: toJson(request.negativeBehaviors),
            changeSummary: request.changeSummary,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: dateOrNull(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await createValueChildren(transaction, principal.tenantId, created, request);
        const bumped = await transaction.valueDefinition.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: definitionId,
            revision: request.expectedDefinitionRevision,
          },
          data: { revision: { increment: 1 } },
        });
        if (bumped.count !== 1) throw stale('Value Definition');
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.value_version.created',
          'value_version',
          versionId,
          { definitionId, version, revision: 1 },
        );
        return hydrateValueVersion(transaction, created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Value Version');
    }
  }

  async updateValueVersion(
    definitionId: string,
    versionId: string,
    request: UpdateValueVersionRequest,
  ): Promise<ValueVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'value_versions', principal.tenantId, versionId);
      const current = await transaction.valueVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          id: versionId,
          valueDefinitionId: definitionId,
        },
      });
      if (current === null) throw notFound('Value Version');
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Published Value Versions are immutable.');
      }
      if (current.revision !== request.expectedRevision) throw stale('Value Version');
      await this.policy.requireWrite(transaction, principal, 'business.value.update', {
        resource: semanticResource('VALUE', current),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      const updated = await transaction.valueVersion.update({
        where: { id: versionId },
        data: {
          ...(request.statement === undefined ? {} : { statement: request.statement }),
          ...(request.positiveBehaviors === undefined
            ? {}
            : { positiveBehaviors: toJson(request.positiveBehaviors) }),
          ...(request.negativeBehaviors === undefined
            ? {}
            : { negativeBehaviors: toJson(request.negativeBehaviors) }),
          ...(request.changeSummary === undefined ? {} : { changeSummary: request.changeSummary }),
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
      if (request.metrics !== undefined || request.constraints !== undefined) {
        const existingMetrics = await transaction.valueMetric.findMany({
          where: { tenantId: principal.tenantId, valueVersionId: versionId },
        });
        const existingConstraints = await transaction.valueConstraint.findMany({
          where: { tenantId: principal.tenantId, valueVersionId: versionId },
        });
        await transaction.valueMetric.deleteMany({
          where: { tenantId: principal.tenantId, valueVersionId: versionId },
        });
        await transaction.valueConstraint.deleteMany({
          where: { tenantId: principal.tenantId, valueVersionId: versionId },
        });
        await createValueChildren(transaction, principal.tenantId, updated, {
          metrics:
            request.metrics ??
            existingMetrics.map((metric) => ({
              code: metric.code,
              metricDefinitionId: metric.metricDefinitionId,
              name: metric.name,
              weight: Number(metric.weight),
              target: metric.target as never,
              permissionLabels: stringArray(metric.permissionLabels),
            })),
          constraints:
            request.constraints ??
            existingConstraints.map((constraint) => ({
              code: constraint.code,
              type: constraint.type,
              severity: constraint.severity,
              statement: constraint.statement,
              requiredEvidenceTypes: stringArray(constraint.requiredEvidenceTypes),
              permissionLabels: stringArray(constraint.permissionLabels),
            })),
          owner: request.owner ?? mapOwner(current),
        });
      }
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.value_version.updated',
        'value_version',
        versionId,
        { definitionId, version: updated.version, revision: updated.revision },
      );
      return hydrateValueVersion(transaction, updated);
    });
  }

  async transitionValueVersion(
    definitionId: string,
    versionId: string,
    request: TransitionValueVersionRequest,
  ): Promise<ValueVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'value_versions', principal.tenantId, versionId);
      const current = await transaction.valueVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          id: versionId,
          valueDefinitionId: definitionId,
        },
      });
      if (current === null) throw notFound('Value Version');
      if (current.revision !== request.expectedRevision) throw stale('Value Version');
      await this.policy.requireWrite(transaction, principal, 'business.value.transition', {
        resource: semanticResource('VALUE', current),
        mutation: {},
      });
      const effectiveAt = new Date(request.effectiveAt);
      if (request.action === 'PUBLISH') {
        if (current.status !== 'DRAFT') throw illegalTransition('Value Version');
        await transaction.valueVersion.updateMany({
          where: {
            tenantId: principal.tenantId,
            valueDefinitionId: definitionId,
            status: 'PUBLISHED',
            id: { not: versionId },
          },
          data: {
            status: 'RETIRED',
            retiredAt: effectiveAt,
            revision: { increment: 1 },
          },
        });
        await transaction.valueVersion.update({
          where: { id: versionId },
          data: {
            status: 'PUBLISHED',
            publishedAt: effectiveAt,
            revision: { increment: 1 },
          },
        });
        await transaction.valueDefinition.update({
          where: { id: definitionId },
          data: {
            currentVersionId: versionId,
            currentVersionNumber: current.version,
            revision: { increment: 1 },
          },
        });
      } else {
        if (current.status !== 'PUBLISHED') throw illegalTransition('Value Version');
        await transaction.valueVersion.update({
          where: { id: versionId },
          data: {
            status: 'RETIRED',
            retiredAt: effectiveAt,
            revision: { increment: 1 },
          },
        });
        await transaction.valueDefinition.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: definitionId,
            currentVersionId: versionId,
          },
          data: {
            currentVersionId: null,
            currentVersionNumber: null,
            revision: { increment: 1 },
          },
        });
      }
      const updated = await transaction.valueVersion.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id: versionId },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        `business_semantics.value_version.${request.action.toLowerCase()}`,
        'value_version',
        versionId,
        { reason: request.reason, version: updated.version, revision: updated.revision },
      );
      return hydrateValueVersion(transaction, updated);
    });
  }
}

async function hydrateValueVersion(
  transaction: Prisma.TransactionClient,
  record: DbValueVersion,
): Promise<ValueVersion> {
  const [metrics, constraints] = await Promise.all([
    transaction.valueMetric.findMany({
      where: { tenantId: record.tenantId, valueVersionId: record.id },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    }),
    transaction.valueConstraint.findMany({
      where: { tenantId: record.tenantId, valueVersionId: record.id },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    }),
  ]);
  return mapValueVersion(record, metrics, constraints);
}

async function createValueChildren(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  version: DbValueVersion,
  request: {
    readonly owner: Parameters<typeof ownerColumns>[0];
    readonly metrics: readonly {
      readonly code: string;
      readonly metricDefinitionId: string;
      readonly name: string;
      readonly weight: number;
      readonly target: unknown;
      readonly permissionLabels: readonly string[];
    }[];
    readonly constraints: readonly {
      readonly code: string;
      readonly type: Prisma.ValueConstraintCreateInput['type'];
      readonly severity: Prisma.ValueConstraintCreateInput['severity'];
      readonly statement: string;
      readonly requiredEvidenceTypes: readonly string[];
      readonly permissionLabels: readonly string[];
    }[];
  },
): Promise<void> {
  const definitionIds = [...new Set(request.metrics.map((metric) => metric.metricDefinitionId))];
  const metricDefinitions = await transaction.metricDefinition.findMany({
    where: { tenantId, id: { in: definitionIds } },
  });
  if (metricDefinitions.length !== definitionIds.length) {
    throw new ConflictException('A Value Metric references a missing Metric Definition.');
  }
  const metricById = new Map(metricDefinitions.map((definition) => [definition.id, definition]));
  for (const metric of request.metrics) {
    const definition = metricById.get(metric.metricDefinitionId);
    if (definition === undefined) throw notFound('Metric Definition');
    const identity = idempotencyIdentity(metric, `${version.id}:metric:${metric.code}`);
    await transaction.valueMetric.create({
      data: {
        id: randomUUID(),
        tenantId,
        code: metric.code,
        valueDefinitionId: version.valueDefinitionId,
        valueVersionId: version.id,
        valueVersionNumber: version.version,
        metricDefinitionId: definition.id,
        metricDefinitionVersion: definition.version,
        name: metric.name,
        weight: metric.weight,
        target: toJson(metric.target),
        ...ownerColumns(request.owner),
        permissionLabels: toJson(metric.permissionLabels),
        idempotencyKey: identity.key,
        requestHash: identity.requestHash,
      },
    });
  }
  for (const constraint of request.constraints) {
    const identity = idempotencyIdentity(constraint, `${version.id}:constraint:${constraint.code}`);
    await transaction.valueConstraint.create({
      data: {
        id: randomUUID(),
        tenantId,
        code: constraint.code,
        valueDefinitionId: version.valueDefinitionId,
        valueVersionId: version.id,
        valueVersionNumber: version.version,
        type: constraint.type,
        severity: constraint.severity,
        statement: constraint.statement,
        requiredEvidenceTypes: toJson(constraint.requiredEvidenceTypes),
        ...ownerColumns(request.owner),
        permissionLabels: toJson(constraint.permissionLabels),
        idempotencyKey: identity.key,
        requestHash: identity.requestHash,
      },
    });
  }
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
