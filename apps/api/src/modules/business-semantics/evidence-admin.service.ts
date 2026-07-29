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
export class EvidenceAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listEvidence(): Promise<{ items: Evidence[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.evidence.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ observedAt: 'desc' }, { code: 'asc' }, { version: 'desc' }],
          take: 5_000,
        })
      ).map(mapEvidence),
    }));
  }

  async createEvidence(request: CreateEvidenceRequest, suppliedKey?: string): Promise<Evidence> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'evidence', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.evidence.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.evidence.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return mapEvidence(replay);
        }
        const created = await transaction.evidence.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            sourceType: request.sourceType,
            sourceSystem: request.sourceSystem,
            sourceRecordId: request.sourceRecordId,
            sourceVersion: request.sourceVersion,
            sourceUri: request.sourceUri,
            observedAt: new Date(request.observedAt),
            contentHashAlgorithm: 'SHA256',
            contentHash: request.contentHash,
            trustLevel: request.trustLevel,
            confidence: request.confidence,
            summary: request.summary,
            ...verifierColumns(request.verifiedBy),
            verifiedAt: dateOrNull(request.verifiedAt),
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
          'business_semantics.evidence.created',
          'evidence',
          created.id,
          { code: created.code, version: created.version, sourceType: created.sourceType },
        );
        return mapEvidence(created);
      });
    } catch (error) {
      throw mapWriteError(error, 'Evidence');
    }
  }

  async updateEvidence(id: string, request: UpdateEvidenceRequest): Promise<Evidence> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.evidence.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Evidence');
      await this.policy.requireWrite(transaction, principal, 'business.evidence.update', {
        resource: semanticResource('EVIDENCE', current),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
        },
      });
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Active Evidence is immutable; create a new Evidence version.');
      }
      const result = await transaction.evidence.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: 'DRAFT',
        },
        data: {
          ...(request.trustLevel === undefined ? {} : { trustLevel: request.trustLevel }),
          ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
          ...(request.summary === undefined ? {} : { summary: request.summary }),
          ...(request.verifiedBy === undefined ? {} : verifierColumns(request.verifiedBy)),
          ...(request.verifiedAt === undefined
            ? {}
            : { verifiedAt: dateOrNull(request.verifiedAt) }),
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
      if (result.count !== 1) throw stale('Evidence');
      const updated = await transaction.evidence.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.evidence.updated',
        'evidence',
        id,
        { version: updated.version, revision: updated.revision },
      );
      return mapEvidence(updated);
    });
  }

  async transitionEvidence(id: string, request: TransitionEvidenceRequest): Promise<Evidence> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockEntity(transaction, 'evidence', principal.tenantId, id);
      const current = await transaction.evidence.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw notFound('Evidence');
      if (current.revision !== request.expectedRevision) throw stale('Evidence');
      await this.policy.requireWrite(transaction, principal, 'business.evidence.transition', {
        resource: semanticResource('EVIDENCE', current),
        mutation: {},
      });
      if (request.action === 'VERIFY') {
        if (current.status !== 'DRAFT') throw illegalTransition('Evidence');
        const verifierCount = [
          current.verifiedByUserId,
          current.verifiedByRoleAssignmentId,
          current.verifiedByRoleTemplateId,
          current.verifiedByOrgUnitId,
        ].filter((value) => value !== null).length;
        if (verifierCount !== 1 || current.verifiedAt === null) {
          throw new ConflictException(
            'Evidence must have exactly one verifier and verifiedAt before verification.',
          );
        }
      } else if (current.status !== 'ACTIVE') {
        throw illegalTransition('Evidence');
      }
      const at = new Date(request.effectiveAt);
      const result = await transaction.evidence.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: request.action === 'VERIFY' ? 'DRAFT' : 'ACTIVE',
        },
        data:
          request.action === 'VERIFY'
            ? {
                status: 'ACTIVE',
                activatedAt: at,
                trustLevel: 'VERIFIED',
                revision: { increment: 1 },
              }
            : { status: 'REVOKED', revokedAt: at, revision: { increment: 1 } },
      });
      if (result.count !== 1) throw stale('Evidence');
      const updated = await transaction.evidence.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        `business_semantics.evidence.${request.action.toLowerCase()}`,
        'evidence',
        id,
        { reason: request.reason, version: updated.version, revision: updated.revision },
      );
      return mapEvidence(updated);
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
