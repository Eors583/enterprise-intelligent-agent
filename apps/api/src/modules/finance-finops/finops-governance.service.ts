import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AcknowledgeFinopsAlertRequest,
  ApproveFinopsBudgetRequest,
  CreateFinopsBudgetEventRequest,
  CreateFinopsBudgetRequest,
  CreateFinopsRoutingSuggestionRequest,
  DecideFinopsRoutingSuggestionRequest,
  FinopsBudget,
  FinopsBudgetAlert,
  FinopsBudgetEvent,
  FinopsRoiSnapshot,
  FinopsRoutingSuggestion,
  RecomputeFinopsRoiRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  mapBudget,
  mapBudgetAlert,
  mapBudgetEvent,
  mapRoiSnapshot,
  mapRoutingSuggestion,
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
export class FinopsGovernanceService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async recomputeRoi(request: RecomputeFinopsRoiRequest): Promise<FinopsRoiSnapshot> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_roi_snapshot');
          return mapRoiSnapshot(
            await transaction.finopsRoiSnapshot.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const formula = await transaction.finopsRoiFormulaVersion.findFirst({
          where: {
            tenantId: principal.tenantId,
            id: request.formulaId,
            status: 'APPROVED',
          },
        });
        if (formula === null) {
          throw new NotFoundException('An approved FinOps ROI Formula Version was not found.');
        }
        if (request.recalculationOfId !== null) {
          const prior = await transaction.finopsRoiSnapshot.findFirst({
            where: { tenantId: principal.tenantId, id: request.recalculationOfId },
          });
          if (prior === null) {
            throw new NotFoundException('The prior ROI snapshot was not found.');
          }
        }
        const periodStart = new Date(request.periodStart);
        const periodEnd = new Date(request.periodEnd);
        const [costRows, benefitRows] = await Promise.all([
          transaction.$queryRaw<
            Array<{
              id: string;
              calculatedAmount: Prisma.Decimal;
              sourceContentHash: string;
              priceSnapshotId: string;
              priceSnapshotVersion: number;
              reviewId: string | null;
              reviewRevision: number | null;
              reviewEvidenceContentHash: string | null;
            }>
          >`
            SELECT
              cost."id",
              cost."calculated_amount" AS "calculatedAmount",
              cost."source_content_hash" AS "sourceContentHash",
              cost."price_snapshot_id" AS "priceSnapshotId",
              cost."price_snapshot_version" AS "priceSnapshotVersion",
              state."review_id" AS "reviewId",
              state."review_revision" AS "reviewRevision",
              state."evidence_content_hash" AS "reviewEvidenceContentHash"
            FROM public."finops_cost_entries" cost
            JOIN public."finops_effective_cost_verifications" state
              ON state."tenant_id" = cost."tenant_id"
             AND state."cost_entry_id" = cost."id"
            WHERE cost."tenant_id" = ${principal.tenantId}::uuid
              AND cost."currency" = ${request.currency}
              AND cost."incurred_at" >= ${periodStart}
              AND cost."incurred_at" < ${periodEnd}
              AND state."effective_verification_status" = 'VERIFIED'
            ORDER BY cost."incurred_at" ASC, cost."id" ASC
          `,
          transaction.finopsBenefitClaim.findMany({
            where: {
              tenantId: principal.tenantId,
              currency: request.currency,
              status: 'CONFIRMED',
              periodStart: { lt: periodEnd },
              periodEnd: { gt: periodStart },
            },
            orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              amount: true,
              sourceContentHash: true,
              evidenceId: true,
              evidenceVersion: true,
              revision: true,
            },
          }),
        ]);
        const cost = costRows.reduce(
          (total, row) => total.add(row.calculatedAmount),
          new Prisma.Decimal(0),
        );
        const benefit = benefitRows.reduce(
          (total, row) => total.add(row.amount),
          new Prisma.Decimal(0),
        );
        const net = benefit.sub(cost);
        const ratio = cost.isZero() ? null : net.div(cost);
        const costInputsHash = hashStable(
          costRows.map((row) => ({
            id: row.id,
            amount: row.calculatedAmount.toFixed(),
            sourceContentHash: row.sourceContentHash,
            priceSnapshotId: row.priceSnapshotId,
            priceSnapshotVersion: row.priceSnapshotVersion,
            reviewId: row.reviewId,
            reviewRevision: row.reviewRevision,
            reviewEvidenceContentHash: row.reviewEvidenceContentHash,
          })),
        );
        const benefitInputsHash = hashStable(
          benefitRows.map((row) => ({
            id: row.id,
            amount: row.amount.toFixed(),
            sourceContentHash: row.sourceContentHash,
            evidenceId: row.evidenceId,
            evidenceVersion: row.evidenceVersion,
            revision: row.revision,
          })),
        );
        const inputsHash = hashStable({
          formulaId: formula.id,
          formulaVersion: formula.version,
          currency: request.currency,
          periodStart: request.periodStart,
          periodEnd: request.periodEnd,
          costInputsHash,
          benefitInputsHash,
        });
        const created = await transaction.finopsRoiSnapshot.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            formulaId: formula.id,
            formulaVersion: formula.version,
            currency: request.currency,
            periodStart,
            periodEnd,
            verifiedCost: cost,
            confirmedBenefit: benefit,
            netBenefit: net,
            roiRatio: ratio,
            status: cost.isZero() ? 'INVALID_ZERO_COST' : 'COMPUTED',
            costInputsHash,
            benefitInputsHash,
            inputsHash,
            recalculationOfId: request.recalculationOfId,
            calculatedByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ROI_RECOMPUTE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_roi_snapshot',
          resourceId: created.id,
          resultRevision: 1,
          action: 'finops.roi.recomputed',
          metadata: {
            formulaId: formula.id,
            formulaVersion: formula.version,
            currency: request.currency,
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
            verifiedCost: cost.toFixed(),
            confirmedBenefit: benefit.toFixed(),
            status: created.status,
            recalculationOfId: request.recalculationOfId,
          },
        });
        return mapRoiSnapshot(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps ROI recomputation');
    }
  }

  async createBudget(request: CreateFinopsBudgetRequest): Promise<FinopsBudget> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_budget');
          return this.hydrateBudget(transaction, principal.tenantId, command.replay.resourceId);
        }
        if (request.scopeType === 'TENANT' && request.scopeId !== principal.tenantId) {
          throw new ConflictException('Tenant budget scope must equal the active tenant.');
        }
        if (request.scopeType === 'CUSTOMER' || request.scopeType === 'PROJECT') {
          const dimension = await transaction.finopsDimensionMember.findFirst({
            where: {
              tenantId: principal.tenantId,
              id: request.scopeId,
              dimension: request.scopeType,
            },
          });
          if (dimension === null) {
            throw new NotFoundException(
              `The ${request.scopeType.toLowerCase()} FinOps dimension was not found.`,
            );
          }
        }
        const latest = await transaction.finopsBudget.findFirst({
          where: { tenantId: principal.tenantId, code: request.code },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await transaction.finopsBudget.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            code: request.code,
            version: (latest?.version ?? 0) + 1,
            scopeType: request.scopeType,
            scopeId: request.scopeId,
            employeeUserId: request.scopeType === 'EMPLOYEE' ? request.scopeId : null,
            roleAssignmentId: request.scopeType === 'ROLE_ASSIGNMENT' ? request.scopeId : null,
            taskId: request.scopeType === 'TASK' ? request.scopeId : null,
            taskVersion: request.scopeType === 'TASK' ? request.scopeVersion : null,
            processDefinitionId: request.scopeType === 'PROCESS' ? request.scopeId : null,
            customerId: request.scopeType === 'CUSTOMER' ? request.scopeId : null,
            projectId: request.scopeType === 'PROJECT' ? request.scopeId : null,
            departmentOrgUnitId: request.scopeType === 'DEPARTMENT' ? request.scopeId : null,
            currency: request.currency,
            limitAmount: new Prisma.Decimal(request.limitAmount),
            alertThresholdRatio: new Prisma.Decimal(request.alertThresholdRatio),
            periodStart: new Date(request.periodStart),
            periodEnd: new Date(request.periodEnd),
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'BUDGET_CREATE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_budget',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.budget.created',
          metadata: {
            code: created.code,
            version: created.version,
            scopeType: created.scopeType,
            scopeId: created.scopeId,
            currency: created.currency,
            limitAmount: created.limitAmount.toFixed(),
          },
        });
        return mapBudget(created, []);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Budget');
    }
  }

  async approveBudget(id: string, request: ApproveFinopsBudgetRequest): Promise<FinopsBudget> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, resourceId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_budget');
          return this.hydrateBudget(transaction, principal.tenantId, command.replay.resourceId);
        }
        await lockFinopsRecord(transaction, 'finops_budgets', principal.tenantId, id);
        const current = await transaction.finopsBudget.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (current === null) throw new NotFoundException('FinOps Budget was not found.');
        if (current.createdByUserId === principal.userId) {
          throw new ConflictException('The Budget maker cannot act as its checker.');
        }
        const changed = await transaction.finopsBudget.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: 'DRAFT',
          },
          data: {
            status: request.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED',
            revision: { increment: 1 },
            approvedByUserId: principal.userId,
            approvalComment: request.comment,
            approvedAt: new Date(),
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('The Budget changed. Refresh and try again.');
        }
        await recordFinopsMutation(transaction, principal, {
          commandType: 'BUDGET_REVIEW',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_budget',
          resourceId: id,
          resultRevision: request.expectedRevision + 1,
          action: `finops.budget.${request.decision.toLowerCase()}`,
          metadata: {
            decision: request.decision,
            expectedRevision: request.expectedRevision,
            comment: request.comment,
          },
        });
        return this.hydrateBudget(transaction, principal.tenantId, id);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Budget review');
    }
  }

  async createBudgetEvent(
    budgetId: string,
    request: CreateFinopsBudgetEventRequest,
  ): Promise<FinopsBudgetEvent> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, budgetId });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_budget_event');
          return mapBudgetEvent(
            await transaction.finopsBudgetEvent.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        if (request.type === 'ADJUSTMENT') {
          throw new UnprocessableEntityException(
            'Budget adjustments require a separate maker-checker workflow; create a new Budget Version.',
          );
        }
        const budget = await transaction.finopsBudget.findFirst({
          where: { tenantId: principal.tenantId, id: budgetId, status: 'ACTIVE' },
        });
        if (budget === null) throw new NotFoundException('An active FinOps Budget was not found.');
        if (request.type === 'SETTLEMENT' && request.costEntryId !== null) {
          const cost = await transaction.$queryRaw<Array<{ id: string }>>`
            SELECT cost."id"
            FROM public."finops_cost_entries" cost
            JOIN public."finops_effective_cost_verifications" state
              ON state."tenant_id" = cost."tenant_id"
             AND state."cost_entry_id" = cost."id"
            WHERE cost."tenant_id" = ${principal.tenantId}::uuid
              AND cost."id" = ${request.costEntryId}::uuid
              AND cost."currency" = ${budget.currency}
              AND state."effective_verification_status" = 'VERIFIED'
          `;
          if (cost.length !== 1) {
            throw new ConflictException(
              'Budget settlement requires an effectively verified same-currency Cost Entry.',
            );
          }
        }
        const created = await transaction.finopsBudgetEvent.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            budgetId: budget.id,
            budgetVersion: budget.version,
            type: request.type,
            currency: budget.currency,
            amount: new Prisma.Decimal(request.amount),
            reservationEventId: request.reservationEventId,
            costEntryId: request.costEntryId,
            reason: request.reason,
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: `BUDGET_${request.type}`,
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_budget_event',
          resourceId: created.id,
          resultRevision: 1,
          action: `finops.budget.${request.type.toLowerCase()}`,
          metadata: {
            budgetId: budget.id,
            budgetVersion: budget.version,
            amount: created.amount.toFixed(),
            currency: created.currency,
            reservationEventId: created.reservationEventId,
            costEntryId: created.costEntryId,
          },
        });
        return mapBudgetEvent(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Budget event');
    }
  }

  async acknowledgeAlert(
    id: string,
    request: AcknowledgeFinopsAlertRequest,
  ): Promise<FinopsBudgetAlert> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, resourceId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_budget_alert');
          return mapBudgetAlert(
            await transaction.finopsBudgetAlert.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        await lockFinopsRecord(transaction, 'finops_budget_alerts', principal.tenantId, id);
        const changed = await transaction.finopsBudgetAlert.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: 'OPEN',
          },
          data: {
            status: 'ACKNOWLEDGED',
            revision: { increment: 1 },
            acknowledgedByUserId: principal.userId,
            acknowledgementComment: request.comment,
            acknowledgedAt: new Date(),
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('The Budget Alert changed. Refresh and try again.');
        }
        const alert = await transaction.finopsBudgetAlert.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'BUDGET_ALERT_ACKNOWLEDGE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_budget_alert',
          resourceId: id,
          resultRevision: alert.revision,
          action: 'finops.budget_alert.acknowledged',
          metadata: {
            expectedRevision: request.expectedRevision,
            comment: request.comment,
          },
        });
        return mapBudgetAlert(alert);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Budget Alert');
    }
  }

  async createRoutingSuggestion(
    request: CreateFinopsRoutingSuggestionRequest,
  ): Promise<FinopsRoutingSuggestion> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity(request);
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_model_routing_suggestion');
          return mapRoutingSuggestion(
            await transaction.finopsModelRoutingSuggestion.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        const created = await transaction.finopsModelRoutingSuggestion.create({
          data: {
            id: randomUUID(),
            tenantId: principal.tenantId,
            agentRunId: request.agentRunId,
            currentRoute: request.currentRoute,
            suggestedRoute: request.suggestedRoute,
            currency: request.currency,
            estimatedSavings: new Prisma.Decimal(request.estimatedSavings),
            qualityFloor: new Prisma.Decimal(request.qualityFloor),
            policyBoundary: request.policyBoundary as Prisma.InputJsonObject,
            rationale: request.rationale,
            autoApplied: false,
            createdByUserId: principal.userId,
            idempotencyKey: request.idempotencyKey,
            requestHash: identity.requestHash,
          },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ROUTING_SUGGEST',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_model_routing_suggestion',
          resourceId: created.id,
          resultRevision: created.revision,
          action: 'finops.routing_suggestion.created',
          metadata: {
            currentRoute: created.currentRoute,
            suggestedRoute: created.suggestedRoute,
            estimatedSavings: created.estimatedSavings.toFixed(),
            qualityFloor: created.qualityFloor.toFixed(),
            autoApplied: false,
          },
        });
        return mapRoutingSuggestion(created);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Routing Suggestion');
    }
  }

  async decideRoutingSuggestion(
    id: string,
    request: DecideFinopsRoutingSuggestionRequest,
  ): Promise<FinopsRoutingSuggestion> {
    const principal = this.access.requireDirectoryWrite();
    const identity = finopsRequestIdentity({ ...request, resourceId: id });
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const command = await beginFinopsCommand(transaction, principal.tenantId, identity);
        if (command.replay !== null) {
          assertReplay(command.replay.resourceType, 'finops_model_routing_suggestion');
          return mapRoutingSuggestion(
            await transaction.finopsModelRoutingSuggestion.findFirstOrThrow({
              where: { tenantId: principal.tenantId, id: command.replay.resourceId },
            }),
          );
        }
        await lockFinopsRecord(
          transaction,
          'finops_model_routing_suggestions',
          principal.tenantId,
          id,
        );
        const changed = await transaction.finopsModelRoutingSuggestion.updateMany({
          where: {
            tenantId: principal.tenantId,
            id,
            revision: request.expectedRevision,
            status: 'PROPOSED',
            autoApplied: false,
          },
          data: {
            status: request.decision === 'ACCEPT_FOR_REVIEW' ? 'ACCEPTED_FOR_REVIEW' : 'REJECTED',
            revision: { increment: 1 },
            decidedByUserId: principal.userId,
            decisionComment: request.comment,
            decidedAt: new Date(),
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('The Routing Suggestion changed. Refresh and try again.');
        }
        const suggestion = await transaction.finopsModelRoutingSuggestion.findFirstOrThrow({
          where: { tenantId: principal.tenantId, id },
        });
        await recordFinopsMutation(transaction, principal, {
          commandType: 'ROUTING_DECIDE',
          idempotencyKey: request.idempotencyKey,
          requestHash: identity.requestHash,
          resourceType: 'finops_model_routing_suggestion',
          resourceId: id,
          resultRevision: suggestion.revision,
          action: `finops.routing_suggestion.${request.decision.toLowerCase()}`,
          metadata: {
            decision: request.decision,
            expectedRevision: request.expectedRevision,
            autoApplied: false,
            comment: request.comment,
          },
        });
        return mapRoutingSuggestion(suggestion);
      });
    } catch (error) {
      return mapFinopsWriteError(error, 'FinOps Routing Suggestion decision');
    }
  }

  private async hydrateBudget(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<FinopsBudget> {
    const [budget, events] = await Promise.all([
      transaction.finopsBudget.findFirstOrThrow({ where: { tenantId, id } }),
      transaction.finopsBudgetEvent.findMany({
        where: { tenantId, budgetId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return mapBudget(budget, events);
  }
}

function assertReplay(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ConflictException('FinOps command replay resolved to a different resource type.');
  }
}
