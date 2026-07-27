import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { KnowledgeIngestionService } from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import type { KnowledgeRetrievalService } from '../knowledge-retrieval/knowledge-retrieval.service.js';
import type { KnowledgeAiRuntimeClient } from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import type { AdminAccessService } from './admin-access.service.js';
import { KnowledgeAdminService } from './knowledge-admin.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000002';
const USER_ID = '00000000-0000-7000-8000-000000000003';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000004';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000005';
const DOCUMENT_VERSION_ID = '00000000-0000-7000-8000-000000000007';

describe('KnowledgeAdminService', () => {
  it('uses an explicit lightweight document select for knowledge-base lists', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = createService({ transaction: { knowledgeBase: { findMany } } });

    await expect(service.list()).resolves.toEqual({ items: [] });

    const query = findMany.mock.calls[0]?.[0];
    expect(query.include.documents.select).toMatchObject({
      id: true,
      title: true,
      versions: expect.any(Object),
    });
    expect(query.include.documents.select).not.toHaveProperty('contentText');
    expect(query.include.documents).not.toHaveProperty('include');
  });

  it('routes text publication through the versioned ingestion service', async () => {
    const ingestion = { createTextVersion: vi.fn().mockResolvedValue(DOCUMENT_ID) };
    const service = createService({ ingestion });
    const getDocument = vi
      .spyOn(service, 'getDocument')
      .mockResolvedValue(documentResponse('READY'));

    const response = await service.createDocument(KNOWLEDGE_BASE_ID, {
      title: 'Employee handbook',
      sourceType: 'MARKDOWN',
      contentText: '# Handbook',
      status: 'READY',
    });

    expect(ingestion.createTextVersion).toHaveBeenCalledWith({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      title: 'Employee handbook',
      sourceType: 'MARKDOWN',
      content: '# Handbook',
      publish: true,
    });
    expect(getDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, DOCUMENT_ID);
    expect(response.status).toBe('READY');
  });

  it('requires file documents to use the bounded multipart upload endpoint', async () => {
    const ingestion = { createTextVersion: vi.fn() };
    const service = createService({ ingestion });

    await expect(
      service.createDocument(KNOWLEDGE_BASE_ID, {
        title: 'Unsafe shortcut',
        sourceType: 'FILE',
        contentText: 'not a real file',
        status: 'DRAFT',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.createTextVersion).not.toHaveBeenCalled();
  });

  it('uploads a new file version into the existing stable document', async () => {
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          title: 'Employee handbook',
          sourceType: 'FILE',
          status: 'READY',
        }),
      },
    };
    const ingestion = { uploadFileVersion: vi.fn().mockResolvedValue(DOCUMENT_ID) };
    const service = createService({ transaction, ingestion });
    vi.spyOn(service, 'getDocument').mockResolvedValue({
      ...documentResponse('READY'),
      sourceType: 'FILE',
      fileName: 'handbook.pdf',
    });
    const bytes = Buffer.from('updated file');

    const response = await service.uploadDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
      bytes,
      mimeType: 'application/pdf',
      fileName: 'handbook-2026.pdf',
      changeSummary: 'Annual update',
    });

    expect(ingestion.uploadFileVersion).toHaveBeenCalledWith({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documentId: DOCUMENT_ID,
      title: 'Employee handbook',
      bytes,
      mimeType: 'application/pdf',
      fileName: 'handbook-2026.pdf',
      changeSummary: 'Annual update',
    });
    expect(response.id).toBe(DOCUMENT_ID);
  });

  it('does not accept an uploaded file version for a text document', async () => {
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          title: 'Employee handbook',
          sourceType: 'MARKDOWN',
          status: 'READY',
        }),
      },
    };
    const ingestion = { uploadFileVersion: vi.fn() };
    const service = createService({ transaction, ingestion });

    await expect(
      service.uploadDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
        bytes: Buffer.from('updated file'),
        mimeType: 'text/plain',
        fileName: 'handbook.txt',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingestion.uploadFileVersion).not.toHaveBeenCalled();
  });

  it('tests retrieval as the selected tenant user and preserves measured lexical scores', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      user: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID }) },
    };
    const retrieval = {
      search: vi.fn().mockResolvedValue({
        accessibleKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        items: [
          {
            chunkId: '00000000-0000-7000-8000-000000000006',
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            knowledgeBaseName: 'Company policies',
            documentId: DOCUMENT_ID,
            documentVersionId: '00000000-0000-7000-8000-000000000007',
            documentVersion: 2,
            title: 'Leave policy',
            headingPath: ['Benefits', 'Leave'],
            content: '  Employees   receive  ten days.  ',
            sourceType: 'TEXT',
            updatedAt: new Date('2026-07-20T00:00:00.000Z'),
            keywordScore: 0.75,
            fuzzyScore: 0.25,
            finalScore: 0.575,
          },
        ],
      }),
    };
    const service = createService({ transaction, retrieval });

    const response = await service.testRetrieval(KNOWLEDGE_BASE_ID, {
      query: 'leave allowance',
      userId: USER_ID,
      limit: 5,
    });

    expect(retrieval.search).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      previewDraftKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
      query: 'leave allowance',
      limit: 5,
    });
    expect(response.noAnswer).toBe(false);
    expect(response.items[0]).toMatchObject({
      excerpt: 'Employees receive ten days.',
      keywordScore: 0.75,
      fuzzyScore: 0.25,
      finalScore: 0.575,
    });
  });

  it('does not run a retrieval test for a user outside the current tenant', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const retrieval = { search: vi.fn() };
    const service = createService({ transaction, retrieval });

    await expect(
      service.testRetrieval(KNOWLEDGE_BASE_ID, {
        query: 'leave allowance',
        userId: USER_ID,
        limit: 5,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(retrieval.search).not.toHaveBeenCalled();
  });

  it('rejects stale document revisions before creating an immutable version', async () => {
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentVersion: 3,
        }),
      },
    };
    const ingestion = { createTextVersion: vi.fn() };
    const service = createService({ transaction, ingestion });

    await expect(
      service.updateDocument(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
        contentText: 'new text',
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ingestion.createTextVersion).not.toHaveBeenCalled();
  });

  it('archives without inventing a document content version', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      knowledgeDocument: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          tenantId: TENANT_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          status: 'READY',
          documentVersion: 3,
        }),
        updateMany,
        findFirstOrThrow: vi.fn().mockResolvedValue(storedDocument('ARCHIVED', 3)),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService({ transaction });

    const archived = await service.archiveDocument(KNOWLEDGE_BASE_ID, DOCUMENT_ID, 3);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ documentVersion: 3 }),
        data: { status: 'ARCHIVED' },
      }),
    );
    expect(archived).toMatchObject({ status: 'ARCHIVED', documentVersion: 3 });
  });

  it('returns full text only from an explicitly requested document version', async () => {
    const versionId = DOCUMENT_VERSION_ID;
    const transaction = {
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: versionId,
          tenantId: TENANT_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentId: DOCUMENT_ID,
          versionNumber: 2,
          sourceType: 'MARKDOWN',
          mimeType: 'text/markdown',
          fileName: null,
          objectKey: null,
          checksum: null,
          contentText: '# New draft',
          status: 'DRAFT',
          changeSummary: 'Continue editing',
          createdById: ADMIN_ID,
          createdAt: new Date('2026-07-20T00:00:00.000Z'),
          publishedAt: null,
          _count: { chunks: 0 },
          ingestionJobs: [],
        }),
      },
    };
    const service = createService({ transaction });

    await expect(
      service.getDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, versionId),
    ).resolves.toMatchObject({
      id: versionId,
      documentId: DOCUMENT_ID,
      versionNumber: 2,
      status: 'DRAFT',
      contentText: '# New draft',
    });
  });

  it('returns a paginated chunk preview with distinct embedding models and coverage', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      knowledgeDocument: { findFirst: vi.fn().mockResolvedValue({ id: DOCUMENT_ID }) },
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({ id: DOCUMENT_VERSION_ID }),
      },
      knowledgeChunk: {
        count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2),
        findMany: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-7000-8000-000000000008',
            chunkIndex: 1,
            headingPath: ['Benefits', 'Leave'],
            content: 'Employees receive annual leave.',
            tokenCount: 8,
            contentHash: 'a'.repeat(64),
            metadata: { pageStart: 2, pageEnd: 3 },
            embeddings: [{ embeddingModel: 'embedding-v1' }, { embeddingModel: 'embedding-v2' }],
          },
        ]),
      },
    };
    const service = createService({ transaction });

    const response = await service.listDocumentVersionChunks(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      1,
      25,
    );

    expect(response).toEqual({
      documentVersionId: DOCUMENT_VERSION_ID,
      total: 3,
      offset: 1,
      limit: 25,
      embeddedChunkCount: 2,
      semanticCoverage: 2 / 3,
      items: [
        {
          id: '00000000-0000-7000-8000-000000000008',
          chunkIndex: 1,
          headingPath: ['Benefits', 'Leave'],
          content: 'Employees receive annual leave.',
          tokenCount: 8,
          contentHash: 'a'.repeat(64),
          pageStart: 2,
          pageEnd: 3,
          embeddingModels: ['embedding-v1', 'embedding-v2'],
        },
      ],
    });
    expect(transaction.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 25 }),
    );
  });

  it('rejects invalid chunk-preview pagination before accessing tenant data', async () => {
    const service = createService({ transaction: {} });

    await expect(
      service.listDocumentVersionChunks(
        KNOWLEDGE_BASE_ID,
        DOCUMENT_ID,
        DOCUMENT_VERSION_ID,
        -1,
        101,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not activate an empty or unindexed knowledge base', async () => {
    const updateMany = vi.fn();
    const transaction = {
      knowledgeBase: {
        findFirst: vi.fn().mockResolvedValue({
          id: KNOWLEDGE_BASE_ID,
          tenantId: TENANT_ID,
          status: 'DRAFT',
          version: 1,
        }),
        updateMany,
      },
      knowledgeDocument: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = createService({ transaction });

    await expect(
      service.update(KNOWLEDGE_BASE_ID, {
        status: 'ACTIVE',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction.knowledgeDocument.findMany).toHaveBeenCalled();
  });

  it('does not reapply new activation gates to an already active knowledge base', async () => {
    const active = {
      id: KNOWLEDGE_BASE_ID,
      tenantId: TENANT_ID,
      key: 'company-policies',
      name: 'Company policies',
      description: null,
      status: 'ACTIVE',
      version: 1,
      orgUnits: [],
      documents: [],
      _count: { documents: 0 },
      updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    };
    const updated = { ...active, name: 'Updated policies', version: 2 };
    const transaction = {
      knowledgeBase: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(active)
          .mockResolvedValueOnce(active)
          .mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeDocument: { findFirst: vi.fn() },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const semantic = {
      semanticEnabled: true,
      rerankEnabled: true,
      embeddingDimensions: 1536,
      capabilities: vi.fn(),
    };
    const service = createService({ transaction, semantic });
    const readiness = vi.spyOn(service, 'readiness');

    await expect(
      service.update(KNOWLEDGE_BASE_ID, {
        name: 'Updated policies',
        status: 'ACTIVE',
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({
      id: KNOWLEDGE_BASE_ID,
      name: 'Updated policies',
      status: 'ACTIVE',
      version: 2,
    });

    expect(readiness).not.toHaveBeenCalled();
    expect(semantic.capabilities).not.toHaveBeenCalled();
    expect(transaction.knowledgeDocument.findFirst).not.toHaveBeenCalled();
  });

  it('reports current-model vector coverage and safe provider readiness', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      knowledgeDocument: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: 'READY',
            currentVersion: {
              id: DOCUMENT_VERSION_ID,
              status: 'READY',
              _count: { chunks: 4 },
            },
            versions: [
              {
                status: 'READY',
                ingestionJobs: [{ status: 'SUCCEEDED' }],
              },
            ],
          },
          {
            status: 'READY',
            currentVersion: {
              id: '00000000-0000-7000-8000-000000000008',
              status: 'READY',
              _count: { chunks: 2 },
            },
            versions: [
              {
                status: 'FAILED',
                ingestionJobs: [{ status: 'FAILED' }],
              },
            ],
          },
        ]),
      },
      knowledgeChunk: { count: vi.fn().mockResolvedValue(5) },
    };
    const semantic = {
      semanticEnabled: true,
      rerankEnabled: true,
      embeddingDimensions: 1536,
      capabilities: vi.fn().mockResolvedValue({
        embeddings: {
          status: 'ready',
          provider: 'openai_compatible',
          model: 'embedding-v1',
          dimensions: 1536,
        },
        rerank: {
          status: 'ready',
          provider: 'cohere_compatible',
          model: 'reranker-v1',
        },
      }),
    };
    const service = createService({ transaction, semantic });

    await expect(service.readiness(KNOWLEDGE_BASE_ID)).resolves.toMatchObject({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documents: { total: 2, ready: 1, failed: 1, processing: 0 },
      publishedChunkCount: 6,
      embeddedChunkCount: 5,
      semanticCoverage: 5 / 6,
      embedding: { status: 'READY', model: 'embedding-v1' },
      rerank: { status: 'READY', model: 'reranker-v1' },
      retrievalMode: 'LEXICAL',
      degradedReason: 'EMBEDDING_COVERAGE_INCOMPLETE',
      activationAllowed: false,
    });
    expect(transaction.knowledgeChunk.count).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        documentVersionId: {
          in: [DOCUMENT_VERSION_ID, '00000000-0000-7000-8000-000000000008'],
        },
        embeddings: { some: { embeddingModel: 'embedding-v1' } },
      },
    });
  });

  it('converts runtime capability failures to safe unavailable states', async () => {
    const transaction = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue({ id: KNOWLEDGE_BASE_ID }) },
      knowledgeDocument: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const semantic = {
      semanticEnabled: true,
      rerankEnabled: false,
      embeddingDimensions: 1536,
      capabilities: vi.fn().mockRejectedValue(new Error('upstream secret and URL')),
    };
    const service = createService({ transaction, semantic });

    const response = await service.readiness(KNOWLEDGE_BASE_ID);
    expect(response.embedding).toEqual({
      status: 'UNAVAILABLE',
      provider: 'openai_compatible',
      model: null,
      dimensions: 1536,
    });
    expect(response.rerank).toEqual({
      status: 'DISABLED',
      provider: 'disabled',
      model: null,
      dimensions: null,
    });
    expect(JSON.stringify(response)).not.toContain('upstream');
    expect(JSON.stringify(response)).not.toContain('URL');
  });
});

