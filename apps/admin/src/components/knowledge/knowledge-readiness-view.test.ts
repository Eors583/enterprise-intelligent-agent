import type { KnowledgeBaseIndexReadiness } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  knowledgeReadinessReasonLabel,
  knowledgeReadinessSummary,
} from './knowledge-readiness-view';

describe('knowledge readiness view', () => {
  it('translates safe blocker codes without exposing upstream error text', () => {
    expect(knowledgeReadinessReasonLabel('DOCUMENTS_PROCESSING')).toBe(
      '仍有文档正在解析或建立索引',
    );
    expect(knowledgeReadinessReasonLabel('DOCUMENTS_FAILED')).toBe('仍有文档解析或索引失败');
    expect(knowledgeReadinessReasonLabel('NO_PUBLISHED_CHUNKS')).toBe('没有已发布且包含切片的文档');
    expect(knowledgeReadinessReasonLabel('EMBEDDING_MODEL_UNAVAILABLE')).toBe(
      'Embedding 模型未配置或不可用',
    );
    expect(knowledgeReadinessReasonLabel('EMBEDDING_COVERAGE_INCOMPLETE')).toBe(
      '当前模型尚未覆盖全部已发布切片',
    );
    expect(knowledgeReadinessReasonLabel('EMBEDDING_PROVIDER_UNAVAILABLE')).toBe(
      'Embedding 服务暂时不可连接',
    );
    expect(knowledgeReadinessReasonLabel('RERANK_DISABLED')).toBe('Reranker 能力未启用');
    expect(knowledgeReadinessReasonLabel('RERANK_PROVIDER_UNAVAILABLE')).toBe(
      'Reranker 服务暂时不可连接',
    );
  });

  it('prioritizes processing and failed documents over the activation summary', () => {
    expect(knowledgeReadinessSummary(readiness({ processing: 1 }))).toBe('PROCESSING');
    expect(knowledgeReadinessSummary(readiness({ failed: 1 }))).toBe('FAILED');
    expect(knowledgeReadinessSummary(readiness({}, true))).toBe('READY');
    expect(knowledgeReadinessSummary(readiness())).toBe('DEGRADED');
  });
});

function readiness(
  documentOverrides: Partial<KnowledgeBaseIndexReadiness['documents']> = {},
  activationAllowed = false,
): KnowledgeBaseIndexReadiness {
  return {
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    documents: {
      total: 0,
      ready: 0,
      failed: 0,
      processing: 0,
      draft: 0,
      archived: 0,
      ...documentOverrides,
    },
    publishedChunkCount: 0,
    embeddedChunkCount: 0,
    semanticCoverage: 0,
    embedding: {
      status: 'DISABLED',
      provider: 'disabled',
      model: null,
      dimensions: 1536,
    },
    rerank: {
      status: 'DISABLED',
      provider: 'disabled',
      model: null,
      dimensions: null,
    },
    retrievalMode: 'LEXICAL',
    degradedReason: 'NO_PUBLISHED_CHUNKS',
    activationAllowed,
    activationBlockers: activationAllowed ? [] : ['NO_PUBLISHED_CHUNKS'],
  };
}
