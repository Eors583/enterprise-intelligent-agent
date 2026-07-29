import type {
  FinopsAllocationLine,
  FinopsAllocationRule,
  FinopsAllocationSet,
  FinopsBenefitClaim,
  FinopsBudget,
  FinopsBudgetAlert,
  FinopsBudgetEvent,
  FinopsCostEntry,
  FinopsCostVerificationReview,
  FinopsDimensionMember,
  FinopsPriceSnapshot,
  FinopsRoiFormulaVersion,
  FinopsRoiSnapshot,
  FinopsRoutingSuggestion,
  FinopsSourceReference,
} from '@enterprise/contracts';
import {
  Prisma,
  type FinopsAllocationSet as DbAllocationSet,
  type FinopsAllocationRule as DbAllocationRule,
  type FinopsBenefitClaim as DbBenefitClaim,
  type FinopsBudget as DbBudget,
  type FinopsBudgetAlert as DbBudgetAlert,
  type FinopsBudgetEvent as DbBudgetEvent,
  type FinopsCostAllocation as DbCostAllocation,
  type FinopsCostEntry as DbCostEntry,
  type FinopsCostVerificationReview as DbCostVerificationReview,
  type FinopsDimensionMember as DbDimensionMember,
  type FinopsModelRoutingSuggestion as DbRoutingSuggestion,
  type FinopsPriceSnapshot as DbPriceSnapshot,
  type FinopsRoiFormulaVersion as DbRoiFormulaVersion,
  type FinopsRoiSnapshot as DbRoiSnapshot,
} from '@prisma/client';

export interface EffectiveCostVerificationRow {
  readonly tenantId: string;
  readonly costEntryId: string;
  readonly originalVerificationStatus: FinopsCostEntry['originalVerificationStatus'];
  readonly effectiveVerificationStatus: FinopsCostEntry['effectiveVerificationStatus'];
  readonly reviewId: string | null;
  readonly reviewRevision: number | null;
  readonly reviewDecision: FinopsCostVerificationReview['decision'] | null;
  readonly reviewBasis: FinopsCostVerificationReview['basis'] | null;
  readonly reviewerUserId: string | null;
  readonly evidenceId: string | null;
  readonly evidenceVersion: number | null;
  readonly evidenceContentHash: string | null;
  readonly reviewComment: string | null;
  readonly reviewedAt: Date | null;
}

