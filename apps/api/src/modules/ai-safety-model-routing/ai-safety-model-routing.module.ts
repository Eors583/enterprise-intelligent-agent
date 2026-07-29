import { Module } from '@nestjs/common';

import { AiSafetyModelRoutingController } from './ai-safety-model-routing.controller.js';
import { AiModelConnectivityProbeService } from './ai-model-connectivity-probe.service.js';
import { AiSafetyModelRoutingService } from './ai-safety-model-routing.service.js';
import { AgentOperationalReadinessModule } from './agent-operational-readiness.module.js';
import { AdminAccessModule } from '../admin/admin-access.module.js';
import { AgentRunModule } from '../agent-run/agent-run.module.js';

@Module({
  imports: [AdminAccessModule, AgentOperationalReadinessModule, AgentRunModule],
  controllers: [AiSafetyModelRoutingController],
  providers: [AiSafetyModelRoutingService, AiModelConnectivityProbeService],
  exports: [AiSafetyModelRoutingService],
})
export class AiSafetyModelRoutingModule {}
