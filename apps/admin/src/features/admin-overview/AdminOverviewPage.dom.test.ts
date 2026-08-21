import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadAdminOverviewMock } = vi.hoisted(() => ({ loadAdminOverviewMock: vi.fn() }));
vi.mock('./api', () => ({ loadAdminOverview: loadAdminOverviewMock }));

import { AdminOverviewPage } from './AdminOverviewPage';
import { renderInTestDom } from '@/test/dom-test-utils';

function overviewFixture() {
  const window = {
    from: '2026-07-28T00:00:00.000Z',
    total: 4,
    succeeded: 2,
    failed: 1,
    unknown: 1,
    cancelled: 0,
    inProgress: 0,
    trustedUsageRuns: 2,
    unreportedUsageRuns: 2,
    quotaUpperBoundRuns: 1,
    inputTokens: '1200',
    outputTokens: '300',
    totalTokens: '1500',
    quotaChargedTokens: '20000',
    costMicros: '210000',
    latencySampleCount: 2,
    averageLatencyMs: 1200,
    p95LatencyMs: 1800,
    groundedSucceededRuns: 1,
    ungroundedSucceededRuns: 1,
    helpfulFeedback: 3,
    notHelpfulFeedback: 1,
    feedbackSampleCount: 4,
    helpfulRateBps: 7500,
  };
  return {
    generatedAt: '2026-07-28T01:00:00.000Z',
    people: {
      total: 10,
      active: 8,
      inactive: 1,
      locked: 1,
      pendingInvitations: 1,
      activeUsers7d: 6,
    },
    agents: {
      total: 3,
      configuredOnline: 3,
      available: 1,
      notReady: 2,
      degraded: 0,
      unknown: 0,
    },
    ai: { today: window, month: window },
    knowledge: {
      activeBases: 1,
      totalDocuments: 5,
      readyDocuments: 3,
      failedDocuments: 1,
      pendingParseReviews: 1,
      rejectedParseReviews: 0,
      failedIngestionJobs: 1,
      totalChunks: 30,
      chunksWithEmbeddings: 20,
      chunksMissingEmbeddings: 10,
    },
    directory: {
      latestRunStatus: 'FAILED' as const,
      latestRunFinishedAt: '2026-07-28T00:30:00.000Z',
      failedRuns24h: 1,
      pendingPreviewItems: 2,
    },
    operations: {
      pendingOutboxEvents: 2,
      failedOutboxEvents: 1,
      unknownOutboxEvents: 1,
      quarantinedOutboxEvents: 1,
      unknownAgentRuns24h: 1,
    },
    alerts: [
      {
        code: 'AGENTS_NOT_OPERATIONALLY_AVAILABLE',
        severity: 'CRITICAL' as const,
        count: 2,
        title: '智能体尚未形成真实可用证据',
        description: '已发布不等于模型可用。',
        target: 'ai-model-routing' as const,
      },
    ],
  };
}

describe('AdminOverviewPage', () => {
  beforeEach(() => loadAdminOverviewMock.mockReset());

  it('renders persisted operational evidence and explicit external acceptance caveats', async () => {
    loadAdminOverviewMock.mockResolvedValue(overviewFixture());
    const dom = await renderInTestDom(createElement(AdminOverviewPage));
    try {
      await dom.flush();
      expect(dom.container.textContent).toContain('管理概览');
      expect(dom.container.textContent).toContain('真实可用智能体');
      expect(dom.container.textContent).toContain('1/3');
      expect(dom.container.textContent).toContain('近 7 天活跃 6');
      expect(dom.container.textContent).toContain('75.0% (4)');
      expect(dom.container.textContent).toContain('智能体使用效果');
      expect(dom.container.textContent).toContain('组织通讯录同步');
      expect(dom.container.textContent).not.toContain('成本微单位');
      expect(dom.container.textContent).not.toContain('Outbox');
      expect(dom.container.textContent).toContain('指定模型');
      expect(dom.container.textContent).not.toContain('AGENTS_NOT_OPERATIONALLY_AVAILABLE');
    } finally {
      await dom.cleanup();
    }
  });

  it('keeps the loading state empty instead of falling back to sample metrics', async () => {
    let resolve!: (value: ReturnType<typeof overviewFixture>) => void;
    loadAdminOverviewMock.mockReturnValue(
      new Promise<ReturnType<typeof overviewFixture>>((accept) => {
        resolve = accept;
      }),
    );
    const dom = await renderInTestDom(createElement(AdminOverviewPage));
    try {
      expect(dom.container.textContent).toContain('正在读取企业运行状态');
      expect(dom.container.querySelector('[aria-label="企业运行概况"]')).toBeNull();
    } finally {
      resolve(overviewFixture());
      await dom.flush();
      await dom.cleanup();
    }
  });
});
