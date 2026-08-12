import { Inject, Injectable } from '@nestjs/common';
import {
  adminOverviewResponseSchema,
  type AdminOverviewAlert,
  type AdminOverviewResponse,
  type AdminOverviewRunWindow,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { AgentOperationalReadinessService } from '../ai-safety-model-routing/agent-operational-readiness.service.js';
import { KnowledgeGateway } from '../knowledge-gateway/knowledge-gateway.port.js';

interface PeopleRow {
  readonly total: number;
  readonly active: number;
  readonly inactive: number;
  readonly locked: number;
  readonly pending_invitations: number;
  readonly active_users_7d: number;
}

interface AgentRow {
  readonly id: string;
  readonly status: 'ONLINE' | 'OFFLINE' | 'DISABLED';
}

interface RunWindowRow {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unknown: number;
  readonly cancelled: number;
  readonly in_progress: number;
  readonly trusted_usage_runs: number;
  readonly unreported_usage_runs: number;
  readonly quota_upper_bound_runs: number;
  readonly input_tokens: string;
  readonly output_tokens: string;
  readonly total_tokens: string;
  readonly quota_charged_tokens: string;
  readonly cost_micros: string;
  readonly latency_sample_count: number;
  readonly average_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly grounded_succeeded_runs: number;
  readonly ungrounded_succeeded_runs: number;
  readonly helpful_feedback: number;
  readonly not_helpful_feedback: number;
}

interface DirectoryRow {
  readonly latest_run_status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER' | null;
  readonly latest_run_finished_at: Date | null;
  readonly failed_runs_24h: number;
  readonly pending_preview_items: number;
}

interface OperationsRow {
  readonly pending_outbox_events: number;
  readonly failed_outbox_events: number;
  readonly unknown_outbox_events: number;
  readonly quarantined_outbox_events: number;
  readonly unknown_agent_runs_24h: number;
}

@Injectable()
export class AdminOverviewService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(AgentOperationalReadinessService)
    private readonly operationalReadiness: AgentOperationalReadinessService,
    @Inject(KnowledgeGateway) private readonly knowledge: KnowledgeGateway,
  ) {}

  async read(): Promise<AdminOverviewResponse> {
    const principal = this.access.requireDirectoryWrite();
    const generatedAt = new Date();
    const todayFrom = startOfUtcDay(generatedAt);
    const monthFrom = new Date(
      Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), 1),
    );
    const [snapshot, knowledge] = await Promise.all([
      this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const people = await transaction.$queryRaw<PeopleRow[]>(Prisma.sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE "status" = 'ACTIVE')::int AS active,
          count(*) FILTER (WHERE "status" = 'INACTIVE')::int AS inactive,
          count(*) FILTER (WHERE "status" = 'LOCKED')::int AS locked,
          (
            SELECT count(DISTINCT invitation."user_id")::int
            FROM public."auth_action_tokens" invitation
            WHERE invitation."tenant_id" = ${principal.tenantId}::uuid
              AND invitation."purpose" = 'MEMBER_INVITATION'
              AND invitation."consumed_at" IS NULL
              AND invitation."revoked_at" IS NULL
              AND invitation."expires_at" > ${generatedAt}
          ) AS pending_invitations
          ,
          (
            SELECT count(DISTINCT session."user_id")::int
            FROM public."auth_sessions" session
            JOIN public."users" active_user
              ON active_user."tenant_id" = session."tenant_id"
             AND active_user."id" = session."user_id"
             AND active_user."status" = 'ACTIVE'
            WHERE session."tenant_id" = ${principal.tenantId}::uuid
              AND session."revoked_at" IS NULL
              AND session."last_used_at" >= ${new Date(generatedAt.getTime() - 7 * 86_400_000)}
          ) AS active_users_7d
        FROM public."users"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
      `);
        const agents = await transaction.$queryRaw<AgentRow[]>(Prisma.sql`
        SELECT "id", "status"::text AS status
        FROM public."agent_instances"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
        ORDER BY "id"
      `);
        const today = await queryRunWindow(transaction, principal.tenantId, todayFrom, generatedAt);
        const month = await queryRunWindow(transaction, principal.tenantId, monthFrom, generatedAt);
        const directory = await transaction.$queryRaw<DirectoryRow[]>(Prisma.sql`
        SELECT
          (
            SELECT "status"::text
            FROM public."directory_sync_runs"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
            ORDER BY "created_at" DESC, "id" DESC
            LIMIT 1
          ) AS latest_run_status,
          (
            SELECT "finished_at"
            FROM public."directory_sync_runs"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
            ORDER BY "created_at" DESC, "id" DESC
            LIMIT 1
          ) AS latest_run_finished_at,
          (
            SELECT count(*)::int
            FROM public."directory_sync_runs"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "status" IN ('FAILED', 'DEAD_LETTER')
              AND "created_at" >= ${new Date(generatedAt.getTime() - 86_400_000)}
          ) AS failed_runs_24h,
          (
            SELECT count(*)::int
            FROM public."directory_sync_preview_items"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "apply_status" IN ('PENDING', 'FAILED')
          ) AS pending_preview_items
      `);
        const operations = await transaction.$queryRaw<OperationsRow[]>(Prisma.sql`
        SELECT
          (
            SELECT count(*)::int
            FROM public."outbox_event_deliveries"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "status" = 'PENDING'
          ) AS pending_outbox_events,
          (
            SELECT count(*)::int
            FROM public."outbox_event_deliveries"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "status" = 'FAILED'
          ) AS failed_outbox_events,
          (
            SELECT count(*)::int
            FROM public."outbox_event_deliveries"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "status" = 'UNKNOWN'
          ) AS unknown_outbox_events,
          (
            SELECT count(*)::int
            FROM public."outbox_events"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "routing_purpose" = 'QUARANTINED'
          ) AS quarantined_outbox_events,
          (
            SELECT count(*)::int
            FROM public."agent_runs"
            WHERE "tenant_id" = ${principal.tenantId}::uuid
              AND "status" = 'UNKNOWN'
              AND "created_at" >= ${new Date(generatedAt.getTime() - 86_400_000)}
          ) AS unknown_agent_runs_24h
      `);
        return {
          people: people[0] ?? emptyPeople(),
          agents,
          today,
          month,
          directory: directory[0] ?? emptyDirectory(),
          operations: operations[0] ?? emptyOperations(),
        };
      }),
      this.knowledge.readOperationalSummary({
        tenantId: principal.tenantId,
        userId: principal.userId,
      }),
    ]);

    const readiness = await this.operationalReadiness.inspectAgents(
      principal.tenantId,
      snapshot.agents.map(({ id }) => id),
    );
    const agentCounts = {
      total: snapshot.agents.length,
      configuredOnline: snapshot.agents.filter(({ status }) => status === 'ONLINE').length,
      available: 0,
      notReady: 0,
      degraded: 0,
      unknown: 0,
    };
    for (const agent of snapshot.agents) {
      const status = readiness.get(agent.id)?.status ?? 'UNKNOWN';
      if (status === 'AVAILABLE') agentCounts.available += 1;
      else if (status === 'NOT_READY') agentCounts.notReady += 1;
      else if (status === 'DEGRADED') agentCounts.degraded += 1;
      else agentCounts.unknown += 1;
    }

    const knowledgeSnapshot = {
      activeBases: knowledge.activeBases,
      totalDocuments: knowledge.totalDocuments,
      readyDocuments: knowledge.readyDocuments,
      failedDocuments: knowledge.failedDocuments,
      pendingParseReviews: knowledge.pendingParseReviews,
      rejectedParseReviews: knowledge.rejectedParseReviews,
      failedIngestionJobs: knowledge.failedIngestionJobs,
      totalChunks: knowledge.totalChunks,
      chunksWithEmbeddings: knowledge.chunksWithEmbeddings,
      chunksMissingEmbeddings: Math.max(0, knowledge.totalChunks - knowledge.chunksWithEmbeddings),
    };
    const operationsSnapshot = {
      pendingOutboxEvents: snapshot.operations.pending_outbox_events,
      failedOutboxEvents: snapshot.operations.failed_outbox_events,
      unknownOutboxEvents: snapshot.operations.unknown_outbox_events,
      quarantinedOutboxEvents: snapshot.operations.quarantined_outbox_events,
      unknownAgentRuns24h: snapshot.operations.unknown_agent_runs_24h,
    };
    const directorySnapshot = {
      latestRunStatus: snapshot.directory.latest_run_status,
      latestRunFinishedAt: snapshot.directory.latest_run_finished_at?.toISOString() ?? null,
      failedRuns24h: snapshot.directory.failed_runs_24h,
      pendingPreviewItems: snapshot.directory.pending_preview_items,
    };
    const result: AdminOverviewResponse = {
      generatedAt: generatedAt.toISOString(),
      people: {
        total: snapshot.people.total,
        active: snapshot.people.active,
        inactive: snapshot.people.inactive,
        locked: snapshot.people.locked,
        pendingInvitations: snapshot.people.pending_invitations,
        activeUsers7d: snapshot.people.active_users_7d,
      },
      agents: agentCounts,
      ai: {
        today: mapRunWindow(todayFrom, snapshot.today),
        month: mapRunWindow(monthFrom, snapshot.month),
      },
      knowledge: knowledgeSnapshot,
      directory: directorySnapshot,
      operations: operationsSnapshot,
      alerts: buildAlerts({
        people: snapshot.people,
        agents: agentCounts,
        today: snapshot.today,
        knowledge: knowledgeSnapshot,
        directory: directorySnapshot,
        operations: operationsSnapshot,
      }),
    };
    return adminOverviewResponseSchema.parse(result);
  }
}

async function queryRunWindow(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<RunWindowRow> {
  const rows = await transaction.$queryRaw<RunWindowRow[]>(Prisma.sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE "status" = 'SUCCEEDED')::int AS succeeded,
      count(*) FILTER (WHERE "status" = 'FAILED')::int AS failed,
      count(*) FILTER (WHERE "status" = 'UNKNOWN')::int AS unknown,
      count(*) FILTER (WHERE "status" = 'CANCELLED')::int AS cancelled,
      count(*) FILTER (
        WHERE "status" IN ('QUEUED', 'DISPATCHING', 'RUNNING')
      )::int AS in_progress,
      count(*) FILTER (
        WHERE "token_evidence" = 'PROVIDER_REPORTED'
          ::public."AgentRunTokenEvidence"
          AND ("input_tokens" > 0 OR "output_tokens" > 0 OR "total_tokens" > 0)
      )::int AS trusted_usage_runs,
      count(*) FILTER (
        WHERE "status" IN ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')
          AND (
            "token_evidence" <> 'PROVIDER_REPORTED'
              ::public."AgentRunTokenEvidence"
            OR ("input_tokens" = 0 AND "output_tokens" = 0 AND "total_tokens" = 0)
          )
      )::int AS unreported_usage_runs,
      count(*) FILTER (
        WHERE "token_evidence" = 'QUOTA_UPPER_BOUND'
          ::public."AgentRunTokenEvidence"
      )::int AS quota_upper_bound_runs,
      COALESCE(
        sum("input_tokens") FILTER (
          WHERE "token_evidence" = 'PROVIDER_REPORTED'
            ::public."AgentRunTokenEvidence"
        ),
        0
      )::text AS input_tokens,
      COALESCE(
        sum("output_tokens") FILTER (
          WHERE "token_evidence" = 'PROVIDER_REPORTED'
            ::public."AgentRunTokenEvidence"
        ),
        0
      )::text AS output_tokens,
      COALESCE(
        sum("total_tokens") FILTER (
          WHERE "token_evidence" = 'PROVIDER_REPORTED'
            ::public."AgentRunTokenEvidence"
        ),
        0
      )::text AS total_tokens,
      COALESCE(
        sum("quota_charged_tokens") FILTER (
          WHERE "token_evidence" = 'QUOTA_UPPER_BOUND'
            ::public."AgentRunTokenEvidence"
        ),
        0
      )::text AS quota_charged_tokens,
      COALESCE(
        sum("cost_micros") FILTER (WHERE "cost_recorded_at" IS NOT NULL),
        0
      )::text AS cost_micros,
      count("latency_ms")::int AS latency_sample_count,
      round(avg("latency_ms"))::int AS average_latency_ms,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latency_ms"))::int
        AS p95_latency_ms,
      count(*) FILTER (
        WHERE run."status" = 'SUCCEEDED'
          AND run."output_message_id" IS NOT NULL
          AND run."grounded_citation_count" > 0
      )::int AS grounded_succeeded_runs,
      count(*) FILTER (
        WHERE run."status" = 'SUCCEEDED'
          AND (
            run."output_message_id" IS NULL
            OR run."grounded_citation_count" = 0
          )
      )::int AS ungrounded_succeeded_runs,
      (
        SELECT count(*)::int
        FROM public."answer_feedbacks" feedback
        JOIN public."agent_runs" feedback_run
          ON feedback_run."tenant_id" = feedback."tenant_id"
         AND feedback_run."output_message_id" = feedback."message_id"
        WHERE feedback."tenant_id" = ${tenantId}::uuid
          AND feedback."rating" = 'HELPFUL'
          AND feedback_run."created_at" >= ${from}
          AND feedback_run."created_at" < ${to}
      ) AS helpful_feedback,
      (
        SELECT count(*)::int
        FROM public."answer_feedbacks" feedback
        JOIN public."agent_runs" feedback_run
          ON feedback_run."tenant_id" = feedback."tenant_id"
         AND feedback_run."output_message_id" = feedback."message_id"
        WHERE feedback."tenant_id" = ${tenantId}::uuid
          AND feedback."rating" = 'NOT_HELPFUL'
          AND feedback_run."created_at" >= ${from}
          AND feedback_run."created_at" < ${to}
      ) AS not_helpful_feedback
    FROM public."agent_runs" run
    WHERE run."tenant_id" = ${tenantId}::uuid
      AND run."created_at" >= ${from}
      AND run."created_at" < ${to}
  `);
  return rows[0] ?? emptyRunWindow();
}

