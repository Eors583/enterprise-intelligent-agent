import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ServiceUnavailableException } from '@nestjs/common';

import type { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import type { KnowledgeDocumentParser } from './knowledge-document-parser.port.js';
import type { KnowledgeFileScanner } from '../infrastructure/knowledge-file-scanner.js';
import type { KnowledgeObjectStore } from '../infrastructure/knowledge-object.store.js';
import {
  KnowledgeIngestionProcessor,
  normalizeKnowledgeEntityAliases,
  type KnowledgeIngestionLeaseControl,
} from './knowledge-ingestion.service.js';

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

describe('KnowledgeIngestionProcessor write availability gate', () => {
  it('rejects file upload and web import before any durable or remote side effect', async () => {
    const prisma = { withTenant: vi.fn() };
    const objects = { putObject: vi.fn() };
    const unavailable = vi.fn(() => {
      throw new ServiceUnavailableException({
        code: 'KNOWLEDGE_INGESTION_CONSUMER_UNAVAILABLE',
        message: 'Knowledge ingestion consumer is unavailable.',
      });
    });
    const { service } = createService({
      prisma,
      objects,
      assertPersistentWritesAvailable: unavailable,
    });

    await expect(
      service.upload(PRINCIPAL, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        title: 'Policy',
        bytes: Buffer.from('policy'),
        mimeType: 'text/plain',
        fileName: 'policy.txt',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.importWeb(PRINCIPAL, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        sourceUri: 'https://docs.example.test/policy',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(objects.putObject).not.toHaveBeenCalled();
  });
});

describe('knowledge entity alias persistence boundary', () => {
  it('cleans, deduplicates and bounds aliases without storing the canonical form', () => {
    const aliases = normalizeKnowledgeEntityAliases('Canonical Name', [
      'Canonical Name',
      '“Canonical Name”',
      ' canonical name ',
      '“Surface Alias”',
      'Surface Alias',
      'x',
      ` ${'L'.repeat(200)} `,
      ...Array.from({ length: 40 }, (_, index) => `alias-${index}`),
    ]);

    expect(aliases).toHaveLength(32);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).not.toContain('Canonical Name');
    expect(aliases).toContain('canonical name');
    expect(aliases.filter((alias) => alias === 'Surface Alias')).toHaveLength(1);
    expect(aliases.every((alias) => alias === alias.trim())).toBe(true);
    expect(aliases.every((alias) => alias.length >= 2 && alias.length <= 160)).toBe(true);
    expect(aliases.some((alias) => alias.length === 160)).toBe(true);
  });
});

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
          classification: 'INTERNAL',
          governanceHash: 'a'.repeat(64),
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
      { fetch: vi.fn() } as never,
      { assertPersistentWritesAvailable: vi.fn() } as never,
    );
    const process = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, { process });
    const lease = activeLease();

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
      lease,
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
    expect(process).toHaveBeenCalledWith(expect.any(Object), bytes, 'worker-1', lease);
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
        .mockResolvedValueOnce([{ id: JOB_ID }])
        .mockImplementation((sql: { readonly strings?: readonly string[] }) => {
          const statement = sql.strings?.join('') ?? '';
          if (statement.includes('FROM public.knowledge_relation_governance')) return [];
          if (statement.includes('JOIN public.knowledge_ontology_versions')) return [];
          if (statement.includes('SELECT subject.entity_type AS subject_type')) {
            return [{ subject_type: 'DOCUMENT', object_type: 'TOPIC' }];
          }
          // This provenance test does not exercise governance persistence. Leave
          // the synthetic conflict uninserted so no unrelated audit/outbox mock
          // is required; the dedicated governance-candidate suite covers it.
          if (statement.includes('INSERT INTO public.knowledge_graph_conflicts')) return [];
          return [{ id: '00000000-0000-7000-8000-000000000099' }];
        }),
      $executeRaw: vi.fn().mockResolvedValue(1),
      knowledgeIngestionJob: {
        findFirst: vi.fn().mockResolvedValue({ id: JOB_ID }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      knowledgeDocument: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValueOnce({ status: 'PROCESSING', title: 'PDF page provenance' })
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
      { fetch: vi.fn() } as never,
      { assertPersistentWritesAvailable: vi.fn() } as never,
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
            classification: string;
            governanceHash: string;
            mimeType: string;
            fileName: string;
            actorUserId: string;
          },
          source: Buffer,
          workerId: string,
          lease: KnowledgeIngestionLeaseControl,
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
        classification: 'INTERNAL',
        governanceHash: 'a'.repeat(64),
        mimeType: 'application/pdf',
        fileName: 'handbook.pdf',
        actorUserId: ADMIN_ID,
      },
      bytes,
      'worker-1',
      activeLease(),
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
    expect(parser.parse).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stored.some((chunk) => chunk.metadata.pageStart === 2)).toBe(false);
    expect(stored[2]?.content).toBe(thirdPage);
    expect(transaction.knowledgeDocumentVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentText: fullText,
          status: 'READY',
          publishedAt: null,
          parserName: 'local-document-parser-v1',
          parseReviewStatus: 'PENDING',
          parseDiagnostics: expect.objectContaining({
            pageCount: 3,
            nonEmptyPageCount: 2,
          }),
        }),
      }),
    );
    expect(transaction.knowledgeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'READY' },
      }),
    );
    expect(transaction.knowledgeDocument.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentVersionId: VERSION_ID }),
      }),
    );
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.knowledge-document-version.indexed',
          metadata: expect.objectContaining({
            current: false,
            publicationRequired: true,
          }),
        }),
      }),
    );
  });

  it('blocks sensitive PDF content before Docling or Embedding receives bytes', async () => {
    const parser = { parse: vi.fn() };
    const semantic = { semanticEnabled: true, embedAll: vi.fn() };
    const transaction = {
      knowledgeIngestionJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
      semantic as never,
      { fetch: vi.fn() } as never,
      { assertPersistentWritesAvailable: vi.fn() } as never,
    );

    await expect(
      (
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
              classification: string;
              governanceHash: string;
              mimeType: string;
              fileName: string;
              actorUserId: string;
            },
            source: Buffer,
            workerId: string,
            lease: KnowledgeIngestionLeaseControl,
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
          classification: 'SENSITIVE',
          governanceHash: 'a'.repeat(64),
          mimeType: 'application/pdf',
          fileName: 'restricted.pdf',
          actorUserId: ADMIN_ID,
        },
        Buffer.from('%PDF-1.7 restricted'),
        'worker-1',
        activeLease(),
      ),
    ).rejects.toThrow('KNOWLEDGE_DOCLING_CLASSIFICATION_NOT_APPROVED');
    expect(parser.parse).not.toHaveBeenCalled();
    expect(semantic.embedAll).not.toHaveBeenCalled();
  });
});

