import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

export const SCIM_MEDIA_TYPE = 'application/scim+json';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error' as const;

export class ScimHttpException extends HttpException {
  constructor(
    status: number,
    detail: string,
    readonly scimType?: string,
  ) {
    super(detail, status);
  }
}

export interface ScimErrorBody {
  readonly schemas: readonly [typeof SCIM_ERROR_SCHEMA];
  readonly status: string;
  readonly scimType?: string;
  readonly detail: string;
}

export function toScimError(exception: unknown): {
  readonly status: number;
  readonly body: ScimErrorBody;
} {
  const status =
    exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const detail =
    exception instanceof ScimHttpException
      ? exception.message
      : status >= 500
        ? 'An unexpected SCIM error occurred.'
        : exception instanceof Error
          ? exception.message
          : 'SCIM request failed.';
  return {
    status,
    body: {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      ...(exception instanceof ScimHttpException && exception.scimType !== undefined
        ? { scimType: exception.scimType }
        : {}),
      detail,
    },
  };
}

@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const error = toScimError(exception);
    response.status(error.status).type(SCIM_MEDIA_TYPE).json(error.body);
  }
}
