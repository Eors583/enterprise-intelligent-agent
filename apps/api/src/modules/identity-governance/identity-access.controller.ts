import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  revokeIdentityResourceRequestSchema,
  type IdentitySecurityOverview,
  type RevokeIdentityResourceRequest,
  type RevokeIdentityResourceResponse,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';
import { IdentityAccessService } from './identity-access.service.js';

@Controller('identity/security')
export class IdentityAccessController {
  constructor(
    @Inject(IdentityAccessService)
    private readonly access: IdentityAccessService,
  ) {}

  @Get()
  overview(@Req() request: Request): Promise<IdentitySecurityOverview> {
    return this.access.overview(requirePrincipal(request));
  }

  @Post('sessions/:sessionId/revoke')
  revokeSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body(new SchemaValidationPipe(revokeIdentityResourceRequestSchema))
    request: RevokeIdentityResourceRequest,
    @Req() httpRequest: Request,
  ): Promise<RevokeIdentityResourceResponse> {
    return this.access.revokeSession(sessionId, request, requirePrincipal(httpRequest));
  }

  @Post('devices/:deviceId/revoke')
  revokeDevice(
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Body(new SchemaValidationPipe(revokeIdentityResourceRequestSchema))
    request: RevokeIdentityResourceRequest,
    @Req() httpRequest: Request,
  ): Promise<RevokeIdentityResourceResponse> {
    return this.access.revokeDevice(deviceId, request, requirePrincipal(httpRequest));
  }
}

function requirePrincipal(request: Request): AuthenticatedPrincipal {
  if (request.authPrincipal === undefined) {
    throw new UnauthorizedException('Authentication required.');
  }
  return request.authPrincipal;
}
