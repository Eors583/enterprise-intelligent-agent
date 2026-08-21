import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../database/prisma.service.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { AiSafetyModelRoutingService } from './ai-safety-model-routing.service.js';
import type {
  ModelRoutingRuntimeReadinessClient,
  RuntimeModelRoutingReadiness,
} from './model-routing-runtime-readiness.client.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const CATALOG_ID = '00000000-0000-7000-8000-000000000003';
const POLICY_ID = '00000000-0000-7000-8000-000000000004';

describe('AI model routing readiness evidence', () => {
  it('is READY only when candidates, Runtime allowlist and recent success all agree', async () => {
    const service = serviceWith(
      runtimeEvidence({
        status: 'READY',
        requireTrustedRoute: true,
        providerReady: true,
        routes: [
          {
            routeKey: 'GENERAL.PRIMARY',
            catalogVersionId: CATALOG_ID,
            provider: 'OPENAI_COMPATIBLE',
            model: 'model-a',
            configurationSha256: configurationSha256(),
          },
        ],
      }),
      true,
    );

    const dashboard = await service.dashboard({ status: 'DRAFT' });

    expect(dashboard.catalogVersions).toEqual([]);
    expect(dashboard.routePolicies).toEqual([]);
    expect(dashboard.readiness).toMatchObject({
      status: 'READY',
      evidenceStatus: 'VERIFIED',
      ready: true,
      publishedCatalogCount: 1,
      publishedPolicyCount: 1,
      activeCandidateCount: 1,
      invalidPublishedPolicyCount: 0,
      runtimeAllowlistedCandidateCount: 1,
      recentSuccessfulCandidateCount: 1,
      reasonCodes: [],
    });
  });

  it('fails closed instead of turning green when Runtime or provider evidence is missing', async () => {
    const service = serviceWith(
      runtimeEvidence({
        status: 'UNAVAILABLE',
        requireTrustedRoute: null,
        providerReady: null,
        routes: [],
      }),
      false,
    );

    const dashboard = await service.dashboard({});

    expect(dashboard.readiness.status).toBe('NOT_READY');
    expect(dashboard.readiness.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(dashboard.readiness.ready).toBe(false);
    expect(dashboard.readiness.reasonCodes).toEqual(
      expect.arrayContaining([
        'RUNTIME_READINESS_UNAVAILABLE',
        'NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE',
      ]),
    );
  });
});

function serviceWith(
  runtime: RuntimeModelRoutingReadiness,
  recentSuccess: boolean,
): AiSafetyModelRoutingService {
  const catalog = {
    id: CATALOG_ID,
    tenantId: TENANT_ID,
    routeKey: 'GENERAL.PRIMARY',
    status: 'PUBLISHED',
    provider: 'OPENAI_COMPATIBLE',
    modelName: 'model-a',
    credentialReference: 'vault://ai/general-primary',
    dataResidency: 'CN',
    maximumClassification: 'CONFIDENTIAL',
    capabilities: ['chat'],
    p95LatencyMs: 1_000,
    inputCostMicrosPerMillion: 1_000n,
    outputCostMicrosPerMillion: 2_000n,
  };
  const policy = {
    id: POLICY_ID,
    tenantId: TENANT_ID,
    status: 'PUBLISHED',
    maximumAttempts: 1,
    allowedResidencies: ['CN'],
    maximumClassification: 'INTERNAL',
    requiredCapabilities: ['chat'],
    maxP95LatencyMs: 5_000,
    maxInputCostMicrosPerMillion: 5_000n,
    maxOutputCostMicrosPerMillion: 10_000n,
  };
  const transaction = {
    aiModelCatalogVersion: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('id' in where) return [catalog];
        if (where.status === 'PUBLISHED') return [catalog];
        return [];
      }),
    },
    aiModelRoutePolicyVersion: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.status === 'PUBLISHED' ? [policy] : [],
      ),
    },
    aiModelRouteCandidate: {
      findMany: vi.fn().mockResolvedValue([
        {
          tenantId: TENANT_ID,
          policyVersionId: POLICY_ID,
          ordinal: 1,
          catalogVersionId: CATALOG_ID,
        },
      ]),
    },
    aiModelCircuitStateRecord: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    aiModelAttemptReceipt: {
      findMany: vi.fn().mockResolvedValue(recentSuccess ? [{ catalogVersionId: CATALOG_ID }] : []),
    },
    aiSafetyDecisionRecord: {
      count: vi.fn().mockResolvedValue(0),
    },
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withTenant: <T>(_tenantId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>) =>
      operation(transaction),
  } as unknown as PrismaService;
  const access = {
    requireDirectoryRead: () => ({
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: 'ADMIN' as const,
    }),
  } as unknown as AdminAccessService;
  const readinessClient = {
    inspect: vi.fn().mockResolvedValue(runtime),
  } as unknown as ModelRoutingRuntimeReadinessClient;
  return new AiSafetyModelRoutingService(prisma, access, readinessClient);
}

function runtimeEvidence(
  overrides: Omit<RuntimeModelRoutingReadiness, 'checkedAt'>,
): RuntimeModelRoutingReadiness {
  return {
    ...overrides,
    checkedAt: overrides.status === 'UNAVAILABLE' ? null : new Date(),
  };
}

function configurationSha256(): string {
  return createHash('sha256')
    .update(
      [
        'GENERAL.PRIMARY',
        CATALOG_ID,
        'OPENAI_COMPATIBLE',
        'model-a',
        'vault://ai/general-primary',
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
}
