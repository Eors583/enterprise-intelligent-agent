import { randomUUID } from 'node:crypto';

import { PrismaClient, type Prisma } from '@prisma/client';

import { PrismaService } from '../src/database/prisma.service.js';
import { AdminAccessService } from '../src/modules/admin/admin-access.service.js';
import { AiSafetyModelRoutingService } from '../src/modules/ai-safety-model-routing/ai-safety-model-routing.service.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe.runIf(enabled)('PostgreSQL AI safety and model routing integration', () => {
  const administrator = new PrismaClient();
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  const makerAId = randomUUID();
  const reviewerAId = randomUUID();
  const makerBId = randomUUID();
  const catalogAId = randomUUID();
  const catalogBId = randomUUID();
  const policyAId = randomUUID();
  const policyAReplacementId = randomUUID();
  const templateAId = randomUUID();
  const agentVersionAId = randomUUID();
  const agentAId = randomUUID();
  const conversationAId = randomUUID();
  const inputMessageAId = randomUUID();
  const runAId = randomUUID();
  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    await administrator.tenant.createMany({
      data: [
        {
          id: tenantAId,
          slug: `ai-routing-integration-a-${unique}`,
          name: 'AI routing integration tenant A',
        },
        {
          id: tenantBId,
          slug: `ai-routing-integration-b-${unique}`,
          name: 'AI routing integration tenant B',
        },
      ],
    });
    await administrator.user.createMany({
      data: [
        {
          id: makerAId,
          tenantId: tenantAId,
          email: `maker-a-${unique}@ai-routing.integration`,
          emailNormalized: `maker-a-${unique}@ai-routing.integration`,
          displayName: 'AI routing maker A',
          role: 'OWNER',
        },
        {
          id: reviewerAId,
          tenantId: tenantAId,
          email: `reviewer-a-${unique}@ai-routing.integration`,
          emailNormalized: `reviewer-a-${unique}@ai-routing.integration`,
          displayName: 'AI routing reviewer A',
          role: 'ADMIN',
        },
        {
          id: makerBId,
          tenantId: tenantBId,
          email: `maker-b-${unique}@ai-routing.integration`,
          emailNormalized: `maker-b-${unique}@ai-routing.integration`,
          displayName: 'AI routing maker B',
          role: 'OWNER',
        },
      ],
    });

    await withActor(tenantAId, makerAId, async (transaction) => {
      await transaction.aiModelCatalogVersion.create({
        data: catalogFixture({
          id: catalogAId,
          tenantId: tenantAId,
          userId: makerAId,
          idempotencyKey: `catalog-a-${unique}`,
        }),
      });
    });
    await withActor(tenantBId, makerBId, async (transaction) => {
      await transaction.aiModelCatalogVersion.create({
        data: catalogFixture({
          id: catalogBId,
          tenantId: tenantBId,
          userId: makerBId,
          idempotencyKey: `catalog-b-${unique}`,
        }),
      });
    });
  });

  afterAll(async () => {
    await administrator.$disconnect();
  });

  it('publishes immutable model and route versions with maker-checker, audit and outbox evidence', async () => {
    const submittedAt = new Date();
    await withActor(tenantAId, makerAId, async (transaction) => {
      await transaction.aiModelCatalogVersion.update({
        where: { id: catalogAId },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: makerAId,
          submittedAt,
        },
      });
    });
    await withActor(tenantAId, reviewerAId, async (transaction) => {
      await transaction.aiModelCatalogVersion.update({
        where: { id: catalogAId },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: reviewerAId,
          reviewedAt: submittedAt,
          publishedByUserId: reviewerAId,
          publishedAt: submittedAt,
        },
      });
    });

    await withActor(tenantAId, makerAId, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.create({
        data: {
          id: policyAId,
          tenantId: tenantAId,
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
          policyHash: HASH_B,
          createdByUserId: makerAId,
          idempotencyKey: `policy-a-${unique}`,
          requestHash: HASH_C,
        },
      });
      await transaction.aiModelRouteCandidate.create({
        data: {
          tenantId: tenantAId,
          policyVersionId: policyAId,
          ordinal: 1,
          catalogVersionId: catalogAId,
        },
      });
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: policyAId },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: makerAId,
          submittedAt,
        },
      });
    });
    await withActor(tenantAId, reviewerAId, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: policyAId },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: reviewerAId,
          reviewedAt: submittedAt,
          publishedByUserId: reviewerAId,
          publishedAt: submittedAt,
        },
      });
    });

    await expect(
      administrator.aiModelRoutePolicyVersion.findUniqueOrThrow({ where: { id: policyAId } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHED',
      revision: 3,
      submittedByUserId: makerAId,
      reviewedByUserId: reviewerAId,
    });
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId: tenantAId,
          resourceId: { in: [catalogAId, policyAId] },
        },
      }),
    ).resolves.toBeGreaterThanOrEqual(6);
    await expect(
      administrator.outboxEvent.count({
        where: {
          tenantId: tenantAId,
          aggregateId: { in: [catalogAId, policyAId] },
          aggregateType: 'AI_GOVERNANCE',
        },
      }),
    ).resolves.toBeGreaterThanOrEqual(6);
  });

  it('rejects plaintext credentials, stale revisions, self-review and published mutation', async () => {
    await expect(
      administrator.aiModelCatalogVersion.create({
        data: catalogFixture({
          id: randomUUID(),
          tenantId: tenantBId,
          userId: makerBId,
          routeKey: 'PLAINTEXT',
          credentialReference: 'secret=plaintext-provider-key',
          idempotencyKey: `plaintext-${unique}`,
        }),
      }),
    ).rejects.toThrow();

    await expect(
      administrator.aiModelCatalogVersion.update({
        where: { id: catalogBId },
        data: { revision: 1, modelName: 'stale-write' },
      }),
    ).rejects.toThrow();

    await expect(
      administrator.aiModelCatalogVersion.update({
        where: { id: catalogAId },
        data: { revision: 4, modelName: 'mutated-after-publication' },
      }),
    ).rejects.toThrow();

    const now = new Date();
    await expect(
      administrator.aiModelCatalogVersion.create({
        data: {
          ...catalogFixture({
            id: randomUUID(),
            tenantId: tenantBId,
            userId: makerBId,
            routeKey: 'SELF_REVIEWED',
            idempotencyKey: `self-review-${unique}`,
          }),
          status: 'PUBLISHED',
          submittedByUserId: makerBId,
          submittedAt: now,
          reviewedByUserId: makerBId,
          reviewedAt: now,
          publishedByUserId: makerBId,
          publishedAt: now,
        },
      }),
    ).rejects.toThrow();
  });

  it('forces tenant RLS and exposes only bounded application-role privileges', async () => {
    const visibleForTenantA = await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${makerAId}, true)`;
      return transaction.$queryRaw<Array<{ tenantId: string }>>`
        SELECT "tenant_id" AS "tenantId"
        FROM public."ai_model_catalog_versions"
        ORDER BY "tenant_id"
      `;
    });
    expect(visibleForTenantA).toEqual([{ tenantId: tenantAId }]);

    const visibleWithoutTenant = await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', '', true)`;
      return transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS "count"
        FROM public."ai_model_catalog_versions"
      `;
    });
    expect(visibleWithoutTenant[0]?.count).toBe(0n);

    const [security] = await administrator.$queryRaw<
      Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        appCanSelect: boolean;
        appCanInsert: boolean;
        appCanDelete: boolean;
        publicCanSelect: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        has_table_privilege(
          'enterprise_agent_app',
          'public.ai_model_catalog_versions',
          'SELECT'
        ) AS "appCanSelect",
        has_table_privilege(
          'enterprise_agent_app',
          'public.ai_model_catalog_versions',
          'INSERT'
        ) AS "appCanInsert",
        has_table_privilege(
          'enterprise_agent_app',
          'public.ai_model_catalog_versions',
          'DELETE'
        ) AS "appCanDelete",
        has_table_privilege(
          'public',
          'public.ai_model_catalog_versions',
          'SELECT'
        ) AS "publicCanSelect"
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'ai_model_catalog_versions'
    `;
    expect(security).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      appCanSelect: true,
      appCanInsert: true,
      appCanDelete: false,
      publicCanSelect: false,
    });
  });

  it('keeps the Run route snapshot stable and append-only evidence hash-only', async () => {
    await seedRunFixture();
    const originalSnapshot = routeSnapshot(policyAId, HASH_B, 1, catalogAId);
    await administrator.agentRun.update({
      where: { id: runAId },
      data: {
        modelRoutePolicyVersionId: policyAId,
        modelRouteSnapshot: originalSnapshot,
      },
    });

    const changedAt = new Date();
    const retireIdempotencyKey = `policy-a-retire-${unique}`;
    const governance = routingServiceFor(reviewerAId);
    const retireRequest = {
      action: 'RETIRE' as const,
      expectedRevision: 3,
      reason: 'Replace the published route with a lower latency version.',
      idempotencyKey: retireIdempotencyKey,
    };
    const firstRetirement = await governance.transitionRoutePolicyVersion(policyAId, retireRequest);
    const replayedRetirement = await governance.transitionRoutePolicyVersion(
      policyAId,
      retireRequest,
    );
    expect(firstRetirement.revision).toBe(4);
    expect(replayedRetirement.revision).toBe(4);
    await expect(
      administrator.aiGovernanceCommand.count({
        where: { tenantId: tenantAId, idempotencyKey: retireIdempotencyKey },
      }),
    ).resolves.toBe(1);
    await expect(
      governance.transitionRoutePolicyVersion(policyAId, {
        ...retireRequest,
        reason: 'Conflicting reuse of the idempotency key.',
      }),
    ).rejects.toThrow();
    await withActor(tenantAId, makerAId, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.create({
        data: {
          id: policyAReplacementId,
          tenantId: tenantAId,
          taskClass: 'GENERAL_QA',
          version: 2,
          maximumClassification: 'CONFIDENTIAL',
          allowedResidencies: ['CN'],
          requiredCapabilities: ['chat'],
          maxP95LatencyMs: 6_000,
          maxInputCostMicrosPerMillion: 4_000n,
          maxOutputCostMicrosPerMillion: 8_000n,
          maximumAttempts: 1,
          circuitFailureThreshold: 2,
          circuitOpenSeconds: 120,
          policyHash: HASH_C,
          createdByUserId: makerAId,
          idempotencyKey: `policy-a-v2-${unique}`,
          requestHash: HASH_A,
        },
      });
      await transaction.aiModelRouteCandidate.create({
        data: {
          tenantId: tenantAId,
          policyVersionId: policyAReplacementId,
          ordinal: 1,
          catalogVersionId: catalogAId,
        },
      });
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: policyAReplacementId },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: makerAId,
          submittedAt: changedAt,
        },
      });
    });
    await withActor(tenantAId, reviewerAId, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: policyAReplacementId },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: reviewerAId,
          reviewedAt: changedAt,
          publishedByUserId: reviewerAId,
          publishedAt: changedAt,
        },
      });
    });

    const storedRun = await administrator.agentRun.findUniqueOrThrow({ where: { id: runAId } });
    expect(storedRun.modelRoutePolicyVersionId).toBe(policyAId);
    expect(storedRun.modelRouteSnapshot).toEqual(originalSnapshot);
    await expect(
      administrator.agentRun.update({
        where: { id: runAId },
        data: {
          modelRoutePolicyVersionId: policyAReplacementId,
          modelRouteSnapshot: routeSnapshot(policyAReplacementId, HASH_C, 2, catalogAId),
        },
      }),
    ).rejects.toThrow();

    const attemptStartedId = randomUUID();
    const attemptTerminalId = randomUUID();
    const safetyDecisionId = randomUUID();
    const startedAt = new Date();
    const finishedAt = new Date(startedAt.getTime() + 25);
    await withActor(tenantAId, makerAId, async (transaction) => {
      await transaction.aiModelAttemptReceipt.create({
        data: {
          id: attemptStartedId,
          tenantId: tenantAId,
          runId: runAId,
          attemptNumber: 1,
          phase: 'STARTED',
          outcome: 'STARTED',
          catalogVersionId: catalogAId,
          routeKey: 'GENERAL_PRIMARY',
          provider: 'OPENAI_COMPATIBLE',
          modelName: 'enterprise-chat',
          retrySafe: false,
          startedAt,
          receiptHash: HASH_A,
        },
      });
      await transaction.aiModelAttemptReceipt.create({
        data: {
          id: attemptTerminalId,
          tenantId: tenantAId,
          runId: runAId,
          attemptNumber: 1,
          phase: 'TERMINAL',
          outcome: 'SUCCEEDED',
          catalogVersionId: catalogAId,
          routeKey: 'GENERAL_PRIMARY',
          provider: 'OPENAI_COMPATIBLE',
          modelName: 'enterprise-chat',
          retrySafe: false,
          startedAt,
          finishedAt,
          receiptHash: HASH_B,
        },
      });
      await transaction.aiSafetyDecisionRecord.create({
        data: {
          id: safetyDecisionId,
          tenantId: tenantAId,
          runId: runAId,
          direction: 'OUTPUT',
          sequence: 1,
          classification: 'INTERNAL',
          action: 'ALLOW',
          reasonCodes: ['NO_SENSITIVE_PATTERN_DETECTED'],
          contentSha256: HASH_A,
          redactedContentSha256: null,
          detectorVersion: 'integration-detector-v1',
          decisionHash: HASH_C,
        },
      });
    });

    await expect(
      administrator.aiModelAttemptReceipt.update({
        where: { id: attemptTerminalId },
        data: { reasonCode: 'TAMPERED' },
      }),
    ).rejects.toThrow();
    await expect(
      administrator.aiSafetyDecisionRecord.delete({ where: { id: safetyDecisionId } }),
    ).rejects.toThrow();
    const transitionCommand = await administrator.aiGovernanceCommand.findFirstOrThrow({
      where: { tenantId: tenantAId, idempotencyKey: retireIdempotencyKey },
    });
    await expect(
      administrator.aiGovernanceCommand.delete({ where: { id: transitionCommand.id } }),
    ).rejects.toThrow();
    await expect(
      withActor(tenantAId, makerAId, (transaction) =>
        transaction.aiModelAttemptReceipt.create({
          data: {
            tenantId: tenantAId,
            runId: runAId,
            attemptNumber: 1,
            phase: 'TERMINAL',
            outcome: 'SUCCEEDED',
            catalogVersionId: catalogAId,
            routeKey: 'GENERAL_PRIMARY',
            provider: 'OPENAI_COMPATIBLE',
            modelName: 'enterprise-chat',
            retrySafe: false,
            startedAt,
            finishedAt,
            receiptHash: HASH_C,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withActor(tenantBId, makerBId, (transaction) =>
        transaction.aiModelAttemptReceipt.create({
          data: {
            tenantId: tenantBId,
            runId: runAId,
            attemptNumber: 2,
            phase: 'TERMINAL',
            outcome: 'REJECTED',
            catalogVersionId: catalogBId,
            routeKey: 'GENERAL_PRIMARY',
            provider: 'OPENAI_COMPATIBLE',
            modelName: 'enterprise-chat',
            reasonCode: 'CROSS_TENANT',
            retrySafe: false,
            startedAt,
            finishedAt,
            receiptHash: HASH_C,
          },
        }),
      ),
    ).rejects.toThrow();

    const unsafeColumns = await administrator.$queryRaw<Array<{ columnName: string }>>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('ai_model_attempt_receipts', 'ai_safety_decisions')
        AND column_name IN (
          'raw_content',
          'content',
          'prompt',
          'response',
          'secret',
          'api_key',
          'credential'
        )
      ORDER BY column_name
    `;
    expect(unsafeColumns).toEqual([]);
    await expect(
      administrator.aiModelAttemptReceipt.count({ where: { tenantId: tenantAId, runId: runAId } }),
    ).resolves.toBe(2);
    await expect(
      administrator.aiSafetyDecisionRecord.count({
        where: { tenantId: tenantAId, runId: runAId },
      }),
    ).resolves.toBe(1);
  });

  it('registers only a strictly shaped controlled connectivity probe', async () => {
    const probePrompt =
      'Reply with exactly MODEL_CONNECTIVITY_OK. This is a controlled administrator connectivity test. Do not call tools.';
    const validConversationId = randomUUID();
    const validMessageId = randomUUID();
    const validRunId = randomUUID();
    const forgedConversationId = randomUUID();
    const forgedMessageId = randomUUID();
    const forgedRunId = randomUUID();

    await administrator.conversation.create({
      data: {
        id: validConversationId,
        tenantId: tenantAId,
        type: 'DIRECT',
        directKey: `model-connectivity-probe:${makerAId}:${agentAId}`,
        title: '[SYSTEM] Model connectivity probe',
        createdById: makerAId,
      },
    });
    await administrator.conversationParticipant.createMany({
      data: [
        {
          tenantId: tenantAId,
          conversationId: validConversationId,
          type: 'USER',
          participantKey: `user:${makerAId}`,
          userId: makerAId,
          displayName: 'AI routing maker A',
        },
        {
          tenantId: tenantAId,
          conversationId: validConversationId,
          type: 'AGENT',
          participantKey: `agent:${agentAId}`,
          agentId: agentAId,
          displayName: 'AI routing integration agent',
        },
      ],
    });
    await administrator.message.create({
      data: {
        id: validMessageId,
        tenantId: tenantAId,
        conversationId: validConversationId,
        senderType: 'USER',
        senderUserId: makerAId,
        senderKey: `user:${makerAId}`,
        senderName: 'AI routing maker A',
        clientMessageId: `model-connectivity-probe-message-${unique}`,
        content: { type: 'text', text: probePrompt },
      },
    });
    await administrator.agentRun.create({
      data: {
        id: validRunId,
        tenantId: tenantAId,
        conversationId: validConversationId,
        inputMessageId: validMessageId,
        requesterUserId: makerAId,
        agentId: agentAId,
        agentVersionId: agentVersionAId,
        idempotencyKey: `model-connectivity-probe:${randomUUID()}`,
        policySnapshot: {
          controlledModelConnectivityProbe: true,
          connectivityProbeCatalogVersionId: catalogAId,
        },
      },
    });

    await administrator.conversation.create({
      data: {
        id: forgedConversationId,
        tenantId: tenantAId,
        type: 'DIRECT',
        directKey: `ordinary-conversation-${unique}`,
        title: 'Ordinary conversation with a forged marker',
        createdById: makerAId,
      },
    });
    await administrator.conversationParticipant.createMany({
      data: [
        {
          tenantId: tenantAId,
          conversationId: forgedConversationId,
          type: 'USER',
          participantKey: `user:${makerAId}`,
          userId: makerAId,
          displayName: 'AI routing maker A',
        },
        {
          tenantId: tenantAId,
          conversationId: forgedConversationId,
          type: 'AGENT',
          participantKey: `agent:${agentAId}`,
          agentId: agentAId,
          displayName: 'AI routing integration agent',
        },
      ],
    });
    await administrator.message.create({
      data: {
        id: forgedMessageId,
        tenantId: tenantAId,
        conversationId: forgedConversationId,
        senderType: 'USER',
        senderUserId: makerAId,
        senderKey: `user:${makerAId}`,
        senderName: 'AI routing maker A',
        clientMessageId: `forged-model-connectivity-probe-message-${unique}`,
        content: { type: 'text', text: probePrompt },
      },
    });
    await administrator.agentRun.create({
      data: {
        id: forgedRunId,
        tenantId: tenantAId,
        conversationId: forgedConversationId,
        inputMessageId: forgedMessageId,
        requesterUserId: makerAId,
        agentId: agentAId,
        agentVersionId: agentVersionAId,
        idempotencyKey: `model-connectivity-probe:${randomUUID()}`,
        policySnapshot: {
          controlledModelConnectivityProbe: true,
          connectivityProbeCatalogVersionId: catalogAId,
        },
      },
    });

    await expect(
      registerConnectivityProbe({
        tenantId: tenantAId,
        runId: validRunId,
        catalogVersionId: catalogAId,
        userId: makerAId,
      }),
    ).resolves.toEqual(validRunId);
    await expect(
      registerConnectivityProbe({
        tenantId: tenantAId,
        runId: validRunId,
        catalogVersionId: catalogAId,
        userId: makerAId,
      }),
    ).resolves.toEqual(validRunId);
    await expect(
      administrator.aiModelConnectivityProbe.findFirst({
        where: { tenantId: tenantAId, runId: validRunId },
        select: {
          targetCatalogVersionId: true,
          requesterUserId: true,
          conversationId: true,
        },
      }),
    ).resolves.toEqual({
      targetCatalogVersionId: catalogAId,
      requesterUserId: makerAId,
      conversationId: validConversationId,
    });

    const ordinaryRun = await captureSqlError(() =>
      registerConnectivityProbe({
        tenantId: tenantAId,
        runId: runAId,
        catalogVersionId: catalogAId,
        userId: makerAId,
      }),
    );
    const forgedMarker = await captureSqlError(() =>
      registerConnectivityProbe({
        tenantId: tenantAId,
        runId: forgedRunId,
        catalogVersionId: catalogAId,
        userId: makerAId,
      }),
    );
    expect(ordinaryRun).toMatchObject({ prismaCode: 'P2010', sqlState: '23514' });
    expect(forgedMarker).toMatchObject({ prismaCode: 'P2010', sqlState: '23514' });
    expect(forgedMarker.databaseMessage).toContain(
      'model connectivity probe conversation provenance is invalid',
    );
    await expect(
      administrator.aiModelConnectivityProbe.count({
        where: { tenantId: tenantAId, runId: { in: [runAId, forgedRunId] } },
      }),
    ).resolves.toBe(0);
  });

  async function seedRunFixture(): Promise<void> {
    await administrator.agentTemplate.create({
      data: {
        id: templateAId,
        tenantId: tenantAId,
        key: `ai-routing-template-${unique}`,
        name: 'AI routing integration template',
      },
    });
    await administrator.agentVersion.create({
      data: {
        id: agentVersionAId,
        tenantId: tenantAId,
        templateId: templateAId,
        version: 1,
        status: 'PUBLISHED',
        systemPrompt: 'Answer with governed enterprise knowledge.',
        modelPolicy: {
          taskClass: 'GENERAL_QA',
          dataClassification: 'INTERNAL',
          requiredCapabilities: ['chat'],
        },
        toolPolicy: { allow: [] },
        knowledgeScope: { knowledgeBaseIds: [] },
        publishedAt: new Date(),
      },
    });
    await administrator.agentInstance.create({
      data: {
        id: agentAId,
        tenantId: tenantAId,
        key: `ai-routing-agent-${unique}`,
        versionId: agentVersionAId,
        ownerUserId: makerAId,
        createdById: makerAId,
        name: 'AI routing integration agent',
        status: 'ONLINE',
        settings: { visibility: 'tenant' },
      },
    });
    await administrator.conversation.create({
      data: {
        id: conversationAId,
        tenantId: tenantAId,
        directKey: `ai-routing-conversation-${unique}`,
        createdById: makerAId,
      },
    });
    await administrator.conversationParticipant.createMany({
      data: [
        {
          tenantId: tenantAId,
          conversationId: conversationAId,
          type: 'USER',
          participantKey: `user:${makerAId}`,
          userId: makerAId,
          displayName: 'AI routing maker A',
        },
        {
          tenantId: tenantAId,
          conversationId: conversationAId,
          type: 'AGENT',
          participantKey: `agent:${agentAId}`,
          agentId: agentAId,
          displayName: 'AI routing integration agent',
        },
      ],
    });
    await administrator.message.create({
      data: {
        id: inputMessageAId,
        tenantId: tenantAId,
        conversationId: conversationAId,
        senderType: 'USER',
        senderUserId: makerAId,
        senderKey: `user:${makerAId}`,
        senderName: 'AI routing maker A',
        clientMessageId: `ai-routing-input-${unique}`,
        content: { type: 'text', text: 'Summarize the governed policy.' },
      },
    });
    await administrator.agentRun.create({
      data: {
        id: runAId,
        tenantId: tenantAId,
        conversationId: conversationAId,
        inputMessageId: inputMessageAId,
        requesterUserId: makerAId,
        agentId: agentAId,
        agentVersionId: agentVersionAId,
        idempotencyKey: `ai-routing-run-${unique}`,
        policySnapshot: { schemaVersion: 1 },
      },
    });
  }

  function routingServiceFor(userId: string): AiSafetyModelRoutingService {
    const prisma = {
      withTenant: <T>(
        _tenantId: string,
        operation: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) => administrator.$transaction(operation),
    } as unknown as PrismaService;
    const access = {
      requireDirectoryWrite: () => ({
        tenantId: tenantAId,
        userId,
        role: 'ADMIN' as const,
      }),
    } as unknown as AdminAccessService;
    return new AiSafetyModelRoutingService(prisma, access);
  }

  function withActor<T>(
    tenantId: string,
    userId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return operation(transaction);
    });
  }

  function registerConnectivityProbe(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly catalogVersionId: string;
    readonly userId: string;
  }): Promise<string> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${input.userId}, true)`;
      const [registered] = await transaction.$queryRaw<Array<{ runId: string }>>`
        SELECT public.register_ai_model_connectivity_probe(
          ${input.tenantId}::uuid,
          ${input.runId}::uuid,
          ${input.catalogVersionId}::uuid,
          ${input.userId}::uuid
        )::text AS "runId"
      `;
      if (registered === undefined)
        throw new Error('Connectivity probe registration returned no row.');
      return registered.runId;
    });
  }

  async function captureSqlError(
    operation: () => Promise<unknown>,
  ): Promise<{ prismaCode: string; sqlState: string; databaseMessage: string }> {
    try {
      await operation();
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error)) throw error;
      const known = error as {
        readonly code: unknown;
        readonly meta?: { readonly code?: unknown; readonly message?: unknown };
      };
      return {
        prismaCode: String(known.code),
        sqlState: String(known.meta?.code),
        databaseMessage: String(known.meta?.message),
      };
    }
    throw new Error('Expected the database operation to be denied.');
  }
});

