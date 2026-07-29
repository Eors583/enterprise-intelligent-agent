import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  Acceptance,
  CreateAcceptanceRequest,
  CreateDeliverableRequest,
  Deliverable,
  TransitionAcceptanceRequest,
  TransitionDeliverableRequest,
  UpdateAcceptanceRequest,
  UpdateDeliverableRequest,
} from '@enterprise/contracts';
import {
  Prisma,
  type Acceptance as DbAcceptance,
  type Deliverable as DbDeliverable,
  type Evidence as DbEvidence,
} from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import {
  deciderColumns,
  mapAcceptance,
  mapDeliverable,
  ownerColumns,
} from './business-semantics.mapper.js';
import {
  assertIdempotentReplay,
  idempotencyIdentity,
  lockIdempotency,
  recordBusinessMutation,
  toJson,
} from './business-semantics.mutation.js';
import {
  BusinessSemanticsPolicyService,
  semanticResource,
} from './business-semantics-policy.service.js';
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
export class DeliverableAcceptanceAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async listDeliverables(taskId: string): Promise<{ items: Deliverable[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.deliverable.findMany({
          where: { tenantId: principal.tenantId, taskId },
          orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
          take: 10_000,
        })
      ).map(mapDeliverable),
    }));
  }

  async createDeliverable(
    taskId: string,
    request: CreateDeliverableRequest,
    suppliedKey?: string,
  ): Promise<Deliverable> {
    if (request.taskId !== taskId) {
      throw new ConflictException('Path and request Task identities differ.');
    }
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity({ taskId, request }, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'deliverable', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.deliverable.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
            proposedTaskId: taskId,
          },
        });
        const replay = await transaction.deliverable.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          if (replay.taskId !== taskId) {
            throw new ConflictException('The idempotency key belongs to a different Task.');
          }
          return mapDeliverable(replay);
        }
        const task = await transaction.task.findFirst({
          where: { tenantId: principal.tenantId, id: taskId },
        });
        if (task === null) throw semanticNotFound('Task');
        if (task.status === 'CANCELLED') {
          throw new ConflictException('A cancelled Task cannot receive Deliverables.');
        }
        const effectiveFrom = new Date(request.effectiveFrom);
        const effectiveTo = nullableDate(request.effectiveTo);
        if (
          effectiveFrom < task.effectiveFrom ||
          (task.effectiveTo !== null && (effectiveTo === null || effectiveTo > task.effectiveTo)) ||
          new Date(request.dueAt) > task.dueAt
        ) {
          throw new ConflictException('Deliverable period and due date must fit the Task version.');
        }
        const created = await transaction.deliverable.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            taskId: task.id,
            taskVersion: task.version,
            title: request.title,
            description: request.description,
            dueAt: new Date(request.dueAt),
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom,
            effectiveTo,
            evidenceSealedAt: null,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.deliverable.created',
          'deliverable',
          created.id,
          { taskId: task.id, taskVersion: task.version, version: created.version },
        );
        return mapDeliverable(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Deliverable');
    }
  }

  async updateDeliverable(
    taskId: string,
    id: string,
    request: UpdateDeliverableRequest,
  ): Promise<Deliverable> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBusinessSemanticEntity(transaction, 'deliverables', principal.tenantId, id);
      const current = await transaction.deliverable.findFirst({
        where: { tenantId: principal.tenantId, id, taskId },
      });
      if (current === null) throw semanticNotFound('Deliverable');
      if (current.revision !== request.expectedRevision) {
        throw staleSemanticRevision('Deliverable');
      }
      if (current.status !== 'DRAFT') {
        throw new ConflictException('Only Draft Deliverables can be edited.');
      }
      await this.policy.requireWrite(transaction, principal, 'business.deliverable.update', {
        resource: semanticResource('DELIVERABLE', current, {
          taskId: current.taskId,
        }),
        mutation: {
          ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
          ...(request.permissionLabels === undefined
            ? {}
            : { proposedPermissionLabels: request.permissionLabels }),
          proposedTaskId: current.taskId,
        },
      });
      const result = await transaction.deliverable.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          taskId,
          status: 'DRAFT',
          revision: request.expectedRevision,
        },
        data: {
          ...(request.code === undefined ? {} : { code: request.code }),
          ...(request.title === undefined ? {} : { title: request.title }),
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
            : { effectiveTo: nullableDate(request.effectiveTo) }),
          ...(request.dueAt === undefined ? {} : { dueAt: new Date(request.dueAt) }),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw staleSemanticRevision('Deliverable');
      const updated = await transaction.deliverable.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.deliverable.updated',
        'deliverable',
        id,
        { taskId, version: updated.version, revision: updated.revision },
      );
      return mapDeliverable(updated);
    });
  }

  async transitionDeliverable(
    taskId: string,
    id: string,
    request: TransitionDeliverableRequest,
  ): Promise<Deliverable> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockBusinessSemanticEntity(transaction, 'deliverables', principal.tenantId, id);
        const current = await transaction.deliverable.findFirst({
          where: { tenantId: principal.tenantId, id, taskId },
        });
        if (current === null) throw semanticNotFound('Deliverable');
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Deliverable');
        }
        await this.policy.requireWrite(transaction, principal, 'business.deliverable.transition', {
          resource: semanticResource('DELIVERABLE', current, {
            taskId: current.taskId,
          }),
          mutation: { proposedTaskId: current.taskId },
        });
        if (request.action === 'SUBMIT') {
          await submitDeliverableWithinTransaction(
            transaction,
            principal.tenantId,
            taskId,
            current,
            request,
          );
        } else {
          if (current.status !== 'DRAFT' && current.status !== 'SUBMITTED') {
            throw illegalSemanticTransition('Deliverable');
          }
          const result = await transaction.deliverable.updateMany({
            where: {
              tenantId: principal.tenantId,
              id,
              taskId,
              status: current.status,
              revision: request.expectedRevision,
            },
            data: { status: 'WITHDRAWN', revision: { increment: 1 } },
          });
          if (result.count !== 1) throw staleSemanticRevision('Deliverable');
        }
        const updated = await transaction.deliverable.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          `business_semantics.deliverable.${request.action.toLowerCase()}`,
          'deliverable',
          id,
          {
            taskId,
            version: updated.version,
            revision: updated.revision,
            ...(request.action === 'WITHDRAW' ? { reason: request.reason } : {}),
          },
        );
        return mapDeliverable(updated);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Deliverable');
    }
  }

  async listAcceptances(taskId: string, deliverableId: string): Promise<{ items: Acceptance[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const deliverable = await transaction.deliverable.findFirst({
        where: { tenantId: principal.tenantId, id: deliverableId, taskId },
      });
      if (deliverable === null) throw semanticNotFound('Deliverable');
      const records = await transaction.acceptance.findMany({
        where: { tenantId: principal.tenantId, deliverableId },
        orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
        take: 10_000,
      });
      return {
        items: await Promise.all(records.map((record) => hydrateAcceptance(transaction, record))),
      };
    });
  }

  async createAcceptance(
    taskId: string,
    deliverableId: string,
    request: CreateAcceptanceRequest,
    suppliedKey?: string,
  ): Promise<Acceptance> {
    if (request.deliverableId !== deliverableId) {
      throw new ConflictException('Path and request Deliverable identities differ.');
    }
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity({ taskId, deliverableId, request }, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'acceptance', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.acceptance.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
            proposedTaskId: taskId,
          },
        });
        const replay = await transaction.acceptance.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          if (replay.deliverableId !== deliverableId) {
            throw new ConflictException('The idempotency key belongs to a different Deliverable.');
          }
          return hydrateAcceptance(transaction, replay);
        }
        await lockBusinessSemanticEntity(
          transaction,
          'deliverables',
          principal.tenantId,
          deliverableId,
        );
        const deliverable = await transaction.deliverable.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: deliverableId,
            taskId,
            status: 'SUBMITTED',
          },
        });
        if (deliverable === null) {
          throw new ConflictException(
            'Acceptance requires a submitted Deliverable in the path Task.',
          );
        }
        const evidence = await loadEvidence(
          transaction,
          principal.tenantId,
          request.evidenceIds,
          new Date(request.decidedAt),
        );
        const created = await transaction.acceptance.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            deliverableId: deliverable.id,
            deliverableVersion: deliverable.version,
            decision: request.decision,
            ...deciderColumns(request.decidedBy),
            decidedAt: new Date(request.decidedAt),
            criteria: toJson(request.criteria),
            comment: request.comment,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            evidenceSealedAt: null,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await sealAcceptanceEvidence(transaction, principal.tenantId, created, evidence);
        const deliverableResult = await transaction.deliverable.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: deliverable.id,
            version: deliverable.version,
            status: 'SUBMITTED',
            revision: deliverable.revision,
          },
          data: {
            status: request.decision === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
            revision: { increment: 1 },
          },
        });
        if (deliverableResult.count !== 1) {
          throw staleSemanticRevision('Deliverable');
        }
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.acceptance.created',
          'acceptance',
          created.id,
          {
            taskId,
            deliverableId,
            decision: created.decision,
            version: created.version,
          },
        );
        const sealed = await transaction.acceptance.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: created.id },
        });
        return hydrateAcceptance(transaction, sealed);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Acceptance');
    }
  }

  async updateAcceptance(
    taskId: string,
    deliverableId: string,
    id: string,
    request: UpdateAcceptanceRequest,
  ): Promise<Acceptance> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockBusinessSemanticEntity(
          transaction,
          'deliverables',
          principal.tenantId,
          deliverableId,
        );
        await lockBusinessSemanticEntity(transaction, 'acceptances', principal.tenantId, id);
        const [deliverable, current] = await Promise.all([
          transaction.deliverable.findFirst({
            where: { tenantId: principal.tenantId, id: deliverableId, taskId },
          }),
          transaction.acceptance.findFirst({
            where: { tenantId: principal.tenantId, id, deliverableId },
          }),
        ]);
        if (deliverable === null || current === null) {
          throw semanticNotFound('Acceptance');
        }
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Acceptance');
        }
        if (current.status !== 'ACTIVE') throw illegalSemanticTransition('Acceptance');
        if (request.decision !== undefined && request.decision !== current.decision) {
          throw new ConflictException(
            'A terminal Deliverable Acceptance decision cannot be rewritten.',
          );
        }
        await this.policy.requireWrite(transaction, principal, 'business.acceptance.update', {
          resource: semanticResource('ACCEPTANCE', current, { taskId }),
          mutation: {
            ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
            ...(request.permissionLabels === undefined
              ? {}
              : { proposedPermissionLabels: request.permissionLabels }),
            proposedTaskId: taskId,
          },
        });
        const evidenceIds =
          request.evidenceIds ??
          (
            await transaction.acceptanceEvidence.findMany({
              where: {
                tenantId: principal.tenantId,
                acceptanceId: current.id,
                acceptanceVersion: current.version,
              },
              orderBy: { evidenceId: 'asc' },
            })
          ).map((link) => link.evidenceId);
        const decidedAt =
          request.decidedAt === undefined ? current.decidedAt : new Date(request.decidedAt);
        const evidence = await loadEvidence(
          transaction,
          principal.tenantId,
          evidenceIds,
          decidedAt,
        );
        const voided = await transaction.acceptance.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            status: 'ACTIVE',
            revision: request.expectedRevision,
          },
          data: {
            status: 'VOID',
            voidedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        if (voided.count !== 1) throw staleSemanticRevision('Acceptance');
        const identity = idempotencyIdentity({ id, request });
        const created = await transaction.acceptance.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: current.code,
            ...nextVersionIdentity(current),
            deliverableId: current.deliverableId,
            deliverableVersion: current.deliverableVersion,
            decision: current.decision,
            ...deciderColumns(request.decidedBy ?? deciderFromAcceptance(current)),
            decidedAt,
            criteria:
              request.criteria === undefined ? toJson(current.criteria) : toJson(request.criteria),
            comment: request.comment ?? current.comment,
            ...ownerColumns(request.owner ?? businessOwnerFromColumns(current)),
            permissionLabels:
              request.permissionLabels === undefined
                ? toJson(current.permissionLabels)
                : toJson(request.permissionLabels),
            evidenceSealedAt: null,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await sealAcceptanceEvidence(transaction, principal.tenantId, created, evidence);
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.acceptance.version_created',
          'acceptance',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        const sealed = await transaction.acceptance.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: created.id },
        });
        return hydrateAcceptance(transaction, sealed);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Acceptance');
    }
  }

  async transitionAcceptance(
    taskId: string,
    deliverableId: string,
    id: string,
    request: TransitionAcceptanceRequest,
  ): Promise<Acceptance> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBusinessSemanticEntity(transaction, 'acceptances', principal.tenantId, id);
      const [deliverable, current] = await Promise.all([
        transaction.deliverable.findFirst({
          where: { tenantId: principal.tenantId, id: deliverableId, taskId },
        }),
        transaction.acceptance.findFirst({
          where: { tenantId: principal.tenantId, id, deliverableId },
        }),
      ]);
      if (deliverable === null || current === null) {
        throw semanticNotFound('Acceptance');
      }
      if (current.revision !== request.expectedRevision) {
        throw staleSemanticRevision('Acceptance');
      }
      if (current.status !== 'ACTIVE') throw illegalSemanticTransition('Acceptance');
      await this.policy.requireWrite(transaction, principal, 'business.acceptance.transition', {
        resource: semanticResource('ACCEPTANCE', current, { taskId }),
        mutation: { proposedTaskId: taskId },
      });
      const otherActive = await transaction.acceptance.count({
        where: {
          tenantId: principal.tenantId,
          deliverableId,
          status: 'ACTIVE',
          id: { not: id },
          decision:
            deliverable.status === 'ACCEPTED'
              ? 'ACCEPTED'
              : { in: ['REJECTED', 'CHANGES_REQUESTED'] },
          evidenceSealedAt: { not: null },
        },
      });
      if (['ACCEPTED', 'REJECTED'].includes(deliverable.status) && otherActive === 0) {
        throw new ConflictException(
          'A terminal Deliverable must retain a matching active Acceptance.',
        );
      }
      const result = await transaction.acceptance.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          status: 'ACTIVE',
          revision: request.expectedRevision,
        },
        data: {
          status: 'VOID',
          voidedAt: new Date(request.effectiveAt),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw staleSemanticRevision('Acceptance');
      const updated = await transaction.acceptance.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.acceptance.voided',
        'acceptance',
        id,
        {
          reason: request.reason,
          taskId,
          deliverableId,
          version: updated.version,
          revision: updated.revision,
        },
      );
      return hydrateAcceptance(transaction, updated);
    });
  }
}

