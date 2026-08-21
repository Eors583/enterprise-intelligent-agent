import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { resolveTraceContext } from '../observability/trace-context.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const provided = request.header('x-request-id');
    request.requestId =
      provided !== undefined && SAFE_REQUEST_ID.test(provided) ? provided : randomUUID();
    const providedCorrelationId = request.header('x-correlation-id');
    const providedTraceparent = request.header('traceparent');
    const trace = resolveTraceContext({
      requestId: request.requestId,
      ...(providedCorrelationId === undefined ? {} : { correlationId: providedCorrelationId }),
      ...(providedTraceparent === undefined ? {} : { traceparent: providedTraceparent }),
    });
    request.correlationId = trace.correlationId;
    request.traceId = trace.traceId;
    request.traceparent = trace.traceparent;
    response.setHeader('x-request-id', request.requestId);
    response.setHeader('x-correlation-id', request.correlationId);
    response.setHeader('traceparent', request.traceparent);
    next();
  }
}
