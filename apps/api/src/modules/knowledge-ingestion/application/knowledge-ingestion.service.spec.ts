import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { KnowledgeDocumentParser } from './knowledge-document-parser.port.js';
import type { KnowledgeFileScanner } from '../infrastructure/knowledge-file-scanner.js';
import type { KnowledgeObjectStore } from '../infrastructure/knowledge-object.store.js';
import { KnowledgeIngestionProcessor } from './knowledge-ingestion.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000002';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000003';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000004';
const VERSION_ID = '00000000-0000-7000-8000-000000000005';
const JOB_ID = '00000000-0000-7000-8000-000000000006';
const PRINCIPAL = {
  tenantId: TENANT_ID,
  userId: ADMIN_ID,
  role: 'OWNER' as const,
  authenticationSource: 'session' as const,
};

describe('KnowledgeIngestionProcessor file version storage', () => {
  it('retains a deterministic object for delayed worker recovery when ledger linking fails', async () => {
    const objectKey = `${TENANT_ID}/${DOCUMENT_ID}/${VERSION_ID}.bin`;
    const objects = {
      putObject: vi.fn().mockResolvedValue({
        objectKey,
        size: 10,
        sha256: 'a'.repeat(64),
        created: true,
      }),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      withTenant: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const { service, createVersionRecord, failBeforeEnqueue } = createService({
      prisma,
      objects,
    });

    await expect(
      service.upload(PRINCIPAL, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        title: 'Handbook',
        bytes: Buffer.from('file bytes'),
        mimeType: 'text/plain',
        fileName: 'handbook.txt',
      }),
    ).resolves.toBe(DOCUMENT_ID);

    expect(createVersionRecord).toHaveBeenCalledOnce();
    expect(objects.deleteObject).not.toHaveBeenCalled();
    expect(failBeforeEnqueue).not.toHaveBeenCalled();
  });

  it('marks the delayed job failed when object persistence itself is rejected', async () => {
    const objects = {
      putObject: vi.fn().mockRejectedValue(new Error('storage unavailable')),
      deleteObject: vi.fn(),
    };
    const { service, failBeforeEnqueue } = createService({
      prisma: { withTenant: vi.fn() },
      objects,
    });

    await expect(
      service.upload(PRINCIPAL, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        title: 'Handbook',
        bytes: Buffer.from('file bytes'),
        mimeType: 'text/plain',
        fileName: 'handbook.txt',
      }),
    ).resolves.toBe(DOCUMENT_ID);

    expect(failBeforeEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ documentVersionId: VERSION_ID, jobId: JOB_ID }),
      expect.any(Error),
    );
  });

  it('creates a file version under the supplied stable document id', async () => {
    const objectKey = `${TENANT_ID}/${DOCUMENT_ID}/${VERSION_ID}.bin`;
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      knowledgeDocumentVersion: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      knowledgeIngestionJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    };
    const objects = {
      putObject: vi.fn().mockResolvedValue({
        objectKey,
        size: 10,
        sha256: 'b'.repeat(64),
        created: true,
      }),
      deleteObject: vi.fn(),
    };
    const { service, createVersionRecord, process } = createService({ prisma, objects });

    await expect(
      service.uploadFileVersion(PRINCIPAL, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        documentId: DOCUMENT_ID,
        title: 'Handbook',
        bytes: Buffer.from('file bytes'),
        mimeType: 'text/plain',
        fileName: 'handbook-2026.txt',
      }),
    ).resolves.toBe(DOCUMENT_ID);

    expect(createVersionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        documentId: DOCUMENT_ID,
        sourceType: 'FILE',
      }),
    );
    expect(process).not.toHaveBeenCalled();
    expect(transaction.knowledgeDocumentVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          objectKey,
          objectSize: 10,
          objectSha256: 'b'.repeat(64),
        },
      }),
    );
    expect(transaction.knowledgeIngestionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { availableAt: expect.any(Date) },
      }),
    );
    expect(objects.deleteObject).not.toHaveBeenCalled();
  });

  it('recovers an object written before the version ledger transaction crashed', async () => {
    const bytes = Buffer.from('durable recovery bytes');
    const objectKey = `${TENANT_ID}/${DOCUMENT_ID}/${VERSION_ID}.bin`;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const initialTransaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ owned: true }]),
      knowledgeDocumentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: VERSION_ID,
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          documentId: DOCUMENT_ID,
          versionNumber: 2,
          sourceType: 'FILE',
          mimeType: 'text/plain',
          fileName: 'recovery.txt',
          objectKey: null,
          objectSize: null,
          objectSha256: null,
          contentText: null,
          createdById: ADMIN_ID,
        }),
      },
    };
    const recoveryTransaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ owned: true }]),
      knowledgeDocumentVersion: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      withTenant: vi
        .fn()
        .mockImplementationOnce((_tenantId: string, operation: (value: unknown) => unknown) =>
          operation(initialTransaction),
        )
        .mockImplementationOnce((_tenantId: string, operation: (value: unknown) => unknown) =>
          operation(recoveryTransaction),
        ),
    };
    const objects = {
      readObject: vi.fn().mockResolvedValue({
        objectKey,
        size: bytes.byteLength,
        sha256: digest,
        body: Readable.from([bytes]),
      }),
    };
    const service = new KnowledgeIngestionProcessor(
      prisma as unknown as AdminPrismaService,
      {} as KnowledgeDocumentParser,
      objects as unknown as KnowledgeObjectStore,
      { scan: vi.fn() } as unknown as KnowledgeFileScanner,
      { semanticEnabled: false } as never,
    );
    const process = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, { process });

    await service.executeClaim(
      {
        id: JOB_ID,
        tenantId: TENANT_ID,
        documentVersionId: VERSION_ID,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      },
      'worker-1',
    );

    expect(objects.readObject).toHaveBeenCalledWith(objectKey);
    expect(recoveryTransaction.knowledgeDocumentVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          objectKey,
          objectSize: bytes.byteLength,
          objectSha256: digest,
        },
      }),
    );
    expect(process).toHaveBeenCalledWith(expect.any(Object), bytes, 'worker-1');
  });
});

