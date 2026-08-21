import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateObjectiveRelationRequest,
  ObjectiveRelation,
  TransitionObjectiveRelationRequest,
  UpdateObjectiveRelationRequest,
} from '@enterprise/contracts';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { mapObjectiveRelation, ownerColumns } from './business-semantics.mapper.js';
import {
  BusinessSemanticsPolicyService,
  semanticResource,
} from './business-semantics-policy.service.js';
import {
  assertIdempotentReplay,
  idempotencyIdentity,
  lockIdempotency,
  lockSemanticGraph,
  recordBusinessMutation,
  toJson,
} from './business-semantics.mutation.js';
import {
  businessOwnerFromColumns,
  illegalSemanticTransition,
  lockBusinessSemanticEntity,
  mapSemanticWriteError,
  nextVersionIdentity,
  nullableDate,
  semanticNotFound,
  staleSemanticRevision,
} from './business-semantics.persistence.js';

@Injectable()
export class ObjectiveRelationAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async list(): Promise<{ items: ObjectiveRelation[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.objectiveRelation.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
          take: 5_000,
        })
      ).map(mapObjectiveRelation),
    }));
  }

  async create(
    request: CreateObjectiveRelationRequest,
    suppliedKey?: string,
  ): Promise<ObjectiveRelation> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'objective-relation', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.objective.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
          },
        });
        const replay = await transaction.objectiveRelation.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return mapObjectiveRelation(replay);
        }
        await lockSemanticGraph(transaction, principal.tenantId, 'objective-parent');
        const endpoints = await loadObjectiveEndpoints(
          transaction,
          principal.tenantId,
          request.sourceObjectiveId,
          request.targetObjectiveId,
        );
        const created = await transaction.objectiveRelation.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            sourceObjectiveId: endpoints.source.id,
            sourceObjectiveVersion: endpoints.source.version,
            targetObjectiveId: endpoints.target.id,
            targetObjectiveVersion: endpoints.target.version,
            type: request.type,
            weight: request.weight,
            lagDays: request.lagDays,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: nullableDate(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.objective_relation.created',
          'objective_relation',
          created.id,
          {
            sourceObjectiveId: created.sourceObjectiveId,
            targetObjectiveId: created.targetObjectiveId,
            type: created.type,
          },
        );
        return mapObjectiveRelation(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Objective Relation');
    }
  }

  async update(id: string, request: UpdateObjectiveRelationRequest): Promise<ObjectiveRelation> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockSemanticGraph(transaction, principal.tenantId, 'objective-parent');
        await lockBusinessSemanticEntity(
          transaction,
          'objective_relations',
          principal.tenantId,
          id,
        );
        const current = await transaction.objectiveRelation.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw semanticNotFound('Objective Relation');
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Objective Relation');
        }
        if (current.status !== 'ACTIVE') {
          throw illegalSemanticTransition('Objective Relation');
        }
        await this.policy.requireWrite(transaction, principal, 'business.objective.update', {
          resource: semanticResource('OBJECTIVE', current),
          mutation: {
            ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
            ...(request.permissionLabels === undefined
              ? {}
              : {
                  proposedPermissionLabels: request.permissionLabels,
                }),
          },
        });
        if (request.code !== undefined && request.code !== current.code) {
          throw new ConflictException('Objective Relation code is immutable across versions.');
        }
        const endpoints = await loadObjectiveEndpoints(
          transaction,
          principal.tenantId,
          request.sourceObjectiveId ?? current.sourceObjectiveId,
          request.targetObjectiveId ?? current.targetObjectiveId,
        );
        const retired = await transaction.objectiveRelation.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            status: 'ACTIVE',
            revision: request.expectedRevision,
          },
          data: {
            status: 'RETIRED',
            retiredAt: new Date(),
            revision: { increment: 1 },
          },
        });
        if (retired.count !== 1) throw staleSemanticRevision('Objective Relation');
        const identity = idempotencyIdentity({ id, request });
        const created = await transaction.objectiveRelation.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: current.code,
            ...nextVersionIdentity(current),
            sourceObjectiveId: endpoints.source.id,
            sourceObjectiveVersion: endpoints.source.version,
            targetObjectiveId: endpoints.target.id,
            targetObjectiveVersion: endpoints.target.version,
            type: request.type ?? current.type,
            weight: request.weight ?? current.weight,
            lagDays: request.lagDays ?? current.lagDays,
            ...ownerColumns(request.owner ?? businessOwnerFromColumns(current)),
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
                : nullableDate(request.effectiveTo),
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.objective_relation.version_created',
          'objective_relation',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        return mapObjectiveRelation(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Objective Relation');
    }
  }

  async transition(
    id: string,
    request: TransitionObjectiveRelationRequest,
  ): Promise<ObjectiveRelation> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBusinessSemanticEntity(transaction, 'objective_relations', principal.tenantId, id);
      const current = await transaction.objectiveRelation.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw semanticNotFound('Objective Relation');
      if (current.revision !== request.expectedRevision) {
        throw staleSemanticRevision('Objective Relation');
      }
      if (current.status !== 'ACTIVE') {
        throw illegalSemanticTransition('Objective Relation');
      }
      await this.policy.requireWrite(transaction, principal, 'business.objective.transition', {
        resource: semanticResource('OBJECTIVE', current),
        mutation: {},
      });
      const result = await transaction.objectiveRelation.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: 'ACTIVE',
        },
        data: {
          status: 'RETIRED',
          retiredAt: new Date(request.effectiveAt),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw staleSemanticRevision('Objective Relation');
      const updated = await transaction.objectiveRelation.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.objective_relation.retired',
        'objective_relation',
        id,
        {
          reason: request.reason,
          version: updated.version,
          revision: updated.revision,
        },
      );
      return mapObjectiveRelation(updated);
    });
  }
}

async function loadObjectiveEndpoints(
  transaction: Parameters<Parameters<AdminPrismaService['withTenant']>[1]>[0],
  tenantId: string,
  sourceId: string,
  targetId: string,
) {
  const [source, target] = await Promise.all([
    transaction.objective.findFirst({ where: { tenantId, id: sourceId } }),
    transaction.objective.findFirst({ where: { tenantId, id: targetId } }),
  ]);
  if (source === null || target === null) {
    throw semanticNotFound('Objective Relation endpoint');
  }
  if (
    source.strategyId !== target.strategyId ||
    source.strategyVersion !== target.strategyVersion
  ) {
    throw new ConflictException(
      'Objective Relation endpoints must belong to the same Strategy version.',
    );
  }
  return { source, target };
}
