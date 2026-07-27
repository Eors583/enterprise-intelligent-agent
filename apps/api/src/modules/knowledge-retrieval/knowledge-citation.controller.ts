import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import type { KnowledgeCitationDetail } from '@enterprise/contracts';

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
  ): Promise<KnowledgeCitationDetail> {
    return this.citations.getOriginal(documentVersionId, chunkId);
  }
}
