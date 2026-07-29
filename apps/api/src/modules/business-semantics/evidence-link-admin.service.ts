import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateEvidenceLinkRequest,
  EvidenceLink,
  TransitionEvidenceLinkRequest,
  UpdateEvidenceLinkRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { mapEvidenceLink, ownerColumns } from './business-semantics.mapper.js';
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
export class EvidenceLinkAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async list(evidenceId: string): Promise<{ items: EvidenceLink[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => ({
      items: (
        await transaction.evidenceLink.findMany({
          where: { tenantId: principal.tenantId, evidenceId },
          orderBy: [{ code: 'asc' }, { version: 'desc' }, { id: 'asc' }],
          take: 50_000,
        })
      ).map(mapEvidenceLink),
    }));
  }

  async create(
    evidenceId: string,
    request: CreateEvidenceLinkRequest,
    suppliedKey?: string,
  ): Promise<EvidenceLink> {
    if (request.evidenceId !== evidenceId) {
      throw new ConflictException('Path and request Evidence identities differ.');
    }
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity({ evidenceId, request }, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'evidence-link', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.evidence.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
            ...(request.targetType === 'TASK' ? { proposedTaskId: request.targetId } : {}),
          },
        });
        const replay = await transaction.evidenceLink.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          if (replay.evidenceId !== evidenceId) {
            throw new ConflictException('The idempotency key belongs to different Evidence.');
          }
          return mapEvidenceLink(replay);
        }
        const evidence = await transaction.evidence.findFirst({
          where: { tenantId: principal.tenantId, id: evidenceId, status: 'ACTIVE' },
        });
        if (evidence === null) {
          throw new ConflictException('Evidence Link requires active Evidence.');
        }
        const target = await resolveEvidenceTarget(
          transaction,
          principal.tenantId,
          request.targetType,
          request.targetId,
          request.targetVersion,
        );
        const effectiveFrom = new Date(request.effectiveFrom);
        const effectiveTo = nullableDate(request.effectiveTo);
        assertLinkPeriod(evidence, target.period, effectiveFrom, effectiveTo);
        const created = await transaction.evidenceLink.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            evidenceId: evidence.id,
            evidenceVersion: evidence.version,
            targetType: request.targetType,
            ...target.columns,
            targetVersion: request.targetVersion,
            type: request.type,
            relevance: request.relevance,
            statement: request.statement,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            effectiveFrom,
            effectiveTo,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.evidence_link.created',
          'evidence_link',
          created.id,
          {
            evidenceId,
            targetType: created.targetType,
            targetId: request.targetId,
            targetVersion: created.targetVersion,
          },
        );
        return mapEvidenceLink(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Evidence Link');
    }
  }

  async update(
    evidenceId: string,
    id: string,
    request: UpdateEvidenceLinkRequest,
  ): Promise<EvidenceLink> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockBusinessSemanticEntity(transaction, 'evidence_links', principal.tenantId, id);
        const current = await transaction.evidenceLink.findFirst({
          where: { tenantId: principal.tenantId, id, evidenceId },
        });
        if (current === null) throw semanticNotFound('Evidence Link');
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Evidence Link');
        }
        if (current.status !== 'ACTIVE') throw illegalSemanticTransition('Evidence Link');
        const taskId = await targetTaskScope(transaction, current);
        await this.policy.requireWrite(transaction, principal, 'business.evidence.update', {
          resource: semanticResource('EVIDENCE', current, { taskId }),
          mutation: {
            ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
            ...(request.permissionLabels === undefined
              ? {}
              : { proposedPermissionLabels: request.permissionLabels }),
            ...(taskId === null ? {} : { proposedTaskId: taskId }),
          },
        });
        const removed = await transaction.evidenceLink.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            evidenceId,
            status: 'ACTIVE',
            revision: request.expectedRevision,
          },
          data: {
            status: 'REMOVED',
            removedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        if (removed.count !== 1) throw staleSemanticRevision('Evidence Link');
        const identity = idempotencyIdentity({ evidenceId, id, request });
        const created = await transaction.evidenceLink.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: current.code,
            ...nextVersionIdentity(current),
            evidenceId: current.evidenceId,
            evidenceVersion: current.evidenceVersion,
            targetType: current.targetType,
            targetValueDefinitionId: current.targetValueDefinitionId,
            targetValueVersionId: current.targetValueVersionId,
            targetStrategyId: current.targetStrategyId,
            targetObjectiveId: current.targetObjectiveId,
            targetMetricObservationId: current.targetMetricObservationId,
            targetTaskId: current.targetTaskId,
            targetDeliverableId: current.targetDeliverableId,
            targetAcceptanceId: current.targetAcceptanceId,
            targetVersion: current.targetVersion,
            type: request.type ?? current.type,
            relevance: request.relevance ?? current.relevance,
            statement: request.statement ?? current.statement,
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
          'business_semantics.evidence_link.version_created',
          'evidence_link',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        return mapEvidenceLink(created);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Evidence Link');
    }
  }

  async transition(
    evidenceId: string,
    id: string,
    request: TransitionEvidenceLinkRequest,
  ): Promise<EvidenceLink> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockBusinessSemanticEntity(transaction, 'evidence_links', principal.tenantId, id);
      const current = await transaction.evidenceLink.findFirst({
        where: { tenantId: principal.tenantId, id, evidenceId },
      });
      if (current === null) throw semanticNotFound('Evidence Link');
      if (current.revision !== request.expectedRevision) {
        throw staleSemanticRevision('Evidence Link');
      }
      if (current.status !== 'ACTIVE') throw illegalSemanticTransition('Evidence Link');
      const taskId = await targetTaskScope(transaction, current);
      await this.policy.requireWrite(transaction, principal, 'business.evidence.transition', {
        resource: semanticResource('EVIDENCE', current, { taskId }),
        mutation: taskId === null ? {} : { proposedTaskId: taskId },
      });
      const result = await transaction.evidenceLink.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          evidenceId,
          status: 'ACTIVE',
          revision: request.expectedRevision,
        },
        data: {
          status: 'REMOVED',
          removedAt: new Date(request.effectiveAt),
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw staleSemanticRevision('Evidence Link');
      const updated = await transaction.evidenceLink.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id },
      });
      await recordBusinessMutation(
        transaction,
        principal,
        'business_semantics.evidence_link.removed',
        'evidence_link',
        id,
        {
          reason: request.reason,
          evidenceId,
          version: updated.version,
          revision: updated.revision,
        },
      );
      return mapEvidenceLink(updated);
    });
  }
}

