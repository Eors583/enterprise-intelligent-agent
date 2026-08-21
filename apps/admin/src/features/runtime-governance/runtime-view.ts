import type {
  BusinessEventDelivery,
  ProcessCommand,
  ProcessInstanceStatus,
  ProcessStepCommand,
  ProcessStepInstance,
  ProcessStepStatus,
} from '@enterprise/contracts';

import { ApiError, messageFromError } from '@/api/client';

export type ProcessCommandName = ProcessCommand['command'];
export type ProcessStepCommandName = ProcessStepCommand['command'];

const PROCESS_COMMANDS: Record<ProcessInstanceStatus, readonly ProcessCommandName[]> = {
  PENDING: ['START', 'CANCEL'],
  RUNNING: ['PAUSE', 'COMPLETE', 'FAIL', 'CANCEL'],
  PAUSED: ['RESUME', 'CANCEL'],
  COMPLETED: [],
  FAILED: ['BEGIN_COMPENSATION'],
  CANCELLED: [],
  COMPENSATING: ['COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'],
  COMPENSATED: [],
  COMPENSATION_FAILED: [],
};

const STEP_COMMANDS: Record<ProcessStepStatus, readonly ProcessStepCommandName[]> = {
  WAITING: ['ACTIVATE', 'CANCEL', 'SKIP'],
  READY: ['CLAIM', 'CANCEL', 'SKIP'],
  RUNNING: ['COMPLETE', 'REJECT', 'TIMEOUT', 'FAIL', 'CANCEL'],
  COMPLETED: ['BEGIN_COMPENSATION'],
  REJECTED: [],
  TIMED_OUT: ['RETRY', 'CANCEL'],
  FAILED: ['RETRY', 'BEGIN_COMPENSATION', 'CANCEL'],
  CANCELLED: [],
  COMPENSATING: ['COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'],
  COMPENSATED: [],
  COMPENSATION_FAILED: [],
  SKIPPED: [],
};

export function processCommandsFor(status: ProcessInstanceStatus): readonly ProcessCommandName[] {
  return PROCESS_COMMANDS[status];
}

export function processStepCommandsFor(
  status: ProcessStepStatus,
): readonly ProcessStepCommandName[] {
  return STEP_COMMANDS[status];
}

export function processStepCommandRequiresActor(command: ProcessStepCommandName): boolean {
  return ['CLAIM', 'COMPLETE', 'REJECT', 'FAIL'].includes(command);
}

export function availableProcessStepCommands(
  step: ProcessStepInstance,
): readonly ProcessStepCommandName[] {
  return processStepCommandsFor(step.status).filter(
    (command) =>
      !processStepCommandRequiresActor(command) || step.resolvedRoleAssignmentId !== null,
  );
}

export function processStatusLabel(status: ProcessInstanceStatus): string {
  return (
    {
      PENDING: '待启动',
      RUNNING: '运行中',
      PAUSED: '已暂停',
      COMPLETED: '已完成',
      FAILED: '失败',
      CANCELLED: '已取消',
      COMPENSATING: '补偿中',
      COMPENSATED: '已补偿',
      COMPENSATION_FAILED: '补偿失败',
    }[status] ?? status
  );
}

export function processStepStatusLabel(status: ProcessStepStatus): string {
  return (
    {
      WAITING: '等待',
      READY: '可执行',
      RUNNING: '执行中',
      COMPLETED: '已完成',
      REJECTED: '已拒绝',
      TIMED_OUT: '已超时',
      FAILED: '失败',
      CANCELLED: '已取消',
      COMPENSATING: '补偿中',
      COMPENSATED: '已补偿',
      COMPENSATION_FAILED: '补偿失败',
      SKIPPED: '已跳过',
    }[status] ?? status
  );
}

export function deliveryStatusLabel(status: BusinessEventDelivery['status']): string {
  return (
    {
      PENDING: '待投递',
      PROCESSING: '处理中',
      PROCESSED: '已处理',
      RETRY_SCHEDULED: '等待重试',
      DEAD_LETTERED: '死信',
    }[status] ?? status
  );
}

export function commandLabel(command: ProcessCommandName | ProcessStepCommandName): string {
  return (
    {
      START: '启动',
      PAUSE: '暂停',
      RESUME: '恢复',
      COMPLETE: '完成',
      FAIL: '标记失败',
      CANCEL: '取消',
      BEGIN_COMPENSATION: '开始补偿',
      COMPLETE_COMPENSATION: '完成补偿',
      FAIL_COMPENSATION: '补偿失败',
      ACTIVATE: '激活',
      CLAIM: '认领',
      REJECT: '拒绝',
      TIMEOUT: '标记超时',
      RETRY: '重试',
      SKIP: '跳过',
    }[command] ?? command
  );
}

export function isCapabilityUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}

export function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export function runtimeErrorMessage(error: unknown): string {
  if (isCapabilityUnavailable(error)) {
    return '服务端尚未接通该运行治理能力（HTTP 404/501）；界面不会使用模拟数据替代。';
  }
  if (isRevisionConflict(error)) {
    return '修订冲突：记录已被其他操作者更新。请关闭对话框并刷新，再基于最新 revision 操作。';
  }
  return messageFromError(error);
}

export function formatRuntimeDate(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function shortRuntimeId(value: string | null): string {
  if (value === null) return '—';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
