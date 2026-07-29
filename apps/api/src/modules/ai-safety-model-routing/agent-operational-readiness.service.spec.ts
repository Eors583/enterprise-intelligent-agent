import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentOperationalReadinessService } from './agent-operational-readiness.service.js';
import { modelRouteConfigurationSha256 } from './model-route-readiness.support.js';
import type { RuntimeModelRoutingReadiness } from './model-routing-runtime-readiness.client.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000201';
const POLICY_ID = '00000000-0000-7000-8000-000000000301';
const CATALOG_ID = '00000000-0000-7000-8000-000000000401';

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentOperationalReadinessService', () => {
  it('returns UNKNOWN and fails closed when Runtime readiness is unavailable', async () => {
    const harness = createHarness({ runtime: runtimeUnavailable() });

    await expectStatus(harness.service, 'UNKNOWN', 'RUNTIME_READINESS_UNAVAILABLE');
  });

  it('rejects a route that is not an exact Runtime allowlist match', async () => {
    const harness = createHarness({
      runtime: runtimeReady({ configurationSha256: 'f'.repeat(64) }),
    });

    await expectStatus(harness.service, 'NOT_READY', 'RUNTIME_ALLOWLIST_MISMATCH');
  });

  it('does not infer readiness without a recent real successful receipt', async () => {
    const harness = createHarness({ recentSuccess: false });

    await expectStatus(harness.service, 'NOT_READY', 'NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE');
  });

  it('returns AVAILABLE only when policy, circuit, Runtime route and real receipt all agree', async () => {
    const harness = createHarness();

    const availability = (await harness.service.inspectAgents(TENANT_ID, [AGENT_ID])).get(AGENT_ID);

    expect(availability).toMatchObject({
      status: 'AVAILABLE',
      evidenceStatus: 'VERIFIED',
      reasonCodes: [],
    });
  });

  it('re-reads Agent status immediately while expiring only the short Runtime cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T01:00:00.000Z'));
    const harness = createHarness({
      runtimeSequence: [
        runtimeReady(),
        {
          ...runtimeReady(),
          status: 'NOT_READY',
          providerReady: false,
        },
      ],
    });

    await expectStatus(harness.service, 'AVAILABLE');
    harness.agentStatus.value = 'OFFLINE';
    await expectStatus(harness.service, 'NOT_READY', 'AGENT_CONFIGURATION_NOT_ONLINE');
    expect(harness.runtimeInspect).toHaveBeenCalledTimes(1);

    harness.agentStatus.value = 'ONLINE';
    await vi.advanceTimersByTimeAsync(5_001);
    await expectStatus(harness.service, 'NOT_READY', 'RUNTIME_TRUSTED_ROUTE_NOT_READY');
    expect(harness.runtimeInspect).toHaveBeenCalledTimes(2);
  });
});

async function expectStatus(
  service: AgentOperationalReadinessService,
  status: 'AVAILABLE' | 'NOT_READY' | 'DEGRADED' | 'UNKNOWN',
  reasonCode?: string,
): Promise<void> {
  const availability = (await service.inspectAgents(TENANT_ID, [AGENT_ID])).get(AGENT_ID);
  expect(availability?.status).toBe(status);
  if (reasonCode !== undefined) expect(availability?.reasonCodes).toContain(reasonCode);
}

