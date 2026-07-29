import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorResponse } from '@enterprise/contracts';

import { buildHttpFailureLog } from '../observability/http-access-log.js';

type ErrorDescription = Pick<ApiErrorResponse, 'code' | 'message' | 'details'>;

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const description = this.describe(exception, status);

    if (status >= 500) {
      this.logger.error(
        JSON.stringify(buildHttpFailureLog({ request, statusCode: status, error: exception })),
      );
    }

    const body: ApiErrorResponse = {
      ...description,
      request_id: request.requestId,
    };
    response.status(status).json(body);
  }

  private describe(exception: unknown, status: number): ErrorDescription {
    if (!(exception instanceof HttpException)) {
      return {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
      };
    }

    const payload: unknown = exception.getResponse();
    if (typeof payload === 'string') {
      return { code: this.codeForStatus(status), message: payload };
    }
    if (this.isRecord(payload)) {
      const rawMessage = payload.message;
      const message = Array.isArray(rawMessage)
        ? 'Request validation failed.'
        : typeof rawMessage === 'string'
          ? rawMessage
          : exception.message;
      const details = Array.isArray(rawMessage) ? rawMessage : undefined;
      return details === undefined
        ? { code: this.codeForStatus(status), message }
        : { code: this.codeForStatus(status), message, details };
    }
    return { code: this.codeForStatus(status), message: exception.message };
  }

  private codeForStatus(status: number): string {
    return HttpStatus[status] ?? `HTTP_${status}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
