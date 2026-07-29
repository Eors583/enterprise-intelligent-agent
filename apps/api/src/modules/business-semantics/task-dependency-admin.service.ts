import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateTaskDependencyRequest,
  TaskDependency,
  TransitionTaskDependencyRequest,
  UpdateTaskDependencyRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { mapTaskDependency, ownerColumns } from './business-semantics.mapper.js';
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
export class TaskDependencyAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async list(): Promise<{ items: TaskDependency[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.taskDependency.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
          take: 10_000,
        })
      ).map(mapTaskDependency),
    }));
  }

  async create(
    request: CreateTaskDependencyRequest,
    suppliedKey?: string,
  ): Promise<TaskDependency> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'task-dependency', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.task.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
            proposedTaskId: request.successorTaskId,
          },
        });
        const replay = await transaction.taskDependency.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return mapTaskDependency(replay);
        }
        await lockSemanticGraph(transaction, principal.tenantId, 'task-dependency');
        const endpoints = await loadTaskEndpoints(
          transaction,
          principal.tenantId,
          request.predecessorTaskId,
          request.successorTaskId,
          new Date(request.effectiveFrom),
          nullableDate(request.effectiveTo),
        );
        const created = await transaction.taskDependency.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            predecessorTaskId: endpoints.predecessor.id,
            predecessorTaskVersion: endpoints.predecessor.version,
            successorTaskId: endpoints.successor.id,
            successorTaskVersion: endpoints.successor.version,
            type: request.type,
            lagMinutes: request.lagMinutes,
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
          'business_semantics.task_dependency.created',
          'task_dependency',
          created.id,
          {
            predecessorTaskId: created.predecessorTaskId,
            successorTaskId: created.successorTaskId,
            type: created.type,
          },
        );
        return mapTaskDependency(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Task Dependency');
    }
  }

  async update(id: string, request: UpdateTaskDependencyRequest): Promise<TaskDependency> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockSemanticGraph(transaction, principal.tenantId, 'task-dependency');
        await lockBusinessSemanticEntity(transaction, 'task_dependencies', principal.tenantId, id);
        const current = await transaction.taskDependency.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw semanticNotFound('Task Dependency');
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Task Dependency');
        }
        if (current.status !== 'ACTIVE') throw illegalSemanticTransition('Task Dependency');
        await this.policy.requireWrite(transaction, principal, 'business.task.update', {
          resource: semanticResource('TASK', current, {
            taskId: current.successorTaskId,
          }),
          mutation: {
            ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
            ...(request.permissionLabels === undefined
              ? {}
              : {
                  proposedPermissionLabels: request.permissionLabels,
                }),
            ...(request.successorTaskId === undefined
              ? {}
              : { proposedTaskId: request.successorTaskId }),
          },
        });
        if (request.code !== undefined && request.code !== current.code) {
          throw new ConflictException('Task Dependency code is immutable across versions.');
        }
        const effectiveFrom =
          request.effectiveFrom === undefined
            ? current.effectiveFrom
            : new Date(request.effectiveFrom);
        const effectiveTo =
          request.effectiveTo === undefined
            ? current.effectiveTo
            : nullableDate(request.effectiveTo);
        const endpoints = await loadTaskEndpoints(
          transaction,
          principal.tenantId,
          request.predecessorTaskId ?? current.predecessorTaskId,
          request.successorTaskId ?? current.successorTaskId,
          effectiveFrom,
          effectiveTo,
        );
        const removed = await transaction.taskDependency.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            status: 'ACTIVE',
            revision: request.expectedRevision,
          },
          data: {
            status: 'REMOVED',
            removedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        if (removed.count !== 1) throw staleSemanticRevision('Task Dependency');
        const identity = idempotencyIdentity({ id, request });
        const created = await transaction.taskDependency.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: current.code,
            ...nextVersionIdentity(current),
            predecessorTaskId: endpoints.predecessor.id,
            predecessorTaskVersion: endpoints.predecessor.version,
            successorTaskId: endpoints.successor.id,
            successorTaskVersion: endpoints.successor.version,
            type: request.type ?? current.type,
            lagMinutes: request.lagMinutes ?? current.lagMinutes,
            ...ownerColumns(request.owner ?? businessOwnerFromColumns(current)),
            permissionLabels:
              request.permissionLabels === undefined
                ? toJson(current.permissionLabels)
                : toJson(request.permissionLabels),
            effectiveFrom,
            effectiveTo,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.task_dependency.version_created',
          'task_dependency',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        return mapTaskDependency(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Task Dependency');
    }
  }

  async transition(id: string, request: TransitionTaskDependencyRequest): Promise<TaskDependency> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockSemanticGraph(transaction, principal.tenantId, 'task-dependency');
      await lockBusinessSemanticEntity(transaction, 'task_dependencies', principal.tenantId, id);
      const current = await transaction.taskDependency.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw semanticNotFound('Task Dependency');
      if (current.revision !== request.expectedRevision) {
        throw staleSemanticRevision('Task Dependency');
      }
      if (current.status !== 'ACTIVE') throw illegalSemanticTransition('Task Dependency');
      await this.policy.requireWrite(transaction, principal, 'business.task.transition', {
        resource: semanticResource('TASK', current, {
          taskId: current.successorTaskId,
        }),
        mutation: {},
      });
      const result = await transaction.taskDependency.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: 'ACTIVE',
        },
        data: {
          status: 'REMOVED',
          removedAt: new Date(request.effectiveAt),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw staleSemanticRevision('Task Dependency');
      const updated = await transaction.taskDependency.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.task_dependency.removed',
        'task_dependency',
        id,
        {
          reason: request.reason,
          version: updated.version,
          revision: updated.revision,
        },
      );
      return mapTaskDependency(updated);
    });
  }
}

async function loadTaskEndpoints(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  predecessorId: string,
  successorId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
) {
  const [predecessor, successor] = await Promise.all([
    transaction.task.findFirst({ where: { tenantId, id: predecessorId } }),
    transaction.task.findFirst({ where: { tenantId, id: successorId } }),
  ]);
  if (predecessor === null || successor === null) {
    throw semanticNotFound('Task Dependency endpoint');
  }
  if (predecessor.id === successor.id) {
    throw new ConflictException('A Task cannot depend on itself.');
  }
  for (const endpoint of [predecessor, successor]) {
    if (
      effectiveFrom < endpoint.effectiveFrom ||
      (endpoint.effectiveTo !== null &&
        (effectiveTo === null || effectiveTo > endpoint.effectiveTo))
    ) {
      throw new ConflictException('Task Dependency effective period must fit both Task versions.');
    }
  }
  return { predecessor, successor };
}
