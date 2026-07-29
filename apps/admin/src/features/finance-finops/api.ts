import {
  acknowledgeFinopsAlertRequestSchema,
  approveFinopsBudgetRequestSchema,
  approveFinopsPriceSnapshotRequestSchema,
  approveFinopsRoiFormulaVersionRequestSchema,
  createFinopsBudgetEventRequestSchema,
  createFinopsBudgetRequestSchema,
  createFinopsPriceSnapshotRequestSchema,
  decideFinopsRoutingSuggestionRequestSchema,
  finopsBudgetAlertSchema,
  finopsBudgetEventSchema,
  finopsBudgetSchema,
  finopsAllocationSetSchema,
  finopsBenefitClaimSchema,
  finopsCostEntrySchema,
  finopsCostVerificationReviewSchema,
  finopsDashboardSchema,
  finopsPriceSnapshotSchema,
  finopsRoiFormulaVersionSchema,
  finopsRoiSnapshotSchema,
  finopsRoutingSuggestionSchema,
  recomputeFinopsRoiRequestSchema,
  recordFinopsCostRequestSchema,
  reviewFinopsAllocationSetRequestSchema,
  reviewFinopsBenefitClaimRequestSchema,
  reviewFinopsCostRequestSchema,
  type AcknowledgeFinopsAlertRequest,
  type ApproveFinopsBudgetRequest,
  type ApproveFinopsPriceSnapshotRequest,
  type ApproveFinopsRoiFormulaVersionRequest,
  type CreateFinopsBudgetEventRequest,
  type CreateFinopsBudgetRequest,
  type CreateFinopsPriceSnapshotRequest,
  type DecideFinopsRoutingSuggestionRequest,
  type FinopsBudget,
  type FinopsAllocationSet,
  type FinopsBenefitClaim,
  type FinopsBudgetAlert,
  type FinopsBudgetEvent,
  type FinopsDashboard,
  type FinopsCostEntry,
  type FinopsCostVerificationReview,
  type FinopsPriceSnapshot,
  type FinopsRoiFormulaVersion,
  type FinopsRoiSnapshot,
  type FinopsRoutingSuggestion,
  type RecomputeFinopsRoiRequest,
  type RecordFinopsCostRequest,
  type ReviewFinopsAllocationSetRequest,
  type ReviewFinopsBenefitClaimRequest,
  type ReviewFinopsCostRequest,
} from '@enterprise/contracts';

import { request } from '@/api/client';

export function loadFinopsDashboard(
  currency: string,
  signal?: AbortSignal,
): Promise<FinopsDashboard> {
  return request(`/admin/finops/dashboard?currency=${encodeURIComponent(currency)}`, {
    schema: finopsDashboardSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createFinopsPriceSnapshot(
  input: CreateFinopsPriceSnapshotRequest,
): Promise<FinopsPriceSnapshot> {
  return request('/admin/finops/price-snapshots', {
    method: 'POST',
    schema: finopsPriceSnapshotSchema,
    body: createFinopsPriceSnapshotRequestSchema.parse(input),
  });
}

export function reviewFinopsPriceSnapshot(
  id: string,
  input: ApproveFinopsPriceSnapshotRequest,
): Promise<FinopsPriceSnapshot> {
  return request(`/admin/finops/price-snapshots/${id}/review`, {
    method: 'POST',
    schema: finopsPriceSnapshotSchema,
    body: approveFinopsPriceSnapshotRequestSchema.parse(input),
  });
}

export function recordFinopsCost(input: RecordFinopsCostRequest): Promise<FinopsCostEntry> {
  return request('/admin/finops/cost-entries', {
    method: 'POST',
    schema: finopsCostEntrySchema,
    body: recordFinopsCostRequestSchema.parse(input),
  });
}

export function reviewFinopsCost(
  id: string,
  input: ReviewFinopsCostRequest,
): Promise<FinopsCostVerificationReview> {
  return request(`/admin/finops/cost-entries/${id}/review`, {
    method: 'POST',
    schema: finopsCostVerificationReviewSchema,
    body: reviewFinopsCostRequestSchema.parse(input),
  });
}

export function createFinopsBudget(input: CreateFinopsBudgetRequest): Promise<FinopsBudget> {
  return request('/admin/finops/budgets', {
    method: 'POST',
    schema: finopsBudgetSchema,
    body: createFinopsBudgetRequestSchema.parse(input),
  });
}

export function reviewFinopsAllocationSet(
  id: string,
  input: ReviewFinopsAllocationSetRequest,
): Promise<FinopsAllocationSet> {
  return request(`/admin/finops/allocation-sets/${id}/review`, {
    method: 'POST',
    schema: finopsAllocationSetSchema,
    body: reviewFinopsAllocationSetRequestSchema.parse(input),
  });
}

export function reviewFinopsBenefitClaim(
  id: string,
  input: ReviewFinopsBenefitClaimRequest,
): Promise<FinopsBenefitClaim> {
  return request(`/admin/finops/benefit-claims/${id}/review`, {
    method: 'POST',
    schema: finopsBenefitClaimSchema,
    body: reviewFinopsBenefitClaimRequestSchema.parse(input),
  });
}

export function reviewFinopsBudget(
  id: string,
  input: ApproveFinopsBudgetRequest,
): Promise<FinopsBudget> {
  return request(`/admin/finops/budgets/${id}/review`, {
    method: 'POST',
    schema: finopsBudgetSchema,
    body: approveFinopsBudgetRequestSchema.parse(input),
  });
}

export function createFinopsBudgetEvent(
  id: string,
  input: CreateFinopsBudgetEventRequest,
): Promise<FinopsBudgetEvent> {
  return request(`/admin/finops/budgets/${id}/events`, {
    method: 'POST',
    schema: finopsBudgetEventSchema,
    body: createFinopsBudgetEventRequestSchema.parse(input),
  });
}

export function reviewFinopsRoiFormula(
  id: string,
  input: ApproveFinopsRoiFormulaVersionRequest,
): Promise<FinopsRoiFormulaVersion> {
  return request(`/admin/finops/roi-formulas/${id}/review`, {
    method: 'POST',
    schema: finopsRoiFormulaVersionSchema,
    body: approveFinopsRoiFormulaVersionRequestSchema.parse(input),
  });
}

export function recomputeFinopsRoi(input: RecomputeFinopsRoiRequest): Promise<FinopsRoiSnapshot> {
  return request('/admin/finops/roi/recompute', {
    method: 'POST',
    schema: finopsRoiSnapshotSchema,
    body: recomputeFinopsRoiRequestSchema.parse(input),
  });
}

export function acknowledgeFinopsAlert(
  id: string,
  input: AcknowledgeFinopsAlertRequest,
): Promise<FinopsBudgetAlert> {
  return request(`/admin/finops/alerts/${id}/acknowledge`, {
    method: 'POST',
    schema: finopsBudgetAlertSchema,
    body: acknowledgeFinopsAlertRequestSchema.parse(input),
  });
}

export function decideFinopsRoutingSuggestion(
  id: string,
  input: DecideFinopsRoutingSuggestionRequest,
): Promise<FinopsRoutingSuggestion> {
  return request(`/admin/finops/routing-suggestions/${id}/decide`, {
    method: 'POST',
    schema: finopsRoutingSuggestionSchema,
    body: decideFinopsRoutingSuggestionRequestSchema.parse(input),
  });
}
