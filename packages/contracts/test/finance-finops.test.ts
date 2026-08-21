import { describe, expect, it } from 'vitest';

import {
  createFinopsAllocationSetRequestSchema,
  createFinopsBenefitClaimRequestSchema,
  createFinopsBudgetEventRequestSchema,
  createFinopsPriceSnapshotRequestSchema,
  finopsProjectionDiagnosticSchema,
  finopsRoiSnapshotSchema,
  recordFinopsCostRequestSchema,
  reviewFinopsCostRequestSchema,
} from '../src/finance-finops.js';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const NOW = '2026-07-28T08:00:00.000Z';
const LATER = '2026-07-29T08:00:00.000Z';
const source = {
  authority: 'PROVIDER_BILL' as const,
  system: 'provider-billing',
  recordId: 'invoice-line-42',
  recordVersion: '2026-07',
  contentHash: 'a'.repeat(64),
  evidenceId: id(90),
  evidenceVersion: 1,
};

describe('FIN-001 contracts', () => {
  it('accepts exact, versioned prices for every governed cost family', () => {
    for (const resourceKind of [
      'MODEL',
      'EMBEDDING',
      'RERANK',
      'TOOL',
      'API',
      'STORAGE',
      'HUMAN_REVIEW',
    ] as const) {
      expect(
        createFinopsPriceSnapshotRequestSchema.parse({
          code: `PRICE.${resourceKind}`,
          resourceKind,
          provider: 'provider',
          sku: 'sku',
          currency: 'cny',
          billingUnit: resourceKind === 'HUMAN_REVIEW' ? 'HOUR' : 'REQUEST',
          unitSize: '1',
          unitPrice: '0.123456',
          effectiveFrom: NOW,
          effectiveTo: null,
          source,
          idempotencyKey: `price-${resourceKind}-20260728`,
        }).currency,
      ).toBe('CNY');
    }
  });

  it('records administrative cost only as pending human-attested input with an exact reference', () => {
    const request = {
      subjectType: 'AGENT_RUN' as const,
      subjectId: id(1),
      agentRunId: id(1),
      priceSnapshotId: id(2),
      quantity: '2481',
      rawUsage: { inputTokens: 2000, outputTokens: 481 },
      formulaCode: 'LINEAR_UNIT_RATE',
      formulaVersion: 1,
      formulaExpression: '(quantity / unitSize) * unitPrice' as const,
      verificationStatus: 'PENDING' as const,
      source: { ...source, authority: 'HUMAN_ATTESTED' as const },
      incurredAt: NOW,
      idempotencyKey: 'cost-agent-run-00000001',
    };
    expect(recordFinopsCostRequestSchema.parse(request).rawUsage).toEqual(request.rawUsage);
    expect(() => recordFinopsCostRequestSchema.parse({ ...request, agentRunId: null })).toThrow();
    expect(() => recordFinopsCostRequestSchema.parse({ ...request, subjectId: id(99) })).toThrow();
    expect(() =>
      recordFinopsCostRequestSchema.parse({
        ...request,
        source,
      }),
    ).toThrow();
    expect(() =>
      recordFinopsCostRequestSchema.parse({
        ...request,
        formulaExpression: 'quantity * userSuppliedPrice',
      }),
    ).toThrow();
  });

  it('requires independent verification to cite trusted Evidence or an immutable trusted source', () => {
    expect(
      reviewFinopsCostRequestSchema.parse({
        decision: 'VERIFIED',
        basis: 'TRUSTED_EVIDENCE',
        evidenceId: id(90),
        evidenceVersion: 1,
        comment: 'The active verified Evidence matches the immutable source record.',
        idempotencyKey: 'cost-review-evidence-0001',
      }).basis,
    ).toBe('TRUSTED_EVIDENCE');
    expect(
      reviewFinopsCostRequestSchema.parse({
        decision: 'VERIFIED',
        basis: 'TRUSTED_SOURCE',
        evidenceId: null,
        evidenceVersion: null,
        comment: 'The controlled projector supplied an immutable trusted source.',
        idempotencyKey: 'cost-review-source-000001',
      }).basis,
    ).toBe('TRUSTED_SOURCE');
    expect(() =>
      reviewFinopsCostRequestSchema.parse({
        decision: 'VERIFIED',
        basis: 'REVIEWER_JUDGMENT',
        comment: 'A reviewer opinion alone must never create verified ledger truth.',
        idempotencyKey: 'cost-review-judgment-0001',
      }),
    ).toThrow();
  });

  it('requires AI allocation and value candidates to retain their producing run', () => {
    const allocation = {
      costEntryId: id(3),
      ruleId: id(4),
      origin: 'AI' as const,
      proposedByAgentRunId: id(5),
      lines: [
        {
          employeeUserId: id(6),
          roleAssignmentId: null,
          taskId: id(7),
          taskVersion: 2,
          processDefinitionId: null,
          processVersionId: null,
          processVersion: null,
          customerId: null,
          projectId: null,
          departmentOrgUnitId: id(8),
          weight: '1',
          allocatedAmount: '12.34',
          rationale: 'Directly attributable to the governed task.',
        },
      ],
      idempotencyKey: 'allocation-agent-run-0001',
    };
    expect(createFinopsAllocationSetRequestSchema.parse(allocation).origin).toBe('AI');
    expect(() =>
      createFinopsAllocationSetRequestSchema.parse({
        ...allocation,
        proposedByAgentRunId: null,
      }),
    ).toThrow();

    const benefit = {
      code: 'BENEFIT.RETENTION',
      origin: 'AI' as const,
      currency: 'CNY',
      amount: '15000',
      periodStart: NOW,
      periodEnd: LATER,
      deliverableId: id(10),
      deliverableVersion: 1,
      acceptanceId: id(11),
      acceptanceVersion: 1,
      evidenceId: id(12),
      evidenceVersion: 1,
      valueDefinitionId: id(13),
      valueVersionId: id(14),
      valueVersion: 2,
      objectiveId: id(15),
      objectiveVersion: 3,
      source,
      agentRunId: id(5),
      idempotencyKey: 'benefit-ai-candidate-0001',
    };
    expect(createFinopsBenefitClaimRequestSchema.parse(benefit).agentRunId).toBe(id(5));
    expect(() =>
      createFinopsBenefitClaimRequestSchema.parse({ ...benefit, agentRunId: null }),
    ).toThrow();
  });

  it('rejects invented ROI and a zero denominator', () => {
    const base = {
      id: id(20),
      tenantId: id(21),
      formulaId: id(22),
      formulaVersion: 1,
      currency: 'CNY',
      periodStart: NOW,
      periodEnd: LATER,
      verifiedCost: '0',
      confirmedBenefit: '999',
      netBenefit: '999',
      roiRatio: null,
      status: 'INVALID_ZERO_COST' as const,
      inputsHash: 'b'.repeat(64),
      recalculationOfId: null,
      calculatedByUserId: id(23),
      createdAt: LATER,
    };
    expect(finopsRoiSnapshotSchema.parse(base).status).toBe('INVALID_ZERO_COST');
    expect(() =>
      finopsRoiSnapshotSchema.parse({ ...base, roiRatio: '999', status: 'COMPUTED' }),
    ).toThrow();
  });

  it('ties settlement and release events back to immutable reservations', () => {
    expect(() =>
      createFinopsBudgetEventRequestSchema.parse({
        type: 'SETTLEMENT',
        amount: '10',
        reservationEventId: null,
        costEntryId: id(30),
        reason: 'Provider bill reconciled.',
        idempotencyKey: 'settlement-without-reservation',
      }),
    ).toThrow();
  });

  it('exposes unresolved automatic projection failures as governable diagnostics', () => {
    expect(
      finopsProjectionDiagnosticSchema.parse({
        id: id(40),
        tenantId: id(41),
        sourceKind: 'AGENT_RUN',
        sourceId: id(42),
        sourceVersion: '4',
        code: 'PRICE_MISSING',
        detail: 'No approved price matches the runtime settlement.',
        metadata: { provider: 'openai', sku: 'gpt-enterprise' },
        status: 'OPEN',
        openedAt: NOW,
        resolvedAt: null,
      }).status,
    ).toBe('OPEN');
  });
});