function createService(input: {
  transaction?: Record<string, unknown>;
  ingestion?: Record<string, unknown>;
  retrieval?: Record<string, unknown>;
  semantic?: Record<string, unknown>;
}): KnowledgeAdminService {
  const transaction = input.transaction ?? {};
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
      operation(transaction),
    ),
  };
  const access = {
    requireKnowledgeWrite: vi.fn(() => ({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      role: 'ADMIN',
      authenticationSource: 'session',
    })),
  };
  return new KnowledgeAdminService(
    prisma as unknown as AdminPrismaService,
    access as unknown as AdminAccessService,
    (input.ingestion ?? {}) as unknown as KnowledgeIngestionService,
    (input.retrieval ?? {}) as unknown as KnowledgeRetrievalService,
    (input.semantic ?? {
      semanticEnabled: false,
      rerankEnabled: false,
      embeddingDimensions: 1536,
      capabilities: vi.fn().mockResolvedValue({
        embeddings: {
          status: 'disabled',
          provider: 'disabled',
          model: null,
          dimensions: 1536,
        },
        rerank: { status: 'disabled', provider: 'disabled', model: null },
      }),
    }) as unknown as KnowledgeAiRuntimeClient,
  );
}

function documentResponse(status: 'DRAFT' | 'READY') {
  return {
    id: DOCUMENT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    title: 'Employee handbook',
    sourceType: 'MARKDOWN' as const,
    mimeType: 'text/markdown',
    fileName: null,
    contentText: '# Handbook',
    checksum: null,
    status,
    documentVersion: 1,
    currentVersionId: status === 'READY' ? '00000000-0000-7000-8000-000000000007' : null,
    versions: [],
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

function storedDocument(status: 'READY' | 'ARCHIVED', documentVersion: number) {
  return {
    id: DOCUMENT_ID,
    tenantId: TENANT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    title: 'Employee handbook',
    sourceType: 'FILE' as const,
    mimeType: 'application/pdf',
    fileName: 'handbook.pdf',
    contentText: 'Handbook content',
    objectKey: 'tenant/document/version.bin',
    checksum: null,
    status,
    documentVersion,
    currentVersionId: '00000000-0000-7000-8000-000000000007',
    createdById: ADMIN_ID,
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    versions: [],
  };
}
