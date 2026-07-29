import type {
  CollaborationCommandRequest,
  CorrectionFeedbackRequest,
  CreateCollaborationRequest,
  EmployeeAcceptanceRequestInput,
  EmployeeDeliverableSubmissionRequest,
  EmployeeEvidenceContributionRequest,
  EmployeeTaskTransitionRequest,
} from '@enterprise/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createTaskCollaboration,
  getTaskCollaborationDetail,
  getEmployeeTaskExecution,
  getWorkbenchTaskTrace,
  contributeEmployeeEvidence,
  listTaskCollaborations,
  listTaskCollaborationCandidates,
  listTaskCorrections,
  listWorkbenchObjectives,
  listWorkbenchTasks,
  requestEmployeeAcceptance,
  submitEmployeeDeliverable,
  submitTaskCollaborationCommand,
  submitTaskCorrectionFeedback,
  transitionEmployeeTask,
} from './api';

export const workbenchObjectivesQueryKey = ['workbench', 'objectives'] as const;
export const workbenchTasksQueryKey = ['workbench', 'tasks'] as const;

export function useWorkbenchObjectives(enabled = true) {
  return useQuery({
    queryKey: workbenchObjectivesQueryKey,
    queryFn: ({ signal }) => listWorkbenchObjectives(signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useWorkbenchTasks(enabled = true) {
  return useQuery({
    queryKey: workbenchTasksQueryKey,
    queryFn: ({ signal }) => listWorkbenchTasks(signal),
    enabled,
    staleTime: 15_000,
  });
}

export function useWorkbenchTaskTrace(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['workbench', 'tasks', taskId, 'trace'],
    queryFn: ({ signal }) => getWorkbenchTaskTrace(taskId!, signal),
    enabled: enabled && taskId !== null,
    staleTime: 15_000,
  });
}

export const taskCollaborationQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'collaborations'] as const;
export const taskCollaborationCandidatesQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'collaboration-candidates'] as const;
export const taskCollaborationDetailQueryKey = (taskId: string, collaborationId: string) =>
  ['workbench', 'tasks', taskId, 'collaborations', collaborationId] as const;
export const taskCorrectionQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'corrections'] as const;
export const employeeTaskExecutionQueryKey = (taskId: string) =>
  ['workbench', 'tasks', taskId, 'execution'] as const;

export function useTaskCollaborations(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: taskCollaborationQueryKey(taskId ?? 'none'),
    queryFn: ({ signal }) => listTaskCollaborations(taskId!, signal),
    enabled: enabled && taskId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useTaskCollaborationCandidates(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: taskCollaborationCandidatesQueryKey(taskId ?? 'none'),
    queryFn: ({ signal }) => listTaskCollaborationCandidates(taskId!, signal),
    enabled: enabled && taskId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useTaskCollaborationDetail(
  taskId: string | null,
  collaborationId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: taskCollaborationDetailQueryKey(taskId ?? 'none', collaborationId ?? 'none'),
    queryFn: ({ signal }) => getTaskCollaborationDetail(taskId!, collaborationId!, signal),
    enabled: enabled && taskId !== null && collaborationId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useTaskCorrections(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: taskCorrectionQueryKey(taskId ?? 'none'),
    queryFn: ({ signal }) => listTaskCorrections(taskId!, signal),
    enabled: enabled && taskId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useCreateTaskCollaboration(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCollaborationRequest) => createTaskCollaboration(taskId, input),
    onSuccess: async (response) => {
      queryClient.setQueryData(
        taskCollaborationDetailQueryKey(taskId, response.collaboration.id),
        response,
      );
      await queryClient.invalidateQueries({ queryKey: taskCollaborationQueryKey(taskId) });
    },
  });
}

export function useSubmitTaskCollaborationCommand(taskId: string, collaborationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CollaborationCommandRequest) =>
      submitTaskCollaborationCommand(taskId, collaborationId, input),
    onSuccess: async (response) => {
      queryClient.setQueryData(taskCollaborationDetailQueryKey(taskId, collaborationId), response);
      await queryClient.invalidateQueries({ queryKey: taskCollaborationQueryKey(taskId) });
    },
  });
}

export function useEmployeeTaskExecution(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: employeeTaskExecutionQueryKey(taskId ?? 'none'),
    queryFn: ({ signal }) => getEmployeeTaskExecution(taskId!, signal),
    enabled: enabled && taskId !== null,
    staleTime: 5_000,
    retry: false,
  });
}

export function useSubmitTaskCorrectionFeedback(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      correctionId,
      input,
    }: {
      correctionId: string;
      input: CorrectionFeedbackRequest;
    }) => submitTaskCorrectionFeedback(taskId, correctionId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskCorrectionQueryKey(taskId) });
    },
  });
}

function useInvalidateEmployeeTaskExecution(taskId: string) {
  const queryClient = useQueryClient();
  return async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: employeeTaskExecutionQueryKey(taskId) }),
      queryClient.invalidateQueries({ queryKey: workbenchTasksQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['workbench', 'tasks', taskId, 'trace'] }),
    ]);
  };
}

export function useTransitionEmployeeTask(taskId: string) {
  const invalidate = useInvalidateEmployeeTaskExecution(taskId);
  return useMutation({
    mutationFn: (input: EmployeeTaskTransitionRequest) => transitionEmployeeTask(taskId, input),
    onSuccess: invalidate,
  });
}

export function useContributeEmployeeEvidence(taskId: string) {
  const invalidate = useInvalidateEmployeeTaskExecution(taskId);
  return useMutation({
    mutationFn: (input: EmployeeEvidenceContributionRequest) =>
      contributeEmployeeEvidence(taskId, input),
    onSuccess: invalidate,
  });
}

export function useSubmitEmployeeDeliverable(taskId: string) {
  const invalidate = useInvalidateEmployeeTaskExecution(taskId);
  return useMutation({
    mutationFn: ({
      deliverableId,
      input,
    }: {
      deliverableId: string;
      input: EmployeeDeliverableSubmissionRequest;
    }) => submitEmployeeDeliverable(taskId, deliverableId, input),
    onSuccess: invalidate,
  });
}

export function useRequestEmployeeAcceptance(taskId: string) {
  const invalidate = useInvalidateEmployeeTaskExecution(taskId);
  return useMutation({
    mutationFn: ({
      deliverableId,
      input,
    }: {
      deliverableId: string;
      input: EmployeeAcceptanceRequestInput;
    }) => requestEmployeeAcceptance(taskId, deliverableId, input),
    onSuccess: invalidate,
  });
}
