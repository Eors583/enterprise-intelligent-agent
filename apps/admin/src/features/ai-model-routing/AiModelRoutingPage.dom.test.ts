import type { AiModelCatalogVersion, AiModelRoutePolicyVersion } from '@enterprise/contracts';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInTestDom } from '@/test/dom-test-utils';

const apiMocks = vi.hoisted(() => ({
  loadAiModelRoutingDashboard: vi.fn(),
  runAiModelConnectivityProbe: vi.fn(),
  createAiModelCatalogVersion: vi.fn(),
  createAiModelRoutePolicyVersion: vi.fn(),
  transitionAiModelCatalogVersion: vi.fn(),
  transitionAiModelRoutePolicyVersion: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import {
  AiModelRoutingPage,
  aiRouteCode,
  catalogDraftFromExisting,
  derivePolicyConstraints,
  policyDraftFromExisting,
} from './AiModelRoutingPage';

const CATALOG: AiModelCatalogVersion = {
  id: '00000000-0000-7000-8000-000000000401',
  tenantId: '00000000-0000-7000-8000-000000000101',
  routeKey: 'MODEL.OPENAI_COMPATIBLE.ENTERPRISE.CHAT',
  version: 3,
  revision: 2,
  status: 'PUBLISHED',
  provider: 'OPENAI_COMPATIBLE',
  modelName: 'enterprise-chat',
  credentialReference: 'vault://ai/providers/enterprise',
  dataResidency: 'CN',
  maximumClassification: 'CONFIDENTIAL',
  capabilities: ['chat', 'tools'],
  maxContextTokens: 128_000,
  maxOutputTokens: 8_000,
  inputCostMicrosPerMillion: '900719925474099300',
  outputCostMicrosPerMillion: '900719925474099500',
  p95LatencyMs: 8_000,
  configurationHash: 'a'.repeat(64),
  submittedByUserId: '00000000-0000-7000-8000-000000000201',
  reviewedByUserId: '00000000-0000-7000-8000-000000000202',
  publishedByUserId: '00000000-0000-7000-8000-000000000202',
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T02:00:00.000Z',
};

const SECOND_CATALOG: AiModelCatalogVersion = {
  ...CATALOG,
  id: '00000000-0000-7000-8000-000000000402',
  routeKey: 'MODEL.MANUS.ENTERPRISE.REASONING',
  provider: 'MANUS',
  modelName: 'enterprise-reasoning',
  credentialReference: 'vault://ai/providers/reasoning',
  dataResidency: 'SG',
  maximumClassification: 'INTERNAL',
  capabilities: ['chat', 'reasoning'],
  inputCostMicrosPerMillion: '900719925474099200',
  outputCostMicrosPerMillion: '900719925474099600',
  p95LatencyMs: 12_000,
  configurationHash: 'b'.repeat(64),
};

const POLICY: AiModelRoutePolicyVersion = {
  id: '00000000-0000-7000-8000-000000000501',
  tenantId: CATALOG.tenantId,
  taskClass: 'KNOWLEDGE_QA',
  version: 2,
  revision: 4,
  status: 'PUBLISHED',
  allowedResidencies: ['CN'],
  maximumClassification: 'CONFIDENTIAL',
  requiredCapabilities: ['chat'],
  maxP95LatencyMs: 8_000,
  maxInputCostMicrosPerMillion: CATALOG.inputCostMicrosPerMillion,
  maxOutputCostMicrosPerMillion: CATALOG.outputCostMicrosPerMillion,
  maximumAttempts: 2,
  circuitFailureThreshold: 5,
  circuitOpenSeconds: 60,
  policyHash: 'c'.repeat(64),
  submittedByUserId: '00000000-0000-7000-8000-000000000201',
  reviewedByUserId: '00000000-0000-7000-8000-000000000202',
  publishedByUserId: '00000000-0000-7000-8000-000000000202',
  candidates: [
    {
      ordinal: 1,
      catalogVersionId: CATALOG.id,
      routeKey: CATALOG.routeKey,
      provider: CATALOG.provider,
      modelName: CATALOG.modelName,
      credentialReference: CATALOG.credentialReference,
      dataResidency: CATALOG.dataResidency,
      maximumClassification: CATALOG.maximumClassification,
      capabilities: [...CATALOG.capabilities],
      p95LatencyMs: CATALOG.p95LatencyMs,
      circuitState: 'CLOSED',
      circuitOpenedUntil: null,
    },
  ],
  createdAt: '2026-07-28T01:00:00.000Z',
  updatedAt: '2026-07-28T02:00:00.000Z',
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.loadAiModelRoutingDashboard.mockResolvedValue({
    catalogVersions: [],
    routePolicies: [],
    readiness: {
      publishedCatalogCount: 0,
      publishedPolicyCount: 0,
      activeCandidateCount: 1,
      invalidPublishedPolicyCount: 1,
      runtimeAllowlistedCandidateCount: 0,
      recentSuccessfulCandidateCount: 0,
      openCircuitCount: 2,
      blockedSafetyDecisionCount24h: 3,
      status: 'NOT_READY',
      evidenceStatus: 'INSUFFICIENT_EVIDENCE',
      ready: false,
      reasonCodes: [
        'NO_PUBLISHED_MODEL',
        'NO_PUBLISHED_ROUTE',
        'OPEN_CIRCUIT',
        'RUNTIME_READINESS_UNAVAILABLE',
      ],
      runtime: {
        status: 'UNAVAILABLE',
        requireTrustedRoute: null,
        providerReady: null,
        checkedAt: null,
      },
    },
  });
});

describe('AI model routing governance DOM acceptance', () => {
  it('exposes readiness, circuit and safety state without accepting provider secrets', async () => {
    const dom = await renderInTestDom(createElement(AiModelRoutingPage));
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('NOT_READY');
      expect(dom.container.textContent).toContain('INSUFFICIENT_EVIDENCE');
      expect(dom.container.textContent).toContain('NO_PUBLISHED_MODEL');
      expect(dom.container.textContent).toContain('OPEN_CIRCUIT');
      expect(dom.container.textContent).toContain('RUNTIME_READINESS_UNAVAILABLE');
      expect(dom.container.textContent).toContain('24h');
      expect(
        dom.container
          .querySelector('input[name="credentialReference"]')
          ?.getAttribute('placeholder'),
      ).toBe('vault://ai/providers/general');
      const advanced = dom.container
        .querySelector('input[name="credentialReference"]')
        ?.closest('details');
      expect(advanced?.classList.contains('ai-routing-advanced-details')).toBe(true);
      expect(advanced?.hasAttribute('open')).toBe(false);
      expect(dom.container.querySelector('input[name="apiKey"]')).toBeNull();
      expect(dom.container.querySelector('input[name="baseUrl"]')).toBeNull();
      expect(dom.container.querySelector('input[type="password"]')).toBeNull();
      expect(dom.container.textContent).toContain('系统不会生成示例模型');
      expect(dom.container.textContent).toContain('真实 Provider 恢复验证');
      expect(dom.container.textContent).toContain('本地 Runtime 探针只证明配置存在');
      expect(dom.container.textContent).toContain('企业所有者可直接发布');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps technical provider fields closed and exposes controlled catalog and policy choices', async () => {
    apiMocks.loadAiModelRoutingDashboard.mockResolvedValue({
      catalogVersions: [CATALOG],
      routePolicies: [POLICY],
      readiness: {
        publishedCatalogCount: 1,
        publishedPolicyCount: 1,
        activeCandidateCount: 1,
        invalidPublishedPolicyCount: 0,
        runtimeAllowlistedCandidateCount: 1,
        recentSuccessfulCandidateCount: 1,
        openCircuitCount: 0,
        blockedSafetyDecisionCount24h: 0,
        status: 'READY',
        evidenceStatus: 'VERIFIED',
        ready: true,
        reasonCodes: [],
        runtime: {
          status: 'READY',
          requireTrustedRoute: true,
          providerReady: true,
          checkedAt: '2026-07-28T01:00:00.000Z',
        },
      },
    });

    const dom = await renderInTestDom(createElement(AiModelRoutingPage));
    try {
      await dom.flush();

      expect(dom.container.querySelector('select[name="existingCatalogId"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="existingPolicyId"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="taskClass"]')).not.toBeNull();
      expect(dom.container.querySelector('select[name="policyPreset"]')).not.toBeNull();
      expect(
        dom.container.querySelector(
          '.ai-routing-business-form select[name="maximumClassification"]',
        ),
      ).not.toBeNull();
      expect(
        dom.container.querySelectorAll('.ai-routing-business-form input[type="checkbox"]'),
      ).toHaveLength(1);

      const technicalNames = [
        'provider',
        'modelName',
        'credentialReference',
        'dataResidency',
        'maxContextTokens',
        'maxOutputTokens',
        'inputCostMicrosPerMillion',
        'outputCostMicrosPerMillion',
        'p95LatencyMs',
      ];
      for (const name of technicalNames) {
        const field = dom.container.querySelector(`[name="${name}"]`);
        expect(field, `${name} should remain available in advanced settings`).not.toBeNull();
        expect(
          field?.closest('details')?.hasAttribute('open'),
          `${name} should be closed by default`,
        ).toBe(false);
      }
      const capabilityPicker = dom.container.querySelector('.ai-routing-capability-picker');
      expect(capabilityPicker).not.toBeNull();
      expect(capabilityPicker?.closest('details')?.hasAttribute('open')).toBe(false);
      expect(capabilityPicker?.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
      expect(dom.container.textContent).not.toContain('能力（逗号分隔）');
      const advancedClassification = dom.container.querySelector(
        '.ai-routing-technical-form select[name="maximumClassification"]',
      );
      expect(advancedClassification).not.toBeNull();
      expect(advancedClassification?.closest('details')?.hasAttribute('open')).toBe(false);
      const taskClassOverride = dom.container.querySelector('input[name="taskClassOverride"]');
      expect(taskClassOverride).toBeNull();

      for (const derivedName of [
        'allowedResidencies',
        'requiredCapabilities',
        'maxP95LatencyMs',
        'maxInputCostMicrosPerMillion',
        'maxOutputCostMicrosPerMillion',
        'maximumAttempts',
        'circuitFailureThreshold',
        'circuitOpenSeconds',
      ]) {
        expect(dom.container.querySelector(`[name="${derivedName}"]`)).toBeNull();
      }
    } finally {
      await dom.cleanup();
    }
  });

  it('offers a controlled real provider test when only recent evidence is missing', async () => {
    apiMocks.loadAiModelRoutingDashboard.mockResolvedValue({
      catalogVersions: [],
      routePolicies: [],
      readiness: {
        publishedCatalogCount: 1,
        publishedPolicyCount: 1,
        activeCandidateCount: 1,
        invalidPublishedPolicyCount: 0,
        runtimeAllowlistedCandidateCount: 1,
        recentSuccessfulCandidateCount: 0,
        openCircuitCount: 0,
        blockedSafetyDecisionCount24h: 0,
        status: 'NOT_READY',
        evidenceStatus: 'INSUFFICIENT_EVIDENCE',
        ready: false,
        reasonCodes: ['NO_RECENT_SUCCESSFUL_PROVIDER_EVIDENCE'],
        runtime: {
          status: 'READY',
          requireTrustedRoute: true,
          providerReady: true,
          checkedAt: '2026-07-28T01:00:00.000Z',
        },
      },
    });
    apiMocks.runAiModelConnectivityProbe.mockResolvedValue({
      runId: '00000000-0000-7000-8000-000000000701',
      agentId: '00000000-0000-7000-8000-000000000201',
      targetCatalogVersionId: '00000000-0000-7000-8000-000000000401',
      status: 'SUCCEEDED',
      evidenceStatus: 'VERIFIED',
      reasonCode: null,
      successfulReceiptCatalogVersionIds: ['00000000-0000-7000-8000-000000000401'],
      checkedAt: '2026-07-28T01:00:00.000Z',
    });

    const dom = await renderInTestDom(createElement(AiModelRoutingPage));
    try {
      await dom.flush();
      const button = [...dom.container.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes('执行真实模型连通性测试'),
      );
      expect(button?.hasAttribute('disabled')).toBe(false);
      if (button) await dom.click(button);
      await dom.flush();

      expect(apiMocks.runAiModelConnectivityProbe).toHaveBeenCalledWith({
        idempotencyKey: expect.any(String),
      });
      expect(dom.container.textContent).toContain('SUCCEEDED · VERIFIED');
      expect(dom.container.textContent).toContain('00000000-0000-7000-8000-000000000401');
    } finally {
      await dom.cleanup();
    }
  });
});

describe('AI model routing selection helpers', () => {
  it('generates a stable route code and preserves an existing catalog as a new draft', () => {
    expect(aiRouteCode('OPENAI_COMPATIBLE', 'Enterprise Chat / CN')).toBe(
      'MODEL.OPENAI_COMPATIBLE.ENTERPRISE.CHAT.CN',
    );
    expect(catalogDraftFromExisting(CATALOG, 'catalog-clone')).toEqual({
      routeKey: CATALOG.routeKey,
      provider: CATALOG.provider,
      modelName: CATALOG.modelName,
      credentialReference: CATALOG.credentialReference,
      dataResidency: CATALOG.dataResidency,
      maximumClassification: CATALOG.maximumClassification,
      capabilities: CATALOG.capabilities,
      maxContextTokens: CATALOG.maxContextTokens,
      maxOutputTokens: CATALOG.maxOutputTokens,
      inputCostMicrosPerMillion: CATALOG.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: CATALOG.outputCostMicrosPerMillion,
      p95LatencyMs: CATALOG.p95LatencyMs,
      idempotencyKey: 'catalog-clone',
    });
  });

  it('derives route constraints from selected real catalogs without losing large costs', () => {
    expect(derivePolicyConstraints([CATALOG, SECOND_CATALOG], 'BALANCED')).toEqual({
      allowedResidencies: ['CN', 'SG'],
      requiredCapabilities: ['chat'],
      maxP95LatencyMs: 12_000,
      maxInputCostMicrosPerMillion: '900719925474099300',
      maxOutputCostMicrosPerMillion: '900719925474099600',
      maximumAttempts: 2,
      circuitFailureThreshold: 5,
      circuitOpenSeconds: 60,
    });
  });

  it('preserves the existing policy wire contract when it is reused', () => {
    expect(policyDraftFromExisting(POLICY, 'policy-clone')).toEqual({
      taskClass: POLICY.taskClass,
      allowedResidencies: POLICY.allowedResidencies,
      maximumClassification: POLICY.maximumClassification,
      requiredCapabilities: POLICY.requiredCapabilities,
      maxP95LatencyMs: POLICY.maxP95LatencyMs,
      maxInputCostMicrosPerMillion: POLICY.maxInputCostMicrosPerMillion,
      maxOutputCostMicrosPerMillion: POLICY.maxOutputCostMicrosPerMillion,
      maximumAttempts: POLICY.maximumAttempts,
      circuitFailureThreshold: POLICY.circuitFailureThreshold,
      circuitOpenSeconds: POLICY.circuitOpenSeconds,
      catalogVersionIds: [CATALOG.id],
      idempotencyKey: 'policy-clone',
    });
  });
});
