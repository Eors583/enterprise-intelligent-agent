import { Module } from '@nestjs/common';

import { KnowledgeIngestionModule } from '../knowledge-ingestion/knowledge-ingestion.module.js';
import { KnowledgeRetrievalModule } from '../knowledge-retrieval/knowledge-retrieval.module.js';
import { InProcessKnowledgeGateway } from './in-process-knowledge.gateway.js';
import { InProcessKnowledgeRetrievalGateway } from './in-process-knowledge-retrieval.gateway.js';
import { KnowledgeBoundaryReadService } from './knowledge-boundary-read.service.js';
import {
  KnowledgeGateway,
  KnowledgeEvaluationGateway,
  KnowledgeRetrievalGateway,
} from './knowledge-gateway.port.js';

@Module({
  imports: [KnowledgeIngestionModule, KnowledgeRetrievalModule],
  providers: [
    KnowledgeBoundaryReadService,
    InProcessKnowledgeRetrievalGateway,
    { provide: KnowledgeRetrievalGateway, useExisting: InProcessKnowledgeRetrievalGateway },
    { provide: KnowledgeEvaluationGateway, useExisting: InProcessKnowledgeRetrievalGateway },
    InProcessKnowledgeGateway,
    { provide: KnowledgeGateway, useExisting: InProcessKnowledgeGateway },
  ],
  exports: [KnowledgeGateway, KnowledgeRetrievalGateway, KnowledgeEvaluationGateway],
})
export class KnowledgeGatewayModule {}
