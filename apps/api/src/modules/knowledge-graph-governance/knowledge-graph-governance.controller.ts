import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  createKnowledgeGraphConflictRequestSchema,
  createKnowledgeGraphCorrectionRequestSchema,
  createKnowledgeOntologyRequestSchema,
  createKnowledgeOntologyVersionRequestSchema,
  transitionKnowledgeGraphCorrectionRequestSchema,
  transitionKnowledgeGraphCorrectionBatchRequestSchema,
  transitionKnowledgeOntologyVersionRequestSchema,
  type CreateKnowledgeGraphConflictRequest,
  type CreateKnowledgeGraphCorrectionRequest,
  type CreateKnowledgeOntologyRequest,
  type CreateKnowledgeOntologyVersionRequest,
  type TransitionKnowledgeGraphCorrectionRequest,
  type TransitionKnowledgeGraphCorrectionBatchRequest,
  type TransitionKnowledgeOntologyVersionRequest,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { KnowledgeGraphGovernanceService } from './knowledge-graph-governance.service.js';

@Controller('admin/knowledge-bases/:knowledgeBaseId/graph-governance')
export class KnowledgeGraphGovernanceController {
  constructor(
    @Inject(KnowledgeGraphGovernanceService)
    private readonly governance: KnowledgeGraphGovernanceService,
  ) {}

  @Get()
  overview(@Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string) {
    return this.governance.overview(knowledgeBaseId);
  }

  @Post('ontologies')
  createOntology(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(createKnowledgeOntologyRequestSchema))
    request: CreateKnowledgeOntologyRequest,
  ) {
    return this.governance.createOntology(knowledgeBaseId, request);
  }

  @Post('ontologies/:ontologyId/versions')
  createOntologyVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('ontologyId', new ParseUUIDPipe()) ontologyId: string,
    @Body(new SchemaValidationPipe(createKnowledgeOntologyVersionRequestSchema))
    request: CreateKnowledgeOntologyVersionRequest,
  ) {
    return this.governance.createOntologyVersion(knowledgeBaseId, ontologyId, request);
  }

  @Post('ontology-versions/:versionId/transitions')
  transitionOntologyVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body(new SchemaValidationPipe(transitionKnowledgeOntologyVersionRequestSchema))
    request: TransitionKnowledgeOntologyVersionRequest,
  ) {
    return this.governance.transitionOntologyVersion(knowledgeBaseId, versionId, request);
  }

  @Post('conflicts')
  createConflict(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(createKnowledgeGraphConflictRequestSchema))
    request: CreateKnowledgeGraphConflictRequest,
  ) {
    return this.governance.createConflict(knowledgeBaseId, request);
  }

  @Post('corrections')
  createCorrection(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(createKnowledgeGraphCorrectionRequestSchema))
    request: CreateKnowledgeGraphCorrectionRequest,
  ) {
    return this.governance.createCorrection(knowledgeBaseId, request);
  }

  @Post('corrections/:correctionId/transitions')
  transitionCorrection(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('correctionId', new ParseUUIDPipe()) correctionId: string,
    @Body(new SchemaValidationPipe(transitionKnowledgeGraphCorrectionRequestSchema))
    request: TransitionKnowledgeGraphCorrectionRequest,
  ) {
    return this.governance.transitionCorrection(knowledgeBaseId, correctionId, request);
  }

  @Post('relation-corrections/batch-transitions')
  transitionRelationCorrections(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(transitionKnowledgeGraphCorrectionBatchRequestSchema))
    request: TransitionKnowledgeGraphCorrectionBatchRequest,
  ) {
    return this.governance.transitionRelationCorrectionBatch(knowledgeBaseId, request);
  }
}
