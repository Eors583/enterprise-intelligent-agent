import type {
  AvailableTool,
  ToolInvocation,
  ToolInvocationDecisionRequest,
  ToolInvocationStatus,
  ToolRiskClass,
} from '@enterprise/contracts';

import { ApiClientError } from '../../shared/api/client';

export type RequesterToolAction =
  | Extract<ToolInvocationDecisionRequest['action'], 'CONFIRM' | 'CANCEL' | 'RETRY' | 'RECONCILE'>
  | 'COMPENSATE';

const STATUS_LABELS: Record<ToolInvocationStatus, string> = {
  REQUESTED: '已登记',
  POLICY_DENIED: '策略拒绝',
  PENDING_CONFIRMATION: '待本人确认',
  PENDING_APPROVAL: '待独立审批',
  APPROVED: '已批准待执行',
  REJECTED: '审批拒绝',
  EXECUTING: '执行中',
  SUCCEEDED: '执行成功',
  FAILED: '执行失败',
  UNKNOWN: '结果待核对',
  CANCELLED: '已取消',
  COMPENSATING: '补偿中',
  COMPENSATED: '已补偿',
  COMPENSATION_FAILED: '补偿失败',
};

const RISK_LABELS: Record<ToolRiskClass, string> = {
  READ_ONLY: '只读查询',
  DRAFT_ONLY: '仅生成草稿',
  CONFIRM_REQUIRED: '确认后执行',
  HIGH_RISK_APPROVAL: '独立审批后执行',
  FORBIDDEN: '禁止执行',
};

export function toolInvocationStatusLabel(status: ToolInvocationStatus): string {
  return STATUS_LABELS[status];
}

export function toolRiskLabel(risk: ToolRiskClass): string {
  return RISK_LABELS[risk];
}

export function requesterActionsFor(invocation: ToolInvocation): readonly RequesterToolAction[] {
  if (invocation.status === 'PENDING_CONFIRMATION') return ['CONFIRM', 'CANCEL'];
  if (invocation.status === 'PENDING_APPROVAL' || invocation.status === 'APPROVED') {
    return ['CANCEL'];
  }
  if (invocation.status === 'FAILED') return ['RETRY'];
  if (invocation.status === 'UNKNOWN') return ['RECONCILE'];
  if (
    invocation.status === 'SUCCEEDED' &&
    invocation.compensationForInvocationId === null &&
    !invocation.dryRun &&
    !['READ_ONLY', 'DRAFT_ONLY', 'FORBIDDEN'].includes(invocation.riskClass)
  ) {
    return ['COMPENSATE'];
  }
  return [];
}

export function requesterToolActionLabel(action: RequesterToolAction): string {
  const labels: Record<RequesterToolAction, string> = {
    COMPENSATE: '发起受控补偿',
    CONFIRM: '确认执行',
    CANCEL: '取消调用',
    RETRY: '创建重试',
    RECONCILE: '请求核对',
  };
  return labels[action];
}

export function initialToolInput(tool: AvailableTool): string {
  const properties = record(tool.inputSchema.properties);
  const value: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const field = record(schema);
    value[key] =
      field.type === 'number' || field.type === 'integer'
        ? 0
        : field.type === 'boolean'
          ? false
          : field.type === 'array'
            ? []
            : field.type === 'object'
              ? {}
              : '';
  }
  return JSON.stringify(value, null, 2);
}

export function parseToolInput(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工具输入必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}

export function toolOperationError(error: unknown): string {
  if (error instanceof SyntaxError) return '工具输入不是有效 JSON，请检查括号、逗号和引号。';
  if (error instanceof ApiClientError) {
    if (error.status === 409) return '调用状态已变化，请刷新后基于最新 revision 再操作。';
    if (error.status === 403) return '当前角色任命没有执行此工具动作的权限。';
    return error.requestId ? `${error.message}（请求 ${error.requestId}）` : error.message;
  }
  return error instanceof Error ? error.message : '工具操作失败，请刷新后重试。';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
