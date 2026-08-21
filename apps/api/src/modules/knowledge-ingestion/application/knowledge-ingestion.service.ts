import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { defineKnowledgePublicEvent } from '@enterprise/contracts';
import type {
  KnowledgeDocumentGovernancePolicy,
  KnowledgeGraphRebuildResponse,
  KnowledgeStructuredDocumentPreview,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../../admin/admin-access.service.js';
import { recordAdminAudit } from '../../admin/admin-audit.js';
import {
  isExternalKnowledgeAiApproved,
  knowledgeClassificationToAi,
} from '../../ai-safety-model-routing/ai-data-classification.js';
import {
  KnowledgeAiRuntimeClient,
  KnowledgeAiRuntimeError,
} from '../../knowledge-semantic/knowledge-ai-runtime.client.js';
import {
  KnowledgeSearchIndex,
  type KnowledgeSearchIndexProfile,
} from '../../knowledge-search-index/knowledge-search-index.port.js';
import {
  KNOWLEDGE_DOCUMENT_PARSER,
  type KnowledgeDocumentParser,
} from './knowledge-document-parser.port.js';
import { KnowledgeIngestionAvailabilityService } from './knowledge-ingestion-availability.service.js';
import type { ClaimedKnowledgeIngestionJob } from '../domain/knowledge-ingestion-job.repository.js';
import {
  chunkKnowledgeDocumentWithParents,
  type KnowledgeDocumentChunk,
  type KnowledgeDocumentParentChunk,
} from '../domain/knowledge-document.chunker.js';
import {
  projectKnowledgeGraph,
  type KnowledgeGraphProjection,
} from '../domain/knowledge-graph.projector.js';
import { assessKnowledgeParseQuality } from '../domain/knowledge-parse-quality.js';
import { scanKnowledgeContent } from '../domain/knowledge-content-security.js';
import {
  ControlledKnowledgeWebFetcher,
  KnowledgeWebFetchError,
} from '../infrastructure/controlled-knowledge-web-fetcher.js';
import {
  DocumentParsingError,
  PDF_PARSER_NAME,
  type ParsedKnowledgeDocument,
} from '../infrastructure/document-parser.adapter.js';
import {
  KNOWLEDGE_OBJECT_STORE,
  KnowledgeObjectConflictError,
  KnowledgeObjectIntegrityError,
  KnowledgeObjectStore,
  KnowledgeObjectTooLargeError,
  KnowledgeObjectValidationError,
  buildKnowledgeObjectKey,
  collectReadable,
  type StoredKnowledgeObject,
} from '../infrastructure/knowledge-object.store.js';
import {
  KNOWLEDGE_FILE_SCANNER,
  KnowledgeFileScanner,
} from '../infrastructure/knowledge-file-scanner.js';

const FILE_UPLOAD_RECOVERY_DELAY_MS = 5 * 60_000;
const MAX_PERSISTED_ENTITY_ALIASES = 32;
const MAX_PERSISTED_ENTITY_ALIAS_LENGTH = 160;
const STRUCTURED_KNOWLEDGE_FORMAT = 'enterprise-knowledge-document/v1';
const EMBEDDING_PERSIST_BATCH_SIZE = 64;

const embeddingIndexVersionSelect = {
  id: true,
  version: true,
  status: true,
  model: true,
  dimensions: true,
  distance: true,
  collectionName: true,
} satisfies Prisma.KnowledgeEmbeddingIndexVersionSelect;

interface EmbeddingIndexDescriptor {
  readonly id: string;
  readonly version: number;
  readonly status: 'BUILDING' | 'ACTIVE' | 'RETIRED' | 'FAILED';
  readonly model: string;
  readonly dimensions: number;
  readonly distance: string;
  readonly collectionName: string | null;
}

function embeddingProfileExpectation(index: EmbeddingIndexDescriptor) {
  return { model: index.model, dimensions: index.dimensions };
}

function knowledgeSearchIndexProfile(index: EmbeddingIndexDescriptor): KnowledgeSearchIndexProfile {
  if (index.distance !== 'COSINE') throw new Error('KNOWLEDGE_INDEX_DISTANCE_UNSUPPORTED');
  return {
    indexVersionId: index.id,
    collectionName: index.collectionName,
    dimensions: index.dimensions,
    distance: 'COSINE',
  };
}

function deploymentDefaultSearchIndexProfile(dimensions: number): KnowledgeSearchIndexProfile {
  return {
    indexVersionId: 'deployment-default',
    collectionName: null,
    dimensions,
    distance: 'COSINE',
  };
}

function requireEmbeddingIndex(index: EmbeddingIndexDescriptor | null): EmbeddingIndexDescriptor {
  if (index === null) throw new Error('KNOWLEDGE_EMBEDDING_INDEX_UNCONFIGURED');
  return index;
}

interface IngestionIdentity {
  readonly tenantId: string;
  readonly knowledgeBaseId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly title: string;
  readonly jobId: string | null;
  readonly versionNumber: number;
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
  readonly classification: string;
  readonly governanceHash: string;
  readonly mimeType: string;
  readonly fileName: string | null;
  readonly actorUserId: string;
}

interface IngestionSource {
  readonly identity: IngestionIdentity;
  readonly objectKey: string | null;
  readonly objectSize: number | null;
  readonly objectSha256: string | null;
  readonly contentText: string | null;
}

export interface KnowledgeIngestionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface KnowledgeIngestionLeaseControl {
  readonly signal: AbortSignal;
  readonly assertOwned: () => Promise<void>;
}

export class KnowledgeIngestionLeaseLostError extends Error {
  constructor() {
    super('KNOWLEDGE_INGESTION_LEASE_LOST');
    this.name = 'KnowledgeIngestionLeaseLostError';
  }
}

class KnowledgeFileSecurityError extends Error {
  constructor(
    readonly code: 'KNOWLEDGE_FILE_INFECTED' | 'KNOWLEDGE_FILE_SCAN_UNAVAILABLE',
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'KnowledgeFileSecurityError';
  }
}

export interface KnowledgeEmbeddingRebuildResult {
  readonly documentVersionId: string;
  readonly embeddingIndexVersionId: string;
  readonly embeddingIndexVersion: number;
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly chunkCount: number;
}

export interface KnowledgeSourceDocument {
  readonly body: Readable;
  readonly size: number;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface KnowledgeGraphPersistenceIdentity {
  readonly tenantId: string;
  readonly knowledgeBaseId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly actorUserId: string;
}

export type KnowledgeGraphRebuildResult = KnowledgeGraphRebuildResponse;

/**
 * Request-scoped command facade. It is intentionally the only ingestion
 * provider that depends on AdminAccessService/TenantContext.
 */
@Injectable()
export class KnowledgeIngestionService {
  constructor(
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(forwardRef(() => KnowledgeIngestionProcessor))
    private readonly processor: Pick<
      KnowledgeIngestionProcessor,
      | 'createTextVersion'
      | 'upload'
      | 'importWeb'
      | 'uploadFileVersion'
      | 'retry'
      | 'rebuildEmbeddings'
      | 'rebuildKnowledgeGraph'
      | 'syncSearchDocumentVersion'
      | 'archiveSearchDocument'
      | 'readStructuredDocumentPreview'
      | 'readSourceDocument'
    >,
  ) {}

  createTextVersion(input: {
    readonly knowledgeBaseId: string;
    readonly documentId?: string;
    readonly title: string;
    readonly sourceType: 'TEXT' | 'MARKDOWN';
    readonly content: string;
    readonly publish: boolean;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string> {
    return this.processor.createTextVersion(this.access.requireKnowledgeWrite(), input);
  }

  upload(input: {
    readonly knowledgeBaseId: string;
    readonly folderId?: string | null;
    readonly title: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly fileName: string;
    readonly sourceUri?: string;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string> {
    return this.processor.upload(this.access.requireKnowledgeWrite(), input);
  }

  uploadFileVersion(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly title: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly fileName: string;
    readonly sourceUri?: string;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string> {
    return this.processor.uploadFileVersion(this.access.requireKnowledgeWrite(), input);
  }

  importWeb(input: {
    readonly knowledgeBaseId: string;
    readonly sourceUri: string;
    readonly title?: string;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<string> {
    return this.processor.importWeb(this.access.requireKnowledgeWrite(), input);
  }

  retry(documentVersionId: string): Promise<string> {
    return this.processor.retry(this.access.requireKnowledgeWrite(), documentVersionId);
  }

  rebuildEmbeddings(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly embeddingIndexVersionId?: string;
  }): Promise<KnowledgeEmbeddingRebuildResult> {
    return this.processor.rebuildEmbeddings(this.access.requireKnowledgeWrite(), input);
  }

  rebuildKnowledgeGraph(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeGraphRebuildResult> {
    return this.processor.rebuildKnowledgeGraph(this.access.requireKnowledgeWrite(), input);
  }

  syncSearchDocumentVersion(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly active: boolean;
    readonly embeddingIndexVersionId?: string;
  }): Promise<void> {
    return this.processor.syncSearchDocumentVersion(this.access.requireKnowledgeWrite(), input);
  }

  archiveSearchDocument(input: { readonly documentId: string }): Promise<void> {
    return this.processor.archiveSearchDocument(this.access.requireKnowledgeWrite(), input);
  }

  readStructuredDocumentPreview(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeStructuredDocumentPreview> {
    return this.processor.readStructuredDocumentPreview(this.access.requireKnowledgeWrite(), input);
  }

  readSourceDocument(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeSourceDocument> {
    return this.processor.readSourceDocument(this.access.requireKnowledgeWrite(), input);
  }
}

@Injectable()
export class KnowledgeIngestionProcessor {
  private readonly logger = new Logger(KnowledgeIngestionProcessor.name);

  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(KNOWLEDGE_DOCUMENT_PARSER) private readonly parser: KnowledgeDocumentParser,
    @Inject(KNOWLEDGE_OBJECT_STORE) private readonly objects: KnowledgeObjectStore,
    @Inject(KNOWLEDGE_FILE_SCANNER) private readonly scanner: KnowledgeFileScanner,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
    @Inject(KnowledgeSearchIndex) private readonly searchIndex: KnowledgeSearchIndex,
    @Inject(ControlledKnowledgeWebFetcher)
    private readonly webFetcher: ControlledKnowledgeWebFetcher,
    @Inject(KnowledgeIngestionAvailabilityService)
    private readonly availability: KnowledgeIngestionAvailabilityService,
  ) {}

  async createTextVersion(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId?: string;
      readonly title: string;
      readonly sourceType: 'TEXT' | 'MARKDOWN';
      readonly content: string;
      readonly publish: boolean;
      readonly changeSummary?: string;
      readonly governance?: KnowledgeDocumentGovernancePolicy;
    },
  ): Promise<string> {
    this.availability.assertPersistentWritesAvailable();
    const identity = await this.createVersionRecord({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      knowledgeBaseId: input.knowledgeBaseId,
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      title: input.title,
      sourceType: input.sourceType,
      contentText: input.content,
      mimeType: input.sourceType === 'MARKDOWN' ? 'text/markdown' : 'text/plain',
      fileName: null,
      processing: input.publish,
      enqueue: input.publish,
      ...(input.governance === undefined ? {} : { governance: input.governance }),
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
    });
    return identity.documentId;
  }

  async upload(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly folderId?: string | null;
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly sourceUri?: string;
      readonly changeSummary?: string;
      readonly governance?: KnowledgeDocumentGovernancePolicy;
    },
  ): Promise<string> {
    this.availability.assertPersistentWritesAvailable();
    return this.uploadFile(principal, input);
  }

  async uploadFileVersion(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly sourceUri?: string;
      readonly changeSummary?: string;
      readonly governance?: KnowledgeDocumentGovernancePolicy;
    },
  ): Promise<string> {
    this.availability.assertPersistentWritesAvailable();
    return this.uploadFile(principal, input);
  }

  async importWeb(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly sourceUri: string;
      readonly title?: string;
      readonly changeSummary?: string;
      readonly governance?: KnowledgeDocumentGovernancePolicy;
    },
  ): Promise<string> {
    this.availability.assertPersistentWritesAvailable();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: principal.tenantId, id: input.knowledgeBaseId },
        select: { status: true },
      });
      if (knowledgeBase === null || knowledgeBase.status === 'ARCHIVED') {
        throw new NotFoundException('The active knowledge base was not found.');
      }
    });
    let page;
    try {
      page = await this.webFetcher.fetch(input.sourceUri);
    } catch (error) {
      if (error instanceof KnowledgeWebFetchError) {
        if (
          error.code === 'KNOWLEDGE_WEB_URL_INVALID' ||
          error.code === 'KNOWLEDGE_WEB_HOST_NOT_ALLOWED' ||
          error.code === 'KNOWLEDGE_WEB_ADDRESS_FORBIDDEN' ||
          error.code === 'KNOWLEDGE_WEB_REDIRECT_FORBIDDEN' ||
          error.code === 'KNOWLEDGE_WEB_CONTENT_TYPE_FORBIDDEN' ||
          error.code === 'KNOWLEDGE_WEB_RESPONSE_TOO_LARGE'
        ) {
          throw new BadRequestException(error.code);
        }
        throw new BadGatewayException(error.code);
      }
      throw error;
    }
    const url = new URL(page.sourceUri);
    const pathLeaf = url.pathname.split('/').filter(Boolean).pop() ?? '';
    let decodedPathLeaf = pathLeaf;
    try {
      decodedPathLeaf = decodeURIComponent(pathLeaf);
    } catch {
      // Preserve the canonical escaped path when it contains a malformed
      // percent sequence rather than leaking a URI decoder exception.
    }
    const fallbackTitle = (decodedPathLeaf.trim() || url.hostname).slice(0, 300);
    const identity = await this.createVersionRecord({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title ?? fallbackTitle,
      sourceType: 'WEB',
      sourceUri: page.sourceUri,
      mimeType: page.mimeType,
      fileName: null,
      processing: true,
      enqueue: true,
      queueAvailableAt: new Date(Date.now() + FILE_UPLOAD_RECOVERY_DELAY_MS),
      ...(input.governance === undefined ? {} : { governance: input.governance }),
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
    });
    await this.persistObjectAndActivate(identity, page.bytes);
    return identity.documentId;
  }

  private async uploadFile(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly folderId?: string | null;
      readonly documentId?: string;
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly sourceUri?: string;
      readonly changeSummary?: string;
      readonly governance?: KnowledgeDocumentGovernancePolicy;
    },
  ): Promise<string> {
    const identity = await this.createVersionRecord({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      knowledgeBaseId: input.knowledgeBaseId,
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      title: input.title,
      sourceType: 'FILE',
      mimeType: input.mimeType,
      fileName: input.fileName,
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      processing: true,
      enqueue: true,
      queueAvailableAt: new Date(Date.now() + FILE_UPLOAD_RECOVERY_DELAY_MS),
      ...(input.governance === undefined ? {} : { governance: input.governance }),
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
    });
    await this.persistObjectAndActivate(identity, input.bytes);
    return identity.documentId;
  }

  private async persistObjectAndActivate(
    identity: IngestionIdentity,
    bytes: Buffer,
  ): Promise<void> {
    let storedObject: StoredKnowledgeObject | undefined;
    try {
      const stored = await this.objects.putObject({
        tenantId: identity.tenantId,
        documentId: identity.documentId,
        versionId: identity.documentVersionId,
        body: bytes,
      });
      storedObject = stored;
      await this.prisma.withTenant(identity.tenantId, async (transaction) => {
        await lockKnowledgeDocument(transaction, identity.tenantId, identity.documentId);
        const linked = await transaction.knowledgeDocumentVersion.updateMany({
          where: {
            tenantId: identity.tenantId,
            id: identity.documentVersionId,
            documentId: identity.documentId,
            status: 'PROCESSING',
            objectKey: null,
          },
          data: {
            objectKey: stored.objectKey,
            objectSize: stored.size,
            objectSha256: stored.sha256,
          },
        });
        if (linked.count !== 1) {
          throw new ConflictException('The file version can no longer be queued.');
        }
        const activated = await transaction.knowledgeIngestionJob.updateMany({
          where: {
            tenantId: identity.tenantId,
            id: requireIngestionJobId(identity),
            documentVersionId: identity.documentVersionId,
            status: 'PENDING',
          },
          data: { availableAt: new Date() },
        });
        if (activated.count !== 1) {
          throw new ConflictException('The file ingestion job can no longer be activated.');
        }
      });
    } catch (error) {
      if (storedObject === undefined) {
        await this.failBeforeEnqueue(identity, error);
      }
      // Once putObject succeeds, retain the deterministic object and delayed
      // queue row. A worker can reconstruct the key and atomically restore the
      // missing object ledger; deleting here would create a crash-window race.
    }
  }

  async retry(principal: AdminPrincipal, documentVersionId: string): Promise<string> {
    this.availability.assertPersistentWritesAvailable();
    const documentId = await this.findDocumentIdForVersion(principal.tenantId, documentVersionId);
    const identity = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId: principal.tenantId, id: documentVersionId, documentId },
        include: {
          ingestionJobs: { orderBy: { createdAt: 'desc' }, take: 1 },
          document: { select: { title: true } },
        },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      await requireActiveDocumentAndKnowledgeBase(
        transaction,
        principal.tenantId,
        version.knowledgeBaseId,
        documentId,
      );
      if (version.status === 'PROCESSING') {
        throw new ConflictException('The document version is already being processed.');
      }
      if (version.status !== 'FAILED') {
        throw new ConflictException('Only a failed document version can be retried.');
      }
      const job = await transaction.knowledgeIngestionJob.create({
        data: pendingJob(principal.tenantId, version.id),
      });
      await transaction.knowledgeDocumentVersion.update({
        where: { id: version.id },
        data: { status: 'PROCESSING' },
      });
      return {
        tenantId: principal.tenantId,
        knowledgeBaseId: version.knowledgeBaseId,
        documentId: version.documentId,
        documentVersionId: version.id,
        title: version.document.title,
        jobId: job.id,
        versionNumber: version.versionNumber,
        sourceType: version.sourceType,
        classification: version.classification,
        governanceHash: version.governanceHash,
        mimeType: version.mimeType ?? 'text/plain',
        fileName: version.fileName,
        actorUserId: principal.userId,
      };
    });
    return identity.documentId;
  }

  async rebuildEmbeddings(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly documentVersionId: string;
      readonly embeddingIndexVersionId?: string;
    },
  ): Promise<KnowledgeEmbeddingRebuildResult> {
    this.availability.assertPersistentWritesAvailable();
    if (!this.semantic.semanticEnabled) {
      throw new ConflictException('Semantic indexing is not enabled for this environment.');
    }
    const snapshot = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await requireActiveDocumentAndKnowledgeBase(
        transaction,
        principal.tenantId,
        input.knowledgeBaseId,
        input.documentId,
      );
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: principal.tenantId, id: input.knowledgeBaseId },
        select: {
          activeEmbeddingIndexVersion: { select: embeddingIndexVersionSelect },
          pendingEmbeddingIndexVersion: { select: embeddingIndexVersionSelect },
        },
      });
      const explicitlyRequested =
        input.embeddingIndexVersionId === undefined
          ? null
          : await transaction.knowledgeEmbeddingIndexVersion.findFirst({
              where: {
                tenantId: principal.tenantId,
                knowledgeBaseId: input.knowledgeBaseId,
                id: input.embeddingIndexVersionId,
              },
              select: embeddingIndexVersionSelect,
            });
      if (input.embeddingIndexVersionId !== undefined && explicitlyRequested === null) {
        throw new NotFoundException('The requested embedding index version was not found.');
      }
      const embeddingIndex =
        explicitlyRequested ??
        knowledgeBase?.pendingEmbeddingIndexVersion ??
        knowledgeBase?.activeEmbeddingIndexVersion ??
        null;
      if (embeddingIndex === null) {
        throw new ConflictException(
          'Configure an embedding index version before rebuilding document embeddings.',
        );
      }
      if (embeddingIndex.status !== 'ACTIVE' && embeddingIndex.status !== 'BUILDING') {
        throw new ConflictException('The selected embedding index version cannot be rebuilt.');
      }
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          id: input.documentVersionId,
          status: { in: ['READY', 'ARCHIVED'] },
        },
        include: { chunks: { orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }] } },
      });
      if (version === null)
        throw new NotFoundException('The indexed document version was not found.');
      if (version.chunks.length === 0) {
        throw new ConflictException('The document version has no chunks to embed.');
      }
      return {
        embeddingIndex,
        classification: knowledgeClassificationToAi(version.classification),
        chunks: version.chunks.map((chunk) => ({
          id: chunk.id,
          content: chunk.content,
          contentHash: chunk.contentHash,
        })),
      };
    });

    const embeddingBatch = await this.semantic.embedAll(
      principal.tenantId,
      snapshot.chunks.map((chunk) => chunk.content),
      snapshot.classification,
      undefined,
      embeddingProfileExpectation(snapshot.embeddingIndex),
    );
    if (embeddingBatch.vectors.length !== snapshot.chunks.length) {
      throw new KnowledgeAiRuntimeError('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH', true);
    }

    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, input.documentId);
      const currentChunks = await transaction.knowledgeChunk.findMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
        },
        orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }],
        select: { id: true, contentHash: true },
      });
      if (
        currentChunks.length !== snapshot.chunks.length ||
        currentChunks.some(
          (chunk, index) =>
            chunk.id !== snapshot.chunks[index]?.id ||
            chunk.contentHash !== snapshot.chunks[index]?.contentHash,
        )
      ) {
        throw new ConflictException('Document chunks changed while embeddings were generated.');
      }
      for (const [index, chunk] of snapshot.chunks.entries()) {
        const vector = embeddingBatch.vectors[index];
        if (vector === undefined) {
          throw new KnowledgeAiRuntimeError('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH', true);
        }
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_chunk_embeddings" (
            "id", "tenant_id", "chunk_id", "embedding_index_version_id", "embedding_model",
            "embedding_dimension", "content_hash", "embedding"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${principal.tenantId}::uuid,
            ${chunk.id}::uuid,
            ${snapshot.embeddingIndex.id}::uuid,
            ${embeddingBatch.model},
            ${embeddingBatch.dimensions},
            ${chunk.contentHash},
            ${vectorLiteral(vector)}::vector
          )
          ON CONFLICT ("tenant_id", "chunk_id", "embedding_index_version_id")
          DO UPDATE SET
            "embedding_dimension" = EXCLUDED."embedding_dimension",
            "content_hash" = EXCLUDED."content_hash",
            "embedding" = EXCLUDED."embedding",
            "updated_at" = now()
        `;
      }
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-document-version.embeddings-rebuilt',
        'knowledge_document_version',
        input.documentVersionId,
        {
          documentId: input.documentId,
          embeddingIndexVersionId: snapshot.embeddingIndex.id,
          embeddingIndexVersion: snapshot.embeddingIndex.version,
          embeddingModel: embeddingBatch.model,
          dimensions: embeddingBatch.dimensions,
          chunkCount: snapshot.chunks.length,
        },
      );
    });
    return {
      documentVersionId: input.documentVersionId,
      embeddingIndexVersionId: snapshot.embeddingIndex.id,
      embeddingIndexVersion: snapshot.embeddingIndex.version,
      embeddingModel: embeddingBatch.model,
      dimensions: embeddingBatch.dimensions,
      chunkCount: snapshot.chunks.length,
    };
  }

  async syncSearchDocumentVersion(
    principal: Pick<AdminPrincipal, 'tenantId'>,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly documentVersionId: string;
      readonly active: boolean;
      readonly embeddingIndexVersionId?: string;
    },
  ): Promise<void> {
    const snapshot = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: principal.tenantId, id: input.knowledgeBaseId },
        select: {
          activeEmbeddingIndexVersion: { select: embeddingIndexVersionSelect },
        },
      });
      const embeddingIndex =
        input.embeddingIndexVersionId === undefined
          ? (knowledgeBase?.activeEmbeddingIndexVersion ?? null)
          : await transaction.knowledgeEmbeddingIndexVersion.findFirst({
              where: {
                tenantId: principal.tenantId,
                knowledgeBaseId: input.knowledgeBaseId,
                id: input.embeddingIndexVersionId,
              },
              select: embeddingIndexVersionSelect,
            });
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          id: input.documentVersionId,
          status: { in: ['READY', 'ARCHIVED'] },
        },
        select: {
          id: true,
          classification: true,
          governanceHash: true,
          createdAt: true,
          document: { select: { title: true } },
          chunks: {
            orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              headingPath: true,
              content: true,
              contentHash: true,
            },
          },
        },
      });
      if (version === null)
        throw new NotFoundException('The indexed document version was not found.');
      const embeddings =
        embeddingIndex === null
          ? []
          : await transaction.$queryRaw<
              Array<{ readonly chunk_id: string; readonly embedding: string }>
            >(Prisma.sql`
              SELECT DISTINCT ON (embedding."chunk_id")
                embedding."chunk_id"::text AS chunk_id,
                embedding."embedding"::text AS embedding
              FROM public."knowledge_chunk_embeddings" embedding
              JOIN public."knowledge_chunks" chunk
                ON chunk."tenant_id" = embedding."tenant_id"
               AND chunk."id" = embedding."chunk_id"
              WHERE embedding."tenant_id" = ${principal.tenantId}::uuid
                AND embedding."embedding_index_version_id" = ${embeddingIndex.id}::uuid
                AND chunk."document_version_id" = ${input.documentVersionId}::uuid
              ORDER BY embedding."chunk_id", embedding."updated_at" DESC, embedding."embedding_model"
            `);
      return {
        embeddingIndex,
        version,
        vectorByChunkId: new Map(
          embeddings.map((row) => [row.chunk_id, parseStoredVector(row.embedding)]),
        ),
      };
    });
    const searchIndexProfile =
      snapshot.embeddingIndex === null
        ? deploymentDefaultSearchIndexProfile(this.semantic.embeddingDimensions)
        : knowledgeSearchIndexProfile(snapshot.embeddingIndex);
    await this.searchIndex.replaceDocumentVersion({
      profile: searchIndexProfile,
      tenantId: principal.tenantId,
      documentVersionId: input.documentVersionId,
      active: input.active,
      chunks: snapshot.version.chunks.map((chunk) => {
        const vector = snapshot.vectorByChunkId.get(chunk.id);
        return {
          chunkId: chunk.id,
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          title: snapshot.version.document.title,
          headingPath: chunk.headingPath,
          content: chunk.content,
          contentHash: chunk.contentHash,
          classification: snapshot.version.classification,
          governanceHash: snapshot.version.governanceHash,
          updatedAt: snapshot.version.createdAt.toISOString(),
          ...(vector === undefined ? {} : { vector }),
        };
      }),
    });
    if (input.active) {
      await this.searchIndex.publishDocumentVersion({
        profile: searchIndexProfile,
        tenantId: principal.tenantId,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
      });
    }
  }

  async archiveSearchDocument(
    principal: AdminPrincipal,
    input: { readonly documentId: string },
  ): Promise<void> {
    const profiles = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const document = await transaction.knowledgeDocument.findFirst({
        where: { tenantId: principal.tenantId, id: input.documentId },
        select: {
          knowledgeBase: {
            select: {
              activeEmbeddingIndexVersion: { select: embeddingIndexVersionSelect },
              pendingEmbeddingIndexVersion: { select: embeddingIndexVersionSelect },
            },
          },
        },
      });
      if (document === null) return [];
      const configuredProfiles = [
        document.knowledgeBase.activeEmbeddingIndexVersion,
        document.knowledgeBase.pendingEmbeddingIndexVersion,
      ].filter((profile): profile is NonNullable<typeof profile> => profile !== null);
      return configuredProfiles.length === 0
        ? [deploymentDefaultSearchIndexProfile(this.semantic.embeddingDimensions)]
        : configuredProfiles.map(knowledgeSearchIndexProfile);
    });
    await Promise.all(
      profiles.map((profile) =>
        this.searchIndex.archiveDocument({
          profile,
          tenantId: principal.tenantId,
          documentId: input.documentId,
        }),
      ),
    );
  }

  async readStructuredDocumentPreview(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly documentVersionId: string;
    },
  ): Promise<KnowledgeStructuredDocumentPreview> {
    const version = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          id: input.documentVersionId,
        },
        select: {
          id: true,
          structuredObjectKey: true,
          structuredObjectSize: true,
          structuredObjectSha256: true,
          structuredFormat: true,
        },
      }),
    );
    if (version === null) throw new NotFoundException('The document version was not found.');
    if (
      version.structuredObjectKey === null ||
      version.structuredObjectSize === null ||
      version.structuredObjectSha256 === null ||
      version.structuredFormat === null
    ) {
      throw new NotFoundException('The structured document artifact is not available.');
    }
    const object = await this.objects.readObject(version.structuredObjectKey);
    if (
      object.size !== version.structuredObjectSize ||
      object.sha256 !== version.structuredObjectSha256
    ) {
      throw new KnowledgeObjectIntegrityError(
        'Structured knowledge artifact does not match its version ledger.',
      );
    }
    const bytes = await collectReadable(object.body, object.size, object.size);
    let content: unknown;
    try {
      content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new KnowledgeObjectIntegrityError('Structured knowledge artifact is not valid JSON.');
    }
    const preview = structuredPreview(content);
    return {
      documentVersionId: version.id,
      format: version.structuredFormat,
      size: version.structuredObjectSize,
      sha256: version.structuredObjectSha256,
      truncated: preview.truncated,
      content: preview.value,
    };
  }

  async readSourceDocument(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly documentVersionId: string;
    },
  ): Promise<KnowledgeSourceDocument> {
    const version = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          id: input.documentVersionId,
        },
        select: {
          objectKey: true,
          objectSize: true,
          objectSha256: true,
          mimeType: true,
          fileName: true,
          document: { select: { title: true } },
        },
      }),
    );
    if (version === null || version.objectKey === null) {
      throw new NotFoundException('The original source file is not available.');
    }
    const object = await this.objects.readObject(version.objectKey);
    if (version.objectSize !== null && object.size !== version.objectSize) {
      object.body.destroy();
      throw new KnowledgeObjectIntegrityError(
        'Knowledge source object size does not match its version ledger.',
      );
    }
    if (
      version.objectSha256 !== null &&
      object.sha256.toLowerCase() !== version.objectSha256.toLowerCase()
    ) {
      object.body.destroy();
      throw new KnowledgeObjectIntegrityError(
        'Knowledge source object checksum does not match its version ledger.',
      );
    }
    return {
      body: object.body,
      size: object.size,
      mimeType: version.mimeType ?? 'application/octet-stream',
      fileName: sourceFileName(version.fileName ?? version.document.title),
    };
  }

  async rebuildKnowledgeGraph(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId: string;
      readonly documentVersionId: string;
    },
  ): Promise<KnowledgeGraphRebuildResult> {
    this.availability.assertPersistentWritesAvailable();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, input.documentId);
      await requireActiveDocumentAndKnowledgeBase(
        transaction,
        principal.tenantId,
        input.knowledgeBaseId,
        input.documentId,
      );
      const [document, version] = await Promise.all([
        transaction.knowledgeDocument.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId: input.knowledgeBaseId,
            id: input.documentId,
          },
          select: { title: true },
        }),
        transaction.knowledgeDocumentVersion.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId: input.knowledgeBaseId,
            documentId: input.documentId,
            id: input.documentVersionId,
            status: { in: ['READY', 'ARCHIVED'] },
          },
          include: { chunks: { orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }] } },
        }),
      ]);
      if (document === null || version === null) {
        throw new NotFoundException('The indexed document version was not found.');
      }
      if (version.publishedAt !== null) {
        throw new ConflictException(
          'An active graph projection is immutable. Create and govern a new document version.',
        );
      }
      if (version.chunks.length === 0) {
        throw new ConflictException('The document version has no chunks to project.');
      }
      const projection = projectKnowledgeGraph({
        documentId: input.documentId,
        documentTitle: document.title,
        chunks: version.chunks,
      });
      await persistKnowledgeGraphProjection(
        transaction,
        {
          tenantId: principal.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          actorUserId: principal.userId,
        },
        projection,
      );
      const evidenceCount = projection.relations.reduce(
        (count, relation) => count + relation.evidence.length,
        0,
      );
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-document-version.graph-rebuilt',
        'knowledge_document_version',
        input.documentVersionId,
        {
          documentId: input.documentId,
          entityCount: projection.entities.length,
          relationCount: projection.relations.length,
          mentionCount: projection.mentions.length,
          evidenceCount,
        },
      );
      return {
        documentVersionId: input.documentVersionId,
        entityCount: projection.entities.length,
        relationCount: projection.relations.length,
        mentionCount: projection.mentions.length,
        evidenceCount,
      };
    });
  }

  private async findDocumentIdForVersion(
    tenantId: string,
    documentVersionId: string,
  ): Promise<string> {
    return this.prisma.withTenant(tenantId, async (transaction) => {
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId, id: documentVersionId },
        select: { documentId: true },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      return version.documentId;
    });
  }

  private async createVersionRecord(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly knowledgeBaseId: string;
    readonly folderId?: string | null;
    readonly documentId?: string;
    readonly title: string;
    readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
    readonly sourceUri?: string;
    readonly mimeType: string;
    readonly fileName: string | null;
    readonly contentText?: string;
    readonly processing: boolean;
    readonly enqueue: boolean;
    readonly queueAvailableAt?: Date;
    readonly changeSummary?: string;
    readonly governance?: KnowledgeDocumentGovernancePolicy;
  }): Promise<IngestionIdentity> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, input.tenantId, input.documentId ?? input.title);
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: input.tenantId, id: input.knowledgeBaseId },
      });
      if (knowledgeBase === null || knowledgeBase.status === 'ARCHIVED') {
        throw new NotFoundException('The active knowledge base was not found.');
      }
      if (input.documentId === undefined && input.folderId != null) {
        const folder = await transaction.knowledgeFolder.findFirst({
          where: {
            tenantId: input.tenantId,
            knowledgeBaseId: input.knowledgeBaseId,
            id: input.folderId,
          },
          select: { id: true },
        });
        if (folder === null) throw new BadRequestException('The knowledge folder was not found.');
      }
      const document =
        input.documentId === undefined
          ? await transaction.knowledgeDocument.create({
              data: {
                tenantId: input.tenantId,
                knowledgeBaseId: input.knowledgeBaseId,
                folderId: input.folderId ?? null,
                title: input.title,
                sourceType: input.sourceType,
                mimeType: input.mimeType,
                fileName: input.fileName,
                status: input.processing ? 'PROCESSING' : 'DRAFT',
                createdById: input.actorUserId,
              },
            })
          : await transaction.knowledgeDocument.findFirst({
              where: {
                tenantId: input.tenantId,
                knowledgeBaseId: input.knowledgeBaseId,
                id: input.documentId,
              },
            });
      if (document === null) throw new NotFoundException('The knowledge document was not found.');
      if (document.status === 'ARCHIVED') {
        throw new ConflictException('An archived document cannot receive a new version.');
      }
      if (document.sourceType !== input.sourceType) {
        throw new ConflictException('A document version must keep the original source type.');
      }
      const latest = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId: input.tenantId, documentId: document.id },
        orderBy: { versionNumber: 'desc' },
        select: {
          id: true,
          versionNumber: true,
          governanceOwnerUserId: true,
          classification: true,
          scopeMode: true,
          organizationScopeIds: true,
          projectScopeIds: true,
          taskScopeIds: true,
          roleTemplateScopeIds: true,
          dataLabels: true,
          retentionUntil: true,
          retentionAction: true,
        },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;
      const governance = knowledgeGovernanceCreateData(input.governance, latest, input.actorUserId);
      const owner = await transaction.user.findFirst({
        where: {
          tenantId: input.tenantId,
          id: governance.governanceOwnerUserId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (owner === null) {
        throw new BadRequestException('The knowledge governance owner must be an active user.');
      }
      const version = await transaction.knowledgeDocumentVersion.create({
        data: {
          tenantId: input.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: document.id,
          versionNumber,
          sourceType: input.sourceType,
          mimeType: input.mimeType,
          fileName: input.fileName,
          sourceUri: input.sourceUri ?? null,
          status: input.processing ? 'PROCESSING' : 'DRAFT',
          changeSummary: input.changeSummary ?? null,
          ...governance,
          createdById: input.actorUserId,
          ...(input.sourceType === 'TEXT' || input.sourceType === 'MARKDOWN'
            ? {
                contentText: input.contentText ?? '',
                checksum: sha256(input.contentText ?? ''),
              }
            : {}),
        },
      });
      const job = input.enqueue
        ? await transaction.knowledgeIngestionJob.create({
            data: pendingJob(input.tenantId, version.id, input.queueAvailableAt),
          })
        : null;
      await transaction.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          ...((input.sourceType === 'FILE' || input.sourceType === 'WEB') &&
          document.currentVersionId !== null
            ? {}
            : {
                title: input.title,
                sourceType: input.sourceType,
                mimeType: input.mimeType,
                fileName: input.fileName,
              }),
          ...(!input.processing && document.currentVersionId === null
            ? {
                status: 'DRAFT' as const,
                contentText: input.contentText ?? '',
                checksum: sha256(input.contentText ?? ''),
              }
            : {}),
        },
      });
      return {
        tenantId: input.tenantId,
        knowledgeBaseId: input.knowledgeBaseId,
        documentId: document.id,
        documentVersionId: version.id,
        title: document.title,
        jobId: job?.id ?? null,
        versionNumber,
        sourceType: input.sourceType,
        classification: version.classification,
        governanceHash: version.governanceHash,
        mimeType: input.mimeType,
        fileName: input.fileName,
        actorUserId: input.actorUserId,
      };
    });
  }

  /**
   * Executes a queue claim. The cross-tenant queue repository deliberately
   * returns identifiers only; all source/content reads happen behind the
   * tenant-scoped admin capability here.
   */
  async executeClaim(
    claim: ClaimedKnowledgeIngestionJob,
    workerId: string,
    lease: KnowledgeIngestionLeaseControl,
  ): Promise<void> {
    assertKnowledgeIngestionLeaseActive(lease);
    const source = await this.prisma.withTenant(claim.tenantId, async (transaction) => {
      const owned = await hasOwnedClaim(transaction, claim.id, workerId);
      if (!owned) throw new KnowledgeIngestionLeaseLostError();
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: claim.tenantId,
          id: claim.documentVersionId,
          status: 'PROCESSING',
        },
        select: {
          id: true,
          knowledgeBaseId: true,
          documentId: true,
          versionNumber: true,
          sourceType: true,
          classification: true,
          governanceHash: true,
          mimeType: true,
          fileName: true,
          objectKey: true,
          objectSize: true,
          objectSha256: true,
          contentText: true,
          createdById: true,
          document: { select: { title: true } },
        },
      });
      if (version === null) throw new Error('KNOWLEDGE_DOCUMENT_VERSION_UNAVAILABLE');
      return {
        identity: {
          tenantId: claim.tenantId,
          knowledgeBaseId: version.knowledgeBaseId,
          documentId: version.documentId,
          documentVersionId: version.id,
          title: version.document.title,
          jobId: claim.id,
          versionNumber: version.versionNumber,
          sourceType: version.sourceType,
          classification: version.classification,
          governanceHash: version.governanceHash,
          mimeType:
            version.mimeType ??
            (version.sourceType === 'MARKDOWN' ? 'text/markdown' : 'text/plain'),
          fileName: version.fileName,
          actorUserId: version.createdById,
        } satisfies IngestionIdentity,
        objectKey: version.objectKey,
        objectSize: version.objectSize,
        objectSha256: version.objectSha256,
        contentText: version.contentText,
      };
    });
    await lease.assertOwned();
    const bytes = await this.readSourceBytes(source, workerId, lease);
    await lease.assertOwned();
    await this.process(source.identity, bytes, workerId, lease);
  }

  async failClaim(
    claim: ClaimedKnowledgeIngestionJob,
    workerId: string,
    failure: KnowledgeIngestionFailure,
  ): Promise<boolean> {
    return this.prisma.withTenant(claim.tenantId, async (transaction) => {
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId: claim.tenantId, id: claim.documentVersionId },
        select: { documentId: true, createdById: true },
      });
      if (version === null) return false;
      await lockKnowledgeDocument(transaction, claim.tenantId, version.documentId);
      if (!(await lockOwnedClaim(transaction, claim.id, workerId))) return false;
      const latestJob = await transaction.knowledgeIngestionJob.findFirst({
        where: {
          tenantId: claim.tenantId,
          documentVersionId: claim.documentVersionId,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      await transaction.knowledgeIngestionJob.update({
        where: { id: claim.id },
        data: {
          status: 'FAILED',
          errorCode: failure.code,
          errorMessage: failure.message,
          claimedBy: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        },
      });
      if (latestJob?.id !== claim.id) return true;

      await transaction.knowledgeDocumentVersion.updateMany({
        where: { tenantId: claim.tenantId, id: claim.documentVersionId },
        data: { status: 'FAILED' },
      });
      const document = await transaction.knowledgeDocument.findFirst({
        where: { tenantId: claim.tenantId, id: version.documentId },
        select: { currentVersionId: true, status: true },
      });
      if (document?.currentVersionId === null && document.status !== 'ARCHIVED') {
        await transaction.knowledgeDocument.updateMany({
          where: { tenantId: claim.tenantId, id: version.documentId },
          data: { status: 'FAILED' },
        });
      }
      await recordAdminAudit(
        transaction,
        { tenantId: claim.tenantId, userId: version.createdById },
        'admin.knowledge-document-version.ingestion-failed',
        'knowledge_document_version',
        claim.documentVersionId,
        {
          errorCode: failure.code,
          attempts: claim.attempts,
          failureAttempts: claim.failureAttempts,
          queued: true,
        },
      );
      return true;
    });
  }

  private async readSourceBytes(
    source: IngestionSource,
    workerId: string,
    lease: KnowledgeIngestionLeaseControl,
  ): Promise<Buffer> {
    assertKnowledgeIngestionLeaseActive(lease);
    if (source.identity.sourceType !== 'FILE' && source.identity.sourceType !== 'WEB') {
      return Buffer.from(source.contentText ?? '', 'utf8');
    }
    const objectKey =
      source.objectKey ??
      buildKnowledgeObjectKey({
        tenantId: source.identity.tenantId,
        documentId: source.identity.documentId,
        versionId: source.identity.documentVersionId,
      });
    const object = await this.objects.readObject(objectKey);
    if (source.objectSize !== null && object.size !== source.objectSize) {
      object.body.destroy();
      throw new KnowledgeObjectIntegrityError(
        'Knowledge object size does not match its persisted ledger.',
      );
    }
    if (
      object.sha256 !== undefined &&
      source.objectSha256 !== null &&
      object.sha256.toLowerCase() !== source.objectSha256.toLowerCase()
    ) {
      object.body.destroy();
      throw new KnowledgeObjectIntegrityError(
        'Knowledge object provider checksum does not match its persisted ledger.',
      );
    }
    const abortRead = (): void => {
      object.body.destroy(new KnowledgeIngestionLeaseLostError());
    };
    lease.signal.addEventListener('abort', abortRead, { once: true });
    let bytes: Buffer;
    try {
      if (lease.signal.aborted) abortRead();
      bytes = await collectReadable(object.body, object.size, object.size);
    } catch (error) {
      if (lease.signal.aborted) throw new KnowledgeIngestionLeaseLostError();
      throw error;
    } finally {
      lease.signal.removeEventListener('abort', abortRead);
    }
    await lease.assertOwned();
    const contentSha256 = sha256(bytes);
    if (source.objectSha256 !== null && contentSha256 !== source.objectSha256.toLowerCase()) {
      throw new KnowledgeObjectIntegrityError(
        'Knowledge object content does not match its persisted ledger.',
      );
    }
    if (object.sha256 !== undefined && contentSha256 !== object.sha256.toLowerCase()) {
      throw new KnowledgeObjectIntegrityError(
        'Knowledge object content does not match its provider checksum.',
      );
    }
    if (source.objectKey === null || source.objectSize === null || source.objectSha256 === null) {
      const updated = await this.prisma.withTenant(
        source.identity.tenantId,
        async (transaction) => {
          if (
            !(await hasOwnedClaim(transaction, requireIngestionJobId(source.identity), workerId))
          ) {
            throw new KnowledgeIngestionLeaseLostError();
          }
          return transaction.knowledgeDocumentVersion.updateMany({
            where: {
              tenantId: source.identity.tenantId,
              id: source.identity.documentVersionId,
              status: 'PROCESSING',
              objectKey: source.objectKey,
              objectSize: source.objectSize,
              objectSha256: source.objectSha256,
            },
            data: {
              objectKey,
              objectSize: object.size,
              objectSha256: contentSha256,
            },
          });
        },
      );
      if (updated.count !== 1) throw new KnowledgeIngestionLeaseLostError();
    }
    return bytes;
  }

  private async process(
    identity: IngestionIdentity,
    bytes: Buffer,
    workerId: string,
    lease: KnowledgeIngestionLeaseControl,
  ): Promise<void> {
    const startedAt = performance.now();
    const timings: Record<string, number> = {};
    let stageStartedAt = startedAt;
    const finishStage = (stage: string): void => {
      const now = performance.now();
      timings[stage] = Math.round(now - stageStartedAt);
      stageStartedAt = now;
    };
    assertKnowledgeIngestionLeaseActive(lease);
    await this.advance(identity, workerId, 'SECURITY_CHECK', 15);
    let securityScan: {
      readonly verdict: 'clean' | 'not_scanned';
      readonly scanner: string | null;
    } | null = null;
    if (identity.sourceType === 'FILE' || identity.sourceType === 'WEB') {
      await lease.assertOwned();
      const scan = await this.scanner.scan({
        bytes,
        fileName: identity.fileName ?? 'document.bin',
        mimeType: identity.mimeType,
        sha256: sha256(bytes),
      });
      assertKnowledgeIngestionLeaseActive(lease);
      if (scan.verdict === 'infected') {
        throw new KnowledgeFileSecurityError('KNOWLEDGE_FILE_INFECTED', false);
      }
      if (scan.verdict === 'not_scanned') {
        // Environment validation forbids the disabled scanner in production.
        // Development may continue, but the audit event must never call this
        // result clean.
        securityScan = { verdict: 'not_scanned', scanner: null };
      }
      if (scan.verdict === 'error') {
        throw new KnowledgeFileSecurityError('KNOWLEDGE_FILE_SCAN_UNAVAILABLE', true);
      }
      if (scan.verdict === 'clean') {
        securityScan = { verdict: 'clean', scanner: scan.scanner };
      }
    }
    finishStage('securityScanMs');
    await this.advance(identity, workerId, 'PARSING', 30);
    await lease.assertOwned();
    const aiClassification = knowledgeClassificationToAi(identity.classification);
    if (
      isRemoteDocumentParserMimeType(identity.mimeType) &&
      !isExternalKnowledgeAiApproved(aiClassification)
    ) {
      throw new Error('KNOWLEDGE_DOCLING_CLASSIFICATION_NOT_APPROVED');
    }
    const parsed = await this.parser.parse({
      bytes,
      mimeType: identity.mimeType,
      ...(identity.fileName === null ? {} : { fileName: identity.fileName }),
      signal: lease.signal,
    });
    finishStage('parseMs');
    assertKnowledgeIngestionLeaseActive(lease);
    await lease.assertOwned();
    // Parsed content must be checked before any derived artifact, chunk,
    // embedding, database row or external search index is produced.
    // Findings intentionally stay in memory until the dedicated review ledger
    // persists only redacted summaries; never include the matched value in an
    // exception or log message.
    if (scanKnowledgeContent(parsed.text).length > 0) {
      throw new Error('KNOWLEDGE_CONTENT_SECURITY_REVIEW_REQUIRED');
    }
    const structuredBytes = serializeStructuredKnowledgeDocument(parsed);
    const structuredObjectInput = {
      tenantId: identity.tenantId,
      documentId: identity.documentId,
      versionId: identity.documentVersionId,
      artifactKind: 'structured' as const,
      contentType: 'application/json; charset=utf-8',
      body: structuredBytes,
    };
    let structuredObject: StoredKnowledgeObject;
    try {
      structuredObject = await this.objects.putObject(structuredObjectInput);
    } catch (error) {
      if (!(error instanceof KnowledgeObjectConflictError)) throw error;
      // A killed attempt can leave an uncommitted derived artifact behind. The
      // immutable source object is never replaced; the current lease owner may
      // regenerate only this structured derivative before chunks are committed.
      await lease.assertOwned();
      await this.objects.deleteObject(error.objectKey);
      await lease.assertOwned();
      structuredObject = await this.objects.putObject(structuredObjectInput);
    }
    finishStage('structuredObjectMs');
    assertKnowledgeIngestionLeaseActive(lease);
    await lease.assertOwned();
    await this.advance(identity, workerId, 'CHUNKING', 55);
    const knowledgeConfiguration = await this.prisma.withTenant(identity.tenantId, (transaction) =>
      transaction.knowledgeBase.findFirst({
        where: { tenantId: identity.tenantId, id: identity.knowledgeBaseId },
        select: {
          chunkTargetTokens: true,
          chunkOverlapTokens: true,
          activeEmbeddingIndexVersion: { select: embeddingIndexVersionSelect },
        },
      }),
    );
    if (knowledgeConfiguration === null) throw new Error('KNOWLEDGE_BASE_UNAVAILABLE');
    await lease.assertOwned();
    const hierarchy = chunkParsedKnowledgeDocument(parsed, {
      targetTokens: knowledgeConfiguration.chunkTargetTokens,
      overlapTokens: knowledgeConfiguration.chunkOverlapTokens,
    });
    finishStage('chunkMs');
    const chunks = hierarchy.chunks;
    if (chunks.length === 0) throw new Error('DOCUMENT_TEXT_EMPTY');
    const parseQuality = assessKnowledgeParseQuality({
      parsed,
      sourceByteLength: bytes.byteLength,
      chunkCount: chunks.length,
    });
    const storedParents = hierarchy.parents.map((parent) => ({ id: randomUUID(), ...parent }));
    const chunkIds = chunks.map(() => randomUUID());
    const storedChunks = chunks.map((chunk, index) => ({
      id: requireArrayValue(chunkIds, index, 'KNOWLEDGE_CHUNK_ID_MISSING'),
      ...chunk,
      parentChunkId: requireArrayValue(
        storedParents,
        chunk.parentIndex,
        'KNOWLEDGE_PARENT_CHUNK_MISSING',
      ).id,
      previousChunkId:
        index === 0 ? null : requireArrayValue(chunkIds, index - 1, 'KNOWLEDGE_CHUNK_ID_MISSING'),
      nextChunkId:
        index + 1 >= chunkIds.length
          ? null
          : requireArrayValue(chunkIds, index + 1, 'KNOWLEDGE_CHUNK_ID_MISSING'),
    }));
    await this.advance(identity, workerId, 'INDEXING', 65);
    await lease.assertOwned();
    const embeddingIndex = knowledgeConfiguration.activeEmbeddingIndexVersion ?? null;
    const embeddingBatch =
      this.semantic.semanticEnabled && embeddingIndex !== null
        ? await this.semantic.embedAll(
            identity.tenantId,
            storedChunks.map((chunk) => chunk.content),
            aiClassification,
            lease.signal,
            embeddingProfileExpectation(embeddingIndex),
          )
        : null;
    finishStage('embeddingMs');
    assertKnowledgeIngestionLeaseActive(lease);
    await lease.assertOwned();

    if (embeddingBatch !== null && embeddingBatch.vectors.length !== storedChunks.length) {
      throw new Error('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH');
    }
    await this.advance(identity, workerId, 'INDEXING', 78);
    const indexedAt = new Date();
    let automaticallyPublished = false;
    await this.searchIndex.replaceDocumentVersion({
      profile:
        embeddingIndex === null
          ? deploymentDefaultSearchIndexProfile(this.semantic.embeddingDimensions)
          : knowledgeSearchIndexProfile(embeddingIndex),
      tenantId: identity.tenantId,
      documentVersionId: identity.documentVersionId,
      active: false,
      chunks: storedChunks.map((chunk, index) => ({
        chunkId: chunk.id,
        tenantId: identity.tenantId,
        knowledgeBaseId: identity.knowledgeBaseId,
        documentId: identity.documentId,
        documentVersionId: identity.documentVersionId,
        title: identity.title,
        headingPath: chunk.headingPath,
        content: chunk.content,
        contentHash: chunk.contentHash,
        classification: identity.classification,
        governanceHash: identity.governanceHash,
        updatedAt: indexedAt.toISOString(),
        ...(embeddingBatch?.vectors[index] === undefined
          ? {}
          : { vector: embeddingBatch.vectors[index] }),
      })),
    });
    finishStage('searchIndexMs');
    assertKnowledgeIngestionLeaseActive(lease);
    await lease.assertOwned();
    await this.advance(identity, workerId, 'INDEXING', 90);

    await this.prisma.withTenant(identity.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, identity.tenantId, identity.documentId);
      const jobId = requireIngestionJobId(identity);
      if (!(await lockOwnedClaim(transaction, jobId, workerId))) {
        throw new KnowledgeIngestionLeaseLostError();
      }
      const latestJob = await transaction.knowledgeIngestionJob.findFirst({
        where: {
          tenantId: identity.tenantId,
          documentVersionId: identity.documentVersionId,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (latestJob?.id !== jobId) throw new KnowledgeIngestionLeaseLostError();
      const activeDocument = await transaction.knowledgeDocument.findFirstOrThrow({
        where: { tenantId: identity.tenantId, id: identity.documentId },
        select: { status: true, title: true },
      });
      const activeKnowledgeBase = await transaction.knowledgeBase.findFirstOrThrow({
        where: { tenantId: identity.tenantId, id: identity.knowledgeBaseId },
        select: { status: true },
      });
      if (activeDocument.status === 'ARCHIVED') {
        throw new Error('KNOWLEDGE_DOCUMENT_ARCHIVED');
      }
      if (activeKnowledgeBase.status === 'ARCHIVED') {
        throw new Error('KNOWLEDGE_BASE_ARCHIVED');
      }
      await transaction.knowledgeChunk.deleteMany({
        where: { tenantId: identity.tenantId, documentVersionId: identity.documentVersionId },
      });
      await transaction.knowledgeParentChunk.deleteMany({
        where: { tenantId: identity.tenantId, documentVersionId: identity.documentVersionId },
      });
      await transaction.knowledgeParentChunk.createMany({
        data: storedParents.map((parent) => ({
          id: parent.id,
          tenantId: identity.tenantId,
          knowledgeBaseId: identity.knowledgeBaseId,
          documentId: identity.documentId,
          documentVersionId: identity.documentVersionId,
          parentIndex: parent.parentIndex,
          headingPath: parent.headingPath,
          content: parent.content,
          tokenCount: parent.tokenCount,
          contentHash: parent.contentHash,
          metadata: parent.metadata,
        })),
      });
      await transaction.knowledgeChunk.createMany({
        data: storedChunks.map((chunk) => ({
          id: chunk.id,
          tenantId: identity.tenantId,
          knowledgeBaseId: identity.knowledgeBaseId,
          documentId: identity.documentId,
          documentVersionId: identity.documentVersionId,
          parentChunkId: chunk.parentChunkId,
          previousChunkId: chunk.previousChunkId,
          nextChunkId: chunk.nextChunkId,
          chunkIndex: chunk.chunkIndex,
          headingPath: chunk.headingPath,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          metadata: chunk.metadata,
        })),
      });
      const graphProjection = projectKnowledgeGraph({
        documentId: identity.documentId,
        documentTitle: activeDocument.title,
        chunks: storedChunks,
      });
      await persistKnowledgeGraphProjection(transaction, identity, graphProjection);
      if (embeddingBatch !== null) {
        if (embeddingBatch.vectors.length !== storedChunks.length) {
          throw new Error('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH');
        }
        for (let offset = 0; offset < storedChunks.length; offset += EMBEDDING_PERSIST_BATCH_SIZE) {
          const rows = storedChunks
            .slice(offset, offset + EMBEDDING_PERSIST_BATCH_SIZE)
            .map((chunk, batchIndex) => {
              const vector = embeddingBatch.vectors[offset + batchIndex];
              if (vector === undefined) throw new Error('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH');
              return Prisma.sql`(
                ${randomUUID()}::uuid,
                ${identity.tenantId}::uuid,
                ${chunk.id}::uuid,
                ${requireEmbeddingIndex(embeddingIndex).id}::uuid,
                ${embeddingBatch.model},
                ${embeddingBatch.dimensions},
                ${chunk.contentHash},
                ${vectorLiteral(vector)}::vector
              )`;
            });
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO public."knowledge_chunk_embeddings" (
              "id", "tenant_id", "chunk_id", "embedding_index_version_id", "embedding_model",
              "embedding_dimension", "content_hash", "embedding"
            ) VALUES ${Prisma.join(rows)}
            ON CONFLICT ("tenant_id", "chunk_id", "embedding_index_version_id")
            DO UPDATE SET
              "embedding_dimension" = EXCLUDED."embedding_dimension",
              "content_hash" = EXCLUDED."content_hash",
              "embedding" = EXCLUDED."embedding",
              "updated_at" = now()
          `);
        }
      }
      const document = await transaction.knowledgeDocument.findFirstOrThrow({
        where: { tenantId: identity.tenantId, id: identity.documentId },
        select: { currentVersionId: true, documentVersion: true },
      });
      const shouldPublish =
        identity.versionNumber >= document.documentVersion &&
        (document.currentVersionId === null || identity.versionNumber > document.documentVersion);
      const graphActivation = shouldPublish
        ? await activateKnowledgeGraphProjection(transaction, {
            tenantId: identity.tenantId,
            knowledgeBaseId: identity.knowledgeBaseId,
            documentId: identity.documentId,
            documentVersionId: identity.documentVersionId,
          })
        : null;
      await transaction.knowledgeDocumentVersion.update({
        where: { id: identity.documentVersionId },
        data: {
          contentText: parsed.text,
          checksum: sha256(bytes),
          status: 'READY',
          publishedAt: shouldPublish ? indexedAt : null,
          parserName: parseQuality.parserName,
          parseQualityScore: parseQuality.score,
          parseReviewStatus:
            identity.sourceType === 'FILE' || identity.sourceType === 'WEB'
              ? 'PENDING'
              : 'NOT_REQUIRED',
          parseReviewRevision: { increment: 1 },
          parseReviewedById: null,
          parseReviewedAt: null,
          parseReviewNote: null,
          parseDiagnostics: parseQuality.diagnostics,
          structuredObjectKey: structuredObject.objectKey,
          structuredObjectSize: structuredObject.size,
          structuredObjectSha256: structuredObject.sha256,
          structuredFormat: STRUCTURED_KNOWLEDGE_FORMAT,
        },
      });
      if (shouldPublish) {
        await transaction.knowledgeDocument.update({
          where: { id: identity.documentId },
          data: {
            currentVersionId: identity.documentVersionId,
            status: 'READY',
            documentVersion: identity.versionNumber,
            contentText: parsed.text,
            checksum: sha256(bytes),
            objectKey:
              identity.sourceType === 'FILE' || identity.sourceType === 'WEB'
                ? buildKnowledgeObjectKey({
                    tenantId: identity.tenantId,
                    documentId: identity.documentId,
                    versionId: identity.documentVersionId,
                  })
                : null,
            mimeType: identity.mimeType,
            fileName: identity.fileName,
          },
        });
        const publicEvent = defineKnowledgePublicEvent({
          eventType: 'knowledge.document-version.published.v1',
          payload: {
            knowledgeBaseId: identity.knowledgeBaseId,
            documentId: identity.documentId,
            documentVersionId: identity.documentVersionId,
            version: identity.versionNumber,
            graphProjectionId: graphActivation?.projectionId ?? null,
            graphHash: graphActivation?.graphHash ?? null,
            publishedAt: indexedAt.toISOString(),
          },
        });
        await transaction.outboxEvent.create({
          data: {
            tenantId: identity.tenantId,
            aggregateType: 'knowledge_document_version',
            aggregateId: identity.documentVersionId,
            eventType: publicEvent.eventType,
            payload: publicEvent.payload,
          },
        });
        automaticallyPublished = true;
      }
      await transaction.knowledgeIngestionJob.update({
        where: { id: jobId },
        data: {
          stage: 'READY',
          status: 'SUCCEEDED',
          progress: 100,
          claimedBy: null,
          leaseExpiresAt: null,
          finishedAt: indexedAt,
          errorCode: null,
          errorMessage: null,
        },
      });
      await recordAdminAudit(
        transaction,
        {
          tenantId: identity.tenantId,
          userId: identity.actorUserId,
        },
        'admin.knowledge-document-version.indexed',
        'knowledge_document_version',
        identity.documentVersionId,
        {
          documentId: identity.documentId,
          version: identity.versionNumber,
          chunkCount: storedChunks.length,
          graphEntityCount: graphProjection.entities.length,
          graphRelationCount: graphProjection.relations.length,
          graphEvidenceCount: graphProjection.relations.reduce(
            (count, relation) => count + relation.evidence.length,
            0,
          ),
          semanticIndexed: embeddingBatch !== null,
          embeddingModel: embeddingBatch?.model ?? null,
          embeddingIndexVersionId: embeddingIndex?.id ?? null,
          current: shouldPublish,
          publicationRequired: false,
          automaticPublication: shouldPublish,
          parseQualityScore: parseQuality.score,
          parseReviewRequired: identity.sourceType === 'FILE' || identity.sourceType === 'WEB',
          parseLowQualityReasons: parseQuality.diagnostics.lowQualityReasons,
          securityScanVerdict: securityScan?.verdict ?? 'not_applicable',
          securityScanner: securityScan?.scanner ?? null,
        },
      );
    });
    finishStage('postgresPersistMs');
    this.logger.log(
      JSON.stringify({
        event: 'knowledge.ingestion.stage_timings',
        tenantId: identity.tenantId,
        knowledgeBaseId: identity.knowledgeBaseId,
        documentId: identity.documentId,
        documentVersionId: identity.documentVersionId,
        mimeType: identity.mimeType,
        sourceBytes: bytes.byteLength,
        pageCount: parsed.pages?.length ?? null,
        characterCount: parsed.metadata.characterCount,
        parentChunkCount: storedParents.length,
        chunkCount: storedChunks.length,
        embeddingBatchCount: embeddingBatch === null ? 0 : Math.ceil(storedChunks.length / 64),
        embeddingInputTokens: embeddingBatch?.inputTokens ?? null,
        ...timings,
        totalMs: Math.round(performance.now() - startedAt),
      }),
    );
    if (automaticallyPublished) {
      try {
        await this.syncSearchDocumentVersion(
          { tenantId: identity.tenantId },
          {
            knowledgeBaseId: identity.knowledgeBaseId,
            documentId: identity.documentId,
            documentVersionId: identity.documentVersionId,
            active: true,
          },
        );
      } catch (error) {
        this.logger.warn(
          `Knowledge document ${identity.documentVersionId} is usable in PostgreSQL, but external search-index activation must be retried (${error instanceof Error ? error.name : 'UnknownError'}).`,
        );
      }
    }
  }

  private async advance(
    identity: IngestionIdentity,
    workerId: string,
    stage: 'SECURITY_CHECK' | 'PARSING' | 'CHUNKING' | 'INDEXING',
    progress: number,
  ): Promise<void> {
    const updated = await this.prisma.withTenant(identity.tenantId, (transaction) =>
      transaction.knowledgeIngestionJob.updateMany({
        where: {
          tenantId: identity.tenantId,
          id: requireIngestionJobId(identity),
          status: 'RUNNING',
          claimedBy: workerId,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { stage, progress },
      }),
    );
    if (updated.count !== 1) throw new KnowledgeIngestionLeaseLostError();
  }

  private async failBeforeEnqueue(identity: IngestionIdentity, error: unknown): Promise<void> {
    const failure = describeKnowledgeIngestionError(error);
    await this.prisma.withTenant(identity.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, identity.tenantId, identity.documentId);
      if (identity.jobId !== null) {
        await transaction.knowledgeIngestionJob.updateMany({
          where: {
            tenantId: identity.tenantId,
            id: identity.jobId,
            documentVersionId: identity.documentVersionId,
            status: 'PENDING',
          },
          data: {
            status: 'FAILED',
            errorCode: failure.code,
            errorMessage: failure.message,
            finishedAt: new Date(),
          },
        });
      }
      await transaction.knowledgeDocumentVersion.updateMany({
        where: {
          tenantId: identity.tenantId,
          id: identity.documentVersionId,
          status: 'PROCESSING',
        },
        data: { status: 'FAILED' },
      });
      const document = await transaction.knowledgeDocument.findFirst({
        where: { tenantId: identity.tenantId, id: identity.documentId },
        select: { currentVersionId: true, status: true },
      });
      if (document?.currentVersionId === null && document.status !== 'ARCHIVED') {
        await transaction.knowledgeDocument.updateMany({
          where: { tenantId: identity.tenantId, id: identity.documentId },
          data: { status: 'FAILED' },
        });
      }
      await recordAdminAudit(
        transaction,
        { tenantId: identity.tenantId, userId: identity.actorUserId },
        'admin.knowledge-document-version.ingestion-failed',
        'knowledge_document_version',
        identity.documentVersionId,
        { errorCode: failure.code, queued: false },
      );
    });
  }
}

