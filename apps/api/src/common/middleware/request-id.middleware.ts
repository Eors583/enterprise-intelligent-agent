import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const provided = request.header('x-request-id');
    request.requestId =
      provided !== undefined && SAFE_REQUEST_ID.test(provided) ? provided : randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
