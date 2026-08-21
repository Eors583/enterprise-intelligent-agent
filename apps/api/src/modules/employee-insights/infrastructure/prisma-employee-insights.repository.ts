import { Inject, Injectable } from '@nestjs/common';
import {
  employeeAiUsageSummarySchema,
  employeeExperienceSourceSchema,
  type EmployeeAiUsageSummary,
  type EmployeeExperienceSource,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  EmployeeInsightsRepository,
  type EmployeeUsageWindow,
} from '../employee-insights.repository.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { TrustedRuntimePrincipal } from '../../process-orchestration/application/runtime-identity.port.js';

@Injectable()
export class PrismaEmployeeInsightsRepository extends EmployeeInsightsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async experienceSources(
    principal: TrustedRuntimePrincipal,
    taskId: string,
    now: Date,
  ): Promise<EmployeeExperienceSource | null> {
    return withEmployeeInsights(this.prisma, principal, async (transaction) => {
      const tasks = await transaction.$queryRaw<
        Array<{ id: string; title: string; permission_labels: Prisma.JsonValue }>
      >(Prisma.sql`
        SELECT task."id", task."title", task."permission_labels"
        FROM public."tasks" task
        WHERE task."tenant_id" = ${principal.tenantId}::uuid
          AND task."id" = ${taskId}::uuid
          AND task."status" <> 'CANCELLED'
          AND task."effective_from" <= ${now}
          AND (task."effective_to" IS NULL OR task."effective_to" > ${now})
          AND public.employee_insights_task_authorized(
            task."tenant_id",
            ${principal.userId}::uuid,
            task."id",
            ${now}
          )
        LIMIT 1
      `);
      const task = tasks[0];
      if (task === undefined) return null;

      const deliverables = await transaction.$queryRaw<DeliverableSourceRow[]>(Prisma.sql`
        SELECT
          deliverable."id",
          deliverable."version",
          deliverable."title",
          deliverable."status"::text AS status
        FROM public."deliverables" deliverable
        WHERE deliverable."tenant_id" = ${principal.tenantId}::uuid
          AND deliverable."task_id" = ${taskId}::uuid
          AND deliverable."status" IN ('SUBMITTED', 'ACCEPTED')
          AND deliverable."evidence_sealed_at" IS NOT NULL
        ORDER BY deliverable."updated_at" DESC, deliverable."id"
        LIMIT 200
      `);
      const evidence = await transaction.$queryRaw<EvidenceSourceRow[]>(Prisma.sql`
        SELECT DISTINCT
          evidence."id",
          evidence."version",
          evidence."code",
          evidence."source_type"::text AS source_type,
          evidence."summary",
          evidence."observed_at"
        FROM public."evidence" evidence
        WHERE evidence."tenant_id" = ${principal.tenantId}::uuid
          AND evidence."status" = 'ACTIVE'
          AND evidence."trust_level" = 'VERIFIED'
          AND evidence."verified_at" IS NOT NULL
          AND evidence."effective_from" <= ${now}
          AND (evidence."effective_to" IS NULL OR evidence."effective_to" > ${now})
          AND public.employee_insights_evidence_authorized(
            evidence."tenant_id",
            ${principal.userId}::uuid,
            ${taskId}::uuid,
            evidence."id",
            evidence."version",
            ${now}
          )
        ORDER BY evidence."observed_at" DESC, evidence."id"
        LIMIT 500
      `);
      return employeeExperienceSourceSchema.parse({
        task: {
          id: task.id,
          title: task.title,
          permissionLabels: jsonStringArray(task.permission_labels),
        },
        deliverables,
        evidence: evidence.map((row) => ({
          id: row.id,
          version: row.version,
          code: row.code,
          sourceType: row.source_type,
          summary: row.summary,
          observedAt: row.observed_at.toISOString(),
        })),
      });
    });
  }

  async aiUsage(
    principal: TrustedRuntimePrincipal,
    window: EmployeeUsageWindow,
  ): Promise<
    Pick<EmployeeAiUsageSummary, 'runs' | 'trustedUsage' | 'latency' | 'byAgent' | 'byTask'>
  > {
    return withEmployeeInsights(this.prisma, principal, async (transaction) => {
      const totals = await transaction.$queryRaw<UsageAggregateRow[]>(Prisma.sql`
        SELECT ${usageAggregateSql()}
        FROM public."agent_runs" run
        WHERE run."tenant_id" = ${principal.tenantId}::uuid
          AND run."requester_user_id" = ${principal.userId}::uuid
          AND run."created_at" >= ${window.from}
          AND run."created_at" < ${window.to}
      `);
      const agents = await transaction.$queryRaw<UsageGroupRow[]>(Prisma.sql`
        SELECT
          run."agent_id" AS id,
          agent."name",
          ${usageAggregateSql()}
        FROM public."agent_runs" run
        JOIN public."agent_instances" agent
          ON agent."tenant_id" = run."tenant_id"
         AND agent."id" = run."agent_id"
        WHERE run."tenant_id" = ${principal.tenantId}::uuid
          AND run."requester_user_id" = ${principal.userId}::uuid
          AND run."created_at" >= ${window.from}
          AND run."created_at" < ${window.to}
        GROUP BY run."agent_id", agent."name"
        ORDER BY count(*) DESC, run."agent_id"
        LIMIT ${window.groupLimit}
      `);
      const tasks = await transaction.$queryRaw<UsageGroupRow[]>(Prisma.sql`
        SELECT
          run."task_id" AS id,
          task."title" AS name,
          ${usageAggregateSql()}
        FROM public."agent_runs" run
        LEFT JOIN public."tasks" task
          ON task."tenant_id" = run."tenant_id"
         AND task."id" = run."task_id"
        WHERE run."tenant_id" = ${principal.tenantId}::uuid
          AND run."requester_user_id" = ${principal.userId}::uuid
          AND run."created_at" >= ${window.from}
          AND run."created_at" < ${window.to}
        GROUP BY run."task_id", task."title"
        ORDER BY count(*) DESC, run."task_id" NULLS LAST
        LIMIT ${window.groupLimit}
      `);
      const total = totals[0] ?? emptyUsageAggregate();
      const response = {
        runs: runCounts(total),
        trustedUsage: trustedUsage(total),
        latency: latency(total),
        byAgent: agents.map(usageGroup),
        byTask: tasks.map(usageGroup),
      };
      const parsed = employeeAiUsageSummarySchema
        .pick({
          runs: true,
          trustedUsage: true,
          latency: true,
          byAgent: true,
          byTask: true,
        })
        .parse(response);
      return parsed;
    });
  }
}

