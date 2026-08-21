import type {
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';

export type KnowledgePublicationStageKey = 'PARSE' | 'PUBLISH' | 'INDEX_STATUS';
export type KnowledgePublicationStageState = 'COMPLETE' | 'CURRENT' | 'WAITING' | 'BLOCKED';
export type KnowledgePublicationAction =
  'RETRY_INGESTION' | 'OPEN_PUBLISH' | 'REBUILD_INDEX' | 'NONE';

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
  readonly semanticReady: boolean;
  readonly semanticBlocker: string | null;
}

export function deriveKnowledgePublicationJourney(input: {
  readonly document: KnowledgeDocumentSummary;
  readonly version: KnowledgeDocumentVersionSummary;
  readonly readiness: KnowledgeBaseIndexReadiness | null;
}): KnowledgePublicationJourney {
  const { document, version, readiness } = input;
  const parsed =
    (version.status === 'READY' || version.status === 'ARCHIVED') && version.chunkCount > 0;
  const parseFailed = version.status === 'FAILED' || version.ingestionJob?.status === 'FAILED';
  const published =
    document.currentVersionId === version.id &&
    version.publishedAt !== null &&
    version.status === 'READY';
  const semanticReady = isSemanticIndexReady(readiness);

  const stages: readonly KnowledgePublicationStage[] = [
    {
      key: 'PARSE',
      label: '解析与分块',
      state: parsed ? 'COMPLETE' : parseFailed ? 'BLOCKED' : 'CURRENT',
      detail: parseDetail(version),
    },
    {
      key: 'PUBLISH',
      label: '发布',
      state: published ? 'COMPLETE' : parsed ? 'CURRENT' : 'WAITING',
      detail: published
        ? '该版本已切换为当前可检索版本。'
        : parsed
          ? '解析完成后即可直接发布，不要求评测或人工审核。'
          : '等待解析与分块完成。',
    },
    {
      key: 'INDEX_STATUS',
      label: '检索状态',
      state: published && semanticReady ? 'COMPLETE' : published ? 'CURRENT' : 'WAITING',
      detail: published && semanticReady ? '混合检索索引可用。' : semanticStatus(readiness),
    },
  ];

  const nextAction: KnowledgePublicationAction = parseFailed
    ? 'RETRY_INGESTION'
    : !parsed
      ? 'NONE'
      : !published
        ? 'OPEN_PUBLISH'
        : !semanticReady
          ? 'REBUILD_INDEX'
          : 'NONE';
  return {
    stages,
    nextAction,
    nextActionLabel: actionLabel(nextAction),
    semanticReady,
    semanticBlocker: semanticReady ? null : semanticStatus(readiness),
  };
}

export function isSemanticIndexReady(readiness: KnowledgeBaseIndexReadiness | null): boolean {
  return (
    readiness !== null &&
    readiness.embedding.status === 'READY' &&
    readiness.embedding.model !== null &&
    readiness.semanticCoverage === 1 &&
    readiness.retrievalMode === 'HYBRID'
  );
}

function actionLabel(action: KnowledgePublicationAction): string | null {
  return {
    RETRY_INGESTION: '重试解析',
    OPEN_PUBLISH: '发布版本',
    REBUILD_INDEX: '重建向量索引',
    NONE: null,
  }[action];
}

function parseDetail(version: KnowledgeDocumentVersionSummary): string {
  if (version.status === 'FAILED' || version.ingestionJob?.status === 'FAILED') {
    return version.ingestionJob?.errorMessage ?? '解析或索引处理失败。';
  }
  if (version.chunkCount > 0) return `已形成 ${version.chunkCount} 个切片。`;
  return version.ingestionJob === null
    ? '尚未形成可检索切片。'
    : `${version.ingestionJob.stage} · ${version.ingestionJob.progress}%`;
}

function semanticStatus(readiness: KnowledgeBaseIndexReadiness | null): string {
  if (readiness === null) return '检索状态尚未加载；这不会阻止发布。';
  if (readiness.publishedChunkCount === 0) return '尚无已发布切片。';
  if (readiness.embedding.status !== 'READY' || readiness.embedding.model === null) {
    return '向量服务不可用时仍可使用关键词检索。';
  }
  if (readiness.semanticCoverage < 1) {
    return `向量覆盖率 ${Math.round(readiness.semanticCoverage * 100)}%；未覆盖部分仍可关键词检索。`;
  }
  if (readiness.retrievalMode !== 'HYBRID') return '当前使用关键词检索。';
  return '检索状态可用。';
}