describe('KnowledgeIngestionProcessor controlled web import', () => {
  it('persists the canonical source URI and fetched HTML through the object-store path', async () => {
    const bytes = Buffer.from('<main>Security policy</main>');
    const prisma = {
      withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => unknown) =>
        operation({
          knowledgeBase: {
            findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }),
          },
        }),
      ),
    };
    const fetch = vi.fn().mockResolvedValue({
      sourceUri: 'https://docs.example.com/security',
      bytes,
      mimeType: 'text/html',
    });
    const service = new KnowledgeIngestionProcessor(
      prisma as unknown as AdminPrismaService,
      {} as KnowledgeDocumentParser,
      {} as KnowledgeObjectStore,
      { scan: vi.fn() } as unknown as KnowledgeFileScanner,
      { semanticEnabled: false } as never,
      { fetch } as never,
      { assertPersistentWritesAvailable: vi.fn() } as never,
    );
    const createVersionRecord = vi.fn().mockResolvedValue({
      tenantId: TENANT_ID,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      documentId: DOCUMENT_ID,
      documentVersionId: VERSION_ID,
      jobId: JOB_ID,
      versionNumber: 1,
      sourceType: 'WEB',
      classification: 'INTERNAL',
      governanceHash: 'a'.repeat(64),
      mimeType: 'text/html',
      fileName: null,
      actorUserId: ADMIN_ID,
    });
    const persistObjectAndActivate = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, { createVersionRecord, persistObjectAndActivate });

    await expect(
      service.importWeb({ tenantId: TENANT_ID, userId: ADMIN_ID } as never, {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        sourceUri: 'https://docs.example.com/security',
      }),
    ).resolves.toBe(DOCUMENT_ID);

    expect(fetch).toHaveBeenCalledWith('https://docs.example.com/security');
    expect(createVersionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'WEB',
        sourceUri: 'https://docs.example.com/security',
        mimeType: 'text/html',
        processing: true,
        enqueue: true,
      }),
    );
    expect(persistObjectAndActivate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'WEB' }),
      bytes,
    );
  });
});

function createService(input: {
  prisma: Record<string, unknown>;
  objects: Record<string, unknown>;
  assertPersistentWritesAvailable?: () => void;
}) {
  const service = new KnowledgeIngestionProcessor(
    input.prisma as unknown as AdminPrismaService,
    {} as KnowledgeDocumentParser,
    input.objects as unknown as KnowledgeObjectStore,
    { scan: vi.fn() } as unknown as KnowledgeFileScanner,
    { semanticEnabled: false } as never,
    { fetch: vi.fn() } as never,
    {
      assertPersistentWritesAvailable: input.assertPersistentWritesAvailable ?? vi.fn(),
    } as never,
  );
  const createVersionRecord = vi.fn().mockResolvedValue({
    tenantId: TENANT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    jobId: JOB_ID,
    versionNumber: 2,
    sourceType: 'FILE',
    classification: 'INTERNAL',
    governanceHash: 'a'.repeat(64),
    mimeType: 'text/plain',
    fileName: 'handbook-2026.txt',
    actorUserId: ADMIN_ID,
  });
  const process = vi.fn().mockResolvedValue(undefined);
  const failBeforeEnqueue = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, { createVersionRecord, process, failBeforeEnqueue });
  return { service, createVersionRecord, process, failBeforeEnqueue };
}

function activeLease(): KnowledgeIngestionLeaseControl {
  return {
    signal: new AbortController().signal,
    assertOwned: vi.fn().mockResolvedValue(undefined),
  };
}
