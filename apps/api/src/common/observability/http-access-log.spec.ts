import type { Request, Response } from 'express';

import { buildHttpAccessLog, buildHttpFailureLog } from './http-access-log.js';

describe('buildHttpAccessLog', () => {
  it('emits correlation fields without query values or request content', () => {
    const result = buildHttpAccessLog({
      request: {
        requestId: 'request-1',
        correlationId: 'task-1',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        method: 'GET',
        path: '/api/v1/workbench/tasks',
        originalUrl: '/api/v1/workbench/tasks?token=must-not-log',
      } as Request,
      response: { statusCode: 200 } as Response,
      durationMs: 12.36,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });

    expect(result).toEqual({
      event: 'http_request_completed',
      occurredAtUtc: '2026-07-28T00:00:00.000Z',
      requestId: 'request-1',
      correlationId: 'task-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      method: 'GET',
      path: '/api/v1/workbench/tasks',
      statusCode: 200,
      durationMs: 12.4,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-log');
  });

  it('classifies failures without persisting exception messages or stacks', () => {
    const request = {
      requestId: 'request-1',
      correlationId: 'task-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      method: 'POST',
      path: '/api/v1/tool-invocations',
    } as Request;
    const result = buildHttpFailureLog({
      request,
      statusCode: 500,
      error: new Error('secret=must-not-log'),
      now: new Date('2026-07-28T00:00:00.000Z'),
    });

    expect(result.errorType).toBe('Error');
    expect(JSON.stringify(result)).not.toContain('must-not-log');
  });
});
