import { Inject, Injectable } from '@nestjs/common';

import { KnowledgeRetrievalService } from '../knowledge-retrieval/knowledge-retrieval.service.js';
import { KnowledgeBoundaryReadService } from './knowledge-boundary-read.service.js';
import { KnowledgeRetrievalGateway, type KnowledgeSearchInput } from './knowledge-gateway.port.js';

/** Singleton-safe local retrieval adapter. */
@Injectable()
export class InProcessKnowledgeRetrievalGateway extends KnowledgeRetrievalGateway {
  constructor(
    @Inject(KnowledgeRetrievalService) private readonly retrieval: KnowledgeRetrievalService,
    @Inject(KnowledgeBoundaryReadService)
    private readonly boundaryReads: KnowledgeBoundaryReadService,
  ) {
    super();
  }

  search(input: KnowledgeSearchInput) {
    return this.retrieval.search(input);
  }

  resolveAccessibleKnowledgeBaseIds(
    input: Parameters<KnowledgeRetrievalGateway['resolveAccessibleKnowledgeBaseIds']>[0],
  ) {
    return this.retrieval.resolveAccessibleKnowledgeBaseIds(input);
  }

  areChunksAccessible(input: Parameters<KnowledgeRetrievalGateway['areChunksAccessible']>[0]) {
    return this.retrieval.areChunksAccessible(input);
  }

  readOperationalSummary(
    input: Parameters<KnowledgeRetrievalGateway['readOperationalSummary']>[0],
  ) {
    return this.boundaryReads.readOperationalSummary(input);
  }

  requireActiveKnowledgeBase(
    input: Parameters<KnowledgeRetrievalGateway['requireActiveKnowledgeBase']>[0],
  ) {
    return this.boundaryReads.requireActiveKnowledgeBase(input);
  }

  validateKnowledgeBaseSelection(
    input: Parameters<KnowledgeRetrievalGateway['validateKnowledgeBaseSelection']>[0],
  ) {
    return this.boundaryReads.validateKnowledgeBaseSelection(input);
  }

  countOrgUnitBindings(input: Parameters<KnowledgeRetrievalGateway['countOrgUnitBindings']>[0]) {
    return this.boundaryReads.countOrgUnitBindings(input);
  }

  findDocumentVersionByChangeSummary(
    input: Parameters<KnowledgeRetrievalGateway['findDocumentVersionByChangeSummary']>[0],
  ) {
    return this.boundaryReads.findDocumentVersionByChangeSummary(input);
  }

  readDocumentMaterialization(
    input: Parameters<KnowledgeRetrievalGateway['readDocumentMaterialization']>[0],
  ) {
    return this.boundaryReads.readDocumentMaterialization(input);
  }

  captureEvaluationSnapshot(
    input: Parameters<KnowledgeRetrievalGateway['captureEvaluationSnapshot']>[0],
  ) {
    return this.boundaryReads.captureEvaluationSnapshot(input);
  }

  readEvaluationCorpus(input: Parameters<KnowledgeRetrievalGateway['readEvaluationCorpus']>[0]) {
    return this.boundaryReads.readEvaluationCorpus(input);
  }
}
