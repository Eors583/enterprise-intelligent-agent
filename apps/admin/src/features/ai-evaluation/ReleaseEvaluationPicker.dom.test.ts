import type { KnowledgeBase, RoleBlueprint, RoleVersion } from '@enterprise/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';
import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

const { pickerMock } = vi.hoisted(() => ({ pickerMock: vi.fn() }));
vi.mock('./PassingEvaluationRunSelect', () => ({
  PassingEvaluationRunSelect: (props: unknown) => {
    pickerMock(props);
    return null;
  },
}));

import { KnowledgeDocumentsPanel } from '@/components/knowledge/KnowledgeDocumentsPanel';
import { RoleVersionTransitionModal } from '@/features/role-blueprints/RoleVersionModals';

const VERSION_ID = '00000000-0000-7000-8000-000000000201';

beforeEach(() => pickerMock.mockReset());

describe('optional evaluation integration', () => {
  it('does not require an Evaluation Run selector for Role publication', () => {
    const version = {
      id: VERSION_ID,
      version: 7,
      revision: 4,
      status: 'TESTING',
      reviewStatus: 'APPROVED',
    } as RoleVersion;
    const blueprint = {
      id: '00000000-0000-7000-8000-000000000101',
      name: '销售负责人',
    } as RoleBlueprint;

    renderToStaticMarkup(
      createElement(RoleVersionTransitionModal, {
        blueprint,
        version,
        action: 'publish',
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(pickerMock).not.toHaveBeenCalled();
  });

  it('keeps knowledge publication and technical repair actions out of the ordinary document UI', async () => {
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
      const labels = [...dom.container.querySelectorAll('button')].map((button) =>
        button.textContent?.trim(),
      );
      expect(labels).not.toContain('发布');
      expect(labels).not.toContain('重建向量');
      expect(labels).not.toContain('重建关系');
      expect(labels).not.toContain('查看切片');
      expect(labels).not.toContain('结构化预览');
      expect(labels).toContain('权限变更');
      expect(pickerMock).not.toHaveBeenCalled();
      expect(dom.container.textContent).toContain('当前可用');
      expect(
        dom.container
          .querySelector('.knowledge-document-status-stack')
          ?.querySelectorAll('.status-pill'),
      ).toHaveLength(1);
    } finally {
      await dom.cleanup();
    }
  });

  it('shows only one status when the latest document version is already current', async () => {
    const item = knowledgeBase();
    const document = item.documents[0]!;
    document.versions = document.versions.filter(
      (version) => version.id === document.currentVersionId,
    );
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentsPanel, {
        item,
        organization: null,
        organizationReady: false,
        onCreateDocument: vi.fn(),
        onEditDocument: vi.fn(),
        onChanged: vi.fn(),
      }),
    );
    try {
      const statusStack = dom.container.querySelector('.knowledge-document-status-stack');
      expect(statusStack?.querySelectorAll('.status-pill')).toHaveLength(1);
      expect(statusStack?.textContent).toContain('当前可用 v1');
      expect(statusStack?.textContent).not.toContain('最新 v1 · 可用');
    } finally {
      await dom.cleanup();
    }
  });
});

function knowledgeBase(): KnowledgeBase {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    key: 'sales',
    name: '销售知识库',
    description: null,
    status: 'ACTIVE',
    space: {
      type: 'DEPARTMENT',
      targetId: '00000000-0000-7000-8000-000000000099',
      targetName: '销售部',
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
    documentCount: 1,
    folders: [],
    updatedAt: '2026-07-28T00:00:00.000Z',
    documents: [
      {
        id: '00000000-0000-7000-8000-000000000100',
        knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
        folderId: null,
        folderPath: null,
        title: '销售手册',
        sourceType: 'FILE',
        mimeType: 'application/pdf',
        fileName: 'sales.pdf',
        checksum: 'a'.repeat(64),
        status: 'READY',
        documentVersion: 1,
        currentVersionId: '00000000-0000-7000-8000-000000000200',
        updatedAt: '2026-07-28T00:00:00.000Z',
        versions: [
          {
            id: '00000000-0000-7000-8000-000000000200',
            versionNumber: 1,
            sourceType: 'FILE',
            mimeType: 'application/pdf',
            fileName: 'sales.pdf',
            checksum: 'a'.repeat(64),
            status: 'READY',
            changeSummary: null,
            chunkCount: 2,
            createdAt: '2026-07-27T00:00:00.000Z',
            publishedAt: '2026-07-27T01:00:00.000Z',
            evaluationRunId: '00000000-0000-7000-8000-000000000300',
            evaluationDatasetVersionId: '00000000-0000-7000-8000-000000000301',
            evaluationSnapshotHash: 'b'.repeat(64),
            sourceUri: null,
            parserName: 'pdf-parse-v2',
            parseQualityScore: 0.98,
            parseReviewStatus: 'APPROVED',
            parseReviewRevision: 2,
            parseReviewedById: '00000000-0000-7000-8000-000000000302',
            parseReviewedAt: '2026-07-27T00:30:00.000Z',
            parseReviewNote: null,
            parseDiagnostics: {},
            governance: testKnowledgeGovernance(),
            ingestionJob: null,
          },
          {
            id: VERSION_ID,
            versionNumber: 2,
            sourceType: 'FILE',
            mimeType: 'application/pdf',
            fileName: 'sales-v2.pdf',
            checksum: 'c'.repeat(64),
            status: 'READY',
            changeSummary: '修订价格规则',
            chunkCount: 3,
            createdAt: '2026-07-28T00:00:00.000Z',
            publishedAt: null,
            evaluationRunId: null,
            evaluationDatasetVersionId: null,
            evaluationSnapshotHash: null,
            sourceUri: null,
            parserName: 'pdf-parse-v2',
            parseQualityScore: 0.95,
            parseReviewStatus: 'APPROVED',
            parseReviewRevision: 2,
            parseReviewedById: '00000000-0000-7000-8000-000000000302',
            parseReviewedAt: '2026-07-28T00:30:00.000Z',
            parseReviewNote: null,
            parseDiagnostics: {},
            governance: testKnowledgeGovernance(),
            ingestionJob: null,
          },
        ],
      },
    ],
  };
}