async function hydrateAcceptance(
  transaction: Prisma.TransactionClient,
  record: DbAcceptance,
): Promise<Acceptance> {
  const links = await transaction.acceptanceEvidence.findMany({
    where: {
      tenantId: record.tenantId,
      acceptanceId: record.id,
      acceptanceVersion: record.version,
    },
    orderBy: { evidenceId: 'asc' },
  });
  return mapAcceptance(
    record,
    links.map((link) => link.evidenceId),
  );
}

export async function submitDeliverableWithinTransaction(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
  current: DbDeliverable,
  request: Extract<TransitionDeliverableRequest, { readonly action: 'SUBMIT' }>,
): Promise<void> {
  if (current.status !== 'DRAFT') {
    throw illegalSemanticTransition('Deliverable');
  }
  const evidence = await loadEvidence(
    transaction,
    tenantId,
    request.evidenceIds,
    new Date(request.submittedAt),
  );
  await transaction.deliverableEvidence.createMany({
    data: evidence.map((record) => ({
      tenantId,
      deliverableId: current.id,
      deliverableVersion: current.version,
      evidenceId: record.id,
      evidenceVersion: record.version,
    })),
  });
  const result = await transaction.deliverable.updateMany({
    where: {
      tenantId,
      id: current.id,
      taskId,
      status: 'DRAFT',
      revision: request.expectedRevision,
      evidenceSealedAt: null,
    },
    data: {
      status: 'SUBMITTED',
      submittedAt: new Date(request.submittedAt),
      artifactUri: request.artifactUri,
      contentHash: request.contentHash,
      evidenceSealedAt: new Date(),
      revision: { increment: 1 },
    },
  });
  if (result.count !== 1) throw staleSemanticRevision('Deliverable');
}

