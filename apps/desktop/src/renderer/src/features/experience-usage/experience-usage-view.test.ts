import { describe, expect, it } from 'vitest';

import { formatCostMicros, usageTrustSummary } from './experience-usage-view';
import type { EmployeeAiUsageSummary } from '@enterprise/contracts';

describe('employee experience usage view', () => {
  it('formats micros without using floating point', () => {
    expect(formatCostMicros('1234567')).toBe('1.234567');
    expect(formatCostMicros('2000000')).toBe('2');
  });

  it('makes unknown and unreported usage explicit', () => {
    expect(usageTrustSummary(usageFixture())).toBe(
      '可信 Token 1 次，未上报 1 次；可信费用 1 次，未上报 1 次；结果未知 1 次。',
    );
  });
});

function usageFixture(): EmployeeAiUsageSummary {
  return {
    period: {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-28T08:00:00.000Z',
      defaultedToCurrentMonth: true,
    },
    generatedAt: '2026-07-28T08:00:00.000Z',
    runs: {
      total: 2,
      succeeded: 1,
      failed: 0,
      unknown: 1,
      cancelled: 0,
      inProgress: 0,
      tokenReported: 1,
      tokenUnreported: 1,
      costReported: 1,
      costUnreported: 1,
    },
    trustedUsage: {
      inputTokens: '20',
      outputTokens: '5',
      totalTokens: '25',
      costMicros: '800',
    },
    latency: { sampleCount: 2, averageMs: 250, p50Ms: 200, p95Ms: 300 },
    byAgent: [],
    byTask: [],
  };
}
