import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  createScimServiceTokenRequestSchema,
  identityProviderCommandRequestSchema,
  oidcProviderInputSchema,
  revokeScimServiceTokenRequestSchema,
  rotateScimServiceTokenRequestSchema,
  scimConnectorCommandRequestSchema,
  scimConnectorCreateRequestSchema,
  scimConnectorUpdateRequestSchema,
  upsertIdentityPolicyRequestSchema,
  type CreateScimServiceTokenRequest,
  type IdentityPolicy,
  type IdentityProvider,
  type IdentityProviderCommandRequest,
  type OidcProviderInput,
  type RevokeScimServiceTokenRequest,
  type RotateScimServiceTokenRequest,
  type ScimConnector,
  type ScimConnectorCommandRequest,
  type ScimConnectorCreateRequest,
  type ScimConnectorUpdateRequest,
  type ScimServiceTokenCreated,
  type ScimServiceTokenMetadata,
  type UpsertIdentityPolicyRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import type { AuthenticatedPrincipal } from '../auth/domain/authenticated-principal.js';
import { IdentityGovernanceAdminService } from './identity-governance-admin.service.js';

@Controller('admin/identity-governance')
export class IdentityGovernanceAdminController {
  constructor(
    @Inject(IdentityGovernanceAdminService)
    private readonly governance: IdentityGovernanceAdminService,
  ) {}

  @Get('providers')
  listProviders(@Req() request: Request): Promise<{ items: IdentityProvider[] }> {
    return this.governance.listProviders(requirePrincipal(request));
  }

  @Put('providers/oidc')
  upsertOidc(
    @Body(new SchemaValidationPipe(oidcProviderInputSchema))
    body: OidcProviderInput,
    @Req() request: Request,
  ): Promise<IdentityProvider> {
    return this.governance.upsertOidc(body, requirePrincipal(request));
  }

  @Post('providers/:providerId/verify')
  verifyOidc(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Req() request: Request,
  ): Promise<IdentityProvider> {
    return this.governance.verifyOidc(providerId, requirePrincipal(request));
  }

  @Post('providers/:providerId/submit')
  submit(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body(new SchemaValidationPipe(identityProviderCommandRequestSchema))
    body: IdentityProviderCommandRequest,
    @Req() request: Request,
  ): Promise<IdentityProvider> {
    return this.governance.transitionProvider(
      providerId,
      'SUBMIT',
      body,
      requirePrincipal(request),
    );
  }

  @Post('providers/:providerId/publish')
  publish(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body(new SchemaValidationPipe(identityProviderCommandRequestSchema))
    body: IdentityProviderCommandRequest,
    @Req() request: Request,
  ): Promise<IdentityProvider> {
    return this.governance.transitionProvider(
      providerId,
      'PUBLISH',
      body,
      requirePrincipal(request),
    );
  }

  @Post('providers/:providerId/retire')
  retire(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body(new SchemaValidationPipe(identityProviderCommandRequestSchema))
    body: IdentityProviderCommandRequest,
    @Req() request: Request,
  ): Promise<IdentityProvider> {
    return this.governance.transitionProvider(
      providerId,
      'RETIRE',
      body,
      requirePrincipal(request),
    );
  }

  @Get('policy')
  async policy(@Req() request: Request, @Res() response: Response): Promise<void> {
    const policy = await this.governance.getPolicy(requirePrincipal(request));
    response.status(200).json(policy);
  }

  @Put('policy')
  upsertPolicy(
    @Body(new SchemaValidationPipe(upsertIdentityPolicyRequestSchema))
    body: UpsertIdentityPolicyRequest,
    @Req() request: Request,
  ): Promise<IdentityPolicy> {
    return this.governance.upsertPolicy(body, requirePrincipal(request));
  }

  @Get('scim/connectors')
  listScimConnectors(@Req() request: Request): Promise<{ items: ScimConnector[] }> {
    return this.governance.listScimConnectors(requirePrincipal(request));
  }

