import { Module } from '@nestjs/common';

import { AgentRunModule } from '../agent-run/agent-run.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { AgentAdminController } from './agent-admin.controller.js';
import { AgentAdminService } from './agent-admin.service.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';

@Module({
  imports: [AdminAccessModule, AgentRunModule, KnowledgeGatewayModule],
  controllers: [AgentAdminController],
  providers: [AgentAdminService],
})
export class AgentAdminModule {}
