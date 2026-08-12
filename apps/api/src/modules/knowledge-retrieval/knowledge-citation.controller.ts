import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
} from '@nestjs/common';
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

  @Get(':documentVersionId/chunks/:chunkId/source')
  async getSourceFile(
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Param('chunkId', new ParseUUIDPipe()) chunkId: string,
    @Query(new SchemaValidationPipe(knowledgeCitationOriginalQuerySchema))
    query: KnowledgeCitationOriginalQuery,
  ): Promise<StreamableFile> {
    const source = await this.citations.getSourceFile(query.messageId, documentVersionId, chunkId);
    return new StreamableFile(source.body, {
      type: source.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(source.fileName)}`,
      length: source.size,
    });
  }
}
