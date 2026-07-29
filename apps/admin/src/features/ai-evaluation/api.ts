import {
  aiEvaluationBadCaseListResponseSchema,
  aiEvaluationBadCaseSchema,
  aiEvaluationCaseListResponseSchema,
  aiEvaluationCaseSchema,
  aiEvaluationDatasetListResponseSchema,
  aiEvaluationDatasetSchema,
  aiEvaluationDatasetVersionListResponseSchema,
  aiEvaluationDatasetVersionSchema,
  aiEvaluationListQuerySchema,
  aiEvaluationReadinessQuerySchema,
  aiEvaluationReadinessSchema,
  aiEvaluationRunListQuerySchema,
  aiEvaluationRunListResponseSchema,
  aiEvaluationRunnerListResponseSchema,
  aiEvaluationRunnerSchema,
  aiEvaluationRunSchema,
  annotateAiEvaluationCaseRequestSchema,
  createAiEvaluationCaseRequestSchema,
  createAiEvaluationDatasetRequestSchema,
  createAiEvaluationDatasetVersionRequestSchema,
  createAiEvaluationRunnerRequestSchema,
  createAiEvaluationRunRequestSchema,
  ingestAiEvaluationBadCaseRequestSchema,
  startAiEvaluationRunRequestSchema,
  submitAiEvaluationRunRequestSchema,
  transitionAiEvaluationDatasetVersionRequestSchema,
  triageAiEvaluationBadCaseRequestSchema,
  verifyAiEvaluationRunRequestSchema,
  type AiEvaluationBadCase,
  type AiEvaluationBadCaseListResponse,
  type AiEvaluationCase,
  type AiEvaluationCaseListResponse,
  type AiEvaluationDataset,
  type AiEvaluationDatasetListResponse,
  type AiEvaluationDatasetVersion,
  type AiEvaluationDatasetVersionListResponse,
  type AiEvaluationListQuery,
  type AiEvaluationReadiness,
  type AiEvaluationReadinessQuery,
  type AiEvaluationRun,
  type AiEvaluationRunListQuery,
  type AiEvaluationRunListResponse,
  type AiEvaluationRunner,
  type AiEvaluationRunnerListResponse,
  type AnnotateAiEvaluationCaseRequest,
  type CreateAiEvaluationCaseRequest,
  type CreateAiEvaluationDatasetRequest,
  type CreateAiEvaluationDatasetVersionRequest,
  type CreateAiEvaluationRunnerRequest,
  type CreateAiEvaluationRunRequest,
  type IngestAiEvaluationBadCaseRequest,
  type StartAiEvaluationRunRequest,
  type SubmitAiEvaluationRunRequest,
  type TransitionAiEvaluationDatasetVersionRequest,
  type TriageAiEvaluationBadCaseRequest,
  type VerifyAiEvaluationRunRequest,
} from '@enterprise/contracts';
import { z } from 'zod';

import { request } from '@/api/client';

