import { Inject, Injectable } from '@nestjs/common';
import type { AgentOperationalAvailability } from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import { readModelRouteRequest } from './model-route-execution.js';
import { modelRouteConfigurationSha256 } from './model-route-readiness.support.js';
import {
  ModelRoutingRuntimeReadinessClient,
  type RuntimeModelRoutingReadiness,
} from './model-routing-runtime-readiness.client.js';

const RUNTIME_CACHE_TTL_MS = 5_000;
const RUNTIME_EVIDENCE_MAX_AGE_MS = 60_000;
const RECENT_SUCCESS_WINDOW_MS = 86_400_000;

type Transaction = Prisma.TransactionClient;
type AgentRow = Awaited<ReturnType<typeof readAgents>>[number];
type PolicyRow = Prisma.AiModelRoutePolicyVersionGetPayload<Record<string, never>>;
type CandidateRow = Prisma.AiModelRouteCandidateGetPayload<Record<string, never>>;
type CatalogRow = Prisma.AiModelCatalogVersionGetPayload<Record<string, never>>;
type CircuitRow = Prisma.AiModelCircuitStateRecordGetPayload<Record<string, never>>;

interface ReadinessSnapshot {
  readonly agents: readonly AgentRow[];
  readonly policies: readonly PolicyRow[];
  readonly candidates: readonly CandidateRow[];
  readonly catalogs: readonly CatalogRow[];
  readonly circuits: readonly CircuitRow[];
  readonly recentSuccessfulCatalogIds: ReadonlySet<string>;
}

@Injectable()
export class AgentOperationalReadinessService {
  private runtimeCache:
    { readonly value: RuntimeModelRoutingReadiness; readonly expiresAt: number } | undefined;
  private runtimeInFlight: Promise<RuntimeModelRoutingReadiness> | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelRoutingRuntimeReadinessClient)
    private readonly runtimeReadiness: ModelRoutingRuntimeReadinessClient,
  ) {}

  async inspectAgents(
    tenantId: string,
    agentIds: readonly string[],
  ): Promise<ReadonlyMap<string, AgentOperationalAvailability>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    if (uniqueAgentIds.length === 0) return new Map();
    if (!this.prisma.enabled) {
      return new Map(
        uniqueAgentIds.map((agentId) => [agentId, unavailable('READINESS_DATA_UNAVAILABLE')]),
      );
    }

    const now = Date.now();
    const [snapshot, runtime] = await Promise.all([
      this.readSnapshot(tenantId, uniqueAgentIds, now),
      this.runtimeSnapshot(now),
    ]);
    return evaluateSnapshot(uniqueAgentIds, snapshot, runtime, now);
  }

  private async readSnapshot(
    tenantId: string,
    agentIds: readonly string[],
    now: number,
  ): Promise<ReadinessSnapshot> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const agents = await readAgents(transaction, tenantId, agentIds);
      const requests = agents.map(({ version }) => readModelRouteRequest(version.modelPolicy));
      const taskClasses = [...new Set(requests.map(({ taskClass }) => taskClass))];
      const policies = await transaction.aiModelRoutePolicyVersion.findMany({
        where: { tenantId, taskClass: { in: taskClasses }, status: 'PUBLISHED' },
        orderBy: [{ taskClass: 'asc' }, { version: 'desc' }],
      });
      const policyIds = policies.map(({ id }) => id);
      const candidates = await transaction.aiModelRouteCandidate.findMany({
        where: { tenantId, policyVersionId: { in: policyIds } },
        orderBy: [{ policyVersionId: 'asc' }, { ordinal: 'asc' }],
      });
      const catalogIds = [...new Set(candidates.map(({ catalogVersionId }) => catalogVersionId))];
      const [catalogs, circuits, recentSuccessfulReceipts] = await Promise.all([
        transaction.aiModelCatalogVersion.findMany({
          where: { tenantId, id: { in: catalogIds } },
        }),
        transaction.aiModelCircuitStateRecord.findMany({
          where: { tenantId, catalogVersionId: { in: catalogIds } },
        }),
        transaction.aiModelAttemptReceipt.findMany({
          where: {
            tenantId,
            catalogVersionId: { in: catalogIds },
            phase: 'TERMINAL',
            outcome: 'SUCCEEDED',
            createdAt: { gte: new Date(now - RECENT_SUCCESS_WINDOW_MS) },
          },
          select: { catalogVersionId: true },
          distinct: ['catalogVersionId'],
        }),
      ]);
      return {
        agents,
        policies,
        candidates,
        catalogs,
        circuits,
        recentSuccessfulCatalogIds: new Set(
          recentSuccessfulReceipts.map(({ catalogVersionId }) => catalogVersionId),
        ),
      };
    });
  }

  private async runtimeSnapshot(now: number): Promise<RuntimeModelRoutingReadiness> {
    if (this.runtimeCache !== undefined && this.runtimeCache.expiresAt > now) {
      return this.runtimeCache.value;
    }
    if (this.runtimeInFlight !== undefined) return this.runtimeInFlight;

    const inspection = this.runtimeReadiness
      .inspect()
      .catch((): RuntimeModelRoutingReadiness => runtimeUnavailable())
      .then((value) => {
        this.runtimeCache = { value, expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        this.runtimeInFlight = undefined;
      });
    this.runtimeInFlight = inspection;
    return inspection;
  }
}

