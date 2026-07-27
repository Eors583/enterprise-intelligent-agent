import type {
  KnowledgeBaseIndexReadiness,
  KnowledgeCapabilityReadiness,
  KnowledgeReadinessReason,
} from '@enterprise/contracts';

type DocumentReadinessStatus = keyof KnowledgeBaseIndexReadiness['documents'];

export interface KnowledgeReadinessDocumentState {
  readonly documentStatus: 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';
  readonly currentVersionStatus: 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED' | null;
  readonly currentChunkCount: number;
  readonly latestVersionStatus: 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED' | null;
  readonly latestIngestionStatus: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
}

export interface DeriveKnowledgeReadinessInput {
  readonly knowledgeBaseId: string;
  readonly documents: ReadonlyArray<KnowledgeReadinessDocumentState>;
  readonly embeddedChunkCount: number;
  readonly embedding: KnowledgeCapabilityReadiness;
  readonly rerank: KnowledgeCapabilityReadiness;
}

export function classifyKnowledgeReadinessDocument(
  document: KnowledgeReadinessDocumentState,
): Exclude<DocumentReadinessStatus, 'total'> {
  if (document.documentStatus === 'ARCHIVED') return 'archived';
  if (
    document.documentStatus === 'FAILED' ||
    document.latestVersionStatus === 'FAILED' ||
    document.latestIngestionStatus === 'FAILED'
  ) {
    return 'failed';
  }
  if (
    document.documentStatus === 'PROCESSING' ||
    document.latestVersionStatus === 'PROCESSING' ||
    document.latestIngestionStatus === 'PENDING' ||
    document.latestIngestionStatus === 'RUNNING'
  ) {
    return 'processing';
  }
  if (document.currentVersionStatus === 'READY') return 'ready';
  return 'draft';
}

export function deriveKnowledgeBaseIndexReadiness(
  input: DeriveKnowledgeReadinessInput,
): KnowledgeBaseIndexReadiness {
  const documents = {
    total: input.documents.length,
    ready: 0,
    failed: 0,
    processing: 0,
    draft: 0,
    archived: 0,
  };
  let publishedChunkCount = 0;
  for (const document of input.documents) {
    documents[classifyKnowledgeReadinessDocument(document)] += 1;
    if (document.currentVersionStatus === 'READY' && document.documentStatus !== 'ARCHIVED') {
      publishedChunkCount += Math.max(0, document.currentChunkCount);
    }
  }

  const embeddedChunkCount = Math.min(publishedChunkCount, Math.max(0, input.embeddedChunkCount));
  const semanticCoverage = publishedChunkCount === 0 ? 0 : embeddedChunkCount / publishedChunkCount;
  const semanticBlocker = semanticBlockerFor(
    publishedChunkCount,
    semanticCoverage,
    input.embedding,
  );
  const activationBlockers: KnowledgeReadinessReason[] = [];
  if (documents.processing > 0) activationBlockers.push('DOCUMENTS_PROCESSING');
  if (documents.failed > 0) activationBlockers.push('DOCUMENTS_FAILED');
  if (semanticBlocker !== null) activationBlockers.push(semanticBlocker);
  const rerankBlocker = rerankBlockerFor(input.rerank);
  if (rerankBlocker !== null) activationBlockers.push(rerankBlocker);

  return {
    knowledgeBaseId: input.knowledgeBaseId,
    documents,
    publishedChunkCount,
    embeddedChunkCount,
    semanticCoverage,
    embedding: input.embedding,
    rerank: input.rerank,
    retrievalMode: semanticBlocker === null ? 'HYBRID' : 'LEXICAL',
    degradedReason: semanticBlocker,
    activationAllowed: activationBlockers.length === 0,
    activationBlockers,
  };
}

function semanticBlockerFor(
  publishedChunkCount: number,
  semanticCoverage: number,
  capability: KnowledgeCapabilityReadiness,
): KnowledgeReadinessReason | null {
  if (publishedChunkCount === 0) return 'NO_PUBLISHED_CHUNKS';
  if (capability.status === 'DISABLED') return 'EMBEDDING_DISABLED';
  if (capability.status === 'UNAVAILABLE') return 'EMBEDDING_PROVIDER_UNAVAILABLE';
  if (capability.status === 'NOT_READY') return 'EMBEDDING_PROVIDER_NOT_READY';
  if (capability.model === null) return 'EMBEDDING_MODEL_UNAVAILABLE';
  if (semanticCoverage < 1) return 'EMBEDDING_COVERAGE_INCOMPLETE';
  return null;
}

function rerankBlockerFor(
  capability: KnowledgeCapabilityReadiness,
): KnowledgeReadinessReason | null {
  if (capability.status === 'DISABLED') return 'RERANK_DISABLED';
  if (capability.status === 'UNAVAILABLE') return 'RERANK_PROVIDER_UNAVAILABLE';
  if (capability.status === 'NOT_READY' || capability.model === null) {
    return 'RERANK_PROVIDER_NOT_READY';
  }
  return null;
}