function mapRunWindow(from: Date, row: RunWindowRow): AdminOverviewRunWindow {
  return {
    from: from.toISOString(),
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    unknown: row.unknown,
    cancelled: row.cancelled,
    inProgress: row.in_progress,
    trustedUsageRuns: row.trusted_usage_runs,
    unreportedUsageRuns: row.unreported_usage_runs,
    quotaUpperBoundRuns: row.quota_upper_bound_runs,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    quotaChargedTokens: row.quota_charged_tokens,
    costMicros: row.cost_micros,
    latencySampleCount: row.latency_sample_count,
    averageLatencyMs: row.average_latency_ms,
    p95LatencyMs: row.p95_latency_ms,
    groundedSucceededRuns: row.grounded_succeeded_runs,
    ungroundedSucceededRuns: row.ungrounded_succeeded_runs,
    helpfulFeedback: row.helpful_feedback,
    notHelpfulFeedback: row.not_helpful_feedback,
    feedbackSampleCount: row.helpful_feedback + row.not_helpful_feedback,
    helpfulRateBps:
      row.helpful_feedback + row.not_helpful_feedback === 0
        ? null
        : Math.round(
            (row.helpful_feedback * 10_000) / (row.helpful_feedback + row.not_helpful_feedback),
          ),
  };
}

