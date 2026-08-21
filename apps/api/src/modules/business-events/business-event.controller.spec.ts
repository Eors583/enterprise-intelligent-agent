import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  businessEventDeliverySchema,
  businessEventDetailResponseSchema,
  businessEventListResponseSchema,
} from '@enterprise/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_ID,
  EVENT_ID,
  businessEvent,
  delivery,
} from '../process-orchestration/testing/runtime-test-fixtures.js';
import { BusinessEventController } from './business-event.controller.js';
import { BusinessEventService } from './business-event.service.js';

const REPLAY_REQUEST = {
  expectedStatus: 'DEAD_LETTERED',
  reason: 'The provider has recovered.',
  idempotencyKey: 'delivery:replay:1',
} as const;

describe('BusinessEventController', () => {
  let app: INestApplication;
  const listEvents = vi.fn();
  const getEvent = vi.fn();
  const replayDelivery = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BusinessEventController],
      providers: [
        {
          provide: BusinessEventService,
          useValue: { listEvents, getEvent, replayDelivery },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('exposes the Business Event list endpoint', async () => {
    listEvents.mockResolvedValueOnce({
      items: [businessEvent()],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/business-events/events?cursor=opaque')
      .expect(200);

    expect(businessEventListResponseSchema.parse(response.body).items).toHaveLength(1);
    expect(listEvents).toHaveBeenCalledWith('opaque');
  });

  it('exposes a Business Event with its delivery trace', async () => {
    getEvent.mockResolvedValueOnce({
      event: businessEvent(),
      deliveries: [delivery()],
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/business-events/events/${EVENT_ID}`)
      .expect(200);

    expect(businessEventDetailResponseSchema.parse(response.body).event.eventId).toBe(EVENT_ID);
    expect(getEvent).toHaveBeenCalledWith(EVENT_ID);
  });

  it('validates and delegates a DLQ replay request', async () => {
    replayDelivery.mockResolvedValueOnce(
      delivery({
        status: 'PENDING',
        deadLetteredAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        updatedAt: '2026-07-28T01:10:00.000Z',
      }),
    );

    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/business-events/deliveries/${DELIVERY_ID}/replay`)
      .send(REPLAY_REQUEST)
      .expect(201);

    expect(businessEventDeliverySchema.parse(response.body).status).toBe('PENDING');
    expect(replayDelivery).toHaveBeenCalledWith(DELIVERY_ID, REPLAY_REQUEST);
  });

  it('rejects an unbounded or ambiguous replay body', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/business-events/deliveries/${DELIVERY_ID}/replay`)
      .send({ ...REPLAY_REQUEST, expectedStatus: 'PROCESSED' })
      .expect(400);
  });
});
