import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AnswerFeedbackController } from './answer-feedback.controller.js';
import { AnswerFeedbackService } from './answer-feedback.service.js';

const MESSAGE_ID = '00000000-0000-7000-8000-000000000501';

describe('AnswerFeedbackController', () => {
  let app: INestApplication;
  const getCurrent = vi.fn();
  const upsert = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AnswerFeedbackController],
      providers: [{ provide: AnswerFeedbackService, useValue: { getCurrent, upsert } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('upserts and returns the current feedback', async () => {
    upsert.mockResolvedValueOnce({
      id: '00000000-0000-7000-8000-000000000601',
      messageId: MESSAGE_ID,
      rating: 'HELPFUL',
      reason: null,
      comment: null,
      createdAt: '2026-07-20T03:00:00.000Z',
      updatedAt: '2026-07-20T03:01:00.000Z',
    });

    await request(app.getHttpServer())
      .put(`/api/v1/messages/${MESSAGE_ID}/feedback`)
      .send({ rating: 'HELPFUL' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ messageId: MESSAGE_ID, rating: 'HELPFUL' });
      });
    expect(upsert).toHaveBeenCalledWith(MESSAGE_ID, {
      rating: 'HELPFUL',
      reason: null,
      comment: null,
    });
  });

  it('rejects a negative rating without a reason before calling the service', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/messages/${MESSAGE_ID}/feedback`)
      .send({ rating: 'NOT_HELPFUL' })
      .expect(400);
  });

  it('returns the current feedback envelope', async () => {
    getCurrent.mockResolvedValueOnce({ feedback: null });
    await request(app.getHttpServer())
      .get(`/api/v1/messages/${MESSAGE_ID}/feedback`)
      .expect(200)
      .expect({ feedback: null });
  });
});
