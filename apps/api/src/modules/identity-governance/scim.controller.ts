import {
  Body,
  type CallHandler,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  type NestInterceptor,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import {
  SCIM_BULK_MAX_OPERATIONS,
  SCIM_BULK_MAX_PAYLOAD_BYTES,
  type ScimBulkResponse,
  type ScimGroup,
  type ScimUser,
} from '@enterprise/contracts';

import { Public } from '../auth/public.decorator.js';
import { SCIM_MEDIA_TYPE, ScimExceptionFilter, ScimHttpException } from './scim.errors.js';
import { ScimService, type ScimListQuery, type ScimRequestIdentity } from './scim.service.js';

class ScimContentTypeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context.switchToHttp().getResponse<Response>().setHeader('Content-Type', SCIM_MEDIA_TYPE);
    return next.handle();
  }
}

@Public()
@UseFilters(ScimExceptionFilter)
@UseInterceptors(new ScimContentTypeInterceptor())
@Controller('scim/v2/:connectorKey')
export class ScimController {
  constructor(@Inject(ScimService) private readonly scim: ScimService) {}

  @Get('ServiceProviderConfig')
  serviceProviderConfig(): unknown {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: {
        supported: true,
        maxOperations: SCIM_BULK_MAX_OPERATIONS,
        maxPayloadSize: SCIM_BULK_MAX_PAYLOAD_BYTES,
      },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: true },
      etag: { supported: true },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer Token',
          description: 'Opaque tenant-scoped SCIM service token.',
          specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
          primary: true,
        },
      ],
    };
  }

  @Post('Bulk')
  @HttpCode(HttpStatus.OK)
  bulk(
    @Param('connectorKey') connectorKey: string,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<ScimBulkResponse> {
    return this.scim.bulk(connectorKey, identity(request), body);
  }

  @Get('Users')
  listUsers(
    @Param('connectorKey') connectorKey: string,
    @Req() request: Request,
    @Query() query: ScimListQuery,
  ): Promise<unknown> {
    return this.scim.listUsers(connectorKey, identity(request), query);
  }

  @Get('Users/:scimId')
  async getUser(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimUser> {
    const resource = await this.scim.getUser(connectorKey, scimId, identity(request));
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Post('Users')
  @HttpCode(HttpStatus.CREATED)
  async createUser(
    @Param('connectorKey') connectorKey: string,
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimUser> {
    const resource = await this.scim.createUser(connectorKey, identity(request), body);
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Put('Users/:scimId')
  async replaceUser(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimUser> {
    const resource = await this.scim.replaceUser(connectorKey, scimId, identity(request), body);
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Patch('Users/:scimId')
  async patchUser(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimUser> {
    const resource = await this.scim.patchUser(connectorKey, scimId, identity(request), body);
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Delete('Users/:scimId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.scim.deleteUser(connectorKey, scimId, identity(request));
  }

  @Get('Groups')
  listGroups(
    @Param('connectorKey') connectorKey: string,
    @Req() request: Request,
    @Query() query: ScimListQuery,
  ): Promise<unknown> {
    return this.scim.listGroups(connectorKey, identity(request), query);
  }

  @Get('Groups/:scimId')
  async getGroup(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimGroup> {
    const resource = await this.scim.getGroup(connectorKey, scimId, identity(request));
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Post('Groups')
  @HttpCode(HttpStatus.CREATED)
  async createGroup(
    @Param('connectorKey') connectorKey: string,
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimGroup> {
    const resource = await this.scim.createGroup(connectorKey, identity(request), body);
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Put('Groups/:scimId')
  async replaceGroup(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimGroup> {
    const resource = await this.scim.replaceGroup(connectorKey, scimId, identity(request), body);
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Patch('Groups/:scimId')
  async patchGroup(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScimGroup> {
    const resource = await this.scim.patchGroup(connectorKey, scimId, identity(request), body);
    applyResourceHeaders(response, resource);
    return resource;
  }

  @Delete('Groups/:scimId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteGroup(
    @Param('connectorKey') connectorKey: string,
    @Param('scimId') scimId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.scim.deleteGroup(connectorKey, scimId, identity(request));
  }
}

function identity(request: Request): ScimRequestIdentity {
  const authorization = request.header('authorization');
  const match = /^Bearer (ea_scim_[A-Za-z0-9_-]{32,256})$/i.exec(authorization ?? '');
  if (match === null) throw new ScimHttpException(401, 'SCIM bearer capability is required.');
  const idempotencyKey = optionalBoundedHeader(request, 'idempotency-key', 200);
  const ifMatch = optionalBoundedHeader(request, 'if-match', 100);
  return {
    bearer: match[1]!,
    requestId: (request.requestId ?? 'scim-request').slice(0, 200),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(ifMatch === undefined ? {} : { ifMatch }),
  };
}

function optionalBoundedHeader(
  request: Request,
  name: string,
  maxLength: number,
): string | undefined {
  const value = request.header(name);
  if (value === undefined) return undefined;
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new ScimHttpException(
      400,
      `${name} header is outside the supported range.`,
      'invalidValue',
    );
  }
  return value;
}

function applyResourceHeaders(
  response: Response,
  resource: { readonly meta: { readonly version: string; readonly location: string } },
): void {
  response.setHeader('ETag', resource.meta.version);
  response.setHeader('Location', resource.meta.location);
  response.setHeader('Content-Type', 'application/scim+json');
}
