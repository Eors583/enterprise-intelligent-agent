import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  knowledgeCitationOriginalQuerySchema,
  type KnowledgeCitationDetail,
  type KnowledgeCitationOriginalQuery,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { KnowledgeCitationService } from './knowledge-citation.service.js';

@Controller('knowledge-citations')
export class KnowledgeCitationController {
  constructor(
    @Inject(KnowledgeCitationService) private readonly citations: KnowledgeCitationService,
  ) {}

  @Get(':documentVersionId/chunks/:chunkId')
  getOriginal(
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Param('chunkId', new ParseUUIDPipe()) chunkId: string,
    @Query(new SchemaValidationPipe(knowledgeCitationOriginalQuerySchema))
    query: KnowledgeCitationOriginalQuery,
  ): Promise<KnowledgeCitationDetail> {
    return this.citations.getOriginal(query.messageId, documentVersionId, chunkId);
  }
}
