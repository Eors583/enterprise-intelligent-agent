import type { KnowledgeBaseIndexReadiness, KnowledgeGraphOverview } from '@enterprise/contracts';
import { createElement } from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const api = vi.hoisted(() => ({
  getKnowledgeBaseReadiness: vi.fn(),
  getKnowledgeGraphOverview: vi.fn(),
}));
vi.mock('@/api/admin-api', () => api);

import { KnowledgeReadinessPanel } from './KnowledgeReadinessPanel';

beforeEach(() => {
  api.getKnowledgeBaseReadiness.mockReset();
  api.getKnowledgeGraphOverview.mockReset();
  api.getKnowledgeGraphOverview.mockResolvedValue(graphOverview());
});

describe('KnowledgeReadinessPanel', () => {
  it('rechecks an unavailable runtime and replaces stale LEXICAL state after recovery', async () => {
    let resolveInitialReadiness: (value: KnowledgeBaseIndexReadiness) => void = () => undefined;
    api.getKnowledgeBaseReadiness
      .mockImplementationOnce(
        () =>
          new Promise<KnowledgeBaseIndexReadiness>((resolve) => {
            resolveInitialReadiness = resolve;
          }),
      )
      .mockResolvedValueOnce(hybridReadiness());

    const onReadinessChange = vi.fn();
    const dom = await renderInTestDom(
      createElement(KnowledgeReadinessPanel, {
        knowledgeBaseId: knowledgeBaseId,
        refreshToken: 'documents-stable',
        onReadinessChange,
        onGraphOverviewChange: vi.fn(),
        onReviewFailures: vi.fn(),
      }),
    );
    Object.defineProperty(dom.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    const originalSetTimeout = window.setTimeout.bind(window);
    let recoveryPoll: (() => void) | null = null;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5_000 && typeof handler === 'function') {
        recoveryPoll = () => handler(...args);
        return 5_000;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;

    try {
      await act(async () => {
        resolveInitialReadiness(unavailableReadiness());
        await Promise.resolve();
        await Promise.resolve();
      });
      await dom.flush();

      expect(dom.container.textContent).toContain('关键词检索可用');
      expect(dom.container.textContent).toContain('LEXICAL');
      expect(recoveryPoll).not.toBeNull();

      await act(async () => {
        recoveryPoll!();
        await Promise.resolve();
        await Promise.resolve();
      });
      await dom.flush();

      expect(api.getKnowledgeBaseReadiness).toHaveBeenCalledTimes(2);
      expect(dom.container.textContent).toContain('混合检索可用');
      expect(dom.container.textContent).toContain('HYBRID');
      expect(dom.container.textContent).not.toContain('Embedding 服务暂时不可连接');
      expect(onReadinessChange).toHaveBeenLastCalledWith(hybridReadiness());
    } finally {
      window.setTimeout = originalSetTimeout;
      await dom.cleanup();
    }
  });
});

const knowledgeBaseId = '00000000-0000-7000-8000-000000000001';

function unavailableReadiness(): KnowledgeBaseIndexReadiness {
  return {
    ...hybridReadiness(),
    embedding: {
      status: 'UNAVAILABLE',
      provider: 'local_fastembed',
      model: null,
      dimensions: 1536,
    },
    rerank: {
      status: 'UNAVAILABLE',
      provider: 'local_fastembed',
      model: null,
      dimensions: null,
    },
    retrievalMode: 'LEXICAL',
    degradedReason: 'EMBEDDING_PROVIDER_UNAVAILABLE',
  };
}

function hybridReadiness(): KnowledgeBaseIndexReadiness {
  return {
    knowledgeBaseId,
    documents: { total: 1, ready: 1, failed: 0, processing: 0, draft: 0, archived: 0 },
    publishedChunkCount: 4,
    embeddedChunkCount: 4,
    semanticCoverage: 1,
    embedding: {
      status: 'READY',
      provider: 'local_fastembed',
      model: 'local-fastembed:bge-small-zh',
      dimensions: 1536,
    },
    rerank: {
      status: 'READY',
      provider: 'local_fastembed',
      model: 'local-fastembed:bge-reranker-base',
      dimensions: null,
    },
    retrievalMode: 'HYBRID',
    degradedReason: null,
  };
}

function graphOverview(): KnowledgeGraphOverview {
  return {
    knowledgeBaseId,
    status: 'READY',
    entityCount: 1,
    relationCount: 0,
    mentionCount: 1,
    evidenceCount: 0,
    orphanEntityCount: 1,
    relationsWithoutEvidenceCount: 0,
    publishedChunkCount: 4,
    linkedChunkCount: 1,
    mentionCoverage: 0.25,
    evidenceCoverage: 0,
    entityTypes: [{ type: 'POLICY', count: 1 }],
    relationTypes: [],
    diagnostics: [],
    lastBuiltAt: '2026-08-10T00:00:00.000Z',
  };
}
