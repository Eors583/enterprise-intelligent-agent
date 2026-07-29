import {
  isCollaborationTransitionAllowed,
  isCorrectionTransitionAllowed,
  type Collaboration,
  type CollaborationCommandRequest,
  type CollaborationMessage,
  type CorrectionCase,
  type CorrectionFeedbackRequest,
} from '@enterprise/contracts';

import { ApiClientError } from '../../shared/api/client';

export type CorrectionFeedbackAction = CorrectionFeedbackRequest['action'];
export type CollaborationCommandAction = CollaborationCommandRequest['type'];

const CORRECTION_TARGETS: Readonly<Record<CorrectionFeedbackAction, CorrectionCase['status']>> = {
  ACKNOWLEDGE: 'ACKNOWLEDGED',
  ACCEPT: 'ACCEPTED',
  REJECT: 'REJECTED',
  EXPLAIN: 'EXPLAINED',
  ESCALATE: 'ESCALATED',
  RESOLVE: 'RESOLVED',
  CANCEL: 'CANCELLED',
};

const COLLABORATION_STATUSES: readonly Collaboration['status'][] = [
  'REQUESTED',
  'COMMITTED',
  'DELIVERED',
  'ACCEPTED',
  'REJECTED',
  'ESCALATED',
  'CANCELLED',
];

const COLLABORATION_TARGETS: Readonly<Record<CollaborationCommandAction, Collaboration['status']>> =
  {
    COMMIT: 'COMMITTED',
    DELIVER: 'DELIVERED',
    ACCEPT: 'ACCEPTED',
    REJECT: 'REJECTED',
    ESCALATE: 'ESCALATED',
    CANCEL: 'CANCELLED',
  };

export function correctionActionsFor(
  status: CorrectionCase['status'],
): readonly CorrectionFeedbackAction[] {
  return (Object.keys(CORRECTION_TARGETS) as CorrectionFeedbackAction[]).filter((action) =>
    isCorrectionTransitionAllowed(status, CORRECTION_TARGETS[action]),
  );
}

export function correctionActionRequiresEvidence(action: CorrectionFeedbackAction): boolean {
  return ['REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE'].includes(action);
}

export function isCollaborationTerminal(status: Collaboration['status']): boolean {
  return !COLLABORATION_STATUSES.some((candidate) =>
    isCollaborationTransitionAllowed(status, candidate),
  );
}

export function collaborationActionsFor(
  status: Collaboration['status'],
): readonly CollaborationCommandAction[] {
  return (Object.keys(COLLABORATION_TARGETS) as CollaborationCommandAction[]).filter((action) =>
    isCollaborationTransitionAllowed(status, COLLABORATION_TARGETS[action]),
  );
}

export function collaborationCommandLabel(action: CollaborationCommandAction): string {
  return (
    {
      COMMIT: '承诺交付',
      DELIVER: '提交交付',
      ACCEPT: '接受交付',
      REJECT: '拒绝/退回',
      ESCALATE: '升级决策',
      CANCEL: '取消协同',
    }[action] ?? action
  );
}

export function collaborationStatusLabel(status: Collaboration['status']): string {
  return (
    {
      REQUESTED: '已请求',
      COMMITTED: '已承诺',
      DELIVERED: '已交付',
      ACCEPTED: '已接受',
      REJECTED: '已拒绝',
      ESCALATED: '已升级',
      CANCELLED: '已取消',
    }[status] ?? status
  );
}

export function collaborationMessageLabel(type: CollaborationMessage['type']): string {
  return (
    {
      REQUEST: '请求',
      COMMIT: '承诺',
      DELIVER: '交付',
      ACCEPT: '接受',
      REJECT: '拒绝',
      ESCALATE: '升级',
      CANCEL: '取消',
    }[type] ?? type
  );
}

export function correctionStatusLabel(status: CorrectionCase['status']): string {
  return (
    {
      OPEN: '待处理',
      ACKNOWLEDGED: '已确认',
      ACCEPTED: '已接受',
      REJECTED: '已拒绝',
      EXPLAINED: '已解释',
      ESCALATED: '已升级',
      RESOLVED: '已解决',
      CANCELLED: '已取消',
    }[status] ?? status
  );
}

export function correctionActionLabel(action: CorrectionFeedbackAction): string {
  return (
    {
      ACKNOWLEDGE: '确认收到',
      ACCEPT: '接受建议',
      REJECT: '拒绝纠偏',
      EXPLAIN: '提交解释',
      ESCALATE: '升级处理',
      RESOLVE: '标记解决',
      CANCEL: '取消纠偏',
    }[action] ?? action
  );
}

export function isWorkbenchCapabilityUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.kind === 'http' &&
    (error.status === 404 || error.status === 501)
  );
}

export function isWorkbenchRevisionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.kind === 'http' && error.status === 409;
}

export function workbenchInteractionError(error: unknown): string {
  if (isWorkbenchCapabilityUnavailable(error)) {
    return '服务端尚未接通该工作台能力（HTTP 404/501）；不会展示模拟协同或纠偏数据。';
  }
  if (isWorkbenchRevisionConflict(error)) {
    return '修订冲突：纠偏记录已发生变化。请关闭反馈窗口并刷新后，基于最新 revision 再操作。';
  }
  if (error instanceof ApiClientError) {
    return `${error.message}${error.requestId ? `（请求 ID：${error.requestId}）` : ''}`;
  }
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}
