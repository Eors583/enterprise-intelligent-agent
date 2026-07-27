import { describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { KnowledgeAiRuntimeError } from '../../knowledge-semantic/knowledge-ai-runtime.client.js';
import type { KnowledgeIngestionJobRepository } from '../domain/knowledge-ingestion-job.repository.js';
import {
  KnowledgeIngestionLeaseLostError,
  type KnowledgeIngestionProcessor,
} from './knowledge-ingestion.service.js';
import {
  KnowledgeIngestionWorker,
  calculateKnowledgeIngestionRetryDelay,
} from './knowledge-ingestion.worker.js';

const CLAIM = {
  id: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-000000000002',
  documentVersionId: '00000000-0000-7000-8000-000000000003',
  attempts: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
};

describe('KnowledgeIngestionWorker', () => {
  it('starts polling from the application bootstrap lifecycle', async () => {
    const { worker, ingestion } = createWorker();

    worker.onApplicationBootstrap();
    await vi.waitFor(() => expect(ingestion.executeClaim).toHaveBeenCalledOnce());
    await worker.onApplicationShutdown();
  });

  it('executes a claimed job exactly once', async () => {
    const { worker, jobs, ingestion } = createWorker();

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(ingestion.executeClaim).toHaveBeenCalledWith(CLAIM, expect.any(String));
    expect(jobs.releaseForRetry).not.toHaveBeenCalled();
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });

  it('releases retryable failures with a bounded backoff and safe error', async () => {
    const runtimeError = new KnowledgeAiRuntimeError(
      'KNOWLEDGE_AI_UNAVAILABLE',
      true,
      'provider secret must not be persisted',
    );
    const { worker, jobs, ingestion } = createWorker({
      executeClaim: vi.fn().mockRejectedValue(runtimeError),
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(jobs.releaseForRetry).toHaveBeenCalledWith({
      jobId: CLAIM.id,
      workerId: expect.any(String),
      availableAt: expect.any(Date),
      errorCode: 'KNOWLEDGE_AI_UNAVAILABLE',
      errorMessage: 'Embedding service is unavailable. Retry the indexing job.',
    });
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });

  it('terminally fails a job after the configured attempt limit', async () => {
    const exhausted = { ...CLAIM, attempts: 6 };
    const { worker, ingestion } = createWorker({ claims: [exhausted] });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(ingestion.executeClaim).not.toHaveBeenCalled();
    expect(ingestion.failClaim).toHaveBeenCalledWith(
      exhausted,
      expect.any(String),
      expect.objectContaining({
        code: 'KNOWLEDGE_INGESTION_ATTEMPTS_EXHAUSTED',
        retryable: false,
      }),
    );
  });

  it('does not mutate a claim after its tenant-scoped lease is lost', async () => {
    const { worker, jobs, ingestion } = createWorker({
      executeClaim: vi.fn().mockRejectedValue(new KnowledgeIngestionLeaseLostError()),
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(jobs.releaseForRetry).not.toHaveBeenCalled();
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });
});

describe('calculateKnowledgeIngestionRetryDelay', () => {
  it('applies exponential backoff, bounded jitter and a hard maximum', () => {
    expect(calculateKnowledgeIngestionRetryDelay(1, 1_000, 10_000, () => 0)).toBe(800);
    expect(calculateKnowledgeIngestionRetryDelay(2, 1_000, 10_000, () => 0.5)).toBe(2_000);
    expect(calculateKnowledgeIngestionRetryDelay(20, 1_000, 10_000, () => 1)).toBe(10_000);
  });
});

function createWorker(input?: {
  readonly claims?: readonly (typeof CLAIM)[];
  readonly executeClaim?: ReturnType<typeof vi.fn>;
}) {
  const values: Partial<EnvironmentVariables> = {
    KNOWLEDGE_INGESTION_WORKER_ENABLED: true,
    KNOWLEDGE_INGESTION_POLL_INTERVAL_MS: 500,
    KNOWLEDGE_INGESTION_BATCH_SIZE: 2,
    KNOWLEDGE_INGESTION_MAX_ATTEMPTS: 5,
    KNOWLEDGE_INGESTION_RETRY_BASE_MS: 1_000,
    KNOWLEDGE_INGESTION_RETRY_MAX_MS: 60_000,
    KNOWLEDGE_INGESTION_CLAIM_TTL_MS: 120_000,
  };
  const config = {
    get: vi.fn((key: keyof EnvironmentVariables) => values[key]),
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const jobs = {
    claim: vi.fn().mockResolvedValue(input?.claims ?? [CLAIM]),
    renewLease: vi.fn().mockResolvedValue(true),
    releaseForRetry: vi.fn().mockResolvedValue(true),
  };
  const ingestion = {
    executeClaim: input?.executeClaim ?? vi.fn().mockResolvedValue(undefined),
    failClaim: vi.fn().mockResolvedValue(true),
  };
  const worker = new KnowledgeIngestionWorker(
    config,
    jobs as unknown as KnowledgeIngestionJobRepository,
    ingestion as unknown as KnowledgeIngestionProcessor,
  );
  return { worker, jobs, ingestion };
}
