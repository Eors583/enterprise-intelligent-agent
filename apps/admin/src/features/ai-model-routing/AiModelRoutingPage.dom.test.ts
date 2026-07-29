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

import { AiModelRoutingPage } from './AiModelRoutingPage';

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
      expect(dom.container.querySelector('input[name="apiKey"]')).toBeNull();
      expect(dom.container.querySelector('input[name="baseUrl"]')).toBeNull();
      expect(dom.container.querySelector('input[type="password"]')).toBeNull();
      expect(dom.container.textContent).toContain('真实 Provider 恢复验证');
      expect(dom.container.textContent).toContain('本地 Runtime 探针只证明配置存在');
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
