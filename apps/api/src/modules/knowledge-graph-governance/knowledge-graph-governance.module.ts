import { Module } from '@nestjs/common';

import { AdminAccessModule } from '../admin/admin-access.module.js';
import { KnowledgeGraphGovernanceController } from './knowledge-graph-governance.controller.js';
import { KnowledgeGraphGovernanceService } from './knowledge-graph-governance.service.js';

@Module({
  imports: [AdminAccessModule],
  controllers: [KnowledgeGraphGovernanceController],
  providers: [KnowledgeGraphGovernanceService],
  exports: [KnowledgeGraphGovernanceService],
})
export class KnowledgeGraphGovernanceModule {}
