import { Prisma, PrismaClient } from '@prisma/client';

import { PrismaService } from '../src/database/prisma.service.js';
import { PrismaFinopsAutoProjectionReconciler } from '../src/modules/finance-finops/finops-auto-projection.reconciler.js';
import { cleanupDisposableTenants } from './database-test-harness.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantA = '00000000-0000-7000-8000-00000000f101';
const tenantB = '00000000-0000-7000-8000-00000000f102';
const makerA = '00000000-0000-7000-8000-00000000f111';
const checkerA = '00000000-0000-7000-8000-00000000f112';
const userB = '00000000-0000-7000-8000-00000000f113';
const goodRun = '00000000-0000-7000-8000-00000000f121';
const missingPriceRun = '00000000-0000-7000-8000-00000000f122';
const unknownRun = '00000000-0000-7000-8000-00000000f123';
const emptyUsageRun = '00000000-0000-7000-8000-00000000f124';
const tenantBRun = '00000000-0000-7000-8000-00000000f125';
const toolDefinition = '00000000-0000-7000-8000-00000000f131';
const toolVersion = '00000000-0000-7000-8000-00000000f132';
const toolInvocation = '00000000-0000-7000-8000-00000000f133';
const toolReceipt = '00000000-0000-7000-8000-00000000f134';
const taskId = '00000000-0000-7000-8000-00000000f141';
const roleAssignmentId = '00000000-0000-7000-8000-00000000f142';
const agentId = '00000000-0000-7000-8000-00000000f143';
const agentVersionId = '00000000-0000-7000-8000-00000000f144';
const occurredAt = new Date('2026-07-28T08:00:00.000Z');

