export interface RoiResult {
  readonly status: 'COMPUTED' | 'INVALID_ZERO_COST';
  readonly netBenefit: string;
  readonly roiRatio: string | null;
}

export function calculateRoi(verifiedCost: string, confirmedBenefit: string): RoiResult {
  const cost = Number(verifiedCost);
  const benefit = Number(confirmedBenefit);
  if (!Number.isFinite(cost) || !Number.isFinite(benefit) || cost < 0 || benefit < 0) {
    throw new Error('ROI inputs must be finite, non-negative ledger totals.');
  }
  const netBenefit = benefit - cost;
  if (cost === 0) {
    return {
      status: 'INVALID_ZERO_COST',
      netBenefit: normalized(netBenefit),
      roiRatio: null,
    };
  }
  return {
    status: 'COMPUTED',
    netBenefit: normalized(netBenefit),
    roiRatio: normalized(netBenefit / cost),
  };
}

export function assertAllocationCloses(
  costAmount: string,
  lines: readonly { readonly weight: string; readonly allocatedAmount: string }[],
): void {
  const weight = lines.reduce((total, line) => total + Number(line.weight), 0);
  const amount = lines.reduce((total, line) => total + Number(line.allocatedAmount), 0);
  if (Math.abs(weight - 1) > 1e-12 || Math.abs(amount - Number(costAmount)) > 1e-12) {
    throw new Error('Allocation weights and amounts must close the Cost Entry exactly.');
  }
}

export function assertReservationWithinLimit(
  limit: string,
  settled: string,
  outstandingReservations: string,
  requested: string,
): void {
  if (Number(settled) + Number(outstandingReservations) + Number(requested) > Number(limit)) {
    throw new Error('Budget reservation would exceed the active hard limit.');
  }
}

function normalized(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(12).replace(/0+$/, '');
}
