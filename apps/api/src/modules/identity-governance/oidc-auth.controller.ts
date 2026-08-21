import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  oidcLoginCallbackRequestSchema,
  oidcLoginStartRequestSchema,
  type AuthSessionResponse,
  type BrowserAuthSessionResponse,
  type OidcLoginCallbackRequest,
  type OidcLoginStartRequest,
  type OidcLoginStartResponse,
} from '@enterprise/contracts';
import type { Response } from 'express';

import { SuppressResponseTiming } from '../../common/interceptors/suppress-response-timing.decorator.js';
import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { Public } from '../auth/public.decorator.js';
import { BrowserSessionTransport } from '../auth/browser-session.transport.js';
import { OidcAuthService } from './oidc-auth.service.js';

@Controller('auth')
export class OidcAuthController {
  constructor(
    @Inject(OidcAuthService) private readonly oidc: OidcAuthService,
    @Inject(BrowserSessionTransport)
    private readonly browserSession: BrowserSessionTransport,
  ) {}

  @Public()
  @Get('oidc/providers/:tenantSlug')
  providers(
    @Param('tenantSlug') tenantSlug: string,
  ): Promise<{ items: Array<{ key: string; displayName: string; protocol: 'OIDC' }> }> {
    return this.oidc.publicProviders(tenantSlug.trim().toLowerCase());
  }

  @Public()
  @SuppressResponseTiming()
  @Post('oidc/start')
  @HttpCode(HttpStatus.OK)
  start(
    @Body(new SchemaValidationPipe(oidcLoginStartRequestSchema))
    request: OidcLoginStartRequest,
  ): Promise<OidcLoginStartResponse> {
    return this.oidc.start(request);
  }

  @Public()
  @SuppressResponseTiming()
  @Post('oidc/callback')
  @HttpCode(HttpStatus.OK)
  callback(
    @Body(new SchemaValidationPipe(oidcLoginCallbackRequestSchema))
    request: OidcLoginCallbackRequest,
  ): Promise<AuthSessionResponse> {
    return this.oidc.callback(request);
  }

  @Public()
  @SuppressResponseTiming()
  @Post('browser/oidc/callback')
  @HttpCode(HttpStatus.OK)
  async browserCallback(
    @Body(new SchemaValidationPipe(oidcLoginCallbackRequestSchema))
    request: OidcLoginCallbackRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BrowserAuthSessionResponse> {
    return this.browserSession.issue(response, await this.oidc.callback(request));
  }

  @Public()
  @Post('saml/:tenantSlug/:providerKey')
  samlFailClosed(): never {
    throw new ServiceUnavailableException(
      'SAML is disabled because no XML-signature verifier adapter is configured.',
    );
  }
}
