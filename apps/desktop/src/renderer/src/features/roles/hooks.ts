import { useQuery } from '@tanstack/react-query';

import { listMyRoleAssignments } from './api';

export const myRoleAssignmentQueryKey = ['role-assignments', 'me'] as const;

export function useMyRoleAssignments(enabled = true) {
  return useQuery({
    queryKey: myRoleAssignmentQueryKey,
    queryFn: ({ signal }) => listMyRoleAssignments(signal),
    enabled,
    staleTime: 30_000,
  });
}
