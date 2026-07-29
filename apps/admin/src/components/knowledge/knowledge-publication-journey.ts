import type {
  AiEvaluationRun,
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';

export type KnowledgePublicationStageKey =
  | 'PARSE'
  | 'PARSE_REVIEW'
  | 'GOVERNANCE_REVIEW'
  | 'SYSTEM_EVALUATION'
  | 'INDEPENDENT_REVIEW'
  | 'PUBLISH'
  | 'INDEX_READY';

export type KnowledgePublicationStageState = 'COMPLETE' | 'CURRENT' | 'WAITING' | 'BLOCKED';

export type KnowledgePublicationAction =
  | 'RETRY_INGESTION'
  | 'OPEN_PARSE_REVIEW'
  | 'OPEN_GOVERNANCE'
  | 'OPEN_EVALUATION'
  | 'OPEN_REVIEW'
  | 'OPEN_PUBLISH'
  | 'REBUILD_INDEX'
  | 'NONE';

export interface KnowledgePublicationStage {
  readonly key: KnowledgePublicationStageKey;
  readonly label: string;
  readonly state: KnowledgePublicationStageState;
  readonly detail: string;
}

export interface KnowledgePublicationJourney {
  readonly stages: readonly KnowledgePublicationStage[];
  readonly nextAction: KnowledgePublicationAction;
  readonly nextActionLabel: string | null;
  readonly matchingRun: AiEvaluationRun | null;
  readonly semanticReady: boolean;
  readonly semanticBlocker: string | null;
}

export function deriveKnowledgePublicationJourney(input: {
  readonly document: KnowledgeDocumentSummary;
  readonly version: KnowledgeDocumentVersionSummary;
  readonly runs: readonly AiEvaluationRun[];
  readonly readiness: KnowledgeBaseIndexReadiness | null;
}): KnowledgePublicationJourney {
  const { document, version, readiness } = input;
  const parsed =
    (version.status === 'READY' || version.status === 'ARCHIVED') && version.chunkCount > 0;
  const parseFailed = version.status === 'FAILED' || version.ingestionJob?.status === 'FAILED';
  const parseReviewed = !requiresParseReview(version) || version.parseReviewStatus === 'APPROVED';
  const parseReviewBlocked = version.parseReviewStatus === 'REJECTED';
  const governanceReviewed = version.governance.reviewStatus === 'APPROVED';
  const governanceBlocked = version.governance.reviewStatus === 'REJECTED';
  const matchingRun = bestMatchingRun(input.runs, version);
  const systemEvaluated =
    matchingRun !== null &&
    ['SUBMITTED', 'VERIFIED', 'PASSED', 'FAILED'].includes(matchingRun.status);
  const evaluationBlocked = matchingRun?.status === 'FAILED' || matchingRun?.status === 'CANCELLED';
  const independentlyApproved = matchingRun?.status === 'PASSED';
  const published =
    document.currentVersionId === version.id &&
    version.publishedAt !== null &&
    version.status === 'READY';
  const semanticReady = isEnterpriseSemanticReady(readiness);
  const indexReady = published && semanticReady;

  const completion = [
    parsed,
    parsed && parseReviewed,
    parsed && parseReviewed && governanceReviewed,
    parsed && parseReviewed && governanceReviewed && systemEvaluated,
    parsed && parseReviewed && governanceReviewed && independentlyApproved,
    published,
    indexReady,
  ];
  const blocked = [
    parseFailed,
    parseReviewBlocked,
    governanceBlocked,
    evaluationBlocked,
    evaluationBlocked,
    false,
    published && !semanticReady,
  ];
  const currentIndex = firstCurrentStage(completion, blocked);

  const stages: readonly KnowledgePublicationStage[] = [
    stage(
      'PARSE',
      '解析',
      completion[0] ?? false,
      blocked[0] ?? false,
      currentIndex === 0,
      parseDetail(version),
    ),
    stage(
      'PARSE_REVIEW',
      '解析审核',
      completion[1] ?? false,
      blocked[1] ?? false,
      currentIndex === 1,
      parseReviewDetail(version),
    ),
    stage(
      'GOVERNANCE_REVIEW',
      '治理审核',
      completion[2] ?? false,
      blocked[2] ?? false,
      currentIndex === 2,
      governanceDetail(version),
    ),
    stage(
      'SYSTEM_EVALUATION',
      '系统评测',
      completion[3] ?? false,
      blocked[3] ?? false,
      currentIndex === 3,
      evaluationDetail(matchingRun, false),
    ),
    stage(
      'INDEPENDENT_REVIEW',
      '独立复核',
      completion[4] ?? false,
      blocked[4] ?? false,
      currentIndex === 4,
      evaluationDetail(matchingRun, true),
    ),
    stage(
      'PUBLISH',
      '发布',
      completion[5] ?? false,
      blocked[5] ?? false,
      currentIndex === 5,
      published ? '候选版本已原子切换为当前发布版本。' : '等待已通过且快照一致的评测 Run。',
    ),
    stage(
      'INDEX_READY',
      '索引就绪',
      completion[6] ?? false,
      blocked[6] ?? false,
      currentIndex === 6,
      indexReady
        ? 'Embedding、向量覆盖与 Reranker 均已达到企业语义门禁。'
        : semanticBlocker(readiness),
    ),
  ];

  const nextAction = completion.every(Boolean)
    ? 'NONE'
    : actionForStage(stages[currentIndex]?.key, parseFailed);
  return {
    stages,
    nextAction,
    nextActionLabel: actionLabel(nextAction),
    matchingRun,
    semanticReady,
    semanticBlocker: semanticReady ? null : semanticBlocker(readiness),
  };
}

export function isEnterpriseSemanticReady(readiness: KnowledgeBaseIndexReadiness | null): boolean {
  return (
    readiness !== null &&
    readiness.embedding.status === 'READY' &&
    readiness.embedding.model !== null &&
    readiness.rerank.status === 'READY' &&
    readiness.rerank.model !== null &&
    readiness.semanticCoverage === 1 &&
    readiness.retrievalMode === 'HYBRID' &&
    readiness.activationAllowed
  );
}

function requiresParseReview(version: KnowledgeDocumentVersionSummary): boolean {
  return version.sourceType === 'FILE' || version.sourceType === 'WEB';
}

function bestMatchingRun(
  runs: readonly AiEvaluationRun[],
  version: KnowledgeDocumentVersionSummary,
): AiEvaluationRun | null {
  const priority: Record<AiEvaluationRun['status'], number> = {
    PASSED: 7,
    SUBMITTED: 6,
    VERIFIED: 5,
    RUNNING: 4,
    CREATED: 3,
    FAILED: 2,
    CANCELLED: 1,
  };
  return (
    runs
      .filter(
        (run) =>
          run.subjectType === 'KNOWLEDGE_VERSION' &&
          run.subjectId === version.id &&
          run.subjectVersion === version.versionNumber,
      )
      .sort((left, right) => {
        const statusDifference = priority[right.status] - priority[left.status];
        return statusDifference || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })[0] ?? null
  );
}

function firstCurrentStage(completion: readonly boolean[], blocked: readonly boolean[]): number {
  const blockedIndex = blocked.findIndex(Boolean);
  if (blockedIndex >= 0) return blockedIndex;
  const incompleteIndex = completion.findIndex((complete) => !complete);
  return incompleteIndex >= 0 ? incompleteIndex : completion.length - 1;
}

function stage(
  key: KnowledgePublicationStageKey,
  label: string,
  complete: boolean,
  blocked: boolean,
  current: boolean,
  detail: string,
): KnowledgePublicationStage {
  return {
    key,
    label,
    state: complete ? 'COMPLETE' : blocked ? 'BLOCKED' : current ? 'CURRENT' : 'WAITING',
    detail,
  };
}

function actionForStage(
  stageKey: KnowledgePublicationStageKey | undefined,
  parseFailed: boolean,
): KnowledgePublicationAction {
  if (stageKey === 'PARSE') return parseFailed ? 'RETRY_INGESTION' : 'NONE';
  if (stageKey === 'PARSE_REVIEW') return 'OPEN_PARSE_REVIEW';
  if (stageKey === 'GOVERNANCE_REVIEW') return 'OPEN_GOVERNANCE';
  if (stageKey === 'SYSTEM_EVALUATION') return 'OPEN_EVALUATION';
  if (stageKey === 'INDEPENDENT_REVIEW') return 'OPEN_REVIEW';
  if (stageKey === 'PUBLISH') return 'OPEN_PUBLISH';
  if (stageKey === 'INDEX_READY') return 'REBUILD_INDEX';
  return 'NONE';
}

function actionLabel(action: KnowledgePublicationAction): string | null {
  return (
    {
      RETRY_INGESTION: '重试解析',
      OPEN_PARSE_REVIEW: '处理解析审核',
      OPEN_GOVERNANCE: '处理治理审核',
      OPEN_EVALUATION: '创建并运行系统评测',
      OPEN_REVIEW: '前往独立复核',
      OPEN_PUBLISH: '验证并发布',
      REBUILD_INDEX: '补齐企业语义索引',
      NONE: null,
    }[action] ?? null
  );
}

function parseDetail(version: KnowledgeDocumentVersionSummary): string {
  if (version.status === 'FAILED' || version.ingestionJob?.status === 'FAILED') {
    return version.ingestionJob?.errorMessage ?? '解析或索引处理失败。';
  }
  if (version.chunkCount > 0) return `已形成 ${version.chunkCount} 个密封切片。`;
  return version.ingestionJob === null
    ? '尚未形成可评测切片。'
    : `${version.ingestionJob.stage} · ${version.ingestionJob.progress}%`;
}

function parseReviewDetail(version: KnowledgeDocumentVersionSummary): string {
  if (!requiresParseReview(version)) return '该来源无需人工解析质检。';
  return (
    {
      PENDING: '等待另一位管理员核对解析质量。',
      APPROVED: '解析质量已批准。',
      REJECTED: '解析质量已驳回，需修复后重新提交。',
      NOT_REQUIRED: '该来源无需人工解析质检。',
    }[version.parseReviewStatus] ?? version.parseReviewStatus
  );
}

function governanceDetail(version: KnowledgeDocumentVersionSummary): string {
  return (
    {
      PENDING: '等待治理策略及可见范围审核。',
      APPROVED: '治理策略已独立批准。',
      REJECTED: '治理策略已驳回。',
      MIGRATED: '历史迁移策略不能替代当前候选治理审批。',
    }[version.governance.reviewStatus] ?? version.governance.reviewStatus
  );
}

function evaluationDetail(run: AiEvaluationRun | null, independent: boolean): string {
  if (run === null) {
    return independent ? '系统评测完成后由管理员复核 Runner 证据。' : '尚未创建密封评测 Run。';
  }
  if (independent) {
    if (run.status === 'PASSED') return `Run ${run.id} 已独立复核通过。`;
    if (run.status === 'FAILED') return `Run ${run.id} 已复核失败。`;
    if (run.status === 'SUBMITTED' || run.status === 'VERIFIED') {
      return `Run ${run.id} 已返回可信证据，等待管理员复核。`;
    }
    return `Run ${run.id} 尚未到达可复核状态。`;
  }
  return `Run ${run.id} · ${run.status}`;
}

function semanticBlocker(readiness: KnowledgeBaseIndexReadiness | null): string {
  if (readiness === null) return '企业语义就绪度尚未加载，不能标记为生产可用。';
  if (readiness.embedding.status !== 'READY' || readiness.embedding.model === null) {
    return 'Embedding 未配置或不可用，当前不是企业语义就绪。';
  }
  if (readiness.semanticCoverage < 1) {
    return `向量覆盖率仅 ${Math.round(readiness.semanticCoverage * 100)}%，不能标记为生产可用。`;
  }
  if (readiness.rerank.status !== 'READY' || readiness.rerank.model === null) {
    return 'Reranker 未配置或不可用，当前不是企业语义就绪。';
  }
  if (readiness.retrievalMode !== 'HYBRID') {
    return '当前仅支持词法检索，不能标记为企业语义就绪。';
  }
  return '企业语义激活门禁尚未通过，不能标记为生产可用。';
}
