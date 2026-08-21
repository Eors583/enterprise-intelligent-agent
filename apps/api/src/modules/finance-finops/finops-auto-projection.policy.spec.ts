import { describe, expect, it } from 'vitest';

import {
  decideFinopsAutoProjection,
  type AgentRunProjectionSource,
  type FinopsProjectionPrice,
  type ToolReceiptProjectionSource,
} from './finops-auto-projection.policy.js';

const inputPrice = price('INPUT_TOKEN', '5');
const outputPrice = price('OUTPUT_TOKEN', '10', 2);

describe('trusted automatic FinOps projection policy', () => {
  it('projects a confirmed Agent Run only when approved prices exactly close cost', () => {
    const decision = decideFinopsAutoProjection(agentRun(), [inputPrice, outputPrice]);

    expect(decision.kind).toBe('PROJECT');
    if (decision.kind !== 'PROJECT') return;
    expect(decision.expectedCostMicros).toBe(2_000n);
    expect(
      decision.lines.map(({ billingUnit, quantity }) => [billingUnit, quantity.toFixed()]),
    ).toEqual([
      ['INPUT_TOKEN', '200'],
      ['OUTPUT_TOKEN', '100'],
    ]);
    expect(decision.dimensions).toMatchObject({
      taskId: '00000000-0000-7000-8000-000000000051',
      requesterUserId: '00000000-0000-7000-8000-000000000011',
    });
  });

  it('never represents 0/0/0, quota-only evidence, or UNKNOWN as trusted zero', () => {
    expect(
      decideFinopsAutoProjection(
        agentRun({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0n }),
        [inputPrice, outputPrice],
      ),
    ).toMatchObject({ kind: 'BLOCKED', code: 'EMPTY_USAGE' });
    expect(
      decideFinopsAutoProjection(
        agentRun({
          tokenEvidence: 'QUOTA_UPPER_BOUND',
          usageRecordedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }),
        [inputPrice, outputPrice],
      ),
    ).toMatchObject({ kind: 'BLOCKED', code: 'USAGE_UNREPORTED' });
    expect(
      decideFinopsAutoProjection(agentRun({ status: 'UNKNOWN' }), [inputPrice, outputPrice]),
    ).toMatchObject({ kind: 'BLOCKED', code: 'SOURCE_UNKNOWN' });
  });

  it('prices provider-reported tokens from the approved catalog when cost is unreported', () => {
    expect(
      decideFinopsAutoProjection(agentRun({ costRecordedAt: null, costMicros: 0n }), [
        inputPrice,
        outputPrice,
      ]),
    ).toMatchObject({
      kind: 'PROJECT',
      expectedCostMicros: 2_000n,
      sourceAuthority: 'TRUSTED_SYSTEM',
      dimensions: {
        tokenEvidence: 'PROVIDER_REPORTED',
        costBasis: 'APPROVED_PRICE_SNAPSHOT',
      },
    });
  });

  it('blocks missing, overlapping, or inconsistent prices instead of choosing or using zero', () => {
    expect(decideFinopsAutoProjection(agentRun(), [])).toMatchObject({
      kind: 'BLOCKED',
      code: 'PRICE_MISSING',
    });
    expect(
      decideFinopsAutoProjection(agentRun(), [
        inputPrice,
        { ...inputPrice, id: '00000000-0000-7000-8000-000000000099', version: 9 },
        outputPrice,
      ]),
    ).toMatchObject({ kind: 'BLOCKED', code: 'PRICE_AMBIGUOUS' });
    expect(
      decideFinopsAutoProjection(agentRun({ costMicros: 999n }), [inputPrice, outputPrice]),
    ).toMatchObject({ kind: 'BLOCKED', code: 'SETTLEMENT_MISMATCH' });
  });

  it('projects a non-UNKNOWN immutable Tool receipt and preserves task/role dimensions', () => {
    const decision = decideFinopsAutoProjection(toolReceipt(), [
      price('CALL', '0.000025', 3, 'HTTP', 'crm.customer.read', 'TOOL'),
    ]);

    expect(decision.kind).toBe('PROJECT');
    if (decision.kind !== 'PROJECT') return;
    expect(decision.expectedCostMicros).toBe(25n);
    expect(decision.sourceAuthority).toBe('RUNTIME_ATTESTED');
    expect(decision.dimensions).toMatchObject({
      roleAssignmentId: '00000000-0000-7000-8000-000000000072',
      taskId: '00000000-0000-7000-8000-000000000073',
      providerDryRun: false,
    });
  });

  it('prices an unattested successful Tool receipt from the approved catalog without a false mismatch', () => {
    const decision = decideFinopsAutoProjection(
      toolReceipt({ costAttestation: 'UNATTESTED', costMicros: null }),
      [price('CALL', '0.000025', 3, 'HTTP', 'crm.customer.read', 'TOOL')],
    );

    expect(decision).toMatchObject({
      kind: 'PROJECT',
      expectedCostMicros: 25n,
      sourceAuthority: 'TRUSTED_SYSTEM',
      dimensions: { costBasis: 'APPROVED_PRICE_SNAPSHOT' },
    });
  });

  it('keeps an attested zero distinct and rejects it against a non-zero approved price', () => {
    expect(
      decideFinopsAutoProjection(
        toolReceipt({ costAttestation: 'PROVIDER_ATTESTED', costMicros: 0n }),
        [price('CALL', '0.000025', 3, 'HTTP', 'crm.customer.read', 'TOOL')],
      ),
    ).toMatchObject({ kind: 'BLOCKED', code: 'SETTLEMENT_MISMATCH' });
  });

  it('keeps UNKNOWN Tool delivery outside the ledger even with a price', () => {
    expect(
      decideFinopsAutoProjection(toolReceipt({ outcome: 'UNKNOWN' }), [
        price('CALL', '0.000025', 3, 'HTTP', 'crm.customer.read', 'TOOL'),
      ]),
    ).toMatchObject({ kind: 'BLOCKED', code: 'SOURCE_UNKNOWN' });
  });

  it('does not admit a zero-duration SECOND settlement as a trusted zero-cost entry', () => {
    expect(
      decideFinopsAutoProjection(
        toolReceipt({
          startedAt: new Date('2026-07-28T08:00:00.000Z'),
          completedAt: new Date('2026-07-28T08:00:00.000Z'),
          latencyMs: 0,
          costMicros: 0n,
        }),
        [price('SECOND', '0.10', 4, 'HTTP', 'crm.customer.read', 'TOOL')],
      ),
    ).toMatchObject({ kind: 'BLOCKED', code: 'EMPTY_USAGE' });
  });
});

