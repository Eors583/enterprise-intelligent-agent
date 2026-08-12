import { describe, expect, it } from 'vitest';

import {
  classifyKnowledgeReadinessDocument,
  deriveKnowledgeBaseIndexReadiness,
  type KnowledgeReadinessDocumentState,
} from './knowledge-readiness.js';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000001';

describe('knowledge readiness', () => {
  it('prioritizes a failed or running latest version over an older published version', () => {
    expect(
      classifyKnowledgeReadinessDocument(
        document({
          currentVersionStatus: 'READY',
          currentChunkCount: 2,
          latestVersionStatus: 'FAILED',
          latestIngestionStatus: 'FAILED',
        }),
      ),
    ).toBe('failed');
    expect(
      classifyKnowledgeReadinessDocument(
        document({
          currentVersionStatus: 'READY',
          currentChunkCount: 2,
          latestVersionStatus: 'PROCESSING',
          latestIngestionStatus: 'RUNNING',
        }),
      ),
    ).toBe('processing');
  });

  it('reports hybrid retrieval when published chunks are fully embedded', () => {
    expect(
      deriveKnowledgeBaseIndexReadiness({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        documents: [
          document({ currentVersionStatus: 'READY', currentChunkCount: 3 }),
          document({ documentStatus: 'ARCHIVED', currentChunkCount: 9 }),
        ],
        embeddedChunkCount: 3,
        embedding: {
          status: 'READY',
          provider: 'openai_compatible',
          model: 'embedding-v1',
          dimensions: 1536,
        },
        rerank: {
          status: 'READY',
          provider: 'cohere_compatible',
          model: 'reranker-v1',
          dimensions: null,
        },
      }),
    ).toEqual({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documents: {
        total: 2,
        ready: 1,
        failed: 0,
        processing: 0,
        draft: 0,
        archived: 1,
      },
      publishedChunkCount: 3,
      embeddedChunkCount: 3,
      semanticCoverage: 1,
      embedding: {
        status: 'READY',
        provider: 'openai_compatible',
        model: 'embedding-v1',
        dimensions: 1536,
      },
      rerank: {
        status: 'READY',
        provider: 'cohere_compatible',
        model: 'reranker-v1',
        dimensions: null,
      },
      retrievalMode: 'HYBRID',
      degradedReason: null,
    });
  });

  it('reports safe lexical degradation without exposing provider details', () => {
    const result = deriveKnowledgeBaseIndexReadiness({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documents: [document({ currentVersionStatus: 'READY', currentChunkCount: 4 })],
      embeddedChunkCount: 2,
      embedding: {
        status: 'READY',
        provider: 'openai_compatible',
        model: 'embedding-v1',
        dimensions: 1536,
      },
      rerank: {
        status: 'UNAVAILABLE',
        provider: 'cohere_compatible',
        model: null,
        dimensions: null,
      },
    });

    expect(result).toMatchObject({
      retrievalMode: 'LEXICAL',
      degradedReason: 'EMBEDDING_COVERAGE_INCOMPLETE',
      semanticCoverage: 0.5,
    });
    expect(JSON.stringify(result)).not.toContain('http');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reports document processing and failures without changing available retrieval mode', () => {
    const result = deriveKnowledgeBaseIndexReadiness({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documents: [
        document({
          documentStatus: 'PROCESSING',
          currentVersionStatus: null,
          latestVersionStatus: 'PROCESSING',
          latestIngestionStatus: 'RUNNING',
        }),
        document({
          documentStatus: 'FAILED',
          currentVersionStatus: null,
          latestVersionStatus: 'FAILED',
          latestIngestionStatus: 'FAILED',
        }),
        document({ currentVersionStatus: 'READY', currentChunkCount: 1 }),
      ],
      embeddedChunkCount: 1,
      embedding: {
        status: 'READY',
        provider: 'openai_compatible',
        model: 'embedding-v1',
        dimensions: 1536,
      },
      rerank: {
        status: 'READY',
        provider: 'cohere_compatible',
        model: 'reranker-v1',
        dimensions: null,
      },
    });

    expect(result).toMatchObject({
      documents: { processing: 1, failed: 1, ready: 1 },
      retrievalMode: 'HYBRID',
      degradedReason: null,
    });
  });
});

function document(
  overrides: Partial<KnowledgeReadinessDocumentState> = {},
): KnowledgeReadinessDocumentState {
  return {
    documentStatus: 'READY',
    currentVersionStatus: 'READY',
    currentChunkCount: 1,
    latestVersionStatus: 'READY',
    latestIngestionStatus: 'SUCCEEDED',
    ...overrides,
  };
}
