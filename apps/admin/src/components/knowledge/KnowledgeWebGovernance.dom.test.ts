import type { KnowledgeBase, KnowledgeDocumentVersionDetail } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

const api = vi.hoisted(() => ({
  importKnowledgeWebDocument: vi.fn(),
  listPendingKnowledgeParseReviews: vi.fn(),
  reviewKnowledgeDocumentParse: vi.fn(),
}));

vi.mock('@/api/admin-api', () => api);

import { KnowledgeParseReviewPanel } from './KnowledgeParseReviewPanel';
import { KnowledgeWebImportModal } from './KnowledgeWebImportModal';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000001';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000002';
const VERSION_ID = '00000000-0000-7000-8000-000000000003';

beforeEach(() => {
  vi.clearAllMocks();
  api.importKnowledgeWebDocument.mockResolvedValue({});
  api.reviewKnowledgeDocumentParse.mockResolvedValue({});
  api.listPendingKnowledgeParseReviews.mockResolvedValue({ items: [pendingVersion()] });
});

describe('knowledge web import and parse review UI', () => {
  it('submits only URL metadata and explains that original HTML is not echoed', async () => {
    const onImported = vi.fn();
    const dom = await renderInTestDom(
      createElement(KnowledgeWebImportModal, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        onClose: vi.fn(),
        onImported,
      }),
    );
    try {
      expect(dom.container.textContent).toContain('原始 HTML 仅写入对象存储');
      expect(dom.container.textContent).toContain('文档标题（可选）');
      const url = dom.container.querySelector('input[type="url"]') as HTMLInputElement;
      await dom.change(url, 'https://docs.example.com/security');
      await dom.submit(dom.container.querySelector('form') as HTMLFormElement);

      expect(api.importKnowledgeWebDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, {
        url: 'https://docs.example.com/security',
      });
      expect(onImported).toHaveBeenCalledOnce();
    } finally {
      await dom.cleanup();
    }
  });

  it('shows quality diagnostics and requires a rejection reason', async () => {
    const onChanged = vi.fn();
    const dom = await renderInTestDom(
      createElement(KnowledgeParseReviewPanel, {
        item: knowledgeBase(),
        onChanged,
      }),
    );
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('质量分 42%');
      expect(dom.container.textContent).toContain('https://docs.example.com/security');
      expect(dom.container.textContent).toContain('linkedom-v0.18');
      expect(dom.container.textContent).toContain('CONTENT_TOO_SHORT');
      const review = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '复核',
      );
      expect(review).not.toBeUndefined();
      if (review) await dom.click(review);
      const reject = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '驳回',
      ) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      const note = dom.container.querySelector('textarea') as HTMLTextAreaElement;
      await dom.change(note, '正文过短，表格未解析。');
      expect(reject.disabled).toBe(false);
      await dom.click(reject);

      expect(api.reviewKnowledgeDocumentParse).toHaveBeenCalledWith(
        KNOWLEDGE_BASE_ID,
        DOCUMENT_ID,
        VERSION_ID,
        {
          decision: 'REJECT',
          expectedReviewRevision: 2,
          note: '正文过短，表格未解析。',
        },
      );
    } finally {
      await dom.cleanup();
    }
  });
});

function knowledgeBase(): KnowledgeBase {
  return {
    id: KNOWLEDGE_BASE_ID,
    key: 'policy',
    name: '制度库',
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
    documentCount: 0,
    folders: [],
    documents: [],
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

function pendingVersion(): KnowledgeDocumentVersionDetail {
  return {
    id: VERSION_ID,
    documentId: DOCUMENT_ID,
    versionNumber: 1,
    sourceType: 'WEB',
    mimeType: 'text/html',
    fileName: null,
    checksum: 'a'.repeat(64),
    status: 'READY',
    changeSummary: null,
    chunkCount: 1,
    createdAt: '2026-07-28T00:00:00.000Z',
    publishedAt: null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    sourceUri: 'https://docs.example.com/security',
    parserName: 'linkedom-v0.18',
    parseQualityScore: 0.42,
    parseReviewStatus: 'PENDING',
    parseReviewRevision: 2,
    parseReviewedById: null,
    parseReviewedAt: null,
    parseReviewNote: null,
    parseDiagnostics: { lowQualityReasons: ['CONTENT_TOO_SHORT'] },
    governance: testKnowledgeGovernance({
      reviewStatus: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
    }),
    ingestionJob: null,
    contentText: null,
    graphProjectionId: null,
    graphProjectionStatus: null,
    graphProjectionHash: null,
  };
}
