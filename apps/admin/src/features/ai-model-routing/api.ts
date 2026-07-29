import {
  aiModelCatalogVersionSchema,
  aiModelConnectivityProbeResultSchema,
  aiModelRoutePolicyVersionSchema,
  aiModelRoutingDashboardSchema,
  createAiModelCatalogVersionRequestSchema,
  createAiModelConnectivityProbeRequestSchema,
  createAiModelRoutePolicyVersionRequestSchema,
  transitionAiGovernanceVersionRequestSchema,
  type AiModelCatalogVersion,
  type AiModelConnectivityProbeResult,
  type AiModelRoutePolicyVersion,
  type AiModelRoutingDashboard,
  type CreateAiModelCatalogVersionRequest,
  type CreateAiModelConnectivityProbeRequest,
  type CreateAiModelRoutePolicyVersionRequest,
  type TransitionAiGovernanceVersionRequest,
} from '@enterprise/contracts';

import { request } from '@/api/client';

export function loadAiModelRoutingDashboard(
  signal?: AbortSignal,
): Promise<AiModelRoutingDashboard> {
  return request('/admin/ai-model-routing', {
    schema: aiModelRoutingDashboardSchema,
    ...(signal ? { signal } : {}),
  });
}

export function runAiModelConnectivityProbe(
  input: CreateAiModelConnectivityProbeRequest,
): Promise<AiModelConnectivityProbeResult> {
  return request('/admin/ai-model-routing/connectivity-probes', {
    method: 'POST',
    schema: aiModelConnectivityProbeResultSchema,
    body: createAiModelConnectivityProbeRequestSchema.parse(input),
  });
}

export function createAiModelCatalogVersion(
  input: CreateAiModelCatalogVersionRequest,
): Promise<AiModelCatalogVersion> {
  return request('/admin/ai-model-routing/catalog-versions', {
    method: 'POST',
    schema: aiModelCatalogVersionSchema,
    body: createAiModelCatalogVersionRequestSchema.parse(input),
  });
}

export function transitionAiModelCatalogVersion(
  id: string,
  input: TransitionAiGovernanceVersionRequest,
): Promise<AiModelCatalogVersion> {
  return request(`/admin/ai-model-routing/catalog-versions/${id}/transitions`, {
    method: 'POST',
    schema: aiModelCatalogVersionSchema,
    body: transitionAiGovernanceVersionRequestSchema.parse(input),
  });
}

export function createAiModelRoutePolicyVersion(
  input: CreateAiModelRoutePolicyVersionRequest,
): Promise<AiModelRoutePolicyVersion> {
  return request('/admin/ai-model-routing/route-policy-versions', {
    method: 'POST',
    schema: aiModelRoutePolicyVersionSchema,
    body: createAiModelRoutePolicyVersionRequestSchema.parse(input),
  });
}

export function transitionAiModelRoutePolicyVersion(
  id: string,
  input: TransitionAiGovernanceVersionRequest,
): Promise<AiModelRoutePolicyVersion> {
  return request(`/admin/ai-model-routing/route-policy-versions/${id}/transitions`, {
    method: 'POST',
    schema: aiModelRoutePolicyVersionSchema,
    body: transitionAiGovernanceVersionRequestSchema.parse(input),
  });
}
