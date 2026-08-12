import { describe, expect, it } from 'vitest';

import { knowledgePublicEventSchema } from '../src/index.js';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000001';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000002';
const VERSION_ID = '00000000-0000-7000-8000-000000000003';

describe('knowledge public event contracts', () => {
  it('accepts a versioned document publication event', () => {
    expect(
      knowledgePublicEventSchema.parse({
        eventType: 'knowledge.document-version.published.v1',
        payload: {
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentId: DOCUMENT_ID,
          documentVersionId: VERSION_ID,
          version: 3,
          graphProjectionId: null,
          graphHash: null,
          publishedAt: '2026-08-06T04:00:00.000Z',
        },
      }),
    ).toMatchObject({ eventType: 'knowledge.document-version.published.v1' });
  });

  it('rejects incompatible payloads instead of silently changing an event version', () => {
    expect(() =>
      knowledgePublicEventSchema.parse({
        eventType: 'knowledge.document-version.published.v1',
        payload: {
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentId: DOCUMENT_ID,
          documentVersionId: VERSION_ID,
          version: 0,
          publishedAt: 'not-a-timestamp',
        },
      }),
    ).toThrow();
  });

  it('requires failed synchronizations to carry a non-zero failure count', () => {
    expect(() =>
      knowledgePublicEventSchema.parse({
        eventType: 'knowledge.source-sync.failed.v1',
        payload: {
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          connectorId: DOCUMENT_ID,
          runId: VERSION_ID,
          discoveredCount: 1,
          createdCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          deletedCount: 0,
          failedCount: 0,
        },
      }),
    ).toThrow();
  });
});