describe.runIf(enabled)('PostgreSQL automatic trusted FinOps projection', () => {
  const administrator = new PrismaClient();
  const prisma = {
    enabled: true,
    $transaction: administrator.$transaction.bind(administrator),
  } as unknown as PrismaService;
  const reconciler = new PrismaFinopsAutoProjectionReconciler(prisma);

  beforeAll(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await administrator.$disconnect();
  });

  it('projects exact Agent Run and Tool settlement prices once with Audit + Outbox', async () => {
    await expect(
      reconciler.reconcileBatch({
        workerId: 'finops-pg-e2e-a',
        batchSize: 20,
        claimTtlMs: 30_000,
      }),
    ).resolves.toBe(6);

    const entries = await administrator.finopsCostEntry.findMany({
      where: { tenantId: tenantA },
      orderBy: [{ subjectType: 'asc' }, { idempotencyKey: 'asc' }],
    });
    expect(entries).toHaveLength(3);
    expect(
      entries.map((entry) => ({
        subjectType: entry.subjectType,
        resourceKind: entry.resourceKind,
        amount: entry.calculatedAmount.toFixed(),
        verification: entry.verificationStatus,
        sourceAuthority: entry.sourceAuthority,
      })),
    ).toEqual([
      {
        subjectType: 'AGENT_RUN',
        resourceKind: 'MODEL',
        amount: '0.001',
        verification: 'VERIFIED',
        sourceAuthority: 'RUNTIME_ATTESTED',
      },
      {
        subjectType: 'AGENT_RUN',
        resourceKind: 'MODEL',
        amount: '0.001',
        verification: 'VERIFIED',
        sourceAuthority: 'RUNTIME_ATTESTED',
      },
      {
        subjectType: 'TOOL_INVOCATION',
        resourceKind: 'TOOL',
        amount: '0.000025',
        verification: 'VERIFIED',
        sourceAuthority: 'TRUSTED_SYSTEM',
      },
    ]);
    expect(
      entries.find(({ toolInvocationId }) => toolInvocationId !== null)?.rawUsage,
    ).toMatchObject({
      provider: 'INTERNAL',
      sku: 'crm.customer.read',
      dimensions: { taskId, roleAssignmentId },
    });

    const [projectedJobs, auditCount, outboxCount] = await Promise.all([
      administrator.finopsProjectionJob.count({
        where: { tenantId: tenantA, status: 'PROJECTED' },
      }),
      administrator.auditEvent.count({
        where: { tenantId: tenantA, action: 'finops.cost.auto_projected' },
      }),
      administrator.outboxEvent.count({
        where: { tenantId: tenantA, eventType: 'finops.cost.auto_projected.v1' },
      }),
    ]);
    expect(projectedJobs).toBe(2);
    expect(auditCount).toBe(3);
    expect(outboxCount).toBe(3);

    await expect(
      Promise.all([
        reconciler.reconcileBatch({
          workerId: 'finops-pg-e2e-b',
          batchSize: 20,
          claimTtlMs: 30_000,
        }),
        reconciler.reconcileBatch({
          workerId: 'finops-pg-e2e-c',
          batchSize: 20,
          claimTtlMs: 30_000,
        }),
      ]),
    ).resolves.toEqual([0, 0]);
    expect(await administrator.finopsCostEntry.count({ where: { tenantId: tenantA } })).toBe(3);
  });

  it('keeps missing price, UNKNOWN, 0/0/0 and cross-tenant sources outside trusted cost', async () => {
    const diagnostics = await administrator.finopsProjectionDiagnostic.findMany({
      where: { tenantId: tenantA, status: 'OPEN' },
      orderBy: [{ sourceId: 'asc' }, { code: 'asc' }],
    });
    expect(diagnostics.map(({ sourceId, code }) => ({ sourceId, code }))).toEqual(
      expect.arrayContaining([
        { sourceId: missingPriceRun, code: 'PRICE_MISSING' },
        { sourceId: unknownRun, code: 'SOURCE_UNKNOWN' },
        { sourceId: emptyUsageRun, code: 'USAGE_UNREPORTED' },
      ]),
    );
    expect(
      await administrator.finopsCostEntry.count({
        where: {
          tenantId: tenantA,
          subjectId: { in: [missingPriceRun, unknownRun, emptyUsageRun] },
        },
      }),
    ).toBe(0);
    expect(await administrator.finopsCostEntry.count({ where: { tenantId: tenantB } })).toBe(0);
  });

  it('enforces tenant RLS and denies projector price mutation or forged events', async () => {
    const tenantAJobs = await projectorRows<{ count: bigint }>(
      tenantA,
      Prisma.sql`SELECT count(*)::bigint AS "count" FROM public."finops_projection_jobs"`,
    );
    const tenantBJobsThroughA = await projectorRows<{ count: bigint }>(
      tenantA,
      Prisma.sql`
        SELECT count(*)::bigint AS "count"
        FROM public."finops_projection_jobs"
        WHERE "tenant_id" = ${tenantB}::uuid
      `,
    );
    expect(Number(tenantAJobs[0]?.count)).toBe(5);
    expect(Number(tenantBJobsThroughA[0]?.count)).toBe(0);

    await expect(
      projectorExecute(
        tenantA,
        Prisma.sql`
          UPDATE public."finops_price_snapshots"
          SET "unit_price" = 0
          WHERE "tenant_id" = ${tenantA}::uuid
        `,
      ),
    ).rejects.toThrow();
    await expect(
      projectorExecute(
        tenantA,
        Prisma.sql`
          DELETE FROM public."finops_cost_entries"
          WHERE "tenant_id" = ${tenantA}::uuid
        `,
      ),
    ).rejects.toThrow();
    await expect(
      projectorExecute(
        tenantA,
        Prisma.sql`
          INSERT INTO public."audit_events" (
            "id", "tenant_id", "actor_type", "actor_id", "action",
            "resource_type", "resource_id", "metadata"
          ) VALUES (
            gen_random_uuid(), ${tenantA}::uuid, 'SERVICE',
            gen_random_uuid(), 'finops.cost.auto_projected',
            'FINOPS_COST_ENTRY', gen_random_uuid(), '{}'::jsonb
          )
        `,
      ),
    ).rejects.toThrow();
  });

  async function projectorRows<T>(tenantId: string, statement: Prisma.Sql): Promise<T[]> {
    return administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_finops_projector');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return transaction.$queryRaw<T[]>(statement);
    });
  }

  async function projectorExecute(tenantId: string, statement: Prisma.Sql): Promise<void> {
    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_finops_projector');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await transaction.$executeRaw(statement);
    });
  }

  async function seed(): Promise<void> {
    await administrator.tenant.createMany({
      data: [
        { id: tenantA, slug: 'finops-auto-projection-a', name: 'FinOps Auto Projection A' },
        { id: tenantB, slug: 'finops-auto-projection-b', name: 'FinOps Auto Projection B' },
      ],
    });
    await administrator.user.createMany({
      data: [
        user(tenantA, makerA, 'finops-maker-a@test.invalid'),
        user(tenantA, checkerA, 'finops-checker-a@test.invalid'),
        user(tenantB, userB, 'finops-user-b@test.invalid'),
      ],
    });
    await administrator.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await transaction.$executeRaw(
        agentRunSql(goodRun, tenantA, makerA, 'openai', 'gpt-enterprise', {
          status: 'SUCCEEDED',
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          costMicros: 2_000n,
        }),
      );
      await transaction.$executeRaw(
        agentRunSql(missingPriceRun, tenantA, makerA, 'unpriced-provider', 'unpriced-model', {
          status: 'SUCCEEDED',
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costMicros: 99n,
        }),
      );
      await transaction.$executeRaw(
        agentRunSql(unknownRun, tenantA, makerA, 'openai', 'gpt-enterprise', {
          status: 'UNKNOWN',
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costMicros: 99n,
        }),
      );
      await transaction.$executeRaw(
        agentRunSql(emptyUsageRun, tenantA, makerA, 'openai', 'gpt-enterprise', {
          status: 'FAILED',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costMicros: 0n,
        }),
      );
      await transaction.$executeRaw(
        agentRunSql(tenantBRun, tenantB, userB, 'none', 'none', {
          status: 'UNKNOWN',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costMicros: 0n,
        }),
      );
      for (const statement of toolFixtureSql()) {
        await transaction.$executeRaw(statement);
      }
      await transaction.$executeRaw(priceFixturesSql());
    });
  }

  async function cleanup(): Promise<void> {
    await cleanupDisposableTenants(administrator, [tenantA, tenantB]);
  }
});

