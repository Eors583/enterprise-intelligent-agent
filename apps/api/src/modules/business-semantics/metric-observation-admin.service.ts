import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateMetricObservationRequest,
  MetricObservation,
  UpdateMetricObservationRequest,
} from '@enterprise/contracts';
import { Prisma, type MetricObservation as DbMetricObservation } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { mapMetricObservation, ownerColumns } from './business-semantics.mapper.js';
import {
  BusinessSemanticsPolicyService,
  semanticResource,
} from './business-semantics-policy.service.js';
import {
  assertIdempotentReplay,
  idempotencyIdentity,
  lockIdempotency,
  recordBusinessMutation,
  toJson,
} from './business-semantics.mutation.js';
import {
  businessOwnerFromColumns,
  jsonStringArray,
  lockBusinessSemanticEntity,
  mapSemanticWriteError,
  nextVersionIdentity,
  semanticNotFound,
  staleSemanticRevision,
} from './business-semantics.persistence.js';

@Injectable()
export class MetricObservationAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(BusinessSemanticsPolicyService)
    private readonly policy: BusinessSemanticsPolicyService,
  ) {}

  async list(): Promise<{ items: MetricObservation[] }> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const records = await transaction.metricObservation.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ observedAt: 'desc' }, { code: 'asc' }, { version: 'desc' }],
        take: 10_000,
      });
      const links = await transaction.metricObservationEvidence.findMany({
        where: {
          tenantId: principal.tenantId,
          metricObservationId: { in: records.map((record) => record.id) },
        },
        orderBy: { evidenceId: 'asc' },
      });
      return {
        items: records.map((record) =>
          mapMetricObservation(
            record,
            links
              .filter(
                (link) =>
                  link.metricObservationId === record.id &&
                  link.metricObservationVersion === record.version,
              )
              .map((link) => link.evidenceId),
          ),
        ),
      };
    });
  }

  async create(
    request: CreateMetricObservationRequest,
    suppliedKey?: string,
  ): Promise<MetricObservation> {
    const principal = this.access.requireDirectoryWrite();
    const identity = idempotencyIdentity(request, suppliedKey);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockIdempotency(transaction, principal.tenantId, 'metric-observation', identity.key);
        await this.policy.requireWrite(transaction, principal, 'business.metric.create', {
          mutation: {
            proposedOwner: request.owner,
            proposedPermissionLabels: request.permissionLabels,
            ...(request.subject.type === 'TASK' ? { proposedTaskId: request.subject.id } : {}),
          },
        });
        const replay = await transaction.metricObservation.findFirst({
          where: { tenantId: principal.tenantId, idempotencyKey: identity.key },
        });
        if (replay !== null) {
          assertIdempotentReplay(replay, identity.requestHash);
          return hydrateObservation(transaction, replay);
        }
        const resolved = await resolveObservationReferences(
          transaction,
          principal.tenantId,
          request,
        );
        const created = await transaction.metricObservation.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: 1,
            metricDefinitionId: resolved.metric.id,
            metricDefinitionVersion: resolved.metric.version,
            ...resolved.subjectColumns,
            value: request.value,
            periodStart: new Date(request.periodStart),
            periodEnd: new Date(request.periodEnd),
            observedAt: new Date(request.observedAt),
            supersedesObservationId: resolved.supersedes?.id ?? null,
            supersedesObservationVersion: resolved.supersedes?.version ?? null,
            ...ownerColumns(request.owner),
            permissionLabels: toJson(request.permissionLabels),
            evidenceSealedAt: null,
            idempotencyKey: identity.key,
            requestHash: identity.requestHash,
          },
        });
        await sealObservationEvidence(transaction, principal.tenantId, created, resolved.evidence);
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.metric_observation.created',
          'metric_observation',
          created.id,
          {
            metricDefinitionId: created.metricDefinitionId,
            subjectType: created.subjectType,
            version: created.version,
          },
        );
        const sealed = await transaction.metricObservation.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: created.id },
        });
        return hydrateObservation(transaction, sealed);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Metric Observation');
    }
  }

  async update(id: string, request: UpdateMetricObservationRequest): Promise<MetricObservation> {
    const principal = this.access.requireDirectoryWrite();
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await lockBusinessSemanticEntity(
          transaction,
          'metric_observations',
          principal.tenantId,
          id,
        );
        const current = await transaction.metricObservation.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw semanticNotFound('Metric Observation');
        if (current.revision !== request.expectedRevision) {
          throw staleSemanticRevision('Metric Observation');
        }
        await this.policy.requireWrite(transaction, principal, 'business.metric.update', {
          resource: semanticResource('METRIC', current),
          mutation: {
            ...(request.owner === undefined ? {} : { proposedOwner: request.owner }),
            ...(request.permissionLabels === undefined
              ? {}
              : {
                  proposedPermissionLabels: request.permissionLabels,
                }),
          },
        });
        const evidenceIds =
          request.evidenceIds ??
          (
            await transaction.metricObservationEvidence.findMany({
              where: {
                tenantId: principal.tenantId,
                metricObservationId: current.id,
                metricObservationVersion: current.version,
              },
              orderBy: { evidenceId: 'asc' },
            })
          ).map((link) => link.evidenceId);
        const evidence = await loadActiveEvidence(transaction, principal.tenantId, evidenceIds);
        const claimed = await transaction.metricObservation.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
          },
          data: { revision: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          throw staleSemanticRevision('Metric Observation');
        }
        const identity = idempotencyIdentity({ id, request });
        const created = await transaction.metricObservation.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: current.code,
            ...nextVersionIdentity(current),
            metricDefinitionId: current.metricDefinitionId,
            metricDefinitionVersion: current.metricDefinitionVersion,
            subjectType: current.subjectType,
            subjectValueDefinitionId: current.subjectValueDefinitionId,
            subjectValueVersionId: current.subjectValueVersionId,
            subjectStrategyId: current.subjectStrategyId,
            subjectObjectiveId: current.subjectObjectiveId,
            subjectTaskId: current.subjectTaskId,
            subjectDeliverableId: current.subjectDeliverableId,
            subjectVersion: current.subjectVersion,
            value: request.value ?? current.value,
            periodStart: current.periodStart,
            periodEnd: current.periodEnd,
            observedAt:
              request.observedAt === undefined ? current.observedAt : new Date(request.observedAt),
            supersedesObservationId: current.id,
            supersedesObservationVersion: current.version,
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
        await sealObservationEvidence(transaction, principal.tenantId, created, evidence);
        await recordBusinessMutation(
          transaction,
          principal,
          'business_semantics.metric_observation.version_created',
          'metric_observation',
          created.id,
          { previousVersionId: current.id, version: created.version },
        );
        const sealed = await transaction.metricObservation.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id: created.id },
        });
        return hydrateObservation(transaction, sealed);
      });
    } catch (error) {
      throw mapSemanticWriteError(error, 'Metric Observation');
    }
  }
}

