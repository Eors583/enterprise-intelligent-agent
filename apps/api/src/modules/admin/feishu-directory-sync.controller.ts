import { Body, Controller, Get, Inject, Post, Put, Res } from '@nestjs/common';
import {
  applyFeishuDirectoryPreviewRequestSchema,
  type ApplyFeishuDirectoryPreviewRequest,
  bindFeishuOrganizationRequestSchema,
  type BindFeishuOrganizationRequest,
  type FeishuDirectoryPreview,
  type FeishuDirectorySyncRunDetail,
  type FeishuDirectorySyncRunList,
  type FeishuOrganizationSyncStatus,
} from '@enterprise/contracts';
import type { Response } from 'express';

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

  @Get('preview')
  async getPreview(@Res() response: Response): Promise<void> {
    const preview = await this.sync.getCurrentPreview();
    response.status(200).json(preview);
  }

  @Post('preview')
  preview(): Promise<FeishuDirectoryPreview> {
    return this.sync.createPreview();
  }

  @Get('runs')
  listRuns(): Promise<FeishuDirectorySyncRunList> {
    return this.sync.listRuns();
  }

  @Post('runs')
  applyPreview(
    @Body(new SchemaValidationPipe(applyFeishuDirectoryPreviewRequestSchema))
    request: ApplyFeishuDirectoryPreviewRequest,
  ): Promise<FeishuDirectorySyncRunDetail> {
    return this.sync.enqueuePreview(request);
  }

  @Put('connection')
  bind(
    @Body(new SchemaValidationPipe(bindFeishuOrganizationRequestSchema))
    request: BindFeishuOrganizationRequest,
  ): Promise<FeishuOrganizationSyncStatus> {
    return this.sync.bind(request);
  }
}
