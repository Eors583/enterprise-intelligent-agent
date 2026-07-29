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
  breakGlassActivateRequestSchema,
  breakGlassDecisionRequestSchema,
  breakGlassRevokeRequestSchema,
  breakGlassScopeSchema,
  closeBreakGlassReviewRequestSchema,
  createBreakGlassRequestSchema,
  type BreakGlassActivateRequest,
  type BreakGlassDecisionRequest,
  type BreakGlassRequest,
  type BreakGlassRevokeRequest,
  type BreakGlassScope,
  type CloseBreakGlassReviewRequest,
  type CreateBreakGlassRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';
import { BreakGlassService } from './break-glass.service.js';

@Controller('identity/break-glass')
export class BreakGlassController {
  constructor(@Inject(BreakGlassService) private readonly breakGlass: BreakGlassService) {}

  @Get()
  listMine(@Req() request: Request): Promise<{ items: BreakGlassRequest[] }> {
    return this.breakGlass.listMine(requirePrincipal(request));
  }

  @Post()
  request(
    @Body(new SchemaValidationPipe(createBreakGlassRequestSchema))
    body: CreateBreakGlassRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.request(body, requirePrincipal(request));
  }

  @Post(':requestId/activate')
  activate(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new SchemaValidationPipe(breakGlassActivateRequestSchema))
    body: BreakGlassActivateRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.activate(requestId, body, requirePrincipal(request));
  }

  @Post(':requestId/revoke')
  revoke(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new SchemaValidationPipe(breakGlassRevokeRequestSchema))
    body: BreakGlassRevokeRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.revoke(requestId, body, requirePrincipal(request));
  }

  @Get('active/:scope')
  async active(
    @Param('scope', new SchemaValidationPipe(breakGlassScopeSchema))
    scope: BreakGlassScope,
    @Req() request: Request,
  ): Promise<{ scope: BreakGlassScope; active: boolean }> {
    return {
      scope,
      active: await this.breakGlass.hasActiveGrant(scope, requirePrincipal(request)),
    };
  }
}

@Controller('admin/identity-governance/break-glass')
export class BreakGlassAdminController {
  constructor(@Inject(BreakGlassService) private readonly breakGlass: BreakGlassService) {}

  @Get()
  list(@Req() request: Request): Promise<{ items: BreakGlassRequest[] }> {
    return this.breakGlass.listForAdministration(requirePrincipal(request));
  }

  @Post(':requestId/approve')
  approve(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new SchemaValidationPipe(breakGlassDecisionRequestSchema))
    body: BreakGlassDecisionRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.approve(requestId, body, requirePrincipal(request));
  }

  @Post(':requestId/reject')
  reject(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new SchemaValidationPipe(breakGlassDecisionRequestSchema))
    body: BreakGlassDecisionRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.reject(requestId, body, requirePrincipal(request));
  }

  @Post(':requestId/revoke')
  revoke(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new SchemaValidationPipe(breakGlassRevokeRequestSchema))
    body: BreakGlassRevokeRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.revoke(requestId, body, requirePrincipal(request));
  }

  @Post(':requestId/review-close')
  closeReview(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new SchemaValidationPipe(closeBreakGlassReviewRequestSchema))
    body: CloseBreakGlassReviewRequest,
    @Req() request: Request,
  ): Promise<BreakGlassRequest> {
    return this.breakGlass.closeReview(requestId, body, requirePrincipal(request));
  }
}

function requirePrincipal(request: Request): AuthenticatedPrincipal {
  if (request.authPrincipal === undefined) {
    throw new UnauthorizedException('Authentication required.');
  }
  return request.authPrincipal;
}
