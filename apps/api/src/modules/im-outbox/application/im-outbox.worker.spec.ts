import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';

import { validateEnvironment, type EnvironmentVariables } from '../../../config/environment.js';
import {
  ImDeliveryError,
  ImDeliveryProvider,
  type ImDeliveryContext,
  type ImDeliveryResult,
  type MessageCreatedDelivery,
} from '../domain/im-delivery.provider.js';
import {
  OutboxDeliveryRepository,
  type ClaimedOutboxEvent,
} from '../domain/outbox-delivery.repository.js';
import { LocalImDeliveryProvider } from '../infrastructure/local/local-im-delivery.provider.js';
import { calculateRetryDelay, ImOutboxWorker } from './im-outbox.worker.js';

describe('ImOutboxWorker', () => {
  it('publishes a claimed event with its stable outbox id as the idempotency key', async () => {
    const repository = new FakeRepository([messageEvent()]);
    const provider = new FakeProvider(async (_event, context) => {
      expect(context.idempotencyKey).toBe(EVENT_ID);
      expect(context.attempt).toBe(1);
      expect(context.firstAttemptedAt).toEqual(FIRST_ATTEMPTED_AT);
      return {
        outcome: 'accepted',
        deliveredRecipientCount: 1,
        providerMessageId: 'provider-001',
      };
    });
    const worker = createWorker(repository, provider);

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.published).toEqual([
      expect.objectContaining({
        eventId: EVENT_ID,
        providerName: 'fake',
        providerReceipt: {
          outcome: 'accepted',
          deliveredRecipientCount: 1,
          providerMessageId: 'provider-001',
        },
      }),
    ]);
    expect(repository.retried).toHaveLength(0);
    expect(repository.failed).toHaveLength(0);
    expect(repository.unknown).toHaveLength(0);
  });

  it('releases a retryable error with exponential backoff and redacts unknown messages', async () => {
    const repository = new FakeRepository([messageEvent({ attempts: 3 })]);
    const provider = new FakeProvider(async () => {
      throw new Error('credential=must-not-be-persisted');
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      await createWorker(repository, provider).runOnce();
    } finally {
      now.mockRestore();
      random.mockRestore();
    }

    expect(repository.retried).toEqual([
      expect.objectContaining({
        eventId: EVENT_ID,
        availableAt: new Date(1_004_000),
        error: 'UNEXPECTED_PROVIDER_ERROR: Error',
      }),
    ]);
  });

  it('moves permanent errors and exhausted retries to FAILED', async () => {
    const permanentRepository = new FakeRepository([messageEvent()]);
    const permanentProvider = new FakeProvider(async () => {
      throw new ImDeliveryError('RECIPIENT_REJECTED', 'recipient rejected', false);
    });
    await createWorker(permanentRepository, permanentProvider).runOnce();
    expect(permanentRepository.failed[0]?.error).toBe(
      'RECIPIENT_REJECTED: IM provider delivery failed',
    );

    const exhaustedRepository = new FakeRepository([messageEvent({ attempts: 8 })]);
    const exhaustedProvider = new FakeProvider(async () => {
      throw new ImDeliveryError('UPSTREAM_BUSY', 'provider unavailable', true);
    });
    await createWorker(exhaustedRepository, exhaustedProvider).runOnce();
    expect(exhaustedRepository.failed[0]?.error).toBe('UPSTREAM_BUSY: IM provider delivery failed');
  });

  it('moves exhausted ambiguous delivery errors to UNKNOWN with a safe provider transition', async () => {
    const repository = new FakeRepository([messageEvent({ attempts: 8 })]);
    const provider = new FakeProvider(async () => {
      throw new ImDeliveryError(
        'TENCENT_IM_NETWORK_ERROR',
        'request URL and credentials must not be persisted',
        true,
        'unknown',
      );
    });

    await createWorker(repository, provider).runOnce();

    expect(repository.unknown).toEqual([
      expect.objectContaining({
        eventId: EVENT_ID,
        providerName: 'fake',
        error: 'TENCENT_IM_NETWORK_ERROR: IM provider delivery failed',
      }),
    ]);
    expect(repository.failed).toHaveLength(0);
  });

  it('marks a worker-level provider timeout UNKNOWN only after its retry limit', async () => {
    const repository = new FakeRepository([messageEvent()]);
    const provider = new FakeProvider(async () => await new Promise<ImDeliveryResult>(() => {}));

    await createWorker(repository, provider, {
      IM_OUTBOX_MAX_ATTEMPTS: '1',
      IM_PROVIDER_TIMEOUT_MS: '100',
    }).runOnce();

    expect(repository.unknown[0]).toMatchObject({
      providerName: 'fake',
      error: 'PROVIDER_TIMEOUT: IM provider timed out',
    });
  });

  it('fails malformed recipient snapshots without invoking the provider', async () => {
    const malformed = messageEvent();
    const repository = new FakeRepository([
      { ...malformed, payload: { ...asRecord(malformed.payload), recipients: [] } },
    ]);
    const provider = new FakeProvider(async () => ({
      outcome: 'accepted',
      deliveredRecipientCount: 0,
    }));

    await createWorker(repository, provider).runOnce();
    expect(provider.calls).toBe(0);
    expect(repository.failed[0]?.error).toContain('MALFORMED_OUTBOX_EVENT');
  });

  it('treats an invalid provider success receipt as UNKNOWN at the retry limit', async () => {
    const repository = new FakeRepository([messageEvent()]);
    const provider = new FakeProvider(async () => ({
      outcome: 'accepted',
      deliveredRecipientCount: 2,
    }));

    await createWorker(repository, provider, { IM_OUTBOX_MAX_ATTEMPTS: '1' }).runOnce();
    expect(repository.unknown[0]?.error).toContain('INVALID_PROVIDER_RECEIPT');
    expect(repository.failed).toHaveLength(0);
  });
});

