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
  CreateDepartmentAgentRequest,
  UpdateAdminAgentRequest,
  UpdateAgentUsageLimitsRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AdminAccessService } from './admin-access.service.js';
import { AGENT_RUN_CONCURRENCY_HOLD_STATUSES } from '../agent-run/domain/agent-run-quota.js';
import { recordAdminAudit } from './admin-audit.js';

type AgentRecord = Prisma.AgentInstanceGetPayload<{
  include: {
    owner: { select: { id: true; displayName: true; status: true } };
    orgUnit: { select: { id: true; name: true; status: true } };
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
        where: { tenantId: principal.tenantId },
        include: agentInclude,
        orderBy: [{ kind: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return { items: canonicalAdminAgents(agents).map(mapAgent) };
    });
  }

  async createDepartment(request: CreateDepartmentAgentRequest): Promise<AdminAgent> {
    const principal = this.access.requireDirectoryWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const department = await transaction.orgUnit.findFirst({
        where: { tenantId: principal.tenantId, id: request.orgUnitId, status: 'ACTIVE' },
        select: { id: true, name: true },
      });
      if (department === null) {
        throw new NotFoundException('The active department was not found.');
      }
      const knowledgeBaseIds = [...new Set(request.knowledgeBaseIds)].sort();
      await requireDepartmentKnowledgeBases(
        transaction,
        principal.tenantId,
        department.id,
        knowledgeBaseIds,
      );

      const templateKey = `department-assistant-${department.id}-${randomUUID()}`;
      const template = await transaction.agentTemplate.create({
        data: {
          tenantId: principal.tenantId,
          key: templateKey,
          name: `${department.name}智能体`,
          description: `供${department.name}成员共同使用的部门知识智能体。`,
          mission: '',
          responsibilities: [],
          valueDefinition: {},
          capabilities: [],
          processes: [],
          tools: [],
          knowledgeDomains: [],
        },
        select: { id: true },
      });
      const now = new Date();
      const version = await transaction.agentVersion.create({
        data: {
          tenantId: principal.tenantId,
          templateId: template.id,
          version: 1,
          status: 'PUBLISHED',
          reviewStatus: 'NOT_SUBMITTED',
          systemPrompt:
            request.systemPrompt ??
            `你是${department.name}的部门智能体。优先依据已绑定的企业知识回答；引用资料来源；资料不足时明确说明，不得编造。`,
          modelPolicy: { route: 'default' },
          toolPolicy: { allow: [] },
          knowledgeScope: { mode: 'department-authorized', knowledgeBaseIds },
          roleDefinitionSnapshot: {},
          blueprintRevision: 1,
          changeSummary: '创建部门智能体并绑定部门知识库。',
          createdById: principal.userId,
          publishedAt: now,
          publishedById: principal.userId,
        },
        select: { id: true },
      });
      const agent = await transaction.agentInstance.create({
        data: {
          tenantId: principal.tenantId,
          key: `department-agent:${department.id}:${randomUUID()}`,
          kind: 'DEPARTMENT',
          versionId: version.id,
          orgUnitId: department.id,
          ownerUserId: null,
          createdById: principal.userId,
          name: request.name,
          summary: request.summary ?? `服务于${department.name}的共享知识智能体。`,
          status: request.status,
          settings: { visibility: 'department', knowledgeBaseIdsOverride: knowledgeBaseIds },
        },
        include: agentInclude,
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.agent.department.created',
        'agent_instance',
        agent.id,
        {
          orgUnitId: department.id,
          versionId: version.id,
          knowledgeBaseIds,
        },
      );
      return mapAgent(agent);
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
        where: { id, tenantId: principal.tenantId },
        include: agentInclude,
      });
      if (current === null) throw new NotFoundException('The member agent was not found.');
      if (current.versionId !== request.expectedVersionId) {
        throw new ConflictException('The agent configuration changed. Refresh and try again.');
      }

      const requestedKnowledgeBaseIds =
        request.knowledgeBaseIds === undefined
          ? readEffectiveKnowledgeBaseIds(current.settings, current.version.knowledgeScope)
          : [...new Set(request.knowledgeBaseIds)].sort();
      if (request.knowledgeBaseIds !== undefined && requestedKnowledgeBaseIds.length > 0) {
        if (current.kind === 'DEPARTMENT' && current.orgUnitId !== null) {
          await requireDepartmentKnowledgeBases(
            transaction,
            principal.tenantId,
            current.orgUnitId,
            requestedKnowledgeBaseIds,
          );
        } else {
          const activeKnowledgeBases = await transaction.knowledgeBase.findMany({
            where: {
              tenantId: principal.tenantId,
              id: { in: requestedKnowledgeBaseIds },
              status: 'ACTIVE',
            },
            select: { id: true },
          });
          if (activeKnowledgeBases.length !== requestedKnowledgeBaseIds.length) {
            throw new ConflictException(
              'The knowledge selection contains a missing, inactive, or cross-tenant knowledge base.',
            );
          }
        }
      }
      const promptChanged =
        request.systemPrompt !== undefined && request.systemPrompt !== current.version.systemPrompt;
      const knowledgeChanged =
        request.knowledgeBaseIds !== undefined &&
        JSON.stringify(requestedKnowledgeBaseIds) !==
          JSON.stringify(
            readEffectiveKnowledgeBaseIds(current.settings, current.version.knowledgeScope),
          );
      if (promptChanged) {
        throw new ConflictException(
          'Prompt changes must be created, reviewed, evaluated, and published through Role Blueprint governance.',
        );
      }

      if (
        (current.kind === 'MEMBER' && request.visibility === 'department') ||
        (current.kind === 'DEPARTMENT' &&
          request.visibility !== undefined &&
          request.visibility !== 'department')
      ) {
        throw new ConflictException('The requested visibility does not match the Agent type.');
      }
      const settings = readSettings(current.settings);
      await transaction.agentInstance.update({
        where: { id: current.id },
        data: {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.summary === undefined ? {} : { summary: request.summary }),
          ...(request.status === undefined ? {} : { status: request.status }),
          settings: {
            ...settings,
            visibility: request.visibility ?? readVisibility(current.settings),
            ...(knowledgeChanged ? { knowledgeBaseIdsOverride: requestedKnowledgeBaseIds } : {}),
          },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.agent.updated',
        'agent_instance',
        current.id,
        {
          versionId: current.versionId,
          ownerUserId: current.ownerUserId,
          knowledgeBaseCount: requestedKnowledgeBaseIds.length,
        },
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
  orgUnit: { select: { id: true, name: true, status: true } },
  version: true,
  runs: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.AgentInstanceInclude;

function mapAgent(agent: AgentRecord): AdminAgent {
  if (agent.kind === 'MEMBER' && agent.owner === null) {
    throw new Error('A member agent must have an owner.');
  }
  if (agent.kind === 'DEPARTMENT' && agent.orgUnit === null) {
    throw new Error('A department agent must have an org unit.');
  }
  const lastRun = agent.runs[0];
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    summary: agent.summary,
    status: agent.status,
    visibility: readVisibility(agent.settings),
    owner: agent.owner,
    department: agent.orgUnit,
    versionId: agent.versionId,
    version: agent.version.version,
    versionStatus: agent.version.status,
    systemPrompt: agent.version.systemPrompt,
    modelRoute: readModelRoute(agent.version.modelPolicy),
    configurationGovernance: agent.version.reviewStatus === 'APPROVED' ? 'GOVERNED' : 'LEGACY',
    knowledgeBaseIds: readEffectiveKnowledgeBaseIds(agent.settings, agent.version.knowledgeScope),
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

function readVisibility(settings: Prisma.JsonValue): 'tenant' | 'owner' | 'department' {
  if (isRecord(settings) && settings.visibility === 'tenant') return 'tenant';
  if (isRecord(settings) && settings.visibility === 'department') return 'department';
  return 'owner';
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

function readEffectiveKnowledgeBaseIds(
  settings: Prisma.JsonValue,
  versionScope: Prisma.JsonValue,
): string[] {
  if (isRecord(settings) && Array.isArray(settings.knowledgeBaseIdsOverride)) {
    return [
      ...new Set(
        settings.knowledgeBaseIdsOverride.filter((id): id is string => typeof id === 'string'),
      ),
    ]
      .sort()
      .slice(0, 50);
  }
  return readKnowledgeBaseIds(versionScope);
}

function isRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundedMetric(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.round(value));
}

function canonicalAdminAgents(agents: readonly AgentRecord[]): AgentRecord[] {
  const result: AgentRecord[] = [];
  const memberByOwner = new Map<string, AgentRecord>();
  for (const agent of agents) {
    if (agent.kind === 'DEPARTMENT') {
      if (agent.orgUnit !== null) result.push(agent);
      continue;
    }
    if (agent.ownerUserId === null || agent.owner === null) continue;
    const current = memberByOwner.get(agent.ownerUserId);
    if (
      current === undefined ||
      adminMemberAgentPreference(agent) > adminMemberAgentPreference(current) ||
      (adminMemberAgentPreference(agent) === adminMemberAgentPreference(current) &&
        agent.updatedAt > current.updatedAt)
    ) {
      memberByOwner.set(agent.ownerUserId, agent);
    }
  }
  return [...result, ...memberByOwner.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
}

function adminMemberAgentPreference(agent: AgentRecord): number {
  return (
    (agent.status === 'ONLINE' ? 1_000 : agent.status === 'OFFLINE' ? 100 : 0) +
    (agent.version.status === 'PUBLISHED' ? 500 : 0) +
    readEffectiveKnowledgeBaseIds(agent.settings, agent.version.knowledgeScope).length * 10
  );
}

async function requireDepartmentKnowledgeBases(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  orgUnitId: string,
  knowledgeBaseIds: readonly string[],
): Promise<void> {
  const [orgUnits, knowledgeBases] = await Promise.all([
    transaction.orgUnit.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { id: true, parentId: true },
    }),
    transaction.knowledgeBase.findMany({
      where: { tenantId, id: { in: [...knowledgeBaseIds] }, status: 'ACTIVE' },
      include: { orgUnits: true },
    }),
  ]);
  if (knowledgeBases.length !== knowledgeBaseIds.length) {
    throw new ConflictException(
      'The knowledge selection contains a missing, inactive, or cross-tenant knowledge base.',
    );
  }
  const parentById = new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit.parentId]));
  if (!parentById.has(orgUnitId)) {
    throw new ConflictException('The department is no longer active.');
  }
  const inaccessible = knowledgeBases.filter(
    (knowledgeBase) =>
      knowledgeBase.orgUnits.length > 0 &&
      !knowledgeBase.orgUnits.some(
        (scope) =>
          scope.orgUnitId === orgUnitId ||
          (scope.includeChildren && isOrgUnitAncestor(scope.orgUnitId, orgUnitId, parentById)),
      ),
  );
  if (inaccessible.length > 0) {
    throw new ConflictException(
      'One or more knowledge bases are not visible to the selected department.',
    );
  }
}

function isOrgUnitAncestor(
  ancestorId: string,
  descendantId: string,
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  const visited = new Set<string>();
  let current = parentById.get(descendantId) ?? null;
  while (current !== null && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}