export interface ActivatedKnowledgeGraphProjection {
  readonly projectionId: string;
  readonly graphHash: string;
}

/**
 * Promotes the exact candidate while the caller holds the document
 * advisory lock. Because this runs on the caller's Prisma transaction, the
 * document current-version CAS and graph lifecycle switch commit atomically.
 * A missing projection is valid: graph retrieval is an optional enhancement.
 */
export async function activateKnowledgeGraphProjection(
  transaction: Prisma.TransactionClient,
  identity: Omit<KnowledgeGraphPersistenceIdentity, 'actorUserId'>,
): Promise<ActivatedKnowledgeGraphProjection | null> {
  const candidates = await transaction.$queryRaw<
    Array<{ readonly id: string; readonly graph_hash: string }>
  >(Prisma.sql`
    SELECT "id"::text AS id, "graph_hash"
    FROM public."knowledge_graph_projections"
    WHERE "tenant_id" = ${identity.tenantId}::uuid
      AND "knowledge_base_id" = ${identity.knowledgeBaseId}::uuid
      AND "document_id" = ${identity.documentId}::uuid
      AND "document_version_id" = ${identity.documentVersionId}::uuid
      AND "status" = 'CANDIDATE'::"KnowledgeGraphProjectionStatus"
    FOR UPDATE
  `);
  const candidate = candidates[0];
  if (candidate === undefined) return null;
  if (candidates.length !== 1) {
    throw new ConflictException('The document version has multiple candidate graph projections.');
  }
  await transaction.$executeRaw(Prisma.sql`
    UPDATE public."knowledge_graph_projections"
    SET
      "status" = 'OBSOLETE'::"KnowledgeGraphProjectionStatus",
      "obsoleted_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "tenant_id" = ${identity.tenantId}::uuid
      AND "knowledge_base_id" = ${identity.knowledgeBaseId}::uuid
      AND "document_id" = ${identity.documentId}::uuid
      AND "status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"
  `);
  const activated = await transaction.$executeRaw(Prisma.sql`
    UPDATE public."knowledge_graph_projections"
    SET
      "status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus",
      "activated_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "tenant_id" = ${identity.tenantId}::uuid
      AND "knowledge_base_id" = ${identity.knowledgeBaseId}::uuid
      AND "document_id" = ${identity.documentId}::uuid
      AND "document_version_id" = ${identity.documentVersionId}::uuid
      AND "id" = ${candidate.id}::uuid
      AND "status" = 'CANDIDATE'::"KnowledgeGraphProjectionStatus"
  `);
  if (activated !== 1) {
    throw new ConflictException(
      'The candidate graph lifecycle changed. Refresh and run publication again.',
    );
  }
  return {
    projectionId: candidate.id,
    graphHash: candidate.graph_hash.trim(),
  };
}

