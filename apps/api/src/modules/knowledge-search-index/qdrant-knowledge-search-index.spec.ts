import { describe, expect, it, vi } from 'vitest';

import { QdrantKnowledgeSearchIndex } from './qdrant-knowledge-search-index.js';

describe('QdrantKnowledgeSearchIndex', () => {
  it('creates an isolated collection with the index-version dimension', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ url, method, body });
      if (method === 'GET') return response({ status: 'not_found' }, 404);
      return response({ status: 'ok', result: {} });
    });
    const index = new QdrantKnowledgeSearchIndex({
      baseUrl: 'http://127.0.0.1:6333',
      collection: 'legacy_collection',
      dimensions: 1_536,
      timeoutMs: 1_000,
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    await index.replaceDocumentVersion({
      profile: {
        indexVersionId: '00000000-0000-7000-8000-000000000010',
        collectionName: 'knowledge_kb_v2_d768',
        dimensions: 768,
        distance: 'COSINE',
      },
      tenantId: '00000000-0000-7000-8000-000000000001',
      documentVersionId: '00000000-0000-7000-8000-000000000006',
      active: false,
      chunks: [
        {
          chunkId: '00000000-0000-7000-8000-000000000007',
          tenantId: '00000000-0000-7000-8000-000000000001',
          knowledgeBaseId: '00000000-0000-7000-8000-000000000003',
          documentId: '00000000-0000-7000-8000-000000000005',
          documentVersionId: '00000000-0000-7000-8000-000000000006',
          title: '制度',
          headingPath: ['第一章'],
          content: '差旅标准',
          contentHash: 'a'.repeat(64),
          classification: 'INTERNAL',
          governanceHash: 'b'.repeat(64),
          updatedAt: '2026-08-06T00:00:00.000Z',
          vector: Array<number>(768).fill(0.1),
        },
      ],
    });

    const collectionCreate = requests.find(
      (request) => request.method === 'PUT' && request.url.endsWith('/knowledge_kb_v2_d768'),
    );
    expect(collectionCreate?.body).toMatchObject({
      vectors: { dense: { size: 768, distance: 'Cosine' } },
    });
    const upsert = requests.find((request) => request.url.includes('/points?wait=true'));
    expect(upsert?.body).toMatchObject({
      points: [
        {
          payload: {
            embedding_index_version_id: '00000000-0000-7000-8000-000000000010',
          },
        },
      ],
    });
  });

  it('writes 129 chunks as two ordered wait=true batches', async () => {
    const requests: Array<{ url: string; body: { points?: unknown[] } }> = [];
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        body: init?.body === undefined ? {} : JSON.parse(String(init.body)),
      });
      return (init?.method ?? 'GET') === 'GET'
        ? response({ status: 'not_found' }, 404)
        : response({ status: 'ok', result: {} });
    });
    const index = new QdrantKnowledgeSearchIndex({
      baseUrl: 'http://127.0.0.1:6333',
      collection: 'knowledge',
      dimensions: 1,
      timeoutMs: 1_000,
      fetchImplementation: fetchImplementation as typeof fetch,
    });
    const tenantId = '00000000-0000-7000-8000-000000000001';
    const documentVersionId = '00000000-0000-7000-8000-000000000006';

    await index.replaceDocumentVersion({
      profile: {
        indexVersionId: '00000000-0000-7000-8000-000000000010',
        collectionName: 'knowledge',
        dimensions: 1,
        distance: 'COSINE',
      },
      tenantId,
      documentVersionId,
      active: false,
      chunks: Array.from({ length: 129 }, (_, index) => ({
        chunkId: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
        tenantId,
        knowledgeBaseId: '00000000-0000-7000-8000-000000000003',
        documentId: '00000000-0000-7000-8000-000000000005',
        documentVersionId,
        title: 'Policy',
        headingPath: [],
        content: `chunk ${index}`,
        contentHash: 'a'.repeat(64),
        classification: 'INTERNAL',
        governanceHash: 'b'.repeat(64),
        updatedAt: '2026-08-12T00:00:00.000Z',
        vector: [0.1],
      })),
    });

    const upserts = requests.filter((request) => request.url.includes('/points?wait=true'));
    expect(upserts.map((request) => request.body.points?.length)).toEqual([128, 1]);
  });

  it('normalizes hybrid RRF scores to the common retrieval score range', async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return response({
          status: 'ok',
          result: { config: { params: { vectors: { dense: { size: 1 } } } } },
        });
      }
      if (input.toString().endsWith('/points/query')) {
        return response({
          status: 'ok',
          result: { points: [{ id: 'chunk-a', score: 1 / 61 }] },
        });
      }
      return response({ status: 'ok', result: {} });
    });
    const index = new QdrantKnowledgeSearchIndex({
      baseUrl: 'http://127.0.0.1:6333',
      collection: 'knowledge',
      dimensions: 1,
      timeoutMs: 1_000,
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    const hits = await index.query({
      profile: {
        indexVersionId: '00000000-0000-7000-8000-000000000010',
        collectionName: 'knowledge',
        dimensions: 1,
        distance: 'COSINE',
      },
      tenantId: '00000000-0000-7000-8000-000000000001',
      knowledgeBaseIds: ['00000000-0000-7000-8000-000000000003'],
      query: 'travel policy',
      vector: [0.1],
      limit: 8,
    });

    expect(hits).toEqual([{ chunkId: 'chunk-a', score: 0.5 }]);
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
