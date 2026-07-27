import { Module } from '@nestjs/common';

import { AgentRunModule } from '../agent-run/agent-run.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { AgentAdminController } from './agent-admin.controller.js';
import { AgentAdminService } from './agent-admin.service.js';

@Module({
  imports: [AdminAccessModule, AgentRunModule],
  controllers: [AgentAdminController],
  providers: [AgentAdminService],
})
export class AgentAdminModule {}