export async function persistKnowledgeGraphProjection(
  transaction: Prisma.TransactionClient,
  identity: KnowledgeGraphPersistenceIdentity,
  projection: KnowledgeGraphProjection,
): Promise<void> {
  const projectionId = randomUUID();
  const graphHash = stableIngestionHash({
    documentVersionId: identity.documentVersionId,
    entities: projection.entities,
    mentions: projection.mentions,
    relations: projection.relations,
  });
  const evidenceCount = projection.relations.reduce(
    (count, relation) => count + relation.evidence.length,
    0,
  );

  // Each projection is an immutable candidate snapshot. Rebuilding or uploading
  // a newer candidate retires the prior draft instead of mutating its governance
  // history, so stale conflicts can never block the current publication.
  await transaction.$executeRaw(Prisma.sql`
    UPDATE public."knowledge_graph_projections"
    SET
      "status" = 'OBSOLETE'::"KnowledgeGraphProjectionStatus",
      "obsoleted_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "tenant_id" = ${identity.tenantId}::uuid
      AND "knowledge_base_id" = ${identity.knowledgeBaseId}::uuid
      AND "document_id" = ${identity.documentId}::uuid
      AND "status" = 'CANDIDATE'::"KnowledgeGraphProjectionStatus"
  `);
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public."knowledge_graph_projections"(
      "id",
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "status",
      "graph_hash",
      "entity_count",
      "mention_count",
      "relation_count",
      "evidence_count",
      "created_by_user_id"
    ) VALUES (
      ${projectionId}::uuid,
      ${identity.tenantId}::uuid,
      ${identity.knowledgeBaseId}::uuid,
      ${identity.documentId}::uuid,
      ${identity.documentVersionId}::uuid,
      'CANDIDATE'::"KnowledgeGraphProjectionStatus",
      ${graphHash},
      ${projection.entities.length},
      ${projection.mentions.length},
      ${projection.relations.length},
      ${evidenceCount},
      ${identity.actorUserId}::uuid
    )
  `);

  const entityIdByKey = new Map<string, string>();
  for (const entity of projection.entities) {
    const boundedAliases = normalizeKnowledgeEntityAliases(entity.canonicalName, entity.aliases);
    const aliasesSql =
      boundedAliases.length === 0
        ? Prisma.sql`ARRAY[]::text[]`
        : Prisma.sql`ARRAY[${Prisma.join(boundedAliases)}]::text[]`;
    const identityConflict =
      entity.externalKey === null
        ? Prisma.sql`
            ON CONFLICT (
              "tenant_id",
              "knowledge_base_id",
              "entity_type",
              "normalized_name"
            ) WHERE "external_key" IS NULL
          `
        : Prisma.sql`
            ON CONFLICT (
              "tenant_id",
              "knowledge_base_id",
              "entity_type",
              "external_key"
            ) WHERE "external_key" IS NOT NULL
          `;
    const rows = await transaction.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      INSERT INTO public."knowledge_entities" (
        "id",
        "tenant_id",
        "knowledge_base_id",
        "entity_type",
        "canonical_name",
        "normalized_name",
        "external_key",
        "description",
        "aliases",
        "attributes",
        "confidence"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${identity.tenantId}::uuid,
        ${identity.knowledgeBaseId}::uuid,
        ${entity.entityType},
        ${entity.canonicalName},
        ${entity.normalizedName},
        ${entity.externalKey},
        ${entity.description},
        ${aliasesSql},
        ${JSON.stringify(entity.attributes)}::jsonb,
        ${entity.confidence}
      )
      ${identityConflict}
      DO UPDATE SET
        "canonical_name" = EXCLUDED."canonical_name",
        "normalized_name" = EXCLUDED."normalized_name",
        "aliases" = ARRAY(
          SELECT merged.alias
          FROM (
            SELECT candidate.alias, min(candidate.ordinality) AS first_position
            FROM unnest(
              public."knowledge_entities"."aliases"
              || CASE
                WHEN public."knowledge_entities"."canonical_name" <> EXCLUDED."canonical_name"
                  THEN ARRAY[public."knowledge_entities"."canonical_name"]::text[]
                ELSE ARRAY[]::text[]
              END
              || EXCLUDED."aliases"
            ) WITH ORDINALITY AS candidate(alias, ordinality)
            WHERE char_length(candidate.alias) BETWEEN 2 AND ${MAX_PERSISTED_ENTITY_ALIAS_LENGTH}
              AND candidate.alias = btrim(candidate.alias)
              AND candidate.alias <> EXCLUDED."canonical_name"
            GROUP BY candidate.alias
          ) AS merged
          ORDER BY merged.first_position, merged.alias
          LIMIT ${MAX_PERSISTED_ENTITY_ALIASES}
        ),
        "attributes" = public."knowledge_entities"."attributes" || EXCLUDED."attributes",
        "confidence" = greatest(
          public."knowledge_entities"."confidence",
          EXCLUDED."confidence"
        ),
        "updated_at" = now()
      RETURNING "id"::text AS id
    `);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('KNOWLEDGE_GRAPH_ENTITY_UPSERT_FAILED');
    entityIdByKey.set(entity.key, id);
  }

  for (const mention of projection.mentions) {
    const entityId = entityIdByKey.get(mention.entityKey);
    if (entityId === undefined) throw new Error('KNOWLEDGE_GRAPH_ENTITY_REFERENCE_MISSING');
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO public."knowledge_entity_mentions" (
        "id",
        "tenant_id",
        "knowledge_base_id",
        "projection_id",
        "entity_id",
        "document_id",
        "document_version_id",
        "chunk_id",
        "surface_form",
        "start_offset",
        "end_offset",
        "confidence",
        "extractor",
        "metadata"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${identity.tenantId}::uuid,
        ${identity.knowledgeBaseId}::uuid,
        ${projectionId}::uuid,
        ${entityId}::uuid,
        ${identity.documentId}::uuid,
        ${identity.documentVersionId}::uuid,
        ${mention.chunkId}::uuid,
        ${mention.surfaceForm},
        ${mention.startOffset},
        ${mention.endOffset},
        ${mention.confidence},
        ${mention.extractor},
        ${JSON.stringify(mention.metadata)}::jsonb
      )
      ON CONFLICT DO NOTHING
    `);
  }

  for (const relation of projection.relations) {
    const subjectEntityId = entityIdByKey.get(relation.subjectEntityKey);
    const objectEntityId = entityIdByKey.get(relation.objectEntityKey);
    if (subjectEntityId === undefined || objectEntityId === undefined) {
      throw new Error('KNOWLEDGE_GRAPH_RELATION_REFERENCE_MISSING');
    }
    const rows = await transaction.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      INSERT INTO public."knowledge_relations" (
        "id",
        "tenant_id",
        "knowledge_base_id",
        "subject_entity_id",
        "predicate",
        "normalized_predicate",
        "object_entity_id",
        "attributes",
        "confidence"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${identity.tenantId}::uuid,
        ${identity.knowledgeBaseId}::uuid,
        ${subjectEntityId}::uuid,
        ${relation.predicate},
        ${relation.normalizedPredicate},
        ${objectEntityId}::uuid,
        ${JSON.stringify(relation.attributes)}::jsonb,
        ${relation.confidence}
      )
      ON CONFLICT (
        "tenant_id",
        "knowledge_base_id",
        "subject_entity_id",
        "normalized_predicate",
        "object_entity_id"
      )
      DO UPDATE SET
        "predicate" = EXCLUDED."predicate",
        "attributes" = public."knowledge_relations"."attributes" || EXCLUDED."attributes",
        "confidence" = greatest(
          public."knowledge_relations"."confidence",
          EXCLUDED."confidence"
        ),
        "updated_at" = now()
      RETURNING "id"::text AS id
    `);
    const relationId = rows[0]?.id;
    if (relationId === undefined) throw new Error('KNOWLEDGE_GRAPH_RELATION_UPSERT_FAILED');

    for (const evidence of relation.evidence) {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO public."knowledge_relation_evidence" (
          "id",
          "tenant_id",
          "knowledge_base_id",
          "projection_id",
          "relation_id",
          "document_id",
          "document_version_id",
          "chunk_id",
          "excerpt",
          "start_offset",
          "end_offset",
          "confidence",
          "extractor",
          "metadata"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${identity.tenantId}::uuid,
          ${identity.knowledgeBaseId}::uuid,
          ${projectionId}::uuid,
          ${relationId}::uuid,
          ${identity.documentId}::uuid,
          ${identity.documentVersionId}::uuid,
          ${evidence.chunkId}::uuid,
          ${evidence.excerpt},
          ${evidence.startOffset},
          ${evidence.endOffset},
          ${evidence.confidence},
          ${evidence.extractor},
          ${JSON.stringify(evidence.metadata)}::jsonb
        )
        ON CONFLICT DO NOTHING
      `);
    }

    await ensureProjectedRelationGovernanceCandidate(transaction, identity, {
      projectionId,
      relationId,
      subjectEntityId,
      objectEntityId,
      normalizedPredicate: relation.normalizedPredicate,
      confidence: relation.confidence,
      evidence: relation.evidence,
    });
  }

  await transaction.$executeRaw(Prisma.sql`
    DELETE FROM public."knowledge_relations" AS relation
    WHERE relation."tenant_id" = ${identity.tenantId}::uuid
      AND relation."knowledge_base_id" = ${identity.knowledgeBaseId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM public."knowledge_relation_evidence" AS evidence
        WHERE evidence."tenant_id" = relation."tenant_id"
          AND evidence."knowledge_base_id" = relation."knowledge_base_id"
          AND evidence."relation_id" = relation."id"
      )
  `);
  await transaction.$executeRaw(Prisma.sql`
    DELETE FROM public."knowledge_entities" AS entity
    WHERE entity."tenant_id" = ${identity.tenantId}::uuid
      AND entity."knowledge_base_id" = ${identity.knowledgeBaseId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM public."knowledge_entity_mentions" AS mention
        WHERE mention."tenant_id" = entity."tenant_id"
          AND mention."knowledge_base_id" = entity."knowledge_base_id"
          AND mention."entity_id" = entity."id"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public."knowledge_relations" AS relation
        WHERE relation."tenant_id" = entity."tenant_id"
          AND relation."knowledge_base_id" = entity."knowledge_base_id"
          AND (
            relation."subject_entity_id" = entity."id"
            OR relation."object_entity_id" = entity."id"
          )
      )
  `);
}

interface ProjectedRelationGovernanceInput {
  readonly projectionId: string;
  readonly relationId: string;
  readonly subjectEntityId: string;
  readonly objectEntityId: string;
  readonly normalizedPredicate: string;
  readonly confidence: number;
  readonly evidence: KnowledgeGraphProjection['relations'][number]['evidence'];
}

interface PublishedRelationMappingRow {
  readonly ontology_version_id: string;
  readonly predicate_definition_id: string;
  readonly relation_created_at: Date;
  readonly subject_type: string;
  readonly object_type: string;
}

/**
 * Extracted graph edges are candidates, never trusted retrieval facts. A relation that
 * matches a published ontology is queued as a maker/checker correction; an unmapped
 * relation is surfaced as an explicit conflict. Only an independently approved and
 * applied correction can populate knowledge_relation_governance.
 */
async function ensureProjectedRelationGovernanceCandidate(
  transaction: Prisma.TransactionClient,
  identity: KnowledgeGraphPersistenceIdentity,
  relation: ProjectedRelationGovernanceInput,
): Promise<void> {
  const existing = await transaction.$queryRaw<Array<{ readonly present: boolean }>>(Prisma.sql`
    SELECT true AS present
    FROM public.knowledge_relation_governance
    WHERE tenant_id = ${identity.tenantId}::uuid
      AND knowledge_base_id = ${identity.knowledgeBaseId}::uuid
      AND relation_id = ${relation.relationId}::uuid
    LIMIT 1
  `);
  if (existing[0]?.present === true) return;

  const mappings = await transaction.$queryRaw<PublishedRelationMappingRow[]>(Prisma.sql`
    SELECT
      version.id::text AS ontology_version_id,
      predicate.id::text AS predicate_definition_id,
      relation.created_at AS relation_created_at,
      subject.entity_type AS subject_type,
      object.entity_type AS object_type
    FROM public.knowledge_relations relation
    JOIN public.knowledge_entities subject
      ON subject.tenant_id = relation.tenant_id
     AND subject.knowledge_base_id = relation.knowledge_base_id
     AND subject.id = relation.subject_entity_id
    JOIN public.knowledge_entities object
      ON object.tenant_id = relation.tenant_id
     AND object.knowledge_base_id = relation.knowledge_base_id
     AND object.id = relation.object_entity_id
    JOIN public.knowledge_ontology_versions version
      ON version.tenant_id = relation.tenant_id
     AND version.knowledge_base_id = relation.knowledge_base_id
     AND version.status = 'PUBLISHED'
    JOIN public.knowledge_ontology_predicates predicate
      ON predicate.tenant_id = version.tenant_id
     AND predicate.knowledge_base_id = version.knowledge_base_id
     AND predicate.ontology_version_id = version.id
     AND predicate.predicate = relation.normalized_predicate
     AND predicate.domain_type_key = CASE
       WHEN regexp_replace(upper(subject.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
         THEN 'TYPE_' || substr(md5(subject.entity_type), 1, 8)
       ELSE left(regexp_replace(upper(subject.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
     END
     AND predicate.range_type_key = CASE
       WHEN regexp_replace(upper(object.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
         THEN 'TYPE_' || substr(md5(object.entity_type), 1, 8)
       ELSE left(regexp_replace(upper(object.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
     END
    WHERE relation.tenant_id = ${identity.tenantId}::uuid
      AND relation.knowledge_base_id = ${identity.knowledgeBaseId}::uuid
      AND relation.id = ${relation.relationId}::uuid
      AND relation.subject_entity_id = ${relation.subjectEntityId}::uuid
      AND relation.object_entity_id = ${relation.objectEntityId}::uuid
    ORDER BY version.system_bootstrap ASC,
      version.published_at DESC NULLS LAST,
      version.version_number DESC,
      version.id
    LIMIT 1
  `);
  const mapping = mappings[0];
  if (mapping !== undefined) {
    await queueMappedRelationCorrection(transaction, identity, relation, mapping);
    return;
  }

  const types = await transaction.$queryRaw<
    Array<{ readonly subject_type: string; readonly object_type: string }>
  >(Prisma.sql`
    SELECT subject.entity_type AS subject_type, object.entity_type AS object_type
    FROM public.knowledge_relations relation
    JOIN public.knowledge_entities subject
      ON subject.tenant_id = relation.tenant_id
     AND subject.knowledge_base_id = relation.knowledge_base_id
     AND subject.id = relation.subject_entity_id
    JOIN public.knowledge_entities object
      ON object.tenant_id = relation.tenant_id
     AND object.knowledge_base_id = relation.knowledge_base_id
     AND object.id = relation.object_entity_id
    WHERE relation.tenant_id = ${identity.tenantId}::uuid
      AND relation.knowledge_base_id = ${identity.knowledgeBaseId}::uuid
      AND relation.id = ${relation.relationId}::uuid
  `);
  await queueUnmappedRelationConflict(transaction, identity, relation, types[0]);
}

async function queueMappedRelationCorrection(
  transaction: Prisma.TransactionClient,
  identity: KnowledgeGraphPersistenceIdentity,
  relation: ProjectedRelationGovernanceInput,
  mapping: PublishedRelationMappingRow,
): Promise<void> {
  const patch = {
    relationId: relation.relationId,
    ontologyVersionId: mapping.ontology_version_id,
    predicateDefinitionId: mapping.predicate_definition_id,
    validFrom: mapping.relation_created_at.toISOString(),
    validTo: null,
  };
  const evidence = projectedRelationReviewEvidence(identity, relation);
  const requestHash = stableIngestionHash({
    action: 'UPSERT_RELATION_VALIDITY',
    patch,
    evidence,
  });
  const idempotencyKey = `kg-auto-correction:${relation.relationId}`;
  const rows = await transaction.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
    INSERT INTO public.knowledge_graph_corrections(
      tenant_id, knowledge_base_id, action, patch, evidence, evidence_hash,
      proposed_by_user_id, idempotency_key, request_hash
    ) VALUES (
      ${identity.tenantId}::uuid,
      ${identity.knowledgeBaseId}::uuid,
      'UPSERT_RELATION_VALIDITY',
      ${JSON.stringify(patch)}::jsonb,
      ${JSON.stringify(evidence)}::jsonb,
      ${stableIngestionHash(evidence)},
      ${identity.actorUserId}::uuid,
      ${idempotencyKey},
      ${requestHash}
    )
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id::text AS id
  `);
  const correctionId = rows[0]?.id;
  if (correctionId === undefined) return;

  await recordProjectedGraphGovernanceMutation(transaction, identity, {
    commandType: 'AUTO_PROPOSE_RELATION_GOVERNANCE',
    idempotencyKey: `kg-auto-command:${relation.relationId}`,
    requestHash,
    resourceType: 'knowledge_graph_correction',
    resourceId: correctionId,
    action: 'admin.knowledge-graph-correction.auto-proposed',
    metadata: {
      relationId: relation.relationId,
      ontologyVersionId: mapping.ontology_version_id,
      predicateDefinitionId: mapping.predicate_definition_id,
      status: 'DRAFT',
      trustedForRetrieval: false,
    },
  });
}

async function queueUnmappedRelationConflict(
  transaction: Prisma.TransactionClient,
  identity: KnowledgeGraphPersistenceIdentity,
  relation: ProjectedRelationGovernanceInput,
  types: { readonly subject_type: string; readonly object_type: string } | undefined,
): Promise<void> {
  const subjectType = types?.subject_type ?? 'UNKNOWN';
  const objectType = types?.object_type ?? 'UNKNOWN';
  const schemaSignature = stableIngestionHash({
    projectionId: relation.projectionId,
    predicate: relation.normalizedPredicate,
    subjectType,
    objectType,
  });
  const conflictKey = `SCHEMA_GAP:${relation.projectionId}:${schemaSignature.slice(0, 32)}`;
  const details = {
    projectionId: relation.projectionId,
    documentVersionId: identity.documentVersionId,
    exampleRelationId: relation.relationId,
    predicate: relation.normalizedPredicate,
    subjectEntityType: subjectType,
    objectEntityType: objectType,
    occurrenceCount: 1,
    remediation:
      'Publish an ontology predicate for this domain/range pair, then submit and independently approve a relation-validity correction.',
  };
  const evidence = projectedRelationReviewEvidence(identity, relation);
  const requestHash = stableIngestionHash({
    conflictKey,
    projectionId: relation.projectionId,
    predicate: relation.normalizedPredicate,
    subjectType,
    objectType,
  });
  const idempotencyKey = `kg-schema-gap:${relation.projectionId}:${schemaSignature.slice(0, 32)}`;
  const rows = await transaction.$queryRaw<
    Array<{ readonly id: string; readonly revision: number }>
  >(Prisma.sql`
    INSERT INTO public.knowledge_graph_conflicts(
      tenant_id, knowledge_base_id, projection_id, document_version_id,
      target_type, target_id, conflict_key, conflict_type,
      schema_predicate, schema_subject_type, schema_object_type,
      occurrence_count, details, evidence,
      detected_by_user_id, idempotency_key, request_hash
    ) VALUES (
      ${identity.tenantId}::uuid,
      ${identity.knowledgeBaseId}::uuid,
      ${relation.projectionId}::uuid,
      ${identity.documentVersionId}::uuid,
      'RELATION',
      ${relation.relationId}::uuid,
      ${conflictKey},
      'ONTOLOGY.SCHEMA.GAP',
      ${relation.normalizedPredicate},
      ${subjectType},
      ${objectType},
      1,
      ${JSON.stringify(details)}::jsonb,
      ${JSON.stringify(evidence)}::jsonb,
      ${identity.actorUserId}::uuid,
      ${idempotencyKey},
      ${requestHash}
    )
    ON CONFLICT (tenant_id, knowledge_base_id, conflict_key)
    DO UPDATE SET
      occurrence_count = public.knowledge_graph_conflicts.occurrence_count + 1,
      details = jsonb_set(
        public.knowledge_graph_conflicts.details,
        '{occurrenceCount}',
        to_jsonb(public.knowledge_graph_conflicts.occurrence_count + 1),
        true
      ),
      evidence = (
        SELECT coalesce(jsonb_agg(sample.value ORDER BY sample.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements(
          public.knowledge_graph_conflicts.evidence || EXCLUDED.evidence
        ) WITH ORDINALITY AS sample(value, ordinality)
        WHERE sample.ordinality <= 100
      ),
      revision = public.knowledge_graph_conflicts.revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE public.knowledge_graph_conflicts.status = 'OPEN'
      AND public.knowledge_graph_conflicts.projection_id = EXCLUDED.projection_id
      AND public.knowledge_graph_conflicts.schema_predicate = EXCLUDED.schema_predicate
      AND public.knowledge_graph_conflicts.schema_subject_type = EXCLUDED.schema_subject_type
      AND public.knowledge_graph_conflicts.schema_object_type = EXCLUDED.schema_object_type
    RETURNING id::text AS id, revision
  `);
  const conflict = rows[0];
  if (conflict === undefined || conflict.revision !== 1) return;

  await recordProjectedGraphGovernanceMutation(transaction, identity, {
    commandType: 'AUTO_DETECT_ONTOLOGY_MAPPING_GAP',
    idempotencyKey: `kg-auto-command-conflict:${relation.projectionId}:${schemaSignature.slice(0, 32)}`,
    requestHash,
    resourceType: 'knowledge_graph_conflict',
    resourceId: conflict.id,
    action: 'admin.knowledge-graph-conflict.auto-detected',
    metadata: {
      projectionId: relation.projectionId,
      documentVersionId: identity.documentVersionId,
      exampleRelationId: relation.relationId,
      predicate: relation.normalizedPredicate,
      subjectEntityType: subjectType,
      objectEntityType: objectType,
      status: 'OPEN',
      occurrenceCount: 1,
      trustedForRetrieval: false,
    },
  });
}

function projectedRelationReviewEvidence(
  identity: KnowledgeGraphPersistenceIdentity,
  relation: ProjectedRelationGovernanceInput,
): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      source: 'KNOWLEDGE_GRAPH_PROJECTION',
      projectionId: relation.projectionId,
      documentId: identity.documentId,
      documentVersionId: identity.documentVersionId,
      relationId: relation.relationId,
      confidence: relation.confidence,
      excerpts: relation.evidence.slice(0, 20),
    },
  ];
}

async function recordProjectedGraphGovernanceMutation(
  transaction: Prisma.TransactionClient,
  identity: KnowledgeGraphPersistenceIdentity,
  input: {
    readonly commandType: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly action: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO public.knowledge_graph_commands(
      tenant_id, knowledge_base_id, command_type, idempotency_key,
      request_hash, resource_type, resource_id, result_revision, actor_user_id
    ) VALUES (
      ${identity.tenantId}::uuid,
      ${identity.knowledgeBaseId}::uuid,
      ${input.commandType},
      ${input.idempotencyKey},
      ${input.requestHash},
      ${input.resourceType},
      ${input.resourceId}::uuid,
      1,
      ${identity.actorUserId}::uuid
    )
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  `);
  await transaction.auditEvent.create({
    data: {
      tenantId: identity.tenantId,
      actorType: 'USER',
      actorId: identity.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata as Prisma.InputJsonObject,
    },
  });
  await transaction.outboxEvent.create({
    data: {
      tenantId: identity.tenantId,
      aggregateType: input.resourceType,
      aggregateId: input.resourceId,
      eventType: input.action,
      payload: {
        ...input.metadata,
        knowledgeBaseId: identity.knowledgeBaseId,
        revision: 1,
      } as Prisma.InputJsonObject,
    },
  });
}

async function lockKnowledgeDocument(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  documentKey: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:knowledge-document:${documentKey}`}, 0))::text
  `;
}

async function requireActiveDocumentAndKnowledgeBase(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<void> {
  const [knowledgeBase, document] = await Promise.all([
    transaction.knowledgeBase.findFirst({
      where: { tenantId, id: knowledgeBaseId },
      select: { status: true },
    }),
    transaction.knowledgeDocument.findFirst({
      where: { tenantId, knowledgeBaseId, id: documentId },
      select: { status: true },
    }),
  ]);
  if (knowledgeBase === null) throw new NotFoundException('The knowledge base was not found.');
  if (document === null) throw new NotFoundException('The knowledge document was not found.');
  if (knowledgeBase.status === 'ARCHIVED') {
    throw new ConflictException('An archived knowledge base cannot process document versions.');
  }
  if (document.status === 'ARCHIVED') {
    throw new ConflictException('An archived document cannot process document versions.');
  }
}

export function normalizeKnowledgeEntityAliases(
  canonicalName: string,
  candidates: readonly string[],
): readonly string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const alias = candidate
      .replace(/\s+/g, ' ')
      .replace(
        /^[\s"'“”‘’「」『』【】()\[\]，,。；;：:]+|[\s"'“”‘’「」『』【】()\[\]，,。；;：:]+$/gu,
        '',
      )
      .trim()
      .slice(0, MAX_PERSISTED_ENTITY_ALIAS_LENGTH);
    if (alias.length < 2 || alias === canonicalName || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
    if (aliases.length === MAX_PERSISTED_ENTITY_ALIASES) break;
  }
  return aliases;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableIngestionHash(value: unknown): string {
  return sha256(stableIngestionJson(value));
}

function stableIngestionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableIngestionJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableIngestionJson(record[key])}`)
    .join(',')}}`;
}

function chunkParsedKnowledgeDocument(
  parsed: ParsedKnowledgeDocument,
  options: { readonly targetTokens: number; readonly overlapTokens: number },
): {
  readonly parents: Array<KnowledgeDocumentParentChunk & { metadata: Prisma.InputJsonObject }>;
  readonly chunks: Array<KnowledgeDocumentChunk & { metadata: Prisma.InputJsonObject }>;
} {
  if (parsed.metadata.mimeType !== 'application/pdf') {
    const hierarchy = chunkKnowledgeDocumentWithParents(
      {
        content: parsed.text,
        sourceType: parsed.metadata.sourceType,
      },
      options,
    );
    return {
      parents: hierarchy.parents.map((parent) => ({
        ...parent,
        metadata: sourceLocatorMetadata(parsed, parent.headingPath),
      })),
      chunks: hierarchy.chunks.map((chunk) => ({
        ...chunk,
        metadata: sourceLocatorMetadata(parsed, chunk.headingPath),
      })),
    };
  }

  const pageCount = parsed.metadata.pageCount;
  const pages = parsed.pages;
  if (
    pages === undefined ||
    pageCount === undefined ||
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0 ||
    pages.length !== pageCount
  ) {
    throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
  }

  const parents: Array<KnowledgeDocumentParentChunk & { metadata: Prisma.InputJsonObject }> = [];
  const chunks: Array<KnowledgeDocumentChunk & { metadata: Prisma.InputJsonObject }> = [];
  for (const [pageIndex, page] of pages.entries()) {
    // The parser includes empty pages, so a gap, duplicate, or reordering is a
    // provenance failure rather than a page that should be silently ignored.
    if (page.pageNumber !== pageIndex + 1) {
      throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
    }
    const pageHierarchy = chunkKnowledgeDocumentWithParents(
      {
        content: page.text,
        sourceType: parsed.metadata.sourceType,
      },
      options,
    );
    const parentOffset = parents.length;
    const pageMetadata = {
      ...parsed.metadata,
      pageStart: page.pageNumber,
      pageEnd: page.pageNumber,
      pageCount,
      parser: parsed.metadata.parser ?? PDF_PARSER_NAME,
    } satisfies Prisma.InputJsonObject;
    for (const pageParent of pageHierarchy.parents) {
      parents.push({
        ...pageParent,
        parentIndex: parents.length,
        metadata: pageMetadata,
      });
    }
    for (const pageChunk of pageHierarchy.chunks) {
      chunks.push({
        ...pageChunk,
        parentIndex: parentOffset + pageChunk.parentIndex,
        chunkIndex: chunks.length,
        metadata: pageMetadata,
      });
    }
  }
  return { parents, chunks };
}

function sourceLocatorMetadata(
  parsed: ParsedKnowledgeDocument,
  headingPath: readonly string[],
): Prisma.InputJsonObject {
  const sheetHeading = headingPath.find((heading) => heading.startsWith('工作表：'));
  return {
    ...parsed.metadata,
    ...(sheetHeading === undefined ? {} : { sheetName: sheetHeading.slice('工作表：'.length) }),
  } as unknown as Prisma.InputJsonObject;
}

function requireArrayValue<Value>(values: readonly Value[], index: number, code: string): Value {
  const value = values[index];
  if (value === undefined) throw new Error(code);
  return value;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 1_536 || vector.some((component) => !Number.isFinite(component))) {
    throw new Error('KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH');
  }
  return `[${vector.join(',')}]`;
}

function serializeStructuredKnowledgeDocument(parsed: ParsedKnowledgeDocument): Buffer {
  const artifact =
    parsed.structuredContent ??
    ({
      schemaVersion: STRUCTURED_KNOWLEDGE_FORMAT,
      kind: parsed.pages === undefined ? 'document' : 'paged-document',
      mimeType: parsed.metadata.mimeType,
      parser: parsed.metadata.parser ?? null,
      text: parsed.text,
      ...(parsed.pages === undefined ? {} : { pages: parsed.pages }),
    } satisfies Readonly<Record<string, unknown>>);
  let serialized: string;
  try {
    serialized = JSON.stringify(artifact);
  } catch {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  if (serialized.length === 0) {
    throw new DocumentParsingError('DOCUMENT_PARSER_INVALID_RESPONSE');
  }
  return Buffer.from(serialized, 'utf8');
}

function structuredPreview(content: unknown): {
  readonly value: unknown;
  readonly truncated: boolean;
} {
  let remainingNodes = 2_500;
  let truncated = false;
  const visit = (value: unknown, depth: number): unknown => {
    remainingNodes -= 1;
    if (remainingNodes < 0 || depth > 10) {
      truncated = true;
      return { $previewTruncated: true };
    }
    if (typeof value === 'string') {
      if (value.length <= 4_000) return value;
      truncated = true;
      return `${value.slice(0, 4_000)}…`;
    }
    if (Array.isArray(value)) {
      if (value.length > 100) truncated = true;
      return value.slice(0, 100).map((item) => visit(item, depth + 1));
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          visit(item, depth + 1),
        ]),
      );
    }
    return value;
  };
  return { value: visit(content, 0), truncated };
}

function parseStoredVector(value: string): readonly number[] {
  const normalized = value.trim();
  if (!normalized.startsWith('[') || !normalized.endsWith(']')) {
    throw new Error('KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH');
  }
  const vector = normalized
    .slice(1, -1)
    .split(',')
    .map((component) => Number(component));
  vectorLiteral(vector);
  return vector;
}

function isRemoteDocumentParserMimeType(mimeType: string): boolean {
  return (
    mimeType === 'application/pdf' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-powerpoint' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType.startsWith('image/')
  );
}

function requireIngestionJobId(identity: IngestionIdentity): string {
  if (identity.jobId === null) throw new Error('KNOWLEDGE_INGESTION_JOB_MISSING');
  return identity.jobId;
}

function pendingJob(tenantId: string, documentVersionId: string, availableAt = new Date()) {
  return {
    tenantId,
    documentVersionId,
    status: 'PENDING' as const,
    stage: 'UPLOADED' as const,
    progress: 5,
    attempts: 0,
    availableAt,
  };
}

function knowledgeGovernanceCreateData(
  requested: KnowledgeDocumentGovernancePolicy | undefined,
  previous: {
    readonly id: string;
    readonly governanceOwnerUserId: string | null;
    readonly classification: string;
    readonly scopeMode: string;
    readonly organizationScopeIds: readonly string[];
    readonly projectScopeIds: readonly string[];
    readonly taskScopeIds: readonly string[];
    readonly roleTemplateScopeIds: readonly string[];
    readonly dataLabels: readonly string[];
    readonly retentionUntil: Date | null;
    readonly retentionAction: string;
  } | null,
  actorUserId: string,
) {
  if (requested !== undefined) {
    return {
      governanceOwnerUserId: actorUserId,
      classification: requested.classification,
      scopeMode: requested.scopeMode,
      organizationScopeIds: sortedUnique(requested.organizationScopeIds),
      projectScopeIds: sortedUnique(requested.projectScopeIds),
      taskScopeIds: sortedUnique(requested.taskScopeIds),
      roleTemplateScopeIds: sortedUnique(requested.roleTemplateScopeIds),
      dataLabels: sortedUnique(requested.dataLabels),
      effectiveFrom: new Date(requested.effectiveFrom),
      expiresAt: requested.expiresAt === null ? null : new Date(requested.expiresAt),
      retentionUntil: requested.retentionUntil === null ? null : new Date(requested.retentionUntil),
      retentionAction: requested.retentionAction,
      supersedesVersionId: requested.supersedesVersionId,
    };
  }
  if (previous !== null) {
    return {
      governanceOwnerUserId: actorUserId,
      classification: previous.classification,
      scopeMode: previous.scopeMode,
      organizationScopeIds: [...previous.organizationScopeIds],
      projectScopeIds: [...previous.projectScopeIds],
      taskScopeIds: [...previous.taskScopeIds],
      roleTemplateScopeIds: [...previous.roleTemplateScopeIds],
      dataLabels: [...previous.dataLabels],
      effectiveFrom: new Date(),
      expiresAt: null,
      retentionUntil: previous.retentionUntil,
      retentionAction: previous.retentionAction,
      supersedesVersionId: previous.id,
    };
  }
  return {
    governanceOwnerUserId: actorUserId,
    classification: 'INTERNAL',
    scopeMode: 'TENANT',
    organizationScopeIds: [],
    projectScopeIds: [],
    taskScopeIds: [],
    roleTemplateScopeIds: [],
    dataLabels: [],
    effectiveFrom: new Date(),
    expiresAt: null,
    retentionUntil: null,
    retentionAction: 'ARCHIVE',
    supersedesVersionId: null,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

async function hasOwnedClaim(
  transaction: Prisma.TransactionClient,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ readonly owned: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM public."knowledge_ingestion_jobs"
      WHERE "id" = ${jobId}::uuid
        AND "status" = 'RUNNING'::"KnowledgeIngestionStatus"
        AND "claimed_by" = ${workerId}
        AND "lease_expires_at" > clock_timestamp()
    ) AS owned
  `);
  return rows[0]?.owned === true;
}

