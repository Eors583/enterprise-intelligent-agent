import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { assertMarketingReplay, marketingRequestIdentity } from './marketing-persistence.js';

describe('marketing mutation identity', () => {
  it('hashes request content independently from the replay key', () => {
    const first = marketingRequestIdentity({
      idempotencyKey: 'first-key',
      value: 'same',
    });
    const second = marketingRequestIdentity({
      idempotencyKey: 'second-key',
      value: 'same',
    });
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.key).not.toBe(second.key);
  });

  it('rejects an idempotency key replay with a different request hash', () => {
    expect(() => assertMarketingReplay({ requestHash: 'a'.repeat(64) }, 'b'.repeat(64))).toThrow(
      ConflictException,
    );
  });
});
