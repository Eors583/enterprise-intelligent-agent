import type {
  CreateToolCompensationRequest,
  CreateToolInvocationRequest,
  ToolInvocation,
  ToolInvocationDecisionRequest,
} from '@enterprise/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createTaskToolCompensation,
  createTaskToolInvocation,
  decideTaskToolInvocation,
  getToolReconciliationStatus,
  listAvailableTaskTools,
  listTaskToolApprovals,
  listTaskToolInvocations,
} from './api';

export const availableTaskToolsQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'tools'] as const;
export const taskToolInvocationsQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'tool-invocations'] as const;
export const taskToolApprovalsQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'tool-approvals'] as const;
export const toolReconciliationQueryKey = (invocationId: string) =>
  ['workbench', 'tool-invocations', invocationId, 'reconciliation'] as const;

export function useAvailableTaskTools(taskId: string, enabled = true) {
  return useQuery({
    queryKey: availableTaskToolsQueryKey(taskId),
    queryFn: ({ signal }) => listAvailableTaskTools(taskId, signal),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export function useTaskToolInvocations(taskId: string, enabled = true) {
  return useQuery({
    queryKey: taskToolInvocationsQueryKey(taskId),
    queryFn: ({ signal }) => listTaskToolInvocations(taskId, signal),
    enabled,
    staleTime: 5_000,
    retry: false,
  });
}

export function useTaskToolApprovals(taskId: string, enabled = true) {
  return useQuery({
    queryKey: taskToolApprovalsQueryKey(taskId),
    queryFn: ({ signal }) => listTaskToolApprovals(taskId, signal),
    enabled,
    staleTime: 5_000,
    retry: false,
  });
}

export function useToolReconciliationStatus(invocationId: string, enabled = true) {
  return useQuery({
    queryKey: toolReconciliationQueryKey(invocationId),
    queryFn: ({ signal }) => getToolReconciliationStatus(invocationId, signal),
    enabled,
    staleTime: 1_000,
    refetchInterval: enabled ? 2_500 : false,
    retry: false,
  });
}

export function useCreateTaskToolInvocation(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateToolInvocationRequest) => createTaskToolInvocation(request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskToolInvocationsQueryKey(taskId) });
    },
  });
}

export function useCreateTaskToolCompensation(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      original,
      request,
    }: {
      readonly original: Pick<ToolInvocation, 'id' | 'taskId'>;
      readonly request: CreateToolCompensationRequest;
    }) => createTaskToolCompensation(original, request),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: taskToolInvocationsQueryKey(taskId) }),
        queryClient.invalidateQueries({ queryKey: taskToolApprovalsQueryKey(taskId) }),
      ]);
    },
  });
}

export function useDecideTaskToolInvocation(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      invocation,
      request,
    }: {
      readonly invocation: Pick<ToolInvocation, 'id' | 'revision'>;
      readonly request: ToolInvocationDecisionRequest;
    }) => decideTaskToolInvocation(taskId, invocation, request),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: taskToolInvocationsQueryKey(taskId) }),
        queryClient.invalidateQueries({ queryKey: taskToolApprovalsQueryKey(taskId) }),
      ]);
    },
  });
}
