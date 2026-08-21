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
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantId = '00000000-0000-7000-8000-000000000007';
const otherTenantId = '00000000-0000-7000-8000-000000000006';
const actorId = '00000000-0000-7000-8000-000000000701';
const routeReviewerId = '00000000-0000-7000-8000-000000000702';
const agentBOwnerId = '00000000-0000-7000-8000-000000000703';
const templateId = '00000000-0000-7000-8000-000000000720';
const versionId = '00000000-0000-7000-8000-000000000721';
const modelCatalogVersionId = '00000000-0000-7000-8000-000000000722';
const modelRoutePolicyVersionId = '00000000-0000-7000-8000-000000000723';
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
  let queuedSecondTopicRunId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    await Promise.all([leftQueueClient.onModuleInit(), rightQueueClient.onModuleInit()]);
    await cleanup();
    await seedFixtures();
    app = await createTestApp({
      // This suite verifies PostgreSQL Run orchestration, idempotency, quotas,
      // relay ordering and RLS. Provider connectivity has its own fail-closed
      // coverage; make availability an explicit test-only prerequisite here.
      agentOperationalReadiness: {
        inspectAgents: (_tenantId, agentIds) =>
          Promise.resolve(
            new Map(
              agentIds.map((agentId) => [
                agentId,
                {
                  status: 'AVAILABLE' as const,
                  evidenceStatus: 'VERIFIED' as const,
                  reasonCodes: [],
                  checkedAt: new Date().toISOString(),
                },
              ]),
            ),
          ),
      },
    });
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
    const prepared = await runs.prepare(tenantId, activeRetryRunId);
    if (prepared.kind !== 'ready') {
      throw new Error(`Expected retry Run to be ready, received ${prepared.kind}.`);
    }
    const externalRunId = randomUUID();
    const reconcileAt = new Date(Date.now() + 3_600_000);
    await runs.attachExternalRun(tenantId, activeRetryRunId, externalRunId);
    await runs.completeUnknown(
      tenantId,
      activeRetryRunId,
      'PROVIDER_RESULT_UNKNOWN',
      undefined,
      'terminal_only',
      reconcileAt,
    );
    const before = await administrator.agentRun.count({
      where: { tenantId, conversationId: singleConversationId },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${singleConversationId}/runs/${activeRetryRunId}/retry`)
      .set(identityHeaders())
      .expect(409);
    expect(response.body.message).toContain('must be reconciled before retrying');
    const ancestorResponse = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${singleConversationId}/runs/${singleRunId}/retry`)
      .set(identityHeaders())
      .expect(409);
    expect(ancestorResponse.body.message).toContain('must be reconciled before retrying');
    await expect(
      administrator.agentRun.count({ where: { tenantId, conversationId: singleConversationId } }),
    ).resolves.toBe(before);
    await expect(
      administrator.agentRunStreamEvent.findMany({
        where: { tenantId, runId: activeRetryRunId },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, type: true, terminalStatus: true },
      }),
    ).resolves.toEqual([{ sequence: 1, type: 'TERMINAL_ONLY', terminalStatus: 'UNKNOWN' }]);
    const reconciliationEvent = await administrator.outboxEvent.findFirstOrThrow({
      where: {
        tenantId,
        aggregateId: activeRetryRunId,
        eventType: agentRunRequestedEventType,
        payload: { path: ['reconciliation'], equals: true },
      },
      include: { deliveries: true },
    });
    expect(reconciliationEvent.payload).toEqual({
      runId: activeRetryRunId,
      reconciliation: true,
      externalRunId,
    });
    expect(reconciliationEvent.availableAt.getTime()).toBe(reconcileAt.getTime());
    expect(reconciliationEvent.deliveries).toHaveLength(1);
    expect(reconciliationEvent.deliveries[0]?.availableAt.getTime()).toBe(reconcileAt.getTime());
    const messageList = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${singleConversationId}/messages`)
      .set(identityHeaders())
      .expect(200);
    expect(
      messageList.body.runs.find((run: { readonly id: string }) => run.id === activeRetryRunId),
    ).toMatchObject({ status: 'UNKNOWN', retryable: false });
  });

  it('appends a final reconciliation marker without rewriting UNKNOWN stream history', async () => {
    const reconciliation = await runs.prepareReconciliation(tenantId, activeRetryRunId);
    expect(reconciliation).toMatchObject({
      kind: 'ready',
      run: { id: activeRetryRunId, externalRunId: expect.any(String) },
    });

    const completed = await runs.completeSucceeded(
      tenantId,
      activeRetryRunId,
      'Reconciled provider answer',
    );
    expect(completed.outputMessageId).toEqual(expect.any(String));
    await expect(
      administrator.agentRunStreamEvent.findMany({
        where: { tenantId, runId: activeRetryRunId },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, type: true, terminalStatus: true },
      }),
    ).resolves.toEqual([
      { sequence: 1, type: 'TERMINAL_ONLY', terminalStatus: 'UNKNOWN' },
      { sequence: 2, type: 'TERMINAL_RECONCILED', terminalStatus: 'SUCCEEDED' },
    ]);
    await expect(
      administrator.agentRun.findUnique({
        where: { id: activeRetryRunId },
        select: { status: true, outputMessageId: true },
      }),
    ).resolves.toEqual({
      status: 'SUCCEEDED',
      outputMessageId: completed.outputMessageId,
    });
    const duplicateAnswer = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${singleConversationId}/runs/${singleRunId}/retry`)
      .set(identityHeaders())
      .expect(409);
    expect(duplicateAnswer.body.message).toContain('already has a completed answer');
  });

  it('reuses one answer slot when different failed ancestors are retried concurrently', async () => {
    const conversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      .send({ type: 'direct', target: { type: 'agent', agentId: agentAId } })
      .expect(201);
    const conversationId = String(conversation.body.id);
    const message = await sendMessage(conversationId, {
      clientMessageId: 'agent-run-retry-ancestor-message-0001',
      content: { type: 'text', text: 'Retry this logical input from different ancestors.' },
    }).expect(201);
    const inputMessageId = String(message.body.id);
    const source = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, conversationId, inputMessageId },
    });
    await administrator.agentRun.update({
      where: { id: source.id },
      data: { status: 'FAILED', errorCode: 'INTEGRATION_RETRY_SOURCE', finishedAt: new Date() },
    });
    const firstRetry = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${conversationId}/runs/${source.id}/retry`)
      .set(identityHeaders())
      .expect(201);
    const firstRetryId = String(firstRetry.body.runId);
    await administrator.agentRun.update({
      where: { id: firstRetryId },
      data: { status: 'FAILED', errorCode: 'INTEGRATION_RETRY_ATTEMPT', finishedAt: new Date() },
    });

    const [sourceRetry, childRetry] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/runs/${source.id}/retry`)
        .set(identityHeaders()),
      request(app.getHttpServer())
        .post(`/api/v1/conversations/${conversationId}/runs/${firstRetryId}/retry`)
        .set(identityHeaders()),
    ]);
    expect(sourceRetry.status, JSON.stringify(sourceRetry.body)).toBe(201);
    expect(childRetry.status, JSON.stringify(childRetry.body)).toBe(201);
    expect(sourceRetry.body).toEqual({ runId: expect.any(String), status: 'queued' });
    expect(childRetry.body).toEqual(sourceRetry.body);
    await expect(
      administrator.agentRun.count({
        where: {
          tenantId,
          inputMessageId,
          status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN', 'SUCCEEDED'] },
        },
      }),
    ).resolves.toBe(1);

    const duplicateRunId = randomUUID();
    const duplicateSlot = await captureKnownDatabaseError(() =>
      administrator.agentRun.create({
        data: {
          id: duplicateRunId,
          tenantId,
          conversationId,
          inputMessageId,
          requesterUserId: actorId,
          agentId: source.agentId,
          agentVersionId: source.agentVersionId,
          status: 'QUEUED',
          idempotencyKey: `duplicate-slot:${duplicateRunId}`,
          policySnapshot: source.policySnapshot as Prisma.InputJsonValue,
        },
      }),
    );
    expect(duplicateSlot.code).toBe('P2002');
    await expect(administrator.agentRun.count({ where: { id: duplicateRunId } })).resolves.toBe(0);
  });

  it('accepts a second topic while the first relay chain is active and gives both a durable order', async () => {
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

    const second = await sendMessage(relayConversationId, {
      clientMessageId: 'agent-run-relay-message-0002',
      content: { type: 'text', text: 'A second topic must wait.' },
    }).expect(201);

    const orderedMessages = await administrator.message.findMany({
      where: { tenantId, conversationId: relayConversationId },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true },
    });
    expect(orderedMessages).toHaveLength(2);
    expect(orderedMessages.map(({ id }) => id)).toEqual([relayInputMessageId, second.body.id]);
    expect(orderedMessages[0]!.sequence).toBeLessThan(orderedMessages[1]!.sequence);

    const orderedRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: relayConversationId },
      orderBy: { conversationSequence: 'asc' },
      select: { id: true, inputMessageId: true, conversationSequence: true, status: true },
    });
    expect(orderedRuns).toHaveLength(2);
    expect(orderedRuns[0]).toMatchObject({
      id: relayRunAId,
      inputMessageId: relayInputMessageId,
      status: 'QUEUED',
    });
    expect(orderedRuns[1]).toMatchObject({ inputMessageId: second.body.id, status: 'QUEUED' });
    expect(orderedRuns[0]!.conversationSequence).toBeLessThan(orderedRuns[1]!.conversationSequence);
    queuedSecondTopicRunId = orderedRuns[1]!.id;
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
    await expect(runs.prepare(tenantId, queuedSecondTopicRunId)).resolves.toMatchObject({
      kind: 'deferred',
      reasonCode: 'EARLIER_AGENT_RUN_ACTIVE',
    });

    const externalRunAId = randomUUID();
    await runs.attachExternalRun(tenantId, relayRunAId, externalRunAId);
    const attemptStartedAt = new Date();
    const attemptFinishedAt = new Date(attemptStartedAt.getTime() + 25);
    await runs.recordModelExecutionEvidence(
      tenantId,
      relayRunAId,
      [
        {
          attemptNumber: 1,
          catalogVersionId: modelCatalogVersionId,
          routeKey: 'AGENT_RUN_PRIMARY',
          provider: 'OPENAI_COMPATIBLE',
          model: 'integration-chat',
          outcome: 'SUCCEEDED',
          reasonCode: null,
          retrySafe: false,
          startedAt: attemptStartedAt,
          finishedAt: attemptFinishedAt,
        },
      ],
      {
        direction: 'OUTPUT',
        classification: 'INTERNAL',
        action: 'ALLOW',
        reasonCodes: ['NO_SENSITIVE_PATTERN_DETECTED'],
        contentSha256: 'e'.repeat(64),
        redactedContentSha256: null,
        detectorVersion: 'integration-output-guard-v1',
        decisionHash: 'f'.repeat(64),
      },
    );
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
      groundedCitationCount: 0,
      reservedTokens: 0,
    });
    await expect(
      administrator.aiModelAttemptReceipt.findMany({
        where: { tenantId, runId: relayRunAId },
        orderBy: { phase: 'asc' },
        select: {
          phase: true,
          outcome: true,
          catalogVersionId: true,
          routeKey: true,
          provider: true,
          modelName: true,
        },
      }),
    ).resolves.toEqual([
      {
        phase: 'STARTED',
        outcome: 'STARTED',
        catalogVersionId: modelCatalogVersionId,
        routeKey: 'AGENT_RUN_PRIMARY',
        provider: 'OPENAI_COMPATIBLE',
        modelName: 'integration-chat',
      },
      {
        phase: 'TERMINAL',
        outcome: 'SUCCEEDED',
        catalogVersionId: modelCatalogVersionId,
        routeKey: 'AGENT_RUN_PRIMARY',
        provider: 'OPENAI_COMPATIBLE',
        modelName: 'integration-chat',
      },
    ]);
    await expect(
      administrator.aiModelCircuitStateRecord.findUnique({
        where: {
          tenantId_catalogVersionId: {
            tenantId,
            catalogVersionId: modelCatalogVersionId,
          },
        },
        select: { state: true, consecutiveFailures: true },
      }),
    ).resolves.toEqual({ state: 'CLOSED', consecutiveFailures: 0 });
    await expect(
      administrator.aiSafetyDecisionRecord.findFirst({
        where: { tenantId, runId: relayRunAId, direction: 'OUTPUT', sequence: 1 },
        select: { action: true, decisionHash: true },
      }),
    ).resolves.toEqual({ action: 'ALLOW', decisionHash: 'f'.repeat(64) });
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
    expect(completedA.outputMessageId).not.toBeNull();
    const completedAMessageId = completedA.outputMessageId!;
    const messageA = await administrator.message.findUniqueOrThrow({
      where: { id: completedAMessageId },
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
      inputMessageId: completedAMessageId,
      requesterUserId: actorId,
      agentId: agentBId,
      trigger: 'RELAY_TURN',
      turnIndex: 2,
      turnLimit: 2,
      status: 'QUEUED',
      conversationSequence: storedA.conversationSequence,
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

    await expect(runs.prepare(tenantId, queuedSecondTopicRunId)).resolves.toMatchObject({
      kind: 'deferred',
      reasonCode: 'EARLIER_AGENT_RUN_ACTIVE',
    });

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

    const preparedSecondTopic = await runs.prepare(tenantId, queuedSecondTopicRunId);
    if (preparedSecondTopic.kind !== 'ready') {
      throw new Error(
        `Expected the second topic to be ready, received ${preparedSecondTopic.kind}.`,
      );
    }
    expect(preparedSecondTopic.run.messages.at(-1)).toMatchObject({
      senderType: 'USER',
      senderId: actorId,
      text: 'A second topic must wait.',
    });
    const externalSecondTopicRunId = randomUUID();
    await runs.attachExternalRun(tenantId, queuedSecondTopicRunId, externalSecondTopicRunId);
    const completedSecondTopic = await runs.completeSucceeded(
      tenantId,
      queuedSecondTopicRunId,
      'Second topic answer',
    );
    expect(completedSecondTopic.externalRunId).toBe(externalSecondTopicRunId);
    const secondTopicRunB = await administrator.agentRun.findFirstOrThrow({
      where: {
        tenantId,
        conversationId: relayConversationId,
        parentRunId: queuedSecondTopicRunId,
      },
    });
    const preparedSecondTopicB = await runs.prepare(tenantId, secondTopicRunB.id);
    if (preparedSecondTopicB.kind !== 'ready') {
      throw new Error(
        `Expected the second topic relay turn to be ready, received ${preparedSecondTopicB.kind}.`,
      );
    }
    expect(preparedSecondTopicB.run.messages.at(-1)).toMatchObject({
      senderType: 'AGENT',
      senderId: agentAId,
      text: 'Second topic answer',
    });
    const externalSecondTopicRunBId = randomUUID();
    await runs.attachExternalRun(tenantId, secondTopicRunB.id, externalSecondTopicRunBId);
    const completedSecondTopicB = await runs.completeSucceeded(
      tenantId,
      secondTopicRunB.id,
      'Second topic Agent B answer',
    );
    expect(completedSecondTopicB.externalRunId).toBe(externalSecondTopicRunBId);

    const orderedRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: relayConversationId },
      orderBy: [{ conversationSequence: 'asc' }, { turnIndex: 'asc' }],
    });
    expect(orderedRuns).toHaveLength(4);
    expect(orderedRuns.map((run) => [run.turnIndex, run.agentId, run.status])).toEqual([
      [1, agentAId, 'SUCCEEDED'],
      [2, agentBId, 'SUCCEEDED'],
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
      orderBy: [{ sequence: 'asc' }],
      select: { senderType: true, senderUserId: true, senderAgentId: true },
    });
    expect(orderedMessages).toEqual([
      { senderType: 'USER', senderUserId: actorId, senderAgentId: null },
      { senderType: 'USER', senderUserId: actorId, senderAgentId: null },
      { senderType: 'AGENT', senderUserId: null, senderAgentId: agentAId },
      { senderType: 'AGENT', senderUserId: null, senderAgentId: agentBId },
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
    ).resolves.toBe(4);
  });

  it('serializes concurrent questions in one conversation while preparing different conversations in parallel', async () => {
    const sameConversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      .send({
        type: 'group',
        title: 'Concurrent same-conversation verification',
        memberUserIds: [],
        agentIds: [agentAId],
      })
      .expect(201);
    const sameConversationId = String(sameConversation.body.id);
    const concurrentMessages = await Promise.all([
      sendMessage(sameConversationId, {
        clientMessageId: 'agent-run-concurrent-same-0001',
        content: { type: 'text', text: 'Concurrent question one.' },
      }),
      sendMessage(sameConversationId, {
        clientMessageId: 'agent-run-concurrent-same-0002',
        content: { type: 'text', text: 'Concurrent question two.' },
      }),
    ]);
    expect(concurrentMessages.map(({ status }) => status)).toEqual([201, 201]);

    const sameConversationRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: sameConversationId },
      orderBy: { conversationSequence: 'asc' },
      select: { id: true, conversationSequence: true },
    });
    expect(sameConversationRuns).toHaveLength(2);
    expect(sameConversationRuns[0]!.conversationSequence).toBeLessThan(
      sameConversationRuns[1]!.conversationSequence,
    );
    const sameConversationPreparations = await Promise.all(
      sameConversationRuns.map(({ id }) => runs.prepare(tenantId, id)),
    );
    expect(sameConversationPreparations.map(({ kind }) => kind).sort()).toEqual([
      'deferred',
      'ready',
    ]);
    const readyIndex = sameConversationPreparations.findIndex(({ kind }) => kind === 'ready');
    const deferredIndex = sameConversationPreparations.findIndex(({ kind }) => kind === 'deferred');
    const readyRunId = sameConversationRuns[readyIndex]!.id;
    const deferredRunId = sameConversationRuns[deferredIndex]!.id;
    await runs.completeFailed(
      tenantId,
      readyRunId,
      'INTEGRATION_CONCURRENCY_COMPLETE',
      'Concurrency verification completed.',
    );
    await expect(runs.prepare(tenantId, deferredRunId)).resolves.toMatchObject({ kind: 'ready' });
    await runs.completeFailed(
      tenantId,
      deferredRunId,
      'INTEGRATION_CONCURRENCY_COMPLETE',
      'Concurrency verification completed.',
    );

    const parallelConversations = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(identityHeaders())
        .send({
          type: 'group',
          title: 'Concurrent cross-conversation verification A',
          memberUserIds: [],
          agentIds: [agentAId],
        }),
      request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(identityHeaders())
        .send({
          type: 'group',
          title: 'Concurrent cross-conversation verification B',
          memberUserIds: [],
          agentIds: [agentBId],
        }),
    ]);
    expect(parallelConversations.map(({ status }) => status)).toEqual([201, 201]);
    const parallelMessages = await Promise.all([
      sendMessage(String(parallelConversations[0]!.body.id), {
        clientMessageId: 'agent-run-concurrent-cross-0001',
        content: { type: 'text', text: 'Parallel conversation one.' },
      }),
      sendMessage(String(parallelConversations[1]!.body.id), {
        clientMessageId: 'agent-run-concurrent-cross-0002',
        content: { type: 'text', text: 'Parallel conversation two.' },
      }),
    ]);
    expect(parallelMessages.map(({ status }) => status)).toEqual([201, 201]);
    const parallelRuns = await administrator.agentRun.findMany({
      where: {
        tenantId,
        conversationId: {
          in: parallelConversations.map(({ body }) => String(body.id)),
        },
      },
      orderBy: { conversationId: 'asc' },
      select: { id: true },
    });
    expect(parallelRuns).toHaveLength(2);
    const parallelPreparations = await Promise.all(
      parallelRuns.map(({ id }) => runs.prepare(tenantId, id)),
    );
    expect(parallelPreparations.map(({ kind }) => kind)).toEqual(['ready', 'ready']);
    await Promise.all(
      parallelRuns.map(({ id }) =>
        runs.completeFailed(
          tenantId,
          id,
          'INTEGRATION_CONCURRENCY_COMPLETE',
          'Concurrency verification completed.',
        ),
      ),
    );
  });

  it('atomically defers dispatch at the tenant concurrency limit and rejects exhausted monthly quota', async () => {
    await administrator.agentRun.updateMany({
      where: {
        tenantId,
        status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] },
      },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        reservedTokens: 0,
        errorCode: 'INTEGRATION_QUOTA_FIXTURE_RESET',
      },
    });
    await administrator.tenant.update({
      where: { id: tenantId },
      data: {
        agentRunConcurrencyLimit: 8,
        agentRunRateLimitPerMinute: 10_000,
        agentRunMonthlyTokenLimit: 1_000_000_000n,
      },
    });
    const holderConversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      .send({ type: 'direct', target: { type: 'agent', agentId: agentAId } })
      .expect(201);
    const holderMessage = await sendMessage(String(holderConversation.body.id), {
      clientMessageId: 'agent-run-quota-holder-0001',
      content: { type: 'text', text: 'Hold one real tenant concurrency slot.' },
    }).expect(201);
    const holder = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, inputMessageId: String(holderMessage.body.id) },
    });
    await expect(runs.prepare(tenantId, holder.id)).resolves.toMatchObject({ kind: 'ready' });
    await runs.attachExternalRun(tenantId, holder.id, randomUUID());

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

    // UNKNOWN may still be executing remotely, so its unverified Token reservation
    // remains. It must not, however, consume a local executable slot indefinitely:
    // otherwise one provider ambiguity can freeze unrelated users in the tenant.
    await runs.completeUnknown(tenantId, holder.id, 'PROVIDER_RESULT_UNKNOWN');

    await administrator.tenant.update({
      where: { id: tenantId },
      data: { agentRunConcurrencyLimit: 1, agentRunMonthlyTokenLimit: 100_000_000n },
    });
    await expect(runs.prepare(tenantId, queued.id)).resolves.toMatchObject({ kind: 'ready' });
    await runs.completeFailed(
      tenantId,
      queued.id,
      'INTEGRATION_UNKNOWN_LOCAL_SLOT_RELEASED',
      'Verified that UNKNOWN does not hold a local executable slot.',
    );

    // Exercise the independent monthly Token hold with a fresh Run. Releasing the
    // local slot does not pretend the unknown provider usage is free.
    const tokenMessage = await sendMessage(String(conversation.body.id), {
      clientMessageId: 'agent-run-quota-message-0002',
      content: { type: 'text', text: 'Exercise the independent monthly Token hold.' },
    }).expect(201);
    const tokenQueued = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, inputMessageId: String(tokenMessage.body.id) },
    });
    await administrator.tenant.update({
      where: { id: tenantId },
      data: { agentRunConcurrencyLimit: 1, agentRunMonthlyTokenLimit: 16n },
    });
    const rejected = await runs.prepare(tenantId, tokenQueued.id);
    expect(rejected).toMatchObject({
      kind: 'terminal',
      status: 'FAILED',
      errorCode: 'TENANT_MONTHLY_TOKEN_QUOTA_EXCEEDED',
    });
    await expect(
      administrator.agentRun.findUniqueOrThrow({ where: { id: tokenQueued.id } }),
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

  it('claims only the queue head of each conversation across multiple workers', async () => {
    const existingEventIds = (
      await administrator.outboxEvent.findMany({
        where: { tenantId, eventType: agentRunRequestedEventType },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await administrator.outboxEventDelivery.deleteMany({
      where: { tenantId, eventId: { in: existingEventIds } },
    });
    await administrator.outboxEvent.deleteMany({
      where: { tenantId, eventType: agentRunRequestedEventType },
    });

    const [busyConversation, independentConversation] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(identityHeaders())
        .send({
          type: 'group',
          title: 'Outbox queue-head verification',
          memberUserIds: [],
          agentIds: [agentAId],
        }),
      request(app.getHttpServer())
        .post('/api/v1/conversations')
        .set(identityHeaders())
        .send({
          type: 'group',
          title: 'Outbox independent conversation verification',
          memberUserIds: [],
          agentIds: [agentBId],
        }),
    ]);
    expect(busyConversation.status, JSON.stringify(busyConversation.body)).toBe(201);
    expect(independentConversation.status, JSON.stringify(independentConversation.body)).toBe(201);
    const busyConversationId = String(busyConversation.body.id);
    const independentConversationId = String(independentConversation.body.id);
    const messages = await Promise.all([
      ...Array.from({ length: 10 }, (_, index) =>
        sendMessage(busyConversationId, {
          clientMessageId: `agent-run-queue-head-${String(index).padStart(4, '0')}`,
          content: { type: 'text', text: `Queued question ${index + 1}.` },
        }),
      ),
      sendMessage(independentConversationId, {
        clientMessageId: 'agent-run-queue-head-independent-0001',
        content: { type: 'text', text: 'Independent queued question.' },
      }),
    ]);
    expect(messages.every(({ status }) => status === 201)).toBe(true);

    const busyRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: busyConversationId },
      orderBy: [{ conversationSequence: 'asc' }, { turnIndex: 'asc' }],
      select: { id: true },
    });
    const independentRun = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId, conversationId: independentConversationId },
      select: { id: true },
    });
    expect(busyRuns).toHaveLength(10);

    const [left, right] = await Promise.all([
      leftQueue.claim({ workerId: 'queue-head-left', batchSize: 20, claimTtlMs: 30_000 }),
      rightQueue.claim({ workerId: 'queue-head-right', batchSize: 20, claimTtlMs: 30_000 }),
    ]);
    const claimed = [...left, ...right];
    expect(new Set(claimed.map(({ aggregateId }) => aggregateId))).toEqual(
      new Set([busyRuns[0]!.id, independentRun.id]),
    );

    const blockedRunIds = busyRuns.slice(1).map(({ id }) => id);
    const blockedEventIds = (
      await administrator.outboxEvent.findMany({
        where: {
          tenantId,
          eventType: agentRunRequestedEventType,
          aggregateId: { in: blockedRunIds },
        },
        select: { id: true },
      })
    ).map(({ id }) => id);
    const blockedDeliveries = await administrator.outboxEventDelivery.findMany({
      where: { tenantId, eventId: { in: blockedEventIds } },
      select: { attempts: true, lockedBy: true },
    });
    expect(blockedDeliveries).toHaveLength(9);
    expect(
      blockedDeliveries.every(({ attempts, lockedBy }) => attempts === 0 && lockedBy === null),
    ).toBe(true);
  });

  it('supersedes UNKNOWN with its queued successor and suppresses a late answer', async () => {
    const existingEventIds = (
      await administrator.outboxEvent.findMany({
        where: { tenantId, eventType: agentRunRequestedEventType },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await administrator.outboxEventDelivery.deleteMany({
      where: { tenantId, eventId: { in: existingEventIds } },
    });
    await administrator.outboxEvent.deleteMany({
      where: { tenantId, eventType: agentRunRequestedEventType },
    });
    await administrator.agentRun.updateMany({
      where: {
        tenantId,
        status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] },
      },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        reservedTokens: 0,
        errorCode: 'INTEGRATION_UNKNOWN_RECOVERY_RESET',
      },
    });
    await administrator.tenant.update({
      where: { id: tenantId },
      data: {
        agentRunConcurrencyLimit: 8,
        agentRunRateLimitPerMinute: 1_000,
        agentRunMonthlyTokenLimit: 1_000_000_000n,
      },
    });

    const conversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders())
      .send({
        type: 'group',
        title: 'UNKNOWN participant recovery verification',
        memberUserIds: [],
        agentIds: [agentAId],
      })
      .expect(201);
    const conversationId = String(conversation.body.id);
    const messages = await Promise.all([
      sendMessage(conversationId, {
        clientMessageId: 'agent-run-unknown-recovery-0001',
        content: { type: 'text', text: 'First question with an uncertain result.' },
      }),
      sendMessage(conversationId, {
        clientMessageId: 'agent-run-unknown-recovery-0002',
        content: { type: 'text', text: 'Second question must wait for a decision.' },
      }),
    ]);
    expect(messages.every(({ status }) => status === 201)).toBe(true);
    const conversationRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId },
      orderBy: [{ conversationSequence: 'asc' }, { turnIndex: 'asc' }],
      select: { id: true },
    });
    expect(conversationRuns).toHaveLength(2);
    const firstRun = conversationRuns[0]!;
    const secondRun = conversationRuns[1]!;

    const [firstClaim] = await leftQueue.claim({
      workerId: 'unknown-recovery-first',
      batchSize: 10,
      claimTtlMs: 30_000,
    });
    expect(firstClaim?.aggregateId).toBe(firstRun.id);
    await expect(runs.prepare(tenantId, firstRun.id)).resolves.toMatchObject({ kind: 'ready' });
    const firstExternalRunId = randomUUID();
    await runs.attachExternalRun(tenantId, firstRun.id, firstExternalRunId);
    await runs.completeUnknown(tenantId, firstRun.id, 'INTEGRATION_UNKNOWN_RECOVERY_PENDING');
    await expect(
      leftQueue.markUnknown({
        eventId: firstClaim!.id,
        workerId: 'unknown-recovery-first',
        errorCode: 'INTEGRATION_UNKNOWN_RECOVERY_PENDING',
      }),
    ).resolves.toBe(true);

    await expect(
      administrator.agentRun.findUniqueOrThrow({ where: { id: firstRun.id } }),
    ).resolves.toMatchObject({
      status: 'UNKNOWN',
      externalRunId: firstExternalRunId,
      supersededByRunId: secondRun.id,
    });

    const [successorClaim] = await rightQueue.claim({
      workerId: 'unknown-recovery-successor',
      batchSize: 10,
      claimTtlMs: 30_000,
    });
    expect(successorClaim).toMatchObject({ aggregateId: secondRun.id, attempts: 1 });

    await expect(runs.prepareReconciliation(tenantId, firstRun.id)).resolves.toMatchObject({
      kind: 'ready',
    });
    const lateResult = await runs.completeSucceeded(
      tenantId,
      firstRun.id,
      'This late result is retained for audit but must not enter the conversation.',
    );
    expect(lateResult).toEqual({ outputMessageId: null, externalRunId: firstExternalRunId });
    await expect(
      administrator.message.count({
        where: { tenantId, clientMessageId: `agent-run:${firstRun.id}` },
      }),
    ).resolves.toBe(0);
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId,
          action: 'agent.run.late_success_suppressed',
          resourceId: firstRun.id,
        },
      }),
    ).resolves.toBe(1);

    await expect(runs.prepare(tenantId, secondRun.id)).resolves.toMatchObject({ kind: 'ready' });
    await runs.completeFailed(
      tenantId,
      secondRun.id,
      'INTEGRATION_UNKNOWN_RECOVERY_COMPLETE',
      'UNKNOWN recovery verification completed.',
    );
    await expect(
      rightQueue.markFailed({
        eventId: successorClaim!.id,
        workerId: 'unknown-recovery-successor',
        errorCode: 'INTEGRATION_UNKNOWN_RECOVERY_COMPLETE',
      }),
    ).resolves.toBe(true);
  });

  it('does not let the Outbox ordering capability read Agent Run policy data', async () => {
    await expect(
      leftQueueClient.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_outbox');
        return transaction.$queryRawUnsafe(
          'SELECT "policy_snapshot" FROM public."agent_runs" LIMIT 1',
        );
      }),
    ).rejects.toThrow();
  });

  it('keeps a cold-start backlog of 200 request events within the tenant concurrency limit', async () => {
    const existingEventIds = (
      await administrator.outboxEvent.findMany({
        where: { tenantId, eventType: agentRunRequestedEventType },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await administrator.outboxEventDelivery.deleteMany({
      where: { tenantId, eventId: { in: existingEventIds } },
    });
    await administrator.outboxEvent.deleteMany({
      where: { tenantId, eventType: agentRunRequestedEventType },
    });
    await administrator.agentRun.updateMany({
      where: {
        tenantId,
        status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] },
      },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        reservedTokens: 0,
        errorCode: 'INTEGRATION_COLD_START_RESET',
      },
    });
    await administrator.tenant.update({
      where: { id: tenantId },
      data: {
        agentRunConcurrencyLimit: 8,
        agentRunRateLimitPerMinute: 1_000,
        agentRunMonthlyTokenLimit: 1_000_000_000n,
      },
    });

    const conversationIds: string[] = [];
    for (let offset = 0; offset < 200; offset += 20) {
      const conversations = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          request(app.getHttpServer())
            .post('/api/v1/conversations')
            .set(identityHeaders())
            .send({
              type: 'group',
              title: `Cold-start quota ${offset + index + 1}`,
              memberUserIds: [],
              agentIds: [agentAId],
            }),
        ),
      );
      expect(conversations.every(({ status }) => status === 201)).toBe(true);
      conversationIds.push(...conversations.map(({ body }) => String(body.id)));
    }
    for (let offset = 0; offset < conversationIds.length; offset += 20) {
      const messages = await Promise.all(
        conversationIds.slice(offset, offset + 20).map((conversationId, index) =>
          sendMessage(conversationId, {
            clientMessageId: `agent-run-cold-start-${String(offset + index).padStart(4, '0')}`,
            content: { type: 'text', text: `Cold-start question ${offset + index + 1}.` },
          }),
        ),
      );
      expect(messages.every(({ status }) => status === 201)).toBe(true);
    }

    const queuedRuns = await administrator.agentRun.findMany({
      where: { tenantId, conversationId: { in: conversationIds }, status: 'QUEUED' },
      select: { id: true },
    });
    expect(queuedRuns).toHaveLength(200);
    const claimers = Array.from({ length: 8 }, (_, index) => ({
      workerId: `cold-start-worker-${index + 1}`,
      queue: index % 2 === 0 ? leftQueue : rightQueue,
    }));
    const claimBatches = await Promise.all(
      claimers.map(({ workerId, queue }) =>
        queue.claim({ workerId, batchSize: 25, claimTtlMs: 120_000 }),
      ),
    );
    const claims = claimBatches.flatMap((events, index) =>
      events.map((event) => ({ event, workerId: claimers[index]!.workerId })),
    );
    expect(claims).toHaveLength(200);
    expect(new Set(claims.map(({ event }) => event.id)).size).toBe(200);

    // No Run is completed while these preparations race. Therefore the final
    // number of DISPATCHING/RUNNING/UNKNOWN rows is also the observed peak.
    let readyCount = 0;
    let deferredCount = 0;
    for (let offset = 0; offset < claims.length; offset += 16) {
      const preparations = await Promise.all(
        claims
          .slice(offset, offset + 16)
          .map(({ event }) => runs.prepare(tenantId, event.aggregateId)),
      );
      expect(preparations.every(({ kind }) => kind === 'ready' || kind === 'deferred')).toBe(true);
      readyCount += preparations.filter(({ kind }) => kind === 'ready').length;
      deferredCount += preparations.filter(({ kind }) => kind === 'deferred').length;
    }
    expect(readyCount).toBe(8);
    expect(deferredCount).toBe(192);
    await expect(
      administrator.agentRun.count({
        where: { tenantId, status: { in: ['DISPATCHING', 'RUNNING', 'UNKNOWN'] } },
      }),
    ).resolves.toBe(8);

    const coldRunIds = queuedRuns.map(({ id }) => id);
    await administrator.agentRun.updateMany({
      where: { tenantId, id: { in: coldRunIds } },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        reservedTokens: 0,
        errorCode: 'INTEGRATION_COLD_START_COMPLETE',
      },
    });
    for (let offset = 0; offset < claims.length; offset += 16) {
      const settled = await Promise.all(
        claims.slice(offset, offset + 16).map(({ event, workerId }) =>
          leftQueue.markFailed({
            eventId: event.id,
            workerId,
            errorCode: 'INTEGRATION_COLD_START_COMPLETE',
          }),
        ),
      );
      expect(settled.every(Boolean)).toBe(true);
    }
  }, 180_000);

  it('keeps steady successful acquire-release competition within the tenant concurrency limit', async () => {
    const existingEventIds = (
      await administrator.outboxEvent.findMany({
        where: { tenantId, eventType: agentRunRequestedEventType },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await administrator.outboxEventDelivery.deleteMany({
      where: { tenantId, eventId: { in: existingEventIds } },
    });
    await administrator.outboxEvent.deleteMany({
      where: { tenantId, eventType: agentRunRequestedEventType },
    });
    await administrator.agentRun.updateMany({
      where: {
        tenantId,
        status: { in: ['QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'] },
      },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        reservedTokens: 0,
        errorCode: 'INTEGRATION_STEADY_STATE_RESET',
      },
    });
    await administrator.tenant.update({
      where: { id: tenantId },
      data: {
        agentRunConcurrencyLimit: 8,
        agentRunRateLimitPerMinute: 10_000,
        agentRunMonthlyTokenLimit: 1_000_000_000n,
      },
    });

    const conversations = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(app.getHttpServer())
          .post('/api/v1/conversations')
          .set(identityHeaders())
          .send({
            type: 'group',
            title: `Steady-state quota conversation ${index + 1}`,
            memberUserIds: [],
            agentIds: [agentAId],
          }),
      ),
    );
    expect(conversations.every(({ status }) => status === 201)).toBe(true);
    const conversationIds = conversations.map(({ body }) => String(body.id));
    const messageBatches = await Promise.all(
      conversationIds.map((conversationId, conversationIndex) =>
        Promise.all(
          Array.from({ length: 10 }, (_, messageIndex) =>
            sendMessage(conversationId, {
              clientMessageId: `agent-run-steady-${conversationIndex}-${messageIndex}`,
              content: {
                type: 'text',
                text: `Steady-state question ${conversationIndex + 1}.${messageIndex + 1}.`,
              },
            }),
          ),
        ),
      ),
    );
    expect(messageBatches.flat().every(({ status }) => status === 201)).toBe(true);
    const steadyRunIds = (
      await administrator.agentRun.findMany({
        where: { tenantId, conversationId: { in: conversationIds } },
        select: { id: true },
      })
    ).map(({ id }) => id);
    expect(steadyRunIds).toHaveLength(100);

    let completed = 0;
    let peakActive = 0;
    const deadline = Date.now() + 90_000;
    const simulatedWorkers = Array.from({ length: 16 }, (_, index) => ({
      workerId: `steady-state-worker-${index + 1}`,
      queue: index % 2 === 0 ? leftQueue : rightQueue,
    }));
    await Promise.all(
      simulatedWorkers.map(async ({ workerId, queue }) => {
        while (completed < steadyRunIds.length) {
          if (Date.now() > deadline) {
            throw new Error(
              `Steady-state quota test timed out after completing ${completed} Runs.`,
            );
          }
          const [event] = await queue.claim({ workerId, batchSize: 1, claimTtlMs: 30_000 });
          if (event === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            continue;
          }
          const preparation = await runs.prepare(tenantId, event.aggregateId);
          if (preparation.kind === 'deferred') {
            await expect(
              queue.defer({
                eventId: event.id,
                workerId,
                availableAt: new Date(Date.now() + 5),
                reasonCode: preparation.reasonCode,
              }),
            ).resolves.toBe(true);
            continue;
          }
          expect(preparation.kind).toBe('ready');
          const active = await administrator.agentRun.count({
            where: { tenantId, status: { in: ['DISPATCHING', 'RUNNING', 'UNKNOWN'] } },
          });
          peakActive = Math.max(peakActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          const externalRunId = randomUUID();
          await runs.attachExternalRun(tenantId, event.aggregateId, externalRunId);
          await runs.completeSucceeded(
            tenantId,
            event.aggregateId,
            `Steady-state successful answer ${event.aggregateId}.`,
            [],
            {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              toolCalls: 0,
              costMicros: 0,
              tokensReported: true,
              costReported: false,
              provider: 'integration',
              model: 'steady-state',
            },
          );
          await expect(
            queue.markPublished({
              eventId: event.id,
              workerId,
              externalRunId,
            }),
          ).resolves.toBe(true);
          completed += 1;
        }
      }),
    );

    expect(completed).toBe(100);
    expect(peakActive).toBe(8);
    await expect(
      administrator.agentRun.count({
        where: { tenantId, id: { in: steadyRunIds }, status: 'SUCCEEDED' },
      }),
    ).resolves.toBe(100);
  }, 180_000);

  it('uses two SKIP LOCKED claimants without claiming an event twice', async () => {
    const existingEventIds = (
      await administrator.outboxEvent.findMany({
        where: { tenantId, eventType: agentRunRequestedEventType },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await administrator.outboxEventDelivery.deleteMany({
      where: { tenantId, eventId: { in: existingEventIds } },
    });
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
    await administrator.user.createMany({
      data: [
        {
          id: actorId,
          tenantId,
          email: 'actor@agent-run-integration.invalid',
          emailNormalized: 'actor@agent-run-integration.invalid',
          displayName: 'Agent Run Actor',
          status: 'ACTIVE',
        },
        {
          id: routeReviewerId,
          tenantId,
          email: 'route-reviewer@agent-run-integration.invalid',
          emailNormalized: 'route-reviewer@agent-run-integration.invalid',
          displayName: 'Agent Run Route Reviewer',
          role: 'ADMIN',
          status: 'ACTIVE',
        },
        {
          id: agentBOwnerId,
          tenantId,
          email: 'agent-b-owner@agent-run-integration.invalid',
          emailNormalized: 'agent-b-owner@agent-run-integration.invalid',
          displayName: 'Agent B Owner',
          status: 'ACTIVE',
        },
      ],
    });
    const reviewedAt = new Date();
    await withModelRouteActor(actorId, async (transaction) => {
      await transaction.aiModelCatalogVersion.create({
        data: {
          id: modelCatalogVersionId,
          tenantId,
          routeKey: 'AGENT_RUN_PRIMARY',
          version: 1,
          provider: 'OPENAI_COMPATIBLE',
          modelName: 'integration-chat',
          credentialReference: 'vault://integration/agent-run',
          dataResidency: 'CN',
          maximumClassification: 'CONFIDENTIAL',
          capabilities: ['chat'],
          maxContextTokens: 32_000,
          maxOutputTokens: 4_000,
          inputCostMicrosPerMillion: 1_000n,
          outputCostMicrosPerMillion: 2_000n,
          p95LatencyMs: 5_000,
          configurationHash: 'a'.repeat(64),
          createdByUserId: actorId,
          idempotencyKey: 'agent-run-integration-model-v1',
          requestHash: 'b'.repeat(64),
        },
      });
      await transaction.aiModelCatalogVersion.update({
        where: { id: modelCatalogVersionId },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: actorId,
          submittedAt: reviewedAt,
        },
      });
    });
    await withModelRouteActor(routeReviewerId, async (transaction) => {
      await transaction.aiModelCatalogVersion.update({
        where: { id: modelCatalogVersionId },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: routeReviewerId,
          reviewedAt,
          publishedByUserId: routeReviewerId,
          publishedAt: reviewedAt,
        },
      });
    });
    await withModelRouteActor(actorId, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.create({
        data: {
          id: modelRoutePolicyVersionId,
          tenantId,
          taskClass: 'GENERAL_QA',
          version: 1,
          maximumClassification: 'CONFIDENTIAL',
          allowedResidencies: ['CN'],
          requiredCapabilities: ['chat'],
          maxP95LatencyMs: 8_000,
          maxInputCostMicrosPerMillion: 5_000n,
          maxOutputCostMicrosPerMillion: 10_000n,
          maximumAttempts: 1,
          circuitFailureThreshold: 3,
          circuitOpenSeconds: 60,
          policyHash: 'c'.repeat(64),
          createdByUserId: actorId,
          idempotencyKey: 'agent-run-integration-policy-v1',
          requestHash: 'd'.repeat(64),
        },
      });
      await transaction.aiModelRouteCandidate.create({
        data: {
          tenantId,
          policyVersionId: modelRoutePolicyVersionId,
          ordinal: 1,
          catalogVersionId: modelCatalogVersionId,
        },
      });
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: modelRoutePolicyVersionId },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: actorId,
          submittedAt: reviewedAt,
        },
      });
    });
    await withModelRouteActor(routeReviewerId, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: modelRoutePolicyVersionId },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: routeReviewerId,
          reviewedAt,
          publishedByUserId: routeReviewerId,
          publishedAt: reviewedAt,
        },
      });
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
        modelPolicy: {
          taskClass: 'GENERAL_QA',
          dataClassification: 'INTERNAL',
          requiredCapabilities: ['chat'],
        },
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
          ownerUserId: agentBOwnerId,
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
    await cleanupDisposableTenants(administrator, tenantIds);
  }

  async function withModelRouteActor<T>(
    userId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return operation(transaction);
    });
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
