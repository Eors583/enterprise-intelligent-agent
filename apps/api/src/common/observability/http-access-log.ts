import type { Request, Response } from 'express';

export interface StructuredHttpAccessLog {
  readonly event: 'http_request_completed';
  readonly occurredAtUtc: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly traceId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface StructuredHttpFailureLog {
  readonly event: 'http_request_failed';
  readonly occurredAtUtc: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly traceId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly errorType: string;
}

export function buildHttpAccessLog(input: {
  readonly request: Request;
  readonly response: Response;
  readonly statusCode?: number;
  readonly durationMs: number;
  readonly now?: Date;
}): StructuredHttpAccessLog {
  return {
    event: 'http_request_completed',
    occurredAtUtc: (input.now ?? new Date()).toISOString(),
    requestId: input.request.requestId,
    correlationId: input.request.correlationId,
    traceId: input.request.traceId,
    method: input.request.method,
    // Express `path` excludes the query string. This keeps tokens and other
    // query parameters out of the operational log by construction.
    path: input.request.path,
    statusCode: input.statusCode ?? input.response.statusCode,
    durationMs: Math.max(0, Math.round(input.durationMs * 10) / 10),
  };
}

export function buildHttpFailureLog(input: {
  readonly request: Request;
  readonly statusCode: number;
  readonly error: unknown;
  readonly now?: Date;
}): StructuredHttpFailureLog {
  return {
    event: 'http_request_failed',
    occurredAtUtc: (input.now ?? new Date()).toISOString(),
    requestId: input.request.requestId,
    correlationId: input.request.correlationId,
    traceId: input.request.traceId,
    method: input.request.method,
    path: input.request.path,
    statusCode: input.statusCode,
    errorType: safeErrorType(input.error),
  };
}

function safeErrorType(error: unknown): string {
  const candidate = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(candidate) ? candidate : 'UnknownError';
}