  @Post('scim/connectors')
  createScimConnector(
    @Body(new SchemaValidationPipe(scimConnectorCreateRequestSchema))
    body: ScimConnectorCreateRequest,
    @Req() request: Request,
  ): Promise<ScimConnector> {
    return this.governance.createScimConnector(body, requirePrincipal(request));
  }

  @Put('scim/connectors/:connectorId')
  updateScimConnector(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(scimConnectorUpdateRequestSchema))
    body: ScimConnectorUpdateRequest,
    @Req() request: Request,
  ): Promise<ScimConnector> {
    return this.governance.updateScimConnector(connectorId, body, requirePrincipal(request));
  }

  @Post('scim/connectors/:connectorId/submit')
  submitScimConnector(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(scimConnectorCommandRequestSchema))
    body: ScimConnectorCommandRequest,
    @Req() request: Request,
  ): Promise<ScimConnector> {
    return this.governance.transitionScimConnector(
      connectorId,
      'SUBMIT',
      body,
      requirePrincipal(request),
    );
  }

  @Post('scim/connectors/:connectorId/activate')
  activateScimConnector(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(scimConnectorCommandRequestSchema))
    body: ScimConnectorCommandRequest,
    @Req() request: Request,
  ): Promise<ScimConnector> {
    return this.governance.transitionScimConnector(
      connectorId,
      'ACTIVATE',
      body,
      requirePrincipal(request),
    );
  }

  @Post('scim/connectors/:connectorId/suspend')
  suspendScimConnector(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(scimConnectorCommandRequestSchema))
    body: ScimConnectorCommandRequest,
    @Req() request: Request,
  ): Promise<ScimConnector> {
    return this.governance.transitionScimConnector(
      connectorId,
      'SUSPEND',
      body,
      requirePrincipal(request),
    );
  }

  @Post('scim/connectors/:connectorId/retire')
  retireScimConnector(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(scimConnectorCommandRequestSchema))
    body: ScimConnectorCommandRequest,
    @Req() request: Request,
  ): Promise<ScimConnector> {
    return this.governance.transitionScimConnector(
      connectorId,
      'RETIRE',
      body,
      requirePrincipal(request),
    );
  }

  @Get('scim/connectors/:connectorId/tokens')
  listScimServiceTokens(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Req() request: Request,
  ): Promise<{ items: ScimServiceTokenMetadata[] }> {
    return this.governance.listScimServiceTokens(connectorId, requirePrincipal(request));
  }

  @Post('scim/connectors/:connectorId/tokens')
  createScimServiceToken(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(createScimServiceTokenRequestSchema))
    body: CreateScimServiceTokenRequest,
    @Req() request: Request,
  ): Promise<ScimServiceTokenCreated> {
    return this.governance.createScimServiceToken(connectorId, body, requirePrincipal(request));
  }

  @Post('scim/connectors/:connectorId/tokens/:tokenId/rotate')
  rotateScimServiceToken(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Param('tokenId', new ParseUUIDPipe()) tokenId: string,
    @Body(new SchemaValidationPipe(rotateScimServiceTokenRequestSchema))
    body: RotateScimServiceTokenRequest,
    @Req() request: Request,
  ): Promise<ScimServiceTokenCreated> {
    return this.governance.rotateScimServiceToken(
      connectorId,
      tokenId,
      body,
      requirePrincipal(request),
    );
  }

  @Post('scim/connectors/:connectorId/tokens/:tokenId/revoke')
  revokeScimServiceToken(
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Param('tokenId', new ParseUUIDPipe()) tokenId: string,
    @Body(new SchemaValidationPipe(revokeScimServiceTokenRequestSchema))
    body: RevokeScimServiceTokenRequest,
    @Req() request: Request,
  ): Promise<ScimServiceTokenMetadata> {
    return this.governance.revokeScimServiceToken(
      connectorId,
      tokenId,
      body,
      requirePrincipal(request),
    );
  }
}

function requirePrincipal(request: Request): AuthenticatedPrincipal {
  if (request.authPrincipal === undefined) {
    throw new UnauthorizedException('Authentication required.');
  }
  return request.authPrincipal;
}
