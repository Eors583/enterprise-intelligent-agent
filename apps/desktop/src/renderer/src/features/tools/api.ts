import {
  availableToolListResponseSchema,
  createToolCompensationRequestSchema,
  createToolInvocationRequestSchema,
  toolInvocationDecisionRequestSchema,
  toolInvocationListResponseSchema,
  toolInvocationSchema,
  toolReconciliationStatusSchema,
  type AvailableTool,
  type CreateToolCompensationRequest,
  type CreateToolInvocationRequest,
  type ToolInvocation,
  type ToolInvocationDecisionRequest,
  type ToolReconciliationStatus,
} from '@enterprise/contracts';

import { ApiClientError, apiRequest } from '../../shared/api/client';

export const toolApiPaths = {
  available: (taskId: string) => `/api/v1/workbench/tools?taskId=${encodeURIComponent(taskId)}`,
  approvals: (taskId: string) =>
    `/api/v1/workbench/tool-approvals?taskId=${encodeURIComponent(taskId)}`,
  invocations: '/api/v1/workbench/tool-invocations',
  actions: (invocationId: string) =>
    `/api/v1/workbench/tool-invocations/${encodeURIComponent(invocationId)}/actions`,
  compensations: (invocationId: string) =>
    `/api/v1/workbench/tool-invocations/${encodeURIComponent(invocationId)}/compensations`,
  reconciliation: (invocationId: string) =>
    `/api/v1/workbench/tool-invocations/${encodeURIComponent(invocationId)}/reconciliation`,
} as const;

export async function getToolReconciliationStatus(
  invocationId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<ToolReconciliationStatus> {
  return apiRequest(toolApiPaths.reconciliation(invocationId), {
    schema: toolReconciliationStatusSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

export async function listAvailableTaskTools(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<readonly AvailableTool[]> {
  const response = await apiRequest(toolApiPaths.available(taskId), {
    schema: availableToolListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  return response.items;
}

export async function listTaskToolInvocations(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<readonly ToolInvocation[]> {
  const response = await apiRequest(toolApiPaths.invocations, {
    schema: toolInvocationListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  return response.items.filter((invocation) => invocation.taskId === taskId);
}

export async function listTaskToolApprovals(
  taskId: string,
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<readonly ToolInvocation[]> {
  const response = await apiRequest(toolApiPaths.approvals(taskId), {
    schema: toolInvocationListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (
    response.items.some(
      (invocation) => invocation.taskId !== taskId || invocation.status !== 'PENDING_APPROVAL',
    )
  ) {
    throw new ApiClientError(
      'contract',
      '审批队列包含当前任务之外或非待审批状态的调用，已拒绝展示。',
    );
  }
  return response.items;
}

export async function createTaskToolInvocation(
  request: CreateToolInvocationRequest,
  apiBaseUrl?: string,
): Promise<ToolInvocation> {
  const parsed = createToolInvocationRequestSchema.parse(request);
  const response = await apiRequest(toolApiPaths.invocations, {
    method: 'POST',
    body: parsed,
    schema: toolInvocationSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (
    response.taskId !== parsed.taskId ||
    response.toolVersionId !== parsed.toolVersionId ||
    response.correlationId !== parsed.correlationId
  ) {
    throw new ApiClientError(
      'contract',
      '工具调用响应与当前任务、工具版本或关联标识不一致，已拒绝展示成功。',
    );
  }
  return response;
}

export async function createTaskToolCompensation(
  original: Pick<ToolInvocation, 'id' | 'taskId'>,
  request: CreateToolCompensationRequest,
  apiBaseUrl?: string,
): Promise<ToolInvocation> {
  const parsed = createToolCompensationRequestSchema.parse(request);
  const response = await apiRequest(toolApiPaths.compensations(original.id), {
    method: 'POST',
    body: parsed,
    schema: toolInvocationSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  if (
    response.id === original.id ||
    response.taskId !== original.taskId ||
    response.compensationForInvocationId !== original.id
  ) {
    throw new ApiClientError('contract', '补偿响应未绑定当前任务与原调用，已拒绝展示为成功。');
  }
  return response;
}

export async function decideTaskToolInvocation(
  taskId: string,
  invocation: Pick<ToolInvocation, 'id' | 'revision'>,
  request: ToolInvocationDecisionRequest,
  apiBaseUrl?: string,
): Promise<ToolInvocation> {
  const parsed = toolInvocationDecisionRequestSchema.parse(request);
  const response = await apiRequest(toolApiPaths.actions(invocation.id), {
    method: 'POST',
    body: parsed,
    schema: toolInvocationSchema,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  const retryIsLinked =
    parsed.action === 'RETRY' &&
    response.id !== invocation.id &&
    response.retryOfInvocationId === invocation.id;
  const sameInvocation = response.id === invocation.id;
  if (
    response.taskId !== taskId ||
    (!sameInvocation && !retryIsLinked) ||
    (parsed.action !== 'RECONCILE' &&
      parsed.action !== 'RETRY' &&
      response.revision <= invocation.revision)
  ) {
    throw new ApiClientError(
      'contract',
      '工具动作响应未确认目标调用、任务或新 revision，已拒绝展示成功。',
    );
  }
  return response;
}
