import type {
  EmployeeCollaborationContextSnapshot,
  EmployeeCollaborationPurpose,
} from '@enterprise/contracts';

export interface ResolveEmployeeCollaborationContextInput {
  readonly tenantId: string;
  readonly requesterUserId: string;
  readonly representedEmployeeId: string;
  readonly purpose: EmployeeCollaborationPurpose;
  readonly query: string;
  readonly now?: Date;
}

export abstract class EmployeeCollaborationContextPort {
  abstract resolve(
    input: ResolveEmployeeCollaborationContextInput,
  ): Promise<EmployeeCollaborationContextSnapshot>;
}

export function inferEmployeeCollaborationPurpose(
  query: string,
  requesterUserId: string,
  representedEmployeeId: string,
): EmployeeCollaborationPurpose {
  if (requesterUserId === representedEmployeeId) return 'SELF_ASSISTANCE';
  const normalized = query.toLowerCase();
  if (/(方便|有空|在吗|状态|出差|休假|请假|回复|响应|available|availability)/u.test(normalized)) {
    return 'AVAILABILITY_QUERY';
  }
  if (/(进度|任务|项目|目标|交付|截止|延期|阻塞|依赖|progress|task|deadline)/u.test(normalized)) {
    return 'WORK_PROGRESS_QUERY';
  }
  return 'COLLABORATION_GUIDANCE';
}
