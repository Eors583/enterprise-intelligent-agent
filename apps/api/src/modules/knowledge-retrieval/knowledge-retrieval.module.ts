import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { KnowledgeSemanticModule } from '../knowledge-semantic/knowledge-semantic.module.js';

import { IdentityModule } from '../identity/identity.module.js';
import { KnowledgeCitationController } from './knowledge-citation.controller.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';
import { KnowledgeRelationshipExpander } from './domain/knowledge-relationship-expander.port.js';
import { PrismaKnowledgeRelationshipExpander } from './infrastructure/prisma-knowledge-relationship.expander.js';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service.js';

@Module({
  imports: [AuthorizationModule, IdentityModule, KnowledgeSemanticModule],
  controllers: [KnowledgeCitationController],
  providers: [
    KnowledgeCitationService,
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
