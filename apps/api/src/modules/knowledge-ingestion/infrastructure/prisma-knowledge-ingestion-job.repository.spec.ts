import { describe, expect, it, vi } from 'vitest';

import type { OutboxPrismaService } from '../../../database/outbox-prisma.service.js';
import { PrismaKnowledgeIngestionJobRepository } from './prisma-knowledge-ingestion-job.repository.js';

const JOB_ID = '00000000-0000-7000-8000-000000000001';
const TENANT_ID = '00000000-0000-7000-8000-000000000002';
const VERSION_ID = '00000000-0000-7000-8000-000000000003';

describe('PrismaKnowledgeIngestionJobRepository', () => {
  it('claims only queue identifiers and maps the durable lease snapshot', async () => {
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const createdAt = new Date();
    const { repository, transaction } = createRepository({
      queryRows: [
        {
          id: JOB_ID,
          tenant_id: TENANT_ID,
          document_version_id: VERSION_ID,
          attempts: 2,
          failure_attempts: 1,
          lease_expires_at: leaseExpiresAt,
          created_at: createdAt,
        },
      ],
    });

    await expect(
      repository.claim({ workerId: 'worker-1', batchSize: 3, claimTtlMs: 120_000 }),
    ).resolves.toEqual([
      {
        id: JOB_ID,
        tenantId: TENANT_ID,
        documentVersionId: VERSION_ID,
        attempts: 2,
        failureAttempts: 1,
        leaseExpiresAt,
        createdAt,
      },
    ]);

    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith(
      'SET LOCAL ROLE enterprise_agent_outbox',
    );
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    const claimSql = transaction.$queryRaw.mock.calls[0]?.[0] as {
      readonly strings: readonly string[];
    };
    expect(claimSql.strings.join(' ').replace(/\s+/gu, ' ')).toContain(
      'ORDER BY tenant_activity.last_activity_at NULLS FIRST, job."failure_attempts", job."attempts", job."available_at", job."created_at", job."id"',
    );
    expect(claimSql.strings.join(' ').replace(/\s+/gu, ' ')).toContain(
      'LEFT JOIN tenant_activity ON tenant_activity."tenant_id" = job."tenant_id"',
    );
  });

  it('reports a lost lease when a retry transition updates no row', async () => {
    const { repository } = createRepository({ affectedRows: 0 });

    await expect(
      repository.releaseForRetry({
        jobId: JOB_ID,
        workerId: 'worker-1',
        availableAt: new Date(),
        errorCode: 'KNOWLEDGE_AI_UNAVAILABLE',
        errorMessage: 'Embedding service is unavailable.',
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ['active ownership', [{ owned: true }], true],
    ['expired or reclaimed ownership', [{ owned: false }], false],
    ['an unavailable ownership row', [], false],
  ] as const)('reports %s without extending the lease', async (_label, queryRows, expected) => {
    const { repository, transaction } = createRepository({ queryRows });

    await expect(repository.ownsLease({ jobId: JOB_ID, workerId: 'worker-1' })).resolves.toBe(
      expected,
    );

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses to run without the dedicated worker database capability', async () => {
    const prisma = { enabled: false } as unknown as OutboxPrismaService;
    const repository = new PrismaKnowledgeIngestionJobRepository(prisma);

    expect(() =>
      repository.claim({ workerId: 'worker-1', batchSize: 1, claimTtlMs: 120_000 }),
    ).toThrow('requires the Prisma repository adapter');
  });
});

function createRepository(input?: {
  readonly queryRows?: readonly Record<string, unknown>[];
  readonly affectedRows?: number;
}) {
  const transaction = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue(input?.queryRows ?? []),
    $executeRaw: vi.fn().mockResolvedValue(input?.affectedRows ?? 1),
  };
  const prisma = {
    enabled: true,
    $transaction: vi.fn((operation: (value: typeof transaction) => unknown) =>
      operation(transaction),
    ),
  };
  return {
    repository: new PrismaKnowledgeIngestionJobRepository(prisma as unknown as OutboxPrismaService),
    transaction,
  };
}
