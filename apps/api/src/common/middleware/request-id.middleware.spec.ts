import type { NextFunction, Request, Response } from 'express';

import { RequestIdMiddleware } from './request-id.middleware.js';

describe('RequestIdMiddleware', () => {
  it('propagates safe request, correlation, and W3C trace identifiers', () => {
    const headers: Record<string, string> = {
      'x-request-id': 'request-1',
      'x-correlation-id': 'task:42',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    };
    const request = {
      header: (name: string) => headers[name],
    } as Request;
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;
    const next = vi.fn() as NextFunction;

    new RequestIdMiddleware().use(request, response, next);

    expect(request).toMatchObject({
      requestId: 'request-1',
      correlationId: 'task:42',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'task:42');
    expect(setHeader).toHaveBeenCalledWith('traceparent', request.traceparent);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not reflect malformed caller-controlled identifiers', () => {
    const request = {
      header: (name: string) =>
        name === 'x-request-id'
          ? 'invalid request'
          : name === 'x-correlation-id'
            ? 'invalid correlation'
            : name === 'traceparent'
              ? 'invalid trace'
              : undefined,
    } as Request;
    const response = { setHeader: vi.fn() } as unknown as Response;

    new RequestIdMiddleware().use(request, response, vi.fn());

    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.correlationId).toBe(request.requestId);
    expect(request.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
