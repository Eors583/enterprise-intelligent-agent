import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { KnowledgeSemanticModule } from '../knowledge-semantic/knowledge-semantic.module.js';
import { KnowledgeSearchIndexModule } from '../knowledge-search-index/knowledge-search-index.module.js';
import { KnowledgeObjectStoreModule } from '../knowledge-ingestion/infrastructure/knowledge-object-store.module.js';

import { IdentityModule } from '../identity/identity.module.js';
import { KnowledgeCitationController } from './knowledge-citation.controller.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';
import { KnowledgeRelationshipExpander } from './domain/knowledge-relationship-expander.port.js';
import { PrismaKnowledgeRelationshipExpander } from './infrastructure/prisma-knowledge-relationship.expander.js';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service.js';
import { KnowledgeStructuredQueryService } from './knowledge-structured-query.service.js';

@Module({
  imports: [
    AuthorizationModule,
    IdentityModule,
    KnowledgeSemanticModule,
    KnowledgeSearchIndexModule,
    KnowledgeObjectStoreModule,
  ],
  controllers: [KnowledgeCitationController],
  providers: [
    KnowledgeCitationService,
    KnowledgeStructuredQueryService,
    PrismaKnowledgeRelationshipExpander,
    {
      provide: KnowledgeRelationshipExpander,
      useExisting: PrismaKnowledgeRelationshipExpander,
    },
    KnowledgeRetrievalService,
  ],
  exports: [KnowledgeCitationService, KnowledgeRetrievalService],
})
export class KnowledgeRetrievalModule {}