export function buildAlerts(input: {
  readonly people: PeopleRow;
  readonly agents: {
    readonly notReady: number;
    readonly degraded: number;
    readonly unknown: number;
  };
  readonly today: RunWindowRow;
  readonly knowledge: {
    readonly failedDocuments: number;
    readonly pendingParseReviews: number;
    readonly rejectedParseReviews: number;
    readonly failedIngestionJobs: number;
    readonly chunksMissingEmbeddings: number;
  };
  readonly directory: {
    readonly failedRuns24h: number;
    readonly pendingPreviewItems: number;
  };
  readonly operations: {
    readonly pendingOutboxEvents: number;
    readonly failedOutboxEvents: number;
    readonly unknownOutboxEvents: number;
    readonly quarantinedOutboxEvents: number;
    readonly unknownAgentRuns24h: number;
  };
}): AdminOverviewAlert[] {
  const alerts: AdminOverviewAlert[] = [];
  addAlert(
    alerts,
    input.people.locked,
    'LOCKED_MEMBERS',
    'WARNING',
    '存在锁定成员账号',
    '请核查登录失败、安全事件或账号恢复状态。',
    'members',
  );
  addAlert(
    alerts,
    input.agents.notReady + input.agents.degraded + input.agents.unknown,
    'AGENTS_NOT_OPERATIONALLY_AVAILABLE',
    'CRITICAL',
    '智能体尚未形成真实可用证据',
    '已发布不等于模型可用；请检查可信路由、Runtime 和真实 Provider 成功回执。',
    'ai-model-routing',
  );
  addAlert(
    alerts,
    input.today.failed + input.today.unknown,
    'AI_RUNS_FAILED_OR_UNKNOWN_TODAY',
    'CRITICAL',
    '今日存在失败或结果未确认的 Agent Run',
    'UNKNOWN 结果不得盲目重试，请先完成供应商状态对账。',
    'runtime-governance',
  );
  addAlert(
    alerts,
    input.today.unreported_usage_runs,
    'AI_USAGE_UNREPORTED_TODAY',
    'WARNING',
    '今日存在未上报 Token 或成本的终态 Run',
    '未报告用量不会按 0 计入可信统计，请排查 Provider 回执和结算链路。',
    'runtime-governance',
  );
  addAlert(
    alerts,
    input.knowledge.failedDocuments + input.knowledge.failedIngestionJobs,
    'KNOWLEDGE_INGESTION_FAILURES',
    'CRITICAL',
    '知识文档解析或索引失败',
    '请查看失败阶段、诊断信息并在修复后执行受控重试。',
    'knowledge',
  );
  addAlert(
    alerts,
    input.knowledge.pendingParseReviews,
    'KNOWLEDGE_PARSE_REVIEW_PENDING',
    'WARNING',
    '存在待人工复核的解析版本',
    'FILE/WEB 版本未通过独立复核前不得发布到生产检索。',
    'knowledge',
  );
  addAlert(
    alerts,
    input.knowledge.rejectedParseReviews,
    'KNOWLEDGE_PARSE_REVIEW_REJECTED',
    'WARNING',
    '存在解析复核被驳回的版本',
    '请根据驳回意见重新解析或修正文档来源。',
    'knowledge',
  );
  addAlert(
    alerts,
    input.knowledge.chunksMissingEmbeddings,
    'KNOWLEDGE_CHUNKS_WITHOUT_EMBEDDINGS',
    'WARNING',
    '存在尚无向量的知识切片',
    '该计数只证明是否存在任意向量；指定模型完整性仍以知识就绪探针为准。',
    'knowledge',
  );
  addAlert(
    alerts,
    input.directory.failedRuns24h,
    'DIRECTORY_SYNC_FAILURES_24H',
    'CRITICAL',
    '近 24 小时存在通讯录同步失败',
    '请查看差异项和单条失败原因，确认离职回收及字段边界。',
    'organization',
  );
  addAlert(
    alerts,
    input.directory.pendingPreviewItems,
    'DIRECTORY_PREVIEW_ITEMS_PENDING',
    'INFO',
    '通讯录差异仍待处理',
    '请在同步前复核新增、修改、停用和冲突项。',
    'organization',
  );
  addAlert(
    alerts,
    input.operations.failedOutboxEvents + input.operations.unknownOutboxEvents,
    'OUTBOX_DELIVERY_FAILURES',
    'CRITICAL',
    '事件投递存在失败或结果未确认',
    '请先核实外部副作用，再决定重试或人工对账。',
    'runtime-governance',
  );
  addAlert(
    alerts,
    input.operations.quarantinedOutboxEvents,
    'OUTBOX_EVENT_TYPES_QUARANTINED',
    'CRITICAL',
    '存在未注册的事件类型',
    '事件已进入隔离队列且不会被静默投递；请先登记 fact-only 或明确消费者与 lane。',
    'runtime-governance',
  );
  addAlert(
    alerts,
    input.operations.pendingOutboxEvents,
    'OUTBOX_EVENTS_PENDING',
    'INFO',
    '事件投递队列存在待处理记录',
    '持续积压时请检查 Worker、优先级和下游健康状态。',
    'runtime-governance',
  );
  addAlert(
    alerts,
    input.operations.unknownAgentRuns24h,
    'UNKNOWN_AGENT_RUNS_24H',
    'CRITICAL',
    '近 24 小时存在 UNKNOWN Agent Run',
    '系统未确认供应商是否已产生结果，必须对账后再继续。',
    'runtime-governance',
  );
  return alerts;
}

