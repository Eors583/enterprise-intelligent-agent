import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateFinopsAllocationSetRequest,
  CreateFinopsBenefitClaimRequest,
  FinopsAllocationSet,
  FinopsBenefitClaim,
  FinopsCostEntry,
  FinopsCostVerificationReview,
  RecordFinopsCostRequest,
  ReviewFinopsCostRequest,
  ReviewFinopsAllocationSetRequest,
  ReviewFinopsBenefitClaimRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  mapAllocationSet,
  mapBenefitClaim,
  mapCostEntry,
  mapCostVerificationReview,
} from './finance-finops.mappers.js';
import {
  beginFinopsCommand,
  finopsRequestIdentity,
  lockFinopsRecord,
  mapFinopsWriteError,
  recordFinopsMutation,
} from './finance-finops.persistence.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';

@Injectable()
export class FinopsLedgerService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async recordCost(request: RecordFinopsCostRequest): Promise<FinopsCostEntry> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_cost_entry');
          return mapCostEntry(
            await transaction.finopsCostEntry.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const price = await transaction.finopsPriceSnapshot.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.priceSnapshotId,
            status: 'APPROVED',
          },
        });
        if (price === null) {
          throw new NotFoundException('An approved FinOps Price Snapshot was not found.');
        }
        const quantity = new Prisma.Decimal(request.quantity);
        const calculatedAmount = quantity.div(price.unitSize).mul(price.unitPrice);
        const created = await transaction.finopsCostEntry.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            subjectType: request.subjectType,
            subjectId: request.subjectId,
            agentRunId: request.agentRunId,
            toolInvocationId: request.toolInvocationId,
            knowledgeDocumentVersionId: request.knowledgeDocumentVersionId,
            humanUserId: request.humanUserId,
            priceSnapshotId: price.id,
            priceSnapshotVersion: price.version,
            resourceKind: price.resourceKind,
            quantity,
            rawUsage: request.rawUsage as Prisma.InputJsonObject,
            formulaCode: request.formulaCode,
            formulaVersion: request.formulaVersion,
            formulaExpression: request.formulaExpression,
            currency: price.currency,
            calculatedAmount,
            verificationStatus: request.verificationStatus,
            sourceAuthority: request.source.authority,
            sourceSystem: request.source.system,
            sourceRecordId: request.source.recordId,
            sourceRecordVersion: request.source.recordVersion,
            sourceContentHash: request.source.contentHash,
            sourceEvidenceId: request.source.evidenceId,
            sourceEvidenceVersion: request.source.evidenceVersion,
            incurredAt: new Date(request.incurredAt),
            recordedByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'COST_RECORD',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_cost_entry',
          resourceId: created.id,
          resultRevision: 1,
          action: 'finops.cost.recorded',
          metadata: {
            subjectType: created.subjectType,
            subjectId: created.subjectId,
            resourceKind: created.resourceKind,
            currency: created.currency,
            calculatedAmount: created.calculatedAmount.toFixed(),
            verificationStatus: created.verificationStatus,
            sourceSystem: created.sourceSystem,
            sourceRecordId: created.sourceRecordId,
          },
        });
        return mapCostEntry(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Cost Entry');
    }
  }

  async reviewCost(
    id: string,
    request: ReviewFinopsCostRequest,
  ): Promise<FinopsCostVerificationReview> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, costEntryId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_cost_verification_review');
          return mapCostVerificationReview(
            await transaction.finopsCostVerificationReview.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const cost = await transaction.finopsCostEntry.findFirst({
          where: { tenantId: principal.tenantId, id },
          select: {
            id: true,
            recordedByUserId: true,
            sourceAuthority: true,
          },
        });
        if (cost === null) throw new NotFoundException('The FinOps Cost Entry was not found.');
        if (cost.recordedByUserId === principal.userId) {
          throw new ConflictException(
            'An independent reviewer must verify, dispute, or reject the Cost Entry.',
          );
        }
        if (
          request.decision === 'VERIFIED' &&
          request.basis === 'TRUSTED_SOURCE' &&
          cost.sourceAuthority === 'HUMAN_ATTESTED'
        ) {
          throw new ConflictException(
            'Human-attested cost requires active, verified Evidence before it can become ledger truth.',
          );
        }
        const created = await transaction.finopsCostVerificationReview.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            costEntryId: cost.id,
            revision: 1,
            decision: request.decision,
            basis: request.basis,
            reviewerUserId: principal.userId,
            evidenceId: request.evidenceId,
            evidenceVersion: request.evidenceVersion,
            evidenceContentHash: null,
            comment: request.comment,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: `COST_${request.decision}`,
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_cost_verification_review',
          resourceId: created.id,
          resultRevision: created.revision,
          action: `finops.cost.${request.decision.toLowerCase()}`,
          metadata: {
            costEntryId: cost.id,
            decision: created.decision,
            basis: created.basis,
            reviewerUserId: created.reviewerUserId,
            evidenceId: created.evidenceId,
            evidenceVersion: created.evidenceVersion,
            evidenceContentHash: created.evidenceContentHash,
          },
        });
        return mapCostVerificationReview(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Cost verification');
    }
  }

  async createAllocation(request: CreateFinopsAllocationSetRequest): Promise<FinopsAllocationSet> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_allocation_set');
          return this.hydrateAllocation(transaction, principal.tenantId, command.replay.resourceId);
        }
        const [cost, rule] = await Promise.all([
          transaction.finopsCostEntry.findFirst({
            where: { tenantId: principal.tenantId, id: request.costEntryId },
          }),
          transaction.finopsAllocationRule.findFirst({
            where: {
              tenantId: principal.tenantId,
              id: request.ruleId,
              status: 'APPROVED',
            },
          }),
        ]);
        if (cost === null) throw new NotFoundException('The FinOps Cost Entry was not found.');
        if (rule === null) {
          throw new NotFoundException('An approved FinOps Allocation Rule was not found.');
        }
        const weightTotal = request.lines.reduce(
          (total, line) => total.add(new Prisma.Decimal(line.weight)),
          new Prisma.Decimal(0),
        );
        const amountTotal = request.lines.reduce(
          (total, line) => total.add(new Prisma.Decimal(line.allocatedAmount)),
          new Prisma.Decimal(0),
        );
        if (!weightTotal.equals(1) || !amountTotal.equals(cost.calculatedAmount)) {
          throw new ConflictException(
            'Allocation weights and amounts must exactly close the immutable Cost Entry.',
          );
        }
        const created = await transaction.finopsAllocationSet.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            costEntryId: cost.id,
            ruleId: rule.id,
            ruleVersion: rule.version,
            origin: request.origin,
            status: request.origin === 'AI' ? 'CANDIDATE' : 'PENDING_REVIEW',
            proposedByUserId: principal.userId,
            proposedByAgentRunId: request.proposedByAgentRunId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await transaction.finopsCostAllocation.createMany({
          data: request.lines.map((line) => ({
            id: randomUUID(),
            tenantId: principal.tenantId,
            allocationSetId: created.id,
            employeeUserId: line.employeeUserId,
            roleAssignmentId: line.roleAssignmentId,
            taskId: line.taskId,
            taskVersion: line.taskVersion,
            processDefinitionId: line.processDefinitionId,
            processVersionId: line.processVersionId,
            processVersion: line.processVersion,
            customerId: line.customerId,
            projectId: line.projectId,
            departmentOrgUnitId: line.departmentOrgUnitId,
            weight: new Prisma.Decimal(line.weight),
            allocatedAmount: new Prisma.Decimal(line.allocatedAmount),
            rationale: line.rationale,
          })),
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ALLOCATION_PROPOSE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_allocation_set',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.allocation.proposed',
          metadata: {
            costEntryId: cost.id,
            ruleId: rule.id,
            ruleVersion: rule.version,
            origin: created.origin,
            lineCount: request.lines.length,
          },
        });
        return this.hydrateAllocation(transaction, principal.tenantId, created.id);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Allocation Set');
    }
  }

  async reviewAllocation(
    id: string,
    request: ReviewFinopsAllocationSetRequest,
  ): Promise<FinopsAllocationSet> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, resourceId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_allocation_set');
          return this.hydrateAllocation(transaction, principal.tenantId, command.replay.resourceId);
        }
        await lockFinopsRecord(transaction, 'finops_allocation_sets', principal.tenantId, id);
        const current = await transaction.finopsAllocationSet.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw new NotFoundException('FinOps Allocation Set was not found.');
        if (current.proposedByUserId === principal.userId) {
          throw new ConflictException('The allocation maker cannot act as its checker.');
        }
        const changed = await transaction.finopsAllocationSet.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: { in: ['CANDIDATE', 'PENDING_REVIEW'] },
          },
          data: {
            status: request.decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED',
            revision: { increment: 1 },
            confirmedByUserId: request.decision === 'CONFIRM' ? principal.userId : null,
            confirmedAt: request.decision === 'CONFIRM' ? new Date() : null,
            reviewComment: request.comment,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('The allocation changed. Refresh and try again.');
        }
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ALLOCATION_REVIEW',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_allocation_set',
          resourceId: id,
          resultRevision: request.expectedRevision + 1,
          action: `finops.allocation.${request.decision.toLowerCase()}`,
          metadata: {
            expectedRevision: request.expectedRevision,
            decision: request.decision,
            comment: request.comment,
          },
        });
        return this.hydrateAllocation(transaction, principal.tenantId, id);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Allocation review');
    }
  }

  async createBenefit(request: CreateFinopsBenefitClaimRequest): Promise<FinopsBenefitClaim> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_benefit_claim');
          return mapBenefitClaim(
            await transaction.finopsBenefitClaim.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const latest = await transaction.finopsBenefitClaim.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await transaction.finopsBenefitClaim.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            origin: request.origin,
            status: request.origin === 'AI' ? 'CANDIDATE' : 'PENDING_REVIEW',
            currency: request.currency,
            amount: new Prisma.Decimal(request.amount),
            periodStart: new Date(request.periodStart),
            periodEnd: new Date(request.periodEnd),
            deliverableId: request.deliverableId,
            deliverableVersion: request.deliverableVersion,
            acceptanceId: request.acceptanceId,
            acceptanceVersion: request.acceptanceVersion,
            evidenceId: request.evidenceId,
            evidenceVersion: request.evidenceVersion,
            valueDefinitionId: request.valueDefinitionId,
            valueVersionId: request.valueVersionId,
            valueVersion: request.valueVersion,
            objectiveId: request.objectiveId,
            objectiveVersion: request.objectiveVersion,
            sourceAuthority: request.source.authority,
            sourceSystem: request.source.system,
            sourceRecordId: request.source.recordId,
            sourceRecordVersion: request.source.recordVersion,
            sourceContentHash: request.source.contentHash,
            agentRunId: request.agentRunId,
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'BENEFIT_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_benefit_claim',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.benefit.candidate_created',
          metadata: {
            code: created.code,
            version: created.version,
            origin: created.origin,
            currency: created.currency,
            amount: created.amount.toFixed(),
            deliverableId: created.deliverableId,
            acceptanceId: created.acceptanceId,
            evidenceId: created.evidenceId,
            objectiveId: created.objectiveId,
            valueVersionId: created.valueVersionId,
          },
        });
        return mapBenefitClaim(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Benefit Claim');
    }
  }

  async reviewBenefit(
    id: string,
    request: ReviewFinopsBenefitClaimRequest,
  ): Promise<FinopsBenefitClaim> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, resourceId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_benefit_claim');
          return mapBenefitClaim(
            await transaction.finopsBenefitClaim.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        await lockFinopsRecord(transaction, 'finops_benefit_claims', principal.tenantId, id);
        const current = await transaction.finopsBenefitClaim.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw new NotFoundException('FinOps Benefit Claim was not found.');
        const trustedImport =
          request.decision === 'CONFIRM' &&
          current.origin === 'TRUSTED_SYSTEM' &&
          request.trustedImportReceipt !== null;
        if (
          request.decision === 'CONFIRM' &&
          !trustedImport &&
          current.createdByUserId === principal.userId
        ) {
          throw new ConflictException('The Benefit maker cannot act as its checker.');
        }
        if (
          request.decision === 'CONFIRM' &&
          current.origin !== 'TRUSTED_SYSTEM' &&
          request.trustedImportReceipt !== null
        ) {
          throw new ConflictException('Only a trusted-system Benefit may use an import receipt.');
        }
        const changed = await transaction.finopsBenefitClaim.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: { in: ['CANDIDATE', 'PENDING_REVIEW'] },
          },
          data: {
            status: request.decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED',
            revision: { increment: 1 },
            confirmationAuthority:
              request.decision !== 'CONFIRM' ? null : trustedImport ? 'TRUSTED_SYSTEM' : 'HUMAN',
            confirmedByUserId:
              request.decision === 'CONFIRM' && !trustedImport ? principal.userId : null,
            trustedImportReceipt:
              request.decision === 'CONFIRM' && trustedImport
                ? (request.trustedImportReceipt as Prisma.InputJsonObject)
                : Prisma.DbNull,
            confirmedAt: request.decision === 'CONFIRM' ? new Date() : null,
            reviewComment: request.comment,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('The Benefit changed. Refresh and try again.');
        }
        await recordFinopsMutation(transaction, principal, {
          commandType: 'BENEFIT_REVIEW',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_benefit_claim',
          resourceId: id,
          resultRevision: request.expectedRevision + 1,
          action: `finops.benefit.${request.decision.toLowerCase()}`,
          metadata: {
            expectedRevision: request.expectedRevision,
            decision: request.decision,
            confirmationAuthority: trustedImport ? 'TRUSTED_SYSTEM' : 'HUMAN',
            comment: request.comment,
          },
        });
        return mapBenefitClaim(
          await transaction.finopsBenefitClaim.findFirstOrThrow({
            where: { tenantId: principal.tenantId, id },
          }),
        );
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Benefit review');
    }
  }

  private async hydrateAllocation(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<FinopsAllocationSet> {
    const [set, lines] = await Promise.all([
      transaction.finopsAllocationSet.findFirstOrThrow({ where: { tenantId, id } }),
      transaction.finopsCostAllocation.findMany({
        where: { tenantId, allocationSetId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return mapAllocationSet(set, lines);
  }
}

function assertReplay(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ConflictException('FinOps command replay resolved to a different resource type.');
  }
}