async function hydrateObservation(
  transaction: Prisma.TransactionClient,
  record: DbMetricObservation,
): Promise<MetricObservation> {
  const evidence = await transaction.metricObservationEvidence.findMany({
    where: {
      tenantId: record.tenantId,
      metricObservationId: record.id,
      metricObservationVersion: record.version,
    },
    orderBy: { evidenceId: 'asc' },
  });
  return mapMetricObservation(
    record,
    evidence.map((link) => link.evidenceId),
  );
}

async function resolveObservationReferences(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  request: CreateMetricObservationRequest,
) {
  const metric = await transaction.metricDefinition.findFirst({
    where: { tenantId, id: request.metricDefinitionId },
  });
  if (metric === null) throw semanticNotFound('Metric Definition');
  if (metric.status !== 'ACTIVE') {
    throw new ConflictException('Metric Observation requires an active Metric Definition.');
  }
  const periodStart = new Date(request.periodStart);
  const periodEnd = new Date(request.periodEnd);
  if (
    periodStart < metric.effectiveFrom ||
    (metric.effectiveTo !== null && periodEnd > metric.effectiveTo)
  ) {
    throw new ConflictException(
      'Metric Observation period must fit the Metric Definition effective period.',
    );
  }
  const subject = await loadObservationSubject(
    transaction,
    tenantId,
    request.subject.type,
    request.subject.id,
    request.subject.version,
  );
  if (
    subject.effectiveFrom !== undefined &&
    (periodStart < subject.effectiveFrom ||
      (subject.effectiveTo !== null && periodEnd > subject.effectiveTo))
  ) {
    throw new ConflictException('Metric Observation period must fit the subject effective period.');
  }
  const evidence = await loadActiveEvidence(transaction, tenantId, request.evidenceIds);
  const supersedes =
    request.supersedesObservationId === null
      ? null
      : await transaction.metricObservation.findFirst({
          where: {
            tenantId,
            id: request.supersedesObservationId,
            metricDefinitionId: metric.id,
            subjectType: request.subject.type,
            subjectVersion: request.subject.version,
          },
        });
  if (request.supersedesObservationId !== null && supersedes === null) {
    throw new ConflictException(
      'Superseded Metric Observation must have the same metric and subject identity.',
    );
  }
  return {
    metric,
    evidence,
    supersedes,
    subjectColumns: observationSubjectColumns(request.subject),
  };
}

