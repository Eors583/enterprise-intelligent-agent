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

describe('release Evaluation Run selector integration', () => {
  it('binds Role publication to the exact Agent Version identity', () => {
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

    expect(pickerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'AGENT_VERSION',
        subjectId: VERSION_ID,
        subjectVersion: 7,
      }),
    );
  });

  it('binds Knowledge publication to the exact document-version identity', async () => {
    const dom = await renderInTestDom(
      createElement(KnowledgeDocumentsPanel, {
        item: knowledgeBase(),
        onCreateDocument: vi.fn(),
        onEditDocument: vi.fn(),
        onChanged: vi.fn(),
      }),
    );
    try {
      const publish = [...dom.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '发布',
      );
      expect(publish).not.toBeUndefined();
      if (publish) await dom.click(publish);
      expect(pickerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: 'KNOWLEDGE_VERSION',
          subjectId: VERSION_ID,
          subjectVersion: 2,
        }),
      );
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
    version: 1,
    orgUnitIds: [],
    orgUnitScopes: [],
    documentCount: 1,
    updatedAt: '2026-07-28T00:00:00.000Z',
    documents: [
      {
        id: '00000000-0000-7000-8000-000000000100',
        knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
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
