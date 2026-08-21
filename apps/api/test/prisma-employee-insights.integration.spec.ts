import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../src/database/prisma.service.js';
import { PrismaEmployeeInsightsRepository } from '../src/modules/employee-insights/infrastructure/prisma-employee-insights.repository.js';
import { PrismaMemoryExperienceRepository } from '../src/modules/memory-experience/infrastructure/prisma/prisma-memory-experience.repository.js';
import type { TrustedRuntimePrincipal } from '../src/modules/process-orchestration/application/runtime-identity.port.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantA = '00000000-0000-7000-8000-000000000e01';
const tenantB = '00000000-0000-7000-8000-000000000e02';
const userA = '00000000-0000-7000-8000-000000000e11';
const otherUserA = '00000000-0000-7000-8000-000000000e12';
const userB = '00000000-0000-7000-8000-000000000e21';
const agentA = '00000000-0000-7000-8000-000000000e31';
const agentOtherA = '00000000-0000-7000-8000-000000000e32';
const agentB = '00000000-0000-7000-8000-000000000e33';
const candidateA = '00000000-0000-7000-8000-000000000e41';
const candidateOtherA = '00000000-0000-7000-8000-000000000e42';
const candidateB = '00000000-0000-7000-8000-000000000e43';
const taskA = '00000000-0000-7000-8000-000000000e51';
const evidenceA = '00000000-0000-7000-8000-000000000e61';

