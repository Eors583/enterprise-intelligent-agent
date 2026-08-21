import type { EmployeeCreateExperienceRequest, ExperienceStatus } from '@enterprise/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createEmployeeExperience,
  getEmployeeAiUsage,
  getEmployeeExperienceSources,
  listEmployeeExperiences,
} from './api';

export const employeeExperiencesQueryKey = (status?: ExperienceStatus) =>
  ['workbench', 'experiences', status ?? 'ALL'] as const;

export function useEmployeeExperiences(status?: ExperienceStatus, enabled = true) {
  return useInfiniteQuery({
    queryKey: employeeExperiencesQueryKey(status),
    queryFn: ({ pageParam, signal }) =>
      listEmployeeExperiences(
        {
          ...(status ? { status } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export function useEmployeeExperienceSources(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['workbench', 'experience-sources', taskId ?? 'none'],
    queryFn: ({ signal }) => getEmployeeExperienceSources(taskId!, signal),
    enabled: enabled && taskId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useCreateEmployeeExperience(status?: ExperienceStatus) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EmployeeCreateExperienceRequest) => createEmployeeExperience(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: employeeExperiencesQueryKey(status) });
      if (status !== undefined) {
        await queryClient.invalidateQueries({ queryKey: employeeExperiencesQueryKey() });
      }
    },
  });
}

export interface EmployeeAiUsageWindow {
  readonly from?: string;
  readonly to?: string;
}

export function useEmployeeAiUsage(window: EmployeeAiUsageWindow, enabled = true) {
  return useQuery({
    queryKey: ['workbench', 'ai-usage', window.from ?? 'MONTH', window.to ?? 'NOW'],
    queryFn: ({ signal }) => getEmployeeAiUsage(window, signal),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}
