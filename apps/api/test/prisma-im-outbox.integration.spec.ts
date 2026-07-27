import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { validateEnvironment, type EnvironmentVariables } from '../src/config/environment.js';
import { OutboxPrismaService } from '../src/database/outbox-prisma.service.js';
import { ImOutboxWorker } from '../src/modules/im-outbox/application/im-outbox.worker.js';
import {
  ImDeliveryError,
  ImDeliveryProvider,
  type ImDeliveryContext,
  type ImDeliveryResult,
  type MessageCreatedDelivery,
} from '../src/modules/im-outbox/domain/im-delivery.provider.js';
import { LocalImDeliveryProvider } from '../src/modules/im-outbox/infrastructure/local/local-im-delivery.provider.js';
import { PrismaOutboxDeliveryRepository } from '../src/modules/im-outbox/infrastructure/prisma/prisma-outbox-delivery.repository.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantId = '00000000-0000-7000-8000-000000000008';

describe.runIf(enabled)('PostgreSQL IM outbox delivery', () => {
  const administrator = new PrismaClient();
  const leftClient = createOutboxClient();
  const rightClient = createOutboxClient();
  const leftRepository = new PrismaOutboxDeliveryRepository(leftClient);
  const rightRepository = new PrismaOutboxDeliveryRepository(rightClient);

  beforeAll(async () => {
    await Promise.all([leftClient.onModuleInit(), rightClient.onModuleInit()]);
    await cleanup();
    await administrator.tenant.create({
      data: { id: tenantId, slug: 'im-outbox-integration', name: 'IM Outbox Integration' },
    });
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([
      leftClient.onModuleDestroy(),
      rightClient.onModuleDestroy(),
      administrator.$disconnect(),
    ]);
  });

  it('uses SKIP LOCKED leases so concurrent instances never claim the same event', async () => {
    const ids = await createEvents(4, 'concurrent');
    const [left, right] = await Promise.all([
      leftRepository.claimMessageEvents({
        workerId: 'worker-left',
        batchSize: 2,
        claimTtlMs: 30_000,
      }),
      rightRepository.claimMessageEvents({
        workerId: 'worker-right',
        batchSize: 2,
        claimTtlMs: 30_000,
      }),
    ]);
    const claimedIds = [...left, ...right].map((event) => event.id);

    expect(claimedIds).toHaveLength(4);
    expect(new Set(claimedIds).size).toBe(4);
    expect(new Set(claimedIds)).toEqual(new Set(ids));

    await Promise.all([
      ...left.map((event) => publish(leftRepository, event.id, 'worker-left')),
      ...right.map((event) => publish(rightRepository, event.id, 'worker-right')),
    ]);
    const stored = await administrator.outboxEvent.findMany({ where: { id: { in: ids } } });
    expect(
      stored.every(
        (event) =>
          event.status === 'PUBLISHED' &&
          event.attempts === 1 &&
          event.firstAttemptedAt instanceof Date,
      ),
    ).toBe(true);
  });

  it('recovers an expired lease and rejects the stale owner transition', async () => {
    const [eventId, sentinelId] = pair(await createEvents(2, 'expired'));
    const first = only(
      await leftRepository.claimMessageEvents({
        workerId: 'worker-stale',
        batchSize: 1,
        claimTtlMs: 30_000,
      }),
    );
    expect(first.id).toBe(eventId);
    const visibleClaim = only(
      await rightRepository.claimMessageEvents({
        workerId: 'worker-current',
        batchSize: 1,
        claimTtlMs: 30_000,
      }),
    );
    expect(visibleClaim.id).toBe(sentinelId);
    expect(visibleClaim.id).not.toBe(eventId);
    await publish(rightRepository, visibleClaim.id, 'worker-current');

    await administrator.outboxEvent.update({
      where: { id: eventId },
      data: { lockedUntil: new Date('2000-01-01T00:00:00.000Z') },
    });
    const reclaimed = only(
      await rightRepository.claimMessageEvents({
        workerId: 'worker-current',
        batchSize: 1,
        claimTtlMs: 30_000,
      }),
    );
    expect(reclaimed).toMatchObject({ id: eventId, attempts: 2 });
    expect(reclaimed.firstAttemptedAt).toEqual(first.firstAttemptedAt);
    await expect(publish(leftRepository, eventId, 'worker-stale')).resolves.toBe(false);
    await expect(publish(rightRepository, eventId, 'worker-current')).resolves.toBe(true);
  });

  it('publishes human delivery and records an explicit agent-only skip receipt', async () => {
    const humanEventId = only(await createEvents(1, 'local-human'));
    const humanWorker = createWorker(leftRepository, new LocalImDeliveryProvider());
    await expect(humanWorker.runOnce()).resolves.toBe(1);
    await expect(
      administrator.outboxEvent.findUniqueOrThrow({ where: { id: humanEventId } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHED',
      providerName: 'local',
      providerReceipt: {
        outcome: 'accepted',
        deliveredRecipientCount: 1,
        providerMessageId: humanEventId,
      },
    });

    const agentEventId = only(await createEvents(1, 'local-agent', 'agent'));
    await expect(humanWorker.runOnce()).resolves.toBe(1);
    await expect(
      administrator.outboxEvent.findUniqueOrThrow({ where: { id: agentEventId } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHED',
      providerName: 'local',
      providerReceipt: {
        outcome: 'skipped',
        deliveredRecipientCount: 0,
        reason: 'no_human_recipients',
      },
    });
  });

  it('persists retry backoff then marks FAILED at the configured limit', async () => {
    const eventId = only(await createEvents(1, 'retry'));
    const provider = new RejectingProvider();
    const worker = createWorker(leftRepository, provider, { IM_OUTBOX_MAX_ATTEMPTS: '2' });

    await expect(worker.runOnce()).resolves.toBe(1);
    let stored = await administrator.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(stored).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lockedBy: null,
      lastError: 'UPSTREAM_UNAVAILABLE: IM provider delivery failed',
    });
    const firstAttemptedAt = stored.firstAttemptedAt;
    expect(firstAttemptedAt).toBeInstanceOf(Date);
    expect(stored.availableAt.getTime()).toBeGreaterThan(Date.now());

    await administrator.outboxEvent.update({
      where: { id: eventId },
      data: { availableAt: new Date('2000-01-01T00:00:00.000Z') },
    });
    await expect(worker.runOnce()).resolves.toBe(1);
    stored = await administrator.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(stored).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      lockedBy: null,
      lockedUntil: null,
      lastError: 'UPSTREAM_UNAVAILABLE: IM provider delivery failed',
    });
    expect(stored.firstAttemptedAt).toEqual(firstAttemptedAt);
  });

  it('persists an exhausted indeterminate provider result as UNKNOWN', async () => {
    const eventId = only(await createEvents(1, 'unknown'));
    const worker = createWorker(leftRepository, new UnknownRejectingProvider(), {
      IM_OUTBOX_MAX_ATTEMPTS: '1',
    });

    await expect(worker.runOnce()).resolves.toBe(1);

    await expect(
      administrator.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }),
    ).resolves.toMatchObject({
      status: 'UNKNOWN',
      attempts: 1,
      providerName: 'unknown-rejecting',
      providerReceipt: {
        outcome: 'unknown',
        deliveredRecipientCount: 0,
        reason: 'delivery_outcome_unknown',
      },
      publishedAt: null,
      lockedBy: null,
      lockedUntil: null,
      lastError: 'NETWORK_RESULT_INDETERMINATE: IM provider delivery failed',
    });
  });

  it('enforces the UNKNOWN receipt and error state invariants', async () => {
    const eventId = only(await createEvents(1, 'invalid-unknown'));

    await expect(
      administrator.outboxEvent.update({
        where: { id: eventId },
        data: { status: 'UNKNOWN' },
      }),
    ).rejects.toThrow();
  });

  it('cannot use the cross-tenant outbox role to read business tables', async () => {
    await expect(
      leftClient.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_outbox');
        return transaction.user.count();
      }),
    ).rejects.toThrow();
  });

  async function createEvents(
    count: number,
    prefix: string,
    recipientType: 'user' | 'agent' = 'user',
  ): Promise<string[]> {
    const rows = Array.from({ length: count }, (_, index) => ({
      tenantId,
      aggregateType: 'message',
      aggregateId: randomUUID(),
      eventType: 'message.created.v1',
      availableAt: new Date(`1999-01-01T00:00:${String(index).padStart(2, '0')}.000Z`),
      payload: messagePayload(`${prefix}-${index}`, recipientType),
    }));
    await administrator.outboxEvent.createMany({ data: rows });
    const stored = await administrator.outboxEvent.findMany({
      where: { tenantId, aggregateId: { in: rows.map((row) => row.aggregateId) } },
      orderBy: { availableAt: 'asc' },
    });
    return stored.map((event) => event.id);
  }

  async function cleanup(): Promise<void> {
    await administrator.outboxEvent.deleteMany({ where: { tenantId } });
    await administrator.tenant.deleteMany({ where: { id: tenantId } });
  }
});

