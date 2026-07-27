import { Body, Controller, Get, Inject, Post, Put } from '@nestjs/common';
import {
  bindFeishuOrganizationRequestSchema,
  type BindFeishuOrganizationRequest,
  type FeishuOrganizationSyncStatus,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { FeishuDirectorySyncService } from './feishu-directory-sync.service.js';

@Controller('admin/integrations/feishu/organization-sync')
export class FeishuDirectorySyncController {
  constructor(
    @Inject(FeishuDirectorySyncService)
    private readonly sync: FeishuDirectorySyncService,
  ) {}

  @Get()
  getStatus(): Promise<FeishuOrganizationSyncStatus> {
    return this.sync.getStatus();
  }

  @Post()
  start(): Promise<FeishuOrganizationSyncStatus> {
    return this.sync.startSync();
  }

  @Put('connection')
  bind(
    @Body(new SchemaValidationPipe(bindFeishuOrganizationRequestSchema))
    request: BindFeishuOrganizationRequest,
  ): Promise<FeishuOrganizationSyncStatus> {
    return this.sync.bind(request);
  }
}
