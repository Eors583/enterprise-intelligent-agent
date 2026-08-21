import type {
  AiEvaluationAnswerFeedbackSource,
  AiEvaluationBadCaseStatus,
  AiEvaluationCategory,
  AiEvaluationDatasetStatus,
  AiEvaluationMetric,
  AiEvaluationRun,
  AiEvaluationRunStatus,
  AiEvaluationSubjectType,
} from '@enterprise/contracts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const EVALUATION_CATEGORIES: ReadonlyArray<{
  value: AiEvaluationCategory;
  label: string;
}> = [
  { value: 'ROLE_BOUNDARY', label: '角色边界' },
  { value: 'FACTUALITY', label: '事实正确性' },
  { value: 'CITATION', label: '引用完整性' },
  { value: 'GOAL_ALIGNMENT', label: '目标对齐' },
  { value: 'TOOL_USE', label: '工具使用' },
  { value: 'CORRECTION', label: '纠错' },
  { value: 'REFUSAL', label: '拒答' },
  { value: 'SAFETY', label: '安全' },
  { value: 'COST', label: '成本' },
];

export function evaluationCategoryLabel(category: AiEvaluationCategory): string {
  return EVALUATION_CATEGORIES.find((item) => item.value === category)?.label ?? category;
}

export function answerFeedbackReasonLabel(
  reason: AiEvaluationAnswerFeedbackSource['feedbackReason'],
): string {
  return {
    INCORRECT: '内容不正确',
    IRRELEVANT_CITATION: '引用与回答无关',
    OUTDATED: '信息已过期',
    MISSING_KNOWLEDGE: '缺少关键知识',
    OTHER: '其他原因',
  }[reason];
}

export const EVALUATION_METRICS: ReadonlyArray<{
  value: AiEvaluationMetric;
  label: string;
}> = [
  { value: 'ROLE_BOUNDARY_ADHERENCE', label: '角色边界遵循率' },
  { value: 'FACTUAL_ACCURACY', label: '事实准确率' },
  { value: 'CITATION_COMPLETENESS', label: '引用完整率' },
  { value: 'GOAL_ALIGNMENT_ACCURACY', label: '目标对齐准确率' },
  { value: 'TOOL_SUCCESS_RATE', label: '工具成功率' },
  { value: 'HIGH_RISK_CONFIRMATION_RATE', label: '高风险确认率' },
  { value: 'CORRECTION_PRECISION', label: '纠错精度' },
  { value: 'CORRECTION_FALSE_POSITIVE_RATE', label: '纠错误报率' },
  { value: 'REFUSAL_CORRECTNESS', label: '拒答正确率' },
  { value: 'KNOWLEDGE_LEAKAGE_COUNT', label: '知识泄漏数' },
  { value: 'PROMPT_INJECTION_RESISTANCE', label: '提示词注入抵抗率' },
  { value: 'SENSITIVE_DATA_DISCLOSURE_COUNT', label: '敏感数据披露数' },
  { value: 'AVERAGE_COST_MICROS', label: '平均成本（微单位）' },
  { value: 'P95_LATENCY_MS', label: 'P95 延迟' },
  { value: 'RETRIEVAL_RECALL_AT_5', label: 'Recall@5（召回率）' },
  { value: 'RETRIEVAL_MRR', label: 'MRR（首个正确来源排名）' },
  { value: 'RETRIEVAL_NDCG_AT_10', label: 'nDCG@10（排序质量）' },
  { value: 'CITATION_SUPPORT_RATE', label: '引用支持率' },
];

export const SUBJECT_TYPES: ReadonlyArray<{
  value: AiEvaluationSubjectType;
  label: string;
}> = [
  { value: 'AGENT_VERSION', label: '智能体 / 角色版本' },
  { value: 'KNOWLEDGE_VERSION', label: '知识版本' },
  { value: 'COMPOSITE_RELEASE', label: '组合发布' },
];

export function parseUuidList(value: string, fieldName: string): string[] {
  const items = uniqueList(value);
  const invalid = items.find((item) => !UUID_PATTERN.test(item));
  if (invalid) throw new Error(`${fieldName}包含无效 UUID：${invalid}`);
  return items;
}

export function parseTextList(value: string): string[] {
  return uniqueList(value);
}

function uniqueList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function runMatchesSubject(
  run: AiEvaluationRun,
  subject: {
    subjectType: AiEvaluationSubjectType;
    subjectId: string;
    subjectVersion: number;
  },
): boolean {
  return (
    run.status === 'PASSED' &&
    run.subjectType === subject.subjectType &&
    run.subjectId === subject.subjectId &&
    run.subjectVersion === subject.subjectVersion
  );
}

export function datasetStatusLabel(status: AiEvaluationDatasetStatus): string {
  return {
    DRAFT: '草稿',
    IN_REVIEW: '审核中',
    APPROVED: '已批准',
    PUBLISHED: '已发布',
    RETIRED: '已退役',
  }[status];
}

export function runStatusLabel(status: AiEvaluationRunStatus): string {
  return {
    CREATED: '已创建',
    RUNNING: '执行中',
    SUBMITTED: '待验证',
    VERIFIED: '已验证',
    PASSED: '通过',
    FAILED: '失败',
    CANCELLED: '已取消',
  }[status];
}

export function badCaseStatusLabel(status: AiEvaluationBadCaseStatus): string {
  return {
    RECEIVED: '待分流',
    TRIAGED: '已分流',
    ADDED_TO_DATASET: '已加入数据集',
    DISMISSED: '已忽略',
  }[status];
}
