import { describe, expect, it } from 'vitest';

import type { AgentRunUsage } from './agent-run.models.js';
import { decideAgentRunTokenSettlement } from './agent-run-token-settlement.js';

const settledAt = new Date('2026-07-29T04:00:00.000Z');

describe('Agent Run token settlement', () => {
  it('records positive provider-attested usage and releases the reservation', () => {
    expect(
      decideAgentRunTokenSettlement({
        status: 'SUCCEEDED',
        reservedTokens: 20_000,
        usage: usage({ inputTokens: 120, outputTokens: 30, totalTokens: 150 }),
        settledAt,
      }),
    ).toEqual({
      kind: 'PROVIDER_REPORTED',
      tokenEvidence: 'PROVIDER_REPORTED',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      usageRecordedAt: settledAt,
      reservedTokens: 0,
      quotaChargedTokens: 0,
      quotaSettledAt: null,
    });
  });

  it('converts an unreported terminal reservation to a separate quota upper bound', () => {
    expect(
      decideAgentRunTokenSettlement({
        status: 'FAILED',
        reservedTokens: 20_000,
        usage: usage({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          tokensReported: false,
        }),
        settledAt,
      }),
    ).toEqual({
      kind: 'QUOTA_UPPER_BOUND',
      tokenEvidence: 'QUOTA_UPPER_BOUND',
      quotaChargedTokens: 20_000,
      quotaSettledAt: settledAt,
      reservedTokens: 0,
    });
  });

  it('never releases or converts an UNKNOWN reservation', () => {
    expect(
      decideAgentRunTokenSettlement({
        status: 'UNKNOWN',
        reservedTokens: 20_000,
        usage: usage({ inputTokens: 5, outputTokens: 3, totalTokens: 8 }),
        settledAt,
      }),
    ).toEqual({ kind: 'UNKNOWN_HOLD' });
  });

  it('does not represent all-zero usage as provider reported', () => {
    expect(() =>
      decideAgentRunTokenSettlement({
        status: 'SUCCEEDED',
        reservedTokens: 20_000,
        usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        settledAt,
      }),
    ).toThrow('Reported Agent Run token usage is not trustworthy.');
  });

  it('leaves a pre-reservation terminal failure explicitly unreported', () => {
    expect(
      decideAgentRunTokenSettlement({
        status: 'FAILED',
        reservedTokens: 0,
        usage: undefined,
        settledAt,
      }),
    ).toEqual({ kind: 'UNREPORTED' });
  });
});

function usage(overrides: Partial<AgentRunUsage>): AgentRunUsage {
  return {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    toolCalls: 0,
    costMicros: 0,
    tokensReported: true,
    costReported: false,
    provider: 'test-provider',
    model: 'test-model',
    ...overrides,
  };
}