const acceptedSchema = z.object({ accepted: z.literal(true) }).strict();
const mutationReceiptSchema = z
  .object({
    id: z.uuid(),
    status: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

function queryString(input: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export function listEvaluationDatasets(
  input: AiEvaluationListQuery = { limit: 100 },
  signal?: AbortSignal,
): Promise<AiEvaluationDatasetListResponse> {
  const query = aiEvaluationListQuerySchema.parse(input);
  return request(`/admin/ai-evaluations/datasets?${queryString(query)}`, {
    schema: aiEvaluationDatasetListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function listEvaluationDatasetVersions(
  datasetId: string,
  input: AiEvaluationListQuery = { limit: 100 },
  signal?: AbortSignal,
): Promise<AiEvaluationDatasetVersionListResponse> {
  const query = aiEvaluationListQuerySchema.parse(input);
  return request(`/admin/ai-evaluations/datasets/${datasetId}/versions?${queryString(query)}`, {
    schema: aiEvaluationDatasetVersionListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function listEvaluationCases(
  versionId: string,
  input: AiEvaluationListQuery = { limit: 200 },
  signal?: AbortSignal,
): Promise<AiEvaluationCaseListResponse> {
  const query = aiEvaluationListQuerySchema.parse(input);
  return request(
    `/admin/ai-evaluations/dataset-versions/${versionId}/cases?${queryString(query)}`,
    {
      schema: aiEvaluationCaseListResponseSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export function listEvaluationRunners(
  input: AiEvaluationListQuery = { limit: 100 },
  signal?: AbortSignal,
): Promise<AiEvaluationRunnerListResponse> {
  const query = aiEvaluationListQuerySchema.parse(input);
  return request(`/admin/ai-evaluations/runners?${queryString(query)}`, {
    schema: aiEvaluationRunnerListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function listEvaluationRuns(
  input: AiEvaluationRunListQuery = { limit: 100 },
  signal?: AbortSignal,
): Promise<AiEvaluationRunListResponse> {
  const query = aiEvaluationRunListQuerySchema.parse(input);
  return request(`/admin/ai-evaluations/runs?${queryString(query)}`, {
    schema: aiEvaluationRunListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function listEvaluationBadCases(
  input: AiEvaluationListQuery = { limit: 100 },
  signal?: AbortSignal,
): Promise<AiEvaluationBadCaseListResponse> {
  const query = aiEvaluationListQuerySchema.parse(input);
  return request(`/admin/ai-evaluations/bad-cases?${queryString(query)}`, {
    schema: aiEvaluationBadCaseListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createEvaluationDataset(
  input: CreateAiEvaluationDatasetRequest,
): Promise<AiEvaluationDataset> {
  return request('/admin/ai-evaluations/datasets', {
    method: 'POST',
    schema: aiEvaluationDatasetSchema,
    body: createAiEvaluationDatasetRequestSchema.parse(input),
  });
}

export function createEvaluationDatasetVersion(
  datasetId: string,
  input: CreateAiEvaluationDatasetVersionRequest,
): Promise<AiEvaluationDatasetVersion> {
  return request(`/admin/ai-evaluations/datasets/${datasetId}/versions`, {
    method: 'POST',
    schema: aiEvaluationDatasetVersionSchema,
    body: createAiEvaluationDatasetVersionRequestSchema.parse(input),
  });
}

export function transitionEvaluationDatasetVersion(
  versionId: string,
  input: TransitionAiEvaluationDatasetVersionRequest,
): Promise<AiEvaluationDatasetVersion> {
  return request(`/admin/ai-evaluations/dataset-versions/${versionId}/transitions`, {
    method: 'POST',
    schema: aiEvaluationDatasetVersionSchema,
    body: transitionAiEvaluationDatasetVersionRequestSchema.parse(input),
  });
}

export function createEvaluationCase(
  versionId: string,
  input: CreateAiEvaluationCaseRequest,
): Promise<AiEvaluationCase> {
  return request(`/admin/ai-evaluations/dataset-versions/${versionId}/cases`, {
    method: 'POST',
    schema: aiEvaluationCaseSchema,
    body: createAiEvaluationCaseRequestSchema.parse(input),
  });
}

export function annotateEvaluationCase(
  caseId: string,
  input: AnnotateAiEvaluationCaseRequest,
): Promise<{ accepted: true }> {
  return request(`/admin/ai-evaluations/cases/${caseId}/annotations`, {
    method: 'POST',
    schema: acceptedSchema,
    body: annotateAiEvaluationCaseRequestSchema.parse(input),
  });
}

export function createEvaluationRunner(
  input: CreateAiEvaluationRunnerRequest,
): Promise<AiEvaluationRunner> {
  return request('/admin/ai-evaluations/runners', {
    method: 'POST',
    schema: aiEvaluationRunnerSchema,
    body: createAiEvaluationRunnerRequestSchema.parse(input),
  });
}

export function createEvaluationRun(input: CreateAiEvaluationRunRequest): Promise<AiEvaluationRun> {
  return request('/admin/ai-evaluations/runs', {
    method: 'POST',
    schema: aiEvaluationRunSchema,
    body: createAiEvaluationRunRequestSchema.parse(input),
  });
}

export function startEvaluationRun(
  runId: string,
  input: StartAiEvaluationRunRequest,
): Promise<AiEvaluationRun> {
  return request(`/admin/ai-evaluations/runs/${runId}/start`, {
    method: 'POST',
    schema: aiEvaluationRunSchema,
    body: startAiEvaluationRunRequestSchema.parse(input),
  });
}

export function submitEvaluationRun(
  runId: string,
  input: SubmitAiEvaluationRunRequest,
): Promise<AiEvaluationRun> {
  return request(`/admin/ai-evaluations/runs/${runId}/results`, {
    method: 'POST',
    schema: aiEvaluationRunSchema,
    body: submitAiEvaluationRunRequestSchema.parse(input),
  });
}

export function verifyEvaluationRun(
  runId: string,
  input: VerifyAiEvaluationRunRequest,
): Promise<AiEvaluationRun> {
  return request(`/admin/ai-evaluations/runs/${runId}/verify`, {
    method: 'POST',
    schema: aiEvaluationRunSchema,
    body: verifyAiEvaluationRunRequestSchema.parse(input),
  });
}

export function ingestEvaluationBadCase(
  input: IngestAiEvaluationBadCaseRequest,
): Promise<{ id: string; status: string; revision: number }> {
  return request('/admin/ai-evaluations/bad-cases', {
    method: 'POST',
    schema: mutationReceiptSchema,
    body: ingestAiEvaluationBadCaseRequestSchema.parse(input),
  });
}

export function triageEvaluationBadCase(
  badCaseId: string,
  input: TriageAiEvaluationBadCaseRequest,
): Promise<{ id: string; status: string; revision: number }> {
  return request(`/admin/ai-evaluations/bad-cases/${badCaseId}/triage`, {
    method: 'POST',
    schema: mutationReceiptSchema,
    body: triageAiEvaluationBadCaseRequestSchema.parse(input),
  });
}

export function loadEvaluationReadiness(
  input: AiEvaluationReadinessQuery,
  signal?: AbortSignal,
): Promise<AiEvaluationReadiness> {
  const query = aiEvaluationReadinessQuerySchema.parse(input);
  return request(`/admin/ai-evaluations/readiness?${queryString(query)}`, {
    schema: aiEvaluationReadinessSchema,
    ...(signal ? { signal } : {}),
  });
}
