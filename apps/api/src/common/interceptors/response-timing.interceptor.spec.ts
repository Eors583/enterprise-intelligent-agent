import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { firstValueFrom, of } from 'rxjs';

import { AuthController } from '../../modules/auth/auth.controller.js';
import { ResponseTimingInterceptor } from './response-timing.interceptor.js';

describe('ResponseTimingInterceptor', () => {
  const sensitiveHandlers = [
    'registerTenant',
    'requestPasswordReset',
    'completePasswordReset',
    'acceptMemberInvitation',
    'login',
    'refresh',
  ] as const;

  it.each(sensitiveHandlers)('suppresses Server-Timing for AuthController.%s', async (name) => {
    const response = responseDouble();
    const interceptor = new ResponseTimingInterceptor(new Reflector());

    await firstValueFrom(
      interceptor.intercept(
        executionContext(AuthController.prototype[name], AuthController, response.value),
        nextHandler(),
      ),
    );

    expect(response.removeHeader).toHaveBeenCalledWith('server-timing');
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('keeps Server-Timing for non-sensitive API handlers', async () => {
    const response = responseDouble();
    const interceptor = new ResponseTimingInterceptor(new Reflector());

    await firstValueFrom(
      interceptor.intercept(
        executionContext(() => undefined, class RegularController {}, response.value),
        nextHandler(),
      ),
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'server-timing',
      expect.stringMatching(/^app;dur=\d+\.\d$/),
    );
  });
});

function nextHandler(): CallHandler {
  return { handle: () => of({ ok: true }) };
}

function executionContext(
  handler: (...arguments_: never[]) => unknown,
  controller: object,
  response: Response,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function responseDouble(): {
  readonly value: Response;
  readonly setHeader: ReturnType<typeof vi.fn>;
  readonly removeHeader: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const removeHeader = vi.fn();
  return {
    value: { setHeader, removeHeader } as unknown as Response,
    setHeader,
    removeHeader,
  };
}
