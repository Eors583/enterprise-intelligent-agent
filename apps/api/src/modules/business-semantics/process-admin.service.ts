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
export class ProcessAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listProcesses(): Promise<{ items: ProcessDefinition[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.processDefinition.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          take: 500,
        })
      ).map(mapProcessDefinition),
    }));
  }

  async createProcess(
    request: CreateProcessDefinitionRequest,
    suppliedKey?: string,
  ): Promise<ProcessDefinition> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'process-definition', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.process.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.processDefinition.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return mapProcessDefinition(replay);
        }
        const created = await transaction.processDefinition.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
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
          'business_semantics.process_definition.created',
          'process_definition',
          created.id,
          { code: created.code, revision: created.revision },
        );
        return mapProcessDefinition(created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Process Definition');
    }
  }

  async updateProcess(
    id: string,
    request: UpdateProcessDefinitionRequest,
  ): Promise<ProcessDefinition> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.processDefinition.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Process Definition');
      await this.policy.requireWrite(transaction, principal, 'business.process.update', {
        resource: semanticResource('PROCESS', current),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Active Process Definition core fields are immutable.');
      }
      const result = await transaction.processDefinition.updateMany({
        where: { tenantId: principal.tenantId, id, revision: request.expectedRevision },
        data: {
          ...(request.code === undefined ? {} : { code: request.code }),
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
      if (result.count !== 1) throw stale('Process Definition');
      const updated = await transaction.processDefinition.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.process_definition.updated',
        'process_definition',
        id,
        { revision: updated.revision },
      );
      return mapProcessDefinition(updated);
    });
  }

  async createProcessVersion(
    definitionId: string,
    request: CreateProcessVersionRequest,
    suppliedKey?: string,
  ): Promise<ProcessVersion> {
    if (request.processDefinitionId !== definitionId) {
      throw new ConflictException('Path and request Process Definition identities differ.');
    }
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity({ definitionId, request }, suppliedKey);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockIdempotency(transaction, principal.tenantId, 'process-version', identity.key);
      await this.policy.requireWrite(transaction, principal, 'business.process.create', {
        mutation: {
          proposedOwner: request.owner,
          proposedPermissionLabels: request.permissionLabels,
        },
      });
      const replay = await transaction.processVersion.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
      });
      if (replay !== null) {
        assertIdempotentReplay(replay, identity.requestHash);
        if (replay.processDefinitionId !== definitionId) {
          throw new ConflictException(
            'The idempotency key belongs to a different Process Definition.',
          );
        }
        return hydrateProcessVersion(transaction, replay);
      }
      await lockEntity(transaction, 'process_definitions', principal.tenantId, definitionId);
      const definition = await transaction.processDefinition.findFirst({
        where: { tenantId: principal.tenantId, id: definitionId },
      });
      if (definition === null) throw notFound('Process Definition');
      if (definition.revision !== request.expectedDefinitionRevision) {
        throw stale('Process Definition');
      }
      const previous = await transaction.processVersion.findFirst({
        where: { tenantId: principal.tenantId, processDefinitionId: definitionId },
        orderBy: { version: 'desc' },
      });
      const version = (previous?.version ?? 0) + 1;
      const created = await transaction.processVersion.create({
        data: {
          id: randomUUID(),
          tenantId: principal.tenantId,
          processDefinitionId: definitionId,
          version,
          previousVersionId: previous?.id ?? null,
          previousVersionNumber: previous?.version ?? null,
          changeSummary: request.changeSummary,
          ...ownerColumns(request.owner),
          permissionLabels: toJson(request.permissionLabels),
          effectiveFrom: new Date(request.effectiveFrom),
          effectiveTo: dateOrNull(request.effectiveTo),
          idempotencyKey: identity.key,
          requestHash: identity.requestHash,
        },
      });
      await createProcessNodes(transaction, principal.tenantId, created, request.nodes);
      const bumped = await transaction.processDefinition.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: definitionId,
          revision: request.expectedDefinitionRevision,
        },
        data: { revision: { increment: 1 } },
      });
      if (bumped.count !== 1) throw stale('Process Definition');
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.process_version.created',
        'process_version',
        created.id,
        { definitionId, version },
      );
      return hydrateProcessVersion(transaction, created);
    });
  }

  async updateProcessVersion(
    definitionId: string,
    versionId: string,
    request: UpdateProcessVersionRequest,
  ): Promise<ProcessVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'process_definitions', principal.tenantId, definitionId);
      await lockEntity(transaction, 'process_versions', principal.tenantId, versionId);
      const current = await transaction.processVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          id: versionId,
          processDefinitionId: definitionId,
        },
      });
      if (current === null) throw notFound('Process Version');
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Published Process Versions are immutable.');
      }
      await this.policy.requireWrite(transaction, principal, 'business.process.update', {
        resource: semanticResource('PROCESS', current),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      const result = await transaction.processVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: versionId,
          revision: request.expectedRevision,
          status: 'DRAFT',
        },
        data: {
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
      if (result.count !== 1) throw stale('Process Version');
      if (request.nodes !== undefined) {
        await transaction.processNode.deleteMany({
          where: { tenantId: principal.tenantId, processVersionId: versionId },
        });
        await createProcessNodes(transaction, principal.tenantId, current, request.nodes);
      }
      const updated = await transaction.processVersion.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id: versionId },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.process_version.updated',
        'process_version',
        versionId,
        { definitionId, version: updated.version, revision: updated.revision },
      );
      return hydrateProcessVersion(transaction, updated);
    });
  }

  async transitionProcessVersion(
    definitionId: string,
    versionId: string,
    request: TransitionProcessVersionRequest,
  ): Promise<ProcessVersion> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'process_definitions', principal.tenantId, definitionId);
      await lockEntity(transaction, 'process_versions', principal.tenantId, versionId);
      const current = await transaction.processVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          id: versionId,
          processDefinitionId: definitionId,
        },
      });
      if (current === null) throw notFound('Process Version');
      if (current.revision !== request.expectedRevision) throw stale('Process Version');
      await this.policy.requireWrite(transaction, principal, 'business.process.transition', {
        resource: semanticResource('PROCESS', current),
        mutation: {},
      });
      const at = new Date(request.effectiveAt);
      if (request.action === 'PUBLISH') {
        if (current.status !== 'DRAFT') throw illegalTransition('Process Version');
        await transaction.processVersion.updateMany({
          where: {
            tenantId: principal.tenantId,
            processDefinitionId: definitionId,
            status: 'PUBLISHED',
            id: { not: versionId },
          },
          data: { status: 'RETIRED', retiredAt: at, revision: { increment: 1 } },
        });
        const published = await transaction.processVersion.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: versionId,
            processDefinitionId: definitionId,
            status: 'DRAFT',
            revision: request.expectedRevision,
          },
          data: { status: 'PUBLISHED', publishedAt: at, revision: { increment: 1 } },
        });
        if (published.count !== 1) throw stale('Process Version');
        await transaction.processDefinition.update({
          where: { id: definitionId },
          data: {
            status: 'ACTIVE',
            currentVersionId: versionId,
            currentVersionNumber: current.version,
            revision: { increment: 1 },
          },
        });
      } else {
        if (current.status !== 'PUBLISHED') throw illegalTransition('Process Version');
        const retired = await transaction.processVersion.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: versionId,
            processDefinitionId: definitionId,
            status: 'PUBLISHED',
            revision: request.expectedRevision,
          },
          data: { status: 'RETIRED', retiredAt: at, revision: { increment: 1 } },
        });
        if (retired.count !== 1) throw stale('Process Version');
        await transaction.processDefinition.update({
          where: { id: definitionId },
          data: { status: 'RETIRED', revision: { increment: 1 } },
        });
      }
      const updated = await transaction.processVersion.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id: versionId },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        `business_semantics.process_version.${request.action.toLowerCase()}`,
        'process_version',
        versionId,
        { reason: request.reason, definitionId, version: updated.version },
      );
      return hydrateProcessVersion(transaction, updated);
    });
  }
}

async function hydrateProcessVersion(
  transaction: Prisma.TransactionClient,
  record: DbProcessVersion,
): Promise<ProcessVersion> {
  const nodes = await transaction.processNode.findMany({
    where: {
      tenantId: record.tenantId,
      processDefinitionId: record.processDefinitionId,
      processVersionId: record.id,
      processVersion: record.version,
    },
    orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
  });
  return mapProcessVersion(record, nodes);
}

async function createProcessNodes(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  version: Pick<DbProcessVersion, 'id' | 'processDefinitionId' | 'version'>,
  nodes: readonly {
    readonly code: string;
    readonly name: string;
    readonly type: Prisma.ProcessNodeCreateInput['type'];
    readonly ordinal: number;
    readonly configuration: Record<string, unknown>;
  }[],
): Promise<void> {
  await transaction.processNode.createMany({
    data: nodes.map((node) => ({
      id: randomUUID(),
      tenantId,
      processDefinitionId: version.processDefinitionId,
      processVersionId: version.id,
      processVersion: version.version,
      code: node.code,
      name: node.name,
      type: node.type,
      ordinal: node.ordinal,
      configuration: toJson(node.configuration),
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
