import type {
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemoryTransitionRequest,
} from '@enterprise/contracts';

export const MEMORY_SCOPES: readonly MemoryScope[] = [
  'ENTERPRISE',
  'ROLE',
  'EMPLOYEE_PRIVATE',
  'TASK',
  'CONVERSATION',
];

export const AGENT_RUN_MEMORY_PURPOSE = 'AGENT_RUN_CONTEXT';

export function memoryScopeLabel(scope: MemoryScope): string {
  return (
    {
      ENTERPRISE: '企业记忆',
      ROLE: '角色记忆',
      EMPLOYEE_PRIVATE: '员工私有',
      TASK: '任务记忆',
      CONVERSATION: '会话记忆',
    } satisfies Record<MemoryScope, string>
  )[scope];
}

export function memoryStatusLabel(status: MemoryStatus): string {
  return (
    {
      CANDIDATE: '待确认',
      ACTIVE: '生效中',
      ARCHIVED: '已归档',
      SEALED: '已封存',
      DELETED: '已删除',
    } satisfies Record<MemoryStatus, string>
  )[status];
}

export function availableMemoryActions(
  status: MemoryStatus,
): readonly MemoryTransitionRequest['action'][] {
  const actions: Readonly<Record<MemoryStatus, readonly MemoryTransitionRequest['action'][]>> = {
    CANDIDATE: ['ACTIVATE', 'DELETE'],
    ACTIVE: ['ARCHIVE', 'SEAL', 'DELETE'],
    ARCHIVED: ['ACTIVATE', 'SEAL', 'DELETE'],
    SEALED: ['DELETE'],
    DELETED: [],
  };
  return actions[status];
}

export function memoryActionLabel(action: MemoryTransitionRequest['action']): string {
  return (
    {
      ACTIVATE: '确认并启用',
      ARCHIVE: '归档',
      SEAL: '封存',
      DELETE: '删除',
    } satisfies Record<MemoryTransitionRequest['action'], string>
  )[action];
}

export function memoryIdentity(memory: MemoryRecord): string {
  switch (memory.scope) {
    case 'ENTERPRISE':
      return '全企业授权范围';
    case 'ROLE':
      return `角色版本 ${shortMemoryId(memory.roleVersionId)}`;
    case 'EMPLOYEE_PRIVATE':
      return `本人 · 任命 ${shortMemoryId(memory.roleAssignmentId)}`;
    case 'TASK':
      return `任务 ${shortMemoryId(memory.taskId)}`;
    case 'CONVERSATION':
      return `会话 ${shortMemoryId(memory.conversationId)}`;
  }
}

export function shortMemoryId(value: string | null): string {
  if (value === null) return '—';
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function formatMemoryDate(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

export function memoryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '记忆服务暂时不可用，请稍后重试。';
}

export function splitMemoryLabels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，;；]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function memoryExpiryIso(value: string): string {
  const parsed = new Date(value);
  if (!value.trim() || Number.isNaN(parsed.getTime())) {
    throw new Error('会话记忆必须设置有效的到期时间。');
  }
  return parsed.toISOString();
}

export async function memoryContentHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
