import { Inject, Injectable } from '@nestjs/common';

import { KnowledgeIngestionService } from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeIngestionProcessor } from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import {
  KnowledgeGateway,
  KnowledgeRetrievalGateway,
  type KnowledgeSearchInput,
} from './knowledge-gateway.port.js';

@Injectable()
export class InProcessKnowledgeGateway extends KnowledgeGateway {
  constructor(
    @Inject(KnowledgeIngestionService) private readonly ingestion: KnowledgeIngestionService,
    @Inject(KnowledgeIngestionProcessor) private readonly processor: KnowledgeIngestionProcessor,
    @Inject(KnowledgeRetrievalGateway)
    private readonly retrieval: KnowledgeRetrievalGateway,
  ) {
    super();
  }

  search(input: KnowledgeSearchInput) {
    return this.retrieval.search(input);
  }

  resolveAccessibleKnowledgeBaseIds(
    input: Parameters<KnowledgeGateway['resolveAccessibleKnowledgeBaseIds']>[0],
  ) {
    return this.retrieval.resolveAccessibleKnowledgeBaseIds(input);
  }

  areChunksAccessible(input: Parameters<KnowledgeGateway['areChunksAccessible']>[0]) {
    return this.retrieval.areChunksAccessible(input);
  }

  readOperationalSummary(input: Parameters<KnowledgeGateway['readOperationalSummary']>[0]) {
    return this.retrieval.readOperationalSummary(input);
  }

  requireActiveKnowledgeBase(input: Parameters<KnowledgeGateway['requireActiveKnowledgeBase']>[0]) {
    return this.retrieval.requireActiveKnowledgeBase(input);
  }

  validateKnowledgeBaseSelection(
    input: Parameters<KnowledgeGateway['validateKnowledgeBaseSelection']>[0],
  ) {
    return this.retrieval.validateKnowledgeBaseSelection(input);
  }

  countOrgUnitBindings(input: Parameters<KnowledgeGateway['countOrgUnitBindings']>[0]) {
    return this.retrieval.countOrgUnitBindings(input);
  }

  findDocumentVersionByChangeSummary(
    input: Parameters<KnowledgeGateway['findDocumentVersionByChangeSummary']>[0],
  ) {
    return this.retrieval.findDocumentVersionByChangeSummary(input);
  }

  readDocumentMaterialization(
    input: Parameters<KnowledgeGateway['readDocumentMaterialization']>[0],
  ) {
    return this.retrieval.readDocumentMaterialization(input);
  }

  captureEvaluationSnapshot(input: Parameters<KnowledgeGateway['captureEvaluationSnapshot']>[0]) {
    return this.retrieval.captureEvaluationSnapshot(input);
  }

  readEvaluationCorpus(input: Parameters<KnowledgeGateway['readEvaluationCorpus']>[0]) {
    return this.retrieval.readEvaluationCorpus(input);
  }

  createTextVersionAs(input: Parameters<KnowledgeGateway['createTextVersionAs']>[0]) {
    return this.processor.createTextVersion(input.principal, input.document);
  }

  createTextVersion(input: Parameters<KnowledgeGateway['createTextVersion']>[0]) {
    return this.ingestion.createTextVersion(input);
  }

  upload(input: Parameters<KnowledgeGateway['upload']>[0]) {
    return this.ingestion.upload(input);
  }

  uploadFileVersion(input: Parameters<KnowledgeGateway['uploadFileVersion']>[0]) {
    return this.ingestion.uploadFileVersion(input);
  }

  importWeb(input: Parameters<KnowledgeGateway['importWeb']>[0]) {
    return this.ingestion.importWeb(input);
  }

  retry(documentVersionId: string) {
    return this.ingestion.retry(documentVersionId);
  }

  rebuildEmbeddings(input: Parameters<KnowledgeGateway['rebuildEmbeddings']>[0]) {
    return this.ingestion.rebuildEmbeddings(input);
  }

  rebuildKnowledgeGraph(input: Parameters<KnowledgeGateway['rebuildKnowledgeGraph']>[0]) {
    return this.ingestion.rebuildKnowledgeGraph(input);
  }

  syncSearchDocumentVersion(input: Parameters<KnowledgeGateway['syncSearchDocumentVersion']>[0]) {
    return this.ingestion.syncSearchDocumentVersion(input);
  }

  archiveSearchDocument(input: Parameters<KnowledgeGateway['archiveSearchDocument']>[0]) {
    return this.ingestion.archiveSearchDocument(input);
  }

  readStructuredDocumentPreview(
    input: Parameters<KnowledgeGateway['readStructuredDocumentPreview']>[0],
  ) {
    return this.ingestion.readStructuredDocumentPreview(input);
  }

  readSourceDocument(input: Parameters<KnowledgeGateway['readSourceDocument']>[0]) {
    return this.ingestion.readSourceDocument(input);
  }
}
