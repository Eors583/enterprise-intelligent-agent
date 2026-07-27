import type { KnowledgeDocumentVersionSummary } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  knowledgeVersionAction,
  knowledgeVersionFailure,
  latestEditableDraft,
} from './knowledge-ingestion-outcome';

describe('knowledgeVersionFailure', () => {
  it('turns a synchronously returned failed upload into a visible safe error', () => {
    expect(
      knowledgeVersionFailure(
        version({
          status: 'FAILED',
          ingestionJob: {
            id: '00000000-0000-7000-8000-000000000101',
            documentVersionId: '00000000-0000-7000-8000-000000000102',
            stage: 'PARSING',
            status: 'FAILED',
            progress: 30,
            attempts: 1,
            errorCode: 'DOCUMENT_PARSE_FAILED',
            errorMessage: '文档解析失败，请确认文件未损坏。',
            startedAt: '2026-07-20T00:00:00.000Z',
            finishedAt: '2026-07-20T00:00:01.000Z',
          },
        }),
      ),
    ).toBe('处理失败（DOCUMENT_PARSE_FAILED）：文档解析失败，请确认文件未损坏。');
  });

  it('does not report successful or still-running ingestion as success failures', () => {
    expect(knowledgeVersionFailure(version({ status: 'READY' }))).toBeNull();
    expect(knowledgeVersionFailure(version({ status: 'PROCESSING' }))).toBeNull();
  });

  it('selects the newest draft after the current published version', () => {
    const published = version({
      id: '00000000-0000-7000-8000-000000000103',
      versionNumber: 2,
      status: 'READY',
    });
    const oldDraft = version({
      id: '00000000-0000-7000-8000-000000000104',
      versionNumber: 1,
      status: 'DRAFT',
    });
    const newestDraft = version({
      id: '00000000-0000-7000-8000-000000000105',
      versionNumber: 3,
      status: 'DRAFT',
    });

    expect(
      latestEditableDraft({
        currentVersionId: published.id,
        versions: [oldDraft, newestDraft, published],
      }),
    ).toEqual(newestDraft);
  });

  it('offers publish for drafts and rollback only for non-current ready versions', () => {
    const current = version({ id: '00000000-0000-7000-8000-000000000106' });
    const historical = version({ id: '00000000-0000-7000-8000-000000000107' });
    const draft = version({
      id: '00000000-0000-7000-8000-000000000108',
      versionNumber: 3,
      status: 'DRAFT',
    });

    const document = { currentVersionId: current.id, versions: [current, historical, draft] };
    expect(knowledgeVersionAction(document, current)).toBeNull();
    expect(knowledgeVersionAction(document, historical)).toBe('rollback');
    expect(knowledgeVersionAction(document, draft)).toBe('publish');
    expect(
      knowledgeVersionAction({ currentVersionId: null, versions: [historical] }, historical),
    ).toBeNull();
    expect(
      knowledgeVersionAction(
        document,
        version({
          id: '00000000-0000-7000-8000-000000000109',
          versionNumber: current.versionNumber,
          status: 'DRAFT',
        }),
      ),
    ).toBeNull();
  });
});

function version(
  overrides: Partial<KnowledgeDocumentVersionSummary>,
): KnowledgeDocumentVersionSummary {
  return {
    id: '00000000-0000-7000-8000-000000000102',
    versionNumber: 2,
    sourceType: 'FILE',
    mimeType: 'text/plain',
    fileName: 'policy.txt',
    checksum: null,
    status: 'READY',
    changeSummary: null,
    chunkCount: 1,
    createdAt: '2026-07-20T00:00:00.000Z',
    publishedAt: null,
    ingestionJob: null,
    ...overrides,
  };
}