async function lockOwnedClaim(
  transaction: Prisma.TransactionClient,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
    SELECT "id"::text AS id
    FROM public."knowledge_ingestion_jobs"
    WHERE "id" = ${jobId}::uuid
      AND "status" = 'RUNNING'::"KnowledgeIngestionStatus"
      AND "claimed_by" = ${workerId}
      AND "lease_expires_at" > clock_timestamp()
    FOR UPDATE
  `);
  return rows.length === 1;
}

function assertKnowledgeIngestionLeaseActive(lease: KnowledgeIngestionLeaseControl): void {
  if (lease.signal.aborted) throw new KnowledgeIngestionLeaseLostError();
}

export function describeKnowledgeIngestionError(error: unknown): KnowledgeIngestionFailure {
  if (error instanceof KnowledgeFileSecurityError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.code),
      retryable: error.retryable,
    };
  }
  if (error instanceof DocumentParsingError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.code),
      retryable:
        error.code === 'DOCUMENT_PARSER_TIMEOUT' ||
        error.code === 'DOCUMENT_PARSER_UNAVAILABLE' ||
        // A syntactically invalid/empty response is a parser-service transport
        // failure, not proof that the source document itself is invalid. Large
        // enterprise batches can produce a transient truncated response while
        // the same document succeeds on the next isolated request.
        error.code === 'DOCUMENT_PARSER_INVALID_RESPONSE',
    };
  }
  if (error instanceof KnowledgeAiRuntimeError) {
    return {
      code: safeCode(error.code),
      message: safeErrorMessage(error.code),
      retryable: error.retryable,
    };
  }
  if (error instanceof KnowledgeObjectTooLargeError) {
    return {
      code: 'KNOWLEDGE_OBJECT_TOO_LARGE',
      message: safeErrorMessage('KNOWLEDGE_OBJECT_TOO_LARGE'),
      retryable: false,
    };
  }
  if (error instanceof KnowledgeObjectConflictError) {
    return {
      code: 'KNOWLEDGE_OBJECT_CONFLICT',
      message: safeErrorMessage('KNOWLEDGE_OBJECT_CONFLICT'),
      retryable: false,
    };
  }
  if (
    error instanceof KnowledgeObjectIntegrityError ||
    error instanceof KnowledgeObjectValidationError
  ) {
    return {
      code: 'KNOWLEDGE_OBJECT_INTEGRITY_FAILED',
      message: safeErrorMessage('KNOWLEDGE_OBJECT_INTEGRITY_FAILED'),
      retryable: false,
    };
  }
  const code =
    error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)
      ? error.message
      : 'KNOWLEDGE_INGESTION_FAILED';
  return {
    code,
    message: safeErrorMessage(code),
    retryable: code === 'KNOWLEDGE_INGESTION_FAILED',
  };
}

function safeCode(code: string): string {
  return /^[A-Z0-9_]{3,120}$/.test(code) ? code : 'KNOWLEDGE_INGESTION_FAILED';
}

function safeErrorMessage(code: string): string {
  const semanticMessages: Record<string, string> = {
    KNOWLEDGE_AI_TIMEOUT: 'Embedding service timed out. Retry the indexing job.',
    KNOWLEDGE_AI_UNAVAILABLE: 'Embedding service is unavailable. Retry the indexing job.',
    KNOWLEDGE_AI_INVALID_RESPONSE: 'Embedding service returned an invalid response.',
    KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH: 'Embedding dimensions do not match the index.',
    KNOWLEDGE_EMBEDDING_COUNT_MISMATCH: 'Embedding response did not match the document chunks.',
    KNOWLEDGE_EMBEDDING_MODEL_CHANGED: 'Embedding model changed during the indexing job.',
    KNOWLEDGE_EMBEDDING_CLASSIFICATION_NOT_APPROVED:
      'Document classification is not approved for the configured Embedding route.',
    KNOWLEDGE_DOCLING_CLASSIFICATION_NOT_APPROVED:
      'Document classification is not approved for the configured document parser route.',
    KNOWLEDGE_SEMANTIC_DISABLED: 'Semantic indexing is disabled.',
    KNOWLEDGE_EMBEDDING_BATCH_INVALID: 'Embedding request exceeded supported limits.',
    KNOWLEDGE_GRAPH_ENTITY_UPSERT_FAILED: 'Knowledge graph entity indexing failed.',
    KNOWLEDGE_GRAPH_ENTITY_REFERENCE_MISSING:
      'Knowledge graph mention referenced an unknown entity.',
    KNOWLEDGE_GRAPH_RELATION_REFERENCE_MISSING:
      'Knowledge graph relation referenced an unknown entity.',
    KNOWLEDGE_GRAPH_RELATION_UPSERT_FAILED: 'Knowledge graph relation indexing failed.',
  };
  const semanticMessage = semanticMessages[code];
  if (semanticMessage !== undefined) return semanticMessage;
  const messages: Record<string, string> = {
    KNOWLEDGE_DOCUMENT_ARCHIVED: 'The document was archived before publication completed.',
    KNOWLEDGE_BASE_ARCHIVED: 'The knowledge base was archived before publication completed.',
    KNOWLEDGE_CONTENT_SECURITY_REVIEW_REQUIRED:
      '资料可能包含敏感信息，已停止建立索引，请完成安全复核后再处理。',
    UNSUPPORTED_MIME_TYPE: '不支持该文件类型。',
    DOCUMENT_EMPTY: '上传文件为空。',
    DOCUMENT_TOO_LARGE: '文件超过当前基础设施可处理的大小。',
    INVALID_FILE_SIGNATURE: '文件内容与声明的格式不一致。',
    INVALID_TEXT_ENCODING: '文本文件不是有效的 UTF-8 编码。',
    DOCUMENT_PARSE_FAILED: '文档解析失败，请确认文件未损坏。',
    DOCUMENT_TEXT_EMPTY: '文档中没有提取到可索引文本。',
    DOCUMENT_PARSER_TIMEOUT: '文档解析服务超时，请稍后重试。',
    DOCUMENT_PARSER_UNAVAILABLE: '文档解析服务暂时不可用，请稍后重试。',
    DOCUMENT_PARSER_INVALID_RESPONSE: '文档解析服务返回了无效结果。',
    KNOWLEDGE_DOCUMENT_VERSION_UNAVAILABLE: '待处理的文档版本不存在或状态已改变。',
    KNOWLEDGE_OBJECT_TOO_LARGE: '知识文件超过对象存储大小限制。',
    KNOWLEDGE_OBJECT_CONFLICT: '知识文件对象与已有内容冲突。',
    KNOWLEDGE_OBJECT_INTEGRITY_FAILED: '知识文件完整性校验失败。',
    KNOWLEDGE_FILE_INFECTED: '知识文件未通过恶意内容扫描，已拒绝入库。',
    KNOWLEDGE_FILE_SCAN_UNAVAILABLE: '文件安全扫描服务暂时不可用，请稍后重试。',
  };
  return messages[code] ?? '文档处理失败，请重试或联系管理员。';
}

function sourceFileName(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\\/]+/gu, '_')
    .trim()
    .slice(0, 500);
  return normalized.length > 0 ? normalized : 'document.bin';
}
