import { Module } from '@nestjs/common';

import { AiEvaluationModule } from '../ai-evaluation/ai-evaluation.module.js';
import { KnowledgeGatewayModule } from '../knowledge-gateway/knowledge-gateway.module.js';
import { KnowledgeGraphGovernanceModule } from '../knowledge-graph-governance/knowledge-graph-governance.module.js';
import { KnowledgeProviderModule } from '../knowledge-provider/knowledge-provider.module.js';
import { KnowledgeSemanticModule } from '../knowledge-semantic/knowledge-semantic.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { KnowledgeAdminController } from './knowledge-admin.controller.js';
import { KnowledgeAdminService } from './knowledge-admin.service.js';
import { ControlledKnowledgeSourceFetcher } from './controlled-knowledge-source-fetcher.js';
import { KnowledgeSourceSyncService } from './knowledge-source-sync.service.js';

@Module({
  imports: [
    AdminAccessModule,
    AiEvaluationModule,
    KnowledgeGraphGovernanceModule,
    KnowledgeProviderModule,
    KnowledgeGatewayModule,
    KnowledgeSemanticModule,
  ],
  controllers: [KnowledgeAdminController],
  providers: [KnowledgeAdminService, ControlledKnowledgeSourceFetcher, KnowledgeSourceSyncService],
})
export class KnowledgeAdminModule {}
