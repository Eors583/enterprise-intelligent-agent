import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { KnowledgeIngestionAvailabilityService } from './knowledge-ingestion-availability.service.js';

describe('KnowledgeIngestionAvailabilityService', () => {
  it('fails closed for production writes until the enabled consumer proves a queue poll', () => {
    const availability = createAvailability({
      NODE_ENV: 'production',
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: true,
      KNOWLEDGE_INGESTION_WORKER_ENABLED: true,
    });

    availability.markWorkerStarting();
    expect(() => availability.assertPersistentWritesAvailable()).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'KNOWLEDGE_INGESTION_CONSUMER_UNAVAILABLE',
          statusCode: 503,
        }),
      }),
    );
    expect(() => availability.readinessStatus()).toThrow(ServiceUnavailableException);

    availability.markWorkerReady();
    expect(() => availability.assertPersistentWritesAvailable()).not.toThrow();
    expect(availability.readinessStatus()).toBe('up');

    availability.markWorkerUnavailable();
    expect(() => availability.assertPersistentWritesAvailable()).toThrow(
      ServiceUnavailableException,
    );
  });

  it('returns an explicit 503 when persistent knowledge writes are disabled', () => {
    const availability = createAvailability({
      NODE_ENV: 'production',
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: false,
      KNOWLEDGE_INGESTION_WORKER_ENABLED: false,
    });

    expect(availability.readinessStatus()).toBe('disabled');
    expect(() => availability.assertPersistentWritesAvailable()).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'KNOWLEDGE_PERSISTENT_WRITES_DISABLED',
          statusCode: 503,
        }),
      }),
    );
  });

  it('keeps development and tests operable without making their worker lifecycle a hard gate', () => {
    const availability = createAvailability({
      NODE_ENV: 'test',
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: true,
      KNOWLEDGE_INGESTION_WORKER_ENABLED: false,
    });

    expect(() => availability.assertPersistentWritesAvailable()).not.toThrow();
    expect(availability.readinessStatus()).toBe('not_required');
  });
});

function createAvailability(
  values: Pick<
    EnvironmentVariables,
    'NODE_ENV' | 'KNOWLEDGE_PERSISTENT_WRITES_ENABLED' | 'KNOWLEDGE_INGESTION_WORKER_ENABLED'
  >,
): KnowledgeIngestionAvailabilityService {
  const config = {
    get: (key: keyof typeof values) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return new KnowledgeIngestionAvailabilityService(config);
}