function agentRun(overrides: Partial<AgentRunProjectionSource> = {}): AgentRunProjectionSource {
  return {
    kind: 'AGENT_RUN',
    id: '00000000-0000-7000-8000-000000000010',
    version: 4,
    status: 'SUCCEEDED',
    requesterUserId: '00000000-0000-7000-8000-000000000011',
    taskId: '00000000-0000-7000-8000-000000000051',
    agentId: '00000000-0000-7000-8000-000000000012',
    agentVersionId: '00000000-0000-7000-8000-000000000013',
    runtimeProvider: 'openai',
    runtimeModel: 'gpt-enterprise',
    tokenEvidence: 'PROVIDER_REPORTED',
    inputTokens: 200,
    outputTokens: 100,
    totalTokens: 300,
    toolCalls: 1,
    costMicros: 2_000n,
    latencyMs: 750,
    usageRecordedAt: new Date('2026-07-28T08:00:00.000Z'),
    costRecordedAt: new Date('2026-07-28T08:00:00.000Z'),
    finishedAt: new Date('2026-07-28T08:00:00.000Z'),
    ...overrides,
  };
}

function toolReceipt(
  overrides: Partial<ToolReceiptProjectionSource> = {},
): ToolReceiptProjectionSource {
  return {
    kind: 'TOOL_RECEIPT',
    id: '00000000-0000-7000-8000-000000000070',
    receiptHash: 'a'.repeat(64),
    invocationId: '00000000-0000-7000-8000-000000000071',
    invocationStatus: 'SUCCEEDED',
    requesterUserId: '00000000-0000-7000-8000-000000000011',
    roleAssignmentId: '00000000-0000-7000-8000-000000000072',
    taskId: '00000000-0000-7000-8000-000000000073',
    processInstanceId: null,
    processStepInstanceId: null,
    agentRunId: null,
    toolVersionId: '00000000-0000-7000-8000-000000000074',
    toolVersion: 2,
    toolKey: 'crm.customer.read',
    adapter: 'HTTP',
    source: 'PROVIDER',
    outcome: 'SUCCEEDED',
    providerRequestId: 'provider-request-1',
    providerDryRun: false,
    executionAttempt: 1,
    startedAt: new Date('2026-07-28T08:00:00.000Z'),
    completedAt: new Date('2026-07-28T08:00:01.000Z'),
    latencyMs: 1_000,
    costAttestation: 'PROVIDER_ATTESTED',
    costMicros: 25n,
    ...overrides,
  };
}

function price(
  billingUnit: FinopsProjectionPrice['billingUnit'],
  unitPrice: string,
  version = 1,
  provider = 'openai',
  sku = 'gpt-enterprise',
  resourceKind: FinopsProjectionPrice['resourceKind'] = 'MODEL',
): FinopsProjectionPrice {
  return {
    id: `00000000-0000-7000-8000-${String(version).padStart(12, '0')}`,
    version,
    resourceKind,
    provider,
    sku,
    currency: 'CNY',
    billingUnit,
    unitSize:
      billingUnit === 'INPUT_TOKEN' || billingUnit === 'OUTPUT_TOKEN' || billingUnit === 'TOKEN'
        ? '1000000'
        : '1',
    unitPrice,
    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    effectiveTo: null,
    approvedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}