async function loadObservationSubject(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  type: CreateMetricObservationRequest['subject']['type'],
  id: string,
  version: number,
): Promise<{ effectiveFrom?: Date; effectiveTo: Date | null }> {
  switch (type) {
    case 'VALUE_VERSION': {
      const record = await transaction.valueVersion.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Metric Observation subject');
      return record;
    }
    case 'STRATEGY': {
      const record = await transaction.strategy.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Metric Observation subject');
      return record;
    }
    case 'OBJECTIVE': {
      const record = await transaction.objective.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Metric Observation subject');
      return record;
    }
    case 'TASK': {
      const record = await transaction.task.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Metric Observation subject');
      return record;
    }
    case 'DELIVERABLE': {
      const record = await transaction.deliverable.findFirst({
        where: { tenantId, id, version },
      });
      if (record === null) throw semanticNotFound('Metric Observation subject');
      return record;
    }
  }
}

function observationSubjectColumns(subject: CreateMetricObservationRequest['subject']) {
  return {
    subjectType: subject.type,
    subjectValueDefinitionId: null,
    subjectValueVersionId: subject.type === 'VALUE_VERSION' ? subject.id : null,
    subjectStrategyId: subject.type === 'STRATEGY' ? subject.id : null,
    subjectObjectiveId: subject.type === 'OBJECTIVE' ? subject.id : null,
    subjectTaskId: subject.type === 'TASK' ? subject.id : null,
    subjectDeliverableId: subject.type === 'DELIVERABLE' ? subject.id : null,
    subjectVersion: subject.version,
  };
}

async function loadActiveEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  evidenceIds: readonly string[],
) {
  const evidence = await transaction.evidence.findMany({
    where: { tenantId, id: { in: [...evidenceIds] }, status: 'ACTIVE' },
    orderBy: { id: 'asc' },
  });
  if (evidence.length !== evidenceIds.length) {
    throw new ConflictException('Metric Observation requires active, tenant-local Evidence.');
  }
  return evidence;
}

async function sealObservationEvidence(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  observation: Pick<DbMetricObservation, 'id' | 'version'>,
  evidence: readonly { readonly id: string; readonly version: number }[],
): Promise<void> {
  await transaction.metricObservationEvidence.createMany({
    data: evidence.map((record) => ({
      tenantId,
      metricObservationId: observation.id,
      metricObservationVersion: observation.version,
      evidenceId: record.id,
      evidenceVersion: record.version,
    })),
  });
  const result = await transaction.metricObservation.updateMany({
    where: {
      tenantId,
      id: observation.id,
      version: observation.version,
      evidenceSealedAt: null,
    },
    data: { evidenceSealedAt: new Date(), revision: { increment: 1 } },
  });
  if (result.count !== 1) throw staleSemanticRevision('Metric Observation');
}