async function readAgents(transaction: Transaction, tenantId: string, agentIds: readonly string[]) {
  return transaction.agentInstance.findMany({
    where: { tenantId, id: { in: [...agentIds] } },
    select: {
      id: true,
      status: true,
      version: { select: { status: true, modelPolicy: true } },
    },
  });
}

function evaluateSnapshot(
  requestedAgentIds: readonly string[],
  snapshot: ReadinessSnapshot,
  runtime: RuntimeModelRoutingReadiness,
  now: number,
): ReadonlyMap<string, AgentOperationalAvailability> {
  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const policyByTaskClass = new Map<string, PolicyRow>();
  for (const policy of snapshot.policies) {
    if (!policyByTaskClass.has(policy.taskClass)) policyByTaskClass.set(policy.taskClass, policy);
  }
  const candidatesByPolicy = groupBy(snapshot.candidates, (candidate) => candidate.policyVersionId);
  const catalogById = new Map(snapshot.catalogs.map((catalog) => [catalog.id, catalog]));
  const circuitByCatalogId = new Map(
    snapshot.circuits.map((circuit) => [circuit.catalogVersionId, circuit]),
  );
  const runtimeRouteByCatalogId = new Map(
    runtime.routes.map((route) => [route.catalogVersionId, route]),
  );

  return new Map(
    requestedAgentIds.map((agentId) => {
      const agent = agentById.get(agentId);
      if (agent === undefined) return [agentId, unavailable('AGENT_NOT_FOUND')];
      if (agent.status !== 'ONLINE') {
        return [
          agentId,
          notReady(
            agent.status === 'DISABLED'
              ? 'AGENT_CONFIGURATION_DISABLED'
              : 'AGENT_CONFIGURATION_NOT_ONLINE',
            runtime,
          ),
        ];
      }
      if (agent.version.status !== 'PUBLISHED' && agent.version.status !== 'RETIRED') {
        return [agentId, notReady('AGENT_VERSION_NOT_PUBLISHED', runtime)];
      }

      const request = readModelRouteRequest(agent.version.modelPolicy);
      const policy = policyByTaskClass.get(request.taskClass);
      if (policy === undefined) {
        return [agentId, notReady('NO_PUBLISHED_ROUTE_POLICY', runtime)];
      }
      if (
        classificationRank(request.classification) >
          classificationRank(policy.maximumClassification) ||
        request.requiredCapabilities.some(
          (capability) => !safeStringArray(policy.requiredCapabilities).includes(capability),
        )
      ) {
        return [agentId, notReady('ROUTE_POLICY_INCOMPATIBLE', runtime)];
      }

      const candidates = candidatesByPolicy.get(policy.id) ?? [];
      if (candidates.length === 0) {
        return [agentId, notReady('NO_PUBLISHED_ROUTE_CANDIDATE', runtime)];
      }
      if (runtime.status === 'UNAVAILABLE' || runtimeEvidenceIsStale(runtime, now)) {
        return [
          agentId,
          unavailable(
            runtime.status === 'UNAVAILABLE'
              ? 'RUNTIME_READINESS_UNAVAILABLE'
              : 'RUNTIME_READINESS_STALE',
          ),
        ];
      }
      if (runtime.status !== 'READY' || runtime.requireTrustedRoute !== true) {
        return [agentId, notReady('RUNTIME_TRUSTED_ROUTE_NOT_READY', runtime)];
      }
      if (runtime.providerReady !== true) {
        return [agentId, notReady('RUNTIME_PROVIDER_NOT_READY', runtime)];
      }

      const reasons: string[] = [];
      let readyCandidateCount = 0;
      for (const candidate of candidates) {
        const catalog = catalogById.get(candidate.catalogVersionId);
        if (
          catalog === undefined ||
          catalog.status !== 'PUBLISHED' ||
          !catalogSatisfiesPolicy(catalog, policy)
        ) {
          reasons.push('INVALID_PUBLISHED_ROUTE_CANDIDATE');
          continue;
        }
        const circuit = circuitByCatalogId.get(catalog.id);
        if (
          circuit?.state === 'OPEN' &&
          circuit.openedUntil !== null &&
          circuit.openedUntil.getTime() > now
        ) {
          reasons.push('MODEL_CIRCUIT_OPEN');
          continue;
        }
        const runtimeRoute = runtimeRouteByCatalogId.get(catalog.id);
        if (
          runtimeRoute === undefined ||
          runtimeRoute.routeKey !== catalog.routeKey ||
          runtimeRoute.provider !== catalog.provider ||
          runtimeRoute.model !== catalog.modelName ||
          runtimeRoute.configurationSha256 !== modelRouteConfigurationSha256(catalog)
        ) {
          reasons.push('RUNTIME_ALLOWLIST_MISMATCH');
          continue;
        }
        if (!snapshot.recentSuccessfulCatalogIds.has(catalog.id)) {
          reasons.push('NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE');
          continue;
        }
        readyCandidateCount += 1;
      }

      const reasonCodes = [...new Set(reasons)];
      if (readyCandidateCount === candidates.length && reasonCodes.length === 0) {
        return [
          agentId,
          {
            status: 'AVAILABLE' as const,
            evidenceStatus: 'VERIFIED' as const,
            reasonCodes: [],
            checkedAt: runtime.checkedAt?.toISOString() ?? null,
          },
        ];
      }
      if (readyCandidateCount > 0) {
        return [
          agentId,
          {
            status: 'DEGRADED' as const,
            evidenceStatus: 'INSUFFICIENT_EVIDENCE' as const,
            reasonCodes: ['PARTIAL_CANDIDATE_AVAILABILITY', ...reasonCodes],
            checkedAt: runtime.checkedAt?.toISOString() ?? null,
          },
        ];
      }
      return [
        agentId,
        {
          status: 'NOT_READY' as const,
          evidenceStatus: 'INSUFFICIENT_EVIDENCE' as const,
          reasonCodes: reasonCodes.length === 0 ? ['NO_OPERATIONAL_ROUTE_CANDIDATE'] : reasonCodes,
          checkedAt: runtime.checkedAt?.toISOString() ?? null,
        },
      ];
    }),
  );
}

