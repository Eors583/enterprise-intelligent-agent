import { describe, expect, it } from 'vitest';

import { FinopsAutoProjectionReconciler } from './finops-auto-projection.reconciler.js';
import { FinopsAutoProjectionWorker } from './finops-auto-projection.worker.js';

describe('FinopsAutoProjectionWorker', () => {
  it('runs one bounded reliable reconciliation batch', async () => {
    const reconciler = new FakeReconciler();
    const worker = new FinopsAutoProjectionWorker(
      config({
        FINOPS_PROJECTION_WORKER_ENABLED: true,
        FINOPS_PROJECTION_BATCH_SIZE: 7,
        FINOPS_PROJECTION_POLL_INTERVAL_MS: 1_000,
        FINOPS_PROJECTION_CLAIM_TTL_MS: 30_000,
      }),
      reconciler,
    );

    await expect(worker.runOnce()).resolves.toBe(3);
    expect(reconciler.inputs).toHaveLength(1);
    expect(reconciler.inputs[0]).toMatchObject({ batchSize: 7, claimTtlMs: 30_000 });
    expect(reconciler.inputs[0]?.workerId).toMatch(/^finops-projector:/);
  });

  it('does not touch sources when the projector is disabled', async () => {
    const reconciler = new FakeReconciler();
    const worker = new FinopsAutoProjectionWorker(
      config({
        FINOPS_PROJECTION_WORKER_ENABLED: false,
        FINOPS_PROJECTION_BATCH_SIZE: 7,
        FINOPS_PROJECTION_POLL_INTERVAL_MS: 1_000,
        FINOPS_PROJECTION_CLAIM_TTL_MS: 30_000,
      }),
      reconciler,
    );

    await expect(worker.runOnce()).resolves.toBe(0);
    expect(reconciler.inputs).toEqual([]);
  });
});

class FakeReconciler extends FinopsAutoProjectionReconciler {
  readonly inputs: Array<{
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }> = [];

  reconcileBatch(input: {
    readonly workerId: string;
    readonly batchSize: number;
    readonly claimTtlMs: number;
  }): Promise<number> {
    this.inputs.push(input);
    return Promise.resolve(3);
  }
}

function config(values: Record<string, unknown>) {
  return {
    get(key: string) {
      return values[key];
    },
  } as never;
}
