import type { AgentRunUsage } from './agent-run.models.js';

export type AgentRunTokenEvidence = 'UNREPORTED' | 'PROVIDER_REPORTED' | 'QUOTA_UPPER_BOUND';

export type AgentRunTokenSettlement =
  | { readonly kind: 'UNKNOWN_HOLD' }
  | { readonly kind: 'UNREPORTED' }
  | {
      readonly kind: 'PROVIDER_REPORTED';
      readonly tokenEvidence: 'PROVIDER_REPORTED';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly usageRecordedAt: Date;
      readonly reservedTokens: 0;
      readonly quotaChargedTokens: 0;
      readonly quotaSettledAt: null;
    }
  | {
      readonly kind: 'QUOTA_UPPER_BOUND';
      readonly tokenEvidence: 'QUOTA_UPPER_BOUND';
      readonly quotaChargedTokens: number;
      readonly quotaSettledAt: Date;
      readonly reservedTokens: 0;
    };

/**
 * Separates provider-attested usage from quota-only conservative settlement.
 * UNKNOWN is intentionally not terminal for accounting: the remote execution
 * may still consume resources, so its reservation must remain untouched.
 */
export function decideAgentRunTokenSettlement(input: {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
  readonly reservedTokens: number;
  readonly usage: AgentRunUsage | undefined;
  readonly settledAt: Date;
}): AgentRunTokenSettlement {
  assertNonNegativeSafeInteger(input.reservedTokens, 'Agent Run token reservation');
  if (input.status === 'UNKNOWN') return { kind: 'UNKNOWN_HOLD' };

  if (input.usage?.tokensReported === true) {
    assertReportedUsage(input.usage);
    return {
      kind: 'PROVIDER_REPORTED',
      tokenEvidence: 'PROVIDER_REPORTED',
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      totalTokens: input.usage.totalTokens,
      usageRecordedAt: input.settledAt,
      reservedTokens: 0,
      quotaChargedTokens: 0,
      quotaSettledAt: null,
    };
  }

  if (input.reservedTokens > 0) {
    return {
      kind: 'QUOTA_UPPER_BOUND',
      tokenEvidence: 'QUOTA_UPPER_BOUND',
      quotaChargedTokens: input.reservedTokens,
      quotaSettledAt: input.settledAt,
      reservedTokens: 0,
    };
  }
  return { kind: 'UNREPORTED' };
}

function assertReportedUsage(usage: AgentRunUsage): void {
  assertNonNegativeSafeInteger(usage.inputTokens, 'Agent Run input token usage');
  assertNonNegativeSafeInteger(usage.outputTokens, 'Agent Run output token usage');
  assertNonNegativeSafeInteger(usage.totalTokens, 'Agent Run total token usage');
  if (usage.totalTokens <= 0 || usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw new Error('Reported Agent Run token usage is not trustworthy.');
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}
