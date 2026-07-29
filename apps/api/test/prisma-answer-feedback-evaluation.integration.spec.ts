import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';

import { createTestApp } from '../src/testing/create-test-app.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantId = '00000000-0000-7000-8000-00000000f101';
const otherTenantId = '00000000-0000-7000-8000-00000000f102';
const reporterId = '00000000-0000-7000-8000-00000000f201';
const otherUserId = '00000000-0000-7000-8000-00000000f202';
const sameTenantOtherUserId = '00000000-0000-7000-8000-00000000f203';
const conversationId = '00000000-0000-7000-8000-00000000f301';
const inputMessageId = '00000000-0000-7000-8000-00000000f401';
const outputMessageId = '00000000-0000-7000-8000-00000000f402';
const agentTemplateId = '00000000-0000-7000-8000-00000000f501';
const agentVersionId = '00000000-0000-7000-8000-00000000f502';
const agentId = '00000000-0000-7000-8000-00000000f503';
const agentRunId = '00000000-0000-7000-8000-00000000f504';
const knowledgeBaseId = '00000000-0000-7000-8000-00000000f601';
const documentId = '00000000-0000-7000-8000-00000000f602';
const documentVersionId = '00000000-0000-7000-8000-00000000f603';
const chunkId = '00000000-0000-7000-8000-00000000f604';
const inputPrompt = 'Contact employee@example.com with api_token=super-secret-token-value-123456.';
const outputAnswer = 'The approved policy applies. [来源1]';
const canonicalCitations = [
  {
    knowledgeBaseId,
    documentId,
    documentVersionId,
    chunkId,
  },
];