function createOutboxClient(): OutboxPrismaService {
  return new OutboxPrismaService(createConfig());
}

function createWorker(
  repository: PrismaOutboxDeliveryRepository,
  provider: ImDeliveryProvider,
  overrides: Record<string, string> = {},
): ImOutboxWorker {
  return new ImOutboxWorker(createConfig(overrides), repository, provider);
}

function createConfig(
  overrides: Record<string, string> = {},
): ConfigService<EnvironmentVariables, true> {
  const databaseUrl =
    process.env.DATABASE_URL ??
    (enabled ? undefined : 'postgresql://skipped:skipped@127.0.0.1:1/skipped');
  const values = validateEnvironment({
    NODE_ENV: 'test',
    REPOSITORY_DRIVER: 'prisma',
    DATABASE_URL: databaseUrl,
    OUTBOX_DATABASE_URL: process.env.OUTBOX_DATABASE_URL ?? databaseUrl,
    IM_OUTBOX_ENABLED: 'true',
    IM_OUTBOX_BATCH_SIZE: '1',
    ...overrides,
  });
  return new ConfigService<EnvironmentVariables, true>(values);
}

function messagePayload(key: string, recipientType: 'user' | 'agent'): object {
  return {
    messageId: randomUUID(),
    conversationId: randomUUID(),
    sender: { type: 'user', id: randomUUID() },
    recipients: [{ type: recipientType, id: randomUUID() }],
    content: { type: 'text', text: `integration-${key}` },
  };
}