describe.runIf(enabled)('PostgreSQL employee Experience and AI usage isolation', () => {
  const administrator = new PrismaClient();
  const prisma = {
    enabled: true,
    $transaction: administrator.$transaction.bind(administrator),
  } as unknown as PrismaService;
  const insights = new PrismaEmployeeInsightsRepository(prisma);
  const experiences = new PrismaMemoryExperienceRepository(prisma);

  beforeAll(async () => {
    await cleanup();
    await seedRlsFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await administrator.$disconnect();
  });

  it('returns only the current contributor/requester and treats terminal 0/0/0 as unreported', async () => {
    const ownExperiences = await experiences.listExperiencesByContributor(
      principal(tenantA, userA),
      { limit: 25 },
    );
    expect(ownExperiences.items.map(({ id }) => id)).toEqual([candidateA]);

    const otherExperiences = await experiences.listExperiencesByContributor(
      principal(tenantA, otherUserA),
      { limit: 25 },
    );
    expect(otherExperiences.items.map(({ id }) => id)).toEqual([candidateOtherA]);

    const usage = await insights.aiUsage(principal(tenantA, userA), {
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
      groupLimit: 25,
    });
    expect(usage.runs).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
      tokenReported: 1,
      tokenUnreported: 1,
    });
    expect(usage.trustedUsage).toEqual({
      inputTokens: '10',
      outputTokens: '5',
      totalTokens: '15',
      costMicros: '500',
    });
    expect(usage.byAgent).toHaveLength(1);
    expect(JSON.stringify(usage)).not.toContain(otherUserA);
  });

  it('returns zero same-user rows when the tenant context is switched', async () => {
    const crossTenantExperiences = await experiences.listExperiencesByContributor(
      principal(tenantB, userA),
      { limit: 25 },
    );
    const crossTenantUsage = await insights.aiUsage(principal(tenantB, userA), {
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
      groupLimit: 25,
    });
    expect(crossTenantExperiences.items).toEqual([]);
    expect(crossTenantUsage.runs.total).toBe(0);
  });

  it('cannot UPDATE, DELETE, or append a governance transition', async () => {
    await expect(
      employeeWrite(
        tenantA,
        userA,
        Prisma.sql`
          UPDATE public."experience_candidates"
          SET "monitored_use_count" = "monitored_use_count" + 1
          WHERE "id" = ${candidateA}::uuid
        `,
      ),
    ).rejects.toThrow();
    await expect(
      employeeWrite(
        tenantA,
        userA,
        Prisma.sql`
          DELETE FROM public."experience_candidates"
          WHERE "id" = ${candidateA}::uuid
        `,
      ),
    ).rejects.toThrow();
    await expect(
      employeeWrite(
        tenantA,
        userA,
        Prisma.sql`
          INSERT INTO public."experience_commands" (
            "id", "tenant_id", "experience_id", "revision", "expected_revision",
            "action", "target_status", "actor_user_id", "actor_role_assignment_id",
            "reason", "payload", "idempotency_key", "request_hash", "occurred_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantA}::uuid, ${candidateA}::uuid, 2, 1,
            'SANITIZE', 'SANITIZED', ${userA}::uuid, ${randomUUID()}::uuid,
            'forged employee transition', '{}'::jsonb, ${`forged:${randomUUID()}`},
            ${'f'.repeat(64)}, CURRENT_TIMESTAMP
          )
        `,
      ),
    ).rejects.toThrow();
  });

  it('rejects forged contributor, source, audit, and outbox inserts', async () => {
    await expect(
      employeeWrite(tenantA, userA, candidateInsertSql(randomUUID(), otherUserA, randomUUID())),
    ).rejects.toThrow();
    await expect(
      employeeWrite(
        tenantA,
        userA,
        Prisma.sql`
          INSERT INTO public."experience_source_evidence" (
            "tenant_id", "experience_id", "evidence_id", "evidence_version"
          ) VALUES (
            ${tenantA}::uuid, ${candidateA}::uuid, ${randomUUID()}::uuid, 1
          )
        `,
      ),
    ).rejects.toThrow();
    await expect(
      employeeWrite(
        tenantA,
        userA,
        Prisma.sql`
          INSERT INTO public."audit_events" (
            "id", "tenant_id", "actor_type", "actor_id", "action",
            "resource_type", "resource_id", "metadata", "occurred_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantA}::uuid, 'USER', ${userA}::uuid,
            'experience.candidate.created', 'EXPERIENCE', ${randomUUID()}::uuid,
            '{}'::jsonb, CURRENT_TIMESTAMP
          )
        `,
      ),
    ).rejects.toThrow();
    await expect(
      employeeWrite(
        tenantA,
        userA,
        Prisma.sql`
          INSERT INTO public."outbox_events" (
            "id", "tenant_id", "aggregate_type", "aggregate_id",
            "event_type", "payload", "available_at", "created_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantA}::uuid, 'EXPERIENCE',
            ${randomUUID()}::uuid, 'ExperienceCandidateCreated',
            '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `,
      ),
    ).rejects.toThrow();
  });

  async function seedRlsFixtures(): Promise<void> {
    await administrator.tenant.createMany({
      data: [
        { id: tenantA, slug: 'employee-insights-gate-a', name: 'Employee Insights Gate A' },
        { id: tenantB, slug: 'employee-insights-gate-b', name: 'Employee Insights Gate B' },
      ],
    });
    await administrator.user.createMany({
      data: [
        userFixture(tenantA, userA, 'employee-a@gate.invalid'),
        userFixture(tenantA, otherUserA, 'employee-other-a@gate.invalid'),
        userFixture(tenantB, userB, 'employee-b@gate.invalid'),
      ],
    });
    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."agent_instances" (
          "id", "tenant_id", "key", "version_id", "owner_user_id",
          "created_by_id", "name", "status", "settings", "created_at", "updated_at"
        ) VALUES
          (
            ${agentA}::uuid, ${tenantA}::uuid, 'employee-gate-a',
            ${randomUUID()}::uuid, ${userA}::uuid, ${userA}::uuid,
            'Employee Gate Agent', 'ONLINE', '{}'::jsonb,
            '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
          ),
          (
            ${agentOtherA}::uuid, ${tenantA}::uuid, 'employee-gate-other-a',
            ${randomUUID()}::uuid, ${otherUserA}::uuid, ${otherUserA}::uuid,
            'Other Employee Agent', 'ONLINE', '{}'::jsonb,
            '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
          ),
          (
            ${agentB}::uuid, ${tenantB}::uuid, 'employee-gate-b',
            ${randomUUID()}::uuid, ${userB}::uuid, ${userB}::uuid,
            'Cross Tenant Agent', 'ONLINE', '{}'::jsonb,
            '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
          )
      `);
      await transaction.$executeRaw(agentRunInsertSql());
      await transaction.$executeRaw(candidateInsertSql(candidateA, userA, taskA));
      await transaction.$executeRaw(candidateInsertSql(candidateOtherA, otherUserA, randomUUID()));
      await transaction.$executeRaw(candidateInsertSql(candidateB, userB, randomUUID(), tenantB));
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."experience_source_evidence" (
          "tenant_id", "experience_id", "evidence_id", "evidence_version"
        ) VALUES
          (${tenantA}::uuid, ${candidateA}::uuid, ${evidenceA}::uuid, 1),
          (${tenantA}::uuid, ${candidateOtherA}::uuid, ${randomUUID()}::uuid, 1),
          (${tenantB}::uuid, ${candidateB}::uuid, ${randomUUID()}::uuid, 1)
      `);
    });
  }

  async function employeeWrite(
    contextTenantId: string,
    contextUserId: string,
    statement: Prisma.Sql,
  ): Promise<void> {
    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_employee_insights');
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${contextTenantId}, true)`;
      await transaction.$executeRaw`SELECT set_config('app.user_id', ${contextUserId}, true)`;
      await transaction.$executeRaw(statement);
    });
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantA, tenantB]);
  }
});

function principal(tenantId: string, userId: string): TrustedRuntimePrincipal {
  return {
    tenantId,
    userId,
    tenantRole: 'MEMBER',
    authenticationSource: 'development-header',
  };
}

function userFixture(tenantId: string, id: string, email: string) {
  return {
    id,
    tenantId,
    email,
    emailNormalized: email,
    displayName: email.split('@')[0]!,
    role: 'MEMBER' as const,
    status: 'ACTIVE' as const,
  };
}

function candidateInsertSql(
  candidateId: string,
  contributorUserId: string,
  sourceTaskId: string,
  tenantId = tenantA,
): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO public."experience_candidates" (
      "id", "tenant_id", "status", "revision", "title",
      "contributor_user_id", "contributor_role_assignment_id",
      "source_task_id", "source_deliverable_count", "source_evidence_count",
      "raw_input_hash", "candidate_summary", "permission_labels",
      "sensitivity", "idempotency_key", "request_hash",
      "created_at", "updated_at"
    ) VALUES (
      ${candidateId}::uuid, ${tenantId}::uuid, 'CANDIDATE', 1,
      'Governed employee candidate', ${contributorUserId}::uuid,
      ${randomUUID()}::uuid, ${sourceTaskId}::uuid, 0, 1,
      ${'a'.repeat(64)}, 'private contribution fixture',
      '[]'::jsonb, 'INTERNAL', ${`employee-gate:${candidateId}`},
      ${'b'.repeat(64)}, '2026-07-15T00:00:00.000Z',
      '2026-07-15T00:00:00.000Z'
    )
  `;
}

