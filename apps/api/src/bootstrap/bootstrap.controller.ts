import { Controller, Get, Inject } from '@nestjs/common';
import type { BootstrapResponse } from '@enterprise/contracts';

import { BootstrapService } from './bootstrap.service.js';

@Controller('bootstrap')
export class BootstrapController {
  constructor(@Inject(BootstrapService) private readonly service: BootstrapService) {}

  @Get()
  getBootstrap(): Promise<BootstrapResponse> {
    return this.service.getBootstrap();
  }
}