function publish(
  repository: PrismaOutboxDeliveryRepository,
  eventId: string,
  workerId: string,
): Promise<boolean> {
  return repository.markPublished({
    eventId,
    workerId,
    providerName: 'integration',
    providerReceipt: { outcome: 'accepted', deliveredRecipientCount: 1 },
  });
}

class RejectingProvider extends ImDeliveryProvider {
  readonly name = 'rejecting';

  deliver(_event: MessageCreatedDelivery, _context: ImDeliveryContext): Promise<ImDeliveryResult> {
    return Promise.reject(
      new ImDeliveryError('UPSTREAM_UNAVAILABLE', 'unsafe upstream body', true),
    );
  }
}

class UnknownRejectingProvider extends ImDeliveryProvider {
  readonly name = 'unknown-rejecting';

  deliver(_event: MessageCreatedDelivery, _context: ImDeliveryContext): Promise<ImDeliveryResult> {
    return Promise.reject(
      new ImDeliveryError(
        'NETWORK_RESULT_INDETERMINATE',
        'secret upstream response must not be persisted',
        true,
        'unknown',
      ),
    );
  }
}

function only<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined || values.length !== 1) {
    throw new Error(`Expected exactly one value, received ${values.length}.`);
  }
  return value;
}

function pair<T>(values: readonly T[]): readonly [T, T] {
  const left = values[0];
  const right = values[1];
  if (left === undefined || right === undefined || values.length !== 2) {
    throw new Error(`Expected exactly two values, received ${values.length}.`);
  }
  return [left, right];
}
