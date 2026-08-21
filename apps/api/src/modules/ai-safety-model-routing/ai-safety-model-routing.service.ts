import { createHash } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AiGovernanceStatus,
  AiModelCatalogVersion,
  AiModelRoutePolicyVersion,
  AiModelRoutingDashboard,
  AiModelRoutingListQuery,
  CreateAiModelCatalogVersionRequest,
  CreateAiModelRoutePolicyVersionRequest,
  TransitionAiGovernanceVersionRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../admin/admin-access.service.js';
import {
  ModelRoutingRuntimeReadinessClient,
  type RuntimeModelRoutingReadiness,
} from './model-routing-runtime-readiness.client.js';
import { modelRouteConfigurationSha256 } from './model-route-readiness.support.js';

@Injectable()
export class AiSafetyModelRoutingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Optional()
    @Inject(ModelRoutingRuntimeReadinessClient)
    private readonly runtimeReadiness?: ModelRoutingRuntimeReadinessClient,
  ) {}

  createCatalogVersion(
    request: CreateAiModelCatalogVersionRequest,
  ): Promise<AiModelCatalogVersion> {
    const principal = this.access.requireDirectoryWrite();
    const requestHash = hashCanonical(request);
    const configurationHash = hashCanonical({
      routeKey: request.routeKey,
      provider: request.provider,
      modelName: request.modelName,
      credentialReference: request.credentialReference,
      dataResidency: request.dataResidency,
      maximumClassification: request.maximumClassification,
      capabilities: [...request.capabilities].sort(),
      maxContextTokens: request.maxContextTokens,
      maxOutputTokens: request.maxOutputTokens,
      inputCostMicrosPerMillion: request.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: request.outputCostMicrosPerMillion,
      p95LatencyMs: request.p95LatencyMs,
    });
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await setActor(transaction, principal);
      const replay = await transaction.aiModelCatalogVersion.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: request.idempotencyKey },
      });
      if (replay !== null) {
        if (replay.requestHash !== requestHash) throw idempotencyConflict();
        return mapCatalog(replay);
      }
      await advisoryLock(transaction, principal.tenantId, `catalog:${request.routeKey}`);
      const latest = await transaction.aiModelCatalogVersion.aggregate({
        where: { tenantId: principal.tenantId, routeKey: request.routeKey },
        _max: { version: true },
      });
      const created = await transaction.aiModelCatalogVersion.create({
        data: {
          tenantId: principal.tenantId,
          routeKey: request.routeKey,
          version: (latest._max.version ?? 0) + 1,
          provider: request.provider,
          modelName: request.modelName,
          credentialReference: request.credentialReference,
          dataResidency: request.dataResidency,
          maximumClassification: request.maximumClassification,
          capabilities: request.capabilities,
          maxContextTokens: request.maxContextTokens,
          maxOutputTokens: request.maxOutputTokens,
          inputCostMicrosPerMillion: BigInt(request.inputCostMicrosPerMillion),
          outputCostMicrosPerMillion: BigInt(request.outputCostMicrosPerMillion),
          p95LatencyMs: request.p95LatencyMs,
          configurationHash,
          createdByUserId: principal.userId,
          idempotencyKey: request.idempotencyKey,
          requestHash,
        },
      });
      return mapCatalog(created);
    });
  }

  transitionCatalogVersion(
    id: string,
    request: TransitionAiGovernanceVersionRequest,
  ): Promise<AiModelCatalogVersion> {
    const principal = this.access.requireDirectoryWrite();
    const requestHash = transitionRequestHash(request);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await setActor(transaction, principal);
      await advisoryLock(
        transaction,
        principal.tenantId,
        `ai-governance-command:${request.idempotencyKey}`,
      );
      const replay = await transitionReplay(transaction, {
        principal,
        resourceType: 'CATALOG',
        resourceId: id,
        request,
        requestHash,
      });
      if (replay !== null) {
        const replayed = await transaction.aiModelCatalogVersion.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (replayed === null || replayed.revision < replay.responseRevision) {
          throw new Error('AI governance command replay target is inconsistent.');
        }
        return mapCatalog(replayed);
      }
      const current = await transaction.aiModelCatalogVersion.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null) throw new NotFoundException('Model catalog version was not found.');
      const transition = governedTransition(current, request, principal);
      const result = await transaction.aiModelCatalogVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: current.status,
        },
        data: transition,
      });
      if (result.count !== 1) throw staleVersion();
      const updated = await transaction.aiModelCatalogVersion.findUniqueOrThrow({ where: { id } });
      await recordTransitionCommand(transaction, {
        principal,
        resourceType: 'CATALOG',
        resourceId: id,
        request,
        requestHash,
        responseRevision: updated.revision,
      });
      return mapCatalog(updated);
    });
  }

  createRoutePolicyVersion(
    request: CreateAiModelRoutePolicyVersionRequest,
  ): Promise<AiModelRoutePolicyVersion> {
    const principal = this.access.requireDirectoryWrite();
    const requestHash = hashCanonical(request);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await setActor(transaction, principal);
      const replay = await transaction.aiModelRoutePolicyVersion.findFirst({
        where: { tenantId: principal.tenantId, idempotencyKey: request.idempotencyKey },
      });
      if (replay !== null) {
        if (replay.requestHash !== requestHash) throw idempotencyConflict();
        return mapPolicy(transaction, replay);
      }
      await advisoryLock(transaction, principal.tenantId, `route:${request.taskClass}`);
      const catalogs = await transaction.aiModelCatalogVersion.findMany({
        where: {
          tenantId: principal.tenantId,
          id: { in: request.catalogVersionIds },
          status: { in: ['IN_REVIEW', 'PUBLISHED'] },
        },
      });
      if (catalogs.length !== request.catalogVersionIds.length) {
        throw new UnprocessableEntityException(
          'Every route candidate must be a reviewed tenant model catalog version.',
        );
      }
      validatePolicyCandidates(request, catalogs);
      const latest = await transaction.aiModelRoutePolicyVersion.aggregate({
        where: { tenantId: principal.tenantId, taskClass: request.taskClass },
        _max: { version: true },
      });
      const policyHash = hashCanonical({
        ...request,
        idempotencyKey: undefined,
        catalogVersionIds: request.catalogVersionIds,
      });
      const created = await transaction.aiModelRoutePolicyVersion.create({
        data: {
          tenantId: principal.tenantId,
          taskClass: request.taskClass,
          version: (latest._max.version ?? 0) + 1,
          allowedResidencies: request.allowedResidencies,
          maximumClassification: request.maximumClassification,
          requiredCapabilities: request.requiredCapabilities,
          maxP95LatencyMs: request.maxP95LatencyMs,
          maxInputCostMicrosPerMillion: BigInt(request.maxInputCostMicrosPerMillion),
          maxOutputCostMicrosPerMillion: BigInt(request.maxOutputCostMicrosPerMillion),
          maximumAttempts: request.maximumAttempts,
          circuitFailureThreshold: request.circuitFailureThreshold,
          circuitOpenSeconds: request.circuitOpenSeconds,
          policyHash,
          createdByUserId: principal.userId,
          idempotencyKey: request.idempotencyKey,
          requestHash,
        },
      });
      await transaction.aiModelRouteCandidate.createMany({
        data: request.catalogVersionIds.map((catalogVersionId, index) => ({
          tenantId: principal.tenantId,
          policyVersionId: created.id,
          ordinal: index + 1,
          catalogVersionId,
        })),
      });
      return mapPolicy(transaction, created);
    });
  }

  transitionRoutePolicyVersion(
    id: string,
    request: TransitionAiGovernanceVersionRequest,
  ): Promise<AiModelRoutePolicyVersion> {
    const principal = this.access.requireDirectoryWrite();
    const requestHash = transitionRequestHash(request);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await setActor(transaction, principal);
      await advisoryLock(
        transaction,
        principal.tenantId,
        `ai-governance-command:${request.idempotencyKey}`,
      );
      const replay = await transitionReplay(transaction, {
        principal,
        resourceType: 'ROUTE_POLICY',
        resourceId: id,
        request,
        requestHash,
      });
      if (replay !== null) {
        const replayed = await transaction.aiModelRoutePolicyVersion.findFirst({
          where: { tenantId: principal.tenantId, id },
        });
        if (replayed === null || replayed.revision < replay.responseRevision) {
          throw new Error('AI governance command replay target is inconsistent.');
        }
        return mapPolicy(transaction, replayed);
      }
      const current = await transaction.aiModelRoutePolicyVersion.findFirst({
        where: { tenantId: principal.tenantId, id },
      });
      if (current === null)
        throw new NotFoundException('Model route policy version was not found.');
      if (request.action === 'PUBLISH') {
        const candidates = await transaction.aiModelRouteCandidate.findMany({
          where: { tenantId: principal.tenantId, policyVersionId: id },
        });
        const published = await transaction.aiModelCatalogVersion.count({
          where: {
            tenantId: principal.tenantId,
            id: { in: candidates.map((candidate) => candidate.catalogVersionId) },
            status: 'PUBLISHED',
          },
        });
        if (
          candidates.length < 1 ||
          candidates.length > current.maximumAttempts ||
          published !== candidates.length
        ) {
          throw new ConflictException(
            'All bounded route candidates must be published before the policy can be published.',
          );
        }
      }
      const transition = governedTransition(current, request, principal);
      const result = await transaction.aiModelRoutePolicyVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          id,
          revision: request.expectedRevision,
          status: current.status,
        },
        data: transition,
      });
      if (result.count !== 1) throw staleVersion();
      const updated = await transaction.aiModelRoutePolicyVersion.findUniqueOrThrow({
        where: { id },
      });
      await recordTransitionCommand(transaction, {
        principal,
        resourceType: 'ROUTE_POLICY',
        resourceId: id,
        request,
        requestHash,
        responseRevision: updated.revision,
      });
      return mapPolicy(transaction, updated);
    });
  }

  async dashboard(query: AiModelRoutingListQuery): Promise<AiModelRoutingDashboard> {
    const principal = this.access.requireDirectoryRead();
    const runtimePromise =
      this.runtimeReadiness?.inspect() ??
      Promise.resolve<RuntimeModelRoutingReadiness>({
        status: 'UNAVAILABLE',
        requireTrustedRoute: null,
        providerReady: null,
        checkedAt: null,
        routes: [],
      });
    const [snapshot, runtime] = await Promise.all([
      this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const [
          catalogRows,
          policyRows,
          publishedCatalogRows,
          publishedPolicyRows,
          blockedSafetyDecisionCount24h,
        ] = await Promise.all([
          transaction.aiModelCatalogVersion.findMany({
            where: {
              tenantId: principal.tenantId,
              ...(query.status === undefined ? {} : { status: query.status }),
            },
            orderBy: [{ routeKey: 'asc' }, { version: 'desc' }],
            take: 500,
          }),
          transaction.aiModelRoutePolicyVersion.findMany({
            where: {
              tenantId: principal.tenantId,
              ...(query.status === undefined ? {} : { status: query.status }),
              ...(query.taskClass === undefined ? {} : { taskClass: query.taskClass }),
            },
            orderBy: [{ taskClass: 'asc' }, { version: 'desc' }],
            take: 500,
          }),
          transaction.aiModelCatalogVersion.findMany({
            where: { tenantId: principal.tenantId, status: 'PUBLISHED' },
            take: 500,
          }),
          transaction.aiModelRoutePolicyVersion.findMany({
            where: { tenantId: principal.tenantId, status: 'PUBLISHED' },
            take: 500,
          }),
          transaction.aiSafetyDecisionRecord.count({
            where: {
              tenantId: principal.tenantId,
              action: 'BLOCK',
              createdAt: { gte: new Date(Date.now() - 86_400_000) },
            },
          }),
        ]);
        const routePolicies = await Promise.all(
          policyRows.map((policy) => mapPolicy(transaction, policy)),
        );
        const publishedPolicyIds = publishedPolicyRows.map(({ id }) => id);
        const candidateRows = await transaction.aiModelRouteCandidate.findMany({
          where: {
            tenantId: principal.tenantId,
            policyVersionId: { in: publishedPolicyIds },
          },
          orderBy: [{ policyVersionId: 'asc' }, { ordinal: 'asc' }],
        });
        const candidateIds = [
          ...new Set(candidateRows.map(({ catalogVersionId }) => catalogVersionId)),
        ];
        const [candidateCatalogs, openCircuits, recentSuccessfulReceipts] = await Promise.all([
          transaction.aiModelCatalogVersion.findMany({
            where: { tenantId: principal.tenantId, id: { in: candidateIds } },
          }),
          transaction.aiModelCircuitStateRecord.findMany({
            where: {
              tenantId: principal.tenantId,
              catalogVersionId: { in: candidateIds },
              state: 'OPEN',
              openedUntil: { gt: new Date() },
            },
          }),
          transaction.aiModelAttemptReceipt.findMany({
            where: {
              tenantId: principal.tenantId,
              catalogVersionId: { in: candidateIds },
              phase: 'TERMINAL',
              outcome: 'SUCCEEDED',
              createdAt: { gte: new Date(Date.now() - 86_400_000) },
            },
            select: { catalogVersionId: true },
            distinct: ['catalogVersionId'],
          }),
        ]);
        return {
          catalogRows,
          routePolicies,
          publishedCatalogRows,
          publishedPolicyRows,
          candidateRows,
          candidateCatalogs,
          openCircuitCount: openCircuits.length,
          recentSuccessfulCatalogIds: new Set(
            recentSuccessfulReceipts.map(({ catalogVersionId }) => catalogVersionId),
          ),
          blockedSafetyDecisionCount24h,
        };
      }),
      runtimePromise,
    ]);

    const catalogById = new Map(snapshot.candidateCatalogs.map((catalog) => [catalog.id, catalog]));
    const candidatesByPolicy = new Map<string, typeof snapshot.candidateRows>();
    for (const candidate of snapshot.candidateRows) {
      const candidates = candidatesByPolicy.get(candidate.policyVersionId) ?? [];
      candidates.push(candidate);
      candidatesByPolicy.set(candidate.policyVersionId, candidates);
    }
    let invalidPublishedPolicyCount = 0;
    for (const policy of snapshot.publishedPolicyRows) {
      const candidates = candidatesByPolicy.get(policy.id) ?? [];
      if (
        candidates.length < 1 ||
        candidates.length > policy.maximumAttempts ||
        candidates.some((candidate) => {
          const catalog = catalogById.get(candidate.catalogVersionId);
          return (
            catalog === undefined ||
            catalog.status !== 'PUBLISHED' ||
            !catalogSatisfiesPolicy(catalog, policy)
          );
        })
      ) {
        invalidPublishedPolicyCount += 1;
      }
    }
    const candidateIds = [
      ...new Set(snapshot.candidateRows.map(({ catalogVersionId }) => catalogVersionId)),
    ];
    const runtimeRouteByCatalogId = new Map(
      runtime.routes.map((route) => [route.catalogVersionId, route]),
    );
    const runtimeAllowlistedCandidateCount = candidateIds.filter((catalogId) => {
      const catalog = catalogById.get(catalogId);
      const route = runtimeRouteByCatalogId.get(catalogId);
      return (
        catalog !== undefined &&
        route !== undefined &&
        route.routeKey === catalog.routeKey &&
        route.provider === catalog.provider &&
        route.model === catalog.modelName &&
        route.configurationSha256 === modelRouteConfigurationSha256(catalog)
      );
    }).length;
    const recentSuccessfulCandidateCount = candidateIds.filter((catalogId) =>
      snapshot.recentSuccessfulCatalogIds.has(catalogId),
    ).length;
    const reasonCodes: string[] = [];
    if (snapshot.publishedCatalogRows.length === 0) reasonCodes.push('NO_PUBLISHED_MODEL');
    if (snapshot.publishedPolicyRows.length === 0) {
      reasonCodes.push('NO_PUBLISHED_ROUTE_POLICY');
    }
    if (invalidPublishedPolicyCount > 0) {
      reasonCodes.push('INVALID_PUBLISHED_ROUTE_POLICY');
    }
    if (snapshot.openCircuitCount > 0) reasonCodes.push('MODEL_CIRCUIT_OPEN');
    if (runtime.status === 'UNAVAILABLE') {
      reasonCodes.push('RUNTIME_READINESS_UNAVAILABLE');
    } else {
      if (runtime.requireTrustedRoute !== true) {
        reasonCodes.push('RUNTIME_TRUSTED_ROUTE_NOT_REQUIRED');
      }
      if (runtime.providerReady !== true) reasonCodes.push('RUNTIME_PROVIDER_NOT_READY');
      if (runtimeAllowlistedCandidateCount !== candidateIds.length) {
        reasonCodes.push('RUNTIME_ALLOWLIST_MISMATCH');
      }
    }
    if (candidateIds.length === 0 || recentSuccessfulCandidateCount !== candidateIds.length) {
      reasonCodes.push('NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE');
    }
    const uniqueReasonCodes = [...new Set(reasonCodes)];
    const ready = uniqueReasonCodes.length === 0;
    const evidenceVerified =
      runtime.status !== 'UNAVAILABLE' &&
      candidateIds.length > 0 &&
      runtimeAllowlistedCandidateCount === candidateIds.length &&
      recentSuccessfulCandidateCount === candidateIds.length;
    return {
      catalogVersions: snapshot.catalogRows.map(mapCatalog),
      routePolicies: snapshot.routePolicies,
      readiness: {
        publishedCatalogCount: snapshot.publishedCatalogRows.length,
        publishedPolicyCount: snapshot.publishedPolicyRows.length,
        activeCandidateCount: candidateIds.length,
        invalidPublishedPolicyCount,
        runtimeAllowlistedCandidateCount,
        recentSuccessfulCandidateCount,
        openCircuitCount: snapshot.openCircuitCount,
        blockedSafetyDecisionCount24h: snapshot.blockedSafetyDecisionCount24h,
        status: ready ? 'READY' : 'NOT_READY',
        evidenceStatus: evidenceVerified ? 'VERIFIED' : 'INSUFFICIENT_EVIDENCE',
        ready,
        reasonCodes: uniqueReasonCodes,
        runtime: {
          status: runtime.status,
          requireTrustedRoute: runtime.requireTrustedRoute,
          providerReady: runtime.providerReady,
          checkedAt: runtime.checkedAt?.toISOString() ?? null,
        },
      },
    };
  }
}

