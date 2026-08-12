import type {
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
  KnowledgeFolder,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

import { knowledgeFolderProcessingSummary } from './knowledge-folder-processing';

describe('knowledgeFolderProcessingSummary', () => {
  it('recursively aggregates completed, processing, failed and waiting documents', () => {
    const summary = knowledgeFolderProcessingSummary(folder('战略'), [
      document('战略', version('READY', 100, 8)),
      document('战略/产品', version('PROCESSING', 60, 0, 'RUNNING')),
      document('战略/市场', version('FAILED', 80, 0, 'FAILED')),
      document('其他', version('READY', 100, 99)),
      document('战略/归档', version('READY', 100, 2), 'ARCHIVED'),
      document('战略/待处理'),
    ]);

    expect(summary).toEqual({
      totalDocuments: 4,
      completedDocuments: 1,
      processingDocuments: 1,
      failedDocuments: 1,
      waitingDocuments: 1,
      chunkCount: 8,
      progress: 40,
      state: 'FAILED',
    });
  });

  it('reports 100 percent only after every document has completed', () => {
    expect(
      knowledgeFolderProcessingSummary(folder('制度'), [
        document('制度', version('READY', 100, 3)),
        document('制度/财务', version('READY', 100, 5)),
      ]),
    ).toMatchObject({
      totalDocuments: 2,
      completedDocuments: 2,
      chunkCount: 8,
      progress: 100,
      state: 'READY',
    });
  });

  it('returns an explicit empty state for a folder without documents', () => {
    expect(knowledgeFolderProcessingSummary(folder('空目录'), [])).toMatchObject({
      totalDocuments: 0,
      progress: 0,
      state: 'EMPTY',
    });
  });
});

function folder(path: string): KnowledgeFolder {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    parentId: null,
    name: path.split('/').at(-1)!,
    path,
    directDocumentCount: 0,
    directChildCount: 0,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function document(
  folderPath: string,
  latest?: KnowledgeDocumentVersionSummary,
  status: KnowledgeDocumentSummary['status'] = latest?.status ?? 'DRAFT',
): KnowledgeDocumentSummary {
  return {
    id: crypto.randomUUID(),
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    folderId: '00000000-0000-7000-8000-000000000010',
    folderPath,
    title: '测试文档',
    sourceType: 'FILE',
    mimeType: 'text/plain',
    fileName: 'test.txt',
    checksum: 'a'.repeat(64),
    status,
    documentVersion: 1,
    currentVersionId: latest?.status === 'READY' ? latest.id : null,
    versions: latest === undefined ? [] : [latest],
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function version(
  status: KnowledgeDocumentVersionSummary['status'],
  progress: number,
  chunkCount: number,
  jobStatus: 'PENDING' | 'RUNNING' | 'FAILED' | 'SUCCEEDED' = status === 'READY'
    ? 'SUCCEEDED'
    : status === 'FAILED'
      ? 'FAILED'
      : 'RUNNING',
): KnowledgeDocumentVersionSummary {
  return {
    id: crypto.randomUUID(),
    versionNumber: 1,
    sourceType: 'FILE',
    mimeType: 'text/plain',
    fileName: 'test.txt',
    checksum: 'a'.repeat(64),
    status,
    changeSummary: null,
    chunkCount,
    createdAt: '2026-08-11T00:00:00.000Z',
    publishedAt: status === 'READY' ? '2026-08-11T00:01:00.000Z' : null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    sourceUri: null,
    parserName: null,
    parseQualityScore: null,
    parseReviewStatus: 'NOT_REQUIRED',
    parseReviewRevision: 0,
    parseReviewedById: null,
    parseReviewedAt: null,
    parseReviewNote: null,
    parseDiagnostics: {},
    governance: testKnowledgeGovernance(),
    ingestionJob: {
      id: crypto.randomUUID(),
      documentVersionId: crypto.randomUUID(),
      status: jobStatus,
      stage: status === 'READY' ? 'READY' : 'CHUNKING',
      progress,
      attempts: 1,
      errorCode: status === 'FAILED' ? 'DOCUMENT_PARSE_FAILED' : null,
      errorMessage: status === 'FAILED' ? '文档解析失败' : null,
      startedAt: '2026-08-11T00:00:00.000Z',
      finishedAt: status === 'READY' || status === 'FAILED' ? '2026-08-11T00:01:00.000Z' : null,
    },
  };
}