function user(tenantId: string, id: string, email: string) {
  return {
    id,
    tenantId,
    email,
    emailNormalized: email,
    displayName: email,
    role: 'MEMBER' as const,
    status: 'ACTIVE' as const,
  };
}

function agentRunSql(
  id: string,
  tenantId: string,
  requesterUserId: string,
  provider: string,
  model: string,
  usage: {
    readonly status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costMicros: bigint;
  },
): Prisma.Sql {
  const finishedAt = usage.status === 'UNKNOWN' ? null : occurredAt;
  const tokenEvidence =
    usage.status !== 'UNKNOWN' && usage.totalTokens > 0 ? 'PROVIDER_REPORTED' : 'UNREPORTED';
  return Prisma.sql`
    INSERT INTO public."agent_runs" (
      "id", "tenant_id", "task_id", "conversation_id", "input_message_id",
      "output_message_id", "requester_user_id", "agent_id", "agent_version_id",
      "trigger", "status", "provider", "idempotency_key", "policy_snapshot",
      "attempts", "version", "runtime_provider", "runtime_model",
      "input_tokens", "output_tokens", "total_tokens", "tool_calls",
      "cost_micros", "latency_ms", "reserved_tokens",
      "usage_recorded_at", "cost_recorded_at", "started_at", "finished_at",
      "created_at", "updated_at", "token_evidence"
    ) VALUES (
      ${id}::uuid, ${tenantId}::uuid, ${taskId}::uuid,
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
      ${requesterUserId}::uuid, ${agentId}::uuid, ${agentVersionId}::uuid,
      'USER_MESSAGE', ${usage.status}::public."AgentRunStatus",
      'ai-runtime', ${`finops-projection:${id}`}, '{}'::jsonb,
      1, 4, ${provider}, ${model},
      ${usage.inputTokens}, ${usage.outputTokens}, ${usage.totalTokens}, 0,
      ${usage.costMicros}, 500, 0,
      ${occurredAt}, ${occurredAt}, ${occurredAt}, ${finishedAt},
      ${occurredAt}, ${occurredAt},
      ${tokenEvidence}::public."AgentRunTokenEvidence"
    )
  `;
}