describe('KnowledgeIngestionProcessor PDF page provenance', () => {
  it('skips empty pages and stores globally ordered chunks with exact page metadata', async () => {
    const firstPage = 'A'.repeat(1_200);
    const thirdPage = 'Third page';
    const fullText = `${firstPage}\n\n${thirdPage}`;
    const bytes = Buffer.from('pdf bytes');
    const parser = {
      parse: vi.fn().mockResolvedValue({
        text: fullText,
        pages: [
          { pageNumber: 1, text: firstPage },
          { pageNumber: 2, text: '' },
          { pageNumber: 3, text: thirdPage },
        ],
        metadata: {
          mimeType: 'application/pdf',
          sourceType: 'TEXT',
          byteLength: bytes.byteLength,
          characterCount: Array.from(fullText).length,
          pageCount: 3,
        },
      }),
    };
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: JOB_ID }]),
      knowledgeIngestionJob: {
        findFirst: vi.fn().mockResolvedValue({ id: JOB_ID }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      knowledgeDocument: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValueOnce({ status: 'PROCESSING' })
          .mockResolvedValueOnce({ currentVersionId: null, documentVersion: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      knowledgeBase: {
        findFirstOrThrow: vi.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
      knowledgeChunk: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
      knowledgeDocumentVersion: {
        findFirstOrThrow: vi.fn().mockResolvedValue({ objectKey: 'tenant/document/version.bin' }),
        update: vi.fn().mockResolvedValue({}),
      },
      auditEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation(transaction),
      ),
    };
    const service = new KnowledgeIngestionProcessor(
      prisma as unknown as AdminPrismaService,
      parser as unknown as KnowledgeDocumentParser,
      {} as KnowledgeObjectStore,
      {
        scan: vi.fn().mockResolvedValue({
          verdict: 'clean',
          scanner: 'test',
          scannedAt: new Date().toISOString(),
        }),
      } as KnowledgeFileScanner,
      { semanticEnabled: false } as never,
    );

    await (
      service as unknown as {
        process(
          identity: {
            tenantId: string;
            knowledgeBaseId: string;
            documentId: string;
            documentVersionId: string;
            jobId: string;
            versionNumber: number;
            sourceType: 'FILE';
            mimeType: string;
            fileName: string;
            actorUserId: string;
          },
          source: Buffer,
          workerId: string,
        ): Promise<void>;
      }
    ).process(
      {
        tenantId: TENANT_ID,
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        documentId: DOCUMENT_ID,
        documentVersionId: VERSION_ID,
        jobId: JOB_ID,
        versionNumber: 2,
        sourceType: 'FILE',
        mimeType: 'application/pdf',
        fileName: 'handbook.pdf',
        actorUserId: ADMIN_ID,
      },
      bytes,
      'worker-1',
    );

    const createMany = transaction.knowledgeChunk.createMany;
    expect(createMany).toHaveBeenCalledOnce();
    const stored = createMany.mock.calls[0]?.[0].data as Array<{
      chunkIndex: number;
      content: string;
      metadata: Record<string, unknown>;
    }>;
    expect(stored).toHaveLength(3);
    expect(stored.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
    expect(stored.map((chunk) => chunk.metadata.pageStart)).toEqual([1, 1, 3]);
    expect(stored.map((chunk) => chunk.metadata.pageEnd)).toEqual([1, 1, 3]);
    expect(stored.every((chunk) => chunk.metadata.pageCount === 3)).toBe(true);
    expect(stored.every((chunk) => chunk.metadata.parser === 'pdf-parse-v2')).toBe(true);
    expect(stored.some((chunk) => chunk.metadata.pageStart === 2)).toBe(false);
    expect(stored[2]?.content).toBe(thirdPage);
    expect(transaction.knowledgeDocumentVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contentText: fullText }),
      }),
    );
    expect(transaction.knowledgeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contentText: fullText }),
      }),
    );
  });
});

function createService(input: {
  prisma: Record<string, unknown>;
  objects: Record<string, unknown>;
}) {
  const service = new KnowledgeIngestionProcessor(
    input.prisma as unknown as AdminPrismaService,
    {} as KnowledgeDocumentParser,
    input.objects as unknown as KnowledgeObjectStore,
    { scan: vi.fn() } as unknown as KnowledgeFileScanner,
    { semanticEnabled: false } as never,
  );
  const createVersionRecord = vi.fn().mockResolvedValue({
    tenantId: TENANT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    jobId: JOB_ID,
    versionNumber: 2,
    sourceType: 'FILE',
    mimeType: 'text/plain',
    fileName: 'handbook-2026.txt',
    actorUserId: ADMIN_ID,
  });
  const process = vi.fn().mockResolvedValue(undefined);
  const failBeforeEnqueue = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, { createVersionRecord, process, failBeforeEnqueue });
  return { service, createVersionRecord, process, failBeforeEnqueue };
}
