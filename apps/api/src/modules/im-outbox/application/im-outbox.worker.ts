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
  ImDeliveryError,
  ImDeliveryProvider,
  parseMessageCreatedDelivery,
  type ImDeliveryResult,
} from '../domain/im-delivery.provider.js';
import {
  OutboxDeliveryRepository,
  type ClaimedOutboxEvent,
} from '../domain/outbox-delivery.repository.js';

@Injectable()
export class ImOutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ImOutboxWorker.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly claimTtlMs: number;
  private readonly providerTimeoutMs: number;
  private readonly workerId = `outbox:${process.pid}:${randomUUID()}`;
  private readonly activeControllers = new Set<AbortController>();
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    @Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>,
    @Inject(OutboxDeliveryRepository)
    private readonly repository: OutboxDeliveryRepository,
    @Inject(ImDeliveryProvider) private readonly provider: ImDeliveryProvider,
  ) {
    this.enabled = config.get('IM_OUTBOX_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('IM_OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('IM_OUTBOX_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('IM_OUTBOX_MAX_ATTEMPTS', { infer: true });
    this.retryBaseMs = config.get('IM_OUTBOX_RETRY_BASE_MS', { infer: true });
    this.retryMaxMs = config.get('IM_OUTBOX_RETRY_MAX_MS', { infer: true });
    this.claimTtlMs = config.get('IM_OUTBOX_CLAIM_TTL_MS', { infer: true });
    this.providerTimeoutMs = config.get('IM_PROVIDER_TIMEOUT_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('IM outbox worker is disabled.');
      return;
    }

    this.stopped = false;
    this.logger.log(
      `Starting IM outbox worker ${this.workerId} with provider ${this.provider.name}.`,
    );
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;

    const shutdownError = new ImDeliveryError(
      'WORKER_SHUTDOWN',
      'IM outbox worker is shutting down',
      true,
    );
    for (const controller of this.activeControllers) controller.abort(shutdownError);
    await this.activeTick;
  }

  /** Runs one bounded claim batch; exposed for deterministic operational tests. */
  async runOnce(): Promise<number> {
    if (!this.enabled) return 0;

    const events = await this.repository.claimMessageEvents({
      workerId: this.workerId,
      batchSize: this.batchSize,
      claimTtlMs: this.claimTtlMs,
    });
    const results = await Promise.allSettled(events.map((event) => this.processEvent(event)));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Unable to persist an IM outbox delivery transition (${errorKind(result.reason)}).`,
        );
      }
    }
    return events.length;
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
      this.logger.error(`IM outbox polling failed (${errorKind(error)}).`);
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }

  private async processEvent(event: ClaimedOutboxEvent): Promise<void> {
    let delivery;
    try {
      delivery = parseMessageCreatedDelivery(event);
    } catch (error) {
      await this.failOrRetry(event, error);
      return;
    }

    try {
      const receipt = await this.deliverWithTimeout(delivery, event);
      validateProviderReceipt(receipt, delivery.recipients.length);
      const updated = await this.repository.markPublished({
        eventId: event.id,
        workerId: this.workerId,
        providerName: this.provider.name,
        providerReceipt: receipt,
      });
      if (!updated) this.logLostLease(event.id);
    } catch (error) {
      await this.failOrRetry(event, error);
    }
  }

  private async deliverWithTimeout(
    event: ReturnType<typeof parseMessageCreatedDelivery>,
    claimed: ClaimedOutboxEvent,
  ): Promise<ImDeliveryResult> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timeout: NodeJS.Timeout | undefined;

    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new ImDeliveryError('DELIVERY_ABORTED', 'IM delivery was aborted', true),
          );
        },
        { once: true },
      );
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new ImDeliveryError(
          'PROVIDER_TIMEOUT',
          'IM provider did not respond before its timeout',
          true,
          'unknown',
        );
        controller.abort(error);
        reject(error);
      }, this.providerTimeoutMs);
      timeout.unref();
    });

    try {
      return await Promise.race([
        this.provider.deliver(event, {
          idempotencyKey: event.eventId,
          attempt: claimed.attempts,
          firstAttemptedAt: claimed.firstAttemptedAt,
          signal: controller.signal,
        }),
        aborted,
        timedOut,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private async failOrRetry(event: ClaimedOutboxEvent, error: unknown): Promise<void> {
    const retryable = !(error instanceof ImDeliveryError) || error.retryable;
    const safeError = safeDeliveryError(error);
    if (!retryable || event.attempts >= this.maxAttempts) {
      const updated =
        error instanceof ImDeliveryError && error.terminalOutcome === 'unknown'
          ? await this.repository.markUnknown({
              eventId: event.id,
              workerId: this.workerId,
              providerName: this.provider.name,
              error: safeError,
            })
          : await this.repository.markFailed({
              eventId: event.id,
              workerId: this.workerId,
              error: safeError,
            });
      if (!updated) this.logLostLease(event.id);
      return;
    }

    const retryDelay = calculateRetryDelay(
      event.attempts,
      this.retryBaseMs,
      this.retryMaxMs,
      Math.random,
    );
    const updated = await this.repository.releaseForRetry({
      eventId: event.id,
      workerId: this.workerId,
      availableAt: new Date(Date.now() + retryDelay),
      error: safeError,
    });
    if (!updated) this.logLostLease(event.id);
  }

  private logLostLease(eventId: string): void {
    this.logger.warn(`Ignored stale transition for outbox event ${eventId}; its lease changed.`);
  }
}

export function calculateRetryDelay(
  attempt: number,
  baseMs: number,
  maximumMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const exponentialDelay = Math.min(maximumMs, baseMs * 2 ** exponent);
  const jitterFactor = 0.8 + clampRandom(random()) * 0.4;
  return Math.min(maximumMs, Math.round(exponentialDelay * jitterFactor));
}

function validateProviderReceipt(receipt: ImDeliveryResult, recipientCount: number): void {
  if (
    !Number.isInteger(receipt.deliveredRecipientCount) ||
    receipt.deliveredRecipientCount < 0 ||
    receipt.deliveredRecipientCount > recipientCount ||
    (receipt.outcome === 'skipped' && receipt.deliveredRecipientCount !== 0)
  ) {
    throw new ImDeliveryError(
      'INVALID_PROVIDER_RECEIPT',
      'IM provider returned an invalid delivery receipt',
      true,
      'unknown',
    );
  }
}

function safeDeliveryError(error: unknown): string {
  if (error instanceof ImDeliveryError) {
    const code = /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'PROVIDER_ERROR';
    return `${code}: ${safeErrorDescription(code)}`;
  }
  return `UNEXPECTED_PROVIDER_ERROR: ${errorKind(error)}`;
}

function safeErrorDescription(code: string): string {
  switch (code) {
    case 'MALFORMED_OUTBOX_EVENT':
      return 'outbox event validation failed';
    case 'PROVIDER_TIMEOUT':
      return 'IM provider timed out';
    case 'WORKER_SHUTDOWN':
    case 'DELIVERY_ABORTED':
      return 'delivery was interrupted';
    case 'INVALID_PROVIDER_RECEIPT':
      return 'IM provider returned an invalid receipt';
    default:
      return 'IM provider delivery failed';
  }
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
