import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { messageSchema } from '@enterprise/contracts';
import { randomUUID } from 'node:crypto';
import request, { type Test } from 'supertest';

import { validateEnvironment, type EnvironmentVariables } from '../src/config/environment.js';
import { OutboxPrismaService } from '../src/database/outbox-prisma.service.js';
import { PrismaAgentRunQueueRepository } from '../src/modules/agent-run/infrastructure/prisma/prisma-agent-run-queue.repository.js';
import { PrismaAgentRunRepository } from '../src/modules/agent-run/infrastructure/prisma/prisma-agent-run.repository.js';
import { createTestApp } from '../src/testing/create-test-app.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantId = '00000000-0000-7000-8000-000000000007';
const otherTenantId = '00000000-0000-7000-8000-000000000006';
const actorId = '00000000-0000-7000-8000-000000000701';
const templateId = '00000000-0000-7000-8000-000000000720';
const versionId = '00000000-0000-7000-8000-000000000721';
const agentAId = '00000000-0000-7000-8000-000000000711';
const agentBId = '00000000-0000-7000-8000-000000000712';
const agentRunRequestedEventType = 'agent.run_requested.v1';

describe.runIf(enabled)('PostgreSQL Agent Run orchestration', () => {
  const administrator = new PrismaClient();
  const leftQueueClient = createQueueClient();
  const rightQueueClient = createQueueClient();
  const leftQueue = new PrismaAgentRunQueueRepository(leftQueueClient);
  const rightQueue = new PrismaAgentRunQueueRepository(rightQueueClient);
  let app: INestApplication;
  let runs: PrismaAgentRunRepository;
  let singleConversationId: string;
  let singleInputMessageId: string;
  let singleRunId: string;
  let activeRetryRunId: string;
  let relayConversationId: string;
  let relayInputMessageId: string;
  let relayRunAId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    await Promise.all([leftQueueClient.onModuleInit(), rightQueueClient.onModuleInit()]);
    await cleanup();
    await seedFixtures();
    app = await createTestApp();
    runs = app.get(PrismaAgentRunRepository);
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanup();
    await Promise.all([
      leftQueueClient.onModuleDestroy(),
      rightQueueClient.onModuleDestroy(),
      administrator.$disconnect(),
    ]);
  });

  it('atomically creates one Message, queued AgentRun, and request event on retry', async () => {
    const conversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      .send({ type: 'direct', target: { type: 'agent', agentId: agentAId } })
      .expect(201);
    singleConversationId = String(conversation.body.id);

    const body = {
      clientMessageId: 'agent-run-single-message-0001',
      content: { type: 'text', text: 'Queue this exactly once.' },
    };
    const [created, retried] = await Promise.all([
      sendMessage(singleConversationId, body),
      sendMessage(singleConversationId, body),
    ]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(messageSchema.safeParse(created.body).success).toBe(true);
    expect(retried.body.id).toBe(created.body.id);
    singleInputMessageId = String(created.body.id);

    const storedMessages = await administrator.message.findMany({
      where: {
        tenantId,
        conversationId: singleConversationId,
        senderKey: `user:${actorId}`,
        clientMessageId: body.clientMessageId,
      },
    });
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0]?.id).toBe(singleInputMessageId);

    const storedRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: singleConversationId },
    });
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]).toMatchObject({
      inputMessageId: singleInputMessageId,
      requesterUserId: actorId,
      agentId: agentAId,
      agentVersionId: versionId,
      trigger: 'USER_MESSAGE',
      turnIndex: 1,
      turnLimit: 1,
      status: 'QUEUED',
    });

    const run = only(storedRuns);
    singleRunId = run.id;
    const requestEvents = await administrator.outboxEvent.findMany({
      where: {
        tenantId,
        aggregateType: 'agent_run',
        aggregateId: run.id,
        eventType: agentRunRequestedEventType,
      },
    });
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]?.payload).toEqual({ runId: run.id });
  });

  it('concurrently reuses one retry Run and persists one event and audit record', async () => {
    await administrator.agentRun.update({
      where: { id: singleRunId },
      data: {
        status: 'FAILED',
        errorCode: 'PROVIDER_INVALID_RESPONSE',
        errorMessage: 'Provider returned an invalid response.',
        finishedAt: new Date(),
      },
    });

    const retryPath = `/api/v1/conversations/${singleConversationId}/runs/${singleRunId}/retry`;
    const [left, right] = await Promise.all([
      request(app.getHttpServer()).post(retryPath).set(identityHeaders()),
      request(app.getHttpServer()).post(retryPath).set(identityHeaders()),
    ]);
    expect(left.status, JSON.stringify(left.body)).toBe(201);
    expect(right.status, JSON.stringify(right.body)).toBe(201);
    expect(left.body).toEqual({ runId: expect.any(String), status: 'queued' });
    expect(right.body).toEqual(left.body);
    activeRetryRunId = String(left.body.runId);

    const retries = await administrator.agentRun.findMany({
      where: { tenantId, retryOfRunId: singleRunId },
    });
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      id: activeRetryRunId,
      conversationId: singleConversationId,
      inputMessageId: singleInputMessageId,
      requesterUserId: actorId,
      agentId: agentAId,
      agentVersionId: versionId,
      status: 'QUEUED',
    });
    await expect(
      administrator.outboxEvent.count({
        where: {
          tenantId,
          aggregateType: 'agent_run',
          aggregateId: activeRetryRunId,
          eventType: agentRunRequestedEventType,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId,
          action: 'agent.run.retry',
          resourceId: activeRetryRunId,
        },
      }),
    ).resolves.toBe(1);
  });

  it('allows a new explicit retry after the prior retry reaches a terminal state', async () => {
    await administrator.agentRun.update({
      where: { id: activeRetryRunId },
      data: { status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT', finishedAt: new Date() },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${singleConversationId}/runs/${singleRunId}/retry`)
      .set(identityHeaders())
      .expect(201);
    expect(response.body).toEqual({ runId: expect.any(String), status: 'queued' });
    expect(response.body.runId).not.toBe(activeRetryRunId);
    activeRetryRunId = String(response.body.runId);
    await expect(
      administrator.agentRun.count({ where: { tenantId, retryOfRunId: singleRunId } }),
    ).resolves.toBe(2);
  });

  it('does not blindly retry an UNKNOWN provider result', async () => {
    await administrator.agentRun.update({
      where: { id: activeRetryRunId },
      data: { status: 'UNKNOWN', errorCode: 'PROVIDER_RESULT_UNKNOWN' },
    });
    const before = await administrator.agentRun.count({
      where: { tenantId, conversationId: singleConversationId },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${singleConversationId}/runs/${activeRetryRunId}/retry`)
      .set(identityHeaders())
      .expect(409);
    expect(response.body.message).toContain('must be reconciled before retrying');
    await expect(
      administrator.agentRun.count({ where: { tenantId, conversationId: singleConversationId } }),
    ).resolves.toBe(before);
  });

  it('queues Agent A first and rolls back a second topic while the relay is active', async () => {
    const conversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      .send({
        type: 'direct',
        target: { type: 'agent_pair', agentIds: [agentAId, agentBId], turnLimit: 2 },
      })
      .expect(201);
    relayConversationId = String(conversation.body.id);

    const first = await sendMessage(relayConversationId, {
      clientMessageId: 'agent-run-relay-message-0001',
      content: { type: 'text', text: 'Discuss this topic in two turns.' },
    }).expect(201);
    relayInputMessageId = String(first.body.id);

    const firstRun = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, conversationId: relayConversationId },
    });
    relayRunAId = firstRun.id;
    expect(firstRun).toMatchObject({
      inputMessageId: relayInputMessageId,
      requesterUserId: actorId,
      agentId: agentAId,
      parentRunId: null,
      trigger: 'USER_MESSAGE',
      turnIndex: 1,
      turnLimit: 2,
      status: 'QUEUED',
    });

    const beforeConflict = await relayPersistenceCounts();
    await sendMessage(relayConversationId, {
      clientMessageId: 'agent-run-relay-message-0002',
      content: { type: 'text', text: 'A second topic must wait.' },
    }).expect(409);

    await expect(
      administrator.message.findFirst({
        where: {
          tenantId,
          conversationId: relayConversationId,
          clientMessageId: 'agent-run-relay-message-0002',
        },
      }),
    ).resolves.toBeNull();
    await expect(relayPersistenceCounts()).resolves.toEqual(beforeConflict);
  });

  it('completes Agent A and Agent B in order without creating a third relay run', async () => {
    const preparedA = await runs.prepare(tenantId, relayRunAId);
    if (preparedA.kind !== 'ready') {
      throw new Error(`Expected Agent A to be ready, received ${preparedA.kind}.`);
    }
    expect(preparedA.run).toMatchObject({
      id: relayRunAId,
      agentId: agentAId,
      turnIndex: 1,
      turnLimit: 2,
    });
    expect(preparedA.run.messages.at(-1)).toMatchObject({
      senderType: 'USER',
      senderId: actorId,
      text: 'Discuss this topic in two turns.',
    });

    const externalRunAId = randomUUID();
    await runs.attachExternalRun(tenantId, relayRunAId, externalRunAId);
    const completedA = await runs.completeSucceeded(tenantId, relayRunAId, 'Agent A answer', [], {
      provider: 'openai_compatible',
      model: 'model-a',
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      toolCalls: 0,
      costMicros: 25,
      tokensReported: true,
      costReported: true,
    });
    expect(completedA.externalRunId).toBe(externalRunAId);

    const storedA = await administrator.agentRun.findUniqueOrThrow({
      where: { id: relayRunAId },
    });
    expect(storedA).toMatchObject({
      status: 'SUCCEEDED',
      outputMessageId: completedA.outputMessageId,
      runtimeProvider: 'openai_compatible',
      runtimeModel: 'model-a',
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      costMicros: 25n,
      reservedTokens: 0,
    });
    await expect(
      administrator.$executeRaw`
        UPDATE public."agent_runs"
        SET "input_tokens" = 0,
            "output_tokens" = 0,
            "total_tokens" = 0,
            "usage_recorded_at" = now()
        WHERE "id" = ${relayRunAId}::uuid
      `,
    ).rejects.toThrow();
    const messageA = await administrator.message.findUniqueOrThrow({
      where: { id: completedA.outputMessageId },
    });
    expect(messageA).toMatchObject({
      conversationId: relayConversationId,
      senderType: 'AGENT',
      senderAgentId: agentAId,
      clientMessageId: `agent-run:${relayRunAId}`,
      content: { type: 'text', text: 'Agent A answer' },
    });

    const runB = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, conversationId: relayConversationId, parentRunId: relayRunAId },
    });
    expect(runB).toMatchObject({
      inputMessageId: completedA.outputMessageId,
      requesterUserId: actorId,
      agentId: agentBId,
      trigger: 'RELAY_TURN',
      turnIndex: 2,
      turnLimit: 2,
      status: 'QUEUED',
    });
    await expect(
      administrator.outboxEvent.count({
        where: {
          tenantId,
          aggregateType: 'agent_run',
          aggregateId: runB.id,
          eventType: agentRunRequestedEventType,
          payload: { equals: { runId: runB.id } },
        },
      }),
    ).resolves.toBe(1);

    const preparedB = await runs.prepare(tenantId, runB.id);
    if (preparedB.kind !== 'ready') {
      throw new Error(`Expected Agent B to be ready, received ${preparedB.kind}.`);
    }
    expect(preparedB.run).toMatchObject({ agentId: agentBId, turnIndex: 2, turnLimit: 2 });
    expect(preparedB.run.messages.at(-1)).toMatchObject({
      senderType: 'AGENT',
      senderId: agentAId,
      text: 'Agent A answer',
    });

    const externalRunBId = randomUUID();
    await runs.attachExternalRun(tenantId, runB.id, externalRunBId);
    const completedB = await runs.completeSucceeded(tenantId, runB.id, 'Agent B answer');
    expect(completedB.externalRunId).toBe(externalRunBId);

    const orderedRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: relayConversationId },
      orderBy: { turnIndex: 'asc' },
    });
    expect(orderedRuns).toHaveLength(2);
    expect(orderedRuns.map((run) => [run.turnIndex, run.agentId, run.status])).toEqual([
      [1, agentAId, 'SUCCEEDED'],
      [2, agentBId, 'SUCCEEDED'],
    ]);
    expect(orderedRuns[1]).toMatchObject({
      id: runB.id,
      parentRunId: relayRunAId,
      outputMessageId: completedB.outputMessageId,
    });
    await expect(
      administrator.agentRun.count({ where: { tenantId, parentRunId: runB.id } }),
    ).resolves.toBe(0);

    const orderedMessages = await administrator.message.findMany({
      where: { tenantId, conversationId: relayConversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { senderType: true, senderUserId: true, senderAgentId: true },
    });
    expect(orderedMessages).toEqual([
      { senderType: 'USER', senderUserId: actorId, senderAgentId: null },
      { senderType: 'AGENT', senderUserId: null, senderAgentId: agentAId },
      { senderType: 'AGENT', senderUserId: null, senderAgentId: agentBId },
    ]);
    await expect(
      administrator.outboxEvent.count({
        where: {
          tenantId,
          aggregateType: 'agent_run',
          aggregateId: { in: orderedRuns.map((run) => run.id) },
          eventType: agentRunRequestedEventType,
        },
      }),
    ).resolves.toBe(2);
  });

  it('atomically defers dispatch at the tenant concurrency limit and rejects exhausted monthly quota', async () => {
    const conversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      // Agent B gives this quota fixture a separate direct key from the run
      // used to exercise active/UNKNOWN quota accounting below.
      .send({ type: 'direct', target: { type: 'agent', agentId: agentBId } })
      .expect(201);
    const message = await sendMessage(String(conversation.body.id), {
      clientMessageId: 'agent-run-quota-message-0001',
      content: { type: 'text', text: 'Exercise the tenant quota gate.' },
    }).expect(201);
    const queued = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, inputMessageId: String(message.body.id) },
    });

    await administrator.tenant.update({
      where: { id: tenantId },
      data: { agentRunConcurrencyLimit: 1 },
    });
    await administrator.agentRun.update({
      where: { id: activeRetryRunId },
      data: {
        status: 'RUNNING',
        externalRunId: randomUUID(),
        finishedAt: null,
        reservedTokens: 20_000,
      },
    });
    const deferred = await runs.prepare(tenantId, queued.id);
    expect(deferred).toMatchObject({
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT',
    });
    await expect(
      administrator.agentRun.findUniqueOrThrow({ where: { id: queued.id } }),
    ).resolves.toMatchObject({
      status: 'QUEUED',
      reservedTokens: 0,
    });

    // UNKNOWN may still be executing remotely. Neither a 16-minute nor a 24-hour
    // wall-clock delay is trusted evidence that the provider stopped, so the Run
    // keeps both its concurrency slot and its unverified token reservation until
    // an operator performs a trusted reconciliation.
    await administrator.agentRun.update({
      where: { id: activeRetryRunId },
      data: { status: 'UNKNOWN', finishedAt: new Date(), errorCode: 'PROVIDER_RESULT_UNKNOWN' },
    });

    await administrator.tenant.update({
      where: { id: tenantId },
      data: { agentRunConcurrencyLimit: 1, agentRunMonthlyTokenLimit: 100_000_000n },
    });
    await expect(runs.prepare(tenantId, queued.id)).resolves.toMatchObject({
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT',
    });
    await administrator.agentRun.update({
      where: { id: activeRetryRunId },
      data: { finishedAt: new Date(Date.now() - 16 * 60_000) },
    });
    await expect(runs.prepare(tenantId, queued.id)).resolves.toMatchObject({
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT',
    });
    await administrator.agentRun.update({
      where: { id: activeRetryRunId },
      data: { finishedAt: new Date(Date.now() - 24 * 60 * 60_000) },
    });
    await expect(runs.prepare(tenantId, queued.id)).resolves.toMatchObject({
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT',
    });

    // Exercise the independent monthly Token hold by making one additional
    // concurrency slot available. This assertion must not depend on UNKNOWN aging out.
    await administrator.tenant.update({
      where: { id: tenantId },
      data: { agentRunConcurrencyLimit: 2, agentRunMonthlyTokenLimit: 16n },
    });
    const rejected = await runs.prepare(tenantId, queued.id);
    expect(rejected).toMatchObject({
      kind: 'terminal',
      status: 'FAILED',
      errorCode: 'TENANT_MONTHLY_TOKEN_QUOTA_EXCEEDED',
    });
    await expect(
      administrator.agentRun.findUniqueOrThrow({ where: { id: queued.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      reservedTokens: 0,
      errorCode: 'TENANT_MONTHLY_TOKEN_QUOTA_EXCEEDED',
    });
    await administrator.tenant.update({
      where: { id: tenantId },
      data: { agentRunMonthlyTokenLimit: 100_000_000n },
    });
  });

  it('lets the tenant owner update quota limits with optimistic locking and an audit record', async () => {
    const summary = await request(app.getHttpServer())
      .get('/api/v1/admin/agents/usage-summary')
      .set(identityHeaders())
      .expect(200);
    const changed = await request(app.getHttpServer())
      .patch('/api/v1/admin/agents/usage-limits')
      .set(identityHeaders())
      .send({
        concurrentRuns: 3,
        runsPerMinute: 45,
        monthlyTokens: '90000000',
        expectedUpdatedAt: summary.body.limits.updatedAt,
      })
      .expect(200);
    expect(changed.body).toMatchObject({
      concurrentRuns: 3,
      runsPerMinute: 45,
      monthlyTokens: '90000000',
      updatedAt: expect.any(String),
    });
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId,
          action: 'admin.agent.usage_limits.updated',
          resourceId: tenantId,
        },
      }),
    ).resolves.toBeGreaterThan(0);

    await request(app.getHttpServer())
      .patch('/api/v1/admin/agents/usage-limits')
      .set(identityHeaders())
      .send({
        concurrentRuns: 4,
        runsPerMinute: 60,
        monthlyTokens: '100000000',
        expectedUpdatedAt: changed.body.updatedAt,
      })
      .expect(200);
  });

  it('forces RLS on agent_runs and hides a run from another tenant context', async () => {
    const [security] = await administrator.$queryRaw<
      Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>
    >`
      SELECT
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity"
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'agent_runs'
    `;
    expect(security).toEqual({ rowSecurity: true, forceRowSecurity: true });

    await expect(countRunAsTenant(tenantId, relayRunAId)).resolves.toBe(1);
    await expect(countRunAsTenant(otherTenantId, relayRunAId)).resolves.toBe(0);
  });

  it('rejects an input Message from another conversation in the same tenant', async () => {
    const invalidRunId = randomUUID();
    const error = await captureKnownDatabaseError(() =>
      administrator.agentRun.create({
        data: {
          id: invalidRunId,
          tenantId,
          conversationId: singleConversationId,
          inputMessageId: relayInputMessageId,
          requesterUserId: actorId,
          agentId: agentBId,
          agentVersionId: versionId,
          // Keep this fixture out of the one-active-run partial index so the
          // assertion reaches the cross-conversation composite foreign key.
          status: 'FAILED',
          idempotencyKey: `cross-conversation:${invalidRunId}`,
          policySnapshot: { integrationTest: true },
        },
      }),
    );

    expect(error.code).toBe('P2003');
    expect(error.message).toContain('agent_runs_tenant_id_input_message_id_fkey');
    await expect(administrator.agentRun.count({ where: { id: invalidRunId } })).resolves.toBe(0);
  });

  it('uses two SKIP LOCKED claimants without claiming an event twice', async () => {
    await administrator.outboxEvent.deleteMany({
      where: { tenantId, eventType: agentRunRequestedEventType },
    });
    const queueRows = Array.from({ length: 4 }, (_, index) => {
      const runId = randomUUID();
      return {
        tenantId,
        aggregateType: 'agent_run',
        aggregateId: runId,
        eventType: agentRunRequestedEventType,
        payload: { runId },
        availableAt: new Date(`1900-01-01T00:00:0${index}.000Z`),
      };
    });
    await administrator.outboxEvent.createMany({ data: queueRows });
    const expectedIds = (
      await administrator.outboxEvent.findMany({
        where: { tenantId, aggregateId: { in: queueRows.map((row) => row.aggregateId) } },
        select: { id: true },
      })
    ).map((event) => event.id);

    const [left, right] = await Promise.all([
      leftQueue.claim({ workerId: 'agent-run-left', batchSize: 2, claimTtlMs: 30_000 }),
      rightQueue.claim({ workerId: 'agent-run-right', batchSize: 2, claimTtlMs: 30_000 }),
    ]);
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    const claimedIds = [...left, ...right].map((event) => event.id);
    expect(new Set(claimedIds).size).toBe(4);
    expect(new Set(claimedIds)).toEqual(new Set(expectedIds));
    expect([...left, ...right].every((event) => event.attempts === 1)).toBe(true);
  });

  function sendMessage(conversationId: string, body: object): Test {
    return request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(identityHeaders())
      .send(body);
  }

  function identityHeaders(): Record<string, string> {
    return { 'x-tenant-id': tenantId, 'x-user-id': actorId };
  }

  async function relayPersistenceCounts(): Promise<{
    readonly messages: number;
    readonly runs: number;
    readonly requestEvents: number;
  }> {
    const [messages, runCount, requestEvents] = await Promise.all([
      administrator.message.count({ where: { tenantId, conversationId: relayConversationId } }),
      administrator.agentRun.count({ where: { tenantId, conversationId: relayConversationId } }),
      administrator.outboxEvent.count({
        where: { tenantId, eventType: agentRunRequestedEventType },
      }),
    ]);
    return { messages, runs: runCount, requestEvents };
  }

  async function countRunAsTenant(contextTenantId: string, runId: string): Promise<number> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${contextTenantId}, true)`;
      return transaction.agentRun.count({ where: { id: runId } });
    });
  }

  async function seedFixtures(): Promise<void> {
    await administrator.tenant.create({
      data: { id: tenantId, slug: 'agent-run-integration', name: 'Agent Run Integration' },
    });
    await administrator.tenant.create({
      data: {
        id: otherTenantId,
        slug: 'agent-run-integration-other',
        name: 'Agent Run Integration Other',
      },
    });
    await administrator.user.create({
      data: {
        id: actorId,
        tenantId,
        email: 'actor@agent-run-integration.invalid',
        emailNormalized: 'actor@agent-run-integration.invalid',
        displayName: 'Agent Run Actor',
        status: 'ACTIVE',
      },
    });
    await administrator.agentTemplate.create({
      data: {
        id: templateId,
        tenantId,
        key: 'agent-run-integration-template',
        name: 'Agent Run Integration Template',
      },
    });
    await administrator.agentVersion.create({
      data: {
        id: versionId,
        tenantId,
        templateId,
        version: 1,
        status: 'PUBLISHED',
        systemPrompt: 'Respond safely for the Agent Run integration test.',
        modelPolicy: { provider: 'integration', model: 'integration' },
        toolPolicy: { allow: [] },
        knowledgeScope: { ids: [] },
        publishedAt: new Date(),
      },
    });
    await administrator.agentInstance.createMany({
      data: [
        {
          id: agentAId,
          tenantId,
          key: 'agent-run-integration-a',
          versionId,
          ownerUserId: actorId,
          createdById: actorId,
          name: 'Agent A',
          status: 'ONLINE',
          settings: { visibility: 'tenant' },
        },
        {
          id: agentBId,
          tenantId,
          key: 'agent-run-integration-b',
          versionId,
          ownerUserId: actorId,
          createdById: actorId,
          name: 'Agent B',
          status: 'ONLINE',
          settings: { visibility: 'tenant' },
        },
      ],
    });
  }

  async function cleanup(): Promise<void> {
    const tenantIds = [tenantId, otherTenantId];
    await administrator.auditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.outboxEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.agentRun.deleteMany({
      where: { tenantId: { in: tenantIds }, parentRunId: { not: null } },
    });
    await administrator.agentRun.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.message.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.conversationParticipant.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await administrator.conversation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.agentInstance.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.agentVersion.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.agentTemplate.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await administrator.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  }
});

function createQueueClient(): OutboxPrismaService {
  return new OutboxPrismaService(createConfig());
}

function createConfig(): ConfigService<EnvironmentVariables, true> {
  const databaseUrl =
    process.env.DATABASE_URL ??
    (enabled ? undefined : 'postgresql://skipped:skipped@127.0.0.1:1/skipped');
  const values = validateEnvironment({
    NODE_ENV: 'test',
    REPOSITORY_DRIVER: 'prisma',
    DATABASE_URL: databaseUrl,
    OUTBOX_DATABASE_URL: process.env.OUTBOX_DATABASE_URL ?? databaseUrl,
    AGENT_RUN_WORKER_ENABLED: 'true',
  });
  return new ConfigService<EnvironmentVariables, true>(values);
}

async function captureKnownDatabaseError(
  operation: () => Promise<unknown>,
): Promise<Prisma.PrismaClientKnownRequestError> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return error;
    throw error;
  }
  throw new Error('Expected the database operation to be rejected.');
}

function only<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined || values.length !== 1) {
    throw new Error(`Expected exactly one value, received ${values.length}.`);
  }
  return value;
}
