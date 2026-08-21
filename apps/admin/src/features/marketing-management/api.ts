import {
  createMarketingActionItemRequestSchema,
  createMarketingActionPlanRequestSchema,
  createMarketingInsightRequestSchema,
  createMarketingMasterDataRequestSchema,
  createMarketingObservationRequestSchema,
  createMarketingTargetRequestSchema,
  marketingActionItemSchema,
  marketingActionPlanSchema,
  marketingInsightSchema,
  marketingListResponseSchema,
  marketingMasterDataSchema,
  marketingObservationSchema,
  marketingTargetSchema,
  transitionMarketingActionItemRequestSchema,
  transitionMarketingActionPlanRequestSchema,
  transitionMarketingInsightRequestSchema,
  transitionMarketingTargetRequestSchema,
  type CreateMarketingActionItemRequest,
  type CreateMarketingActionPlanRequest,
  type CreateMarketingInsightRequest,
  type CreateMarketingMasterDataRequest,
  type CreateMarketingObservationRequest,
  type CreateMarketingTargetRequest,
  type MarketingActionItem,
  type MarketingActionPlan,
  type MarketingInsight,
  type MarketingMasterData,
  type MarketingObservation,
  type MarketingTarget,
  type TransitionMarketingActionItemRequest,
  type TransitionMarketingActionPlanRequest,
  type TransitionMarketingInsightRequest,
  type TransitionMarketingTargetRequest,
} from '@enterprise/contracts';

import { request } from '@/api/client';

export type MarketingMasterPath = 'products' | 'regions' | 'customer-segments';

export async function listMarketingObservations(
  signal?: AbortSignal,
): Promise<MarketingObservation[]> {
  return (
    await request('/admin/marketing/observations', {
      schema: marketingListResponseSchema(marketingObservationSchema),
      ...(signal ? { signal } : {}),
    })
  ).items;
}

export function createMarketingObservation(
  input: CreateMarketingObservationRequest,
): Promise<MarketingObservation> {
  return request('/admin/marketing/observations', {
    method: 'POST',
    schema: marketingObservationSchema,
    body: createMarketingObservationRequestSchema.parse(input),
  });
}

export async function listMarketingInsights(signal?: AbortSignal): Promise<MarketingInsight[]> {
  return (
    await request('/admin/marketing/insights', {
      schema: marketingListResponseSchema(marketingInsightSchema),
      ...(signal ? { signal } : {}),
    })
  ).items;
}

export function createMarketingInsight(
  input: CreateMarketingInsightRequest,
): Promise<MarketingInsight> {
  return request('/admin/marketing/insights', {
    method: 'POST',
    schema: marketingInsightSchema,
    body: createMarketingInsightRequestSchema.parse(input),
  });
}

export function transitionMarketingInsight(
  id: string,
  input: TransitionMarketingInsightRequest,
): Promise<MarketingInsight> {
  return request(`/admin/marketing/insights/${id}/transition`, {
    method: 'POST',
    schema: marketingInsightSchema,
    body: transitionMarketingInsightRequestSchema.parse(input),
  });
}

export async function listMarketingMasterData(
  path: MarketingMasterPath,
  signal?: AbortSignal,
): Promise<MarketingMasterData[]> {
  return (
    await request(`/admin/marketing/${path}`, {
      schema: marketingListResponseSchema(marketingMasterDataSchema),
      ...(signal ? { signal } : {}),
    })
  ).items;
}

export function createMarketingMasterData(
  path: MarketingMasterPath,
  input: CreateMarketingMasterDataRequest,
): Promise<MarketingMasterData> {
  return request(`/admin/marketing/${path}`, {
    method: 'POST',
    schema: marketingMasterDataSchema,
    body: createMarketingMasterDataRequestSchema.parse(input),
  });
}

export async function listMarketingTargets(signal?: AbortSignal): Promise<MarketingTarget[]> {
  return (
    await request('/admin/marketing/targets', {
      schema: marketingListResponseSchema(marketingTargetSchema),
      ...(signal ? { signal } : {}),
    })
  ).items;
}

export function createMarketingTarget(
  input: CreateMarketingTargetRequest,
): Promise<MarketingTarget> {
  return request('/admin/marketing/targets', {
    method: 'POST',
    schema: marketingTargetSchema,
    body: createMarketingTargetRequestSchema.parse(input),
  });
}

export function transitionMarketingTarget(
  id: string,
  input: TransitionMarketingTargetRequest,
): Promise<MarketingTarget> {
  return request(`/admin/marketing/targets/${id}/transition`, {
    method: 'POST',
    schema: marketingTargetSchema,
    body: transitionMarketingTargetRequestSchema.parse(input),
  });
}

export async function listMarketingActionPlans(
  signal?: AbortSignal,
): Promise<MarketingActionPlan[]> {
  return (
    await request('/admin/marketing/action-plans', {
      schema: marketingListResponseSchema(marketingActionPlanSchema),
      ...(signal ? { signal } : {}),
    })
  ).items;
}

export function createMarketingActionPlan(
  input: CreateMarketingActionPlanRequest,
): Promise<MarketingActionPlan> {
  return request('/admin/marketing/action-plans', {
    method: 'POST',
    schema: marketingActionPlanSchema,
    body: createMarketingActionPlanRequestSchema.parse(input),
  });
}

export function transitionMarketingActionPlan(
  id: string,
  input: TransitionMarketingActionPlanRequest,
): Promise<MarketingActionPlan> {
  return request(`/admin/marketing/action-plans/${id}/transition`, {
    method: 'POST',
    schema: marketingActionPlanSchema,
    body: transitionMarketingActionPlanRequestSchema.parse(input),
  });
}

export function createMarketingActionItem(
  planId: string,
  input: CreateMarketingActionItemRequest,
): Promise<MarketingActionItem> {
  return request(`/admin/marketing/action-plans/${planId}/items`, {
    method: 'POST',
    schema: marketingActionItemSchema,
    body: createMarketingActionItemRequestSchema.parse(input),
  });
}

export function transitionMarketingActionItem(
  id: string,
  input: TransitionMarketingActionItemRequest,
): Promise<MarketingActionItem> {
  return request(`/admin/marketing/action-items/${id}/transition`, {
    method: 'POST',
    schema: marketingActionItemSchema,
    body: transitionMarketingActionItemRequestSchema.parse(input),
  });
}
