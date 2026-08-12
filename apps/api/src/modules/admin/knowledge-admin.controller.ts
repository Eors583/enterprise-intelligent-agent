import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  createKnowledgeBaseRequestSchema,
  createKnowledgeEmbeddingIndexVersionRequestSchema,
  createKnowledgeDocumentRequestSchema,
  ensureKnowledgeFoldersRequestSchema,
  knowledgeDocumentGovernancePolicySchema,
  inspectKnowledgeUploadRequestSchema,
  type CreateKnowledgeBaseRequest,
  type CreateKnowledgeEmbeddingIndexVersionRequest,
  type CreateKnowledgeDocumentRequest,
  type KnowledgeBase,
  type KnowledgeBaseIndexReadiness,
  type KnowledgeBaseListResponse,
  type KnowledgeDocument,
  type EnsureKnowledgeFoldersRequest,
  type KnowledgeFolderListResponse,
  type KnowledgeDocumentChunkListResponse,
  type KnowledgeDocumentGovernancePolicy,
  type KnowledgeDocumentVersionDetail,
  type InspectKnowledgeUploadRequest,
  type KnowledgeUploadInspection,
  type KnowledgeParseReviewQueueResponse,
  type KnowledgeEmbeddingRebuildResponse,
  type KnowledgeEmbeddingIndexVersion,
  type KnowledgeEmbeddingIndexVersionListResponse,
  type KnowledgeGraphOverview,
  type KnowledgeGraphQuery,
  type KnowledgeGraphRebuildResponse,
  type KnowledgeGraphResponse,
  type KnowledgeStructuredDocumentPreview,
  type PublishKnowledgeDocumentVersionRequest,
  type KnowledgeRetrievalTestRequest,
  type KnowledgeRetrievalTestResponse,
  type RollbackKnowledgeDocumentVersionRequest,
  type ImportKnowledgeWebDocumentRequest,
  type ReviewKnowledgeDocumentParseRequest,
  type ReviewKnowledgeDocumentGovernanceRequest,
  type UpdateKnowledgeDocumentVersionGovernanceRequest,
  type UpdateKnowledgeDocumentAccessRequest,
  type UpdateKnowledgeBaseRequest,
  type UpdateKnowledgeDocumentRequest,
  knowledgeRetrievalTestRequestSchema,
  importKnowledgeWebDocumentRequestSchema,
  publishKnowledgeDocumentVersionRequestSchema,
  knowledgeGraphQuerySchema,
  rollbackKnowledgeDocumentVersionRequestSchema,
  reviewKnowledgeDocumentParseRequestSchema,
  reviewKnowledgeDocumentGovernanceRequestSchema,
  updateKnowledgeDocumentVersionGovernanceRequestSchema,
  updateKnowledgeDocumentAccessRequestSchema,
  updateKnowledgeBaseRequestSchema,
  updateKnowledgeDocumentRequestSchema,
  createKnowledgeSourceConnectorRequestSchema,
  updateKnowledgeSourceConnectorRequestSchema,
  type CreateKnowledgeSourceConnectorRequest,
  type UpdateKnowledgeSourceConnectorRequest,
  type KnowledgeSourceConnector,
  type KnowledgeSourceConnectorListResponse,
  type KnowledgeSourceSyncRun,
} from '@enterprise/contracts';

import { SchemaValidationPipe } from '../../common/pipes/schema-validation.pipe.js';
import { KnowledgeAdminService } from './knowledge-admin.service.js';
import { KnowledgeSourceSyncService } from './knowledge-source-sync.service.js';

// object_size is a signed 32-bit integer; this is an infrastructure ceiling,
// not a product upload quota.
const MAXIMUM_UPLOAD_BYTES = 2_147_483_647;
const NON_LATIN1_CHARACTER = /[^\u0000-\u00ff]/u;
const UNSAFE_RECOVERED_FILENAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

interface UploadedKnowledgeFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface KnowledgeUploadBody {
  readonly title?: unknown;
  readonly changeSummary?: unknown;
  readonly governance?: unknown;
  readonly folderId?: unknown;
}

