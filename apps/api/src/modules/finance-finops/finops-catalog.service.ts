import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ApproveFinopsAllocationRuleRequest,
  ApproveFinopsPriceSnapshotRequest,
  ApproveFinopsRoiFormulaVersionRequest,
  CreateFinopsAllocationRuleRequest,
  CreateFinopsDimensionMemberRequest,
  CreateFinopsPriceSnapshotRequest,
  CreateFinopsRoiFormulaVersionRequest,
  FinopsAllocationRule,
  FinopsDimensionMember,
  FinopsPriceSnapshot,
  FinopsRoiFormulaVersion,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  mapAllocationRule,
  mapDimensionMember,
  mapPriceSnapshot,
  mapRoiFormula,
} from './finance-finops.mappers.js';
import {
  beginFinopsCommand,
  finopsRequestIdentity,
  hashStable,
  lockFinopsRecord,
  mapFinopsWriteError,
  recordFinopsMutation,
} from './finance-finops.persistence.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';

@Injectable()
export class FinopsCatalogService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async createPrice(request: CreateFinopsPriceSnapshotRequest): Promise<FinopsPriceSnapshot> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_price_snapshot');
          return mapPriceSnapshot(
            await transaction.finopsPriceSnapshot.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const latest = await transaction.finopsPriceSnapshot.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await transaction.finopsPriceSnapshot.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            resourceKind: request.resourceKind,
            provider: request.provider,
            sku: request.sku,
            currency: request.currency,
            billingUnit: request.billingUnit,
            unitSize: new Prisma.Decimal(request.unitSize),
            unitPrice: new Prisma.Decimal(request.unitPrice),
            effectiveFrom: new Date(request.effectiveFrom),
            effectiveTo: request.effectiveTo === null ? null : new Date(request.effectiveTo),
            sourceAuthority: request.source.authority,
            sourceSystem: request.source.system,
            sourceRecordId: request.source.recordId,
            sourceRecordVersion: request.source.recordVersion,
            sourceContentHash: request.source.contentHash,
            sourceEvidenceId: request.source.evidenceId,
            sourceEvidenceVersion: request.source.evidenceVersion,
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'PRICE_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_price_snapshot',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.price_snapshot.created',
          metadata: {
            code: created.code,
            version: created.version,
            resourceKind: created.resourceKind,
            provider: created.provider,
            sku: created.sku,
          },
        });
        return mapPriceSnapshot(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Price Snapshot');
    }
  }

  async approvePrice(
    id: string,
    request: ApproveFinopsPriceSnapshotRequest,
  ): Promise<FinopsPriceSnapshot> {
    return this.approveVersionedRecord(
      'finops_price_snapshots',
      'finops_price_snapshot',
      'PRICE_REVIEW',
      id,
      request,
      async (transaction, tenantId, resourceId) =>
        transaction.finopsPriceSnapshot.findFirstOrThrow({
          where: { tenantId, id: resourceId },
        }),
      async (transaction, tenantId, resourceId, actorId, now) => {
        const changed = await transaction.finopsPriceSnapshot.updateMany({
          where: {
            tenantId,
            id: resourceId,
            revision: request.expectedRevision,
            status: 'DRAFT',
          },
          data: {
            status: request.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            revision: { increment: 1 },
            approvedByUserId: actorId,
            approvalComment: request.comment,
            approvedAt: now,
          },
        });
        return changed.count;
      },
      mapPriceSnapshot,
      'price_snapshot',
    );
  }

  async createAllocationRule(
    request: CreateFinopsAllocationRuleRequest,
  ): Promise<FinopsAllocationRule> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_allocation_rule');
          return mapAllocationRule(
            await transaction.finopsAllocationRule.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const latest = await transaction.finopsAllocationRule.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const definitionHash = hashStable({
          method: request.method,
          dimensions: request.dimensions,
          ruleDefinition: request.ruleDefinition,
        });
        const created = await transaction.finopsAllocationRule.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            method: request.method,
            dimensions: request.dimensions,
            ruleDefinition: request.ruleDefinition as Prisma.InputJsonObject,
            definitionHash,
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ALLOCATION_RULE_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_allocation_rule',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.allocation_rule.created',
          metadata: { code: created.code, version: created.version, method: created.method },
        });
        return mapAllocationRule(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Allocation Rule');
    }
  }

  async approveAllocationRule(
    id: string,
    request: ApproveFinopsAllocationRuleRequest,
  ): Promise<FinopsAllocationRule> {
    return this.approveVersionedRecord(
      'finops_allocation_rules',
      'finops_allocation_rule',
      'ALLOCATION_RULE_REVIEW',
      id,
      request,
      async (transaction, tenantId, resourceId) =>
        transaction.finopsAllocationRule.findFirstOrThrow({
          where: { tenantId, id: resourceId },
        }),
      async (transaction, tenantId, resourceId, actorId, now) => {
        const changed = await transaction.finopsAllocationRule.updateMany({
          where: {
            tenantId,
            id: resourceId,
            revision: request.expectedRevision,
            status: 'DRAFT',
          },
          data: {
            status: request.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            revision: { increment: 1 },
            approvedByUserId: actorId,
            approvalComment: request.comment,
            approvedAt: now,
          },
        });
        return changed.count;
      },
      mapAllocationRule,
      'allocation_rule',
    );
  }

  async createDimensionMember(
    request: CreateFinopsDimensionMemberRequest,
  ): Promise<FinopsDimensionMember> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_dimension_member');
          return mapDimensionMember(
            await transaction.finopsDimensionMember.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const created = await transaction.finopsDimensionMember.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            dimension: request.dimension,
            code: request.code,
            name: request.name,
            sourceSystem: request.sourceSystem,
            sourceRecordId: request.sourceRecordId,
            sourceRecordVersion: request.sourceRecordVersion,
            sourceContentHash: request.sourceContentHash,
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'DIMENSION_MEMBER_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_dimension_member',
          resourceId: created.id,
          resultRevision: 1,
          action: 'finops.dimension_member.created',
          metadata: { dimension: created.dimension, code: created.code },
        });
        return mapDimensionMember(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Dimension Member');
    }
  }

  async createRoiFormula(
    request: CreateFinopsRoiFormulaVersionRequest,
  ): Promise<FinopsRoiFormulaVersion> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_roi_formula_version');
          return mapRoiFormula(
            await transaction.finopsRoiFormulaVersion.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const latest = await transaction.finopsRoiFormulaVersion.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await transaction.finopsRoiFormulaVersion.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            expression: request.expression,
            expressionHash: hashStable(request.expression),
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ROI_FORMULA_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_roi_formula_version',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.roi_formula.created',
          metadata: { code: created.code, version: created.version },
        });
        return mapRoiFormula(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps ROI Formula');
    }
  }

  async approveRoiFormula(
    id: string,
    request: ApproveFinopsRoiFormulaVersionRequest,
  ): Promise<FinopsRoiFormulaVersion> {
    return this.approveVersionedRecord(
      'finops_roi_formula_versions',
      'finops_roi_formula_version',
      'ROI_FORMULA_REVIEW',
      id,
      request,
      async (transaction, tenantId, resourceId) =>
        transaction.finopsRoiFormulaVersion.findFirstOrThrow({
          where: { tenantId, id: resourceId },
        }),
      async (transaction, tenantId, resourceId, actorId, now) => {
        const changed = await transaction.finopsRoiFormulaVersion.updateMany({
          where: {
            tenantId,
            id: resourceId,
            revision: request.expectedRevision,
            status: 'DRAFT',
          },
          data: {
            status: request.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            revision: { increment: 1 },
            approvedByUserId: actorId,
            approvalComment: request.comment,
            approvedAt: now,
          },
        });
        return changed.count;
      },
      mapRoiFormula,
      'roi_formula',
    );
  }

  private async approveVersionedRecord<Stored, Result>(
    table: 'finops_price_snapshots' | 'finops_allocation_rules' | 'finops_roi_formula_versions',
    resourceType: string,
    commandType: string,
    id: string,
    request: ApproveFinopsPriceSnapshotRequest,
    load: (transaction: Prisma.TransactionClient, tenantId: string, id: string) => Promise<Stored>,
    update: (
      transaction: Prisma.TransactionClient,
      tenantId: string,
      id: string,
      actorId: string,
      now: Date,
    ) => Promise<number>,
    map: (stored: Stored) => Result,
    actionName: string,
  ): Promise<Result> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, resourceId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, resourceType);
          return map(await load(transaction, principal.tenantId, command.replay.resourceId));
        }
        await lockFinopsRecord(transaction, table, principal.tenantId, id);
        let current: Stored;
        try {
          current = await load(transaction, principal.tenantId, id);
        } catch {
          throw new NotFoundException('The FinOps versioned record was not found.');
        }
        if ((current as { createdByUserId?: string }).createdByUserId === principal.userId) {
          throw new ConflictException('The FinOps maker cannot act as its checker.');
        }
        if (
          (await update(transaction, principal.tenantId, id, principal.userId, new Date())) !== 1
        ) {
          throw new ConflictException('The FinOps record changed. Refresh and try again.');
        }
        const changed = await load(transaction, principal.tenantId, id);
        const revision = (changed as { revision?: number }).revision ?? 1;
        await recordFinopsMutation(transaction, principal, {
          commandType,
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType,
          resourceId: id,
          resultRevision: revision,
          action: `finops.${actionName}.${request.decision.toLowerCase()}`,
          metadata: {
            decision: request.decision,
            expectedRevision: request.expectedRevision,
            comment: request.comment,
          },
        });
        return map(changed);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps governed version');
    }
  }
}

function assertReplay(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ConflictException('FinOps command replay resolved to a different resource type.');
  }
}
