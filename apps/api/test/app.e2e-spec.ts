import type { INestApplication } from '@nestjs/common';
import {
  bootstrapResponseSchema,
  conversationListResponseSchema,
  conversationSchema,
  messageListResponseSchema,
  messageSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import { KnowledgeIngestionProcessor } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeIngestionWorker } from '../src/modules/knowledge-ingestion/application/knowledge-ingestion.worker.js';
import { createTestApp } from '../src/testing/create-test-app.js';

describe('API vertical slice', () => {
  let app: INestApplication;
  let humanConversationId: string;

  const currentUserId = '00000000-0000-7000-8000-000000000101';
  const targetUserId = '00000000-0000-7000-8000-000000000102';
  const nonParticipantUserId = '00000000-0000-7000-8000-000000000103';
  const agentId = '00000000-0000-7000-8000-000000000301';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without a tenant identity', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('keeps the background knowledge worker and processor in the singleton graph', () => {
    expect(app.get(KnowledgeIngestionProcessor)).toBeInstanceOf(KnowledgeIngestionProcessor);
    expect(app.get(KnowledgeIngestionWorker)).toBeInstanceOf(KnowledgeIngestionWorker);
  });

  it('returns a contract-valid desktop bootstrap payload', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/bootstrap')
      .set('x-request-id', 'bootstrap-e2e')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('bootstrap-e2e');
    expect(response.headers['server-timing']).toMatch(/^app;dur=\d+\.\d$/);
    expect(bootstrapResponseSchema.safeParse(response.body).success).toBe(true);
    const currentMember = response.body.members.find(
      (member: { id: string }) => member.id === currentUserId,
    );
    const otherMember = response.body.members.find(
      (member: { id: string }) => member.id === targetUserId,
    );
    expect(currentMember.capabilities.canContactHuman).toBe(false);
    expect(otherMember.capabilities.canContactHuman).toBe(true);
  });

  it('returns a stable error body for an invalid tenant header', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/bootstrap')
      .set('x-tenant-id', 'not-a-uuid')
      .expect(400);

    expect(response.body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'x-tenant-id must be a UUID.',
      request_id: expect.any(String),
    });
  });

  it('creates and reuses a human direct conversation with viewer-relative titles', async () => {
    const body = {
      type: 'direct',
      target: { type: 'human', userId: targetUserId },
    };
    const created = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .send(body)
      .expect(201);
    expect(conversationSchema.safeParse(created.body).success).toBe(true);
    expect(created.body.title).toBe('周睿');
    humanConversationId = created.body.id;

    const repeated = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .send(body)
      .expect(201);
    expect(repeated.body.id).toBe(humanConversationId);

    const targetView = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-user-id', targetUserId)
      .expect(200);
    expect(
      targetView.body.items.find(
        (conversation: { id: string }) => conversation.id === humanConversationId,
      ).title,
    ).toBe('林晓');
  });

  it('rejects self, nonexistent human, and nonexistent agent targets', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .send({ type: 'direct', target: { type: 'human', userId: currentUserId } })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .send({
        type: 'direct',
        target: { type: 'human', userId: '00000000-0000-7000-8000-000000000999' },
      })
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .send({
        type: 'direct',
        target: { type: 'agent', agentId: '00000000-0000-7000-8000-000000000999' },
      })
      .expect(404);
  });

  it('creates an agent direct conversation and lists only memberships', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .send({ type: 'direct', target: { type: 'agent', agentId } })
      .expect(201);
    expect(conversationSchema.safeParse(created.body).success).toBe(true);
    expect(created.body.title).toBe('林晓的产品助手');

    const listed = await request(app.getHttpServer()).get('/api/v1/conversations').expect(200);
    expect(conversationListResponseSchema.safeParse(listed.body).success).toBe(true);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(humanConversationId);

    const outsider = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set('x-user-id', nonParticipantUserId)
      .expect(200);
    expect(outsider.body.items).toEqual([]);
  });

  it('sends, reuses, rejects conflicting, and lists messages', async () => {
    const messageBody = {
      clientMessageId: 'desktop-message-0001',
      content: { type: 'text', text: '第一条协作消息' },
    };
    const created = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${humanConversationId}/messages`)
      .send(messageBody)
      .expect(201);
    expect(messageSchema.safeParse(created.body).success).toBe(true);

    const repeated = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${humanConversationId}/messages`)
      .send(messageBody)
      .expect(201);
    expect(repeated.body.id).toBe(created.body.id);

    await request(app.getHttpServer())
      .post(`/api/v1/conversations/${humanConversationId}/messages`)
      .send({ ...messageBody, content: { type: 'text', text: '冲突内容' } })
      .expect(409);

    const concurrentBody = {
      clientMessageId: 'desktop-message-0002',
      content: { type: 'text', text: '并发重试消息' },
    };
    const [left, right] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/conversations/${humanConversationId}/messages`)
        .send(concurrentBody),
      request(app.getHttpServer())
        .post(`/api/v1/conversations/${humanConversationId}/messages`)
        .send(concurrentBody),
    ]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(left.body.id).toBe(right.body.id);

    const listed = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${humanConversationId}/messages`)
      .expect(200);
    expect(messageListResponseSchema.safeParse(listed.body).success).toBe(true);
    expect(listed.body.items).toHaveLength(2);
    expect(listed.body.items[0].id).toBe(created.body.id);
  });

  it('hides conversations from nonparticipants and other tenants', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/conversations/${humanConversationId}/messages`)
      .set('x-user-id', nonParticipantUserId)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/conversations/${humanConversationId}/messages`)
      .set('x-user-id', nonParticipantUserId)
      .send({
        clientMessageId: 'outsider-message-0001',
        content: { type: 'text', text: '不应写入' },
      })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/conversations/${humanConversationId}/messages`)
      .set('x-tenant-id', '00000000-0000-7000-8000-000000000009')
      .expect(404);
  });
});