function catalogFixture(input: {
  id: string;
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  routeKey?: string;
  credentialReference?: string;
}): Prisma.AiModelCatalogVersionUncheckedCreateInput {
  return {
    id: input.id,
    tenantId: input.tenantId,
    routeKey: input.routeKey ?? 'GENERAL_PRIMARY',
    version: 1,
    provider: 'OPENAI_COMPATIBLE',
    modelName: 'enterprise-chat',
    credentialReference: input.credentialReference ?? 'vault://ai/providers/general',
    dataResidency: 'CN',
    maximumClassification: 'CONFIDENTIAL',
    capabilities: ['chat'],
    maxContextTokens: 128_000,
    maxOutputTokens: 4_000,
    inputCostMicrosPerMillion: 1_000n,
    outputCostMicrosPerMillion: 2_000n,
    p95LatencyMs: 5_000,
    configurationHash: HASH_A,
    createdByUserId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: HASH_B,
  };
}

function routeSnapshot(
  policyVersionId: string,
  policyHash: string,
  policyVersion: number,
  catalogVersionId: string,
) {
  return {
    schemaVersion: 1,
    policyVersionId,
    policyVersion,
    policyHash,
    taskClass: 'GENERAL_QA',
    maximumClassification: 'CONFIDENTIAL',
    requiredCapabilities: ['chat'],
    maximumAttempts: 1,
    circuitFailureThreshold: policyVersion === 1 ? 3 : 2,
    circuitOpenSeconds: policyVersion === 1 ? 60 : 120,
    candidates: [
      {
        ordinal: 1,
        catalogVersionId,
        routeKey: 'GENERAL_PRIMARY',
        provider: 'OPENAI_COMPATIBLE',
        model: 'enterprise-chat',
        credentialReference: 'vault://ai/providers/general',
      },
    ],
  };
}