async function resolveEvidenceTarget(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  type: CreateEvidenceLinkRequest['targetType'],
  id: string,
  version: number,
) {
  const emptyColumns = {
    targetValueDefinitionId: null,
    targetValueVersionId: null,
    targetStrategyId: null,
    targetObjectiveId: null,
    targetMetricObservationId: null,
    targetTaskId: null,
    targetDeliverableId: null,
    targetAcceptanceId: null,
  };
  switch (type) {
    case 'VALUE_VERSION': {
      const record = await transaction.valueVersion.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: {
          ...emptyColumns,
          targetValueDefinitionId: record.valueDefinitionId,
          targetValueVersionId: record.id,
        },
        period: record,
        taskId: null,
      };
    }
    case 'STRATEGY': {
      const record = await transaction.strategy.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: { ...emptyColumns, targetStrategyId: record.id },
        period: record,
        taskId: null,
      };
    }
    case 'OBJECTIVE': {
      const record = await transaction.objective.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: { ...emptyColumns, targetObjectiveId: record.id },
        period: record,
        taskId: null,
      };
    }
    case 'METRIC_OBSERVATION': {
      const record = await transaction.metricObservation.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: { ...emptyColumns, targetMetricObservationId: record.id },
        period: null,
        taskId: record.subjectTaskId,
      };
    }
    case 'TASK': {
      const record = await transaction.task.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: { ...emptyColumns, targetTaskId: record.id },
        period: record,
        taskId: record.id,
      };
    }
    case 'DELIVERABLE': {
      const record = await transaction.deliverable.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: { ...emptyColumns, targetDeliverableId: record.id },
        period: record,
        taskId: record.taskId,
      };
    }
    case 'ACCEPTANCE': {
      const record = await transaction.acceptance.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Evidence Link target');
      const deliverable = await transaction.deliverable.findFirst({
        where: {
          tenantId,
          id: record.deliverableId,
          version: record.deliverableVersion,
        },
      });
      if (deliverable === null) throw semanticNotFound('Evidence Link target');
      return {
        columns: { ...emptyColumns, targetAcceptanceId: record.id },
        period: null,
        taskId: deliverable.taskId,
      };
    }
  }
}

function assertLinkPeriod(
  evidence: { readonly effectiveFrom: Date; readonly effectiveTo: Date | null },
  target: { readonly effectiveFrom: Date; readonly effectiveTo: Date | null } | null,
  effectiveFrom: Date,
  effectiveTo: Date | null,
): void {
  for (const period of [evidence, target]) {
    if (
      period !== null &&
      (effectiveFrom < period.effectiveFrom ||
        (period.effectiveTo !== null && (effectiveTo === null || effectiveTo > period.effectiveTo)))
    ) {
      throw new ConflictException(
        'Evidence Link effective period must fit Evidence and target periods.',
      );
    }
  }
}

async function targetTaskScope(
  transaction: Prisma.TransactionClient,
  link: {
    readonly targetTaskId: string | null;
    readonly targetDeliverableId: string | null;
    readonly targetAcceptanceId: string | null;
  },
): Promise<string | null> {
  if (link.targetTaskId !== null) return link.targetTaskId;
  if (link.targetDeliverableId !== null) {
    return (
      (
        await transaction.deliverable.findFirst({
          where: { id: link.targetDeliverableId },
          select: { taskId: true },
        })
      )?.taskId ?? null
    );
  }
  if (link.targetAcceptanceId !== null) {
    const acceptance = await transaction.acceptance.findFirst({
      where: { id: link.targetAcceptanceId },
      select: { deliverableId: true, deliverableVersion: true, tenantId: true },
    });
    if (acceptance === null) return null;
    return (
      (
        await transaction.deliverable.findFirst({
          where: {
            tenantId: acceptance.tenantId,
            id: acceptance.deliverableId,
            version: acceptance.deliverableVersion,
          },
          select: { taskId: true },
        })
      )?.taskId ?? null
    );
  }
  return null;
}
