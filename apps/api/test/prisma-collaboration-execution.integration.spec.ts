import type { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';

import {
  parseAgentRunMemoryContextSnapshot,
  PrismaAgentRunRepository,
} from '../src/modules/agent-run/infrastructure/prisma/prisma-agent-run.repository.js';
import { KnowledgeRetrievalService } from '../src/modules/knowledge-retrieval/knowledge-retrieval.service.js';
import { createTestApp } from '../src/testing/create-test-app.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';

const tenantA = '10000000-0000-7000-8000-000000000001';
const tenantB = '10000000-0000-7000-8000-000000000002';
const organizationA = '10000000-0000-7000-8000-000000000011';
const organizationB = '10000000-0000-7000-8000-000000000012';
const orgUnitA = '10000000-0000-7000-8000-000000000021';
const orgUnitB = '10000000-0000-7000-8000-000000000022';

const requesterUser = '10000000-0000-7000-8000-000000000101';
const recipientUser = '10000000-0000-7000-8000-000000000102';
const nonParticipantUser = '10000000-0000-7000-8000-000000000103';
const unauthorizedUser = '10000000-0000-7000-8000-000000000104';
const crossTenantUser = '10000000-0000-7000-8000-000000000105';
const crossTenantReviewer = '10000000-0000-7000-8000-000000000106';
const replayAdministrator = '10000000-0000-7000-8000-000000000107';

const requesterEmployment = '10000000-0000-7000-8000-000000000201';
const recipientEmployment = '10000000-0000-7000-8000-000000000202';
const nonParticipantEmployment = '10000000-0000-7000-8000-000000000203';
const unauthorizedEmployment = '10000000-0000-7000-8000-000000000204';
const crossTenantEmployment = '10000000-0000-7000-8000-000000000205';

const authorizedTemplate = '10000000-0000-7000-8000-000000000301';
const unauthorizedTemplate = '10000000-0000-7000-8000-000000000302';
const crossTenantTemplate = '10000000-0000-7000-8000-000000000303';
const authorizedVersion = '10000000-0000-7000-8000-000000000311';
const unauthorizedVersion = '10000000-0000-7000-8000-000000000312';
const crossTenantVersion = '10000000-0000-7000-8000-000000000313';

const requesterAgent = '10000000-0000-7000-8000-000000000401';
const recipientAgent = '10000000-0000-7000-8000-000000000402';
const nonParticipantAgent = '10000000-0000-7000-8000-000000000403';
const unauthorizedAgent = '10000000-0000-7000-8000-000000000404';
const crossTenantAgent = '10000000-0000-7000-8000-000000000405';
const revokedMemoryAgent = '10000000-0000-7000-8000-000000000406';

const requesterAssignment = '10000000-0000-7000-8000-000000000501';
const recipientAssignment = '10000000-0000-7000-8000-000000000502';
const nonParticipantAssignment = '10000000-0000-7000-8000-000000000503';
const unauthorizedAssignment = '10000000-0000-7000-8000-000000000504';
const crossTenantAssignment = '10000000-0000-7000-8000-000000000505';
const revokedMemoryAssignment = '10000000-0000-7000-8000-000000000506';

const valueDefinition = '10000000-0000-7000-8000-000000000601';
const valueVersion = '10000000-0000-7000-8000-000000000602';
const metricDefinition = '10000000-0000-7000-8000-000000000603';
const valueMetric = '10000000-0000-7000-8000-000000000604';
const strategy = '10000000-0000-7000-8000-000000000605';
const objective = '10000000-0000-7000-8000-000000000606';
const processDefinition = '10000000-0000-7000-8000-000000000607';
const processVersion = '10000000-0000-7000-8000-000000000608';
const processStartNode = '10000000-0000-7000-8000-000000000609';
const processActivityNode = '10000000-0000-7000-8000-000000000610';
const processEndNode = '10000000-0000-7000-8000-000000000611';
const taskId = '10000000-0000-7000-8000-000000000612';
const processStartEdge = '10000000-0000-7000-8000-000000000613';
const processEndEdge = '10000000-0000-7000-8000-000000000614';
const modelCatalogVersion = '10000000-0000-7000-8000-000000000701';
const modelRoutePolicyVersion = '10000000-0000-7000-8000-000000000702';

const permissionLabels = ['classification:internal'] as const;
const farFuture = '2099-07-29T05:00:00.000Z';

describe.runIf(enabled)('PostgreSQL structured Collaboration execution', () => {
  const administrator = new PrismaClient();
  let app: INestApplication;
  let runs: PrismaAgentRunRepository;
  let retrieval: KnowledgeRetrievalService;
  let collaborationId: string;
  let memoryConversationId: string;
  let memoryRunId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    await cleanup();
    await seedFixtures();
    app = await createTestApp({
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
    retrieval = app.get(KnowledgeRetrievalService);
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanup();
    await administrator.$disconnect();
  });

  it('keeps the lock-capable trusted resolver tenant-bound and process-only', async () => {
    const [resolver] = await administrator.$queryRaw<
      Array<{
        securityDefiner: boolean;
        owner: string;
        sessionUser: string;
        settings: string[] | null;
        publicExecute: boolean;
        appExecute: boolean;
        processExecute: boolean;
      }>
    >`
      SELECT
        procedure.prosecdef AS "securityDefiner",
        owner.rolname AS "owner",
        current_user AS "sessionUser",
        procedure.proconfig::text[] AS "settings",
        has_function_privilege(
          'public',
          procedure.oid,
          'EXECUTE'
        ) AS "publicExecute",
        has_function_privilege(
          'enterprise_agent_app',
          procedure.oid,
          'EXECUTE'
        ) AS "appExecute",
        has_function_privilege(
          'enterprise_agent_process',
          procedure.oid,
          'EXECUTE'
        ) AS "processExecute"
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_roles owner
        ON owner.oid = procedure.proowner
      WHERE namespace.nspname = 'public'
        AND procedure.proname = 'build_trusted_assignment_snapshot'
        AND pg_get_function_identity_arguments(procedure.oid) =
          'p_tenant_id uuid, p_role_assignment_id uuid, p_permission_labels jsonb, p_effective_at timestamp with time zone, p_task_id uuid, p_required_action text'
    `;

    expect(resolver).toMatchObject({
      securityDefiner: true,
      publicExecute: false,
      appExecute: false,
      processExecute: true,
    });
    expect(resolver?.owner).toBe(resolver?.sessionUser);
    expect(resolver?.settings).toContain('search_path=pg_catalog, public');

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_process');
        await transaction.$executeRaw`
          SELECT set_config('app.tenant_id', ${tenantA}, true)
        `;
        await transaction.$queryRaw`
          SELECT public.build_trusted_assignment_snapshot(
            ${tenantB}::uuid,
            ${crossTenantAssignment}::uuid,
            '[]'::jsonb,
            CURRENT_TIMESTAMP,
            NULL::uuid,
            NULL::text
          )
        `;
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({ code: '42501' }),
    });
  });

  it('installs the deployed collaboration compatibility guards as live catalog boundaries', async () => {
    const [boundary] = await administrator.$queryRaw<
      Array<{
        userIdentityUnique: boolean;
        agentIdentityUnique: boolean;
        reviewerLivenessTrigger: boolean;
        replayAttributionTrigger: boolean;
        legacyReviewFallback: boolean;
      }>
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_index index_definition
          JOIN pg_class index_relation
            ON index_relation.oid = index_definition.indexrelid
          WHERE index_relation.relnamespace = 'public'::regnamespace
            AND index_relation.relname = 'collaboration_participants_active_user_key'
            AND index_definition.indrelid =
              'public.collaboration_participants'::regclass
            AND index_definition.indisunique
            AND index_definition.indisvalid
            AND pg_get_indexdef(index_definition.indexrelid, 1, true) = 'tenant_id'
            AND pg_get_indexdef(index_definition.indexrelid, 2, true) = 'collaboration_id'
            AND pg_get_indexdef(index_definition.indexrelid, 3, true) = 'user_id'
            AND pg_get_expr(
              index_definition.indpred,
              index_definition.indrelid,
              true
            ) = 'active'
        ) AS "userIdentityUnique",
        EXISTS (
          SELECT 1
          FROM pg_index index_definition
          JOIN pg_class index_relation
            ON index_relation.oid = index_definition.indexrelid
          WHERE index_relation.relnamespace = 'public'::regnamespace
            AND index_relation.relname = 'collaboration_participants_active_agent_key'
            AND index_definition.indrelid =
              'public.collaboration_participants'::regclass
            AND index_definition.indisunique
            AND index_definition.indisvalid
            AND pg_get_indexdef(index_definition.indexrelid, 1, true) = 'tenant_id'
            AND pg_get_indexdef(index_definition.indexrelid, 2, true) = 'collaboration_id'
            AND pg_get_indexdef(index_definition.indexrelid, 3, true) = 'agent_id'
            AND pg_get_expr(
              index_definition.indpred,
              index_definition.indrelid,
              true
            ) = 'active AND agent_id IS NOT NULL'
        ) AS "agentIdentityUnique",
        EXISTS (
          SELECT 1
          FROM pg_trigger trigger_definition
          WHERE trigger_definition.tgrelid = 'public.correction_cases'::regclass
            AND trigger_definition.tgname =
              'correction_cases_reviewer_liveness_trigger'
            AND trigger_definition.tgenabled = 'O'
            AND NOT trigger_definition.tgisinternal
        ) AS "reviewerLivenessTrigger",
        EXISTS (
          SELECT 1
          FROM pg_trigger trigger_definition
          WHERE trigger_definition.tgrelid =
              'public.business_event_deliveries'::regclass
            AND trigger_definition.tgname =
              'business_event_deliveries_replay_attribution_v2_trigger'
            AND trigger_definition.tgenabled = 'O'
            AND NOT trigger_definition.tgisinternal
        ) AS "replayAttributionTrigger",
        POSITION(
          'legacy_independent_reviewer'
          IN pg_get_functiondef(
            'public.guard_correction_feedback_insert()'::regprocedure
          )
        ) > 0 AS "legacyReviewFallback"
    `;
    expect(boundary).toEqual({
      userIdentityUnique: true,
      agentIdentityUnique: true,
      reviewerLivenessTrigger: true,
      replayAttributionTrigger: true,
      legacyReviewFallback: true,
    });
  });

  it('fails closed when task, action, or organization assignment scope is missing', async () => {
    const invalidScopeMutations = [
      Prisma.sql`
        UPDATE public."role_assignments"
        SET "organization_scope" = '{}'::jsonb
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${requesterAssignment}::uuid
      `,
      Prisma.sql`
        UPDATE public."role_assignments"
        SET "permission_scope" = "permission_scope" - 'taskIds'
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${requesterAssignment}::uuid
      `,
      Prisma.sql`
        UPDATE public."role_assignments"
        SET "permission_scope" = "permission_scope" - 'actions'
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${requesterAssignment}::uuid
      `,
    ];

    for (const invalidScopeMutation of invalidScopeMutations) {
      await expect(
        administrator.$transaction(async (transaction) => {
          await transaction.$executeRaw(invalidScopeMutation);
          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_process');
          await transaction.$executeRaw`
            SELECT set_config('app.tenant_id', ${tenantA}, true)
          `;
          await transaction.$queryRaw`
            SELECT public.build_trusted_assignment_snapshot(
              ${tenantA}::uuid,
              ${requesterAssignment}::uuid,
              ${JSON.stringify(permissionLabels)}::jsonb,
              CURRENT_TIMESTAMP,
              ${taskId}::uuid,
              'business.task.execute'
            )
          `;
        }),
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({ code: '23514' }),
      });
    }
  });

  it('rejects evidence rows appended after the immutable parent JSON was committed', async () => {
    const eventId = randomUUID();
    const evidenceId = randomUUID();
    const correlationId = randomUUID();
    await administrator.$transaction(async (transaction) => {
      await insertVerifiedEvidence(transaction, evidenceId, 'parent-bijection');
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."business_events" (
          "id", "tenant_id", "event_type", "schema_version",
          "aggregate_type", "aggregate_id", "aggregate_version",
          "subject_type", "subject_id", "subject_version",
          "occurred_at", "organization_scope", "payload", "evidence_refs",
          "correlation_id", "idempotency_key", "sensitivity",
          "retain_until", "retention_action", "source_system",
          "source_record_id", "source_version", "producer",
          "permission_labels", "event_hash"
        ) VALUES (
          ${eventId}::uuid, ${tenantA}::uuid, 'Task.ParentBijection.Checked', 1,
          'TASK'::public."BusinessEventSubjectType", ${taskId}::uuid, 1,
          'TASK'::public."BusinessEventSubjectType", ${taskId}::uuid, 1,
          CURRENT_TIMESTAMP, ${JSON.stringify({ orgUnitIds: [orgUnitA] })}::jsonb,
          '{"fixture":"parent-bijection"}'::jsonb, '[]'::jsonb,
          ${correlationId}::uuid, ${`fixture:event:${eventId}`},
          'INTERNAL'::public."BusinessEventSensitivity",
          CURRENT_TIMESTAMP + INTERVAL '1 day',
          'ARCHIVE'::public."BusinessEventRetentionAction",
          'integration-test', ${taskId}, '1', 'integration-test',
          ${JSON.stringify(permissionLabels)}::jsonb, ${'e'.repeat(64)}
        )
      `);
    });

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."business_event_evidence" (
            "tenant_id", "business_event_id", "evidence_id",
            "evidence_version", "content_hash"
          ) VALUES (
            ${tenantA}::uuid, ${eventId}::uuid, ${evidenceId}::uuid,
            1, ${'e'.repeat(64)}
          )
        `);
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "business_event_evidence_parent_bijection_trigger" IMMEDIATE',
        );
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({
        code: '23514',
        message: expect.stringContaining(
          'Normalized evidence must remain a bijection with immutable parent JSON.',
        ),
      }),
    });
  });

  it('starts at attempt one and clears terminal state on the only valid RETRY transition', async () => {
    await expect(
      administrator.$transaction(async (transaction) => {
        await insertProcessRuntimeFixture(
          transaction,
          randomUUID(),
          randomUUID(),
          2,
          'invalid-initial-attempt',
        );
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({
        code: '23514',
        message: expect.stringContaining('A Process Step must start at attempt 1.'),
      }),
    });

    const processInstanceId = randomUUID();
    const processStepId = randomUUID();
    let retriedStep:
      | {
          status: string;
          revision: number;
          attempt: number;
          output: unknown;
          failure_code: string | null;
          failure_detail: string | null;
          claimed_at: Date | null;
          started_at: Date | null;
          completed_at: Date | null;
          timed_out_at: Date | null;
        }
      | undefined;
    const rollbackMarker = new Error('ROLLBACK_VALID_RETRY_FIXTURE');
    try {
      await administrator.$transaction(async (transaction) => {
        await insertProcessRuntimeFixture(
          transaction,
          processInstanceId,
          processStepId,
          1,
          'valid-retry',
        );
        await insertProcessStepCommand(transaction, processStepId, 'ACTIVATE', 1, 2);
        await transaction.$executeRaw(Prisma.sql`
        UPDATE public."process_step_instances"
        SET "status" = 'READY'::public."ProcessStepStatus",
            "revision" = 2
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${processStepId}::uuid
      `);
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
        await insertProcessStepCommand(transaction, processStepId, 'CLAIM', 2, 3);
        await transaction.$executeRaw(Prisma.sql`
        UPDATE public."process_step_instances"
        SET "status" = 'RUNNING'::public."ProcessStepStatus",
            "revision" = 3,
            "claimed_at" = CURRENT_TIMESTAMP,
            "started_at" = CURRENT_TIMESTAMP
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${processStepId}::uuid
      `);
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
        await insertProcessStepCommand(transaction, processStepId, 'FAIL', 3, 4);
        await transaction.$executeRaw(Prisma.sql`
        UPDATE public."process_step_instances"
        SET "status" = 'FAILED'::public."ProcessStepStatus",
            "revision" = 4,
            "failure_code" = 'INTEGRATION_FAILURE',
            "failure_detail" = 'The first attempt failed.'
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${processStepId}::uuid
      `);
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
        await insertProcessStepCommand(transaction, processStepId, 'RETRY', 4, 5);
        await transaction.$executeRaw(Prisma.sql`
        UPDATE public."process_step_instances"
        SET "status" = 'READY'::public."ProcessStepStatus",
            "revision" = 5,
            "attempt" = 2,
            "output" = NULL,
            "failure_code" = NULL,
            "failure_detail" = NULL,
            "claimed_at" = NULL,
            "started_at" = NULL,
            "completed_at" = NULL,
            "timed_out_at" = NULL
        WHERE "tenant_id" = ${tenantA}::uuid
          AND "id" = ${processStepId}::uuid
      `);
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        [retriedStep] = await transaction.$queryRaw<Array<NonNullable<typeof retriedStep>>>`
          SELECT
            "status"::text, "revision", "attempt", "output",
            "failure_code", "failure_detail", "claimed_at", "started_at",
            "completed_at", "timed_out_at"
          FROM public."process_step_instances"
          WHERE "tenant_id" = ${tenantA}::uuid
            AND "id" = ${processStepId}::uuid
        `;
        throw rollbackMarker;
      });
    } catch (error: unknown) {
      if (error !== rollbackMarker) throw error;
    }
    expect(retriedStep).toEqual({
      status: 'READY',
      revision: 5,
      attempt: 2,
      output: null,
      failure_code: null,
      failure_detail: null,
      claimed_at: null,
      started_at: null,
      completed_at: null,
      timed_out_at: null,
    });
  });

  it('stops ordinary Process Instance progression after Task cancellation but permits cancellation', async () => {
    await expect(
      administrator.$transaction(async (transaction) => {
        const processInstanceId = randomUUID();
        await insertProcessRuntimeFixture(
          transaction,
          processInstanceId,
          randomUUID(),
          1,
          'terminal-task-ordinary-progression',
        );
        await insertProcessCommand(transaction, processInstanceId, 'START', 1, 2);
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."process_instances"
          SET "status" = 'RUNNING'::public."ProcessInstanceStatus",
              "revision" = 2,
              "started_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${tenantA}::uuid
            AND "id" = ${processInstanceId}::uuid
        `);
        await transaction.task.update({
          where: { id: taskId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
          },
        });
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."process_instances"
          SET "status" = 'PAUSED'::public."ProcessInstanceStatus",
              "revision" = 3,
              "paused_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${tenantA}::uuid
            AND "id" = ${processInstanceId}::uuid
        `);
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({
        code: '23514',
        message: expect.stringContaining(
          'A Task outside READY/IN_PROGRESS/BLOCKED cannot advance its Process Instance.',
        ),
      }),
    });

    let cancelledStatus: string | undefined;
    const rollbackMarker = new Error('ROLLBACK_TERMINAL_TASK_PROCESS_CANCELLATION');
    try {
      await administrator.$transaction(async (transaction) => {
        const processInstanceId = randomUUID();
        await insertProcessRuntimeFixture(
          transaction,
          processInstanceId,
          randomUUID(),
          1,
          'terminal-task-process-cancellation',
        );
        await transaction.task.update({
          where: { id: taskId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
          },
        });
        await insertProcessCommand(transaction, processInstanceId, 'CANCEL', 1, 2);
        const rows = await transaction.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          UPDATE public."process_instances"
          SET "status" = 'CANCELLED'::public."ProcessInstanceStatus",
              "revision" = 2,
              "cancelled_at" = CURRENT_TIMESTAMP
          WHERE "tenant_id" = ${tenantA}::uuid
            AND "id" = ${processInstanceId}::uuid
          RETURNING "status"::text AS status
        `);
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        cancelledStatus = rows[0]?.status;
        throw rollbackMarker;
      });
    } catch (error) {
      expect(error).toBe(rollbackMarker);
    }
    expect(cancelledStatus).toBe('CANCELLED');
  });

  it('allows an independent nominated reviewer to resolve a LOW correction but rejects subject self-closure', async () => {
    const correctionCaseId = randomUUID();
    const evidenceId = randomUUID();
    const feedbackId = randomUUID();
    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT set_config('app.tenant_id', ${tenantA}, true)
      `;
      await insertLowCorrectionFixture(
        transaction,
        correctionCaseId,
        evidenceId,
        `positive-${correctionCaseId}`,
      );
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."correction_feedback" (
          "id", "tenant_id", "correction_case_id", "revision", "action",
          "actor_user_id", "actor_role_assignment_id", "comment",
          "evidence_ids", "occurred_at", "idempotency_key"
        ) VALUES (
          ${feedbackId}::uuid, ${tenantA}::uuid, ${correctionCaseId}::uuid,
          2, 'RESOLVE'::public."CorrectionFeedbackAction",
          ${recipientUser}::uuid, ${recipientAssignment}::uuid,
          'The low-risk correction was independently verified.',
          ${JSON.stringify([evidenceId])}::jsonb, CURRENT_TIMESTAMP,
          ${`correction-feedback:${feedbackId}`}
        )
      `);
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."correction_feedback_evidence" (
          "tenant_id", "correction_feedback_id", "evidence_id",
          "evidence_version", "content_hash"
        ) VALUES (
          ${tenantA}::uuid, ${feedbackId}::uuid, ${evidenceId}::uuid,
          1, ${'e'.repeat(64)}
        )
      `);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });

    const [resolved] = await administrator.$queryRaw<Array<{ status: string; revision: number }>>`
      SELECT "status"::text, "revision"
      FROM public."correction_cases"
      WHERE "tenant_id" = ${tenantA}::uuid
        AND "id" = ${correctionCaseId}::uuid
    `;
    expect(resolved).toEqual({ status: 'RESOLVED', revision: 2 });

    const selfClosureCaseId = randomUUID();
    const selfClosureEvidenceId = randomUUID();
    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          SELECT set_config('app.tenant_id', ${tenantA}, true)
        `;
        await insertLowCorrectionFixture(
          transaction,
          selfClosureCaseId,
          selfClosureEvidenceId,
          `self-closure-${selfClosureCaseId}`,
        );
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."correction_feedback" (
            "id", "tenant_id", "correction_case_id", "revision", "action",
            "actor_user_id", "actor_role_assignment_id", "comment",
            "evidence_ids", "occurred_at", "idempotency_key"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantA}::uuid, ${selfClosureCaseId}::uuid,
            2, 'RESOLVE'::public."CorrectionFeedbackAction",
            ${requesterUser}::uuid, ${requesterAssignment}::uuid,
            'A subject must not close its own correction.',
            ${JSON.stringify([selfClosureEvidenceId])}::jsonb, CURRENT_TIMESTAMP,
            ${`correction-feedback:self-closure:${selfClosureCaseId}`}
          )
        `);
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: expect.objectContaining({
        code: '23514',
        message: expect.stringContaining(
          'Correction feedback actor does not hold the required subject or review role.',
        ),
      }),
    });
  });

  it('binds dead-letter replay attribution to the current active tenant administrator', async () => {
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const correlationId = randomUUID();
    await administrator.$executeRaw(Prisma.sql`
      INSERT INTO public."business_events" (
        "id", "tenant_id", "event_type", "schema_version",
        "aggregate_type", "aggregate_id", "aggregate_version",
        "subject_type", "subject_id", "subject_version",
        "occurred_at", "organization_scope", "payload", "evidence_refs",
        "correlation_id", "idempotency_key", "sensitivity",
        "retain_until", "retention_action", "source_system",
        "source_record_id", "source_version", "producer",
        "permission_labels", "event_hash"
      ) VALUES (
        ${eventId}::uuid, ${tenantA}::uuid, 'Task.ReplayFixture.Created', 1,
        'TASK'::public."BusinessEventSubjectType", ${taskId}::uuid, 1,
        'TASK'::public."BusinessEventSubjectType", ${taskId}::uuid, 1,
        CURRENT_TIMESTAMP, ${JSON.stringify({ orgUnitIds: [orgUnitA] })}::jsonb,
        ${JSON.stringify({ fixture: 'dead-letter-replay-attribution' })}::jsonb,
        '[]'::jsonb, ${correlationId}::uuid,
        ${`fixture:event:${eventId}`}, 'INTERNAL'::public."BusinessEventSensitivity",
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        'ARCHIVE'::public."BusinessEventRetentionAction",
        'integration-test', ${taskId}, '1', 'integration-test',
        ${JSON.stringify(permissionLabels)}::jsonb, ${'b'.repeat(64)}
      )
    `);
    await administrator.$executeRaw(Prisma.sql`
      INSERT INTO public."business_event_deliveries" (
        "id", "tenant_id", "business_event_id", "consumer_name"
      ) VALUES (
        ${deliveryId}::uuid, ${tenantA}::uuid, ${eventId}::uuid,
        'integration-dead-letter-consumer'
      )
    `);
    await administrator.$executeRaw(Prisma.sql`
      UPDATE public."business_event_deliveries"
      SET "status" = 'DEAD_LETTERED'::public."BusinessEventDeliveryStatus",
          "revision" = "revision" + 1,
          "dead_lettered_at" = statement_timestamp(),
          "last_error_code" = 'FIXTURE_FAILURE',
          "last_error_detail" = 'Fixture delivery exhausted retries.'
      WHERE "tenant_id" = ${tenantA}::uuid
        AND "id" = ${deliveryId}::uuid
    `);

    await expect(
      administrator.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT set_config('app.user_id', ${nonParticipantUser}, true)
        `;
        await transaction.$executeRaw(Prisma.sql`
          UPDATE public."business_event_deliveries"
          SET "status" = 'PENDING'::public."BusinessEventDeliveryStatus",
              "revision" = "revision" + 1,
              "available_at" = statement_timestamp(),
              "dead_lettered_at" = NULL,
              "last_error_code" = NULL,
              "last_error_detail" = NULL,
              "replay_count" = "replay_count" + 1,
              "replayed_at" = statement_timestamp(),
              "replayed_by_user_id" = ${replayAdministrator}::uuid,
              "replay_reason" = 'Forged administrator attribution.'
          WHERE "tenant_id" = ${tenantA}::uuid
            AND "id" = ${deliveryId}::uuid
        `);
      }),
    ).rejects.toThrow();

    const deniedReplay = await request(app.getHttpServer())
      .post(`/api/v1/admin/business-events/deliveries/${deliveryId}/replay`)
      .set(identityHeaders(tenantA, nonParticipantUser))
      .send({
        expectedStatus: 'DEAD_LETTERED',
        reason: 'A member must not replay a dead-letter delivery.',
        idempotencyKey: `fixture:replay:member:${deliveryId}`,
      })
      .expect(422);
    expect(deniedReplay.body).toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'Dead-letter replay requires an active tenant owner or administrator.',
    });
    expect(deniedReplay.body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(JSON.stringify(deniedReplay.body)).not.toContain('P2010');
    expect(JSON.stringify(deniedReplay.body)).not.toContain('42501');
    expect(JSON.stringify(deniedReplay.body)).not.toContain(
      'business_event_deliveries_replay_actor_v2_check',
    );

    const replayRequest = {
      expectedStatus: 'DEAD_LETTERED',
      reason: 'An active administrator approved a bounded replay.',
      idempotencyKey: `fixture:replay:admin:${deliveryId}`,
    };
    const replayed = await request(app.getHttpServer())
      .post(`/api/v1/admin/business-events/deliveries/${deliveryId}/replay`)
      .set(identityHeaders(tenantA, replayAdministrator))
      .send(replayRequest);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    expect(replayed.body).toMatchObject({
      id: deliveryId,
      status: 'PENDING',
      revision: 3,
      replayCount: 1,
      replayedByUserId: replayAdministrator,
      replayReason: replayRequest.reason,
    });

    const idempotentReplay = await request(app.getHttpServer())
      .post(`/api/v1/admin/business-events/deliveries/${deliveryId}/replay`)
      .set(identityHeaders(tenantA, replayAdministrator))
      .send(replayRequest)
      .expect(201);
    expect(idempotentReplay.body).toEqual(replayed.body);
  });

  it('resolves candidates server-side and atomically rejects unauthorized or cross-tenant assignments', async () => {
    const candidates = await request(app.getHttpServer())
      .get(`/api/v1/workbench/tasks/${taskId}/collaboration-candidates`)
      .set(identityHeaders(tenantA, requesterUser));

    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.items).toEqual([
      expect.objectContaining({
        roleAssignmentId: requesterAssignment,
        userId: requesterUser,
        canActAsRequester: true,
      }),
      expect.objectContaining({
        roleAssignmentId: nonParticipantAssignment,
        userId: nonParticipantUser,
        canActAsRequester: false,
      }),
      expect.objectContaining({
        roleAssignmentId: recipientAssignment,
        userId: recipientUser,
        canActAsRequester: false,
      }),
    ]);
    expect(
      candidates.body.items.map((item: { roleAssignmentId: string }) => item.roleAssignmentId),
    ).not.toContain(unauthorizedAssignment);
    expect(
      candidates.body.items.map((item: { roleAssignmentId: string }) => item.roleAssignmentId),
    ).not.toContain(crossTenantAssignment);

    const before = await traceSnapshot();
    expect(before).toEqual({
      collaborations: 0,
      messages: 0,
      businessEvents: 0,
      audits: 0,
      outboxEvents: 0,
    });

    for (const [recipientRoleAssignmentId, idempotencyKey] of [
      [unauthorizedAssignment, 'collaboration:unauthorized-assignment'],
      [crossTenantAssignment, 'collaboration:cross-tenant-assignment'],
    ] as const) {
      const denied = await request(app.getHttpServer())
        .post(`/api/v1/workbench/tasks/${taskId}/collaborations`)
        .set(identityHeaders(tenantA, requesterUser))
        .send(createRequest(recipientRoleAssignmentId, idempotencyKey));
      expect(denied.status, JSON.stringify(denied.body)).toBe(422);
      expect(denied.body).toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
      expect(String(denied.body.message)).toContain(
        'Every Collaboration participant must resolve to a distinct active user and agent identity',
      );
      await expect(traceSnapshot()).resolves.toEqual(before);
    }
  });

  it('creates one immutable REQUEST trace and replays the same idempotency key without duplicates', async () => {
    const body = createRequest(recipientAssignment, 'collaboration:create:request-1');
    const created = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${taskId}/collaborations`)
      .set(identityHeaders(tenantA, requesterUser))
      .send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const replayed = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${taskId}/collaborations`)
      .set(identityHeaders(tenantA, requesterUser))
      .send(body);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);

    collaborationId = String(created.body.collaboration.id);
    expect(replayed.body).toEqual(created.body);
    expect(created.body.collaboration).toMatchObject({
      id: collaborationId,
      taskId,
      requesterRoleAssignmentId: requesterAssignment,
      recipientRoleAssignmentIds: [recipientAssignment],
      status: 'REQUESTED',
      revision: 1,
      permissionLabels: [...permissionLabels],
    });
    expect(created.body.messages).toHaveLength(1);
    expect(created.body.messages[0]).toMatchObject({
      type: 'REQUEST',
      revision: 1,
      senderRoleAssignmentId: requesterAssignment,
      recipientRoleAssignmentIds: [recipientAssignment],
    });
    await expect(traceSnapshot()).resolves.toEqual({
      collaborations: 1,
      messages: 1,
      businessEvents: 1,
      audits: 1,
      outboxEvents: 1,
    });
    await assertAtomicTrace([
      {
        eventType: 'Collaboration.Requested',
        auditAction: 'collaboration.create',
        revision: 1,
      },
    ]);
  });

  it('rejects a non-participant and stale revision without side effects, then commits exactly once', async () => {
    const before = await traceSnapshot();
    const commit = {
      expectedRevision: 1,
      type: 'COMMIT',
      payload: {
        committedDueAt: farFuture,
        outputSchema: { type: 'object', required: ['reportUri'] },
        conditions: ['The report must be sealed.'],
      },
      idempotencyKey: 'collaboration:commit:2',
    } as const;

    const wrongActor = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${taskId}/collaborations/${collaborationId}/commands`)
      .set(identityHeaders(tenantA, nonParticipantUser))
      .send({ ...commit, idempotencyKey: 'collaboration:wrong-actor' });
    expect(wrongActor.status, JSON.stringify(wrongActor.body)).toBe(422);
    expect(wrongActor.body).toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
    await expect(traceSnapshot()).resolves.toEqual(before);

    const stale = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${taskId}/collaborations/${collaborationId}/commands`)
      .set(identityHeaders(tenantA, recipientUser))
      .send({
        ...commit,
        expectedRevision: 2,
        idempotencyKey: 'collaboration:stale-revision',
      });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'CONFLICT',
      message: 'Collaboration revision is stale.',
    });
    await expect(traceSnapshot()).resolves.toEqual(before);

    const committed = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${taskId}/collaborations/${collaborationId}/commands`)
      .set(identityHeaders(tenantA, recipientUser))
      .send(commit)
      .expect(201);
    const replayed = await request(app.getHttpServer())
      .post(`/api/v1/workbench/tasks/${taskId}/collaborations/${collaborationId}/commands`)
      .set(identityHeaders(tenantA, recipientUser))
      .send(commit)
      .expect(201);

    expect(replayed.body).toEqual(committed.body);
    expect(committed.body.collaboration).toMatchObject({
      id: collaborationId,
      status: 'COMMITTED',
      revision: 2,
    });
    expect(committed.body.messages).toHaveLength(2);
    expect(committed.body.messages[1]).toMatchObject({
      type: 'COMMIT',
      revision: 2,
      senderRoleAssignmentId: recipientAssignment,
      recipientRoleAssignmentIds: [requesterAssignment],
    });
    await expect(traceSnapshot()).resolves.toEqual({
      collaborations: 1,
      messages: 2,
      businessEvents: 2,
      audits: 2,
      outboxEvents: 2,
    });
    await assertAtomicTrace([
      {
        eventType: 'Collaboration.Requested',
        auditAction: 'collaboration.create',
        revision: 1,
      },
      {
        eventType: 'Collaboration.Committed',
        auditAction: 'collaboration.commit',
        revision: 2,
      },
    ]);
  });

  it('injects only the active purpose-bound Conversation, Task, Role and private memories and seals the Run snapshot', async () => {
    await administrator.user.update({
      where: { id: requesterUser },
      data: { role: 'OWNER' },
    });
    await seedRevokedMemoryAssignment();
    const conversation = await request(app.getHttpServer())
      .post('/api/v1/conversations')
      .set(identityHeaders(tenantA, requesterUser))
      .send({ type: 'direct', target: { type: 'agent', agentId: requesterAgent } })
      .expect(201);
    memoryConversationId = String(conversation.body.id);

    const input = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${memoryConversationId}/messages`)
      .set(identityHeaders(tenantA, requesterUser))
      .send({
        clientMessageId: 'agent-memory-context-message-0001',
        content: {
          type: 'text',
          text: 'Recall the governed alpha memory context for this task.',
        },
      })
      .expect(201);
    const queued = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId: tenantA, inputMessageId: String(input.body.id) },
    });
    memoryRunId = queued.id;
    await administrator.agentRun.update({
      where: { id: memoryRunId },
      data: { taskId },
    });

    const [databaseClock] = await administrator.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (databaseClock === undefined) throw new Error('Database clock is unavailable.');
    const expiresAt = new Date(databaseClock.now.getTime() + 3_000);
    const expired = await createActiveMemory(tenantA, requesterUser, {
      scope: 'ENTERPRISE',
      title: 'Expired alpha memory',
      summary: 'This expired alpha memory must never enter an Agent Run.',
      contentHash: '1'.repeat(64),
      sourceType: 'USER_CONFIRMED',
      sourceId: requesterUser,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      expiresAt: expiresAt.toISOString(),
      retentionAction: 'ARCHIVE',
      idempotencyKey: 'agent-memory-expired',
    });
    const role = await createActiveMemory(tenantA, requesterUser, {
      scope: 'ROLE',
      title: 'Role alpha memory',
      summary: 'The active governed alpha role guidance applies to this Run.',
      contentHash: '2'.repeat(64),
      sourceType: 'ROLE_VERSION',
      sourceId: authorizedVersion,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      roleTemplateId: authorizedTemplate,
      roleVersionId: authorizedVersion,
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      retentionAction: 'ARCHIVE',
      idempotencyKey: 'agent-memory-role-active',
    });
    const privateMemory = await createActiveMemory(tenantA, requesterUser, {
      scope: 'EMPLOYEE_PRIVATE',
      title: 'Private alpha memory',
      summary: 'The employee approved this private alpha context for Agent Runs.',
      contentHash: '3'.repeat(64),
      sourceType: 'USER_CONFIRMED',
      sourceId: requesterUser,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      roleTemplateId: authorizedTemplate,
      roleVersionId: authorizedVersion,
      roleAssignmentId: requesterAssignment,
      permissionLabels: [],
      sensitivity: 'CONFIDENTIAL',
      retentionAction: 'ARCHIVE',
      consentPurpose: 'AGENT_RUN_CONTEXT',
      idempotencyKey: 'agent-memory-private-active',
    });
    const taskMemory = await createActiveMemory(tenantA, requesterUser, {
      scope: 'TASK',
      title: 'Task alpha memory',
      summary: 'The active alpha task context is limited to the current governed task.',
      contentHash: '4'.repeat(64),
      sourceType: 'TASK',
      sourceId: taskId,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      taskId,
      permissionLabels: [...permissionLabels],
      sensitivity: 'INTERNAL',
      retentionAction: 'ARCHIVE',
      idempotencyKey: 'agent-memory-task-active',
    });
    const conversationMemory = await createActiveMemory(tenantA, requesterUser, {
      scope: 'CONVERSATION',
      title: 'Conversation alpha memory',
      summary: 'The active alpha context is limited to this exact conversation.',
      contentHash: '5'.repeat(64),
      sourceType: 'CONVERSATION',
      sourceId: memoryConversationId,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      conversationId: memoryConversationId,
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      expiresAt: farFuture,
      retentionAction: 'DELETE',
      idempotencyKey: 'agent-memory-conversation-active',
    });
    await createActiveMemory(tenantA, requesterUser, {
      scope: 'EMPLOYEE_PRIVATE',
      title: 'Purpose mismatch alpha memory',
      summary: 'This private alpha context has consent for a different purpose.',
      contentHash: '6'.repeat(64),
      sourceType: 'USER_CONFIRMED',
      sourceId: requesterUser,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      roleTemplateId: authorizedTemplate,
      roleVersionId: authorizedVersion,
      roleAssignmentId: requesterAssignment,
      permissionLabels: [],
      sensitivity: 'CONFIDENTIAL',
      retentionAction: 'ARCHIVE',
      consentPurpose: 'PERSONAL_PROFILE',
      idempotencyKey: 'agent-memory-private-purpose-mismatch',
    });
    const archived = await createActiveMemory(tenantA, requesterUser, {
      scope: 'ENTERPRISE',
      title: 'Archived alpha memory',
      summary: 'This archived alpha memory must never enter an Agent Run.',
      contentHash: '7'.repeat(64),
      sourceType: 'USER_CONFIRMED',
      sourceId: requesterUser,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      permissionLabels: [],
      sensitivity: 'INTERNAL',
      retentionAction: 'ARCHIVE',
      idempotencyKey: 'agent-memory-archived',
    });
    await transitionMemory(tenantA, requesterUser, archived.id, 2, 'ARCHIVE');
    const revoked = await createActiveMemory(tenantA, requesterUser, {
      scope: 'EMPLOYEE_PRIVATE',
      title: 'Revoked assignment alpha memory',
      summary: 'This context belongs to an assignment that has been revoked.',
      contentHash: '8'.repeat(64),
      sourceType: 'USER_CONFIRMED',
      sourceId: requesterUser,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      roleTemplateId: unauthorizedTemplate,
      roleVersionId: unauthorizedVersion,
      roleAssignmentId: revokedMemoryAssignment,
      permissionLabels: [],
      sensitivity: 'CONFIDENTIAL',
      retentionAction: 'ARCHIVE',
      consentPurpose: 'AGENT_RUN_CONTEXT',
      idempotencyKey: 'agent-memory-revoked-assignment',
    });
    const crossTenant = await createActiveMemory(tenantB, crossTenantUser, {
      scope: 'EMPLOYEE_PRIVATE',
      title: 'Cross tenant alpha memory',
      summary: 'A matching cross-tenant private memory must remain isolated.',
      contentHash: '9'.repeat(64),
      sourceType: 'USER_CONFIRMED',
      sourceId: crossTenantUser,
      sourceVersion: 1,
      sourceEvidenceIds: [],
      roleTemplateId: crossTenantTemplate,
      roleVersionId: crossTenantVersion,
      roleAssignmentId: crossTenantAssignment,
      permissionLabels: [],
      sensitivity: 'CONFIDENTIAL',
      retentionAction: 'ARCHIVE',
      consentPurpose: 'AGENT_RUN_CONTEXT',
      idempotencyKey: 'agent-memory-cross-tenant',
    });
    const revokedAt = new Date();
    await administrator.roleAssignment.update({
      where: { id: revokedMemoryAssignment },
      data: {
        status: 'REVOKED',
        revokedAt,
        revokedById: requesterUser,
        revokeReason: 'Memory access regression fixture.',
        version: { increment: 1 },
        updatedAt: revokedAt,
      },
    });

    await vi.waitUntil(
      async () => {
        const [expiry] = await administrator.$queryRaw<Array<{ expired: boolean }>>`
          SELECT clock_timestamp() > ${expiresAt} AS "expired"
        `;
        return expiry?.expired === true;
      },
      { interval: 50, timeout: 10_000 },
    );

    const prepared = await runs.prepare(tenantA, memoryRunId);
    if (prepared.kind !== 'ready') {
      throw new Error(`Expected a memory-backed ready Run, received ${JSON.stringify(prepared)}.`);
    }
    const contexts = prepared.run.memoryContexts ?? [];
    expect(new Set(contexts.map(({ id }) => id))).toEqual(
      new Set([role.id, privateMemory.id, taskMemory.id, conversationMemory.id]),
    );
    expect(
      contexts.map(({ scope }) => scope).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['CONVERSATION', 'EMPLOYEE_PRIVATE', 'ROLE', 'TASK']);
    expect(contexts.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([expired.id, archived.id, revoked.id, crossTenant.id]),
    );

    const stored = await administrator.agentRun.findUniqueOrThrow({
      where: { id: memoryRunId },
    });
    expect(stored).toMatchObject({
      status: 'DISPATCHING',
      attempts: 1,
      dispatchStartedAt: expect.any(Date),
    });
    const snapshot = parseAgentRunMemoryContextSnapshot(stored.memoryContextSnapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.purpose).toBe('AGENT_RUN_CONTEXT');
    expect(new Set(snapshot?.contexts.map(({ id }) => id))).toEqual(
      new Set([role.id, privateMemory.id, taskMemory.id, conversationMemory.id]),
    );

    const tamperError = await captureDatabaseError(() =>
      administrator.agentRun.update({
        where: { id: memoryRunId },
        data: {
          memoryContextSnapshot: {
            ...(snapshot as unknown as Prisma.InputJsonObject),
            snapshotSha256: 'f'.repeat(64),
          },
        },
      }),
    );
    expect(tamperError.message).toContain(
      'Agent Run memory context snapshot is immutable after dispatch.',
    );
    await expect(
      administrator.agentRun.findUniqueOrThrow({ where: { id: memoryRunId } }),
    ).resolves.toMatchObject({ memoryContextSnapshot: stored.memoryContextSnapshot });

    const externalRunId = randomUUID();
    await expect(runs.attachExternalRun(tenantA, memoryRunId, externalRunId)).resolves.toBe(
      'attached',
    );
    await runs.completeSucceeded(
      tenantA,
      memoryRunId,
      'The purpose-bound memory snapshot was accepted.',
    );
  }, 30_000);

  it('fails with MEMORY_ACCESS_CHANGED before DISPATCHING when assignment access is revoked after retrieval', async () => {
    const input = await request(app.getHttpServer())
      .post(`/api/v1/conversations/${memoryConversationId}/messages`)
      .set(identityHeaders(tenantA, requesterUser))
      .send({
        clientMessageId: 'agent-memory-context-message-0002',
        content: {
          type: 'text',
          text: 'Use the same governed alpha memory after the retrieval boundary.',
        },
      })
      .expect(201);
    const queued = await administrator.agentRun.findFirstOrThrow({
      where: { tenantId: tenantA, inputMessageId: String(input.body.id) },
    });
    await administrator.agentRun.update({
      where: { id: queued.id },
      data: { taskId },
    });

    const originalSearch = retrieval.search.bind(retrieval);
    const searchSpy = vi.spyOn(retrieval, 'search').mockImplementationOnce(async (searchInput) => {
      const result = await originalSearch(searchInput);
      const revokedAt = new Date();
      await administrator.roleAssignment.update({
        where: { id: requesterAssignment },
        data: {
          status: 'REVOKED',
          revokedAt,
          revokedById: requesterUser,
          revokeReason: 'Revoked between retrieval and dispatch.',
          version: { increment: 1 },
          updatedAt: revokedAt,
        },
      });
      return result;
    });
    try {
      await expect(runs.prepare(tenantA, queued.id)).resolves.toEqual({
        kind: 'terminal',
        status: 'FAILED',
        externalRunId: null,
        errorCode: 'MEMORY_ACCESS_CHANGED',
      });
      expect(searchSpy).toHaveBeenCalledTimes(1);
    } finally {
      searchSpy.mockRestore();
    }
    await expect(
      administrator.agentRun.findUniqueOrThrow({ where: { id: queued.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 0,
      dispatchStartedAt: null,
      reservedTokens: 0,
      memoryContextSnapshot: null,
      errorCode: 'MEMORY_ACCESS_CHANGED',
    });
  });

  async function traceSnapshot(): Promise<{
    collaborations: number;
    messages: number;
    businessEvents: number;
    audits: number;
    outboxEvents: number;
  }> {
    const [collaborations, messages, businessEvents, audits, outboxEvents] = await Promise.all([
      countRows('collaborations'),
      countRows('collaboration_messages'),
      administrator.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS "count"
          FROM public."business_events"
          WHERE "tenant_id" = ${tenantA}::uuid
            AND "producer" = 'collaboration-correction'
        `,
      administrator.auditEvent.count({
        where: { tenantId: tenantA, resourceType: 'COLLABORATION' },
      }),
      administrator.outboxEvent.count({
        where: { tenantId: tenantA, aggregateType: 'COLLABORATION' },
      }),
    ]);
    return {
      collaborations,
      messages,
      businessEvents: Number(businessEvents[0]?.count ?? 0n),
      audits,
      outboxEvents,
    };
  }

  async function countRows(table: 'collaborations' | 'collaboration_messages'): Promise<number> {
    const rows = await administrator.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*)::bigint AS "count"
        FROM ${Prisma.raw(`public."${table}"`)}
        WHERE "tenant_id" = ${tenantA}::uuid`,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  async function assertAtomicTrace(
    expected: readonly {
      eventType: string;
      auditAction: string;
      revision: number;
    }[],
  ): Promise<void> {
    const events = await administrator.$queryRaw<
      Array<{
        id: string;
        eventType: string;
        aggregateVersion: number;
        sourceRecordId: string;
        causationId: string | null;
      }>
    >`
      SELECT
        "id",
        "event_type" AS "eventType",
        "aggregate_version" AS "aggregateVersion",
        "source_record_id" AS "sourceRecordId",
        "causation_id" AS "causationId"
      FROM public."business_events"
      WHERE "tenant_id" = ${tenantA}::uuid
        AND "producer" = 'collaboration-correction'
      ORDER BY "aggregate_version" ASC
    `;
    const audits = await administrator.auditEvent.findMany({
      where: { tenantId: tenantA, resourceType: 'COLLABORATION' },
      orderBy: { occurredAt: 'asc' },
    });
    const outbox = await administrator.outboxEvent.findMany({
      where: { tenantId: tenantA, aggregateType: 'COLLABORATION' },
      orderBy: { createdAt: 'asc' },
    });
    const messages = await administrator.$queryRaw<
      Array<{ id: string; revision: number; type: string }>
    >`
      SELECT "id", "revision", "type"::text
      FROM public."collaboration_messages"
      WHERE "tenant_id" = ${tenantA}::uuid
      ORDER BY "revision" ASC
    `;

    expect(events).toHaveLength(expected.length);
    expect(audits).toHaveLength(expected.length);
    expect(outbox).toHaveLength(expected.length);
    expect(messages).toHaveLength(expected.length);
    for (const [index, item] of expected.entries()) {
      expect(events[index]).toMatchObject({
        eventType: item.eventType,
        aggregateVersion: item.revision,
        sourceRecordId: messages[index]?.id,
        causationId: index === 0 ? null : events[index - 1]?.id,
      });
      expect(audits[index]).toMatchObject({
        actorId: index === 0 ? requesterUser : recipientUser,
        action: item.auditAction,
        resourceId: collaborationId,
      });
      expect(outbox[index]).toMatchObject({
        aggregateId: collaborationId,
        eventType: item.eventType,
      });
      expect(messages[index]).toMatchObject({ revision: item.revision });
    }
  }

  async function createActiveMemory(
    scopedTenantId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ readonly id: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/v1/workbench/memories')
      .set(identityHeaders(scopedTenantId, userId))
      .send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const memoryId = String(created.body.id);
    const activated = await request(app.getHttpServer())
      .post(`/api/v1/workbench/memories/${memoryId}/transitions`)
      .set(identityHeaders(scopedTenantId, userId))
      .send({
        expectedRevision: 1,
        action: 'ACTIVATE',
        reason: 'Activate the Agent Run memory integration fixture.',
        idempotencyKey: `${String(body.idempotencyKey)}:activate`,
      });
    expect(activated.status, JSON.stringify(activated.body)).toBe(201);
    expect(activated.body).toMatchObject({ id: memoryId, status: 'ACTIVE', revision: 2 });
    return { id: memoryId };
  }

  async function transitionMemory(
    scopedTenantId: string,
    userId: string,
    memoryId: string,
    expectedRevision: number,
    action: 'ARCHIVE' | 'SEAL' | 'DELETE',
  ): Promise<void> {
    const transitioned = await request(app.getHttpServer())
      .post(`/api/v1/workbench/memories/${memoryId}/transitions`)
      .set(identityHeaders(scopedTenantId, userId))
      .send({
        expectedRevision,
        action,
        reason: `${action} the Agent Run memory integration fixture.`,
        idempotencyKey: `agent-memory:${memoryId}:${action.toLowerCase()}`,
      });
    expect(transitioned.status, JSON.stringify(transitioned.body)).toBe(201);
    expect(transitioned.body).toMatchObject({
      id: memoryId,
      status: action === 'ARCHIVE' ? 'ARCHIVED' : action === 'SEAL' ? 'SEALED' : 'DELETED',
      revision: expectedRevision + 1,
    });
  }

  async function seedRevokedMemoryAssignment(): Promise<void> {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    await administrator.agentInstance.create({
      data: agentFixture(
        revokedMemoryAgent,
        tenantA,
        unauthorizedVersion,
        requesterUser,
        'revoked-memory',
      ),
    });
    await administrator.roleAssignment.create({
      data: assignmentFixture({
        id: revokedMemoryAssignment,
        tenantId: tenantA,
        userId: requesterUser,
        employmentId: requesterEmployment,
        templateId: unauthorizedTemplate,
        versionId: unauthorizedVersion,
        agentId: revokedMemoryAgent,
        createdById: requesterUser,
        suffix: 'revoked-memory',
        effectiveFrom,
        actions: ['business.task.execute'],
      }),
    });
  }

  async function seedModelRoute(): Promise<void> {
    const reviewedAt = new Date();
    await withModelRouteActor(requesterUser, async (transaction) => {
      await transaction.aiModelCatalogVersion.create({
        data: {
          id: modelCatalogVersion,
          tenantId: tenantA,
          routeKey: 'AGENT_RUN_PRIMARY',
          version: 1,
          provider: 'OPENAI_COMPATIBLE',
          modelName: 'collaboration-integration-chat',
          credentialReference: 'vault://integration/collaboration-agent-run',
          dataResidency: 'CN',
          maximumClassification: 'CONFIDENTIAL',
          capabilities: ['chat'],
          maxContextTokens: 32_000,
          maxOutputTokens: 4_000,
          inputCostMicrosPerMillion: 1_000n,
          outputCostMicrosPerMillion: 2_000n,
          p95LatencyMs: 5_000,
          configurationHash: 'c'.repeat(64),
          createdByUserId: requesterUser,
          idempotencyKey: 'collaboration-model-route-catalog-v1',
          requestHash: 'd'.repeat(64),
        },
      });
      await transaction.aiModelCatalogVersion.update({
        where: { id: modelCatalogVersion },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: requesterUser,
          submittedAt: reviewedAt,
        },
      });
    });
    await withModelRouteActor(recipientUser, async (transaction) => {
      await transaction.aiModelCatalogVersion.update({
        where: { id: modelCatalogVersion },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: recipientUser,
          reviewedAt,
          publishedByUserId: recipientUser,
          publishedAt: reviewedAt,
        },
      });
    });
    await withModelRouteActor(requesterUser, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.create({
        data: {
          id: modelRoutePolicyVersion,
          tenantId: tenantA,
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
          policyHash: 'e'.repeat(64),
          createdByUserId: requesterUser,
          idempotencyKey: 'collaboration-model-route-policy-v1',
          requestHash: 'f'.repeat(64),
        },
      });
      await transaction.aiModelRouteCandidate.create({
        data: {
          tenantId: tenantA,
          policyVersionId: modelRoutePolicyVersion,
          ordinal: 1,
          catalogVersionId: modelCatalogVersion,
        },
      });
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: modelRoutePolicyVersion },
        data: {
          status: 'IN_REVIEW',
          revision: 2,
          submittedByUserId: requesterUser,
          submittedAt: reviewedAt,
        },
      });
    });
    await withModelRouteActor(recipientUser, async (transaction) => {
      await transaction.aiModelRoutePolicyVersion.update({
        where: { id: modelRoutePolicyVersion },
        data: {
          status: 'PUBLISHED',
          revision: 3,
          reviewedByUserId: recipientUser,
          reviewedAt,
          publishedByUserId: recipientUser,
          publishedAt: reviewedAt,
        },
      });
    });
  }

  async function withModelRouteActor<T>(
    userId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return operation(transaction);
    });
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantA, tenantB]);
  }

  async function seedFixtures(): Promise<void> {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date();
    const hash = 'a'.repeat(64);
    const definition = governedRoleDefinition();

    await administrator.$transaction(async (transaction) => {
      await transaction.tenant.createMany({
        data: [
          { id: tenantA, slug: 'collaboration-execution-a', name: 'Collaboration A' },
          { id: tenantB, slug: 'collaboration-execution-b', name: 'Collaboration B' },
        ],
      });
      await transaction.user.createMany({
        data: [
          userFixture(requesterUser, tenantA, 'Requester'),
          userFixture(recipientUser, tenantA, 'Recipient'),
          userFixture(nonParticipantUser, tenantA, 'Non Participant'),
          userFixture(unauthorizedUser, tenantA, 'Unauthorized'),
          userFixture(crossTenantUser, tenantB, 'Cross Tenant'),
          userFixture(crossTenantReviewer, tenantB, 'Cross Tenant Reviewer'),
          userFixture(replayAdministrator, tenantA, 'Replay Administrator', 'ADMIN'),
        ],
      });
      await transaction.organization.createMany({
        data: [
          { id: organizationA, tenantId: tenantA, name: 'Organization A' },
          { id: organizationB, tenantId: tenantB, name: 'Organization B' },
        ],
      });
      await transaction.orgUnit.createMany({
        data: [
          {
            id: orgUnitA,
            tenantId: tenantA,
            organizationId: organizationA,
            name: 'Delivery A',
          },
          {
            id: orgUnitB,
            tenantId: tenantB,
            organizationId: organizationB,
            name: 'Delivery B',
          },
        ],
      });
      await transaction.employment.createMany({
        data: [
          employmentFixture(requesterEmployment, tenantA, requesterUser, organizationA, orgUnitA),
          employmentFixture(recipientEmployment, tenantA, recipientUser, organizationA, orgUnitA),
          employmentFixture(
            nonParticipantEmployment,
            tenantA,
            nonParticipantUser,
            organizationA,
            orgUnitA,
          ),
          employmentFixture(
            unauthorizedEmployment,
            tenantA,
            unauthorizedUser,
            organizationA,
            orgUnitA,
          ),
          employmentFixture(
            crossTenantEmployment,
            tenantB,
            crossTenantUser,
            organizationB,
            orgUnitB,
          ),
        ],
      });
      await transaction.agentTemplate.createMany({
        data: [
          {
            id: authorizedTemplate,
            tenantId: tenantA,
            key: 'collaboration-authorized',
            name: 'Authorized collaboration role',
            ...definition,
          },
          {
            id: unauthorizedTemplate,
            tenantId: tenantA,
            key: 'collaboration-unauthorized',
            name: 'Unauthorized collaboration role',
            ...definition,
          },
          {
            id: crossTenantTemplate,
            tenantId: tenantB,
            key: 'collaboration-cross-tenant',
            name: 'Cross-tenant collaboration role',
            ...definition,
          },
        ],
      });
      await transaction.agentVersion.createMany({
        data: [
          versionFixture(
            authorizedVersion,
            tenantA,
            authorizedTemplate,
            requesterUser,
            recipientUser,
            definition,
          ),
          versionFixture(
            unauthorizedVersion,
            tenantA,
            unauthorizedTemplate,
            requesterUser,
            recipientUser,
            definition,
          ),
          versionFixture(
            crossTenantVersion,
            tenantB,
            crossTenantTemplate,
            crossTenantUser,
            crossTenantReviewer,
            definition,
          ),
        ],
      });
      await transaction.agentInstance.createMany({
        data: [
          agentFixture(requesterAgent, tenantA, authorizedVersion, requesterUser, 'requester'),
          agentFixture(recipientAgent, tenantA, authorizedVersion, recipientUser, 'recipient'),
          agentFixture(
            nonParticipantAgent,
            tenantA,
            authorizedVersion,
            nonParticipantUser,
            'non-participant',
          ),
          agentFixture(
            unauthorizedAgent,
            tenantA,
            unauthorizedVersion,
            unauthorizedUser,
            'unauthorized',
          ),
          agentFixture(
            crossTenantAgent,
            tenantB,
            crossTenantVersion,
            crossTenantUser,
            'cross-tenant',
          ),
        ],
      });
      await transaction.roleAssignment.createMany({
        data: [
          assignmentFixture({
            id: requesterAssignment,
            tenantId: tenantA,
            userId: requesterUser,
            employmentId: requesterEmployment,
            templateId: authorizedTemplate,
            versionId: authorizedVersion,
            agentId: requesterAgent,
            createdById: requesterUser,
            suffix: 'requester',
            effectiveFrom,
            actions: ['business.task.execute', 'agent.run.execute', 'knowledge.retrieve'],
          }),
          assignmentFixture({
            id: recipientAssignment,
            tenantId: tenantA,
            userId: recipientUser,
            employmentId: recipientEmployment,
            templateId: authorizedTemplate,
            versionId: authorizedVersion,
            agentId: recipientAgent,
            createdById: requesterUser,
            suffix: 'recipient',
            effectiveFrom,
            actions: ['business.task.execute'],
          }),
          assignmentFixture({
            id: nonParticipantAssignment,
            tenantId: tenantA,
            userId: nonParticipantUser,
            employmentId: nonParticipantEmployment,
            templateId: authorizedTemplate,
            versionId: authorizedVersion,
            agentId: nonParticipantAgent,
            createdById: requesterUser,
            suffix: 'non-participant',
            effectiveFrom,
            actions: ['business.task.execute'],
          }),
          assignmentFixture({
            id: unauthorizedAssignment,
            tenantId: tenantA,
            userId: unauthorizedUser,
            employmentId: unauthorizedEmployment,
            templateId: unauthorizedTemplate,
            versionId: unauthorizedVersion,
            agentId: unauthorizedAgent,
            createdById: requesterUser,
            suffix: 'unauthorized',
            effectiveFrom,
            actions: ['business.task.read'],
          }),
          assignmentFixture({
            id: crossTenantAssignment,
            tenantId: tenantB,
            userId: crossTenantUser,
            employmentId: crossTenantEmployment,
            templateId: crossTenantTemplate,
            versionId: crossTenantVersion,
            agentId: crossTenantAgent,
            createdById: crossTenantUser,
            suffix: 'cross-tenant',
            effectiveFrom,
            actions: ['business.task.execute'],
          }),
        ],
      });
    });

    await seedModelRoute();

    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
      await transaction.valueDefinition.create({
        data: {
          id: valueDefinition,
          tenantId: tenantA,
          code: 'COLLABORATION_VALUE',
          type: 'ENTERPRISE',
          name: 'Trusted collaboration',
          description: 'Trusted structured collaboration.',
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          idempotencyKey: 'semantic:value-definition',
          requestHash: hash,
        },
      });
      await transaction.metricDefinition.create({
        data: {
          id: metricDefinition,
          tenantId: tenantA,
          code: 'COLLABORATION_METRIC',
          version: 1,
          name: 'Verified collaboration',
          description: 'Count of verified collaborations.',
          status: 'ACTIVE',
          valueType: 'COUNT',
          unit: 'count',
          aggregation: 'SUM',
          direction: 'INCREASE',
          bscPerspective: 'INTERNAL_PROCESS',
          indicatorType: 'LEADING',
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          activatedAt: now,
          idempotencyKey: 'semantic:metric-definition',
          requestHash: hash,
        },
      });
      await transaction.valueVersion.create({
        data: {
          id: valueVersion,
          tenantId: tenantA,
          valueDefinitionId: valueDefinition,
          version: 1,
          status: 'DRAFT',
          statement: 'Collaborate through immutable structured traces.',
          positiveBehaviors: ['Use trusted assignments'],
          negativeBehaviors: ['Trust request-controlled identities'],
          changeSummary: 'Initial version',
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          idempotencyKey: 'semantic:value-version',
          requestHash: hash,
        },
      });
      await transaction.valueMetric.create({
        data: {
          id: valueMetric,
          tenantId: tenantA,
          code: 'COLLABORATION_VALUE_METRIC',
          valueDefinitionId: valueDefinition,
          valueVersionId: valueVersion,
          valueVersionNumber: 1,
          metricDefinitionId: metricDefinition,
          metricDefinitionVersion: 1,
          name: 'Verified collaboration weight',
          weight: new Prisma.Decimal(1),
          target: { minimum: 1 },
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          idempotencyKey: 'semantic:value-metric',
          requestHash: hash,
        },
      });
      await transaction.valueVersion.update({
        where: { id: valueVersion },
        data: { status: 'PUBLISHED', publishedAt: now },
      });
      await transaction.valueDefinition.update({
        where: { id: valueDefinition },
        data: { currentVersionId: valueVersion, currentVersionNumber: 1 },
      });
      await transaction.strategy.create({
        data: {
          id: strategy,
          tenantId: tenantA,
          code: 'COLLABORATION_STRATEGY',
          version: 1,
          name: 'Structured collaboration',
          description: 'Execute governed structured collaboration.',
          status: 'DRAFT',
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          idempotencyKey: 'semantic:strategy',
          requestHash: hash,
        },
      });
      await transaction.strategyValueVersion.create({
        data: {
          tenantId: tenantA,
          strategyId: strategy,
          strategyVersion: 1,
          valueDefinitionId: valueDefinition,
          valueVersionId: valueVersion,
          valueVersionNumber: 1,
        },
      });
      await transaction.strategy.update({
        where: { id: strategy },
        data: { status: 'ACTIVE', activatedAt: now },
      });
      await transaction.objective.create({
        data: {
          id: objective,
          tenantId: tenantA,
          code: 'COLLABORATION_OBJECTIVE',
          version: 1,
          strategyId: strategy,
          strategyVersion: 1,
          name: 'Complete structured collaboration',
          description: 'Complete a trusted request and commit.',
          status: 'DRAFT',
          bscPerspective: 'INTERNAL_PROCESS',
          indicatorType: 'LEADING',
          weight: new Prisma.Decimal(1),
          ownerRoleAssignmentId: requesterAssignment,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          idempotencyKey: 'semantic:objective',
          requestHash: hash,
        },
      });
      await transaction.objectiveValueVersion.create({
        data: {
          tenantId: tenantA,
          objectiveId: objective,
          objectiveVersion: 1,
          strategyId: strategy,
          strategyVersion: 1,
          valueDefinitionId: valueDefinition,
          valueVersionId: valueVersion,
          valueVersionNumber: 1,
        },
      });
      await transaction.objectiveMetricDefinition.create({
        data: {
          tenantId: tenantA,
          objectiveId: objective,
          objectiveVersion: 1,
          metricDefinitionId: metricDefinition,
          metricDefinitionVersion: 1,
        },
      });
      await transaction.objectiveRoleAssignment.createMany({
        data: [
          requesterAssignment,
          recipientAssignment,
          nonParticipantAssignment,
          unauthorizedAssignment,
        ].map((roleAssignmentId) => ({
          tenantId: tenantA,
          objectiveId: objective,
          objectiveVersion: 1,
          roleAssignmentId,
        })),
      });
      await transaction.objective.update({
        where: { id: objective },
        data: { status: 'ACTIVE', activatedAt: now },
      });
      await transaction.processDefinition.create({
        data: {
          id: processDefinition,
          tenantId: tenantA,
          code: 'COLLABORATION_PROCESS',
          name: 'Structured collaboration process',
          description: 'Request and commit.',
          status: 'DRAFT',
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          idempotencyKey: 'semantic:process-definition',
          requestHash: hash,
        },
      });
      await transaction.processVersion.create({
        data: {
          id: processVersion,
          tenantId: tenantA,
          processDefinitionId: processDefinition,
          version: 1,
          status: 'DRAFT',
          changeSummary: 'Initial version',
          ownerUserId: requesterUser,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          idempotencyKey: 'semantic:process-version',
          requestHash: hash,
        },
      });
      await transaction.processNode.createMany({
        data: [
          {
            id: processStartNode,
            tenantId: tenantA,
            processDefinitionId: processDefinition,
            processVersionId: processVersion,
            processVersion: 1,
            code: 'START',
            name: 'Start',
            type: 'START',
            ordinal: 0,
          },
          {
            id: processActivityNode,
            tenantId: tenantA,
            processDefinitionId: processDefinition,
            processVersionId: processVersion,
            processVersion: 1,
            code: 'COLLABORATION_TIMER',
            name: 'Collaborate',
            type: 'TIMER',
            ordinal: 1,
          },
          {
            id: processEndNode,
            tenantId: tenantA,
            processDefinitionId: processDefinition,
            processVersionId: processVersion,
            processVersion: 1,
            code: 'END',
            name: 'End',
            type: 'END',
            ordinal: 2,
          },
        ],
      });
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."process_edges" (
          "id", "tenant_id", "process_definition_id",
          "process_version_id", "process_version",
          "from_node_id", "from_node_code", "to_node_id", "to_node_code",
          "priority", "is_default", "condition"
        ) VALUES
        (
          ${processStartEdge}::uuid, ${tenantA}::uuid, ${processDefinition}::uuid,
          ${processVersion}::uuid, 1,
          ${processStartNode}::uuid, 'START',
          ${processActivityNode}::uuid, 'COLLABORATION_TIMER',
          0, false, '{}'::jsonb
        ),
        (
          ${processEndEdge}::uuid, ${tenantA}::uuid, ${processDefinition}::uuid,
          ${processVersion}::uuid, 1,
          ${processActivityNode}::uuid, 'COLLABORATION_TIMER',
          ${processEndNode}::uuid, 'END',
          0, false, '{}'::jsonb
        )
      `);
      await transaction.processVersion.update({
        where: { id: processVersion },
        data: { status: 'PUBLISHED', publishedAt: now },
      });
      await transaction.processDefinition.update({
        where: { id: processDefinition },
        data: {
          status: 'ACTIVE',
          currentVersionId: processVersion,
          currentVersionNumber: 1,
        },
      });
      await transaction.task.create({
        data: {
          id: taskId,
          tenantId: tenantA,
          code: 'STRUCTURED_COLLABORATION_TASK',
          version: 1,
          strategyId: strategy,
          strategyVersion: 1,
          objectiveId: objective,
          objectiveVersion: 1,
          valueDefinitionId: valueDefinition,
          valueVersionId: valueVersion,
          valueVersionNumber: 1,
          processDefinitionId: processDefinition,
          processDefinitionCode: 'COLLABORATION_PROCESS',
          processVersionId: processVersion,
          processVersion: 1,
          processNodeId: processActivityNode,
          processNodeCode: 'COLLABORATION_TIMER',
          title: 'Complete structured collaboration',
          description: 'Exercise the trusted REQUEST to COMMIT trace.',
          status: 'READY',
          priority: 'HIGH',
          ownerRoleAssignmentId: requesterAssignment,
          permissionLabels: [...permissionLabels],
          effectiveFrom,
          dueAt: new Date(farFuture),
          readyAt: now,
          idempotencyKey: 'semantic:task',
          requestHash: hash,
        },
      });
    });
  }
});

function identityHeaders(tenantId: string, userId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId, 'x-user-id': userId };
}

function createRequest(recipientRoleAssignmentId: string, idempotencyKey: string) {
  return {
    actingRoleAssignmentId: requesterAssignment,
    recipientRoleAssignmentIds: [recipientRoleAssignmentId],
    background: 'Customer knowledge accuracy is below target.',
    commonGoal: 'Restore the customer knowledge accuracy target.',
    requestedInput: 'Provide a sealed regression report.',
    expectedOutputSchema: { type: 'object', required: ['reportUri'] },
    dueAt: farFuture,
    contextRefs: [{ type: 'TASK' as const, id: taskId, version: 1 }],
    idempotencyKey,
  };
}

function userFixture(
  id: string,
  tenantId: string,
  displayName: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER',
) {
  const email = `${displayName.toLowerCase().replaceAll(' ', '-')}@collaboration.integration`;
  return {
    id,
    tenantId,
    email,
    emailNormalized: email,
    displayName,
    status: 'ACTIVE' as const,
    role,
  };
}

function employmentFixture(
  id: string,
  tenantId: string,
  userId: string,
  organizationId: string,
  orgUnitId: string,
) {
  return {
    id,
    tenantId,
    userId,
    organizationId,
    orgUnitId,
    status: 'ACTIVE' as const,
    isPrimary: true,
  };
}

function versionFixture(
  id: string,
  tenantId: string,
  templateId: string,
  authorId: string,
  reviewerId: string,
  definition: ReturnType<typeof governedRoleDefinition>,
) {
  const publishedAt = new Date();
  return {
    id,
    tenantId,
    templateId,
    version: 1,
    status: 'PUBLISHED' as const,
    reviewStatus: 'APPROVED' as const,
    systemPrompt: 'Execute only trusted structured collaboration.',
    modelPolicy: { provider: 'integration', model: 'integration' },
    toolPolicy: { allow: [] },
    knowledgeScope: { ids: [] },
    roleDefinitionSnapshot: definition,
    blueprintRevision: 1,
    createdById: authorId,
    reviewRequestedAt: publishedAt,
    reviewRequestedById: authorId,
    reviewedAt: publishedAt,
    reviewedById: reviewerId,
    reviewComment: 'Approved integration fixture.',
    approvedAt: publishedAt,
    approvedById: reviewerId,
    publishedAt,
    publishedById: reviewerId,
  };
}

function agentFixture(
  id: string,
  tenantId: string,
  versionId: string,
  userId: string,
  suffix: string,
) {
  return {
    id,
    tenantId,
    key: `collaboration-${suffix}`,
    versionId,
    ownerUserId: userId,
    createdById: userId,
    name: `Collaboration ${suffix}`,
    status: 'ONLINE' as const,
  };
}

function assignmentFixture(input: {
  id: string;
  tenantId: string;
  userId: string;
  employmentId: string;
  templateId: string;
  versionId: string;
  agentId: string;
  createdById: string;
  suffix: string;
  effectiveFrom: Date;
  actions: readonly string[];
}) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    key: `collaboration-${input.suffix}`,
    idempotencyKey: `collaboration-assignment:${input.suffix}`,
    requestHash: 'b'.repeat(64),
    userId: input.userId,
    employmentId: input.employmentId,
    roleTemplateId: input.templateId,
    roleVersionId: input.versionId,
    agentInstanceId: input.agentId,
    status: 'ACTIVE' as const,
    source: 'LOCAL' as const,
    effectiveFrom: input.effectiveFrom,
    organizationScope: {
      organizationIds: [input.tenantId === tenantA ? organizationA : organizationB],
      orgUnitIds: [input.tenantId === tenantA ? orgUnitA : orgUnitB],
    },
    permissionScope: {
      taskIds: [taskId],
      dataLabels: [...permissionLabels],
      actions: [...input.actions],
    },
    memoryPolicy: {},
    createdById: input.createdById,
  };
}

function governedRoleDefinition() {
  return {
    mission: 'Deliver governed and verifiable collaboration outcomes.',
    responsibilities: [
      {
        key: 'collaboration-delivery',
        name: 'Collaboration delivery',
        description: 'Deliver a verified structured collaboration result.',
        outcomes: ['A verified collaboration trace exists.'],
      },
    ],
    valueDefinition: {
      statement: 'Produce verifiable enterprise collaboration value.',
      stakeholderOutcomes: ['Stakeholders receive a reliable result.'],
      measures: ['Verified collaboration outcomes'],
    },
    capabilities: [],
    processes: [],
    tools: [],
    knowledgeDomains: [],
  };
}

async function captureDatabaseError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected the database operation to be rejected.');
}

async function insertVerifiedEvidence(
  transaction: Prisma.TransactionClient,
  evidenceId: string,
  suffix: string,
): Promise<void> {
  const now = new Date();
  await transaction.evidence.create({
    data: {
      id: evidenceId,
      tenantId: tenantA,
      code: `COLLABORATION_${suffix.toUpperCase().replaceAll('-', '_')}`,
      version: 1,
      status: 'ACTIVE',
      sourceType: 'HUMAN_ATTESTATION',
      sourceSystem: 'integration-test',
      sourceRecordId: evidenceId,
      sourceVersion: '1',
      observedAt: now,
      contentHash: 'e'.repeat(64),
      trustLevel: 'VERIFIED',
      confidence: new Prisma.Decimal(1),
      summary: `Verified ${suffix} evidence.`,
      verifiedByRoleAssignmentId: requesterAssignment,
      verifiedAt: now,
      ownerRoleAssignmentId: requesterAssignment,
      permissionLabels: [...permissionLabels],
      effectiveFrom: new Date(now.getTime() - 60_000),
      activatedAt: now,
      idempotencyKey: `collaboration:evidence:${suffix}:${evidenceId}`,
      requestHash: 'e'.repeat(64),
    },
  });
}

async function insertProcessRuntimeFixture(
  transaction: Prisma.TransactionClient,
  processInstanceId: string,
  processStepId: string,
  attempt: number,
  suffix: string,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."process_instances" (
      "id", "tenant_id", "process_definition_id", "process_version_id",
      "process_version", "objective_id", "objective_version",
      "task_id", "task_version", "correlation_id", "input",
      "permission_labels", "idempotency_key", "request_hash"
    ) VALUES (
      ${processInstanceId}::uuid, ${tenantA}::uuid,
      ${processDefinition}::uuid, ${processVersion}::uuid, 1,
      ${objective}::uuid, 1, ${taskId}::uuid, 1, ${randomUUID()}::uuid,
      '{}'::jsonb, ${JSON.stringify(permissionLabels)}::jsonb,
      ${`process-instance:${suffix}:${processInstanceId}`}, ${'f'.repeat(64)}
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    UPDATE public."tasks"
    SET "process_instance_id" = ${processInstanceId}::uuid
    WHERE "tenant_id" = ${tenantA}::uuid
      AND "id" = ${taskId}::uuid
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."process_step_instances" (
      "id", "tenant_id", "process_instance_id", "process_definition_id",
      "process_version_id", "process_version", "process_node_id",
      "process_node_code", "attempt", "status", "revision", "input",
      "available_at", "idempotency_key", "request_hash"
    ) VALUES (
      ${processStepId}::uuid, ${tenantA}::uuid, ${processInstanceId}::uuid,
      ${processDefinition}::uuid, ${processVersion}::uuid, 1,
      ${processActivityNode}::uuid, 'COLLABORATION_TIMER', ${attempt},
      'WAITING'::public."ProcessStepStatus", 1, '{}'::jsonb,
      CURRENT_TIMESTAMP, ${`process-step:${suffix}:${processStepId}`},
      ${'f'.repeat(64)}
    )
  `);
}

