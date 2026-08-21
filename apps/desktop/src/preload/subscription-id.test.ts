import { describe, expect, it } from 'vitest';
import { createSubscriptionId } from './subscription-id';

describe('createSubscriptionId', () => {
  it('uses the sandbox-safe Web Crypto source', () => {
    const expected = '00000000-0000-4000-8000-000000000001';

    expect(createSubscriptionId({ randomUUID: () => expected })).toBe(expected);
  });

  it('fails clearly when secure UUID generation is unavailable', () => {
    expect(() => createSubscriptionId(null)).toThrow(
      'Secure UUID generation is unavailable in the Electron preload.',
    );
  });
});
