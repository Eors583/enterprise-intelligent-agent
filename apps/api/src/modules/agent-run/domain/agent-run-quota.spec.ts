import { describe, expect, it } from 'vitest';

import { decideAgentRunQuota, type AgentRunQuotaSnapshot } from './agent-run-quota.js';

const NOW = new Date('2026-07-21T10:00:00.000Z');

describe('decideAgentRunQuota', () => {
  it('reserves against both settled monthly usage and unresolved active work', () => {
    expect(
      decideAgentRunQuota(
        snapshot({
          monthlyTokenLimit: 100_000n,
          monthlyTokensUsed: 70_000n,
          tokensReserved: 15_000n,
        }),
        20_000,
        NOW,
      ),
    ).toEqual({
      kind: 'rejected',
      reasonCode: 'TENANT_MONTHLY_TOKEN_QUOTA_EXCEEDED',
    });
  });

  it('defers at the tenant concurrency boundary', () => {
    expect(decideAgentRunQuota(snapshot({ activeRuns: 4 }), 20_000, NOW)).toEqual({
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT',
      availableAt: new Date('2026-07-21T10:00:02.000Z'),
    });
  });

  it('defers rate-limited work until the rolling minute expires', () => {
    expect(
      decideAgentRunQuota(
        snapshot({
          runsLastMinute: 60,
          oldestDispatchInWindow: new Date('2026-07-21T09:59:20.000Z'),
        }),
        20_000,
        NOW,
      ),
    ).toEqual({
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_RATE_LIMIT',
      availableAt: new Date('2026-07-21T10:00:20.050Z'),
    });
  });

  it('allows work below every limit', () => {
    expect(decideAgentRunQuota(snapshot(), 20_000, NOW)).toEqual({ kind: 'allowed' });
  });
});

function snapshot(overrides: Partial<AgentRunQuotaSnapshot> = {}): AgentRunQuotaSnapshot {
  return {
    concurrencyLimit: 4,
    rateLimitPerMinute: 60,
    monthlyTokenLimit: 100_000_000n,
    activeRuns: 0,
    runsLastMinute: 0,
    oldestDispatchInWindow: null,
    monthlyTokensUsed: 0n,
    tokensReserved: 0n,
    ...overrides,
  };
}