describe('LocalImDeliveryProvider', () => {
  it('explicitly skips an agent-only recipient instead of claiming an external delivery', async () => {
    const provider = new LocalImDeliveryProvider();
    const event = deliveryEvent({ recipients: [{ type: 'agent', id: AGENT_ID }] });
    await expect(
      provider.deliver(event, {
        idempotencyKey: EVENT_ID,
        attempt: 1,
        firstAttemptedAt: FIRST_ATTEMPTED_AT,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      outcome: 'skipped',
      deliveredRecipientCount: 0,
      reason: 'no_human_recipients',
    });
  });
});

describe('calculateRetryDelay', () => {
  it('uses a bounded exponential schedule', () => {
    expect(calculateRetryDelay(1, 1_000, 10_000, () => 0)).toBe(800);
    expect(calculateRetryDelay(3, 1_000, 10_000, () => 0.5)).toBe(4_000);
    expect(calculateRetryDelay(3, 1_000, 10_000, () => 1)).toBe(4_800);
    expect(calculateRetryDelay(30, 1_000, 10_000, () => 1)).toBe(10_000);
  });
});

const EVENT_ID = '00000000-0000-7000-8000-000000000801';
const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000802';
const CONVERSATION_ID = '00000000-0000-7000-8000-000000000803';
const SENDER_ID = '00000000-0000-7000-8000-000000000101';
const RECIPIENT_ID = '00000000-0000-7000-8000-000000000102';
const AGENT_ID = '00000000-0000-7000-8000-000000000201';
const FIRST_ATTEMPTED_AT = new Date('2026-07-15T00:00:01.000Z');

function messageEvent(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    eventType: 'message.created.v1',
    attempts: 1,
    firstAttemptedAt: FIRST_ATTEMPTED_AT,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    payload: {
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      conversationType: 'direct',
      sender: { type: 'user', id: SENDER_ID },
      recipients: [{ type: 'user', id: RECIPIENT_ID }],
      content: { type: 'text', text: 'hello' },
    },
    ...overrides,
  };
}

function deliveryEvent(overrides: Partial<MessageCreatedDelivery> = {}): MessageCreatedDelivery {
  return {
    eventId: EVENT_ID,
    tenantId: TENANT_ID,
    eventType: 'message.created.v1',
    conversationType: 'direct',
    messageId: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sender: { type: 'user', id: SENDER_ID },
    recipients: [{ type: 'user', id: RECIPIENT_ID }],
    content: { type: 'text', text: 'hello' },
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function createWorker(
  repository: OutboxDeliveryRepository,
  provider: ImDeliveryProvider,
  overrides: Record<string, string> = {},
): ImOutboxWorker {
  const values = validateEnvironment({
    NODE_ENV: 'test',
    REPOSITORY_DRIVER: 'prisma',
    DATABASE_URL: 'postgresql://localhost/test',
    IM_OUTBOX_ENABLED: 'true',
    ...overrides,
  });
  const config = new ConfigService<EnvironmentVariables, true>(values);
  return new ImOutboxWorker(config, repository, provider);
}

class FakeProvider extends ImDeliveryProvider {
  readonly name = 'fake';
  calls = 0;

  constructor(
    private readonly handler: (
      event: MessageCreatedDelivery,
      context: ImDeliveryContext,
    ) => Promise<ImDeliveryResult>,
  ) {
    super();
  }

  deliver(event: MessageCreatedDelivery, context: ImDeliveryContext): Promise<ImDeliveryResult> {
    this.calls += 1;
    return this.handler(event, context);
  }
}

class FakeRepository extends OutboxDeliveryRepository {
  published: Array<Parameters<OutboxDeliveryRepository['markPublished']>[0]> = [];
  retried: Array<Parameters<OutboxDeliveryRepository['releaseForRetry']>[0]> = [];
  failed: Array<Parameters<OutboxDeliveryRepository['markFailed']>[0]> = [];
  unknown: Array<Parameters<OutboxDeliveryRepository['markUnknown']>[0]> = [];

  constructor(private readonly events: readonly ClaimedOutboxEvent[]) {
    super();
  }

  claimMessageEvents(): Promise<readonly ClaimedOutboxEvent[]> {
    return Promise.resolve(this.events);
  }

  markPublished(input: Parameters<OutboxDeliveryRepository['markPublished']>[0]): Promise<boolean> {
    this.published.push(input);
    return Promise.resolve(true);
  }

  releaseForRetry(
    input: Parameters<OutboxDeliveryRepository['releaseForRetry']>[0],
  ): Promise<boolean> {
    this.retried.push(input);
    return Promise.resolve(true);
  }

  markFailed(input: Parameters<OutboxDeliveryRepository['markFailed']>[0]): Promise<boolean> {
    this.failed.push(input);
    return Promise.resolve(true);
  }

  markUnknown(input: Parameters<OutboxDeliveryRepository['markUnknown']>[0]): Promise<boolean> {
    this.unknown.push(input);
    return Promise.resolve(true);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
