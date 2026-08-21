import type {
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

import {
  deriveKnowledgePublicationJourney,
  isSemanticIndexReady,
} from './knowledge-publication-journey';

describe('knowledge publication journey', () => {
  it('offers direct publication as soon as parsing and chunking are complete', () => {
    const candidate = version({
      sourceType: 'FILE',
      parseReviewStatus: 'PENDING',
      governance: testKnowledgeGovernance({ reviewStatus: 'PENDING' }),
    });
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate),
      version: candidate,
      readiness: lexicalReadiness(),
    });

    expect(journey.stages.map(({ label }) => label)).toEqual(['解析与分块', '发布', '检索状态']);
    expect(journey.stages[0]?.state).toBe('COMPLETE');
    expect(journey.stages[1]?.state).toBe('CURRENT');
    expect(journey.nextAction).toBe('OPEN_PUBLISH');
  });

  it('treats lexical fallback as a non-blocking diagnostic after publication', () => {
    const candidate = version({ publishedAt: '2026-07-29T02:00:00.000Z' });
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate, candidate.id),
      version: candidate,
      readiness: lexicalReadiness(),
    });

    expect(journey.stages[1]?.state).toBe('COMPLETE');
    expect(journey.stages[2]?.state).toBe('CURRENT');
    expect(journey.semanticReady).toBe(false);
    expect(journey.semanticBlocker).toContain('关键词检索');
    expect(journey.nextAction).toBe('REBUILD_INDEX');
  });

  it('reports completion with full hybrid coverage without requiring rerank', () => {
    const candidate = version({ publishedAt: '2026-07-29T02:00:00.000Z' });
    const readiness = lexicalReadiness({
      semanticCoverage: 1,
      embeddedChunkCount: 2,
      retrievalMode: 'HYBRID',
      degradedReason: null,
      embedding: {
        status: 'READY',
        provider: 'openai_compatible',
        model: 'embedding-model',
        dimensions: 1536,
      },
    });
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate, candidate.id),
      version: candidate,
      readiness,
    });

    expect(isSemanticIndexReady(readiness)).toBe(true);
    expect(journey.stages.every(({ state }) => state === 'COMPLETE')).toBe(true);
    expect(journey.nextAction).toBe('NONE');
  });
});

function version(
  overrides: Partial<KnowledgeDocumentVersionSummary> = {},
): KnowledgeDocumentVersionSummary {
  return {
    id: '00000000-0000-7000-8000-000000000201',
    versionNumber: 2,
    sourceType: 'MARKDOWN',
    mimeType: 'text/markdown',
    fileName: null,
    checksum: 'a'.repeat(64),
    status: 'READY',
    changeSummary: null,
    chunkCount: 2,
    createdAt: '2026-07-29T00:00:00.000Z',
    publishedAt: null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    sourceUri: null,
    parserName: 'markdown-v1',
    parseQualityScore: 1,
    parseReviewStatus: 'NOT_REQUIRED',
    parseReviewRevision: 1,
    parseReviewedById: null,
    parseReviewedAt: null,
    parseReviewNote: null,
    parseDiagnostics: {},
    governance: testKnowledgeGovernance(),
    ingestionJob: null,
    ...overrides,
  };
}

function document(
  candidate: KnowledgeDocumentVersionSummary,
  currentVersionId: string | null = null,
): KnowledgeDocumentSummary {
  return {
    id: '00000000-0000-7000-8000-000000000101',
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    folderId: null,
    folderPath: null,
    title: '员工制度',
    sourceType: candidate.sourceType,
    mimeType: candidate.mimeType,
    fileName: candidate.fileName,
    checksum: candidate.checksum,
    status: currentVersionId === null ? 'DRAFT' : 'READY',
    documentVersion: candidate.versionNumber,
    currentVersionId,
    versions: [candidate],
    updatedAt: '2026-07-29T02:00:00.000Z',
  };
}

function lexicalReadiness(
  overrides: Partial<KnowledgeBaseIndexReadiness> = {},
): KnowledgeBaseIndexReadiness {
  return {
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    documents: { total: 1, ready: 1, failed: 0, processing: 0, draft: 0, archived: 0 },
    publishedChunkCount: 2,
    embeddedChunkCount: 0,
    semanticCoverage: 0,
    embedding: { status: 'DISABLED', provider: 'disabled', model: null, dimensions: 1536 },
    rerank: { status: 'DISABLED', provider: 'disabled', model: null, dimensions: null },
    retrievalMode: 'LEXICAL',
    degradedReason: 'EMBEDDING_DISABLED',
    ...overrides,
  };
}
