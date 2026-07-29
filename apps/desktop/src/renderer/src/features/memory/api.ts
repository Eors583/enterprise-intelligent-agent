import {
  createMemoryCandidateRequestSchema,
  memoryRecordSchema,
  memoryTransitionRequestSchema,
  type CreateMemoryCandidateRequest,
  type MemoryListResponse,
  type MemoryRecord,
  type MemoryScope,
  type MemoryTransitionRequest,
} from '@enterprise/contracts';
import { z } from 'zod';

import { ApiClientError, apiRequest } from '../../shared/api/client';

const memoryListResponseSchema = z
  .object({
    items: z.array(memoryRecordSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const memoryApiPaths = {
  list: '/api/v1/workbench/memories',
  detail: (memoryId: string) => `/api/v1/workbench/memories/${encodeURIComponent(memoryId)}`,
  transitions: (memoryId: string) =>
    `/api/v1/workbench/memories/${encodeURIComponent(memoryId)}/transitions`,
} as const;

export async function listMemories(
  input: {
    readonly scope?: MemoryScope;
    readonly purpose?: string;
    readonly limit?: number;
    readonly cursor?: string;
  } = {},
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<MemoryListResponse> {
  const search = new URLSearchParams({ limit: String(input.limit ?? 100) });
  if (input.scope) search.set('scope', input.scope);
  if (input.purpose?.trim()) search.set('purpose', input.purpose.trim());
  if (input.cursor) search.set('cursor', input.cursor);
  const response = await apiRequest(`${memoryApiPaths.list}?${search.toString()}`, {
    schema: memoryListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (input.scope && response.items.some((memory) => memory.scope !== input.scope)) {
    throw new ApiClientError('contract', '记忆列表包含请求范围之外的记录，客户端已拒绝展示。');
  }
  return response;
}

export function getMemory(
  memoryId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<MemoryRecord> {
  return apiRequest(memoryApiPaths.detail(memoryId), {
    schema: memoryRecordSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export function createMemoryCandidate(
  input: CreateMemoryCandidateRequest,
  apiBaseUrl?: string,
): Promise<MemoryRecord> {
  return apiRequest(memoryApiPaths.list, {
    method: 'POST',
    body: createMemoryCandidateRequestSchema.parse(input),
    schema: memoryRecordSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function transitionMemory(
  memoryId: string,
  input: MemoryTransitionRequest,
  apiBaseUrl?: string,
): Promise<MemoryRecord> {
  const response = await apiRequest(memoryApiPaths.transitions(memoryId), {
    method: 'POST',
    body: memoryTransitionRequestSchema.parse(input),
    schema: memoryRecordSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (response.id !== memoryId || response.revision <= input.expectedRevision) {
    throw new ApiClientError(
      'contract',
      '记忆状态响应未确认目标身份或新 revision，客户端已拒绝显示成功。',
    );
  }
  return response;
}