type CatalogRow = Prisma.AiModelCatalogVersionGetPayload<Record<string, never>>;
type PolicyRow = Prisma.AiModelRoutePolicyVersionGetPayload<Record<string, never>>;
type Transaction = Prisma.TransactionClient;

export function governedTransition(
  current: {
    readonly status: AiGovernanceStatus;
    readonly revision: number;
    readonly submittedByUserId: string | null;
  },
  request: TransitionAiGovernanceVersionRequest,
  principal: AdminPrincipal,
): Prisma.AiModelCatalogVersionUpdateManyMutationInput {
  if (current.revision !== request.expectedRevision) throw staleVersion();
  const now = new Date();
  if (request.action === 'SUBMIT' && current.status === 'DRAFT') {
    return {
      status: 'IN_REVIEW',
      revision: { increment: 1 },
      submittedByUserId: principal.userId,
      submittedAt: now,
    };
  }
  if (request.action === 'PUBLISH' && current.status === 'IN_REVIEW') {
    if (current.submittedByUserId === principal.userId && principal.role !== 'OWNER') {
      throw new ConflictException('Maker-checker requires a different publisher.');
    }
    return {
      status: 'PUBLISHED',
      revision: { increment: 1 },
      reviewedByUserId: principal.userId,
      reviewedAt: now,
      publishedByUserId: principal.userId,
      publishedAt: now,
    };
  }
  if (request.action === 'RETIRE' && current.status === 'PUBLISHED') {
    return {
      status: 'RETIRED',
      revision: { increment: 1 },
      retiredAt: now,
    };
  }
  throw new UnprocessableEntityException(
    `Cannot ${request.action.toLowerCase()} a ${current.status.toLowerCase()} version.`,
  );
}

