import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  bindLexiangUserRequestSchema,
  type BindLexiangUserRequest,
  createLexiangConnectionRequestSchema,
  type CreateLexiangConnectionRequest,
  discoverLexiangConnectionRequestSchema,
  type DiscoverLexiangConnectionRequest,
  type KnowledgeProviderConnectionResponse,
  type KnowledgeProviderHealthCheckResponse,
  type LexiangConnectionDiscoveryResponse,
  type KnowledgeProviderUserBindingsResponse,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { AdminAccessService } from '../admin/admin-access.service.js';
import { KnowledgeProviderConnectionService } from './application/knowledge-provider-connection.service.js';
import { KnowledgeProviderIdentityService } from './application/knowledge-provider-identity.service.js';

@Controller('admin/integrations/knowledge/lexiang')
export class KnowledgeProviderController {
  constructor(
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(KnowledgeProviderConnectionService)
    private readonly connections: KnowledgeProviderConnectionService,
    @Inject(KnowledgeProviderIdentityService)
    private readonly identities: KnowledgeProviderIdentityService,
  ) {}

  @Get('connection')
  getConnection(): Promise<KnowledgeProviderConnectionResponse> {
    return this.connections.get(this.access.requireDirectoryWrite());
  }

  @Put('connection')
  connect(
    @Body(new SchemaValidationPipe(createLexiangConnectionRequestSchema))
    request: CreateLexiangConnectionRequest,
  ): Promise<KnowledgeProviderConnectionResponse> {
    return this.connections.connect(this.access.requireDirectoryWrite(), request);
  }

  @Post('discovery')
  discover(
    @Body(new SchemaValidationPipe(discoverLexiangConnectionRequestSchema))
    request: DiscoverLexiangConnectionRequest,
  ): Promise<LexiangConnectionDiscoveryResponse> {
    this.access.requireDirectoryWrite();
    return this.connections.discover(request);
  }

  @Post('health-check')
  checkHealth(): Promise<KnowledgeProviderHealthCheckResponse> {
    return this.connections.checkHealth(this.access.requireDirectoryWrite());
  }

  @Delete('connection')
  disable(): Promise<KnowledgeProviderConnectionResponse> {
    return this.connections.disable(this.access.requireDirectoryWrite());
  }

  @Get('user-bindings')
  listUserBindings(): Promise<KnowledgeProviderUserBindingsResponse> {
    return this.identities.list(this.access.requireDirectoryWrite().tenantId);
  }

  @Put('user-bindings')
  bindUser(
    @Body(new SchemaValidationPipe(bindLexiangUserRequestSchema)) request: BindLexiangUserRequest,
  ): Promise<KnowledgeProviderUserBindingsResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.identities.bind(principal.tenantId, principal.userId, request);
  }

  @Delete('user-bindings/:userId')
  disableUserBinding(
    @Param('userId', new ParseUUIDPipe({ version: '7' })) userId: string,
  ): Promise<KnowledgeProviderUserBindingsResponse> {
    const principal = this.access.requireDirectoryWrite();
    return this.identities.disable(principal.tenantId, principal.userId, userId);
  }
}
