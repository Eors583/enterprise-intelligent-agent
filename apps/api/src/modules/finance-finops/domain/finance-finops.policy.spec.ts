import { describe, expect, it } from 'vitest';

import {
  assertAllocationCloses,
  assertReservationWithinLimit,
  calculateRoi,
} from './finance-finops.policy.js';

describe('FinOps deterministic policy', () => {
  it('never divides by zero or fabricates an ROI ratio', () => {
    expect(calculateRoi('0', '100')).toEqual({
      status: 'INVALID_ZERO_COST',
      netBenefit: '100',
      roiRatio: null,
    });
    expect(calculateRoi('25', '100')).toEqual({
      status: 'COMPUTED',
      netBenefit: '75',
      roiRatio: '3',
    });
  });

  it('requires an allocation to close both weight and amount', () => {
    expect(() =>
      assertAllocationCloses('10', [
        { weight: '0.4', allocatedAmount: '4' },
        { weight: '0.6', allocatedAmount: '6' },
      ]),
    ).not.toThrow();
    expect(() => assertAllocationCloses('10', [{ weight: '1', allocatedAmount: '9.99' }])).toThrow(
      'close the Cost Entry exactly',
    );
  });

  it('does not let a reservation silently cross an active hard limit', () => {
    expect(() => assertReservationWithinLimit('100', '20', '30', '50')).not.toThrow();
    expect(() => assertReservationWithinLimit('100', '20', '30', '50.01')).toThrow(
      'active hard limit',
    );
  });
});