function addAlert(
  alerts: AdminOverviewAlert[],
  count: number,
  code: string,
  severity: AdminOverviewAlert['severity'],
  title: string,
  description: string,
  target: AdminOverviewAlert['target'],
): void {
  if (count <= 0) return;
  alerts.push({ code, severity, count, title, description, target });
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function emptyPeople(): PeopleRow {
  return {
    total: 0,
    active: 0,
    inactive: 0,
    locked: 0,
    pending_invitations: 0,
    active_users_7d: 0,
  };
}

function emptyRunWindow(): RunWindowRow {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    cancelled: 0,
    in_progress: 0,
    trusted_usage_runs: 0,
    unreported_usage_runs: 0,
    quota_upper_bound_runs: 0,
    input_tokens: '0',
    output_tokens: '0',
    total_tokens: '0',
    quota_charged_tokens: '0',
    cost_micros: '0',
    latency_sample_count: 0,
    average_latency_ms: null,
    p95_latency_ms: null,
    grounded_succeeded_runs: 0,
    ungrounded_succeeded_runs: 0,
    helpful_feedback: 0,
    not_helpful_feedback: 0,
  };
}

function emptyDirectory(): DirectoryRow {
  return {
    latest_run_status: null,
    latest_run_finished_at: null,
    failed_runs_24h: 0,
    pending_preview_items: 0,
  };
}

function emptyOperations(): OperationsRow {
  return {
    pending_outbox_events: 0,
    failed_outbox_events: 0,
    unknown_outbox_events: 0,
    quarantined_outbox_events: 0,
    unknown_agent_runs_24h: 0,
  };
}
