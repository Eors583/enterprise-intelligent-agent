import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { KnowledgeAdminController } from './knowledge-admin.controller.js';
import type { KnowledgeAdminService } from './knowledge-admin.service.js';

const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000101';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000102';
const DOCUMENT_VERSION_ID = '00000000-0000-7000-8000-000000000103';

describe('KnowledgeAdminController uploads', () => {
  it('delegates the controlled web import and parse-review lifecycle', async () => {
    const importWebDocument = vi.fn().mockResolvedValue({ id: DOCUMENT_ID });
    const listPendingParseReviews = vi.fn().mockResolvedValue({ items: [] });
    const reviewDocumentVersionParse = vi.fn().mockResolvedValue({ id: DOCUMENT_VERSION_ID });
    const controller = createController({
      importWebDocument,
      listPendingParseReviews,
      reviewDocumentVersionParse,
    });
    const importRequest = {
      url: 'https://docs.example.com/security',
      title: 'Security policy',
    };
    const reviewRequest = {
      decision: 'REJECT' as const,
      expectedReviewRevision: 2,
      note: 'The parser omitted a table.',
    };

    await controller.importWebDocument(KNOWLEDGE_BASE_ID, importRequest);
    await controller.listPendingParseReviews(KNOWLEDGE_BASE_ID);
    await controller.reviewDocumentVersionParse(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      reviewRequest,
    );

    expect(importWebDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, importRequest);
    expect(listPendingParseReviews).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID);
    expect(reviewDocumentVersionParse).toHaveBeenCalledWith(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      reviewRequest,
    );
  });

  it('delegates lightweight-list follow-up reads to document detail endpoints', async () => {
    const getDocument = vi.fn().mockResolvedValue({ id: DOCUMENT_ID });
    const getDocumentVersion = vi.fn().mockResolvedValue({ id: 'version-id' });
    const controller = createController({ getDocument, getDocumentVersion });
    const versionId = '00000000-0000-7000-8000-000000000103';

    await controller.getDocument(KNOWLEDGE_BASE_ID, DOCUMENT_ID);
    await controller.getDocumentVersion(KNOWLEDGE_BASE_ID, DOCUMENT_ID, versionId);

    expect(getDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, DOCUMENT_ID);
    expect(getDocumentVersion).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, DOCUMENT_ID, versionId);
  });

  it('delegates bounded chunk-preview pagination to the admin service', async () => {
    const listDocumentVersionChunks = vi.fn().mockResolvedValue({
      documentVersionId: DOCUMENT_VERSION_ID,
      total: 0,
      offset: 10,
      limit: 25,
      embeddedChunkCount: 0,
      semanticCoverage: 0,
      items: [],
    });
    const controller = createController({ listDocumentVersionChunks });

    await controller.listDocumentVersionChunks(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      10,
      25,
    );

    expect(listDocumentVersionChunks).toHaveBeenCalledWith(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
      10,
      25,
    );
  });

  it('streams an authorized original source inline with its UTF-8 filename', async () => {
    const getDocumentVersionSource = vi.fn().mockResolvedValue({
      body: Buffer.from('source file'),
      size: 11,
      mimeType: 'application/pdf',
      fileName: '员工制度.pdf',
    });
    const controller = createController({ getDocumentVersionSource });

    const response = await controller.getDocumentVersionSource(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
    );

    expect(getDocumentVersionSource).toHaveBeenCalledWith(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
    );
    expect(response.getHeaders()).toMatchObject({
      type: 'application/pdf',
      disposition: `inline; filename*=UTF-8''${encodeURIComponent('员工制度.pdf')}`,
      length: 11,
    });
  });

  it('delegates tenant-scoped retrieval diagnostics to the admin service', async () => {
    const readiness = vi.fn().mockResolvedValue({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalMode: 'LEXICAL',
    });
    const controller = createController({ readiness });

    await controller.readiness(KNOWLEDGE_BASE_ID);

    expect(readiness).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID);
  });

  it('delegates graph readiness and bounded graph browsing to the admin service', async () => {
    const graphOverview = vi.fn().mockResolvedValue({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      status: 'READY',
    });
    const graph = vi.fn().mockResolvedValue({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      entities: [],
      relations: [],
    });
    const controller = createController({ graphOverview, graph });
    const query = { query: '审批', entityType: 'TOPIC', limit: 25 };

    await controller.graphOverview(KNOWLEDGE_BASE_ID);
    await controller.graph(KNOWLEDGE_BASE_ID, query);

    expect(graphOverview).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID);
    expect(graph).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, query);
  });

  it('delegates relation-index rebuilds for existing document versions', async () => {
    const rebuildDocumentVersionGraph = vi.fn().mockResolvedValue({
      documentVersionId: DOCUMENT_VERSION_ID,
      entityCount: 3,
      relationCount: 2,
      mentionCount: 4,
      evidenceCount: 2,
    });
    const controller = createController({ rebuildDocumentVersionGraph });

    await controller.rebuildDocumentVersionGraph(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
    );

    expect(rebuildDocumentVersionGraph).toHaveBeenCalledWith(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      DOCUMENT_VERSION_ID,
    );
  });

  it('uses the filename as the title and resolves a safe MIME type from the extension', async () => {
    const uploadDocument = vi.fn().mockResolvedValue({ id: 'document-id' });
    const controller = createController({ uploadDocument });
    const buffer = Buffer.from('%PDF-1.7', 'ascii');

    await controller.uploadDocument(
      KNOWLEDGE_BASE_ID,
      {
        originalname: 'employee-handbook.pdf',
        mimetype: 'application/octet-stream',
        size: buffer.byteLength,
        buffer,
      },
      {},
    );

    expect(uploadDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, {
      title: 'employee-handbook',
      bytes: buffer,
      mimeType: 'application/pdf',
      fileName: 'employee-handbook.pdf',
    });
  });

  it('recovers a Chinese UTF-8 filename that Multer decoded as Latin-1', async () => {
    const uploadDocument = vi.fn().mockResolvedValue({ id: 'document-id' });
    const controller = createController({ uploadDocument });
    const buffer = Buffer.from('%PDF-1.7', 'ascii');
    const fileName = '知识库管理制度.pdf';
    const mojibakeFileName = Buffer.from(fileName, 'utf8').toString('latin1');

    await controller.uploadDocument(
      KNOWLEDGE_BASE_ID,
      {
        originalname: mojibakeFileName,
        mimetype: 'application/octet-stream',
        size: buffer.byteLength,
        buffer,
      },
      {},
    );

    expect(uploadDocument).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, {
      title: '知识库管理制度',
      bytes: buffer,
      mimeType: 'application/pdf',
      fileName,
    });
  });

  it.each(['employee-handbook.pdf', 'café.pdf'])(
    'keeps an ASCII or genuine Latin-1 filename unchanged: %s',
    async (fileName) => {
      const uploadDocument = vi.fn().mockResolvedValue({ id: 'document-id' });
      const controller = createController({ uploadDocument });
      const buffer = Buffer.from('%PDF-1.7', 'ascii');

      await controller.uploadDocument(
        KNOWLEDGE_BASE_ID,
        {
          originalname: fileName,
          mimetype: 'application/pdf',
          size: buffer.byteLength,
          buffer,
        },
        { title: 'Explicit title' },
      );

      expect(uploadDocument).toHaveBeenCalledWith(
        KNOWLEDGE_BASE_ID,
        expect.objectContaining({ fileName }),
      );
    },
  );

  it.each([
    ['malformed UTF-8 bytes', Buffer.from([0xc3, 0x28]).toString('latin1') + '.pdf'],
    [
      'a recovered bidirectional control',
      Buffer.from('report\u202Efdp.txt', 'utf8').toString('latin1'),
    ],
  ])('does not reinterpret %s as a recovered filename', async (_case, fileName) => {
    const uploadDocument = vi.fn().mockResolvedValue({ id: 'document-id' });
    const controller = createController({ uploadDocument });
    const buffer = Buffer.from('%PDF-1.7', 'ascii');

    await controller.uploadDocument(
      KNOWLEDGE_BASE_ID,
      {
        originalname: fileName,
        mimetype: 'application/pdf',
        size: buffer.byteLength,
        buffer,
      },
      { title: 'Explicit title' },
    );

    expect(uploadDocument).toHaveBeenCalledWith(
      KNOWLEDGE_BASE_ID,
      expect.objectContaining({ fileName }),
    );
  });

  it('honors trimmed upload metadata without exposing it to the parser boundary', async () => {
    const uploadDocument = vi.fn().mockResolvedValue({ id: 'document-id' });
    const controller = createController({ uploadDocument });
    const buffer = Buffer.from('# Handbook', 'utf8');

    await controller.uploadDocument(
      KNOWLEDGE_BASE_ID,
      {
        originalname: 'handbook.md',
        mimetype: 'text/markdown',
        size: buffer.byteLength,
        buffer,
      },
      { title: '  Employee handbook  ', changeSummary: '  Initial import  ' },
    );

    expect(uploadDocument).toHaveBeenCalledWith(
      KNOWLEDGE_BASE_ID,
      expect.objectContaining({
        title: 'Employee handbook',
        changeSummary: 'Initial import',
        mimeType: 'text/markdown',
      }),
    );
  });

  it('uploads a file as a new version of the stable document without changing its title', async () => {
    const uploadDocumentVersion = vi.fn().mockResolvedValue({ id: DOCUMENT_ID });
    const controller = createController({ uploadDocumentVersion });
    const buffer = Buffer.from('new policy text', 'utf8');

    await controller.uploadDocumentVersion(
      KNOWLEDGE_BASE_ID,
      DOCUMENT_ID,
      {
        originalname: 'policy-2026.txt',
        mimetype: 'text/plain',
        size: buffer.byteLength,
        buffer,
      },
      { title: 'must be ignored', changeSummary: '  Annual update  ' },
    );

    expect(uploadDocumentVersion).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, DOCUMENT_ID, {
      bytes: buffer,
      mimeType: 'text/plain',
      fileName: 'policy-2026.txt',
      changeSummary: 'Annual update',
    });
  });

  it('rejects a missing or empty file before invoking the ingestion service', () => {
    const uploadDocument = vi.fn();
    const controller = createController({ uploadDocument });

    expect(() => controller.uploadDocument(KNOWLEDGE_BASE_ID, undefined, {})).toThrow(
      BadRequestException,
    );
    expect(() =>
      controller.uploadDocument(
        KNOWLEDGE_BASE_ID,
        { originalname: 'empty.txt', mimetype: 'text/plain', size: 0, buffer: Buffer.alloc(0) },
        {},
      ),
    ).toThrow(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('rejects overlong upload metadata', () => {
    const uploadDocument = vi.fn();
    const controller = createController({ uploadDocument });
    const buffer = Buffer.from('safe content', 'utf8');

    expect(() =>
      controller.uploadDocument(
        KNOWLEDGE_BASE_ID,
        {
          originalname: 'safe.txt',
          mimetype: 'text/plain',
          size: buffer.byteLength,
          buffer,
        },
        { changeSummary: 'x'.repeat(501) },
      ),
    ).toThrow(BadRequestException);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('forwards a validated upload inspection request', async () => {
    const inspection = {
      decision: 'NEW_DOCUMENT' as const,
      matchingDocument: null,
    };
    const inspectUpload = vi.fn().mockResolvedValue(inspection);
    const controller = createController({ inspectUpload });
    const request = {
      fileName: 'employee-handbook.pdf',
      size: 2048,
      sha256: 'a'.repeat(64),
    };

    await expect(controller.inspectUpload(KNOWLEDGE_BASE_ID, request)).resolves.toEqual(inspection);
    expect(inspectUpload).toHaveBeenCalledWith(KNOWLEDGE_BASE_ID, request);
  });
});

function createController(overrides: Record<string, unknown>): KnowledgeAdminController {
  return new KnowledgeAdminController(overrides as unknown as KnowledgeAdminService, {} as never);
}
