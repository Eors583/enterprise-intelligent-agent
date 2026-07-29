import { Module } from '@nestjs/common';

import { AgentOperationalReadinessService } from './agent-operational-readiness.service.js';
import { ModelRoutingRuntimeReadinessClient } from './model-routing-runtime-readiness.client.js';

@Module({
  providers: [AgentOperationalReadinessService, ModelRoutingRuntimeReadinessClient],
  exports: [AgentOperationalReadinessService, ModelRoutingRuntimeReadinessClient],
})
export class AgentOperationalReadinessModule {}
