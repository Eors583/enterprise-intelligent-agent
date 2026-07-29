import type {
  ToolDefinitionStatus,
  ToolRiskClass,
  ToolVersionLifecycleRequest,
} from '@enterprise/contracts';

export function toolStatusLabel(status: ToolDefinitionStatus): string {
  return (
    {
      DRAFT: '草稿',
      TESTING: '测试中',
      PUBLISHED: '已发布',
      RETIRED: '已退役',
    } satisfies Record<ToolDefinitionStatus, string>
  )[status];
}

export function toolRiskLabel(risk: ToolRiskClass): string {
  return (
    {
      READ_ONLY: '只读查询',
      DRAFT_ONLY: '仅生成草稿',
      CONFIRM_REQUIRED: '用户确认后执行',
      HIGH_RISK_APPROVAL: '独立审批后执行',
      FORBIDDEN: '禁止执行',
    } satisfies Record<ToolRiskClass, string>
  )[risk];
}

export function nextToolLifecycleAction(
  status: ToolDefinitionStatus,
): ToolVersionLifecycleRequest['action'] | null {
  return (
    {
      DRAFT: 'TEST',
      TESTING: 'PUBLISH',
      PUBLISHED: 'RETIRE',
      RETIRED: null,
    } satisfies Record<ToolDefinitionStatus, ToolVersionLifecycleRequest['action'] | null>
  )[status];
}

export function toolLifecycleLabel(action: ToolVersionLifecycleRequest['action']): string {
  return { TEST: '进入测试', PUBLISH: '发布版本', RETIRE: '退役版本' }[action];
}

export function parseToolList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，;；]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function toolErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '工具治理服务暂时不可用，请稍后重试。';
}

export function formatToolDate(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}
