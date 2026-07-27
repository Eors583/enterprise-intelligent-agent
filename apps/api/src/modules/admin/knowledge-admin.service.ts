import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreateKnowledgeBaseRequest,
  type CreateKnowledgeDocumentRequest,
  type KnowledgeBase,
  type KnowledgeBaseIndexReadiness,
  type KnowledgeBaseListResponse,
  type KnowledgeCapabilityReadiness,
  type KnowledgeDocument,
  type KnowledgeDocumentChunkListResponse,
  type KnowledgeDocumentSummary,
  type KnowledgeDocumentVersionDetail,
  type KnowledgeEmbeddingRebuildResponse,
  type KnowledgeRetrievalTestRequest,
  type KnowledgeRetrievalTestResponse,
  type RollbackKnowledgeDocumentVersionRequest,
  type UpdateKnowledgeBaseRequest,
  type UpdateKnowledgeDocumentRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { KnowledgeIngestionService } from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import { KnowledgeRetrievalService } from '../knowledge-retrieval/knowledge-retrieval.service.js';
import {
  KnowledgeAiRuntimeClient,
  type KnowledgeRuntimeCapabilities,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import { AdminAccessService } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';
import {
  deriveKnowledgeBaseIndexReadiness,
  type KnowledgeReadinessDocumentState,
} from './knowledge-readiness.js';

type KnowledgeBaseRecord = Prisma.KnowledgeBaseGetPayload<{
  include: typeof knowledgeBaseInclude;
}>;

type KnowledgeDocumentRecord = Prisma.KnowledgeDocumentGetPayload<{
  include: typeof knowledgeDocumentInclude;
}>;

type KnowledgeDocumentSummaryRecord = Prisma.KnowledgeDocumentGetPayload<{
  select: typeof knowledgeDocumentSummarySelect;
}>;

type KnowledgeDocumentVersionRecord = Prisma.KnowledgeDocumentVersionGetPayload<{
  include: typeof knowledgeDocumentVersionInclude;
}>;

@Injectable()
export class KnowledgeAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(KnowledgeIngestionService) private readonly ingestion: KnowledgeIngestionService,
    @Inject(KnowledgeRetrievalService) private readonly retrieval: KnowledgeRetrievalService,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
  ) {}

  async list(): Promise<KnowledgeBaseListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const items = await transaction.knowledgeBase.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        include: knowledgeBaseInclude,
      });
      return { items: items.map(mapKnowledgeBase) };
    });
  }

  async readiness(knowledgeBaseId: string): Promise<KnowledgeBaseIndexReadiness> {
    const principal = this.access.requireKnowledgeWrite();
    const capabilities = await this.safeKnowledgeCapabilities(principal.tenantId);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const documents = await transaction.knowledgeDocument.findMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: {
          status: true,
          currentVersion: {
            select: {
              id: true,
              status: true,
              _count: { select: { chunks: true } },
            },
          },
          versions: {
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
            take: 1,
            select: {
              status: true,
              ingestionJobs: {
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
                select: { status: true },
              },
            },
          },
        },
      });
      const states: KnowledgeReadinessDocumentState[] = documents.map((document) => ({
        documentStatus: document.status,
        currentVersionStatus: document.currentVersion?.status ?? null,
        currentChunkCount: document.currentVersion?._count.chunks ?? 0,
        latestVersionStatus: document.versions[0]?.status ?? null,
        latestIngestionStatus: document.versions[0]?.ingestionJobs[0]?.status ?? null,
      }));
      const currentVersionIds = documents.flatMap((document) =>
        document.status !== 'ARCHIVED' && document.currentVersion?.status === 'READY'
          ? [document.currentVersion.id]
          : [],
      );
      const embeddingModel = capabilities.embedding.model;
      const embeddedChunkCount =
        embeddingModel !== null && currentVersionIds.length > 0
          ? await transaction.knowledgeChunk.count({
              where: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                documentVersionId: { in: currentVersionIds },
                embeddings: { some: { embeddingModel } },
              },
            })
          : 0;
      return deriveKnowledgeBaseIndexReadiness({
        knowledgeBaseId,
        documents: states,
        embeddedChunkCount,
        embedding: capabilities.embedding,
        rerank: capabilities.rerank,
      });
    });
  }

  async create(request: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    if (request.status === 'ACTIVE') {
      throw new ConflictException(
        'A new knowledge base must remain draft until enterprise readiness checks pass.',
      );
    }
    try {
      return await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const scopes = normalizeKnowledgeScopes(request.orgUnitScopes, request.orgUnitIds);
        await this.requireOrgUnits(
          transaction,
          principal.tenantId,
          scopes.map((scope) => scope.orgUnitId),
        );
        const knowledgeBase = await transaction.knowledgeBase.create({
          data: {
            tenantId: principal.tenantId,
            key: request.key,
            name: request.name,
            description: request.description ?? null,
            status: request.status,
            createdById: principal.userId,
          },
          select: { id: true, key: true },
        });
        if (scopes.length > 0) {
          await transaction.knowledgeBaseOrgUnit.createMany({
            data: scopes.map((scope) => ({
              tenantId: principal.tenantId,
              knowledgeBaseId: knowledgeBase.id,
              orgUnitId: scope.orgUnitId,
              includeChildren: scope.includeChildren,
            })),
          });
        }
        await recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-base.created',
          'knowledge_base',
          knowledgeBase.id,
          { key: knowledgeBase.key, orgUnitScopes: scopes },
        );
        return mapKnowledgeBase(
          await this.findKnowledgeBase(transaction, principal.tenantId, knowledgeBase.id),
        );
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('A knowledge base with this key already exists.');
      }
      throw error;
    }
  }

  async update(id: string, request: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    const currentStatus = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeBase.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { status: true },
      }),
    );
    if (currentStatus === null) throw knowledgeBaseNotFound();
    if (request.status === 'ACTIVE' && currentStatus.status !== 'ACTIVE') {
      const readiness = await this.readiness(id);
      if (!readiness.activationAllowed) {
        throw new ConflictException(
          `Knowledge base enterprise readiness checks failed: ${readiness.activationBlockers.join(', ')}.`,
        );
      }
    }
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.knowledgeBase.findFirst({
        where: { id, tenantId: principal.tenantId },
      });
      if (current === null) throw knowledgeBaseNotFound();
      if (request.status === 'ACTIVE' && current.status !== 'ACTIVE') {
        const publishableDocument = await transaction.knowledgeDocument.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId: id,
            status: 'READY',
            currentVersionId: { not: null },
            currentVersion: {
              is: {
                status: 'READY',
                chunks: { some: {} },
              },
            },
          },
          select: { id: true },
        });
        if (publishableDocument === null) {
          throw new ConflictException(
            'A knowledge base requires at least one ready, indexed current document before activation.',
          );
        }
      }

      const requestedScopes =
        request.orgUnitScopes !== undefined || request.orgUnitIds !== undefined
          ? normalizeKnowledgeScopes(request.orgUnitScopes, request.orgUnitIds ?? [])
          : null;
      if (requestedScopes !== null) {
        await this.requireOrgUnits(
          transaction,
          principal.tenantId,
          requestedScopes.map((scope) => scope.orgUnitId),
        );
      }
      const result = await transaction.knowledgeBase.updateMany({
        where: {
          id,
          tenantId: principal.tenantId,
          version: request.expectedVersion,
        },
        data: {
          version: { increment: 1 },
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.status === undefined ? {} : { status: request.status }),
        },
      });
      if (result.count !== 1) throw optimisticConflict('knowledge base');

      if (requestedScopes !== null) {
        await transaction.knowledgeBaseOrgUnit.deleteMany({
          where: { tenantId: principal.tenantId, knowledgeBaseId: id },
        });
        if (requestedScopes.length > 0) {
          await transaction.knowledgeBaseOrgUnit.createMany({
            data: requestedScopes.map((scope) => ({
              tenantId: principal.tenantId,
              knowledgeBaseId: id,
              orgUnitId: scope.orgUnitId,
              includeChildren: scope.includeChildren,
            })),
          });
        }
      }

      const updated = await this.findKnowledgeBase(transaction, principal.tenantId, id);
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-base.updated',
        'knowledge_base',
        id,
        { previousVersion: current.version, version: updated.version },
      );
      return mapKnowledgeBase(updated);
    });
  }

  async createDocument(
    knowledgeBaseId: string,
    request: CreateKnowledgeDocumentRequest,
  ): Promise<KnowledgeDocument> {
    if (request.sourceType === 'FILE') {
      throw new BadRequestException('File documents must be created through the upload endpoint.');
    }
    const content = request.contentText ?? '';
    if (request.status === 'READY' && content.trim().length === 0) {
      throw new BadRequestException('A published text document must contain searchable text.');
    }
    const documentId = await this.ingestion.createTextVersion({
      knowledgeBaseId,
      title: request.title,
      sourceType: request.sourceType,
      content,
      publish: request.status === 'READY',
    });
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async uploadDocument(
    knowledgeBaseId: string,
    input: {
      readonly title: string;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly changeSummary?: string;
    },
  ): Promise<KnowledgeDocument> {
    const documentId = await this.ingestion.upload({ knowledgeBaseId, ...input });
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async uploadDocumentVersion(
    knowledgeBaseId: string,
    documentId: string,
    input: {
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly fileName: string;
      readonly changeSummary?: string;
    },
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    const current = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeDocument.findFirst({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
        },
        select: { id: true, title: true, sourceType: true, status: true },
      }),
    );
    if (current === null) throw knowledgeDocumentNotFound();
    if (current.sourceType !== 'FILE') {
      throw new BadRequestException('Only file documents accept uploaded file versions.');
    }
    if (current.status === 'ARCHIVED') {
      throw new ConflictException('An archived document cannot receive a new version.');
    }
    const uploadedDocumentId = await this.ingestion.uploadFileVersion({
      knowledgeBaseId,
      documentId,
      title: current.title,
      ...input,
    });
    if (uploadedDocumentId !== documentId) throw knowledgeDocumentNotFound();
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async updateDocument(
    knowledgeBaseId: string,
    documentId: string,
    request: UpdateKnowledgeDocumentRequest,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    assertPositiveVersion(request.expectedVersion);
    const current = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const document = await transaction.knowledgeDocument.findFirst({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
        },
      });
      if (document === null) throw knowledgeDocumentNotFound();
      if (document.documentVersion !== request.expectedVersion) {
        throw optimisticConflict('knowledge document');
      }
      return document;
    });

    if (request.status === 'ARCHIVED') {
      return this.archiveDocument(knowledgeBaseId, documentId, request.expectedVersion);
    }
    if (current.status === 'ARCHIVED') {
      throw new ConflictException('An archived document cannot receive a new version.');
    }
    if (current.sourceType === 'FILE') {
      throw new BadRequestException('File documents must be revised by uploading a new file.');
    }
    const content = request.contentText ?? current.contentText ?? '';
    const publish =
      request.status === 'READY' || (request.status === undefined && current.status === 'READY');
    if (publish && content.trim().length === 0) {
      throw new BadRequestException('A published text document must contain searchable text.');
    }
    await this.ingestion.createTextVersion({
      knowledgeBaseId,
      documentId,
      title: request.title ?? current.title,
      sourceType: current.sourceType,
      content,
      publish,
      changeSummary: `Revised from version ${current.documentVersion}`,
    });
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async retryDocumentVersion(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          id: documentVersionId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
        },
        select: { id: true },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
    });
    const retriedDocumentId = await this.ingestion.retry(documentVersionId);
    if (retriedDocumentId !== documentId) throw knowledgeDocumentNotFound();
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async publishDocumentVersion(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          id: documentVersionId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
        },
        select: { id: true },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
    });
    const publishedDocumentId = await this.ingestion.publishDraftVersion(documentVersionId);
    if (publishedDocumentId !== documentId) throw knowledgeDocumentNotFound();
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async rollbackDocumentVersion(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
    request: RollbackKnowledgeDocumentVersionRequest,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { id: knowledgeBaseId, tenantId: principal.tenantId },
        select: { status: true },
      });
      if (knowledgeBase === null) throw knowledgeBaseNotFound();
      if (knowledgeBase.status === 'ARCHIVED') {
        throw new ConflictException('An archived knowledge base cannot roll back documents.');
      }
      const document = await transaction.knowledgeDocument.findFirst({
        where: { id: documentId, tenantId: principal.tenantId, knowledgeBaseId },
        select: { currentVersionId: true, status: true },
      });
      if (document === null) throw knowledgeDocumentNotFound();
      if (document.status === 'ARCHIVED') {
        throw new ConflictException('An archived document cannot be rolled back.');
      }
      if (document.currentVersionId !== request.expectedCurrentVersionId) {
        throw optimisticConflict('knowledge document publication');
      }
      if (documentVersionId === document.currentVersionId) {
        throw new ConflictException('The selected version is already the current version.');
      }
      const target = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          id: documentVersionId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
        },
        include: {
          chunks: { orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }] },
        },
      });
      if (target === null) throw new NotFoundException('The document version was not found.');
      if (target.status !== 'READY') {
        throw new ConflictException('Only a ready historical version can be restored.');
      }
      if (target.chunks.length === 0) {
        throw new ConflictException('A version without indexed chunks cannot be restored.');
      }
      const latest = await transaction.knowledgeDocumentVersion.findFirst({
        where: { tenantId: principal.tenantId, documentId },
        orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
        select: { versionNumber: true },
      });
      const rollbackVersionNumber = (latest?.versionNumber ?? 0) + 1;
      const publishedAt = new Date();
      const rollbackVersion = await transaction.knowledgeDocumentVersion.create({
        data: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          versionNumber: rollbackVersionNumber,
          sourceType: target.sourceType,
          mimeType: target.mimeType,
          fileName: target.fileName,
          objectKey: target.objectKey,
          checksum: target.checksum,
          contentText: target.contentText,
          status: 'READY',
          changeSummary: `Rollback from current to v${target.versionNumber}`,
          createdById: principal.userId,
          publishedAt,
        },
      });
      await transaction.knowledgeChunk.createMany({
        data: target.chunks.map((chunk) => ({
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          documentVersionId: rollbackVersion.id,
          chunkIndex: chunk.chunkIndex,
          headingPath: chunk.headingPath,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          metadata: chunk.metadata as Prisma.InputJsonObject,
        })),
      });
      // Rollback snapshots reuse identical content, so already verified embeddings can be
      // copied without another provider call. Chunk lineage remains version-specific.
      await transaction.$executeRaw`
        INSERT INTO public."knowledge_chunk_embeddings" (
          "id", "tenant_id", "chunk_id", "embedding_model",
          "embedding_dimension", "content_hash", "embedding"
        )
        SELECT
          gen_random_uuid(),
          source_embedding."tenant_id",
          restored_chunk."id",
          source_embedding."embedding_model",
          source_embedding."embedding_dimension",
          restored_chunk."content_hash",
          source_embedding."embedding"
        FROM public."knowledge_chunks" AS source_chunk
        JOIN public."knowledge_chunk_embeddings" AS source_embedding
          ON source_embedding."tenant_id" = source_chunk."tenant_id"
         AND source_embedding."chunk_id" = source_chunk."id"
        JOIN public."knowledge_chunks" AS restored_chunk
          ON restored_chunk."tenant_id" = source_chunk."tenant_id"
         AND restored_chunk."document_version_id" = ${rollbackVersion.id}::uuid
         AND restored_chunk."chunk_index" = source_chunk."chunk_index"
         AND restored_chunk."content_hash" = source_chunk."content_hash"
        WHERE source_chunk."tenant_id" = ${principal.tenantId}::uuid
          AND source_chunk."document_version_id" = ${target.id}::uuid
        ON CONFLICT ("tenant_id", "chunk_id", "embedding_model") DO NOTHING
      `;

      const result = await transaction.knowledgeDocument.updateMany({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          currentVersionId: request.expectedCurrentVersionId,
          status: { not: 'ARCHIVED' },
        },
        data: {
          currentVersionId: rollbackVersion.id,
          status: 'READY',
          documentVersion: rollbackVersionNumber,
          sourceType: target.sourceType,
          mimeType: target.mimeType,
          fileName: target.fileName,
          contentText: target.contentText,
          objectKey: target.objectKey,
          checksum: target.checksum,
        },
      });
      if (result.count !== 1) throw optimisticConflict('knowledge document publication');
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-document-version.rolled-back',
        'knowledge_document_version',
        rollbackVersion.id,
        {
          documentId,
          fromVersionId: request.expectedCurrentVersionId,
          sourceVersionId: target.id,
          sourceVersion: target.versionNumber,
          rollbackVersionId: rollbackVersion.id,
          rollbackVersion: rollbackVersionNumber,
        },
      );
      return mapKnowledgeDocument(
        await this.findKnowledgeDocument(
          transaction,
          principal.tenantId,
          knowledgeBaseId,
          documentId,
        ),
      );
    });
  }

  async testRetrieval(
    knowledgeBaseId: string,
    request: KnowledgeRetrievalTestRequest,
  ): Promise<KnowledgeRetrievalTestResponse> {
    const principal = this.access.requireKnowledgeWrite();
    const simulatedUserId = request.userId ?? principal.userId;
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const user = await transaction.user.findFirst({
        where: { tenantId: principal.tenantId, id: simulatedUserId },
        select: { id: true },
      });
      if (user === null) throw new NotFoundException('The simulated user was not found.');
    });

    const startedAt = Date.now();
    const result = await this.retrieval.search({
      tenantId: principal.tenantId,
      userId: simulatedUserId,
      knowledgeBaseIds: [knowledgeBaseId],
      previewDraftKnowledgeBaseIds: [knowledgeBaseId],
      query: request.query,
      limit: request.limit,
    });
    return {
      query: request.query,
      simulatedUserId,
      accessibleKnowledgeBaseIds: [...result.accessibleKnowledgeBaseIds],
      mode: result.mode,
      embeddingModel: result.embeddingModel,
      reranker: result.reranker,
      rerankerModel: result.rerankerModel,
      degradedReason: result.degradedReason,
      lexicalCandidateCount: result.lexicalCandidateCount,
      vectorCandidateCount: result.vectorCandidateCount,
      semanticCoverage: result.semanticCoverage,
      noAnswer: result.items.length === 0,
      elapsedMs: Date.now() - startedAt,
      items: result.items.map((item) => ({
        chunkId: item.chunkId,
        knowledgeBaseId: item.knowledgeBaseId,
        knowledgeBaseName: item.knowledgeBaseName,
        documentId: item.documentId,
        documentVersionId: item.documentVersionId,
        documentVersion: item.documentVersion,
        title: item.title,
        headingPath: [...item.headingPath],
        excerpt: excerpt(item.content),
        keywordScore: item.keywordScore,
        fuzzyScore: item.fuzzyScore,
        semanticScore: item.semanticScore,
        fusionScore: item.fusionScore,
        rerankerScore: item.rerankerScore,
        finalScore: item.finalScore,
      })),
    };
  }

  rebuildDocumentVersionEmbeddings(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeEmbeddingRebuildResponse> {
    return this.ingestion.rebuildEmbeddings({
      knowledgeBaseId,
      documentId,
      documentVersionId,
    });
  }

  async archiveDocument(
    knowledgeBaseId: string,
    documentId: string,
    expectedVersion: number,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    assertPositiveVersion(expectedVersion);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.knowledgeDocument.findFirst({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
        },
      });
      if (current === null) throw knowledgeDocumentNotFound();
      if (current.status === 'ARCHIVED') {
        throw new ConflictException('The knowledge document is already archived.');
      }

      const result = await transaction.knowledgeDocument.updateMany({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentVersion: expectedVersion,
        },
        data: { status: 'ARCHIVED' },
      });
      if (result.count !== 1) throw optimisticConflict('knowledge document');

      const archived = await transaction.knowledgeDocument.findFirstOrThrow({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
        },
        include: knowledgeDocumentInclude,
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-document.archived',
        'knowledge_document',
        documentId,
        { version: archived.documentVersion },
      );
      return mapKnowledgeDocument(archived);
    });
  }

  async getDocument(knowledgeBaseId: string, documentId: string): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const document = await this.findKnowledgeDocument(
        transaction,
        principal.tenantId,
        knowledgeBaseId,
        documentId,
      );
      return mapKnowledgeDocument(document);
    });
  }

  async getDocumentVersion(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeDocumentVersionDetail> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          id: documentVersionId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
        },
        include: knowledgeDocumentVersionInclude,
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      return {
        ...mapKnowledgeDocumentVersion(version),
        documentId: version.documentId,
        contentText: version.contentText,
      };
    });
  }

  async listDocumentVersionChunks(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
    offset: number,
    limit: number,
  ): Promise<KnowledgeDocumentChunkListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    assertChunkPagination(offset, limit);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const [document, version] = await Promise.all([
        transaction.knowledgeDocument.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            id: documentId,
          },
          select: { id: true },
        }),
        transaction.knowledgeDocumentVersion.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            documentId,
            id: documentVersionId,
          },
          select: { id: true },
        }),
      ]);
      if (document === null) throw knowledgeDocumentNotFound();
      if (version === null) throw new NotFoundException('The document version was not found.');

      const chunkScope = {
        tenantId: principal.tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
      };
      const [total, embeddedChunkCount, chunks] = await Promise.all([
        transaction.knowledgeChunk.count({ where: chunkScope }),
        transaction.knowledgeChunk.count({
          where: { ...chunkScope, embeddings: { some: {} } },
        }),
        transaction.knowledgeChunk.findMany({
          where: chunkScope,
          orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }],
          skip: offset,
          take: limit,
          select: {
            id: true,
            chunkIndex: true,
            headingPath: true,
            content: true,
            tokenCount: true,
            contentHash: true,
            metadata: true,
            embeddings: {
              orderBy: [{ embeddingModel: 'asc' }, { id: 'asc' }],
              select: { embeddingModel: true },
            },
          },
        }),
      ]);

      return {
        documentVersionId,
        total,
        offset,
        limit,
        embeddedChunkCount,
        semanticCoverage: total === 0 ? 0 : embeddedChunkCount / total,
        items: chunks.map((chunk) => {
          const pages = readChunkPages(chunk.metadata);
          return {
            id: chunk.id,
            chunkIndex: chunk.chunkIndex,
            headingPath: chunk.headingPath,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
            pageStart: pages.pageStart,
            pageEnd: pages.pageEnd,
            embeddingModels: [
              ...new Set(chunk.embeddings.map((embedding) => embedding.embeddingModel)),
            ],
          };
        }),
      };
    });
  }

  private async safeKnowledgeCapabilities(tenantId: string): Promise<{
    readonly embedding: KnowledgeCapabilityReadiness;
    readonly rerank: KnowledgeCapabilityReadiness;
  }> {
    try {
      const capabilities = await this.semantic.capabilities(tenantId);
      return {
        embedding: mapRuntimeCapability(capabilities.embeddings, this.semantic.semanticEnabled),
        rerank: mapRuntimeCapability(capabilities.rerank, this.semantic.rerankEnabled),
      };
    } catch {
      return {
        embedding: this.semantic.semanticEnabled
          ? {
              status: 'UNAVAILABLE',
              provider: 'openai_compatible',
              model: null,
              dimensions: this.semantic.embeddingDimensions,
            }
          : {
              status: 'DISABLED',
              provider: 'disabled',
              model: null,
              dimensions: this.semantic.embeddingDimensions,
            },
        rerank: this.semantic.rerankEnabled
          ? {
              status: 'UNAVAILABLE',
              provider: 'cohere_compatible',
              model: null,
              dimensions: null,
            }
          : { status: 'DISABLED', provider: 'disabled', model: null, dimensions: null },
      };
    }
  }

  private async requireOrgUnits(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    requestedIds: readonly string[],
  ): Promise<void> {
    const ids = uniqueIds(requestedIds);
    if (ids.length === 0) return;
    const count = await transaction.orgUnit.count({
      where: { tenantId, id: { in: ids }, status: 'ACTIVE' },
    });
    if (count !== ids.length) {
      throw new NotFoundException('One or more organization units were not found.');
    }
  }

  private async requireKnowledgeBase(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<void> {
    const knowledgeBase = await transaction.knowledgeBase.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (knowledgeBase === null) throw knowledgeBaseNotFound();
  }

  private async findKnowledgeBase(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<KnowledgeBaseRecord> {
    const knowledgeBase = await transaction.knowledgeBase.findFirst({
      where: { id, tenantId },
      include: knowledgeBaseInclude,
    });
    if (knowledgeBase === null) throw knowledgeBaseNotFound();
    return knowledgeBase;
  }

  private async findKnowledgeDocument(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    knowledgeBaseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentRecord> {
    const document = await transaction.knowledgeDocument.findFirst({
      where: { id: documentId, tenantId, knowledgeBaseId },
      include: knowledgeDocumentInclude,
    });
    if (document === null) throw knowledgeDocumentNotFound();
    return document;
  }
}

const knowledgeDocumentVersionInclude = {
  _count: { select: { chunks: true } },
  ingestionJobs: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
    take: 1,
  },
} satisfies Prisma.KnowledgeDocumentVersionInclude;

const knowledgeDocumentVersions = {
  orderBy: [{ versionNumber: 'desc' as const }, { id: 'asc' as const }],
  include: knowledgeDocumentVersionInclude,
};

const knowledgeDocumentInclude = {
  versions: knowledgeDocumentVersions,
} satisfies Prisma.KnowledgeDocumentInclude;

const knowledgeDocumentSummarySelect = {
  id: true,
  knowledgeBaseId: true,
  title: true,
  sourceType: true,
  mimeType: true,
  fileName: true,
  checksum: true,
  status: true,
  documentVersion: true,
  currentVersionId: true,
  updatedAt: true,
  versions: knowledgeDocumentVersions,
} satisfies Prisma.KnowledgeDocumentSelect;

const knowledgeBaseInclude = {
  orgUnits: { orderBy: { createdAt: 'asc' as const } },
  documents: {
    orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }],
    select: knowledgeDocumentSummarySelect,
  },
  _count: { select: { documents: true } },
} satisfies Prisma.KnowledgeBaseInclude;

