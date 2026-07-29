import {
  trustedModelRouteSnapshotSchema,
  type AiDataClassification,
  type TrustedModelRouteSnapshot,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import {
  isAiDataClassificationAtMost,
  maximumAiDataClassification,
} from './ai-data-classification.js';

export class ModelRouteUnavailableError extends Error {
  constructor(readonly code: 'MODEL_ROUTE_UNAVAILABLE' | 'MODEL_ROUTE_SNAPSHOT_INVALID') {
    super(code);
    this.name = 'ModelRouteUnavailableError';
  }
}

export async function resolveTrustedModelRouteSnapshot(
  transaction: Prisma.TransactionClient,
  input: {
    readonly tenantId: string;
    readonly existingSnapshot: Prisma.JsonValue | null;
    readonly modelPolicy: Prisma.JsonValue;
    readonly effectiveClassification: AiDataClassification;
  },
): Promise<TrustedModelRouteSnapshot | null> {
  if (input.existingSnapshot !== null) {
    const parsed = trustedModelRouteSnapshotSchema.safeParse(input.existingSnapshot);
    if (!parsed.success) throw new ModelRouteUnavailableError('MODEL_ROUTE_SNAPSHOT_INVALID');
    if (
      !isAiDataClassificationAtMost(
        input.effectiveClassification,
        parsed.data.maximumClassification,
      ) ||
      (parsed.data.effectiveClassification !== undefined &&
        parsed.data.effectiveClassification !== input.effectiveClassification)
    ) {
      throw new ModelRouteUnavailableError('MODEL_ROUTE_SNAPSHOT_INVALID');
    }
    await assertSnapshotCandidatesSupportClassification(
      transaction,
      input.tenantId,
      parsed.data,
      input.effectiveClassification,
    );
    return {
      ...parsed.data,
      effectiveClassification: input.effectiveClassification,
    };
  }

  const request = readModelRouteRequest(input.modelPolicy);
  const effectiveClassification = maximumAiDataClassification(
    request.classification,
    input.effectiveClassification,
  );
  const policy = await transaction.aiModelRoutePolicyVersion.findFirst({
    where: {
      tenantId: input.tenantId,
      taskClass: request.taskClass,
      status: 'PUBLISHED',
    },
  });
  // A queued run must never fall back to a process-global model. Tenants that
  // have not published an explicit route stay unavailable until governance is
  // complete; the Runtime independently enforces the same trusted-route
  // boundary so neither side can silently weaken this decision.
  if (policy === null) throw new ModelRouteUnavailableError('MODEL_ROUTE_UNAVAILABLE');
  if (
    !isAiDataClassificationAtMost(effectiveClassification, policy.maximumClassification) ||
    request.requiredCapabilities.some(
      (capability) => !stringArray(policy.requiredCapabilities).includes(capability),
    )
  ) {
    throw new ModelRouteUnavailableError('MODEL_ROUTE_UNAVAILABLE');
  }

  const routeCandidates = await transaction.aiModelRouteCandidate.findMany({
    where: { tenantId: input.tenantId, policyVersionId: policy.id },
    orderBy: { ordinal: 'asc' },
  });
  const candidateIds = routeCandidates.map(({ catalogVersionId }) => catalogVersionId);
  const [catalogs, circuits] = await Promise.all([
    transaction.aiModelCatalogVersion.findMany({
      where: {
        tenantId: input.tenantId,
        id: { in: candidateIds },
        status: 'PUBLISHED',
      },
    }),
    transaction.aiModelCircuitStateRecord.findMany({
      where: { tenantId: input.tenantId, catalogVersionId: { in: candidateIds } },
    }),
  ]);
  const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
  const circuitById = new Map(circuits.map((circuit) => [circuit.catalogVersionId, circuit]));
  const now = Date.now();
  const candidates = routeCandidates.flatMap((candidate) => {
    const catalog = catalogById.get(candidate.catalogVersionId);
    if (catalog === undefined) return [];
    if (!isAiDataClassificationAtMost(effectiveClassification, catalog.maximumClassification)) {
      return [];
    }
    const circuit = circuitById.get(catalog.id);
    if (
      circuit?.state === 'OPEN' &&
      circuit.openedUntil !== null &&
      circuit.openedUntil.getTime() > now
    ) {
      return [];
    }
    return [
      {
        ordinal: candidate.ordinal,
        catalogVersionId: catalog.id,
        routeKey: catalog.routeKey,
        provider: catalog.provider,
        model: catalog.modelName,
        credentialReference: catalog.credentialReference,
      },
    ];
  });
  if (candidates.length === 0) throw new ModelRouteUnavailableError('MODEL_ROUTE_UNAVAILABLE');
  return trustedModelRouteSnapshotSchema.parse({
    schemaVersion: 1,
    policyVersionId: policy.id,
    policyVersion: policy.version,
    policyHash: policy.policyHash,
    taskClass: policy.taskClass,
    maximumClassification: policy.maximumClassification,
    effectiveClassification,
    requiredCapabilities: stringArray(policy.requiredCapabilities),
    maximumAttempts: Math.min(policy.maximumAttempts, candidates.length),
    circuitFailureThreshold: policy.circuitFailureThreshold,
    circuitOpenSeconds: policy.circuitOpenSeconds,
    candidates: candidates.slice(0, policy.maximumAttempts),
  });
}

export function readModelRouteRequest(value: Prisma.JsonValue): {
  readonly taskClass: string;
  readonly classification: AiDataClassification;
  readonly requiredCapabilities: readonly string[];
} {
  if (!isRecord(value)) {
    return {
      taskClass: 'GENERAL_QA',
      classification: 'INTERNAL',
      requiredCapabilities: ['chat'],
    };
  }
  const taskClass =
    typeof value.taskClass === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,119}$/u.test(value.taskClass)
      ? value.taskClass
      : 'GENERAL_QA';
  const classification = isClassification(value.dataClassification)
    ? value.dataClassification
    : 'INTERNAL';
  const requiredCapabilities =
    Array.isArray(value.requiredCapabilities) &&
    value.requiredCapabilities.length > 0 &&
    value.requiredCapabilities.length <= 32 &&
    value.requiredCapabilities.every(
      (capability) =>
        typeof capability === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/u.test(capability),
    )
      ? [...new Set(value.requiredCapabilities as string[])]
      : ['chat'];
  return { taskClass, classification, requiredCapabilities };
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ModelRouteUnavailableError('MODEL_ROUTE_SNAPSHOT_INVALID');
  }
  return [...value] as string[];
}

function isClassification(value: unknown): value is AiDataClassification {
  return (
    value === 'PUBLIC' || value === 'INTERNAL' || value === 'CONFIDENTIAL' || value === 'RESTRICTED'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertSnapshotCandidatesSupportClassification(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  snapshot: TrustedModelRouteSnapshot,
  effectiveClassification: AiDataClassification,
): Promise<void> {
  const catalogs = await transaction.aiModelCatalogVersion.findMany({
    where: {
      tenantId,
      id: { in: snapshot.candidates.map((candidate) => candidate.catalogVersionId) },
    },
  });
  const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
  const valid = snapshot.candidates.every((candidate) => {
    const catalog = catalogById.get(candidate.catalogVersionId);
    return (
      catalog !== undefined &&
      catalog.routeKey === candidate.routeKey &&
      catalog.provider === candidate.provider &&
      catalog.modelName === candidate.model &&
      catalog.credentialReference === candidate.credentialReference &&
      isAiDataClassificationAtMost(effectiveClassification, catalog.maximumClassification)
    );
  });
  if (!valid) throw new ModelRouteUnavailableError('MODEL_ROUTE_SNAPSHOT_INVALID');
}