async function withEmployeeInsights<T>(
  prisma: PrismaService,
  principal: TrustedRuntimePrincipal,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!prisma.enabled) {
    throw new Error('Employee Insights requires the Prisma repository adapter.');
  }
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_employee_insights');
    await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`;
    await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
    return operation(transaction);
  });
}

function usageAggregateSql(): Prisma.Sql {
  return Prisma.sql`
    count(*)::int AS "total",
    count(*) FILTER (WHERE run."status" = 'SUCCEEDED')::int AS "succeeded",
    count(*) FILTER (WHERE run."status" = 'FAILED')::int AS "failed",
    count(*) FILTER (WHERE run."status" = 'UNKNOWN')::int AS "unknown",
    count(*) FILTER (WHERE run."status" = 'CANCELLED')::int AS "cancelled",
    count(*) FILTER (
      WHERE run."status" IN ('QUEUED', 'DISPATCHING', 'RUNNING')
    )::int AS "in_progress",
    count(*) FILTER (
      WHERE run."status" IN ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')
        AND run."usage_recorded_at" IS NOT NULL
        AND (
          run."input_tokens" > 0
          OR run."output_tokens" > 0
          OR run."total_tokens" > 0
        )
    )::int AS "token_reported",
    count(*) FILTER (
      WHERE run."status" IN ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')
        AND (
          run."usage_recorded_at" IS NULL
          OR (
            run."input_tokens" = 0
            AND run."output_tokens" = 0
            AND run."total_tokens" = 0
          )
        )
    )::int AS "token_unreported",
    count(*) FILTER (
      WHERE run."status" IN ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')
        AND run."cost_recorded_at" IS NOT NULL
    )::int AS "cost_reported",
    count(*) FILTER (
      WHERE run."status" IN ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')
        AND run."cost_recorded_at" IS NULL
    )::int AS "cost_unreported",
    COALESCE(
      sum(run."input_tokens") FILTER (
        WHERE run."usage_recorded_at" IS NOT NULL
          AND (
            run."input_tokens" > 0
            OR run."output_tokens" > 0
            OR run."total_tokens" > 0
          )
      ),
      0
    )::text AS "input_tokens",
    COALESCE(
      sum(run."output_tokens") FILTER (
        WHERE run."usage_recorded_at" IS NOT NULL
          AND (
            run."input_tokens" > 0
            OR run."output_tokens" > 0
            OR run."total_tokens" > 0
          )
      ),
      0
    )::text AS "output_tokens",
    COALESCE(
      sum(run."total_tokens") FILTER (
        WHERE run."usage_recorded_at" IS NOT NULL
          AND (
            run."input_tokens" > 0
            OR run."output_tokens" > 0
            OR run."total_tokens" > 0
          )
      ),
      0
    )::text AS "total_tokens",
    COALESCE(
      sum(run."cost_micros") FILTER (WHERE run."cost_recorded_at" IS NOT NULL),
      0
    )::text AS "cost_micros",
    count(run."latency_ms")::int AS "latency_samples",
    round(avg(run."latency_ms"))::int AS "average_latency_ms",
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY run."latency_ms"))::int
      AS "p50_latency_ms",
    round(percentile_cont(0.95) WITHIN GROUP (ORDER BY run."latency_ms"))::int
      AS "p95_latency_ms"
  `;
}

function runCounts(row: UsageAggregateRow) {
  return {
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    unknown: row.unknown,
    cancelled: row.cancelled,
    inProgress: row.in_progress,
    tokenReported: row.token_reported,
    tokenUnreported: row.token_unreported,
    costReported: row.cost_reported,
    costUnreported: row.cost_unreported,
  };
}

function trustedUsage(row: UsageAggregateRow) {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costMicros: row.cost_micros,
  };
}

function latency(row: UsageAggregateRow) {
  return {
    sampleCount: row.latency_samples,
    averageMs: row.average_latency_ms,
    p50Ms: row.p50_latency_ms,
    p95Ms: row.p95_latency_ms,
  };
}

function usageGroup(row: UsageGroupRow) {
  return {
    id: row.id,
    name: row.name,
    runs: runCounts(row),
    trustedUsage: trustedUsage(row),
    latency: latency(row),
  };
}

function emptyUsageAggregate(): UsageAggregateRow {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    cancelled: 0,
    in_progress: 0,
    token_reported: 0,
    token_unreported: 0,
    cost_reported: 0,
    cost_unreported: 0,
    input_tokens: '0',
    output_tokens: '0',
    total_tokens: '0',
    cost_micros: '0',
    latency_samples: 0,
    average_latency_ms: null,
    p50_latency_ms: null,
    p95_latency_ms: null,
  };
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

interface UsageAggregateRow {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unknown: number;
  readonly cancelled: number;
  readonly in_progress: number;
  readonly token_reported: number;
  readonly token_unreported: number;
  readonly cost_reported: number;
  readonly cost_unreported: number;
  readonly input_tokens: string;
  readonly output_tokens: string;
  readonly total_tokens: string;
  readonly cost_micros: string;
  readonly latency_samples: number;
  readonly average_latency_ms: number | null;
  readonly p50_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
}

interface UsageGroupRow extends UsageAggregateRow {
  readonly id: string | null;
  readonly name: string | null;
}

interface DeliverableSourceRow {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly status: 'SUBMITTED' | 'ACCEPTED';
}

interface EvidenceSourceRow {
  readonly id: string;
  readonly version: number;
  readonly code: string;
  readonly source_type: string;
  readonly summary: string;
  readonly observed_at: Date;
}
