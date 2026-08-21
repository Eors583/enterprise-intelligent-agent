import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { EnvironmentVariables } from '../../../config/environment.js';
import {
  KnowledgeIngestionJobRepository,
  type ClaimedKnowledgeIngestionJob,
} from '../domain/knowledge-ingestion-job.repository.js';
import {
  KnowledgeIngestionLeaseLostError,
  KnowledgeIngestionProcessor,
  describeKnowledgeIngestionError,
  type KnowledgeIngestionFailure,
  type KnowledgeIngestionLeaseControl,
} from './knowledge-ingestion.service.js';
import { KnowledgeIngestionAvailabilityService } from './knowledge-ingestion-availability.service.js';

@Injectable()
export class KnowledgeIngestionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KnowledgeIngestionWorker.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly claimTtlMs: number;
  private readonly workerId = `knowledge-ingestion:${process.pid}:${randomUUID()}`;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(KnowledgeIngestionJobRepository)
    private readonly jobs: KnowledgeIngestionJobRepository,
    @Inject(KnowledgeIngestionProcessor)
    private readonly ingestion: KnowledgeIngestionProcessor,
    @Inject(KnowledgeIngestionAvailabilityService)
    private readonly availability: KnowledgeIngestionAvailabilityService,
  ) {
    this.enabled = config.get('KNOWLEDGE_INGESTION_WORKER_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('KNOWLEDGE_INGESTION_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('KNOWLEDGE_INGESTION_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('KNOWLEDGE_INGESTION_MAX_ATTEMPTS', { infer: true });
    this.retryBaseMs = config.get('KNOWLEDGE_INGESTION_RETRY_BASE_MS', { infer: true });
    this.retryMaxMs = config.get('KNOWLEDGE_INGESTION_RETRY_MAX_MS', { infer: true });
    this.claimTtlMs = config.get('KNOWLEDGE_INGESTION_CLAIM_TTL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.availability.markWorkerStopped();
      this.logger.log('Knowledge ingestion worker is disabled.');
      return;
    }
    this.stopped = false;
    this.availability.markWorkerStarting();
    this.logger.log(`Starting knowledge ingestion worker ${this.workerId}.`);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.availability.markWorkerStopped();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  /** Runs one bounded claim batch; exposed for deterministic operational tests. */
  async runOnce(): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const claims = await this.jobs.claim({
        workerId: this.workerId,
        batchSize: this.batchSize,
        claimTtlMs: this.claimTtlMs,
      });
      const settled = await Promise.allSettled(claims.map((claim) => this.processClaim(claim)));
      for (const result of settled) {
        if (result.status === 'rejected') {
          this.logger.error(
            `Unable to persist a knowledge ingestion transition (${errorKind(result.reason)}).`,
          );
        }
      }
      this.availability.markWorkerReady();
      return claims.length;
    } catch (error) {
      this.availability.markWorkerUnavailable();
      throw error;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const tick = this.tick();
      this.activeTick = tick;
      void tick.finally(() => {
        if (this.activeTick === tick) this.activeTick = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Knowledge ingestion polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }

  private async processClaim(claim: ClaimedKnowledgeIngestionJob): Promise<void> {
    const heartbeat = this.startHeartbeat(claim);
    let failure: unknown;
    try {
      await this.ingestion.executeClaim(claim, this.workerId, heartbeat.lease);
    } catch (error) {
      failure = error;
    } finally {
      await heartbeat.stop();
    }
    if (heartbeat.lost()) {
      this.logLostLease(claim.id);
      return;
    }
    if (failure === undefined) return;
    if (failure instanceof KnowledgeIngestionLeaseLostError) {
      this.logLostLease(claim.id);
      return;
    }
    this.logger.error(
      `Knowledge ingestion job ${claim.id} failed during processing (${safeFailureDetail(failure)}).`,
    );
    await this.failOrRetry(claim, describeKnowledgeIngestionError(failure));
  }

  private startHeartbeat(claim: ClaimedKnowledgeIngestionJob): {
    readonly lease: KnowledgeIngestionLeaseControl;
    readonly lost: () => boolean;
    readonly stop: () => Promise<void>;
  } {
    let lost = false;
    const controller = new AbortController();
    let leaseOperation: Promise<void> = Promise.resolve();
    const markLost = (): void => {
      if (lost) return;
      lost = true;
      controller.abort();
    };
    const runLeaseOperation = (
      operation: () => Promise<boolean>,
      failureMessage: string,
    ): Promise<void> => {
      leaseOperation = leaseOperation.then(async () => {
        if (lost) return;
        try {
          if (!(await operation())) markLost();
        } catch (error) {
          markLost();
          this.logger.error(`${failureMessage} (${errorKind(error)}).`);
        }
      });
      return leaseOperation;
    };
    const intervalMs = Math.max(1_000, Math.floor(this.claimTtlMs / 3));
    const timer = setInterval(() => {
      void runLeaseOperation(
        () =>
          this.jobs.renewLease({
            jobId: claim.id,
            workerId: this.workerId,
            claimTtlMs: this.claimTtlMs,
          }),
        'Knowledge ingestion lease renewal failed',
      );
    }, intervalMs);
    timer.unref();
    return {
      lease: {
        signal: controller.signal,
        assertOwned: async () => {
          await runLeaseOperation(
            () =>
              this.jobs.ownsLease({
                jobId: claim.id,
                workerId: this.workerId,
              }),
            'Knowledge ingestion lease ownership check failed',
          );
          if (lost) throw new KnowledgeIngestionLeaseLostError();
        },
      },
      lost: () => lost,
      stop: async () => {
        clearInterval(timer);
        await leaseOperation;
      },
    };
  }

  private async failOrRetry(
    claim: ClaimedKnowledgeIngestionJob,
    failure: KnowledgeIngestionFailure,
  ): Promise<void> {
    const nextFailureAttempt = claim.failureAttempts + 1;
    if (!failure.retryable || nextFailureAttempt >= this.maxAttempts) {
      await this.transitionFailed(claim, failure);
      return;
    }
    const delayMs = calculateKnowledgeIngestionRetryDelay(
      nextFailureAttempt,
      this.retryBaseMs,
      this.retryMaxMs,
      Math.random,
    );
    const updated = await this.jobs.releaseForRetry({
      jobId: claim.id,
      workerId: this.workerId,
      availableAt: new Date(Date.now() + delayMs),
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    if (!updated) this.logLostLease(claim.id);
  }

  private async transitionFailed(
    claim: ClaimedKnowledgeIngestionJob,
    failure: KnowledgeIngestionFailure,
  ): Promise<void> {
    const updated = await this.ingestion.failClaim(claim, this.workerId, failure);
    if (!updated) this.logLostLease(claim.id);
  }

  private logLostLease(jobId: string): void {
    this.logger.warn(`Ignored stale transition for knowledge ingestion job ${jobId}.`);
  }
}

export function calculateKnowledgeIngestionRetryDelay(
  attempt: number,
  baseMs: number,
  maximumMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const exponentialDelay = Math.min(maximumMs, baseMs * 2 ** exponent);
  const jitter = 0.8 + clampRandom(random()) * 0.4;
  return Math.min(maximumMs, Math.round(exponentialDelay * jitter));
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function safeFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return `${error.name}: ${error.message.replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ').slice(0, 300)}`;
}
