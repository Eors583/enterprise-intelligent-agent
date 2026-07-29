import { describe, expect, it } from 'vitest';

import { calculateDirectorySyncRetryDelay } from './feishu-directory-sync.worker.js';

describe('FeishuDirectorySyncWorker retry policy', () => {
  it('uses bounded exponential backoff with jitter', () => {
    expect(calculateDirectorySyncRetryDelay(1, 1_000, 60_000, () => 0)).toBe(800);
    expect(calculateDirectorySyncRetryDelay(2, 1_000, 60_000, () => 0.5)).toBe(2_000);
    expect(calculateDirectorySyncRetryDelay(20, 1_000, 60_000, () => 1)).toBe(60_000);
  });

  it('normalizes non-finite jitter input', () => {
    expect(calculateDirectorySyncRetryDelay(1, 1_000, 60_000, () => Number.NaN)).toBe(1_000);
  });
});
