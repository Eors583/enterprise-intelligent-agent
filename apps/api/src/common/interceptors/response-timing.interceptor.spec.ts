import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { firstValueFrom, of, throwError } from 'rxjs';

import { AuthController } from '../../modules/auth/auth.controller.js';
import { ResponseTimingInterceptor } from './response-timing.interceptor.js';

describe('ResponseTimingInterceptor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('records the classified error status before the global exception filter runs', async () => {
    const response = responseDouble();
    const interceptor = new ResponseTimingInterceptor(new Reflector());

    await expect(
      firstValueFrom(
        interceptor.intercept(
          executionContext(() => undefined, class RegularController {}, response.value),
          { handle: () => throwError(() => new Error('sensitive upstream detail')) },
        ),
      ),
    ).rejects.toThrow('sensitive upstream detail');

    const logged = vi.mocked(Logger.prototype.log).mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(logged))).toMatchObject({
      event: 'http_request_completed',
      statusCode: 500,
      path: '/test',
    });
    expect(String(logged)).not.toContain('sensitive upstream detail');
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
  const request = {
    requestId: 'request-1',
    correlationId: 'correlation-1',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    method: 'GET',
    path: '/test',
  } as Request;
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
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
    value: { setHeader, removeHeader, statusCode: 200 } as unknown as Response,
    setHeader,
    removeHeader,
  };
}
