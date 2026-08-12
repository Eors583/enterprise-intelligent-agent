import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { KnowledgeAiRuntimeError } from '../../knowledge-semantic/knowledge-ai-runtime.client.js';
import type { KnowledgeIngestionJobRepository } from '../domain/knowledge-ingestion-job.repository.js';
import { DocumentParsingError } from '../infrastructure/document-parser.adapter.js';
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
  failureAttempts: 0,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
};

describe('KnowledgeIngestionWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts polling from the application bootstrap lifecycle', async () => {
    const { worker, ingestion, availability } = createWorker();

    worker.onApplicationBootstrap();
    await vi.waitFor(() => expect(ingestion.executeClaim).toHaveBeenCalledOnce());
    expect(availability.markWorkerStarting).toHaveBeenCalledOnce();
    expect(availability.markWorkerReady).toHaveBeenCalledOnce();
    await worker.onApplicationShutdown();
    expect(availability.markWorkerStopped).toHaveBeenCalledOnce();
  });

  it('executes a claimed job exactly once', async () => {
    const { worker, jobs, ingestion } = createWorker();

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(ingestion.executeClaim).toHaveBeenCalledWith(
      CLAIM,
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        assertOwned: expect.any(Function),
      }),
    );
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

  it('retries a transient invalid parser response instead of rejecting the document', async () => {
    const { worker, jobs, ingestion } = createWorker({
      executeClaim: vi
        .fn()
        .mockRejectedValue(new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE')),
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(jobs.releaseForRetry).toHaveBeenCalledWith({
      jobId: CLAIM.id,
      workerId: expect.any(String),
      availableAt: expect.any(Date),
      errorCode: 'DOCUMENT_PARSER_INVALID_RESPONSE',
      errorMessage: '文档解析服务返回了无效结果。',
    });
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });

  it('preserves the real failure after the configured failure limit', async () => {
    const finalFailure = { ...CLAIM, attempts: 9, failureAttempts: 4 };
    const runtimeError = new KnowledgeAiRuntimeError(
      'KNOWLEDGE_AI_UNAVAILABLE',
      true,
      'provider secret must not be persisted',
    );
    const { worker, jobs, ingestion } = createWorker({
      claims: [finalFailure],
      executeClaim: vi.fn().mockRejectedValue(runtimeError),
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(ingestion.executeClaim).toHaveBeenCalledOnce();
    expect(jobs.releaseForRetry).not.toHaveBeenCalled();
    expect(ingestion.failClaim).toHaveBeenCalledWith(
      finalFailure,
      expect.any(String),
      expect.objectContaining({
        code: 'KNOWLEDGE_AI_UNAVAILABLE',
      }),
    );
  });

  it('does not consume the failure budget when an expired lease is reclaimed', async () => {
    const reclaimed = { ...CLAIM, attempts: 12, failureAttempts: 0 };
    const { worker, ingestion } = createWorker({ claims: [reclaimed] });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(ingestion.executeClaim).toHaveBeenCalledWith(
      reclaimed,
      expect.any(String),
      expect.any(Object),
    );
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });

  it('does not mutate a claim after its tenant-scoped lease is lost', async () => {
    const { worker, jobs, ingestion } = createWorker({
      executeClaim: vi.fn().mockRejectedValue(new KnowledgeIngestionLeaseLostError()),
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(jobs.releaseForRetry).not.toHaveBeenCalled();
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['returns false', () => Promise.resolve(false)],
    ['throws', () => Promise.reject(new Error('lease database unavailable'))],
  ])(
    'fails closed and aborts an in-flight provider when lease renewal %s',
    async (_label, renewal) => {
      vi.useFakeTimers();
      let observedSignal: AbortSignal | undefined;
      const executeClaim = vi.fn(
        (_claim: typeof CLAIM, _workerId: string, lease: { readonly signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            observedSignal = lease.signal;
            const rejectLost = (): void => reject(new KnowledgeIngestionLeaseLostError());
            lease.signal.addEventListener('abort', rejectLost, { once: true });
            if (lease.signal.aborted) rejectLost();
          }),
      );
      const { worker, jobs, ingestion } = createWorker({
        executeClaim,
        renewLease: vi.fn(renewal),
        claimTtlMs: 3_000,
      });

      const running = worker.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(executeClaim).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(running).resolves.toBe(1);

      expect(jobs.renewLease).toHaveBeenCalledOnce();
      expect(observedSignal?.aborted).toBe(true);
      expect(jobs.releaseForRetry).not.toHaveBeenCalled();
      expect(ingestion.failClaim).not.toHaveBeenCalled();
    },
  );

  it('fails closed before a provider starts when the explicit ownership check is stale', async () => {
    const provider = vi.fn();
    const executeClaim = vi.fn(
      async (
        _claim: typeof CLAIM,
        _workerId: string,
        lease: { readonly assertOwned: () => Promise<void> },
      ) => {
        await lease.assertOwned();
        provider();
      },
    );
    const { worker, jobs, ingestion } = createWorker({
      executeClaim,
      ownsLease: vi.fn().mockResolvedValue(false),
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(jobs.ownsLease).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
    expect(jobs.releaseForRetry).not.toHaveBeenCalled();
    expect(ingestion.failClaim).not.toHaveBeenCalled();
  });

  it('aborts the stale provider before a reclaimed worker starts the same job', async () => {
    vi.useFakeTimers();
    let activeProviders = 0;
    let maximumActiveProviders = 0;
    const providerCalls: string[] = [];
    const firstExecution = vi.fn(
      (_claim: typeof CLAIM, _workerId: string, lease: { readonly signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          providerCalls.push('stale-started');
          activeProviders += 1;
          maximumActiveProviders = Math.max(maximumActiveProviders, activeProviders);
          const rejectLost = (): void => {
            activeProviders -= 1;
            providerCalls.push('stale-aborted');
            reject(new KnowledgeIngestionLeaseLostError());
          };
          lease.signal.addEventListener('abort', rejectLost, { once: true });
        }),
    );
    const first = createWorker({
      executeClaim: firstExecution,
      renewLease: vi.fn().mockResolvedValue(false),
      claimTtlMs: 3_000,
    });
    const firstRun = first.worker.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(firstRun).resolves.toBe(1);

    const reclaimed = { ...CLAIM, attempts: 2 };
    const secondExecution = vi.fn().mockImplementation(async () => {
      providerCalls.push('reclaimed-started');
      activeProviders += 1;
      maximumActiveProviders = Math.max(maximumActiveProviders, activeProviders);
      activeProviders -= 1;
    });
    const second = createWorker({
      claims: [reclaimed],
      executeClaim: secondExecution,
    });
    await expect(second.worker.runOnce()).resolves.toBe(1);

    expect(providerCalls).toEqual(['stale-started', 'stale-aborted', 'reclaimed-started']);
    expect(maximumActiveProviders).toBe(1);
    expect(activeProviders).toBe(0);
  });

  it('marks the consumer unavailable when its durable queue poll fails', async () => {
    const { worker, availability } = createWorker({
      claim: vi.fn().mockRejectedValue(new Error('worker database unavailable')),
    });

    await expect(worker.runOnce()).rejects.toThrow('worker database unavailable');
    expect(availability.markWorkerUnavailable).toHaveBeenCalledOnce();
    expect(availability.markWorkerReady).not.toHaveBeenCalled();
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
  readonly claim?: ReturnType<typeof vi.fn>;
  readonly renewLease?: ReturnType<typeof vi.fn>;
  readonly ownsLease?: ReturnType<typeof vi.fn>;
  readonly claimTtlMs?: number;
}) {
  const values: Partial<EnvironmentVariables> = {
    KNOWLEDGE_INGESTION_WORKER_ENABLED: true,
    KNOWLEDGE_INGESTION_POLL_INTERVAL_MS: 500,
    KNOWLEDGE_INGESTION_BATCH_SIZE: 2,
    KNOWLEDGE_INGESTION_MAX_ATTEMPTS: 5,
    KNOWLEDGE_INGESTION_RETRY_BASE_MS: 1_000,
    KNOWLEDGE_INGESTION_RETRY_MAX_MS: 60_000,
    KNOWLEDGE_INGESTION_CLAIM_TTL_MS: input?.claimTtlMs ?? 120_000,
  };
  const config = {
    get: vi.fn((key: keyof EnvironmentVariables) => values[key]),
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const jobs = {
    claim: input?.claim ?? vi.fn().mockResolvedValue(input?.claims ?? [CLAIM]),
    renewLease: input?.renewLease ?? vi.fn().mockResolvedValue(true),
    ownsLease: input?.ownsLease ?? vi.fn().mockResolvedValue(true),
    releaseForRetry: vi.fn().mockResolvedValue(true),
  };
  const ingestion = {
    executeClaim: input?.executeClaim ?? vi.fn().mockResolvedValue(undefined),
    failClaim: vi.fn().mockResolvedValue(true),
  };
  const availability = {
    markWorkerStarting: vi.fn(),
    markWorkerReady: vi.fn(),
    markWorkerUnavailable: vi.fn(),
    markWorkerStopped: vi.fn(),
  };
  const worker = new KnowledgeIngestionWorker(
    config,
    jobs as unknown as KnowledgeIngestionJobRepository,
    ingestion as unknown as KnowledgeIngestionProcessor,
    availability as never,
  );
  return { worker, jobs, ingestion, availability };
}
