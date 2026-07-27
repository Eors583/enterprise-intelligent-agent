import { describe, expect, it } from 'vitest';

import {
  createKnowledgeBaseRequestSchema,
  knowledgeBaseSchema,
  knowledgeDocumentChunkListResponseSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentSummarySchema,
  knowledgeDocumentVersionDetailSchema,
  rollbackKnowledgeDocumentVersionRequestSchema,
  updateKnowledgeBaseRequestSchema,
} from '../src/index.js';

const ORG_UNIT_ID = '00000000-0000-7000-8000-000000000001';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000003';
const VERSION_ID = '00000000-0000-7000-8000-000000000004';

describe('knowledge administration contracts', () => {
  it('preserves whether a department grant includes descendants', () => {
    const request = createKnowledgeBaseRequestSchema.parse({
      key: 'employee-handbook',
      name: 'Employee handbook',
      orgUnitScopes: [{ orgUnitId: ORG_UNIT_ID, includeChildren: false }],
    });

    expect(request.orgUnitScopes).toEqual([{ orgUnitId: ORG_UNIT_ID, includeChildren: false }]);
    expect(request.orgUnitIds).toEqual([]);
  });

  it('keeps legacy department id updates valid during the API transition', () => {
    expect(
      updateKnowledgeBaseRequestSchema.parse({
        orgUnitIds: [ORG_UNIT_ID],
        expectedVersion: 2,
      }),
    ).toMatchObject({ orgUnitIds: [ORG_UNIT_ID] });
  });

  it('requires explicit descendant semantics in knowledge-base responses', () => {
    const result = knowledgeBaseSchema.safeParse({
      id: '00000000-0000-7000-8000-000000000002',
      key: 'employee-handbook',
      name: 'Employee handbook',
      description: null,
      status: 'ACTIVE',
      version: 1,
      orgUnitIds: [ORG_UNIT_ID],
      orgUnitScopes: [{ orgUnitId: ORG_UNIT_ID, includeChildren: false }],
      documentCount: 0,
      documents: [],
      updatedAt: '2026-07-20T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });

  it('keeps list summaries separate from full document and version content', () => {
    const summary = {
      id: DOCUMENT_ID,
      knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
      title: 'Employee handbook',
      sourceType: 'MARKDOWN',
      mimeType: 'text/markdown',
      fileName: null,
      checksum: null,
      status: 'READY',
      documentVersion: 1,
      currentVersionId: VERSION_ID,
      versions: [],
      updatedAt: '2026-07-20T00:00:00.000Z',
    } as const;

    expect(knowledgeDocumentSummarySchema.parse(summary)).not.toHaveProperty('contentText');
    expect(
      knowledgeDocumentSchema.parse({ ...summary, contentText: '# Full handbook' }),
    ).toHaveProperty('contentText', '# Full handbook');
    expect(
      knowledgeDocumentVersionDetailSchema.parse({
        id: VERSION_ID,
        documentId: DOCUMENT_ID,
        versionNumber: 2,
        sourceType: 'MARKDOWN',
        mimeType: 'text/markdown',
        fileName: null,
        checksum: null,
        status: 'DRAFT',
        changeSummary: null,
        chunkCount: 0,
        createdAt: '2026-07-20T00:00:00.000Z',
        publishedAt: null,
        ingestionJob: null,
        contentText: '# Unpublished draft',
      }),
    ).toMatchObject({ documentId: DOCUMENT_ID, contentText: '# Unpublished draft' });
  });

  it('requires an explicit current publication id for rollback concurrency control', () => {
    expect(
      rollbackKnowledgeDocumentVersionRequestSchema.parse({
        expectedCurrentVersionId: VERSION_ID,
      }),
    ).toEqual({ expectedCurrentVersionId: VERSION_ID });
    expect(rollbackKnowledgeDocumentVersionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('validates paginated chunk previews and semantic coverage metadata', () => {
    expect(
      knowledgeDocumentChunkListResponseSchema.parse({
        documentVersionId: VERSION_ID,
        total: 2,
        offset: 0,
        limit: 50,
        embeddedChunkCount: 1,
        semanticCoverage: 0.5,
        items: [
          {
            id: '00000000-0000-7000-8000-000000000005',
            chunkIndex: 0,
            headingPath: ['Benefits', 'Leave'],
            content: 'Employees receive annual leave.',
            tokenCount: 8,
            contentHash: 'a'.repeat(64),
            pageStart: 3,
            pageEnd: 4,
            embeddingModels: ['embedding-v1'],
          },
        ],
      }),
    ).toMatchObject({
      total: 2,
      embeddedChunkCount: 1,
      semanticCoverage: 0.5,
    });

    expect(
      knowledgeDocumentChunkListResponseSchema.safeParse({
        documentVersionId: VERSION_ID,
        total: 0,
        offset: 0,
        limit: 101,
        embeddedChunkCount: 0,
        semanticCoverage: 0,
        items: [],
      }).success,
    ).toBe(false);
  });
});
