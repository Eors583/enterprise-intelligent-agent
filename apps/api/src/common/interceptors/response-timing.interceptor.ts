import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';

import { SUPPRESS_RESPONSE_TIMING } from './suppress-response-timing.decorator.js';

/** Keeps success payloads contract-native while standardizing response metadata. */
@Injectable()
export class ResponseTimingInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    const suppressed = this.reflector.getAllAndOverride<boolean>(SUPPRESS_RESPONSE_TIMING, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (suppressed === true) {
      response.removeHeader('server-timing');
      return next.handle();
    }

    const startedAt = performance.now();
    return next.handle().pipe(
      tap(() => {
        response.setHeader(
          'server-timing',
          `app;dur=${(performance.now() - startedAt).toFixed(1)}`,
        );
      }),
    );
  }
}
