import { describe, expect, it } from 'vitest';

import { adminAgentUsageSummarySchema } from '../src/admin-agent.js';

describe('admin Agent usage contracts', () => {
  it('uses decimal strings for counters that can exceed JSON safe integers', () => {
    const parsed = adminAgentUsageSummarySchema.parse({
      periodStart: '2026-07-01T00:00:00.000Z',
      generatedAt: '2026-07-21T10:00:00.000Z',
      limits: {
        concurrentRuns: 4,
        runsPerMinute: 60,
        monthlyTokens: '100000000',
        updatedAt: '2026-07-21T00:00:00.000Z',
      },
      current: {
        activeRuns: 1,
        runsLastMinute: 2,
        completedRuns: 3,
        failedRuns: 1,
        unknownRuns: 0,
        unverifiedUsageRuns: 1,
        quotaUpperBoundRuns: 1,
        unreportedCostRuns: 2,
        inputTokens: '1200',
        outputTokens: '300',
        totalTokens: '1500',
        quotaChargedTokens: '20000',
        reservedTokens: '20000',
        costMicros: '12345678901234567',
        averageLatencyMs: 840,
      },
      byProviderModel: [
        {
          provider: 'openai_compatible',
          model: 'model-a',
          runCount: 3,
          totalTokens: '1500',
          costMicros: '12345678901234567',
          averageLatencyMs: 840,
        },
      ],
    });

    expect(parsed.current.costMicros).toBe('12345678901234567');
    expect(parsed.byProviderModel[0]?.model).toBe('model-a');
  });

  it('rejects numeric representations of unbounded counters', () => {
    const result = adminAgentUsageSummarySchema.safeParse({
      periodStart: '2026-07-01T00:00:00.000Z',
      generatedAt: '2026-07-21T10:00:00.000Z',
      limits: { concurrentRuns: 4, runsPerMinute: 60, monthlyTokens: 100000000 },
      current: {},
      byProviderModel: [],
    });

    expect(result.success).toBe(false);
  });
});
