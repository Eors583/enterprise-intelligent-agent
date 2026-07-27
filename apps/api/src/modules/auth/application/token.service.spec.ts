import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { TokenService } from './token.service.js';

describe('TokenService', () => {
  const config = {
    get: (key: keyof EnvironmentVariables) =>
      key === 'AUTH_TOKEN_PEPPER' ? 'unit-test-pepper' : undefined,
  } as unknown as ConfigService<EnvironmentVariables, true>;

  it('issues opaque tokens and stores only deterministic HMAC values', () => {
    const service = new TokenService(config);
    const first = service.issuePair();
    const second = service.issuePair();

    expect(first.access.value).toMatch(/^ea_access_[A-Za-z0-9_-]{43}$/);
    expect(first.refresh.value).toMatch(/^ea_refresh_[A-Za-z0-9_-]{43}$/);
    expect(first.access.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.access.hash).toBe(service.hash(first.access.value));
    expect(second.access.value).not.toBe(first.access.value);
    expect(first.access.hash).not.toContain(first.access.value);
  });

  it('rejects malformed opaque tokens before a database lookup', () => {
    const service = new TokenService(config);
    expect(service.isWellFormed('not-a-token')).toBe(false);
    expect(service.isWellFormed(service.issuePair().refresh.value)).toBe(true);
  });

  it('issues purpose-bound one-time action tokens', () => {
    const service = new TokenService(config);
    const reset = service.issueAction('reset');
    const invite = service.issueAction('invite');

    expect(reset.value).toMatch(/^ea_reset_[A-Za-z0-9_-]{43}$/);
    expect(invite.value).toMatch(/^ea_invite_[A-Za-z0-9_-]{43}$/);
    expect(service.isActionWellFormed(reset.value, 'reset')).toBe(true);
    expect(service.isActionWellFormed(reset.value, 'invite')).toBe(false);
    expect(reset.hash).toBe(service.hash(reset.value));
    expect(reset.hash).not.toContain(reset.value);
  });
});
