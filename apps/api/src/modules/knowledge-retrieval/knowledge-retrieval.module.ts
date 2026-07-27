import { Module } from '@nestjs/common';

import { KnowledgeSemanticModule } from '../knowledge-semantic/knowledge-semantic.module.js';

import { IdentityModule } from '../identity/identity.module.js';
import { KnowledgeCitationController } from './knowledge-citation.controller.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service.js';

@Module({
  imports: [IdentityModule, KnowledgeSemanticModule],
  controllers: [KnowledgeCitationController],
  providers: [KnowledgeCitationService, KnowledgeRetrievalService],
  exports: [KnowledgeCitationService, KnowledgeRetrievalService],
})
export class KnowledgeRetrievalModule {}
