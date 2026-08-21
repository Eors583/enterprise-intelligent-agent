import { Controller, Get, Inject } from '@nestjs/common';
import type { AdminOverviewResponse } from '@enterprise/contracts';

import { AdminOverviewService } from './admin-overview.service.js';

@Controller('admin/overview')
export class AdminOverviewController {
  constructor(
    @Inject(AdminOverviewService)
    private readonly overview: AdminOverviewService,
  ) {}

  @Get()
  read(): Promise<AdminOverviewResponse> {
    return this.overview.read();
  }
}