function agentRunInsertSql(): Prisma.Sql {
  const versionA = randomUUID();
  const versionOtherA = randomUUID();
  const versionB = randomUUID();
  return Prisma.sql`
    INSERT INTO public."agent_runs" (
      "id", "tenant_id", "conversation_id", "input_message_id",
      "requester_user_id", "agent_id", "agent_version_id", "status",
      "idempotency_key", "policy_snapshot", "input_tokens", "output_tokens",
      "total_tokens", "cost_micros", "latency_ms", "usage_recorded_at",
      "cost_recorded_at", "finished_at", "created_at", "updated_at"
    ) VALUES
      (
        ${randomUUID()}::uuid, ${tenantA}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${userA}::uuid, ${agentA}::uuid,
        ${versionA}::uuid, 'SUCCEEDED', ${`employee-gate-run:${randomUUID()}`},
        '{}'::jsonb, 10, 5, 15, 500, 120,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:01.000Z', '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:01.000Z'
      ),
      (
        ${randomUUID()}::uuid, ${tenantA}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${userA}::uuid, ${agentA}::uuid,
        ${versionA}::uuid, 'FAILED', ${`employee-gate-run:${randomUUID()}`},
        '{}'::jsonb, 0, 0, 0, 0, 240,
        '2026-07-21T00:00:00.000Z', NULL,
        '2026-07-21T00:00:01.000Z', '2026-07-21T00:00:00.000Z',
        '2026-07-21T00:00:01.000Z'
      ),
      (
        ${randomUUID()}::uuid, ${tenantA}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${otherUserA}::uuid, ${agentOtherA}::uuid,
        ${versionOtherA}::uuid, 'SUCCEEDED', ${`employee-gate-run:${randomUUID()}`},
        '{}'::jsonb, 20, 5, 25, 900, 300,
        '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z',
        '2026-07-22T00:00:01.000Z', '2026-07-22T00:00:00.000Z',
        '2026-07-22T00:00:01.000Z'
      ),
      (
        ${randomUUID()}::uuid, ${tenantB}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${userB}::uuid, ${agentB}::uuid,
        ${versionB}::uuid, 'SUCCEEDED', ${`employee-gate-run:${randomUUID()}`},
        '{}'::jsonb, 30, 10, 40, 1200, 400,
        '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
        '2026-07-23T00:00:01.000Z', '2026-07-23T00:00:00.000Z',
        '2026-07-23T00:00:01.000Z'
      )
  `;
}