export function mapPriceSnapshot(row: DbPriceSnapshot): FinopsPriceSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    version: row.version,
    revision: row.revision,
    resourceKind: row.resourceKind,
    provider: row.provider,
    sku: row.sku,
    currency: row.currency,
    billingUnit: row.billingUnit,
    unitSize: decimal(row.unitSize),
    unitPrice: decimal(row.unitPrice),
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    status: row.status,
    source: source(row),
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapCostEntry(
  row: DbCostEntry,
  effective?: EffectiveCostVerificationRow,
): FinopsCostEntry {
  const originalVerificationStatus =
    effective?.originalVerificationStatus ?? row.verificationStatus;
  return {
    id: row.id,
    tenantId: row.tenantId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    agentRunId: row.agentRunId,
    toolInvocationId: row.toolInvocationId,
    knowledgeDocumentVersionId: row.knowledgeDocumentVersionId,
    humanUserId: row.humanUserId,
    priceSnapshotId: row.priceSnapshotId,
    priceSnapshotVersion: row.priceSnapshotVersion,
    resourceKind: row.resourceKind,
    quantity: decimal(row.quantity),
    rawUsage: asObject(row.rawUsage),
    formulaCode: row.formulaCode,
    formulaVersion: row.formulaVersion,
    formulaExpression: row.formulaExpression,
    currency: row.currency,
    calculatedAmount: decimal(row.calculatedAmount),
    verificationStatus: originalVerificationStatus,
    originalVerificationStatus,
    effectiveVerificationStatus:
      effective?.effectiveVerificationStatus ?? originalVerificationStatus,
    latestVerificationReview:
      effective?.reviewId === undefined || effective.reviewId === null
        ? null
        : mapEffectiveCostVerificationReview(effective),
    source: source(row),
    incurredAt: row.incurredAt.toISOString(),
    recordedByUserId: row.recordedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapCostVerificationReview(
  row: DbCostVerificationReview,
): FinopsCostVerificationReview {
  if (row.decision === 'PENDING') {
    throw new Error('FinOps cost verification review cannot retain a pending decision.');
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    costEntryId: row.costEntryId,
    revision: row.revision,
    decision: row.decision,
    basis: row.basis,
    reviewerUserId: row.reviewerUserId,
    evidenceId: row.evidenceId,
    evidenceVersion: row.evidenceVersion,
    evidenceContentHash: row.evidenceContentHash,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapAllocationRule(row: DbAllocationRule): FinopsAllocationRule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    version: row.version,
    revision: row.revision,
    method: row.method,
    dimensions: Array.isArray(row.dimensions)
      ? (row.dimensions as FinopsAllocationRule['dimensions'])
      : [],
    ruleDefinition: asObject(row.ruleDefinition),
    status: row.status,
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapDimensionMember(row: DbDimensionMember): FinopsDimensionMember {
  return {
    id: row.id,
    tenantId: row.tenantId,
    dimension: row.dimension,
    code: row.code,
    name: row.name,
    sourceSystem: row.sourceSystem,
    sourceRecordId: row.sourceRecordId,
    sourceRecordVersion: row.sourceRecordVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapRoiFormula(row: DbRoiFormulaVersion): FinopsRoiFormulaVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    version: row.version,
    revision: row.revision,
    expression: '(confirmedBenefit - verifiedCost) / verifiedCost',
    status: row.status,
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapAllocationSet(
  row: DbAllocationSet,
  lines: readonly DbCostAllocation[],
): FinopsAllocationSet {
  return {
    id: row.id,
    tenantId: row.tenantId,
    costEntryId: row.costEntryId,
    ruleId: row.ruleId,
    ruleVersion: row.ruleVersion,
    origin: row.origin,
    status: row.status,
    revision: row.revision,
    proposedByUserId: row.proposedByUserId,
    proposedByAgentRunId: row.proposedByAgentRunId,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    lines: lines.map(mapAllocationLine),
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapBenefitClaim(row: DbBenefitClaim): FinopsBenefitClaim {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    version: row.version,
    revision: row.revision,
    origin: row.origin,
    status: row.status,
    currency: row.currency,
    amount: decimal(row.amount),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    deliverableId: row.deliverableId,
    deliverableVersion: row.deliverableVersion,
    acceptanceId: row.acceptanceId,
    acceptanceVersion: row.acceptanceVersion,
    evidenceId: row.evidenceId,
    evidenceVersion: row.evidenceVersion,
    valueDefinitionId: row.valueDefinitionId,
    valueVersionId: row.valueVersionId,
    valueVersion: row.valueVersion,
    objectiveId: row.objectiveId,
    objectiveVersion: row.objectiveVersion,
    source: source(row),
    agentRunId: row.agentRunId,
    createdByUserId: row.createdByUserId,
    confirmationAuthority: row.confirmationAuthority,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapRoiSnapshot(row: DbRoiSnapshot): FinopsRoiSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    formulaId: row.formulaId,
    formulaVersion: row.formulaVersion,
    currency: row.currency,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    verifiedCost: decimal(row.verifiedCost),
    confirmedBenefit: decimal(row.confirmedBenefit),
    netBenefit: decimal(row.netBenefit),
    roiRatio: row.roiRatio === null ? null : decimal(row.roiRatio),
    status: row.status,
    inputsHash: row.inputsHash,
    recalculationOfId: row.recalculationOfId,
    calculatedByUserId: row.calculatedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapBudget(row: DbBudget, events: readonly DbBudgetEvent[]): FinopsBudget {
  let reserved = new Prisma.Decimal(0);
  let settled = new Prisma.Decimal(0);
  for (const event of events) {
    if (event.type === 'RESERVATION') reserved = reserved.add(event.amount);
    if (event.type === 'SETTLEMENT') {
      reserved = reserved.sub(event.amount);
      settled = settled.add(event.amount);
    }
    if (event.type === 'RELEASE') reserved = reserved.sub(event.amount);
    if (event.type === 'ADJUSTMENT') settled = settled.add(event.amount);
  }
  if (reserved.isNegative()) reserved = new Prisma.Decimal(0);
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    version: row.version,
    revision: row.revision,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    scopeVersion: row.taskVersion,
    currency: row.currency,
    limitAmount: decimal(row.limitAmount),
    alertThresholdRatio: decimal(row.alertThresholdRatio),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    reservedAmount: decimal(reserved),
    settledAmount: decimal(settled),
    availableAmount: decimal(row.limitAmount.sub(reserved).sub(settled)),
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapBudgetAlert(row: DbBudgetAlert): FinopsBudgetAlert {
  return {
    id: row.id,
    tenantId: row.tenantId,
    budgetId: row.budgetId,
    budgetVersion: row.budgetVersion,
    type: row.type,
    status: row.status,
    observedAmount: decimal(row.observedAmount),
    thresholdAmount: decimal(row.thresholdAmount),
    revision: row.revision,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapBudgetEvent(row: DbBudgetEvent): FinopsBudgetEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    budgetId: row.budgetId,
    budgetVersion: row.budgetVersion,
    type: row.type,
    currency: row.currency,
    amount: decimal(row.amount),
    reservationEventId: row.reservationEventId,
    costEntryId: row.costEntryId,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapRoutingSuggestion(row: DbRoutingSuggestion): FinopsRoutingSuggestion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentRunId: row.agentRunId,
    currentRoute: row.currentRoute,
    suggestedRoute: row.suggestedRoute,
    currency: row.currency,
    estimatedSavings: decimal(row.estimatedSavings),
    qualityFloor: row.qualityFloor.toNumber(),
    policyBoundary: asObject(row.policyBoundary),
    rationale: row.rationale,
    status: row.status,
    autoApplied: false,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
}

export function decimal(value: Prisma.Decimal): string {
  return value.toFixed();
}

function mapAllocationLine(row: DbCostAllocation): FinopsAllocationLine {
  return {
    id: row.id,
    tenantId: row.tenantId,
    allocationSetId: row.allocationSetId,
    employeeUserId: row.employeeUserId,
    roleAssignmentId: row.roleAssignmentId,
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    processDefinitionId: row.processDefinitionId,
    processVersionId: row.processVersionId,
    processVersion: row.processVersion,
    customerId: row.customerId,
    projectId: row.projectId,
    departmentOrgUnitId: row.departmentOrgUnitId,
    weight: decimal(row.weight),
    allocatedAmount: decimal(row.allocatedAmount),
    rationale: row.rationale,
    createdAt: row.createdAt.toISOString(),
  };
}

function source(row: {
  readonly sourceAuthority: FinopsSourceReference['authority'];
  readonly sourceSystem: string;
  readonly sourceRecordId: string;
  readonly sourceRecordVersion: string;
  readonly sourceContentHash: string;
  readonly sourceEvidenceId?: string | null;
  readonly sourceEvidenceVersion?: number | null;
}): FinopsSourceReference {
  return {
    authority: row.sourceAuthority,
    system: row.sourceSystem,
    recordId: row.sourceRecordId,
    recordVersion: row.sourceRecordVersion,
    contentHash: row.sourceContentHash,
    evidenceId: row.sourceEvidenceId ?? null,
    evidenceVersion: row.sourceEvidenceVersion ?? null,
  };
}

function mapEffectiveCostVerificationReview(
  row: EffectiveCostVerificationRow,
): FinopsCostVerificationReview {
  if (
    row.reviewId === null ||
    row.reviewRevision === null ||
    row.reviewDecision === null ||
    row.reviewBasis === null ||
    row.reviewerUserId === null ||
    row.reviewComment === null ||
    row.reviewedAt === null
  ) {
    throw new Error('Effective FinOps cost verification view returned an incomplete review.');
  }
  return {
    id: row.reviewId,
    tenantId: row.tenantId,
    costEntryId: row.costEntryId,
    revision: row.reviewRevision,
    decision: row.reviewDecision,
    basis: row.reviewBasis,
    reviewerUserId: row.reviewerUserId,
    evidenceId: row.evidenceId,
    evidenceVersion: row.evidenceVersion,
    evidenceContentHash: row.evidenceContentHash,
    comment: row.reviewComment,
    createdAt: row.reviewedAt.toISOString(),
  };
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}
