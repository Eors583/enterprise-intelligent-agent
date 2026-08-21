import {
  employeeAiUsageSummarySchema,
  employeeCreateExperienceRequestSchema,
  employeeExperienceCandidateSchema,
  employeeExperienceListResponseSchema,
  employeeExperienceSourceSchema,
  type EmployeeAiUsageSummary,
  type EmployeeCreateExperienceRequest,
  type EmployeeExperienceCandidate,
  type EmployeeExperienceListResponse,
  type ExperienceStatus,
} from '@enterprise/contracts';

import { apiRequest } from '../../shared/api/client';

export const experienceUsageApiPaths = {
  experiences: '/api/v1/workbench/experiences',
  sources: (taskId: string) =>
    `/api/v1/workbench/experience-sources?taskId=${encodeURIComponent(taskId)}`,
  aiUsage: '/api/v1/workbench/ai-usage',
} as const;

export async function listEmployeeExperiences(
  input: {
    readonly status?: ExperienceStatus;
    readonly cursor?: string;
    readonly limit?: number;
  } = {},
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<EmployeeExperienceListResponse> {
  const search = new URLSearchParams({ limit: String(input.limit ?? 25) });
  if (input.status) search.set('status', input.status);
  if (input.cursor) search.set('cursor', input.cursor);
  return apiRequest(`${experienceUsageApiPaths.experiences}?${search.toString()}`, {
    schema: employeeExperienceListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function getEmployeeExperienceSources(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
) {
  return apiRequest(experienceUsageApiPaths.sources(taskId), {
    schema: employeeExperienceSourceSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function createEmployeeExperience(
  input: EmployeeCreateExperienceRequest,
  apiBaseUrl?: string,
): Promise<EmployeeExperienceCandidate> {
  return apiRequest(experienceUsageApiPaths.experiences, {
    method: 'POST',
    body: employeeCreateExperienceRequestSchema.parse(input),
    schema: employeeExperienceCandidateSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function getEmployeeAiUsage(
  input: {
    readonly from?: string;
    readonly to?: string;
    readonly groupLimit?: number;
  } = {},
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<EmployeeAiUsageSummary> {
  const search = new URLSearchParams({ groupLimit: String(input.groupLimit ?? 25) });
  if (input.from) search.set('from', input.from);
  if (input.to) search.set('to', input.to);
  return apiRequest(`${experienceUsageApiPaths.aiUsage}?${search.toString()}`, {
    schema: employeeAiUsageSummarySchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}
