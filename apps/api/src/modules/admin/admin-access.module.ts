import { Module } from '@nestjs/common';

import { AdminAccessService } from './admin-access.service.js';

@Module({
  providers: [AdminAccessService],
  exports: [AdminAccessService],
})
export class AdminAccessModule {}
