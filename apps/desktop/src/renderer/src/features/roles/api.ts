import { roleAssignmentListResponseSchema, type RoleAssignment } from '@enterprise/contracts';

import { apiRequest } from '../../shared/api/client';

export async function listMyRoleAssignments(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<RoleAssignment[]> {
  const response = await apiRequest('/api/v1/role-assignments/me', {
    schema: roleAssignmentListResponseSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
  return response.items;
}
