import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { conversationSchema, messageSchema } from '@enterprise/contracts';
import request, { type Test } from 'supertest';

import { createTestApp } from '../src/testing/create-test-app.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantId = '00000000-0000-7000-8000-000000000009';
const actorId = '00000000-0000-7000-8000-000000000901';
const targetId = '00000000-0000-7000-8000-000000000902';

describe.runIf(enabled)('PostgreSQL conversation integration', () => {
  const administrator = new PrismaClient();
  let app: INestApplication;
  let conversationId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    await cleanupTestTenant();
    await administrator.tenant.create({
      data: {
        id: tenantId,
        slug: 'database-integration-test',
        name: '数据库集成测试租户',
        status: 'ACTIVE',
        users: {
          create: [
            {
              id: actorId,
              email: 'actor@database-test.invalid',
              emailNormalized: 'actor@database-test.invalid',
              displayName: '测试发起人',
              status: 'ACTIVE',
            },
            {
              id: targetId,
              email: 'target@database-test.invalid',
              emailNormalized: 'target@database-test.invalid',
              displayName: '测试联系人',
              status: 'ACTIVE',
            },
          ],
        },
      },
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanupTestTenant();
    await administrator.$disconnect();
  });

  it('creates and concurrently reuses a direct conversation', async () => {
    const body = { type: 'direct', target: { type: 'human', userId: targetId } };
    const [left, right] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(identityHeaders(actorId))
        .send(body),
      request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(identityHeaders(actorId))
        .send(body),
    ]);
    expect(left.status, JSON.stringify(left.body)).toBe(201);
    expect(right.status, JSON.stringify(right.body)).toBe(201);
    expect(conversationSchema.safeParse(left.body).success).toBe(true);
    expect(left.body.id).toBe(right.body.id);
    conversationId = left.body.id;
  });

  it('concurrently deduplicates the same client message and rejects changed content', async () => {
    const body = {
      clientMessageId: 'database-integration-message-0001',
      content: { type: 'text', text: '数据库幂等消息' },
    };
    const [left, right] = await Promise.all([sendMessage(body), sendMessage(body)]);
    expect(left.status, JSON.stringify(left.body)).toBe(201);
    expect(right.status, JSON.stringify(right.body)).toBe(201);
    expect(messageSchema.safeParse(left.body).success).toBe(true);
    expect(left.body.id).toBe(right.body.id);

    await sendMessage({ ...body, content: { type: 'text', text: '冲突内容' } }).expect(409);
  });

  it('reopens a direct conversation without returning an incomplete participant set', async () => {
    await administrator.conversationParticipant.updateMany({
      where: { tenantId, conversationId, userId: targetId },
      data: { leftAt: new Date() },
    });

    const reopened = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders(actorId))
      .send({ type: 'direct', target: { type: 'human', userId: targetId } })
      .expect(201);
    expect(reopened.body.id).toBe(conversationId);
    expect(reopened.body.participants).toHaveLength(2);
    expect(
      await administrator.conversationParticipant.count({
        where: { tenantId, conversationId, leftAt: null },
      }),
    ).toBe(2);
  });

  it('never moves lastMessageAt backwards when a message commits later', async () => {
    const future = new Date(Date.now() + 3_600_000);
    await administrator.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: future },
    });

    await sendMessage({
      clientMessageId: 'database-integration-message-0002',
      content: { type: 'text', text: '不得回拨会话时间' },
    }).expect(201);

    const listed = await request(app.getHttpServer())
      .get('/api/v1/conversations')
      .set(identityHeaders(actorId))
      .expect(200);
    const conversation = listed.body.items.find(
      (item: { id: string }) => item.id === conversationId,
    );
    expect(conversation.lastMessageAt).toBe(future.toISOString());
  });

  it('hides the test conversation from another tenant', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set({
        'x-tenant-id': '00000000-0000-7000-8000-000000000001',
        'x-user-id': '00000000-0000-7000-8000-000000000101',
      })
      .expect(404);
  });

  it('blocks a suspended tenant before serving business data', async () => {
    await administrator.tenant.update({
      where: { id: tenantId },
      data: { status: 'SUSPENDED' },
    });
    try {
      await request(app.getHttpServer())
        .get('/api/v1/bootstrap')
        .set(identityHeaders(actorId))
        .expect(403);
    } finally {
      await administrator.tenant.update({
        where: { id: tenantId },
        data: { status: 'ACTIVE' },
      });
    }
  });

  function sendMessage(body: object): Test {
    return request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(identityHeaders(actorId))
      .send(body);
  }

  function identityHeaders(userId: string): Record<string, string> {
    return { 'x-tenant-id': tenantId, 'x-user-id': userId };
  }

  async function cleanupTestTenant(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantId]);
  }
});
