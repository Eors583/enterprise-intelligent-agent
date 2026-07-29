import type {
  EmployeeAiUsageSummary,
  EmployeeExperienceCandidate,
  ExperienceStatus,
} from '@enterprise/contracts';

const STATUS_LABELS: Readonly<Record<ExperienceStatus, string>> = {
  CANDIDATE: '待脱敏',
  SANITIZED: '已脱敏',
  STRUCTURED: '已结构化',
  APPROVED: '已审核',
  REJECTED: '已驳回',
  VALIDATED: '已验证',
  PUBLISHED: '已发布',
  MONITORED: '监测中',
  RETIRED: '已退休',
};

export const EXPERIENCE_STATUS_OPTIONS = Object.keys(STATUS_LABELS) as ExperienceStatus[];

export function experienceStatusLabel(status: ExperienceStatus): string {
  return STATUS_LABELS[status];
}

export function experienceStageSummary(candidate: EmployeeExperienceCandidate): string {
  if (candidate.status === 'CANDIDATE') {
    return '原始候选仅保存在治理链路中；当前页面不会回显未脱敏正文。';
  }
  if (candidate.status === 'REJECTED') return '专家审核未通过，不会进入企业知识。';
  if (candidate.status === 'RETIRED') return '已从复用范围退休，历史证据仍保留。';
  if (candidate.publication !== null) {
    return `已发布至 ${candidate.publication.targetRoleTemplateIds.length} 个角色范围、${candidate.publication.targetOrgUnitIds.length} 个组织范围。`;
  }
  if (candidate.validation !== null) {
    return `验证得分 ${formatPercent(candidate.validation.score)}，阈值 ${formatPercent(candidate.validation.threshold)}。`;
  }
  if (candidate.review !== null)
    return `专家审核：${candidate.review.decision === 'APPROVED' ? '通过' : '驳回'}。`;
  return '正在进行脱敏、结构化和独立审核，未审核内容不会进入知识库。';
}

export function formatUsageInteger(value: string | number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(
    typeof value === 'string' ? BigInt(value) : value,
  );
}

export function formatCostMicros(value: string): string {
  const micros = BigInt(value);
  const integer = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '');
  return fraction ? `${integer.toString()}.${fraction}` : integer.toString();
}

export function usageTrustSummary(usage: EmployeeAiUsageSummary): string {
  const { tokenReported, tokenUnreported, costReported, costUnreported, unknown } = usage.runs;
  return `可信 Token ${tokenReported} 次，未上报 ${tokenUnreported} 次；可信费用 ${costReported} 次，未上报 ${costUnreported} 次；结果未知 ${unknown} 次。`;
}

export function readableExperienceUsageError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : '企业服务暂时不可用，请稍后重试。';
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}
