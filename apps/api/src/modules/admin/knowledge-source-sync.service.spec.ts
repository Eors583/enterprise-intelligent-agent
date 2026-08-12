import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type { KnowledgeIngestionService } from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import type { AdminAccessService } from './admin-access.service.js';
import type { ControlledKnowledgeSourceFetcher } from './controlled-knowledge-source-fetcher.js';
import { KnowledgeSourceSyncService } from './knowledge-source-sync.service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const ADMIN_ID = '00000000-0000-7000-8000-000000000101';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000201';
const CONNECTOR_ID = '00000000-0000-7000-8000-000000000301';
const RUN_ID = '00000000-0000-7000-8000-000000000401';
const DOCUMENT_ID = '00000000-0000-7000-8000-000000000501';

describe('KnowledgeSourceSyncService', () => {
  it('downloads a new manifest item, queues ingestion, and advances the cursor', async () => {
    const body = Buffer.from('# 员工手册\n\n远程办公制度。', 'utf8');
    const harness = createHarness(body, createHash('sha256').update(body).digest('hex'));

    const result = await harness.service.sync(KNOWLEDGE_BASE_ID, CONNECTOR_ID);

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      cursorBefore: null,
      cursorAfter: 'cursor-1',
      discoveredCount: 1,
      createdCount: 1,
      failedCount: 0,
    });
    expect(harness.ingestion.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        title: '员工手册',
        fileName: 'handbook.md',
        sourceUri: 'https://drive.example.com/files/handbook',
      }),
    );
    expect(harness.transaction.knowledgeSourceConnector.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cursor: 'cursor-1' }) }),
    );
  });

  it('retains the old cursor and records a safe failure when a checksum is wrong', async () => {
    const body = Buffer.from('tampered', 'utf8');
    const harness = createHarness(body, 'a'.repeat(64));

    const result = await harness.service.sync(KNOWLEDGE_BASE_ID, CONNECTOR_ID);

    expect(result.status).toBe('FAILED');
    expect(result.cursorAfter).toBeNull();
    expect(result.failedCount).toBe(1);
    expect(result.failures[0]?.code).toBe('KNOWLEDGE_SOURCE_CHECKSUM_MISMATCH');
    expect(harness.ingestion.upload).not.toHaveBeenCalled();
    expect(harness.transaction.knowledgeSourceConnector.updateMany).not.toHaveBeenCalled();
  });
});

function createHarness(body: Buffer, manifestSha256: string) {
  const startedAt = new Date('2026-08-05T00:00:00.000Z');
  const connector = {
    id: CONNECTOR_ID,
    tenantId: TENANT_ID,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    name: '公司制度网盘',
    providerType: 'HTTPS_MANIFEST',
    manifestUrl: 'https://drive.example.com/manifest',
    status: 'ACTIVE',
    cursor: null,
    lastSyncedAt: null,
    createdById: ADMIN_ID,
    createdAt: startedAt,
    updatedAt: startedAt,
  } as const;
  const running = {
    id: RUN_ID,
    tenantId: TENANT_ID,
    connectorId: CONNECTOR_ID,
    status: 'RUNNING',
    cursorBefore: null,
    cursorAfter: null,
    discoveredCount: 0,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    requestedById: ADMIN_ID,
    startedAt,
    finishedAt: null,
  } as const;
  const transaction = {
    knowledgeBase: {
      findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }),
    },
    knowledgeSourceConnector: {
      findFirst: vi.fn().mockResolvedValue(connector),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    knowledgeSourceSyncRun: {
      create: vi.fn().mockResolvedValue(running),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        ...running,
        ...data,
      })),
    },
    knowledgeSourceItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    knowledgeDocument: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withTenant: vi.fn((_tenantId: string, operation: (tx: typeof transaction) => unknown) =>
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
  const ingestion = {
    upload: vi.fn().mockResolvedValue(DOCUMENT_ID),
    uploadFileVersion: vi.fn().mockResolvedValue(DOCUMENT_ID),
    archiveSearchDocument: vi.fn().mockResolvedValue(undefined),
  };
  const sourceFetcher = {
    maximumPages: 10,
    assertAllowedUrl: vi.fn(),
    fetchManifest: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      nextCursor: 'cursor-1',
      hasMore: false,
      items: [
        {
          externalId: 'drive/file-1',
          title: '员工手册',
          fileName: 'handbook.md',
          mimeType: 'text/markdown',
          downloadUrl: 'https://drive.example.com/download/handbook',
          sourceUri: 'https://drive.example.com/files/handbook',
          sourceRevision: 'v1',
          sha256: manifestSha256,
          modifiedAt: '2026-08-05T00:00:00.000Z',
          deleted: false,
        },
      ],
    }),
    fetchFile: vi.fn().mockResolvedValue(body),
  };
  return {
    transaction,
    ingestion,
    service: new KnowledgeSourceSyncService(
      prisma as unknown as AdminPrismaService,
      access as unknown as AdminAccessService,
      ingestion as unknown as KnowledgeIngestionService,
      sourceFetcher as unknown as ControlledKnowledgeSourceFetcher,
    ),
  };
}
