import { describe, expect, it } from 'vitest';

import {
  createMarketingObservationRequestSchema,
  createMarketingTargetRequestSchema,
  transitionMarketingActionItemRequestSchema,
} from '../src/marketing-management.js';

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
const timestamp = '2026-07-28T08:00:00.000+00:00';

describe('marketing management contracts', () => {
  it('requires a traceable Agent Run for AI-created observation candidates', () => {
    const result = createMarketingObservationRequestSchema.safeParse({
      code: 'OBS-CUSTOMER-001',
      dimension: 'CUSTOMER',
      assertionType: 'FACT',
      statement: 'Customers require same-day response.',
      confidence: 0.9,
      origin: 'AI',
      agentRunId: null,
      evidence: [
        {
          evidenceId: id(1),
          evidenceVersion: 1,
          linkType: 'SUPPORTS',
          expectedContentHash: 'a'.repeat(64),
        },
      ],
      idempotencyKey: 'observation-request-1',
    });
    expect(result.success).toBe(false);
  });

  it('binds a target to exactly one matching Region or Customer Segment axis', () => {
    const base = {
      code: 'TARGET-001',
      productId: id(1),
      axis: 'REGION',
      regionId: id(2),
      customerSegmentId: id(3),
      strategyId: id(4),
      strategyVersion: 1,
      objectiveId: id(5),
      objectiveVersion: 1,
      valueDefinitionId: id(6),
      valueVersionId: id(7),
      valueVersionNumber: 1,
      responsibleRoleAssignmentId: id(8),
      metricDefinitionId: id(9),
      metricDefinitionVersion: 1,
      baselineValue: 10,
      targetValue: 20,
      unit: 'COUNT',
      periodStart: timestamp,
      periodEnd: '2026-08-28T08:00:00.000+00:00',
      budgetAmount: 1000,
      budgetCurrency: 'CNY',
      idempotencyKey: 'marketing-target-request-1',
    };
    expect(createMarketingTargetRequestSchema.safeParse(base).success).toBe(false);
    expect(
      createMarketingTargetRequestSchema.safeParse({
        ...base,
        customerSegmentId: null,
      }).success,
    ).toBe(true);
  });

  it('requires acceptance Evidence when an Action Item is completed', () => {
    expect(
      transitionMarketingActionItemRequestSchema.safeParse({
        action: 'COMPLETE',
        expectedRevision: 2,
        comment: 'Accepted by the accountable role.',
        acceptanceEvidenceId: null,
        acceptanceEvidenceVersion: null,
      }).success,
    ).toBe(false);
    expect(
      transitionMarketingActionItemRequestSchema.safeParse({
        action: 'COMPLETE',
        expectedRevision: 2,
        comment: 'Accepted by the accountable role.',
        acceptanceEvidenceId: id(10),
        acceptanceEvidenceVersion: 1,
      }).success,
    ).toBe(true);
  });
});