function toolFixtureSql(): readonly Prisma.Sql[] {
  return [
    Prisma.sql`
    INSERT INTO public."tool_definitions" (
      "id", "tenant_id", "key", "name", "description", "owner_user_id",
      "status", "current_version_id", "current_version", "revision",
      "permission_labels", "created_at", "updated_at"
    ) VALUES (
      ${toolDefinition}::uuid, ${tenantA}::uuid, 'crm.customer.read',
      'CRM customer read', 'Test governed Tool', ${makerA}::uuid,
      'PUBLISHED', ${toolVersion}::uuid, 1, 1, '[]'::jsonb,
      ${occurredAt}, ${occurredAt}
    )
    `,
    Prisma.sql`
    INSERT INTO public."tool_versions" (
      "id", "tenant_id", "tool_id", "version", "key", "name", "description",
      "owner_user_id", "status", "adapter", "endpoint_ref",
      "input_schema", "output_schema", "risk_class", "data_classification",
      "timeout_ms", "max_attempts", "idempotency_mode", "dry_run_mode",
      "allowed_http_methods", "allowed_host_patterns", "sensitive_input_paths",
      "configuration_hash", "effective_from", "published_at",
      "created_by_user_id", "created_at"
    ) VALUES (
      ${toolVersion}::uuid, ${tenantA}::uuid, ${toolDefinition}::uuid, 1,
      'crm.customer.read', 'CRM customer read', 'Test governed Tool',
      ${makerA}::uuid, 'PUBLISHED', 'INTERNAL', 'internal://crm/customer',
      '{"type":"object","additionalProperties":false}'::jsonb,
      '{"type":"object","additionalProperties":false}'::jsonb,
      'READ_ONLY', 'INTERNAL', 1000, 1, 'REQUIRED', 'UNSUPPORTED',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ${'a'.repeat(64)},
      ${occurredAt}, ${occurredAt}, ${makerA}::uuid, ${occurredAt}
    )
    `,
    Prisma.sql`
    INSERT INTO public."tool_invocations" (
      "id", "tenant_id", "tool_id", "tool_version_id", "tool_version",
      "tool_configuration_hash", "adapter", "risk_class", "data_classification",
      "idempotency_mode", "dry_run_mode", "requester_user_id",
      "role_assignment_id", "task_id", "correlation_id", "status", "revision",
      "dry_run", "provider_dispatch_allowed", "provider_dry_run",
      "input", "input_hash", "redacted_input_summary", "policy_decision_id",
      "policy_snapshot", "execution_attempt", "provider_request_id",
      "output", "output_hash", "started_at", "completed_at",
      "idempotency_key", "created_at", "updated_at"
    ) VALUES (
      ${toolInvocation}::uuid, ${tenantA}::uuid, ${toolDefinition}::uuid,
      ${toolVersion}::uuid, 1, ${'a'.repeat(64)}, 'INTERNAL', 'READ_ONLY',
      'INTERNAL', 'REQUIRED', 'UNSUPPORTED', ${makerA}::uuid,
      ${roleAssignmentId}::uuid, ${taskId}::uuid, gen_random_uuid(),
      'SUCCEEDED', 3, false, true, false,
      '{"customerId":"customer-1"}'::jsonb, ${'b'.repeat(64)},
      '{"customerId":"***"}'::jsonb, 'policy-test', '{}'::jsonb,
      1, 'provider-tool-1', '{"name":"Blue Ocean"}'::jsonb, ${'c'.repeat(64)},
      ${occurredAt}, ${new Date(occurredAt.getTime() + 1_000)},
      'finops-tool-1', ${occurredAt}, ${new Date(occurredAt.getTime() + 1_000)}
    )
    `,
    Prisma.sql`
    INSERT INTO public."tool_execution_receipts" (
      "id", "tenant_id", "tool_invocation_id", "invocation_revision",
      "execution_attempt", "source", "outcome", "provider_request_id",
      "input_hash", "request_hash", "response_hash", "provider_dry_run",
      "draft_output", "started_at", "completed_at", "latency_ms",
      "cost_micros", "cost_attestation", "receipt_hash", "created_at"
    ) VALUES (
      ${toolReceipt}::uuid, ${tenantA}::uuid, ${toolInvocation}::uuid, 3,
      1, 'PROVIDER', 'SUCCEEDED', 'provider-tool-1',
      ${'b'.repeat(64)}, ${'d'.repeat(64)}, ${'c'.repeat(64)}, false,
      false, ${occurredAt}, ${new Date(occurredAt.getTime() + 1_000)}, 1000,
      NULL, 'UNATTESTED', ${'e'.repeat(64)}, ${new Date(occurredAt.getTime() + 1_000)}
    )
    `,
  ];
}

