import { describe, expect, it } from 'vitest';

import { parseRecoveryRoute } from './RecoveryScreen';

describe('parseRecoveryRoute', () => {
  it('parses fragment-only recovery routes', () => {
    expect(parseRecoveryRoute('#/forgot-password')).toEqual({ kind: 'forgot-password' });
    expect(parseRecoveryRoute('#/reset-password?token=ea_reset_secret')).toEqual({
      kind: 'reset-password',
      token: 'ea_reset_secret',
    });
    expect(parseRecoveryRoute('#/accept-invitation?token=ea_invite_secret')).toEqual({
      kind: 'accept-invitation',
      token: 'ea_invite_secret',
    });
  });

  it('does not treat ordinary admin navigation as recovery', () => {
    expect(parseRecoveryRoute('#agents')).toBeNull();
    expect(parseRecoveryRoute('#/reset-password')).toBeNull();
  });
});