function validatePolicyCandidates(
  request: CreateAiModelRoutePolicyVersionRequest,
  catalogs: readonly CatalogRow[],
): void {
  const classificationOrder = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
  for (const catalog of catalogs) {
    const capabilities = Array.isArray(catalog.capabilities)
      ? catalog.capabilities.filter((value): value is string => typeof value === 'string')
      : [];
    if (
      !request.allowedResidencies.includes(catalog.dataResidency) ||
      catalog.p95LatencyMs > request.maxP95LatencyMs ||
      catalog.inputCostMicrosPerMillion > BigInt(request.maxInputCostMicrosPerMillion) ||
      catalog.outputCostMicrosPerMillion > BigInt(request.maxOutputCostMicrosPerMillion) ||
      request.requiredCapabilities.some((capability) => !capabilities.includes(capability)) ||
      classificationOrder.indexOf(catalog.maximumClassification) <
        classificationOrder.indexOf(request.maximumClassification)
    ) {
      throw new UnprocessableEntityException(
        `Catalog route ${catalog.routeKey} violates the route policy constraints.`,
      );
    }
  }
}

function catalogSatisfiesPolicy(catalog: CatalogRow, policy: PolicyRow): boolean {
  const classificationOrder = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
  const capabilities = stringArray(catalog.capabilities);
  const allowedResidencies = stringArray(policy.allowedResidencies);
  const requiredCapabilities = stringArray(policy.requiredCapabilities);
  return (
    allowedResidencies.includes(catalog.dataResidency) &&
    catalog.p95LatencyMs <= policy.maxP95LatencyMs &&
    catalog.inputCostMicrosPerMillion <= policy.maxInputCostMicrosPerMillion &&
    catalog.outputCostMicrosPerMillion <= policy.maxOutputCostMicrosPerMillion &&
    requiredCapabilities.every((capability) => capabilities.includes(capability)) &&
    classificationOrder.indexOf(catalog.maximumClassification) >=
      classificationOrder.indexOf(policy.maximumClassification)
  );
}

