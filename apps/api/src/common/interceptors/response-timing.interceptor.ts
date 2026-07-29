import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { finalize, Observable, tap } from 'rxjs';

import { buildHttpAccessLog } from '../observability/http-access-log.js';
import { SUPPRESS_RESPONSE_TIMING } from './suppress-response-timing.decorator.js';

/** Keeps success payloads contract-native while standardizing response metadata. */
@Injectable()
export class ResponseTimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpAccess');

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const suppressed = this.reflector.getAllAndOverride<boolean>(SUPPRESS_RESPONSE_TIMING, [
      context.getHandler(),
      context.getClass(),
    ]);
    const startedAt = performance.now();
    let observedErrorStatus: number | undefined;
    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          observedErrorStatus = error instanceof HttpException ? error.getStatus() : 500;
        },
      }),
      finalize(() => {
        const durationMs = performance.now() - startedAt;
        if (suppressed === true) {
          response.removeHeader('server-timing');
        } else {
          response.setHeader('server-timing', `app;dur=${durationMs.toFixed(1)}`);
        }
        this.logger.log(
          JSON.stringify(
            buildHttpAccessLog({
              request,
              response,
              ...(observedErrorStatus === undefined ? {} : { statusCode: observedErrorStatus }),
              durationMs,
            }),
          ),
        );
      }),
    );
  }
}