function createHarness(options?: {
  readonly runtime?: RuntimeModelRoutingReadiness;
  readonly runtimeSequence?: readonly RuntimeModelRoutingReadiness[];
  readonly recentSuccess?: boolean;
}) {
  const catalog = {
    id: CATALOG_ID,
    tenantId: TENANT_ID,
    routeKey: 'general-primary',
    version: 1,
    revision: 1,
    status: 'PUBLISHED',
    provider: 'OPENAI_COMPATIBLE',
    modelName: 'model-a',
    credentialReference: 'secret://model-a',
    dataResidency: 'CN',
    maximumClassification: 'CONFIDENTIAL',
    capabilities: ['chat'],
    maxContextTokens: 16_000,
    maxOutputTokens: 4_000,
    inputCostMicrosPerMillion: 1n,
    outputCostMicrosPerMillion: 1n,
    p95LatencyMs: 1_000,
    configurationHash: 'a'.repeat(64),
    createdByUserId: AGENT_ID,
    submittedByUserId: AGENT_ID,
    submittedAt: new Date(),
    reviewedByUserId: AGENT_ID,
    reviewedAt: new Date(),
    publishedByUserId: AGENT_ID,
    publishedAt: new Date(),
    retiredAt: null,
    idempotencyKey: 'catalog',
    requestHash: 'b'.repeat(64),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
  const agentStatus: { value: 'ONLINE' | 'OFFLINE' | 'DISABLED' } = { value: 'ONLINE' };
  const transaction = {
    agentInstance: {
      findMany: vi.fn(() =>
        Promise.resolve([
          {
            id: AGENT_ID,
            status: agentStatus.value,
            version: {
              status: 'PUBLISHED',
              modelPolicy: {
                taskClass: 'GENERAL_QA',
                dataClassification: 'INTERNAL',
                requiredCapabilities: ['chat'],
              },
            },
          },
        ]),
      ),
    },
    aiModelRoutePolicyVersion: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: POLICY_ID,
          tenantId: TENANT_ID,
          taskClass: 'GENERAL_QA',
          version: 1,
          status: 'PUBLISHED',
          allowedResidencies: ['CN'],
          maximumClassification: 'CONFIDENTIAL',
          requiredCapabilities: ['chat'],
          maxP95LatencyMs: 2_000,
          maxInputCostMicrosPerMillion: 2n,
          maxOutputCostMicrosPerMillion: 2n,
          maximumAttempts: 1,
        },
      ]),
    },
    aiModelRouteCandidate: {
      findMany: vi.fn().mockResolvedValue([
        {
          tenantId: TENANT_ID,
          policyVersionId: POLICY_ID,
          ordinal: 1,
          catalogVersionId: CATALOG_ID,
          createdAt: new Date(),
        },
      ]),
    },
    aiModelCatalogVersion: { findMany: vi.fn().mockResolvedValue([catalog]) },
    aiModelCircuitStateRecord: { findMany: vi.fn().mockResolvedValue([]) },
    aiModelAttemptReceipt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options?.recentSuccess === false ? [] : [{ catalogVersionId: CATALOG_ID }],
        ),
    },
  };
  const prisma = {
    enabled: true,
    withTenant: vi.fn((_tenantId: string, operation: (value: unknown) => Promise<unknown>) =>
      operation(transaction),
    ),
  };
  const runtimeInspect = vi.fn();
  const sequence = options?.runtimeSequence ?? [
    options?.runtime ??
      runtimeReady({ configurationSha256: modelRouteConfigurationSha256(catalog) }),
  ];
  for (const runtime of sequence) runtimeInspect.mockResolvedValueOnce(runtime);
  const service = new AgentOperationalReadinessService(
    prisma as never,
    {
      inspect: runtimeInspect,
    } as never,
  );
  return { service, runtimeInspect, agentStatus };
}

function runtimeReady(
  routeOverrides: Partial<RuntimeModelRoutingReadiness['routes'][number]> = {},
): RuntimeModelRoutingReadiness {
  const catalogIdentity = {
    id: CATALOG_ID,
    routeKey: 'general-primary',
    provider: 'OPENAI_COMPATIBLE',
    modelName: 'model-a',
    credentialReference: 'secret://model-a',
  };
  return {
    status: 'READY',
    requireTrustedRoute: true,
    providerReady: true,
    checkedAt: new Date(),
    routes: [
      {
        routeKey: catalogIdentity.routeKey,
        catalogVersionId: catalogIdentity.id,
        provider: 'OPENAI_COMPATIBLE',
        model: catalogIdentity.modelName,
        configurationSha256: modelRouteConfigurationSha256(catalogIdentity),
        ...routeOverrides,
      },
    ],
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
