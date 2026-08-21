import type { KnowledgeBase, KnowledgeDocumentSummary } from '@enterprise/contracts';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

import { KnowledgeDocumentsPanel } from './KnowledgeDocumentsPanel';

describe('KnowledgeDocumentsPanel folder progress', () => {
  it('shows recursive chunking progress and a visible anomaly count on the folder card', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentsPanel, {
        item: knowledgeBase(),
        organization: null,
        organizationReady: false,
        onCreateDocument: vi.fn(),
        onEditDocument: vi.fn(),
        onChanged: vi.fn(),
      }),
    );

    try {
      expect(dom.container.textContent).toContain('切片与索引');
      expect(dom.container.textContent).toContain('50%');
      expect(dom.container.textContent).toContain('1 个异常');
      expect(dom.container.textContent).toContain('1/2');
      expect(dom.container.textContent).toContain('6 个切片');
      const folderCard = dom.container.querySelector('.knowledge-folder-card');
      expect(folderCard?.getAttribute('aria-label')).toContain('切片与索引进度50%');
      expect(folderCard?.classList.contains('failed')).toBe(true);
    } finally {
      await dom.cleanup();
    }
  });
});

function knowledgeBase(): KnowledgeBase {
  const folderId = '00000000-0000-7000-8000-000000000010';
  return {
    id: '00000000-0000-7000-8000-000000000001',
    key: 'enterprise',
    name: '企业知识库',
    description: null,
    status: 'ACTIVE',
    space: {
      type: 'COMPANY',
      targetId: '00000000-0000-7000-8000-000000000099',
      targetName: '示例企业',
    },
    version: 1,
    retrievalConfig: {
      mode: 'HYBRID',
      topK: 8,
      scoreThreshold: 0.08,
      semanticWeight: 0.7,
      keywordWeight: 0.3,
      rerankEnabled: true,
      relationshipRetrievalEnabled: true,
      maxChunksPerDocument: 3,
    },
    chunkingConfig: { targetTokens: 500, overlapTokens: 80 },
    activeEmbeddingIndexVersion: null,
    pendingEmbeddingIndexVersion: null,
    orgUnitIds: [],
    orgUnitScopes: [],
    memberUserIds: [],
    documentCount: 2,
    folders: [
      {
        id: folderId,
        knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
        parentId: null,
        name: '战略资料',
        path: '战略资料',
        directDocumentCount: 1,
        directChildCount: 1,
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      },
    ],
    documents: [
      document(folderId, '战略资料', 'READY', 6, 100),
      document(folderId, '战略资料/市场', 'FAILED', 0, 70),
    ],
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function document(
  folderId: string,
  folderPath: string,
  status: 'READY' | 'FAILED',
  chunkCount: number,
  progress: number,
): KnowledgeDocumentSummary {
  const versionId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    folderId,
    folderPath,
    title: '战略文档',
    sourceType: 'FILE',
    mimeType: 'text/plain',
    fileName: 'strategy.txt',
    checksum: 'a'.repeat(64),
    status,
    documentVersion: 1,
    currentVersionId: status === 'READY' ? versionId : null,
    versions: [
      {
        id: versionId,
        versionNumber: 1,
        sourceType: 'FILE',
        mimeType: 'text/plain',
        fileName: 'strategy.txt',
        checksum: 'a'.repeat(64),
        status,
        changeSummary: null,
        chunkCount,
        createdAt: '2026-08-11T00:00:00.000Z',
        publishedAt: status === 'READY' ? '2026-08-11T00:01:00.000Z' : null,
        ingestionJob: {
          status: status === 'READY' ? 'SUCCEEDED' : 'FAILED',
          stage: status === 'READY' ? 'READY' : 'CHUNKING',
          progress,
          errorCode: status === 'FAILED' ? 'DOCUMENT_PARSE_FAILED' : null,
          errorMessage: status === 'FAILED' ? '文档解析失败' : null,
        },
      },
    ],
    updatedAt: '2026-08-11T00:00:00.000Z',
  } as KnowledgeDocumentSummary;
}