describe.runIf(enabled)('PostgreSQL answer feedback to Evaluation Bad Case projection', () => {
  const administrator = new PrismaClient();
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    await cleanup();
    await seedEligibleAnswer();
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanup();
    await administrator.$disconnect();
  });

  it('atomically and idempotently captures a NOT_HELPFUL answer with exact immutable lineage', async () => {
    const body = {
      rating: 'NOT_HELPFUL',
      reason: 'IRRELEVANT_CITATION',
      comment: '引用不相关；内部评论 secret-comment-must-not-leak。',
    };
    const first = await request(app.getHttpServer())
      .put(`/api/v1/messages/${outputMessageId}/feedback`)
      .set(identityHeaders(tenantId, reporterId))
      .send(body)
      .expect(200);

    const badCases = await administrator.$queryRaw<
      Array<{
        id: string;
        source_id: string;
        source_version: number;
        category: string;
        sanitized_input: string;
        source_snapshot_hash: string;
        reported_by_user_id: string;
      }>
    >`
      SELECT
        "id", "source_id", "source_version", "category"::text,
        "sanitized_input", "source_snapshot_hash", "reported_by_user_id"
      FROM public."ai_evaluation_bad_cases"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "source_type" = 'ANSWER_FEEDBACK'
    `;
    expect(badCases).toHaveLength(1);
    expect(badCases[0]).toMatchObject({
      source_id: first.body.id,
      source_version: 1,
      category: 'CITATION',
      reported_by_user_id: reporterId,
    });
    expect(badCases[0]!.source_snapshot_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(badCases[0]!.sanitized_input).toContain('[REDACTED_EMAIL]');
    expect(badCases[0]!.sanitized_input).toContain('[REDACTED_SECRET]');
    expect(badCases[0]!.sanitized_input).not.toContain('employee@example.com');
    expect(badCases[0]!.sanitized_input).not.toContain('super-secret-token');
    expect(badCases[0]!.sanitized_input).not.toContain('secret-comment-must-not-leak');

    const sources = await administrator.$queryRaw<
      Array<{
        bad_case_id: string;
        feedback_id: string;
        conversation_id: string;
        message_id: string;
        input_message_id: string;
        agent_run_id: string;
        agent_id: string;
        agent_version_id: string;
        reported_by_user_id: string;
        feedback_reason: string;
        feedback_recorded_at: Date;
        prompt_snapshot_hash: string;
        answer_snapshot_hash: string;
        citations_snapshot_hash: string;
        citations: unknown;
        source_snapshot_hash: string;
      }>
    >`
      SELECT
        "bad_case_id", "feedback_id", "conversation_id", "message_id",
        "input_message_id", "agent_run_id", "agent_id", "agent_version_id",
        "reported_by_user_id", "feedback_reason"::text, "feedback_recorded_at",
        "prompt_snapshot_hash", "answer_snapshot_hash",
        "citations_snapshot_hash", "citations", "source_snapshot_hash"
      FROM public."ai_evaluation_answer_feedback_sources"
      WHERE "tenant_id" = ${tenantId}::uuid
    `;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      bad_case_id: badCases[0]!.id,
      feedback_id: first.body.id,
      conversation_id: conversationId,
      message_id: outputMessageId,
      input_message_id: inputMessageId,
      agent_run_id: agentRunId,
      agent_id: agentId,
      agent_version_id: agentVersionId,
      reported_by_user_id: reporterId,
      feedback_reason: 'IRRELEVANT_CITATION',
      source_snapshot_hash: badCases[0]!.source_snapshot_hash,
      citations: [
        {
          knowledgeBaseId,
          documentId,
          documentVersionId,
          chunkId,
        },
      ],
    });
    const expectedPromptHash = sha256(inputPrompt);
    const expectedAnswerHash = sha256(outputAnswer);
    const [expectedCitationHash] = await administrator.$queryRaw<Array<{ hash: string }>>`
      SELECT encode(
        digest(
          convert_to(${JSON.stringify(canonicalCitations)}::jsonb::text, 'UTF8'),
          'sha256'
        ),
        'hex'
      ) AS hash
    `;
    expect(sources[0]!.prompt_snapshot_hash).toBe(expectedPromptHash);
    expect(sources[0]!.answer_snapshot_hash).toBe(expectedAnswerHash);
    expect(sources[0]!.citations_snapshot_hash).toBe(expectedCitationHash!.hash);

    const [expectedSourceHash] = await administrator.$queryRaw<Array<{ hash: string }>>`
      SELECT encode(
        digest(
          convert_to(
            jsonb_build_object(
              'tenantId', feedback."tenant_id",
              'feedbackId', feedback."id",
              'feedbackReason', feedback."reason",
              'feedbackCommentHash', encode(
                digest(
                  convert_to(COALESCE(feedback."comment", ''), 'UTF8'),
                  'sha256'
                ),
                'hex'
              ),
              'feedbackRecordedAt', feedback."updated_at",
              'conversationId', output_message."conversation_id",
              'messageId', output_message."id",
              'inputMessageId', input_message."id",
              'agentRunId', run."id",
              'agentId', run."agent_id",
              'agentVersionId', run."agent_version_id",
              'promptSnapshotHash', ${expectedPromptHash},
              'answerSnapshotHash', ${expectedAnswerHash},
              'citationsSnapshotHash', ${expectedCitationHash!.hash}
            )::text,
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS hash
      FROM public."answer_feedbacks" feedback
      JOIN public."messages" output_message
        ON output_message."tenant_id" = feedback."tenant_id"
       AND output_message."id" = feedback."message_id"
      JOIN public."agent_runs" run
        ON run."tenant_id" = feedback."tenant_id"
       AND run."output_message_id" = output_message."id"
      JOIN public."messages" input_message
        ON input_message."tenant_id" = run."tenant_id"
       AND input_message."id" = run."input_message_id"
      WHERE feedback."tenant_id" = ${tenantId}::uuid
        AND feedback."id" = ${first.body.id}::uuid
    `;
    expect(sources[0]!.source_snapshot_hash).toBe(expectedSourceHash!.hash);

    const second = await request(app.getHttpServer())
      .put(`/api/v1/messages/${outputMessageId}/feedback`)
      .set(identityHeaders(tenantId, reporterId))
      .send(body)
      .expect(200);
    expect(second.body.id).toBe(first.body.id);

    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId,
          action: 'ai.evaluation.bad_cases.insert',
          resourceId: badCases[0]!.id,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      administrator.outboxEvent.count({
        where: {
          tenantId,
          aggregateType: 'AI_EVALUATION',
          aggregateId: badCases[0]!.id,
          eventType: 'AiEvaluationBadCaseChanged',
        },
      }),
    ).resolves.toBe(1);
  });

  it('rejects cross-tenant rating and a forged same-tenant projection actor', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/messages/${outputMessageId}/feedback`)
      .set(identityHeaders(otherTenantId, otherUserId))
      .send({
        rating: 'NOT_HELPFUL',
        reason: 'INCORRECT',
        comment: null,
      })
      .expect(404);

    const feedback = await administrator.answerFeedback.findFirstOrThrow({
      where: { tenantId, messageId: outputMessageId, userId: reporterId },
    });
    const forged = await captureDatabaseError(() =>
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$queryRaw`
          SELECT set_config('app.user_id', ${sameTenantOtherUserId}, true)
        `;
        await transaction.$queryRaw`
          SELECT *
          FROM public.project_not_helpful_answer_feedback_bad_case(
            ${feedback.id}::uuid
          )
        `;
      }),
    );
    expect(forged.sqlState).toBe('42501');
  });

  it('keeps the source snapshot hidden from the employee role and rejects manual forged pairs', async () => {
    const appRead = await captureDatabaseError(() =>
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$queryRaw`
          SELECT *
          FROM public."ai_evaluation_answer_feedback_sources"
        `;
      }),
    );
    expect(appRead.sqlState).toBe('42501');

    const forgedId = '00000000-0000-7000-8000-00000000f701';
    const forged = await captureDatabaseError(() =>
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$queryRaw`SELECT set_config('app.user_id', ${reporterId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."ai_evaluation_bad_cases" (
            "id", "tenant_id", "source_type", "source_id", "source_version",
            "category", "sanitized_input", "source_snapshot_hash",
            "reported_by_user_id", "idempotency_key", "request_hash"
          ) VALUES (
            ${forgedId}::uuid, ${tenantId}::uuid, 'ANSWER_FEEDBACK',
            ${inputMessageId}::uuid, 1, 'FACTUALITY',
            'forged', ${'f'.repeat(64)}, ${reporterId}::uuid,
            'forged-answer-feedback-pair', ${'f'.repeat(64)}
          )
        `;
        // Force the deferred invariant while still inside Prisma's callback.
        // Otherwise libquery reports a commit-time trigger failure as an
        // UnknownRequestError and hides PostgreSQL's SQLSTATE metadata.
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "ai_evaluation_answer_feedback_pair_required" IMMEDIATE',
        );
      }),
    );
    expect(forged.sqlState).toBe('23514');
    expect(forged.message).toContain(
      'An ANSWER_FEEDBACK Bad Case requires a trusted source projection.',
    );
  });

  it('recomputes source hashes at the database boundary and rejects a forged ledger insert', async () => {
    const [source] = await administrator.$queryRaw<
      Array<{
        feedback_id: string;
        conversation_id: string;
        message_id: string;
        input_message_id: string;
        agent_run_id: string;
        agent_id: string;
        agent_version_id: string;
        reported_by_user_id: string;
        feedback_reason: string;
        feedback_recorded_at: Date;
        prompt_snapshot_hash: string;
        answer_snapshot_hash: string;
        citations_snapshot_hash: string;
        citations: unknown;
        source_snapshot_hash: string;
      }>
    >`
      SELECT
        source."feedback_id", source."conversation_id", source."message_id",
        source."input_message_id", source."agent_run_id", source."agent_id",
        source."agent_version_id", source."reported_by_user_id",
        source."feedback_reason"::text,
        feedback."updated_at" AS "feedback_recorded_at",
        source."prompt_snapshot_hash", source."answer_snapshot_hash",
        source."citations_snapshot_hash", source."citations",
        source."source_snapshot_hash"
      FROM public."ai_evaluation_answer_feedback_sources" source
      JOIN public."answer_feedbacks" feedback
        ON feedback."tenant_id" = source."tenant_id"
       AND feedback."id" = source."feedback_id"
      WHERE source."tenant_id" = ${tenantId}::uuid
    `;
    expect(source).toBeDefined();

    const forged = await captureDatabaseError(() =>
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_feedback_projector');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$queryRaw`SELECT set_config('app.user_id', ${reporterId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."ai_evaluation_answer_feedback_sources" (
            "tenant_id", "bad_case_id", "feedback_id", "conversation_id",
            "message_id", "input_message_id", "agent_run_id", "agent_id",
            "agent_version_id", "reported_by_user_id", "feedback_reason",
            "feedback_recorded_at", "prompt_snapshot_hash",
            "answer_snapshot_hash", "citations_snapshot_hash",
            "citations", "source_snapshot_hash"
          ) VALUES (
            ${tenantId}::uuid,
            ${'00000000-0000-7000-8000-00000000f702'}::uuid,
            ${source!.feedback_id}::uuid,
            ${source!.conversation_id}::uuid,
            ${source!.message_id}::uuid,
            ${source!.input_message_id}::uuid,
            ${source!.agent_run_id}::uuid,
            ${source!.agent_id}::uuid,
            ${source!.agent_version_id}::uuid,
            ${source!.reported_by_user_id}::uuid,
            ${source!.feedback_reason}::public."AnswerFeedbackReason",
            ${source!.feedback_recorded_at},
            ${'f'.repeat(64)},
            ${source!.answer_snapshot_hash},
            ${source!.citations_snapshot_hash},
            ${JSON.stringify(source!.citations)}::jsonb,
            ${source!.source_snapshot_hash}
          )
        `;
      }),
    );
    expect(forged.sqlState).toBe('23514');
    expect(forged.message).toContain(
      'Answer-feedback snapshot hashes must be recomputed from primary records.',
    );
  });

  it('exposes only append/read ACLs and keeps internal SECURITY DEFINER helpers closed', async () => {
    const tablePrivileges = await administrator.$queryRaw<
      Array<{ roleName: string; privileges: string[] }>
    >`
      SELECT
        grantee AS "roleName",
        array_agg(privilege_type ORDER BY privilege_type)::text[] AS privileges
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = 'ai_evaluation_answer_feedback_sources'
        AND grantee IN (
          'enterprise_agent_admin',
          'enterprise_agent_feedback_projector'
        )
      GROUP BY grantee
      ORDER BY grantee
    `;
    expect(tablePrivileges).toEqual([
      {
        roleName: 'enterprise_agent_admin',
        privileges: ['SELECT'],
      },
      {
        roleName: 'enterprise_agent_feedback_projector',
        privileges: ['INSERT', 'SELECT'],
      },
    ]);

    for (const roleName of ['enterprise_agent_admin', 'enterprise_agent_feedback_projector']) {
      for (const mutation of ['UPDATE', 'DELETE'] as const) {
        const denied = await captureDatabaseError(() =>
          administrator.$transaction(async (transaction) => {
            await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${roleName}`);
            await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            if (mutation === 'UPDATE') {
              await transaction.$executeRaw`
                UPDATE public."ai_evaluation_answer_feedback_sources"
                SET "created_at" = "created_at"
                WHERE "tenant_id" = ${tenantId}::uuid
              `;
            } else {
              await transaction.$executeRaw`
                DELETE FROM public."ai_evaluation_answer_feedback_sources"
                WHERE "tenant_id" = ${tenantId}::uuid
              `;
            }
          }),
        );
        expect(denied.sqlState).toBe('42501');
      }
    }

    const functionAcl = await administrator.$queryRaw<
      Array<{
        functionName: string;
        ownerName: string;
        appCanExecute: boolean;
        adminCanExecute: boolean;
        publicCanExecute: boolean;
      }>
    >`
      SELECT
        procedure.proname AS "functionName",
        owner.rolname AS "ownerName",
        has_function_privilege(
          'enterprise_agent_app',
          procedure.oid,
          'EXECUTE'
        ) AS "appCanExecute",
        has_function_privilege(
          'enterprise_agent_admin',
          procedure.oid,
          'EXECUTE'
        ) AS "adminCanExecute",
        EXISTS (
          SELECT 1
          FROM aclexplode(
            COALESCE(
              procedure.proacl,
              acldefault('f', procedure.proowner)
            )
          ) privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS "publicCanExecute"
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_roles owner
        ON owner.oid = procedure.proowner
      WHERE procedure.oid IN (
        'public.ai_evaluation_sanitize_feedback_input(text)'::regprocedure,
        'public.ai_evaluation_derive_answer_feedback_source(uuid,uuid,uuid)'::regprocedure,
        'public.ai_evaluation_answer_feedback_source_guard()'::regprocedure,
        'public.ai_evaluation_answer_feedback_pair_guard()'::regprocedure,
        'public.project_not_helpful_answer_feedback_bad_case(uuid)'::regprocedure
      )
      ORDER BY procedure.proname
    `;
    expect(functionAcl).toEqual([
      {
        functionName: 'ai_evaluation_answer_feedback_pair_guard',
        ownerName: 'enterprise_agent_feedback_projector',
        appCanExecute: false,
        adminCanExecute: false,
        publicCanExecute: false,
      },
      {
        functionName: 'ai_evaluation_answer_feedback_source_guard',
        ownerName: 'enterprise_agent_feedback_projector',
        appCanExecute: false,
        adminCanExecute: false,
        publicCanExecute: false,
      },
      {
        functionName: 'ai_evaluation_derive_answer_feedback_source',
        ownerName: 'enterprise_agent_feedback_projector',
        appCanExecute: false,
        adminCanExecute: false,
        publicCanExecute: false,
      },
      {
        functionName: 'ai_evaluation_sanitize_feedback_input',
        ownerName: 'enterprise_agent_feedback_projector',
        appCanExecute: false,
        adminCanExecute: false,
        publicCanExecute: false,
      },
      {
        functionName: 'project_not_helpful_answer_feedback_bad_case',
        ownerName: 'enterprise_agent_feedback_projector',
        appCanExecute: true,
        adminCanExecute: true,
        publicCanExecute: false,
      },
    ]);

    for (const roleName of ['enterprise_agent_app', 'enterprise_agent_admin']) {
      const denied = await captureDatabaseError(() =>
        administrator.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${roleName}`);
          await transaction.$queryRaw`
            SELECT public.ai_evaluation_derive_answer_feedback_source(
              ${tenantId}::uuid,
              (
                SELECT "feedback_id"
                FROM public."ai_evaluation_answer_feedback_sources"
                WHERE "tenant_id" = ${tenantId}::uuid
              ),
              ${reporterId}::uuid
            )
          `;
        }),
      );
      expect(denied.sqlState).toBe('42501');
    }
  });

  async function seedEligibleAnswer(): Promise<void> {
    await administrator.tenant.create({
      data: {
        id: tenantId,
        slug: 'feedback-evaluation-integration',
        name: 'Feedback Evaluation Integration',
        users: {
          create: [
            {
              id: reporterId,
              email: 'feedback-reporter@integration.invalid',
              emailNormalized: 'feedback-reporter@integration.invalid',
              displayName: 'Feedback Reporter',
              status: 'ACTIVE',
            },
            {
              id: sameTenantOtherUserId,
              email: 'feedback-other@integration.invalid',
              emailNormalized: 'feedback-other@integration.invalid',
              displayName: 'Other Tenant User',
              status: 'ACTIVE',
            },
          ],
        },
      },
    });
    await administrator.tenant.create({
      data: {
        id: otherTenantId,
        slug: 'feedback-evaluation-other',
        name: 'Feedback Evaluation Other',
        users: {
          create: {
            id: otherUserId,
            email: 'feedback-cross@integration.invalid',
            emailNormalized: 'feedback-cross@integration.invalid',
            displayName: 'Cross Tenant User',
            status: 'ACTIVE',
          },
        },
      },
    });
    await administrator.agentTemplate.create({
      data: {
        id: agentTemplateId,
        tenantId,
        key: 'feedback-evaluation-agent',
        name: 'Feedback Evaluation Agent',
      },
    });
    await administrator.agentVersion.create({
      data: {
        id: agentVersionId,
        tenantId,
        templateId: agentTemplateId,
        version: 1,
        status: 'DRAFT',
        systemPrompt: 'Answer with governed enterprise knowledge.',
        modelPolicy: {},
        toolPolicy: { allow: [] },
        knowledgeScope: { ids: [knowledgeBaseId] },
        createdById: reporterId,
      },
    });
    await administrator.agentInstance.create({
      data: {
        id: agentId,
        tenantId,
        key: 'feedback-evaluation-agent',
        versionId: agentVersionId,
        ownerUserId: reporterId,
        createdById: reporterId,
        name: 'Feedback Evaluation Agent',
        status: 'ONLINE',
        settings: { visibility: 'tenant' },
      },
    });
    await administrator.knowledgeBase.create({
      data: {
        id: knowledgeBaseId,
        tenantId,
        key: 'feedback-evaluation-knowledge',
        name: 'Feedback Evaluation Knowledge',
        status: 'ACTIVE',
        createdById: reporterId,
      },
    });
    await administrator.knowledgeDocument.create({
      data: {
        id: documentId,
        tenantId,
        knowledgeBaseId,
        title: 'Approved policy',
        sourceType: 'TEXT',
        contentText: 'The approved policy applies.',
        status: 'READY',
        documentVersion: 1,
        createdById: reporterId,
      },
    });
    await administrator.knowledgeDocumentVersion.create({
      data: {
        id: documentVersionId,
        tenantId,
        knowledgeBaseId,
        documentId,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'The approved policy applies.',
        checksum: 'a'.repeat(64),
        status: 'READY',
        governanceOwnerUserId: reporterId,
        createdById: reporterId,
      },
    });
    await administrator.knowledgeDocument.update({
      where: { id: documentId },
      data: { currentVersionId: documentVersionId },
    });
    await administrator.knowledgeChunk.create({
      data: {
        id: chunkId,
        tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
        chunkIndex: 0,
        content: 'The approved policy applies.',
        tokenCount: 5,
        contentHash: 'b'.repeat(64),
      },
    });
    await administrator.conversation.create({
      data: {
        id: conversationId,
        tenantId,
        directKey: 'feedback-evaluation-conversation',
        createdById: reporterId,
      },
    });
    await administrator.conversationParticipant.createMany({
      data: [
        {
          tenantId,
          conversationId,
          type: 'USER',
          participantKey: `user:${reporterId}`,
          userId: reporterId,
          displayName: 'Feedback Reporter',
        },
        {
          tenantId,
          conversationId,
          type: 'AGENT',
          participantKey: `agent:${agentId}`,
          agentId,
          displayName: 'Feedback Evaluation Agent',
        },
      ],
    });
    await administrator.message.createMany({
      data: [
        {
          id: inputMessageId,
          tenantId,
          conversationId,
          senderType: 'USER',
          senderUserId: reporterId,
          senderKey: `user:${reporterId}`,
          senderName: 'Feedback Reporter',
          clientMessageId: 'feedback-evaluation-input',
          contentType: 'TEXT',
          content: {
            type: 'text',
            text: inputPrompt,
          },
        },
        {
          id: outputMessageId,
          tenantId,
          conversationId,
          senderType: 'AGENT',
          senderAgentId: agentId,
          senderKey: `agent:${agentId}`,
          senderName: 'Feedback Evaluation Agent',
          clientMessageId: `agent-run:${agentRunId}`,
          contentType: 'TEXT',
          content: {
            type: 'text',
            text: outputAnswer,
            citations: [
              {
                knowledgeBaseId,
                knowledgeBaseName: 'Feedback Evaluation Knowledge',
                documentId,
                documentVersionId,
                chunkId,
                title: 'Approved policy',
                documentVersion: 1,
                headingPath: [],
                sourceType: 'TEXT',
                excerpt: 'The approved policy applies.',
                updatedAt: '2026-07-28T00:00:00.000Z',
              },
            ],
          },
        },
      ],
    });
    await administrator.agentRun.create({
      data: {
        id: agentRunId,
        tenantId,
        conversationId,
        inputMessageId,
        outputMessageId,
        requesterUserId: reporterId,
        agentId,
        agentVersionId,
        status: 'SUCCEEDED',
        idempotencyKey: 'feedback-evaluation-agent-run',
        policySnapshot: { test: true },
        finishedAt: new Date(),
      },
    });
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantId, otherTenantId]);
  }
});

function identityHeaders(contextTenantId: string, userId: string): Record<string, string> {
  return {
    'x-tenant-id': contextTenantId,
    'x-user-id': userId,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function captureDatabaseError(
  operation: () => Promise<unknown>,
): Promise<{ sqlState: string | undefined; message: string }> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const metadata = error.meta as { code?: unknown; message?: unknown } | undefined;
      return {
        sqlState: typeof metadata?.code === 'string' ? metadata.code : undefined,
        message: String(metadata?.message ?? error.message),
      };
    }
    throw error;
  }
  throw new Error('Expected the database operation to fail.');
}
