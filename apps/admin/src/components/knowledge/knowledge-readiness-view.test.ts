import type { KnowledgeBaseIndexReadiness } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  knowledgeCapabilityRecoveryPollingRequired,
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

  it('prioritizes processing and failed documents over the retrieval summary', () => {
    expect(knowledgeReadinessSummary(readiness({ processing: 1 }))).toBe('PROCESSING');
    expect(knowledgeReadinessSummary(readiness({ failed: 1 }))).toBe('FAILED');
    expect(knowledgeReadinessSummary(readiness({}, 'HYBRID'))).toBe('READY');
    expect(knowledgeReadinessSummary(readiness())).toBe('DEGRADED');
  });

  it('automatically rechecks transient capability failures until the runtime recovers', () => {
    expect(
      knowledgeCapabilityRecoveryPollingRequired({
        ...readiness(),
        embedding: {
          status: 'UNAVAILABLE',
          provider: 'local_fastembed',
          model: null,
          dimensions: 1536,
        },
      }),
    ).toBe(true);
    expect(
      knowledgeCapabilityRecoveryPollingRequired({
        ...readiness(),
        rerank: {
          status: 'NOT_READY',
          provider: 'local_fastembed',
          model: null,
          dimensions: null,
        },
      }),
    ).toBe(true);
    expect(
      knowledgeCapabilityRecoveryPollingRequired({
        ...readiness({ processing: 1 }),
        embedding: {
          status: 'UNAVAILABLE',
          provider: 'local_fastembed',
          model: null,
          dimensions: 1536,
        },
      }),
    ).toBe(false);
    expect(
      knowledgeCapabilityRecoveryPollingRequired({
        ...readiness({}, 'HYBRID'),
        embedding: {
          status: 'READY',
          provider: 'local_fastembed',
          model: 'bge-small-zh',
          dimensions: 1536,
        },
        rerank: {
          status: 'READY',
          provider: 'local_fastembed',
          model: 'bge-reranker-base',
          dimensions: null,
        },
        degradedReason: null,
      }),
    ).toBe(false);
  });
});

function readiness(
  documentOverrides: Partial<KnowledgeBaseIndexReadiness['documents']> = {},
  retrievalMode: KnowledgeBaseIndexReadiness['retrievalMode'] = 'LEXICAL',
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
    retrievalMode,
    degradedReason: 'NO_PUBLISHED_CHUNKS',
  };
}
