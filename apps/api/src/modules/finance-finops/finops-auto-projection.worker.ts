import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { FinopsAutoProjectionReconciler } from './finops-auto-projection.reconciler.js';
import type { EnvironmentVariables } from '../../config/environment.js';

@Injectable()
export class FinopsAutoProjectionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FinopsAutoProjectionWorker.name);
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly workerId = `finops-projector:${process.pid}:${randomUUID()}`;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(FinopsAutoProjectionReconciler)
    private readonly reconciler: FinopsAutoProjectionReconciler,
  ) {
    this.enabled = config.get('FINOPS_PROJECTION_WORKER_ENABLED', { infer: true });
    this.batchSize = config.get('FINOPS_PROJECTION_BATCH_SIZE', { infer: true });
    this.pollIntervalMs = config.get('FINOPS_PROJECTION_POLL_INTERVAL_MS', { infer: true });
    this.claimTtlMs = config.get('FINOPS_PROJECTION_CLAIM_TTL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Automatic FinOps projection worker is disabled.');
      return;
    }
    this.stopped = false;
    this.logger.log(`Starting automatic FinOps projection worker ${this.workerId}.`);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  async runOnce(): Promise<number> {
    if (!this.enabled) return 0;
    return this.reconciler.reconcileBatch({
      workerId: this.workerId,
      batchSize: this.batchSize,
      claimTtlMs: this.claimTtlMs,
    });
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
      this.logger.error(
        `Automatic FinOps projection failed (${error instanceof Error ? error.name : 'unknown'}).`,
      );
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }
}
