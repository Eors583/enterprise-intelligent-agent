import type { Request } from 'express';

import type { AuthService } from './application/auth.service.js';
import type { AuthRecoveryService } from './application/auth-recovery.service.js';
import type { LoginAttemptLimiter } from './application/login-attempt-limiter.service.js';
import type { RecoveryResponseTimingService } from './application/recovery-response-timing.service.js';
import {
  RecoveryRateLimitExceededException,
  type RecoveryRequestLimiter,
} from './application/recovery-request-limiter.service.js';
import { AuthController } from './auth.controller.js';

describe('AuthController password reset timing budget', () => {
  it.each(['known@example.test', 'unknown@example.test'])(
    'waits for the response budget for %s',
    async (email) => {
      const wait = vi.fn().mockResolvedValue(undefined);
      const recovery = {
        requestPasswordReset: vi.fn().mockResolvedValue({
          accepted: true,
          message: 'If the account is eligible, a password reset message will be sent.',
        }),
      };
      const recoveryRequests = {
        createContext: vi.fn().mockReturnValue({}),
        beginRequest: vi.fn().mockResolvedValue(undefined),
      };
      const controller = createController(recovery, recoveryRequests, {
        start: vi.fn().mockReturnValue({ wait }),
      });

      await expect(
        controller.requestPasswordReset({ tenantSlug: 'tenant', email }, {
          ip: '127.0.0.1',
        } as Request),
      ).resolves.toMatchObject({ accepted: true });
      expect(wait).toHaveBeenCalledOnce();
    },
  );

  it('returns the same 202 body without identity lookup or delivery when rate limiting rejects', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const requestPasswordReset = vi.fn();
    const recoveryRequests = {
      createContext: vi.fn().mockReturnValue({}),
      beginRequest: vi.fn().mockRejectedValue(new RecoveryRateLimitExceededException()),
    };
    const controller = createController({ requestPasswordReset }, recoveryRequests, {
      start: vi.fn().mockReturnValue({ wait }),
    });

    await expect(
      controller.requestPasswordReset({ tenantSlug: 'tenant', email: 'member@example.test' }, {
        ip: '127.0.0.1',
      } as Request),
    ).resolves.toEqual({
      accepted: true,
      message: 'If the account is eligible, a password reset message will be sent.',
    });
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
  });

  it('does not hide unexpected pre-identity persistence failures', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const recoveryRequests = {
      createContext: vi.fn().mockReturnValue({}),
      beginRequest: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const controller = createController({ requestPasswordReset: vi.fn() }, recoveryRequests, {
      start: vi.fn().mockReturnValue({ wait }),
    });

    await expect(
      controller.requestPasswordReset({ tenantSlug: 'tenant', email: 'member@example.test' }, {
        socket: {},
      } as Request),
    ).rejects.toThrow('database unavailable');
    expect(wait).toHaveBeenCalledOnce();
  });
});

function createController(
  recovery: Pick<AuthRecoveryService, 'requestPasswordReset'>,
  recoveryRequests: Pick<RecoveryRequestLimiter, 'beginRequest' | 'createContext'>,
  responseTiming: Pick<RecoveryResponseTimingService, 'start'>,
): AuthController {
  return new AuthController(
    {} as AuthService,
    recovery as AuthRecoveryService,
    {} as LoginAttemptLimiter,
    recoveryRequests as RecoveryRequestLimiter,
    responseTiming as RecoveryResponseTimingService,
  );
}
