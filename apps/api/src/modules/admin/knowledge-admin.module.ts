import { Module } from '@nestjs/common';

import { AiEvaluationModule } from '../ai-evaluation/ai-evaluation.module.js';
import { KnowledgeIngestionModule } from '../knowledge-ingestion/knowledge-ingestion.module.js';
import { KnowledgeGraphGovernanceModule } from '../knowledge-graph-governance/knowledge-graph-governance.module.js';
import { KnowledgeRetrievalModule } from '../knowledge-retrieval/knowledge-retrieval.module.js';
import { KnowledgeSemanticModule } from '../knowledge-semantic/knowledge-semantic.module.js';
import { AdminAccessModule } from './admin-access.module.js';
import { KnowledgeAdminController } from './knowledge-admin.controller.js';
import { KnowledgeAdminService } from './knowledge-admin.service.js';

@Module({
  imports: [
    AdminAccessModule,
    AiEvaluationModule,
    KnowledgeGraphGovernanceModule,
    KnowledgeIngestionModule,
    KnowledgeRetrievalModule,
    KnowledgeSemanticModule,
  ],
  controllers: [KnowledgeAdminController],
  providers: [KnowledgeAdminService],
})
export class KnowledgeAdminModule {}