@Controller('admin/knowledge-bases')
export class KnowledgeAdminController {
  constructor(
    @Inject(KnowledgeAdminService) private readonly knowledge: KnowledgeAdminService,
    @Inject(KnowledgeSourceSyncService) private readonly sources: KnowledgeSourceSyncService,
  ) {}

  @Get()
  list(): Promise<KnowledgeBaseListResponse> {
    return this.knowledge.list();
  }

  @Post()
  create(
    @Body(new SchemaValidationPipe(createKnowledgeBaseRequestSchema))
    request: CreateKnowledgeBaseRequest,
  ): Promise<KnowledgeBase> {
    return this.knowledge.create(request);
  }

  @Get(':knowledgeBaseId/readiness')
  readiness(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
  ): Promise<KnowledgeBaseIndexReadiness> {
    return this.knowledge.readiness(knowledgeBaseId);
  }

  @Get(':knowledgeBaseId/graph-overview')
  graphOverview(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
  ): Promise<KnowledgeGraphOverview> {
    return this.knowledge.graphOverview(knowledgeBaseId);
  }

  @Get(':knowledgeBaseId/graph')
  graph(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Query(new SchemaValidationPipe(knowledgeGraphQuerySchema)) request: KnowledgeGraphQuery,
  ): Promise<KnowledgeGraphResponse> {
    return this.knowledge.graph(knowledgeBaseId, request);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new SchemaValidationPipe(updateKnowledgeBaseRequestSchema))
    request: UpdateKnowledgeBaseRequest,
  ): Promise<KnowledgeBase> {
    return this.knowledge.update(id, request);
  }

  @Get(':knowledgeBaseId/embedding-index-versions')
  listEmbeddingIndexVersions(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
  ): Promise<KnowledgeEmbeddingIndexVersionListResponse> {
    return this.knowledge.listEmbeddingIndexVersions(knowledgeBaseId);
  }

  @Post(':knowledgeBaseId/embedding-index-versions')
  createEmbeddingIndexVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(createKnowledgeEmbeddingIndexVersionRequestSchema))
    request: CreateKnowledgeEmbeddingIndexVersionRequest,
  ): Promise<KnowledgeEmbeddingIndexVersion> {
    return this.knowledge.createEmbeddingIndexVersion(knowledgeBaseId, request);
  }

  @Post(':knowledgeBaseId/embedding-index-versions/:embeddingIndexVersionId/activate')
  activateEmbeddingIndexVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('embeddingIndexVersionId', new ParseUUIDPipe()) embeddingIndexVersionId: string,
  ): Promise<KnowledgeBase> {
    return this.knowledge.activateEmbeddingIndexVersion(knowledgeBaseId, embeddingIndexVersionId);
  }

  @Post(':knowledgeBaseId/documents')
  createDocument(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(createKnowledgeDocumentRequestSchema))
    request: CreateKnowledgeDocumentRequest,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.createDocument(knowledgeBaseId, request);
  }

  @Post(':knowledgeBaseId/folders/ensure')
  ensureFolders(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(ensureKnowledgeFoldersRequestSchema))
    request: EnsureKnowledgeFoldersRequest,
  ): Promise<KnowledgeFolderListResponse> {
    return this.knowledge.ensureFolders(knowledgeBaseId, request);
  }

  @Post(':knowledgeBaseId/documents/import-web')
  importWebDocument(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(importKnowledgeWebDocumentRequestSchema))
    request: ImportKnowledgeWebDocumentRequest,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.importWebDocument(knowledgeBaseId, request);
  }

  @Get(':knowledgeBaseId/source-connectors')
  listSourceConnectors(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
  ): Promise<KnowledgeSourceConnectorListResponse> {
    return this.sources.list(knowledgeBaseId);
  }

  @Post(':knowledgeBaseId/source-connectors')
  createSourceConnector(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(createKnowledgeSourceConnectorRequestSchema))
    request: CreateKnowledgeSourceConnectorRequest,
  ): Promise<KnowledgeSourceConnector> {
    return this.sources.create(knowledgeBaseId, request);
  }

  @Patch(':knowledgeBaseId/source-connectors/:connectorId')
  updateSourceConnector(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Body(new SchemaValidationPipe(updateKnowledgeSourceConnectorRequestSchema))
    request: UpdateKnowledgeSourceConnectorRequest,
  ): Promise<KnowledgeSourceConnector> {
    return this.sources.update(knowledgeBaseId, connectorId, request);
  }

  @Post(':knowledgeBaseId/source-connectors/:connectorId/sync')
  syncSourceConnector(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
  ): Promise<KnowledgeSourceSyncRun> {
    return this.sources.sync(knowledgeBaseId, connectorId);
  }

  @Get(':knowledgeBaseId/parse-review-queue')
  listPendingParseReviews(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
  ): Promise<KnowledgeParseReviewQueueResponse> {
    return this.knowledge.listPendingParseReviews(knowledgeBaseId);
  }

  @Get(':knowledgeBaseId/documents/:documentId')
  getDocument(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.getDocument(knowledgeBaseId, documentId);
  }

  @Get(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId')
  getDocumentVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
  ): Promise<KnowledgeDocumentVersionDetail> {
    return this.knowledge.getDocumentVersion(knowledgeBaseId, documentId, documentVersionId);
  }

  @Get(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/chunks')
  listDocumentVersionChunks(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Query('offset', new DefaultValuePipe(0), new ParseIntPipe()) offset: number,
    @Query('limit', new DefaultValuePipe(50), new ParseIntPipe()) limit: number,
  ): Promise<KnowledgeDocumentChunkListResponse> {
    return this.knowledge.listDocumentVersionChunks(
      knowledgeBaseId,
      documentId,
      documentVersionId,
      offset,
      limit,
    );
  }

  @Get(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/structured')
  getStructuredDocumentPreview(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
  ): Promise<KnowledgeStructuredDocumentPreview> {
    return this.knowledge.getStructuredDocumentPreview(
      knowledgeBaseId,
      documentId,
      documentVersionId,
    );
  }

  @Get(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/source')
  async getDocumentVersionSource(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
  ): Promise<StreamableFile> {
    const source = await this.knowledge.getDocumentVersionSource(
      knowledgeBaseId,
      documentId,
      documentVersionId,
    );
    return new StreamableFile(source.body, {
      type: source.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(source.fileName)}`,
      length: source.size,
    });
  }

  @Post(':knowledgeBaseId/documents/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAXIMUM_UPLOAD_BYTES, files: 1 },
    }),
  )
  uploadDocument(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @UploadedFile() file: UploadedKnowledgeFile | undefined,
    @Body() body: KnowledgeUploadBody,
  ): Promise<KnowledgeDocument> {
    const uploadedFile = requireUploadedKnowledgeFile(file);
    const metadata = parseUploadMetadata(body, uploadedFile.originalname);
    return this.knowledge.uploadDocument(knowledgeBaseId, {
      ...metadata,
      bytes: uploadedFile.buffer,
      mimeType: resolveUploadMimeType(uploadedFile.mimetype, uploadedFile.originalname),
      fileName: uploadedFile.originalname,
    });
  }

  @Post(':knowledgeBaseId/documents/upload-inspection')
  inspectUpload(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(inspectKnowledgeUploadRequestSchema))
    request: InspectKnowledgeUploadRequest,
  ): Promise<KnowledgeUploadInspection> {
    return this.knowledge.inspectUpload(knowledgeBaseId, request);
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAXIMUM_UPLOAD_BYTES, files: 1 },
    }),
  )
  uploadDocumentVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @UploadedFile() file: UploadedKnowledgeFile | undefined,
    @Body() body: KnowledgeUploadBody,
  ): Promise<KnowledgeDocument> {
    const uploadedFile = requireUploadedKnowledgeFile(file);
    return this.knowledge.uploadDocumentVersion(knowledgeBaseId, documentId, {
      ...parseVersionUploadMetadata(body),
      bytes: uploadedFile.buffer,
      mimeType: resolveUploadMimeType(uploadedFile.mimetype, uploadedFile.originalname),
      fileName: uploadedFile.originalname,
    });
  }

  @Patch(':knowledgeBaseId/documents/:documentId')
  updateDocument(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new SchemaValidationPipe(updateKnowledgeDocumentRequestSchema))
    request: UpdateKnowledgeDocumentRequest,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.updateDocument(knowledgeBaseId, documentId, request);
  }

  @Patch(':knowledgeBaseId/documents/:documentId/access')
  updateDocumentAccess(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new SchemaValidationPipe(updateKnowledgeDocumentAccessRequestSchema))
    request: UpdateKnowledgeDocumentAccessRequest,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.updateDocumentAccess(knowledgeBaseId, documentId, request);
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/retry')
  retryDocumentVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.retryDocumentVersion(knowledgeBaseId, documentId, documentVersionId);
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/parse-review')
  reviewDocumentVersionParse(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Body(new SchemaValidationPipe(reviewKnowledgeDocumentParseRequestSchema))
    request: ReviewKnowledgeDocumentParseRequest,
  ): Promise<KnowledgeDocumentVersionDetail> {
    return this.knowledge.reviewDocumentVersionParse(
      knowledgeBaseId,
      documentId,
      documentVersionId,
      request,
    );
  }

  @Patch(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/governance')
  updateDocumentVersionGovernance(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Body(new SchemaValidationPipe(updateKnowledgeDocumentVersionGovernanceRequestSchema))
    request: UpdateKnowledgeDocumentVersionGovernanceRequest,
  ): Promise<KnowledgeDocumentVersionDetail> {
    return this.knowledge.updateDocumentVersionGovernance(
      knowledgeBaseId,
      documentId,
      documentVersionId,
      request,
    );
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/governance-review')
  reviewDocumentVersionGovernance(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Body(new SchemaValidationPipe(reviewKnowledgeDocumentGovernanceRequestSchema))
    request: ReviewKnowledgeDocumentGovernanceRequest,
  ): Promise<KnowledgeDocumentVersionDetail> {
    return this.knowledge.reviewDocumentVersionGovernance(
      knowledgeBaseId,
      documentId,
      documentVersionId,
      request,
    );
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/publish')
  publishDocumentVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Body(new SchemaValidationPipe(publishKnowledgeDocumentVersionRequestSchema))
    request: PublishKnowledgeDocumentVersionRequest,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.publishDocumentVersion(
      knowledgeBaseId,
      documentId,
      documentVersionId,
      request,
    );
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/rollback')
  rollbackDocumentVersion(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
    @Body(new SchemaValidationPipe(rollbackKnowledgeDocumentVersionRequestSchema))
    request: RollbackKnowledgeDocumentVersionRequest,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.rollbackDocumentVersion(
      knowledgeBaseId,
      documentId,
      documentVersionId,
      request,
    );
  }

  @Post(':knowledgeBaseId/retrieval-test')
  testRetrieval(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Body(new SchemaValidationPipe(knowledgeRetrievalTestRequestSchema))
    request: KnowledgeRetrievalTestRequest,
  ): Promise<KnowledgeRetrievalTestResponse> {
    return this.knowledge.testRetrieval(knowledgeBaseId, request);
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/rebuild-embeddings')
  rebuildDocumentVersionEmbeddings(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
  ): Promise<KnowledgeEmbeddingRebuildResponse> {
    return this.knowledge.rebuildDocumentVersionEmbeddings(
      knowledgeBaseId,
      documentId,
      documentVersionId,
    );
  }

  @Post(':knowledgeBaseId/documents/:documentId/versions/:documentVersionId/rebuild-graph')
  rebuildDocumentVersionGraph(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('documentVersionId', new ParseUUIDPipe()) documentVersionId: string,
  ): Promise<KnowledgeGraphRebuildResponse> {
    return this.knowledge.rebuildDocumentVersionGraph(
      knowledgeBaseId,
      documentId,
      documentVersionId,
    );
  }

  @Delete(':knowledgeBaseId/documents/:documentId')
  archiveDocument(
    @Param('knowledgeBaseId', new ParseUUIDPipe()) knowledgeBaseId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Query('expectedVersion', new ParseIntPipe()) expectedVersion: number,
  ): Promise<KnowledgeDocument> {
    return this.knowledge.archiveDocument(knowledgeBaseId, documentId, expectedVersion);
  }
}

function parseUploadMetadata(
  body: KnowledgeUploadBody,
  fileName: string,
): {
  title: string;
  folderId?: string | null;
  changeSummary?: string;
  governance?: KnowledgeDocumentGovernancePolicy;
} {
  const fallbackTitle = fileName.replace(/\.[^.]+$/u, '').trim();
  const title = typeof body.title === 'string' ? body.title.trim() : fallbackTitle;
  if (title.length < 1 || title.length > 300) {
    throw new BadRequestException('title must contain between 1 and 300 characters.');
  }
  const folderId = parseUploadFolderId(body.folderId);
  return {
    title,
    ...(folderId === undefined ? {} : { folderId }),
    ...parseVersionUploadMetadata(body),
  };
}

function parseUploadFolderId(value: unknown): string | null | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === null || value === 'null') return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new BadRequestException('folderId must be a UUID or null.');
  }
  return value;
}

function parseVersionUploadMetadata(body: KnowledgeUploadBody): {
  changeSummary?: string;
  governance?: KnowledgeDocumentGovernancePolicy;
} {
  const result: {
    changeSummary?: string;
    governance?: KnowledgeDocumentGovernancePolicy;
  } = {};
  if (body.changeSummary !== undefined && body.changeSummary !== '') {
    if (typeof body.changeSummary !== 'string') {
      throw new BadRequestException('changeSummary must be text.');
    }
    const changeSummary = body.changeSummary.trim();
    if (changeSummary.length > 500) {
      throw new BadRequestException('changeSummary must not exceed 500 characters.');
    }
    if (changeSummary.length > 0) result.changeSummary = changeSummary;
  }
  if (body.governance !== undefined && body.governance !== '') {
    let candidate: unknown = body.governance;
    if (typeof candidate === 'string') {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        throw new BadRequestException('governance must be valid JSON.');
      }
    }
    const parsed = knowledgeDocumentGovernancePolicySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'governance contains invalid policy fields.',
        issues: parsed.error.issues,
      });
    }
    result.governance = parsed.data;
  }
  return result;
}

function requireUploadedKnowledgeFile(
  file: UploadedKnowledgeFile | undefined,
): UploadedKnowledgeFile {
  if (file === undefined) {
    throw new BadRequestException('A document file is required.');
  }
  if (file.size === 0 || file.buffer.byteLength === 0) {
    throw new BadRequestException('The document file must not be empty.');
  }
  const originalname = normalizeMulterOriginalName(file.originalname);
  if (originalname.trim().length < 1 || originalname.length > 300) {
    throw new BadRequestException('The filename must contain between 1 and 300 characters.');
  }
  return originalname === file.originalname ? file : { ...file, originalname };
}

/**
 * Busboy/Multer can expose a UTF-8 multipart filename as if its header bytes
 * were Latin-1. Recovery is deliberately conservative because an arbitrary
 * Latin-1 filename is otherwise indistinguishable from mojibake.
 */
function normalizeMulterOriginalName(originalname: string): string {
  const characters = Array.from(originalname);
  if (
    characters.length === 0 ||
    !characters.some((character) => (character.codePointAt(0) ?? 0) >= 0x80) ||
    characters.some((character) => (character.codePointAt(0) ?? 0) > 0xff)
  ) {
    return originalname;
  }

  const sourceBytes = Buffer.from(originalname, 'latin1');
  let recovered: string;
  try {
    recovered = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch {
    return originalname;
  }

  if (
    recovered === originalname ||
    !NON_LATIN1_CHARACTER.test(recovered) ||
    !Buffer.from(recovered, 'utf8').equals(sourceBytes) ||
    UNSAFE_RECOVERED_FILENAME_CHARACTER.test(recovered) ||
    recovered.includes('/') ||
    recovered.includes('\\') ||
    recovered === '.' ||
    recovered === '..'
  ) {
    return originalname;
  }
  return recovered;
}

function resolveUploadMimeType(mimeType: string, fileName: string): string {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (normalizedMimeType !== '' && normalizedMimeType !== 'application/octet-stream') {
    return normalizedMimeType;
  }
  const extension = fileName.toLowerCase().match(/\.[^.]+$/u)?.[0];
  switch (extension) {
    case '.txt':
      return 'text/plain';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.ppt':
      return 'application/vnd.ms-powerpoint';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.bmp':
      return 'image/bmp';
    case '.webp':
      return 'image/webp';
    default:
      return normalizedMimeType;
  }
}
