import type {
  CreateMemoryCandidateRequest,
  MemoryScope,
  MemoryTransitionRequest,
} from '@enterprise/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createMemoryCandidate, listMemories, transitionMemory } from './api';

export const memoriesQueryKey = (scope: MemoryScope, purpose: string) =>
  ['workbench', 'memories', scope, purpose.trim()] as const;

export function useMemories(scope: MemoryScope, purpose: string, enabled = true) {
  return useQuery({
    queryKey: memoriesQueryKey(scope, purpose),
    queryFn: ({ signal }) =>
      listMemories(
        {
          scope,
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        },
        signal,
      ),
    enabled: enabled && (scope !== 'EMPLOYEE_PRIVATE' || purpose.trim().length > 0),
    staleTime: 15_000,
    retry: false,
  });
}

export function useCreateMemoryCandidate(scope: MemoryScope, purpose: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMemoryCandidateRequest) => createMemoryCandidate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memoriesQueryKey(scope, purpose) });
    },
  });
}

export function useTransitionMemory(scope: MemoryScope, purpose: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, input }: { memoryId: string; input: MemoryTransitionRequest }) =>
      transitionMemory(memoryId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memoriesQueryKey(scope, purpose) });
    },
  });
}