async function insertProcessStepCommand(
  transaction: Prisma.TransactionClient,
  processStepId: string,
  command: 'ACTIVATE' | 'CLAIM' | 'FAIL' | 'RETRY',
  expectedRevision: number,
  resultRevision: number,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."process_step_commands" (
      "id", "tenant_id", "process_step_instance_id", "command",
      "expected_revision", "result_revision", "actor_type",
      "actor_service_id", "reason", "payload", "effective_at",
      "idempotency_key"
    ) VALUES (
      ${randomUUID()}::uuid, ${tenantA}::uuid, ${processStepId}::uuid,
      ${command}::public."ProcessStepCommandType",
      ${expectedRevision}, ${resultRevision},
      'SERVICE'::public."ProcessActorType", 'integration-orchestrator',
      ${`Exercise ${command} transition.`}, '{}'::jsonb, CURRENT_TIMESTAMP,
      ${`process-step-command:${processStepId}:${resultRevision}`}
    )
  `);
}

async function insertProcessCommand(
  transaction: Prisma.TransactionClient,
  processInstanceId: string,
  command: 'START' | 'CANCEL',
  expectedRevision: number,
  resultRevision: number,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."process_commands" (
      "id", "tenant_id", "process_instance_id", "command",
      "expected_revision", "result_revision", "actor_type",
      "actor_service_id", "reason", "payload", "effective_at",
      "idempotency_key"
    ) VALUES (
      ${randomUUID()}::uuid, ${tenantA}::uuid, ${processInstanceId}::uuid,
      ${command}::public."ProcessCommandType",
      ${expectedRevision}, ${resultRevision},
      'SERVICE'::public."ProcessActorType", 'integration-orchestrator',
      ${`Exercise ${command} Process Instance transition.`},
      '{}'::jsonb, CURRENT_TIMESTAMP,
      ${`process-command:${processInstanceId}:${resultRevision}`}
    )
  `);
}

