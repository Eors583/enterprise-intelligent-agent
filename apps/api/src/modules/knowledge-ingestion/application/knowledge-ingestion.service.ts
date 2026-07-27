import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { AdminPrismaService } from '../../../database/admin-prisma.service.js';
import { AdminAccessService, type AdminPrincipal } from '../../admin/admin-access.service.js';
import { recordAdminAudit } from '../../admin/admin-audit.js';
import {
  KnowledgeAiRuntimeClient,
  KnowledgeAiRuntimeError,
} from '../../knowledge-semantic/knowledge-ai-runtime.client.js';
import {
  KNOWLEDGE_DOCUMENT_PARSER,
  type KnowledgeDocumentParser,
} from './knowledge-document-parser.port.js';
import type { ClaimedKnowledgeIngestionJob } from '../domain/knowledge-ingestion-job.repository.js';
import { chunkKnowledgeDocument } from '../domain/knowledge-document.chunker.js';
import { shouldPromoteKnowledgeVersion } from '../domain/knowledge-version-publication.policy.js';
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

interface IngestionIdentity {
  readonly tenantId: string;
  readonly knowledgeBaseId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly jobId: string | null;
  readonly versionNumber: number;
  readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE';
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
  readonly embeddingModel: string;
  readonly dimensions: 1536;
  readonly chunkCount: number;
}

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
      | 'uploadFileVersion'
      | 'retry'
      | 'publishDraftVersion'
      | 'rebuildEmbeddings'
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
  }): Promise<string> {
    return this.processor.createTextVersion(this.access.requireKnowledgeWrite(), input);
  }

  upload(input: {
    readonly knowledgeBaseId: string;
    readonly title: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly fileName: string;
    readonly changeSummary?: string;
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
    readonly changeSummary?: string;
  }): Promise<string> {
    return this.processor.uploadFileVersion(this.access.requireKnowledgeWrite(), input);
  }

  retry(documentVersionId: string): Promise<string> {
    return this.processor.retry(this.access.requireKnowledgeWrite(), documentVersionId);
  }

  publishDraftVersion(documentVersionId: string): Promise<string> {
    return this.processor.publishDraftVersion(
      this.access.requireKnowledgeWrite(),
      documentVersionId,
    );
  }

  rebuildEmbeddings(input: {
    readonly knowledgeBaseId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeEmbeddingRebuildResult> {
    return this.processor.rebuildEmbeddings(this.access.requireKnowledgeWrite(), input);
  }
}

@Injectable()
export class KnowledgeIngestionProcessor {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(KNOWLEDGE_DOCUMENT_PARSER) private readonly parser: KnowledgeDocumentParser,
    @Inject(KNOWLEDGE_OBJECT_STORE) private readonly objects: KnowledgeObjectStore,
    @Inject(KNOWLEDGE_FILE_SCANNER) private readonly scanner: KnowledgeFileScanner,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
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
    },
  ): Promise<string> {
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
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
    });
    return identity.documentId;
  }

  async upload(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly changeSummary?: string;
    },
  ): Promise<string> {
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
      readonly changeSummary?: string;
    },
  ): Promise<string> {
    return this.uploadFile(principal, input);
  }

  private async uploadFile(
    principal: AdminPrincipal,
    input: {
      readonly knowledgeBaseId: string;
      readonly documentId?: string;
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly changeSummary?: string;
    },
  ): Promise<string> {
    const identity = await this.createVersionRecord({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      knowledgeBaseId: input.knowledgeBaseId,
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      title: input.title,
      sourceType: 'FILE',
      mimeType: input.mimeType,
      fileName: input.fileName,
      processing: true,
      enqueue: true,
      queueAvailableAt: new Date(Date.now() + FILE_UPLOAD_RECOVERY_DELAY_MS),
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
    });
    let storedObject: StoredKnowledgeObject | undefined;
    try {
      const stored = await this.objects.putObject({
        tenantId: identity.tenantId,
        documentId: identity.documentId,
        versionId: identity.documentVersionId,
        body: input.bytes,
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
      return identity.documentId;
    } catch (error) {
      if (storedObject === undefined) {
        await this.failBeforeEnqueue(identity, error);
      }
      // Once putObject succeeds, retain the deterministic object and delayed
      // queue row. A worker can reconstruct the key and atomically restore the
      // missing object ledger; deleting here would create a crash-window race.
      return identity.documentId;
    }
  }

  async retry(principal: AdminPrincipal, documentVersionId: string): Promise<string> {
    const documentId = await this.findDocumentIdForVersion(principal.tenantId, documentVersionId);
    const identity = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId: principal.tenantId, id: documentVersionId, documentId },
        include: {
          ingestionJobs: { orderBy: { createdAt: 'desc' }, take: 1 },
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
        jobId: job.id,
        versionNumber: version.versionNumber,
        sourceType: version.sourceType,
        mimeType: version.mimeType ?? 'text/plain',
        fileName: version.fileName,
        actorUserId: principal.userId,
      };
    });
    return identity.documentId;
  }

  async publishDraftVersion(principal: AdminPrincipal, documentVersionId: string): Promise<string> {
    const documentId = await this.findDocumentIdForVersion(principal.tenantId, documentVersionId);
    const identity = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId: principal.tenantId, id: documentVersionId, documentId },
        include: {
          ingestionJobs: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      await requireActiveDocumentAndKnowledgeBase(
        transaction,
        principal.tenantId,
        version.knowledgeBaseId,
        documentId,
      );
      if (version.sourceType === 'FILE') {
        throw new BadRequestException('File versions are published through file ingestion.');
      }
      if (version.status !== 'DRAFT') {
        throw new ConflictException('Only a draft text or Markdown version can be published.');
      }
      const document = await transaction.knowledgeDocument.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id: documentId },
        select: { currentVersionId: true, documentVersion: true },
      });
      if (document.currentVersionId !== null && version.versionNumber <= document.documentVersion) {
        throw new ConflictException(
          'The draft is not newer than the current published version. Refresh and try again.',
        );
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
        jobId: job.id,
        versionNumber: version.versionNumber,
        sourceType: version.sourceType,
        mimeType:
          version.mimeType ?? (version.sourceType === 'MARKDOWN' ? 'text/markdown' : 'text/plain'),
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
    },
  ): Promise<KnowledgeEmbeddingRebuildResult> {
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
      return version.chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        contentHash: chunk.contentHash,
      }));
    });

    const embeddingBatch = await this.semantic.embedAll(
      principal.tenantId,
      snapshot.map((chunk) => chunk.content),
    );
    if (embeddingBatch.vectors.length !== snapshot.length) {
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
        currentChunks.length !== snapshot.length ||
        currentChunks.some(
          (chunk, index) =>
            chunk.id !== snapshot[index]?.id || chunk.contentHash !== snapshot[index]?.contentHash,
        )
      ) {
        throw new ConflictException('Document chunks changed while embeddings were generated.');
      }
      for (const [index, chunk] of snapshot.entries()) {
        const vector = embeddingBatch.vectors[index];
        if (vector === undefined) {
          throw new KnowledgeAiRuntimeError('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH', true);
        }
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_chunk_embeddings" (
            "id", "tenant_id", "chunk_id", "embedding_model",
            "embedding_dimension", "content_hash", "embedding"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${principal.tenantId}::uuid,
            ${chunk.id}::uuid,
            ${embeddingBatch.model},
            ${embeddingBatch.dimensions},
            ${chunk.contentHash},
            ${vectorLiteral(vector)}::vector
          )
          ON CONFLICT ("tenant_id", "chunk_id", "embedding_model")
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
          embeddingModel: embeddingBatch.model,
          dimensions: embeddingBatch.dimensions,
          chunkCount: snapshot.length,
        },
      );
    });
    return {
      documentVersionId: input.documentVersionId,
      embeddingModel: embeddingBatch.model,
      dimensions: embeddingBatch.dimensions,
      chunkCount: snapshot.length,
    };
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
    readonly documentId?: string;
    readonly title: string;
    readonly sourceType: 'TEXT' | 'MARKDOWN' | 'FILE';
    readonly mimeType: string;
    readonly fileName: string | null;
    readonly contentText?: string;
    readonly processing: boolean;
    readonly enqueue: boolean;
    readonly queueAvailableAt?: Date;
    readonly changeSummary?: string;
  }): Promise<IngestionIdentity> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, input.tenantId, input.documentId ?? input.title);
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: input.tenantId, id: input.knowledgeBaseId },
      });
      if (knowledgeBase === null || knowledgeBase.status === 'ARCHIVED') {
        throw new NotFoundException('The active knowledge base was not found.');
      }
      const document =
        input.documentId === undefined
          ? await transaction.knowledgeDocument.create({
              data: {
                tenantId: input.tenantId,
                knowledgeBaseId: input.knowledgeBaseId,
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
        select: { versionNumber: true },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;
      const version = await transaction.knowledgeDocumentVersion.create({
        data: {
          tenantId: input.tenantId,
          knowledgeBaseId: input.knowledgeBaseId,
          documentId: document.id,
          versionNumber,
          sourceType: input.sourceType,
          mimeType: input.mimeType,
          fileName: input.fileName,
          status: input.processing ? 'PROCESSING' : 'DRAFT',
          changeSummary: input.changeSummary ?? null,
          createdById: input.actorUserId,
          ...(input.sourceType !== 'FILE'
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
          ...(input.sourceType === 'FILE' && document.currentVersionId !== null
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
        jobId: job?.id ?? null,
        versionNumber,
        sourceType: input.sourceType,
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
  async executeClaim(claim: ClaimedKnowledgeIngestionJob, workerId: string): Promise<void> {
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
          mimeType: true,
          fileName: true,
          objectKey: true,
          objectSize: true,
          objectSha256: true,
          contentText: true,
          createdById: true,
        },
      });
      if (version === null) throw new Error('KNOWLEDGE_DOCUMENT_VERSION_UNAVAILABLE');
      return {
        identity: {
          tenantId: claim.tenantId,
          knowledgeBaseId: version.knowledgeBaseId,
          documentId: version.documentId,
          documentVersionId: version.id,
          jobId: claim.id,
          versionNumber: version.versionNumber,
          sourceType: version.sourceType,
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
    const bytes = await this.readSourceBytes(source, workerId);
    await this.process(source.identity, bytes, workerId);
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
        { errorCode: failure.code, attempts: claim.attempts, queued: true },
      );
      return true;
    });
  }

  private async readSourceBytes(source: IngestionSource, workerId: string): Promise<Buffer> {
    if (source.identity.sourceType !== 'FILE') {
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
    const bytes = await collectReadable(object.body, object.size, object.size);
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
  ): Promise<void> {
    await this.advance(identity, workerId, 'SECURITY_CHECK', 15);
    let securityScan: {
      readonly verdict: 'clean' | 'not_scanned';
      readonly scanner: string | null;
    } | null = null;
    if (identity.sourceType === 'FILE') {
      const scan = await this.scanner.scan({
        bytes,
        fileName: identity.fileName ?? 'document.bin',
        mimeType: identity.mimeType,
        sha256: sha256(bytes),
      });
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
    await this.advance(identity, workerId, 'PARSING', 30);
    const parsed = await this.parser.parse({
      bytes,
      mimeType: identity.mimeType,
      ...(identity.fileName === null ? {} : { fileName: identity.fileName }),
    });
    await this.advance(identity, workerId, 'CHUNKING', 55);
    const chunks = chunkParsedKnowledgeDocument(parsed);
    if (chunks.length === 0) throw new Error('DOCUMENT_TEXT_EMPTY');
    const storedChunks = chunks.map((chunk) => ({ id: randomUUID(), ...chunk }));
    await this.advance(identity, workerId, 'INDEXING', 80);
    const embeddingBatch = this.semantic.semanticEnabled
      ? await this.semantic.embedAll(
          identity.tenantId,
          storedChunks.map((chunk) => chunk.content),
        )
      : null;

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
        select: { status: true },
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
      await transaction.knowledgeChunk.createMany({
        data: storedChunks.map((chunk) => ({
          id: chunk.id,
          tenantId: identity.tenantId,
          knowledgeBaseId: identity.knowledgeBaseId,
          documentId: identity.documentId,
          documentVersionId: identity.documentVersionId,
          chunkIndex: chunk.chunkIndex,
          headingPath: chunk.headingPath,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          metadata: chunk.metadata,
        })),
      });
      if (embeddingBatch !== null) {
        if (embeddingBatch.vectors.length !== storedChunks.length) {
          throw new Error('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH');
        }
        for (const [index, chunk] of storedChunks.entries()) {
          const vector = embeddingBatch.vectors[index];
          if (vector === undefined) throw new Error('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH');
          await transaction.$executeRaw`
            INSERT INTO public."knowledge_chunk_embeddings" (
              "id", "tenant_id", "chunk_id", "embedding_model",
              "embedding_dimension", "content_hash", "embedding"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${identity.tenantId}::uuid,
              ${chunk.id}::uuid,
              ${embeddingBatch.model},
              ${embeddingBatch.dimensions},
              ${chunk.contentHash},
              ${vectorLiteral(vector)}::vector
            )
            ON CONFLICT ("tenant_id", "chunk_id", "embedding_model")
            DO UPDATE SET
              "embedding_dimension" = EXCLUDED."embedding_dimension",
              "content_hash" = EXCLUDED."content_hash",
              "embedding" = EXCLUDED."embedding",
              "updated_at" = now()
          `;
        }
      }
      const publishedAt = new Date();
      const document = await transaction.knowledgeDocument.findFirstOrThrow({
        where: { tenantId: identity.tenantId, id: identity.documentId },
        select: { currentVersionId: true, documentVersion: true },
      });
      const shouldPublish = shouldPromoteKnowledgeVersion({
        currentVersionId: document.currentVersionId,
        currentVersionNumber: document.documentVersion,
        candidateVersionNumber: identity.versionNumber,
      });
      const storedVersion = await transaction.knowledgeDocumentVersion.findFirstOrThrow({
        where: { tenantId: identity.tenantId, id: identity.documentVersionId },
        select: { objectKey: true },
      });
      await transaction.knowledgeDocumentVersion.update({
        where: { id: identity.documentVersionId },
        data: {
          contentText: parsed.text,
          checksum: sha256(bytes),
          status: 'READY',
          publishedAt: shouldPublish ? publishedAt : null,
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
            objectKey: storedVersion.objectKey,
            mimeType: identity.mimeType,
            fileName: identity.fileName,
          },
        });
      }
      await transaction.knowledgeIngestionJob.update({
        where: { id: jobId },
        data: {
          stage: 'READY',
          status: 'SUCCEEDED',
          progress: 100,
          claimedBy: null,
          leaseExpiresAt: null,
          finishedAt: publishedAt,
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
        shouldPublish
          ? 'admin.knowledge-document-version.published'
          : 'admin.knowledge-document-version.indexed',
        'knowledge_document_version',
        identity.documentVersionId,
        {
          documentId: identity.documentId,
          version: identity.versionNumber,
          chunkCount: storedChunks.length,
          semanticIndexed: embeddingBatch !== null,
          embeddingModel: embeddingBatch?.model ?? null,
          current: shouldPublish,
          securityScanVerdict: securityScan?.verdict ?? 'not_applicable',
          securityScanner: securityScan?.scanner ?? null,
        },
      );
    });
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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function chunkParsedKnowledgeDocument(parsed: ParsedKnowledgeDocument): Array<
  ReturnType<typeof chunkKnowledgeDocument>[number] & {
    metadata: Prisma.InputJsonObject;
  }
> {
  if (parsed.metadata.mimeType !== 'application/pdf') {
    return chunkKnowledgeDocument({
      content: parsed.text,
      sourceType: parsed.metadata.sourceType,
    }).map((chunk) => ({
      ...chunk,
      metadata: parsed.metadata as unknown as Prisma.InputJsonObject,
    }));
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

  const chunks: Array<
    ReturnType<typeof chunkKnowledgeDocument>[number] & {
      metadata: Prisma.InputJsonObject;
    }
  > = [];
  for (const [pageIndex, page] of pages.entries()) {
    // The parser includes empty pages, so a gap, duplicate, or reordering is a
    // provenance failure rather than a page that should be silently ignored.
    if (page.pageNumber !== pageIndex + 1) {
      throw new DocumentParsingError('DOCUMENT_PARSE_FAILED');
    }
    const pageChunks = chunkKnowledgeDocument({
      content: page.text,
      sourceType: parsed.metadata.sourceType,
    });
    for (const pageChunk of pageChunks) {
      chunks.push({
        ...pageChunk,
        chunkIndex: chunks.length,
        metadata: {
          ...parsed.metadata,
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
          pageCount,
          parser: parsed.metadata.parser ?? PDF_PARSER_NAME,
        },
      });
    }
  }
  return chunks;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 1_536 || vector.some((component) => !Number.isFinite(component))) {
    throw new Error('KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH');
  }
  return `[${vector.join(',')}]`;
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
        error.code === 'DOCUMENT_PARSER_TIMEOUT' || error.code === 'DOCUMENT_PARSER_UNAVAILABLE',
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
    KNOWLEDGE_SEMANTIC_DISABLED: 'Semantic indexing is disabled.',
    KNOWLEDGE_EMBEDDING_BATCH_INVALID: 'Embedding request exceeded supported limits.',
  };
  const semanticMessage = semanticMessages[code];
  if (semanticMessage !== undefined) return semanticMessage;
  const messages: Record<string, string> = {
    KNOWLEDGE_DOCUMENT_ARCHIVED: 'The document was archived before publication completed.',
    KNOWLEDGE_BASE_ARCHIVED: 'The knowledge base was archived before publication completed.',
    UNSUPPORTED_MIME_TYPE: '不支持该文件类型。',
    DOCUMENT_EMPTY: '上传文件为空。',
    DOCUMENT_TOO_LARGE: '文件超过 20 MB 限制。',
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
