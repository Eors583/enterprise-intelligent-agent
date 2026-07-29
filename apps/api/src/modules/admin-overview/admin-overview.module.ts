import { Module } from '@nestjs/common';

import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';
import { AgentOperationalReadinessModule } from '../ai-safety-model-routing/agent-operational-readiness.module.js';

@Module({
  imports: [AdminAccessModule, AgentOperationalReadinessModule],
  controllers: [AdminOverviewController],
  providers: [AdminOverviewService],
})
export class AdminOverviewModule {}