async function insertLowCorrectionFixture(
  transaction: Prisma.TransactionClient,
  correctionCaseId: string,
  evidenceId: string,
  suffix: string,
): Promise<void> {
  await insertVerifiedEvidence(transaction, evidenceId, suffix);
  const evidenceRefs = [
    {
      evidenceId,
      version: 1,
      contentHash: 'e'.repeat(64),
    },
  ];
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."correction_cases" (
      "id", "tenant_id", "correlation_id", "subject_type", "subject_id",
      "subject_version", "role_assignment_id", "objective_id",
      "objective_version", "task_id", "task_version", "trigger",
      "category", "severity", "confidence", "rule_findings",
      "evidence_refs", "impact", "suggested_actions",
      "required_role_assignment_ids", "status", "revision",
      "permission_labels", "idempotency_key", "request_hash"
    ) VALUES (
      ${correctionCaseId}::uuid, ${tenantA}::uuid, ${randomUUID()}::uuid,
      'TASK'::public."BusinessEventSubjectType", ${taskId}::uuid, 1,
      ${requesterAssignment}::uuid, ${objective}::uuid, 1,
      ${taskId}::uuid, 1, 'Low-risk integration correction',
      'THRESHOLD_ANOMALY'::public."CorrectionCategory",
      'LOW'::public."CorrectionSeverity", 0.9,
      '[{"code":"LOW_RISK_INTEGRATION"}]'::jsonb,
      ${JSON.stringify(evidenceRefs)}::jsonb,
      'A bounded low-risk condition requires independent confirmation.',
      '["Review and close the bounded correction."]'::jsonb,
      ${JSON.stringify([recipientAssignment])}::jsonb,
      'OPEN'::public."CorrectionStatus", 1,
      ${JSON.stringify(permissionLabels)}::jsonb,
      ${`correction-case:${suffix}`}, ${'c'.repeat(64)}
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."correction_case_evidence" (
      "tenant_id", "correction_case_id", "evidence_id",
      "evidence_version", "content_hash"
    ) VALUES (
      ${tenantA}::uuid, ${correctionCaseId}::uuid, ${evidenceId}::uuid,
      1, ${'e'.repeat(64)}
    )
  `);
  await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
}
