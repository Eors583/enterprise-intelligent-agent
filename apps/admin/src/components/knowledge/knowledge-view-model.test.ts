import type {
  AdminOrgUnit,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';
import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

import {
  filterKnowledgeDocuments,
  knowledgeBaseReadiness,
  orgUnitPath,
} from './knowledge-view-model';

describe('filterKnowledgeDocuments', () => {
  it('filters by title or file name, source and effective processing status', () => {
    const handbook = document({
      id: '00000000-0000-7000-8000-000000000101',
      title: '员工手册',
      sourceType: 'FILE',
      fileName: 'employee-handbook.pdf',
      status: 'PROCESSING',
      versions: [
        version({
          id: '00000000-0000-7000-8000-000000000201',
          status: 'PROCESSING',
        }),
      ],
    });
    const markdown = document({
      id: '00000000-0000-7000-8000-000000000102',
      title: '报销制度',
      sourceType: 'MARKDOWN',
      fileName: null,
    });
    const deleted = document({
      id: '00000000-0000-7000-8000-000000000103',
      title: '已删除制度',
      status: 'ARCHIVED',
    });

    expect(
      filterKnowledgeDocuments([handbook, markdown], 'handbook', 'FILE', 'PROCESSING'),
    ).toEqual([handbook]);
    expect(filterKnowledgeDocuments([handbook, markdown], '报销', 'MARKDOWN', 'READY')).toEqual([
      markdown,
    ]);
    expect(filterKnowledgeDocuments([handbook, markdown], '', 'TEXT', 'ALL')).toEqual([]);
    expect(filterKnowledgeDocuments([handbook, markdown, deleted], '', 'ALL', 'ALL')).toEqual([
      handbook,
      markdown,
    ]);
  });
});

describe('knowledgeBaseReadiness', () => {
  it('requires a current published READY version with at least one chunk', () => {
    const emptyPublishedVersion = version({
      id: '00000000-0000-7000-8000-000000000211',
      chunkCount: 0,
    });
    const indexedPublishedVersion = version({
      id: '00000000-0000-7000-8000-000000000212',
      chunkCount: 3,
    });
    const documents = [
      document({
        id: '00000000-0000-7000-8000-000000000111',
        currentVersionId: emptyPublishedVersion.id,
        versions: [emptyPublishedVersion],
      }),
      document({
        id: '00000000-0000-7000-8000-000000000112',
        currentVersionId: indexedPublishedVersion.id,
        versions: [indexedPublishedVersion],
      }),
    ];

    expect(knowledgeBaseReadiness(documents)).toEqual({
      ready: true,
      publishedDocumentCount: 2,
      indexedDocumentCount: 1,
    });
    expect(knowledgeBaseReadiness([documents[0]!]).ready).toBe(false);
    expect(
      knowledgeBaseReadiness([
        document({
          id: '00000000-0000-7000-8000-000000000113',
          currentVersionId: null,
          versions: [indexedPublishedVersion],
        }),
      ]).ready,
    ).toBe(false);
  });
});

describe('orgUnitPath', () => {
  it('shows the complete hierarchy for duplicate department names', () => {
    const root = orgUnit({
      id: '00000000-0000-7000-8000-000000000301',
      name: '集团',
      parentId: null,
    });
    const north = orgUnit({
      id: '00000000-0000-7000-8000-000000000302',
      name: '华北',
      parentId: root.id,
    });
    const south = orgUnit({
      id: '00000000-0000-7000-8000-000000000303',
      name: '华南',
      parentId: root.id,
    });
    const northSales = orgUnit({
      id: '00000000-0000-7000-8000-000000000304',
      name: '销售部',
      parentId: north.id,
    });
    const southSales = orgUnit({
      id: '00000000-0000-7000-8000-000000000305',
      name: '销售部',
      parentId: south.id,
    });

    expect(orgUnitPath([root, north, south, northSales, southSales], northSales.id)).toBe(
      '集团 / 华北 / 销售部',
    );
    expect(orgUnitPath([root, north, south, northSales, southSales], southSales.id)).toBe(
      '集团 / 华南 / 销售部',
    );
  });
});

function version(
  overrides: Partial<KnowledgeDocumentVersionSummary> = {},
): KnowledgeDocumentVersionSummary {
  return {
    id: '00000000-0000-7000-8000-000000000200',
    versionNumber: 1,
    sourceType: 'MARKDOWN',
    mimeType: 'text/markdown',
    fileName: null,
    checksum: null,
    status: 'READY',
    changeSummary: null,
    chunkCount: 1,
    createdAt: '2026-07-27T00:00:00.000Z',
    publishedAt: '2026-07-27T00:00:00.000Z',
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    sourceUri: null,
    parserName: 'utf8-markdown-v1',
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

function document(overrides: Partial<KnowledgeDocumentSummary> = {}): KnowledgeDocumentSummary {
  const published = version();
  return {
    id: '00000000-0000-7000-8000-000000000100',
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    folderId: null,
    folderPath: null,
    title: '默认文档',
    sourceType: 'MARKDOWN',
    mimeType: 'text/markdown',
    fileName: null,
    checksum: null,
    status: 'READY',
    documentVersion: 1,
    currentVersionId: published.id,
    versions: [published],
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function orgUnit(overrides: Partial<AdminOrgUnit> = {}): AdminOrgUnit {
  return {
    id: '00000000-0000-7000-8000-000000000300',
    organizationId: '00000000-0000-7000-8000-000000000399',
    parentId: null,
    name: '部门',
    sortOrder: 0,
    status: 'ACTIVE',
    version: 1,
    memberCount: 0,
    source: 'LOCAL',
    ...overrides,
  };
}