async function loadEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  evidenceIds: readonly string[],
  usedAt: Date,
): Promise<DbEvidence[]> {
  const evidence = await transaction.evidence.findMany({
    where: {
      tenantId,
      id: { in: [...evidenceIds] },
      status: 'ACTIVE',
    },
    orderBy: { id: 'asc' },
  });
  if (
    evidence.length !== evidenceIds.length ||
    evidence.some(
      (record) =>
        record.effectiveFrom > usedAt ||
        (record.effectiveTo !== null && record.effectiveTo < usedAt),
    )
  ) {
    throw new ConflictException(
      'Evidence must be active, tenant-local, and effective at the decision time.',
    );
  }
  return evidence;
}

async function sealAcceptanceEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  acceptance: Pick<DbAcceptance, 'id' | 'version'>,
  evidence: readonly Pick<DbEvidence, 'id' | 'version'>[],
): Promise<void> {
  await transaction.acceptanceEvidence.createMany({
    data: evidence.map((record) => ({
      tenantId,
      acceptanceId: acceptance.id,
      acceptanceVersion: acceptance.version,
      evidenceId: record.id,
      evidenceVersion: record.version,
    })),
  });
  const result = await transaction.acceptance.updateMany({
    where: {
      tenantId,
      id: acceptance.id,
      version: acceptance.version,
      evidenceSealedAt: null,
    },
    data: { evidenceSealedAt: new Date(), revision: { increment: 1 } },
  });
  if (result.count !== 1) throw staleSemanticRevision('Acceptance');
}

function deciderFromAcceptance(record: DbAcceptance) {
  if (record.decidedByUserId !== null) {
    return { type: 'USER' as const, id: record.decidedByUserId };
  }
  if (record.decidedByRoleAssignmentId !== null) {
    return {
      type: 'ROLE_ASSIGNMENT' as const,
      id: record.decidedByRoleAssignmentId,
    };
  }
  if (record.decidedByRoleTemplateId !== null) {
    return {
      type: 'ROLE_BLUEPRINT' as const,
      id: record.decidedByRoleTemplateId,
    };
  }
  if (record.decidedByOrgUnitId !== null) {
    return { type: 'ORG_UNIT' as const, id: record.decidedByOrgUnitId };
  }
  throw new Error('Acceptance decider columns violate the exactly-one invariant.');
}
