import { Inject, Injectable } from '@nestjs/common';
import type { FinopsDashboard } from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  type EffectiveCostVerificationRow,
  mapAllocationRule,
  mapAllocationSet,
  mapBenefitClaim,
  mapBudget,
  mapBudgetAlert,
  mapCostEntry,
  mapDimensionMember,
  mapPriceSnapshot,
  mapRoiFormula,
  mapRoiSnapshot,
  mapRoutingSuggestion,
} from './finance-finops.mappers.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';

@Injectable()
export class FinopsQueryService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async dashboard(currency: string): Promise<FinopsDashboard> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const [
        priceSnapshots,
        allocationRules,
        dimensionMembers,
        roiFormulas,
        costEntries,
        effectiveCostVerifications,
        allocationSets,
        allocationLines,
        benefitClaims,
        roiSnapshots,
        budgets,
        budgetEvents,
        alerts,
        projectionDiagnostics,
        routingSuggestions,
      ] = await Promise.all([
        transaction.finopsPriceSnapshot.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
        }),
        transaction.finopsAllocationRule.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
        }),
        transaction.finopsDimensionMember.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ dimension: 'asc' }, { code: 'asc' }],
          take: 500,
        }),
        transaction.finopsRoiFormulaVersion.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
        }),
        transaction.finopsCostEntry.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ incurredAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
        transaction.$queryRaw<EffectiveCostVerificationRow[]>`
          SELECT
            state."tenant_id" AS "tenantId",
            state."cost_entry_id" AS "costEntryId",
            state."original_verification_status" AS "originalVerificationStatus",
            state."effective_verification_status" AS "effectiveVerificationStatus",
            state."review_id" AS "reviewId",
            state."review_revision" AS "reviewRevision",
            state."review_decision" AS "reviewDecision",
            state."review_basis" AS "reviewBasis",
            state."reviewer_user_id" AS "reviewerUserId",
            state."evidence_id" AS "evidenceId",
            state."evidence_version" AS "evidenceVersion",
            state."evidence_content_hash" AS "evidenceContentHash",
            state."review_comment" AS "reviewComment",
            state."reviewed_at" AS "reviewedAt"
          FROM public."finops_effective_cost_verifications" state
          JOIN public."finops_cost_entries" cost
            ON cost."tenant_id" = state."tenant_id"
           AND cost."id" = state."cost_entry_id"
          WHERE state."tenant_id" = ${principal.tenantId}::uuid
            AND cost."currency" = ${currency}
        `,
        transaction.finopsAllocationSet.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
        transaction.finopsCostAllocation.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 5_000,
        }),
        transaction.finopsBenefitClaim.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
        transaction.finopsRoiSnapshot.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
        }),
        transaction.finopsBudget.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
        transaction.finopsBudgetEvent.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 5_000,
        }),
        transaction.finopsBudgetAlert.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
        transaction.finopsProjectionDiagnostic.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: [{ openedAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
        transaction.finopsModelRoutingSuggestion.findMany({
          where: { tenantId: principal.tenantId, currency },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 500,
        }),
      ]);

      const effectiveCostById = new Map(
        effectiveCostVerifications.map((state) => [state.costEntryId, state] as const),
      );
      const verifiedCost = sum(
        costEntries
          .filter(
            (entry) => effectiveCostById.get(entry.id)?.effectiveVerificationStatus === 'VERIFIED',
          )
          .map((entry) => entry.calculatedAmount),
      );
      const pendingCost = sum(
        costEntries
          .filter(
            (entry) => effectiveCostById.get(entry.id)?.effectiveVerificationStatus !== 'VERIFIED',
          )
          .map((entry) => entry.calculatedAmount),
      );
      const confirmedBenefit = sum(
        benefitClaims.filter((claim) => claim.status === 'CONFIRMED').map((claim) => claim.amount),
      );
      const mappedBudgets = budgets.map((budget) =>
        mapBudget(
          budget,
          budgetEvents.filter((event) => event.budgetId === budget.id),
        ),
      );
      return {
        generatedAt: new Date().toISOString(),
        currency,
        totals: {
          verifiedCost: verifiedCost.toFixed(),
          pendingCost: pendingCost.toFixed(),
          confirmedBenefit: confirmedBenefit.toFixed(),
          activeBudgetLimit: sum(
            budgets
              .filter((budget) => budget.status === 'ACTIVE')
              .map((budget) => budget.limitAmount),
          ).toFixed(),
          activeBudgetReserved: sum(
            mappedBudgets
              .filter((budget) => budget.status === 'ACTIVE')
              .map((budget) => new Prisma.Decimal(budget.reservedAmount)),
          ).toFixed(),
          activeBudgetSettled: sum(
            mappedBudgets
              .filter((budget) => budget.status === 'ACTIVE')
              .map((budget) => new Prisma.Decimal(budget.settledAmount)),
          ).toFixed(),
          openAlerts: alerts.filter((alert) => alert.status === 'OPEN').length,
          openProjectionDiagnostics: projectionDiagnostics.filter(
            (diagnostic) => diagnostic.status === 'OPEN',
          ).length,
        },
        priceSnapshots: priceSnapshots.map(mapPriceSnapshot),
        allocationRules: allocationRules.map(mapAllocationRule),
        dimensionMembers: dimensionMembers.map(mapDimensionMember),
        roiFormulas: roiFormulas.map(mapRoiFormula),
        costEntries: costEntries.map((entry) =>
          mapCostEntry(entry, effectiveCostById.get(entry.id)),
        ),
        allocationSets: allocationSets.map((set) =>
          mapAllocationSet(
            set,
            allocationLines.filter((line) => line.allocationSetId === set.id),
          ),
        ),
        benefitClaims: benefitClaims.map(mapBenefitClaim),
        roiSnapshots: roiSnapshots.map(mapRoiSnapshot),
        budgets: mappedBudgets,
        alerts: alerts.map(mapBudgetAlert),
        projectionDiagnostics: projectionDiagnostics.map((diagnostic) => ({
          id: diagnostic.id,
          tenantId: diagnostic.tenantId,
          sourceKind: diagnostic.sourceKind,
          sourceId: diagnostic.sourceId,
          sourceVersion: diagnostic.sourceVersion,
          code: diagnostic.code,
          detail: diagnostic.detail,
          metadata: jsonRecord(diagnostic.metadata),
          status: diagnostic.status,
          openedAt: diagnostic.openedAt.toISOString(),
          resolvedAt: diagnostic.resolvedAt?.toISOString() ?? null,
        })),
        routingSuggestions: routingSuggestions.map(mapRoutingSuggestion),
      };
    });
  }
}

function sum(values: readonly Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.add(value), new Prisma.Decimal(0));
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
