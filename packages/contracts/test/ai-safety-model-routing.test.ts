import { describe, expect, it } from 'vitest';

import {
  aiModelConnectivityProbeResultSchema,
  aiModelRoutingDashboardSchema,
  createAiModelCatalogVersionRequestSchema,
  createAiModelConnectivityProbeRequestSchema,
  createAiModelRoutePolicyVersionRequestSchema,
  trustedModelRouteSnapshotSchema,
} from '../src/ai-safety-model-routing.js';

const CATALOG_ID = '00000000-0000-7000-8000-000000000101';
const POLICY_ID = '00000000-0000-7000-8000-000000000102';

describe('AI safety model routing contracts', () => {
  it('accepts credential references while rejecting plaintext-looking credentials', () => {
    const base = {
      routeKey: 'GENERAL.PRIMARY',
      provider: 'OPENAI_COMPATIBLE',
      modelName: 'model-a',
      credentialReference: 'vault://ai/providers/general',
      dataResidency: 'CN',
      maximumClassification: 'CONFIDENTIAL',
      capabilities: ['chat'],
      maxContextTokens: 128_000,
      maxOutputTokens: 4_000,
      inputCostMicrosPerMillion: '1000',
      outputCostMicrosPerMillion: '2000',
      p95LatencyMs: 8_000,
      idempotencyKey: 'catalog-1',
    } as const;
    expect(createAiModelCatalogVersionRequestSchema.safeParse(base).success).toBe(true);
    expect(
      createAiModelCatalogVersionRequestSchema.safeParse({
        ...base,
        credentialReference: 'secret=plaintext-provider-key',
      }).success,
    ).toBe(false);
  });

  it('bounds route candidates by the immutable attempt budget', () => {
    const result = createAiModelRoutePolicyVersionRequestSchema.safeParse({
      taskClass: 'GENERAL_QA',
      allowedResidencies: ['CN'],
      maximumClassification: 'INTERNAL',
      requiredCapabilities: ['chat'],
      maxP95LatencyMs: 8_000,
      maxInputCostMicrosPerMillion: '5000',
      maxOutputCostMicrosPerMillion: '10000',
      maximumAttempts: 1,
      circuitFailureThreshold: 5,
      circuitOpenSeconds: 60,
      catalogVersionIds: [CATALOG_ID, '00000000-0000-7000-8000-000000000103'],
      idempotencyKey: 'policy-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects arbitrary endpoint and key fields in a Runtime route snapshot', () => {
    const route = {
      schemaVersion: 1,
      policyVersionId: POLICY_ID,
      policyVersion: 1,
      policyHash: 'a'.repeat(64),
      taskClass: 'GENERAL_QA',
      maximumClassification: 'INTERNAL',
      requiredCapabilities: ['chat'],
      maximumAttempts: 1,
      circuitFailureThreshold: 5,
      circuitOpenSeconds: 60,
      candidates: [
        {
          ordinal: 1,
          catalogVersionId: CATALOG_ID,
          routeKey: 'GENERAL.PRIMARY',
          provider: 'OPENAI_COMPATIBLE',
          model: 'model-a',
          credentialReference: 'vault://ai/providers/general',
        },
      ],
    };
    expect(trustedModelRouteSnapshotSchema.safeParse(route).success).toBe(true);
    expect(
      trustedModelRouteSnapshotSchema.safeParse({
        ...route,
        effectiveClassification: 'RESTRICTED',
      }).success,
    ).toBe(false);
    expect(
      trustedModelRouteSnapshotSchema.safeParse({
        ...route,
        candidates: [
          {
            ...route.candidates[0],
            endpoint: 'https://attacker.invalid/v1',
            apiKey: 'plaintext',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires explicit Runtime and provider evidence before readiness can be represented', () => {
    const readiness = {
      catalogVersions: [],
      routePolicies: [],
      readiness: {
        publishedCatalogCount: 0,
        publishedPolicyCount: 0,
        activeCandidateCount: 0,
        invalidPublishedPolicyCount: 0,
        runtimeAllowlistedCandidateCount: 0,
        recentSuccessfulCandidateCount: 0,
        openCircuitCount: 0,
        blockedSafetyDecisionCount24h: 0,
        status: 'NOT_READY',
        evidenceStatus: 'INSUFFICIENT_EVIDENCE',
        ready: false,
        reasonCodes: ['RUNTIME_READINESS_UNAVAILABLE'],
        runtime: {
          status: 'UNAVAILABLE',
          requireTrustedRoute: null,
          providerReady: null,
          checkedAt: null,
        },
      },
    };
    expect(aiModelRoutingDashboardSchema.safeParse(readiness).success).toBe(true);
    expect(
      aiModelRoutingDashboardSchema.safeParse({
        ...readiness,
        readiness: {
          publishedCatalogCount: 1,
          publishedPolicyCount: 1,
          openCircuitCount: 0,
          blockedSafetyDecisionCount24h: 0,
          ready: true,
          reasonCodes: [],
        },
      }).success,
    ).toBe(false);
  });

  it('requires a durable real-attempt receipt before a connectivity probe is verified', () => {
    expect(
      createAiModelConnectivityProbeRequestSchema.safeParse({
        idempotencyKey: 'probe-1',
      }).success,
    ).toBe(true);

    const result = {
      runId: '00000000-0000-7000-8000-000000000104',
      agentId: '00000000-0000-7000-8000-000000000105',
      targetCatalogVersionId: CATALOG_ID,
      status: 'SUCCEEDED',
      evidenceStatus: 'VERIFIED',
      reasonCode: null,
      successfulReceiptCatalogVersionIds: [CATALOG_ID],
      checkedAt: '2026-07-28T08:00:00.000Z',
    } as const;
    expect(aiModelConnectivityProbeResultSchema.safeParse(result).success).toBe(true);
    expect(
      aiModelConnectivityProbeResultSchema.safeParse({
        ...result,
        successfulReceiptCatalogVersionIds: [],
      }).success,
    ).toBe(false);
  });
});