function notReady(
  reasonCode: string,
  runtime: RuntimeModelRoutingReadiness,
): AgentOperationalAvailability {
  return {
    status: 'NOT_READY',
    evidenceStatus: 'INSUFFICIENT_EVIDENCE',
    reasonCodes: [reasonCode],
    checkedAt: runtime.checkedAt?.toISOString() ?? null,
  };
}

function unavailable(reasonCode: string): AgentOperationalAvailability {
  return {
    status: 'UNKNOWN',
    evidenceStatus: 'INSUFFICIENT_EVIDENCE',
    reasonCodes: [reasonCode],
    checkedAt: null,
  };
}

function runtimeUnavailable(): RuntimeModelRoutingReadiness {
  return {
    status: 'UNAVAILABLE',
    requireTrustedRoute: null,
    providerReady: null,
    checkedAt: null,
    routes: [],
  };
}

function runtimeEvidenceIsStale(runtime: RuntimeModelRoutingReadiness, now: number): boolean {
  return (
    runtime.checkedAt === null ||
    Math.abs(now - runtime.checkedAt.getTime()) > RUNTIME_EVIDENCE_MAX_AGE_MS
  );
}

function classificationRank(value: string): number {
  return ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].indexOf(value);
}

function catalogSatisfiesPolicy(catalog: CatalogRow, policy: PolicyRow): boolean {
  const capabilities = safeStringArray(catalog.capabilities);
  const allowedResidencies = safeStringArray(policy.allowedResidencies);
  const requiredCapabilities = safeStringArray(policy.requiredCapabilities);
  return (
    allowedResidencies.includes(catalog.dataResidency) &&
    catalog.p95LatencyMs <= policy.maxP95LatencyMs &&
    catalog.inputCostMicrosPerMillion <= policy.maxInputCostMicrosPerMillion &&
    catalog.outputCostMicrosPerMillion <= policy.maxOutputCostMicrosPerMillion &&
    requiredCapabilities.every((capability) => capabilities.includes(capability)) &&
    classificationRank(catalog.maximumClassification) >=
      classificationRank(policy.maximumClassification)
  );
}

function safeStringArray(value: Prisma.JsonValue): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return [];
  return value as string[];
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}
