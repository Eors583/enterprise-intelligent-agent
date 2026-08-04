import {
  bootstrapResponseSchema,
  type BootstrapResponse,
  type DepartmentSummary,
  type MemberSummary,
} from '@enterprise/contracts';
import { z } from 'zod';
import { ApiClientError, apiRequest } from '../../shared/api/client';

// Cross-entity checks belong to the consuming screen while field-level shapes
// stay in the shared package used by both API and desktop.
export const bootstrapPayloadSchema = bootstrapResponseSchema.superRefine((payload, context) => {
  if (payload.navigation.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['navigation'],
      message: '导航项不能为空',
    });
  }

  checkUniqueIds(payload.navigation, 'navigation', context);
  checkUniqueIds(payload.departments, 'departments', context);
  checkUniqueIds(payload.members, 'members', context);
  checkUniqueIds(payload.departmentAgents, 'departmentAgents', context);

  const departmentIds = new Set(payload.departments.map((department) => department.id));
  const parentByDepartment = new Map(
    payload.departments.map((department) => [department.id, department.parentId] as const),
  );

  for (const [index, department] of payload.departments.entries()) {
    if (department.parentId && !departmentIds.has(department.parentId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['departments', index, 'parentId'],
        message: `父部门 ${department.parentId} 不存在`,
      });
    }

    const visited = new Set<string>([department.id]);
    let cursor = department.parentId;
    while (cursor) {
      if (visited.has(cursor)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['departments', index, 'parentId'],
          message: '组织树不能包含循环引用',
        });
        break;
      }
      visited.add(cursor);
      cursor = parentByDepartment.get(cursor) ?? null;
    }
  }

  for (const [memberIndex, member] of payload.members.entries()) {
    for (const [departmentIndex, departmentId] of member.departmentIds.entries()) {
      if (!departmentIds.has(departmentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', memberIndex, 'departmentIds', departmentIndex],
          message: `成员引用的部门 ${departmentId} 不存在`,
        });
      }
    }
  }
  for (const [agentIndex, agent] of payload.departmentAgents.entries()) {
    if (!departmentIds.has(agent.departmentId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['departmentAgents', agentIndex, 'departmentId'],
        message: `部门智能体引用的部门 ${agent.departmentId} 不存在`,
      });
    }
  }
});

function checkUniqueIds(
  items: ReadonlyArray<{ id: string }>,
  path: 'navigation' | 'departments' | 'members' | 'departmentAgents',
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index, 'id'],
        message: `ID ${item.id} 重复`,
      });
    }
    seen.add(item.id);
  }
}

export type BootstrapPayload = BootstrapResponse;
export type Department = DepartmentSummary;
export type Member = MemberSummary;

export { ApiClientError as BootstrapError };

export async function fetchBootstrap(
  signal?: AbortSignal,
  apiBaseUrl?: string,
): Promise<BootstrapPayload> {
  return apiRequest('/api/v1/bootstrap', {
    schema: bootstrapPayloadSchema,
    ...(signal ? { signal } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}
