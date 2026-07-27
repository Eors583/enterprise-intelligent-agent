import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthRecoveryNotificationService } from './auth-recovery-notification.service.js';

describe('AuthRecoveryNotificationService', () => {
  const config = {
    get: (key: string) =>
      ({
        AUTH_RECOVERY_EMAIL_PROVIDER: 'disabled',
        AUTH_PUBLIC_APP_URL: 'https://admin.example.test',
        AUTH_RECOVERY_EMAIL_HTTP_TIMEOUT_MS: 1000,
      })[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;

  it('places capabilities in a fragment, never in the HTTP query', () => {
    const service = new AuthRecoveryNotificationService(config);
    const token = `ea_reset_${'x'.repeat(43)}`;
    const url = new URL(service.actionUrl('reset-password', token));

    expect(url.search).toBe('');
    expect(url.pathname).toBe('/');
    expect(url.hash).toBe(`#/reset-password?token=${token}`);
  });

  it('reports NOT_CONFIGURED without attempting external delivery', async () => {
    const service = new AuthRecoveryNotificationService(config);
    await expect(
      service.sendPasswordReset({
        email: 'user@example.test',
        displayName: 'User',
        tenantName: 'Tenant',
        token: `ea_reset_${'x'.repeat(43)}`,
      }),
    ).resolves.toBe('NOT_CONFIGURED');
  });
});
