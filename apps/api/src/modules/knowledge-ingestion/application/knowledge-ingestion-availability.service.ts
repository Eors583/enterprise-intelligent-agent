import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';

type WorkerState = 'starting' | 'ready' | 'unavailable' | 'stopped';

export type KnowledgeIngestionReadinessStatus = 'up' | 'disabled' | 'not_required';

/**
 * Runtime gate shared by the producer-facing knowledge commands, the embedded
 * consumer and the public readiness probe.
 *
 * Production writes are accepted only after the consumer has completed at
 * least one successful durable-queue poll. This prevents a configured but
 * broken worker login from turning uploads into permanently queued work.
 */
@Injectable()
export class KnowledgeIngestionAvailabilityService {
  private readonly production: boolean;
  private readonly persistentWritesEnabled: boolean;
  private readonly workerEnabled: boolean;
  private workerState: WorkerState = 'stopped';

  constructor(
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
    this.persistentWritesEnabled = config.get('KNOWLEDGE_PERSISTENT_WRITES_ENABLED', {
      infer: true,
    });
    this.workerEnabled = config.get('KNOWLEDGE_INGESTION_WORKER_ENABLED', { infer: true });
  }

  markWorkerStarting(): void {
    if (this.workerEnabled) this.workerState = 'starting';
  }

  markWorkerReady(): void {
    if (this.workerEnabled) this.workerState = 'ready';
  }

  markWorkerUnavailable(): void {
    if (this.workerEnabled) this.workerState = 'unavailable';
  }

  markWorkerStopped(): void {
    this.workerState = 'stopped';
  }

  assertPersistentWritesAvailable(): void {
    if (!this.persistentWritesEnabled) {
      throw knowledgeIngestionUnavailable(
        'KNOWLEDGE_PERSISTENT_WRITES_DISABLED',
        'Knowledge ingestion writes are disabled for this deployment.',
      );
    }
    this.assertProductionConsumerReady();
  }

  readinessStatus(): KnowledgeIngestionReadinessStatus {
    if (!this.persistentWritesEnabled) return 'disabled';
    this.assertProductionConsumerReady();
    if (!this.production || !this.workerEnabled) return 'not_required';
    return 'up';
  }

  private assertProductionConsumerReady(): void {
    if (!this.production) return;
    if (!this.workerEnabled || this.workerState !== 'ready') {
      throw knowledgeIngestionUnavailable(
        'KNOWLEDGE_INGESTION_CONSUMER_UNAVAILABLE',
        'Knowledge ingestion is temporarily unavailable because no healthy consumer is ready.',
      );
    }
  }
}

function knowledgeIngestionUnavailable(code: string, message: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code,
    message,
  });
}