function mapKnowledgeBase(knowledgeBase: KnowledgeBaseRecord): KnowledgeBase {
  return {
    id: knowledgeBase.id,
    key: knowledgeBase.key,
    name: knowledgeBase.name,
    description: knowledgeBase.description,
    status: knowledgeBase.status,
    version: knowledgeBase.version,
    orgUnitIds: knowledgeBase.orgUnits.map((scope) => scope.orgUnitId),
    orgUnitScopes: knowledgeBase.orgUnits.map((scope) => ({
      orgUnitId: scope.orgUnitId,
      includeChildren: scope.includeChildren,
    })),
    documentCount: knowledgeBase._count.documents,
    documents: knowledgeBase.documents.map(mapKnowledgeDocumentSummary),
    updatedAt: knowledgeBase.updatedAt.toISOString(),
  };
}

function mapKnowledgeDocumentSummary(
  document: KnowledgeDocumentSummaryRecord | KnowledgeDocumentRecord,
): KnowledgeDocumentSummary {
  return {
    id: document.id,
    knowledgeBaseId: document.knowledgeBaseId,
    title: document.title,
    sourceType: document.sourceType,
    mimeType: document.mimeType,
    fileName: document.fileName,
    checksum: document.checksum,
    status: document.status,
    documentVersion: document.documentVersion,
    currentVersionId: document.currentVersionId,
    versions: document.versions.map(mapKnowledgeDocumentVersion),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function mapKnowledgeDocument(document: KnowledgeDocumentRecord): KnowledgeDocument {
  return {
    ...mapKnowledgeDocumentSummary(document),
    contentText: document.contentText,
  };
}

function mapKnowledgeDocumentVersion(version: KnowledgeDocumentVersionRecord) {
  const job = version.ingestionJobs[0];
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    sourceType: version.sourceType,
    mimeType: version.mimeType,
    fileName: version.fileName,
    checksum: version.checksum,
    status: version.status,
    changeSummary: version.changeSummary,
    chunkCount: version._count.chunks,
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    ingestionJob:
      job === undefined
        ? null
        : {
            id: job.id,
            documentVersionId: job.documentVersionId,
            stage: job.stage,
            status: job.status,
            progress: job.progress,
            attempts: job.attempts,
            errorCode: job.errorCode,
            errorMessage: job.errorMessage,
            startedAt: job.startedAt?.toISOString() ?? null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
          },
  };
}

function mapRuntimeCapability(
  capability: KnowledgeRuntimeCapabilities['embeddings'] | KnowledgeRuntimeCapabilities['rerank'],
  featureEnabled: boolean,
): KnowledgeCapabilityReadiness {
  const status = {
    disabled: 'DISABLED',
    ready: 'READY',
    not_ready: 'NOT_READY',
  }[capability.status] as KnowledgeCapabilityReadiness['status'];
  return {
    status: featureEnabled && status === 'DISABLED' ? 'NOT_READY' : status,
    provider: capability.provider,
    model: capability.model,
    dimensions: 'dimensions' in capability ? capability.dimensions : null,
  };
}

function excerpt(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 360 ? normalized : `${normalized.slice(0, 357)}...`;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function normalizeKnowledgeScopes(
  scopes:
    ReadonlyArray<{ readonly orgUnitId: string; readonly includeChildren: boolean }> | undefined,
  fallbackIds: readonly string[],
): Array<{ orgUnitId: string; includeChildren: boolean }> {
  const normalized = new Map<string, boolean>();
  for (const scope of scopes ??
    fallbackIds.map((orgUnitId) => ({ orgUnitId, includeChildren: true }))) {
    normalized.set(scope.orgUnitId, scope.includeChildren);
  }
  return [...normalized].map(([orgUnitId, includeChildren]) => ({ orgUnitId, includeChildren }));
}

function optimisticConflict(resource: string): ConflictException {
  return new ConflictException(
    `The ${resource} changed after it was loaded. Refresh and try again.`,
  );
}

async function lockKnowledgeDocument(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  documentId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:knowledge-document:${documentId}`}, 0))::text
  `;
}

function knowledgeBaseNotFound(): NotFoundException {
  return new NotFoundException('The knowledge base was not found.');
}

function knowledgeDocumentNotFound(): NotFoundException {
  return new NotFoundException('The knowledge document was not found.');
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function assertPositiveVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new BadRequestException('expectedVersion must be a positive integer.');
  }
}

function assertChunkPagination(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new BadRequestException('offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestException('limit must be an integer between 1 and 100.');
  }
}

function readChunkPages(metadata: Prisma.JsonValue): {
  pageStart: number | null;
  pageEnd: number | null;
} {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { pageStart: null, pageEnd: null };
  }
  const pageStart = positiveInteger(metadata.pageStart) ?? positiveInteger(metadata.page);
  const pageEnd = positiveInteger(metadata.pageEnd) ?? pageStart;
  return { pageStart, pageEnd };
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}
