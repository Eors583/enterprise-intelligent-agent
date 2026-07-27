import type {
  KnowledgeBaseIndexReadiness,
  KnowledgeCapabilityStatus,
  KnowledgeDocumentSummary,
  KnowledgeReadinessReason,
} from '@enterprise/contracts';

const REASON_LABELS: Record<KnowledgeReadinessReason, string> = {
  DOCUMENTS_PROCESSING: '仍有文档正在解析或建立索引',
  DOCUMENTS_FAILED: '仍有文档解析或索引失败',
  NO_PUBLISHED_CHUNKS: '没有已发布且包含切片的文档',
  EMBEDDING_DISABLED: '语义向量能力未启用',
  EMBEDDING_PROVIDER_NOT_READY: 'Embedding 服务配置与运行状态不一致或尚未就绪',
  EMBEDDING_PROVIDER_UNAVAILABLE: 'Embedding 服务暂时不可连接',
  EMBEDDING_MODEL_UNAVAILABLE: 'Embedding 模型未配置或不可用',
  EMBEDDING_COVERAGE_INCOMPLETE: '当前模型尚未覆盖全部已发布切片',
  RERANK_DISABLED: 'Reranker 能力未启用',
  RERANK_PROVIDER_NOT_READY: 'Reranker 服务配置与运行状态不一致或尚未就绪',
  RERANK_PROVIDER_UNAVAILABLE: 'Reranker 服务暂时不可连接',
};

const CAPABILITY_LABELS: Record<KnowledgeCapabilityStatus, string> = {
  DISABLED: '未启用',
  READY: '就绪',
  NOT_READY: '未就绪',
  UNAVAILABLE: '不可连接',
};

export function knowledgeReadinessReasonLabel(reason: KnowledgeReadinessReason): string {
  return REASON_LABELS[reason];
}

export function knowledgeCapabilityStatusLabel(status: KnowledgeCapabilityStatus): string {
  return CAPABILITY_LABELS[status];
}

export function knowledgeReadinessRefreshToken(
  documents: ReadonlyArray<KnowledgeDocumentSummary>,
): string {
  return documents
    .flatMap((document) => [
      document.id,
      document.status,
      document.currentVersionId ?? 'none',
      ...document.versions.flatMap((version) => [
        version.id,
        version.status,
        String(version.chunkCount),
        version.ingestionJob?.status ?? 'none',
        String(version.ingestionJob?.progress ?? 0),
      ]),
    ])
    .join(':');
}

export function knowledgeReadinessSummary(
  readiness: KnowledgeBaseIndexReadiness,
): 'READY' | 'DEGRADED' | 'PROCESSING' | 'FAILED' {
  if (readiness.documents.processing > 0) return 'PROCESSING';
  if (readiness.documents.failed > 0) return 'FAILED';
  return readiness.activationAllowed ? 'READY' : 'DEGRADED';
}
