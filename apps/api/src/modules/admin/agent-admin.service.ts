import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminAgent,
  AdminAgentListResponse,
  AdminAgentUsageSummary,
  AgentUsageLimits,
  UpdateAdminAgentRequest,
  UpdateAgentUsageLimitsRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from './admin-access.service.js';
import { AGENT_RUN_CONCURRENCY_HOLD_STATUSES } from '../agent-run/domain/agent-run-quota.js';
import { recordAdminAudit } from './admin-audit.js';

type AgentRecord = Prisma.AgentInstanceGetPayload<{
  include: {
    owner: { select: { id: true; displayName: true; status: true } };
    version: true;
    runs: { orderBy: { createdAt: 'desc' }; take: 1 };
  };
}>;

interface TokenEvidenceSummaryRow {
  readonly unverified_usage_runs: number;
  readonly quota_upper_bound_runs: number;
  readonly quota_charged_tokens: bigint;
}

@Injectable()
export class AgentAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
  ) {}

  async list(): Promise<AdminAgentListResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const agents = await transaction.agentInstance.findMany({
        where: { tenantId: principal.tenantId, ownerUserId: { not: null } },
        include: agentInclude,
        orderBy: [{ owner: { displayName: 'asc' } }, { id: 'asc' }],
      });
      return { items: agents.map(mapAgent) };
    });
  }

  async usageSummary(): Promise<AdminAgentUsageSummary> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const generatedAt = new Date();
      const periodStart = new Date(
        Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), 1),
      );
      const minuteStart = new Date(generatedAt.getTime() - 60_000);
      const tenant = await transaction.tenant.findFirst({
        where: { id: principal.tenantId },
        select: {
          agentRunConcurrencyLimit: true,
          agentRunRateLimitPerMinute: true,
          agentRunMonthlyTokenLimit: true,
          updatedAt: true,
        },
      });
      if (tenant === null) throw new NotFoundException('The tenant was not found.');

      // UNKNOWN remains an active concurrency hold until a trusted reconciliation
      // changes the Run status. Age alone cannot prove that provider work stopped.
      const activeRuns = await transaction.agentRun.count({
        where: {
          tenantId: principal.tenantId,
          status: { in: [...AGENT_RUN_CONCURRENCY_HOLD_STATUSES] },
        },
      });
      const runsLastMinute = await transaction.agentRun.count({
        where: { tenantId: principal.tenantId, dispatchStartedAt: { gte: minuteStart } },
      });
      const completedRuns = await transaction.agentRun.count({
        where: {
          tenantId: principal.tenantId,
          status: 'SUCCEEDED',
          finishedAt: { gte: periodStart },
        },
      });
      const failedRuns = await transaction.agentRun.count({
        where: {
          tenantId: principal.tenantId,
          status: { in: ['FAILED', 'CANCELLED'] },
          finishedAt: { gte: periodStart },
        },
      });
      const unknownRuns = await transaction.agentRun.count({
        where: {
          tenantId: principal.tenantId,
          status: 'UNKNOWN',
          finishedAt: { gte: periodStart },
        },
      });
      const [tokenEvidence] = await transaction.$queryRaw<TokenEvidenceSummaryRow[]>(Prisma.sql`
        SELECT
          count(*) FILTER (
            WHERE "finished_at" >= ${periodStart}
              AND "runtime_provider" IS NOT NULL
              AND "token_evidence" <> 'PROVIDER_REPORTED'
                ::public."AgentRunTokenEvidence"
          )::int AS unverified_usage_runs,
          count(*) FILTER (
            WHERE "quota_settled_at" >= ${periodStart}
              AND "token_evidence" = 'QUOTA_UPPER_BOUND'
                ::public."AgentRunTokenEvidence"
          )::int AS quota_upper_bound_runs,
          COALESCE(sum("quota_charged_tokens") FILTER (
            WHERE "quota_settled_at" >= ${periodStart}
              AND "token_evidence" = 'QUOTA_UPPER_BOUND'
                ::public."AgentRunTokenEvidence"
          ), 0)::bigint AS quota_charged_tokens
        FROM public."agent_runs"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
      `);
      const unreportedCostRuns = await transaction.agentRun.count({
        where: {
          tenantId: principal.tenantId,
          finishedAt: { gte: periodStart },
          runtimeProvider: { not: null },
          costRecordedAt: null,
        },
      });
      const usage = await transaction.agentRun.aggregate({
        where: {
          tenantId: principal.tenantId,
          finishedAt: { gte: periodStart },
          usageRecordedAt: { not: null },
          status: { not: 'UNKNOWN' },
        },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costMicros: true,
        },
        _avg: { latencyMs: true },
      });
      const reservations = await transaction.agentRun.aggregate({
        where: { tenantId: principal.tenantId, reservedTokens: { gt: 0 } },
        _sum: { reservedTokens: true },
      });
      const groups = await transaction.agentRun.groupBy({
        by: ['runtimeProvider', 'runtimeModel'],
        where: {
          tenantId: principal.tenantId,
          finishedAt: { gte: periodStart },
          usageRecordedAt: { not: null },
          status: { not: 'UNKNOWN' },
        },
        _count: { _all: true },
        _sum: { totalTokens: true, costMicros: true },
        _avg: { latencyMs: true },
      });

      return {
        periodStart: periodStart.toISOString(),
        generatedAt: generatedAt.toISOString(),
        limits: {
          concurrentRuns: tenant.agentRunConcurrencyLimit,
          runsPerMinute: tenant.agentRunRateLimitPerMinute,
          monthlyTokens: tenant.agentRunMonthlyTokenLimit.toString(),
          updatedAt: tenant.updatedAt.toISOString(),
        },
        current: {
          activeRuns,
          runsLastMinute,
          completedRuns,
          failedRuns,
          unknownRuns,
          unverifiedUsageRuns: tokenEvidence?.unverified_usage_runs ?? 0,
          quotaUpperBoundRuns: tokenEvidence?.quota_upper_bound_runs ?? 0,
          unreportedCostRuns,
          inputTokens: String(usage._sum.inputTokens ?? 0),
          outputTokens: String(usage._sum.outputTokens ?? 0),
          totalTokens: String(usage._sum.totalTokens ?? 0),
          quotaChargedTokens: String(tokenEvidence?.quota_charged_tokens ?? 0n),
          reservedTokens: String(reservations._sum.reservedTokens ?? 0),
          costMicros: (usage._sum.costMicros ?? 0n).toString(),
          averageLatencyMs: roundedMetric(usage._avg.latencyMs),
        },
        byProviderModel: groups
          .map((group) => ({
            provider: group.runtimeProvider,
            model: group.runtimeModel,
            runCount: group._count._all,
            totalTokens: String(group._sum.totalTokens ?? 0),
            costMicros: (group._sum.costMicros ?? 0n).toString(),
            averageLatencyMs: roundedMetric(group._avg.latencyMs),
          }))
          .sort((left, right) => {
            const leftTokens = BigInt(left.totalTokens);
            const rightTokens = BigInt(right.totalTokens);
            if (leftTokens !== rightTokens) return leftTokens > rightTokens ? -1 : 1;
            return (
              (left.provider ?? '').localeCompare(right.provider ?? '') ||
              (left.model ?? '').localeCompare(right.model ?? '')
            );
          }),
      };
    });
  }

  async updateUsageLimits(request: UpdateAgentUsageLimitsRequest): Promise<AgentUsageLimits> {
    const principal = this.access.requireDirectoryWrite();
    if (principal.role !== 'OWNER') {
      throw new ForbiddenException('Only a tenant owner can change Agent Run limits.');
    }
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${principal.tenantId}:agent-run-quota`}, 0))::text
      `;
      const current = await transaction.tenant.findFirst({
        where: { id: principal.tenantId },
        select: { updatedAt: true },
      });
      if (current === null) throw new NotFoundException('The tenant was not found.');
      if (current.updatedAt.toISOString() !== request.expectedUpdatedAt) {
        throw new ConflictException('Agent Run limits changed. Refresh and try again.');
      }
      const monthlyTokens = BigInt(request.monthlyTokens);
      if (monthlyTokens > 9_223_372_036_854_775_807n) {
        throw new ConflictException('The monthly Token limit exceeds the database boundary.');
      }
      const updatedAt = new Date();
      const updated = await transaction.tenant.updateMany({
        where: { id: principal.tenantId, updatedAt: current.updatedAt },
        data: {
          agentRunConcurrencyLimit: request.concurrentRuns,
          agentRunRateLimitPerMinute: request.runsPerMinute,
          agentRunMonthlyTokenLimit: monthlyTokens,
          updatedAt,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Agent Run limits changed. Refresh and try again.');
      }
      await recordAdminAudit(
        transaction,
        principal,
        'admin.agent.usage_limits.updated',
        'tenant',
        principal.tenantId,
        {
          concurrentRuns: request.concurrentRuns,
          runsPerMinute: request.runsPerMinute,
          monthlyTokens: request.monthlyTokens,
        },
      );
      return {
        concurrentRuns: request.concurrentRuns,
        runsPerMinute: request.runsPerMinute,
        monthlyTokens: request.monthlyTokens,
        updatedAt: updatedAt.toISOString(),
      };
    });
  }

  async update(id: string, request: UpdateAdminAgentRequest): Promise<AdminAgent> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${principal.tenantId}:admin-agent:${id}`}, 0))::text
      `;
      const current = await transaction.agentInstance.findFirst({
        where: { id, tenantId: principal.tenantId, ownerUserId: { not: null } },
        include: agentInclude,
      });
      if (current === null) throw new NotFoundException('The member agent was not found.');
      if (current.versionId !== request.expectedVersionId) {
        throw new ConflictException('The agent configuration changed. Refresh and try again.');
      }

      const requestedKnowledgeBaseIds =
        request.knowledgeBaseIds === undefined
          ? readKnowledgeBaseIds(current.version.knowledgeScope)
          : [...new Set(request.knowledgeBaseIds)].sort();
      const promptChanged =
        request.systemPrompt !== undefined && request.systemPrompt !== current.version.systemPrompt;
      const knowledgeChanged =
        request.knowledgeBaseIds !== undefined &&
        JSON.stringify(requestedKnowledgeBaseIds) !==
          JSON.stringify(readKnowledgeBaseIds(current.version.knowledgeScope));
      if (promptChanged || knowledgeChanged) {
        throw new ConflictException(
          'Prompt and knowledge-scope changes must be created, reviewed, evaluated, and published through Role Blueprint governance.',
        );
      }

      const versionId = current.versionId;
      const settings = readSettings(current.settings);
      await transaction.agentInstance.update({
        where: { id: current.id },
        data: {
          versionId,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.summary === undefined ? {} : { summary: request.summary }),
          ...(request.status === undefined ? {} : { status: request.status }),
          settings: {
            ...settings,
            visibility: request.visibility ?? readVisibility(current.settings),
          },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.agent.updated',
        'agent_instance',
        current.id,
        { previousVersionId: current.versionId, versionId, ownerUserId: current.ownerUserId },
      );
      return mapAgent(
        await transaction.agentInstance.findFirstOrThrow({
          where: { id: current.id, tenantId: principal.tenantId },
          include: agentInclude,
        }),
      );
    });
  }
}

