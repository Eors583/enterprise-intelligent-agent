import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeIdentityPort } from '../process-orchestration/application/runtime-identity.port.js';
import {
  ADMIN_PRINCIPAL,
  DELIVERY_ID,
  EVENT_ID,
  MEMBER_PRINCIPAL,
  businessEvent,
  delivery,
} from '../process-orchestration/testing/runtime-test-fixtures.js';
import type {
  BusinessEventRepository,
  ReplayBusinessEventDeliveryRequest,
} from './business-event.repository.js';
import { BusinessEventService } from './business-event.service.js';

const REPLAY_REQUEST: ReplayBusinessEventDeliveryRequest = {
  expectedStatus: 'DEAD_LETTERED',
  reason: 'The provider has recovered.',
  idempotencyKey: 'delivery:replay:1',
};

describe('BusinessEventService', () => {
  it('lists a bounded tenant-owned Business Event page', async () => {
    const listEvents = vi.fn().mockResolvedValue({
      items: [businessEvent()],
      nextCursor: null,
    });
    const { service } = createService({ repository: { listEvents } });

    const response = await service.listEvents();

    expect(response.items).toHaveLength(1);
    expect(listEvents).toHaveBeenCalledWith(ADMIN_PRINCIPAL, {
      cursor: null,
      limit: 100,
    });
  });

  it('rejects event governance reads for a non-admin caller', async () => {
    const listEvents = vi.fn();
    const { service } = createService({
      repository: { listEvents },
      principal: MEMBER_PRINCIPAL,
    });

    await expect(service.listEvents()).rejects.toBeInstanceOf(ForbiddenException);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('maps an absent Business Event to 404', async () => {
    const { service } = createService({
      repository: { findEvent: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.getEvent(EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a complete contract-valid event delivery trace', async () => {
    const findEvent = vi.fn().mockResolvedValue({
      event: businessEvent(),
      deliveries: [delivery()],
    });
    const { service } = createService({ repository: { findEvent } });

    const response = await service.getEvent(EVENT_ID);

    expect(response.event.eventId).toBe(EVENT_ID);
    expect(response.deliveries).toHaveLength(1);
    expect(findEvent).toHaveBeenCalledWith(ADMIN_PRINCIPAL, EVENT_ID);
  });

  it('replays a DLQ delivery and verifies the authoritative response', async () => {
    const replayDelivery = vi.fn().mockResolvedValue({
      kind: 'APPLIED',
      value: delivery({
        status: 'PENDING',
        deadLetteredAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        updatedAt: '2026-07-28T01:10:00.000Z',
      }),
    });
    const { service } = createService({ repository: { replayDelivery } });

    const response = await service.replayDelivery(DELIVERY_ID, REPLAY_REQUEST);

    expect(response.status).toBe('PENDING');
    expect(replayDelivery).toHaveBeenCalledWith({
      principal: ADMIN_PRINCIPAL,
      deliveryId: DELIVERY_ID,
      request: REPLAY_REQUEST,
    });
  });

  it('maps an idempotency collision to 409 and an invalid replay to 422', async () => {
    const replayDelivery = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'IDEMPOTENCY_CONFLICT' })
      .mockResolvedValueOnce({
        kind: 'REJECTED',
        reason: 'INVALID_TRANSITION',
        detail: 'Only dead-lettered deliveries can be replayed.',
      });
    const { service } = createService({ repository: { replayDelivery } });

    await expect(service.replayDelivery(DELIVERY_ID, REPLAY_REQUEST)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.replayDelivery(DELIVERY_ID, REPLAY_REQUEST)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('rejects a cross-tenant adapter result', async () => {
    const { service } = createService({
      repository: {
        findEvent: vi.fn().mockResolvedValue({
          event: { ...businessEvent(), tenantId: '00000000-0000-7000-8000-000000000999' },
          deliveries: [delivery()],
        }),
      },
    });

    await expect(service.getEvent(EVENT_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

function createService(input: {
  readonly repository?: Partial<BusinessEventRepository>;
  readonly principal?: typeof ADMIN_PRINCIPAL;
}) {
  const repository = {
    listEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findEvent: vi.fn().mockResolvedValue({
      event: businessEvent(),
      deliveries: [delivery()],
    }),
    replayDelivery: vi.fn(),
    ...input.repository,
  } as unknown as BusinessEventRepository;
  const identity = {
    current: () => input.principal ?? ADMIN_PRINCIPAL,
  } as RuntimeIdentityPort;
  return {
    service: new BusinessEventService(repository, identity),
    repository,
  };
}