async function mapPolicy(
  transaction: Transaction,
  row: PolicyRow,
): Promise<AiModelRoutePolicyVersion> {
  const candidates = await transaction.aiModelRouteCandidate.findMany({
    where: { tenantId: row.tenantId, policyVersionId: row.id },
    orderBy: { ordinal: 'asc' },
  });
  const catalogIds = candidates.map(({ catalogVersionId }) => catalogVersionId);
  const [catalogs, circuits] = await Promise.all([
    transaction.aiModelCatalogVersion.findMany({
      where: { tenantId: row.tenantId, id: { in: catalogIds } },
    }),
    transaction.aiModelCircuitStateRecord.findMany({
      where: { tenantId: row.tenantId, catalogVersionId: { in: catalogIds } },
    }),
  ]);
  const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
  const circuitById = new Map(circuits.map((circuit) => [circuit.catalogVersionId, circuit]));
  return {
    id: row.id,
    tenantId: row.tenantId,
    taskClass: row.taskClass,
    version: row.version,
    revision: row.revision,
    status: row.status,
    allowedResidencies: stringArray(row.allowedResidencies),
    maximumClassification: row.maximumClassification,
    requiredCapabilities: stringArray(row.requiredCapabilities),
    maxP95LatencyMs: row.maxP95LatencyMs,
    maxInputCostMicrosPerMillion: row.maxInputCostMicrosPerMillion.toString(),
    maxOutputCostMicrosPerMillion: row.maxOutputCostMicrosPerMillion.toString(),
    maximumAttempts: row.maximumAttempts,
    circuitFailureThreshold: row.circuitFailureThreshold,
    circuitOpenSeconds: row.circuitOpenSeconds,
    policyHash: row.policyHash,
    submittedByUserId: row.submittedByUserId,
    reviewedByUserId: row.reviewedByUserId,
    publishedByUserId: row.publishedByUserId,
    candidates: candidates.map((candidate) => {
      const catalog = catalogById.get(candidate.catalogVersionId);
      if (catalog === undefined) throw new Error('Model route candidate catalog is missing.');
      const circuit = circuitById.get(candidate.catalogVersionId);
      return {
        ordinal: candidate.ordinal,
        catalogVersionId: catalog.id,
        routeKey: catalog.routeKey,
        provider: catalog.provider,
        modelName: catalog.modelName,
        credentialReference: catalog.credentialReference,
        dataResidency: catalog.dataResidency,
        maximumClassification: catalog.maximumClassification,
        capabilities: stringArray(catalog.capabilities),
        p95LatencyMs: catalog.p95LatencyMs,
        circuitState: circuit?.state ?? 'CLOSED',
        circuitOpenedUntil: circuit?.openedUntil?.toISOString() ?? null,
      };
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCatalog(row: CatalogRow): AiModelCatalogVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    routeKey: row.routeKey,
    version: row.version,
    revision: row.revision,
    status: row.status,
    provider: row.provider,
    modelName: row.modelName,
    credentialReference: row.credentialReference,
    dataResidency: row.dataResidency,
    maximumClassification: row.maximumClassification,
    capabilities: stringArray(row.capabilities),
    maxContextTokens: row.maxContextTokens,
    maxOutputTokens: row.maxOutputTokens,
    inputCostMicrosPerMillion: row.inputCostMicrosPerMillion.toString(),
    outputCostMicrosPerMillion: row.outputCostMicrosPerMillion.toString(),
    p95LatencyMs: row.p95LatencyMs,
    configurationHash: row.configurationHash,
    submittedByUserId: row.submittedByUserId,
    reviewedByUserId: row.reviewedByUserId,
    publishedByUserId: row.publishedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Stored AI governance list is invalid.');
  }
  return [...value] as string[];
}

async function setActor(transaction: Transaction, principal: AdminPrincipal): Promise<void> {
  await transaction.$queryRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;
}

type GovernanceResourceType = 'CATALOG' | 'ROUTE_POLICY';

async function transitionReplay(
  transaction: Transaction,
  input: {
    readonly principal: AdminPrincipal;
    readonly resourceType: GovernanceResourceType;
    readonly resourceId: string;
    readonly request: TransitionAiGovernanceVersionRequest;
    readonly requestHash: string;
  },
) {
  const command = await transaction.aiGovernanceCommand.findFirst({
    where: {
      tenantId: input.principal.tenantId,
      idempotencyKey: input.request.idempotencyKey,
    },
  });
  if (command === null) return null;
  if (
    command.resourceType !== input.resourceType ||
    command.resourceId !== input.resourceId ||
    command.action !== input.request.action ||
    command.requestHash !== input.requestHash ||
    command.actorUserId !== input.principal.userId
  ) {
    throw idempotencyConflict();
  }
  return command;
}

async function recordTransitionCommand(
  transaction: Transaction,
  input: {
    readonly principal: AdminPrincipal;
    readonly resourceType: GovernanceResourceType;
    readonly resourceId: string;
    readonly request: TransitionAiGovernanceVersionRequest;
    readonly requestHash: string;
    readonly responseRevision: number;
  },
): Promise<void> {
  await transaction.aiGovernanceCommand.create({
    data: {
      tenantId: input.principal.tenantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      action: input.request.action,
      idempotencyKey: input.request.idempotencyKey,
      requestHash: input.requestHash,
      actorUserId: input.principal.userId,
      responseRevision: input.responseRevision,
    },
  });
}

async function advisoryLock(
  transaction: Transaction,
  tenantId: string,
  scope: string,
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:${scope}`}, 0)
    )
  `;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function transitionRequestHash(request: TransitionAiGovernanceVersionRequest): string {
  return hashCanonical({
    action: request.action,
    expectedRevision: request.expectedRevision,
    reason: request.reason,
  });
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function staleVersion(): ConflictException {
  return new ConflictException('AI governance version changed. Refresh and try again.');
}

function idempotencyConflict(): ConflictException {
  return new ConflictException('Idempotency key was already used for a different request.');
}