const agentInclude = {
  owner: { select: { id: true, displayName: true, status: true } },
  version: true,
  runs: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.AgentInstanceInclude;

function mapAgent(agent: AgentRecord): AdminAgent {
  if (agent.owner === null) throw new Error('A member agent must have an owner.');
  const lastRun = agent.runs[0];
  return {
    id: agent.id,
    name: agent.name,
    summary: agent.summary,
    status: agent.status,
    visibility: readVisibility(agent.settings),
    owner: agent.owner,
    versionId: agent.versionId,
    version: agent.version.version,
    versionStatus: agent.version.status,
    systemPrompt: agent.version.systemPrompt,
    modelRoute: readModelRoute(agent.version.modelPolicy),
    knowledgeBaseIds: readKnowledgeBaseIds(agent.version.knowledgeScope),
    lastRun:
      lastRun === undefined
        ? null
        : {
            id: lastRun.id,
            status: lastRun.status,
            errorCode: lastRun.errorCode,
            errorMessage: lastRun.errorMessage,
            createdAt: lastRun.createdAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          },
    updatedAt: agent.updatedAt.toISOString(),
  };
}

function readVisibility(settings: Prisma.JsonValue): 'tenant' | 'owner' {
  return isRecord(settings) && settings.visibility === 'tenant' ? 'tenant' : 'owner';
}

function readSettings(settings: Prisma.JsonValue): Prisma.InputJsonObject {
  return isRecord(settings) ? (JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonObject) : {};
}

function readModelRoute(policy: Prisma.JsonValue): string {
  return isRecord(policy) && typeof policy.route === 'string' ? policy.route : 'default';
}

function readKnowledgeBaseIds(scope: Prisma.JsonValue): string[] {
  if (!isRecord(scope) || !Array.isArray(scope.knowledgeBaseIds)) return [];
  return [...new Set(scope.knowledgeBaseIds.filter((id): id is string => typeof id === 'string'))]
    .sort()
    .slice(0, 50);
}

function isRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundedMetric(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.round(value));
}