function priceFixturesSql(): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO public."finops_price_snapshots" (
      "id", "tenant_id", "code", "version", "revision", "resource_kind",
      "provider", "sku", "currency", "billing_unit", "unit_size", "unit_price",
      "effective_from", "status", "source_authority", "source_system",
      "source_record_id", "source_record_version", "source_content_hash",
      "created_by_user_id", "approved_by_user_id", "approval_comment",
      "approved_at", "idempotency_key", "request_hash", "created_at"
    ) VALUES
      (
        gen_random_uuid(), ${tenantA}::uuid, 'MODEL.INPUT', 1, 2, 'MODEL',
        'openai', 'gpt-enterprise', 'CNY', 'INPUT_TOKEN', 1000000, 5,
        '2026-07-01T00:00:00.000Z', 'APPROVED', 'TRUSTED_SYSTEM',
        'pricing-test', 'model-input', '1', ${'1'.repeat(64)},
        ${makerA}::uuid, ${checkerA}::uuid, 'approved for test',
        '2026-07-02T00:00:00.000Z', 'price-model-input', ${'2'.repeat(64)},
        '2026-07-01T00:00:00.000Z'
      ),
      (
        gen_random_uuid(), ${tenantA}::uuid, 'MODEL.OUTPUT', 2, 2, 'MODEL',
        'openai', 'gpt-enterprise', 'CNY', 'OUTPUT_TOKEN', 1000000, 10,
        '2026-07-01T00:00:00.000Z', 'APPROVED', 'TRUSTED_SYSTEM',
        'pricing-test', 'model-output', '1', ${'3'.repeat(64)},
        ${makerA}::uuid, ${checkerA}::uuid, 'approved for test',
        '2026-07-02T00:00:00.000Z', 'price-model-output', ${'4'.repeat(64)},
        '2026-07-01T00:00:00.000Z'
      ),
      (
        gen_random_uuid(), ${tenantA}::uuid, 'TOOL.CRM.READ', 1, 2, 'TOOL',
        'INTERNAL', 'crm.customer.read', 'CNY', 'CALL', 1, 0.000025,
        '2026-07-01T00:00:00.000Z', 'APPROVED', 'TRUSTED_SYSTEM',
        'pricing-test', 'tool-crm-read', '1', ${'5'.repeat(64)},
        ${makerA}::uuid, ${checkerA}::uuid, 'approved for test',
        '2026-07-02T00:00:00.000Z', 'price-tool-crm-read', ${'6'.repeat(64)},
        '2026-07-01T00:00:00.000Z'
      )
  `;
}
