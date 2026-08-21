import { createHash, randomUUID } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  defineKnowledgePublicEvent,
  knowledgeGovernanceReviewStatusSchema,
  type CreateKnowledgeBaseRequest,
  type CreateKnowledgeEmbeddingIndexVersionRequest,
  type CreateKnowledgeDocumentRequest,
  type KnowledgeBase,
  type KnowledgeBaseIndexReadiness,
  type KnowledgeBaseListResponse,
  type KnowledgeCapabilityReadiness,
  type KnowledgeDocument,
  type KnowledgeDocumentChunkListResponse,
  type KnowledgeDocumentGovernancePolicy,
  type KnowledgeDocumentSummary,
  type KnowledgeDocumentVersionDetail,
  type EnsureKnowledgeFoldersRequest,
  type KnowledgeFolderListResponse,
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
  type LexiangSpaceSyncResponse,
  type PublishKnowledgeDocumentVersionRequest,
  type KnowledgeRetrievalTestRequest,
  type KnowledgeRetrievalTestResponse,
  type KnowledgeRetrievalConfig,
  type KnowledgeSpaceSelection,
  type KnowledgeChunkingConfig,
  type RollbackKnowledgeDocumentVersionRequest,
  type ImportKnowledgeWebDocumentRequest,
  type ReviewKnowledgeDocumentParseRequest,
  type ReviewKnowledgeDocumentGovernanceRequest,
  type UpdateKnowledgeDocumentVersionGovernanceRequest,
  type UpdateKnowledgeDocumentAccessRequest,
  type UpdateKnowledgeBaseRequest,
  type UpdateKnowledgeDocumentRequest,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { KnowledgeGateway } from '../knowledge-gateway/knowledge-gateway.port.js';
import { KnowledgeProviderSpaceService } from '../knowledge-provider/application/knowledge-provider-space.service.js';
import {
  activateKnowledgeGraphProjection,
  persistKnowledgeGraphProjection,
} from '../knowledge-ingestion/application/knowledge-ingestion.service.js';
import { projectKnowledgeGraph } from '../knowledge-ingestion/domain/knowledge-graph.projector.js';
import {
  KnowledgeAiRuntimeClient,
  type KnowledgeRuntimeCapabilities,
} from '../knowledge-semantic/knowledge-ai-runtime.client.js';
import { AdminAccessService } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';
import { deriveKnowledgeGraphReadiness } from './knowledge-graph-readiness.js';
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

interface KnowledgeGraphOverviewRow {
  entity_count: number;
  relation_count: number;
  published_ontology_version_count: number;
  ungoverned_relation_count: number;
  open_conflict_count: number;
  mention_count: number;
  evidence_count: number;
  orphan_entity_count: number;
  relations_without_evidence_count: number;
  published_chunk_count: number;
  linked_chunk_count: number;
  processing_count: number;
  failed_count: number;
  last_built_at: Date | null;
}

interface KnowledgeGraphTypeCountRow {
  key: string;
  count: number;
}

interface KnowledgeGraphEntityRow {
  id: string;
  entity_type: string;
  canonical_name: string;
  description: string | null;
  aliases: string[];
  attributes: Prisma.JsonValue;
  confidence: number;
  mention_count: number;
  relation_count: number;
  updated_at: Date;
}

interface KnowledgeGraphRelationRow {
  id: string;
  subject_entity_id: string;
  subject_entity_name: string;
  predicate: string;
  object_entity_id: string;
  object_entity_name: string;
  attributes: Prisma.JsonValue;
  confidence: number;
  evidence_count: number;
  updated_at: Date;
}

interface KnowledgeGraphEvidenceRow {
  id: string;
  relation_id: string;
  chunk_id: string;
  document_id: string;
  document_version_id: string;
  excerpt: string;
  confidence: number;
}

interface KnowledgeGraphProjectionRow {
  readonly id: string;
  readonly status: 'CANDIDATE' | 'ACTIVE' | 'OBSOLETE';
  readonly graph_hash: string;
}

@Injectable()
export class KnowledgeAdminService {
  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(KnowledgeGateway) private readonly knowledge: KnowledgeGateway,
    @Inject(KnowledgeAiRuntimeClient) private readonly semantic: KnowledgeAiRuntimeClient,
    @Inject(KnowledgeProviderSpaceService)
    private readonly providerSpaces: KnowledgeProviderSpaceService,
  ) {}

  async list(): Promise<KnowledgeBaseListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    const items = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const items = await transaction.knowledgeBase.findMany({
        where: { tenantId: principal.tenantId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        include: knowledgeBaseInclude,
      });
      return items.map(mapKnowledgeBase);
    });
    return { items: await this.attachExternalSpaces(principal.tenantId, items) };
  }

  async syncLexiangSpaces(): Promise<LexiangSpaceSyncResponse> {
    const principal = this.access.requireKnowledgeWrite();
    let remoteSpaces;
    try {
      remoteSpaces = await this.providerSpaces.listRemote(principal);
    } catch (error) {
      throw new BadGatewayException('乐享知识库目录读取失败，请检查连接状态后重试。', {
        cause: error,
      });
    }
    const linked = await this.providerSpaces.linkedKnowledgeBaseIds(
      principal.tenantId,
      remoteSpaces.map((space) => space.id),
    );
    let imported = 0;
    let updated = 0;
    let requiresPrivacyReview = 0;
    let entriesDiscovered = 0;
    let foldersSynchronized = 0;
    let documentsDiscovered = 0;
    let documentsImported = 0;
    let documentsUpdated = 0;
    let documentsArchived = 0;
    for (const remote of remoteSpaces) {
      let knowledgeBaseId = linked.get(remote.id);
      if (knowledgeBaseId === undefined) {
        const created = await this.create({
          name: importedLexiangSpaceName(remote.name),
          description: remote.description,
          status: 'DRAFT',
          orgUnitIds: [],
          memberUserIds: [principal.userId],
          storageProvider: 'LOCAL',
        });
        knowledgeBaseId = created.id;
        imported += 1;
      } else {
        updated += 1;
      }
      const synchronized = await this.providerSpaces.bindExisting(
        principal,
        knowledgeBaseId,
        remote,
      );
      if (synchronized.status !== 'ACTIVE') requiresPrivacyReview += 1;
      try {
        const entrySync = await this.providerSpaces.syncEntries(principal, knowledgeBaseId);
        entriesDiscovered += entrySync.entriesDiscovered;
        foldersSynchronized += entrySync.foldersSynchronized;
        documentsDiscovered += entrySync.documentsDiscovered;
        documentsImported += entrySync.documentsImported;
        documentsUpdated += entrySync.documentsUpdated;
        documentsArchived += entrySync.documentsArchived;
      } catch (error) {
        throw new BadGatewayException(`乐享知识库“${remote.name}”的文档目录同步失败，请重试。`, {
          cause: error,
        });
      }
    }
    return {
      discovered: remoteSpaces.length,
      imported,
      updated,
      requiresPrivacyReview,
      entriesDiscovered,
      foldersSynchronized,
      documentsDiscovered,
      documentsImported,
      documentsUpdated,
      documentsArchived,
    };
  }

  async ensureFolders(
    knowledgeBaseId: string,
    request: EnsureKnowledgeFoldersRequest,
  ): Promise<KnowledgeFolderListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    const requestedPaths = [...new Set(request.paths.map(normalizeKnowledgeFolderPath))].sort(
      (left, right) =>
        left.split('/').length - right.split('/').length || left.localeCompare(right),
    );
    await this.prisma.withTenant(principal.tenantId, (transaction) =>
      this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId),
    );
    if (await this.providerSpaces.isManaged(principal.tenantId, knowledgeBaseId)) {
      await this.providerSpaces.ensureFolders(principal, knowledgeBaseId, requestedPaths);
      return this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const items = await transaction.knowledgeFolder.findMany({
          where: { tenantId: principal.tenantId, knowledgeBaseId },
          orderBy: [{ path: 'asc' }, { id: 'asc' }],
          include: { _count: { select: { documents: true, children: true } } },
        });
        return { items: items.map(mapKnowledgeFolder) };
      });
    }
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      for (const requestedPath of requestedPaths) {
        let parentId: string | null = null;
        const segments = requestedPath.split('/');
        for (let index = 0; index < segments.length; index += 1) {
          const path = segments.slice(0, index + 1).join('/');
          let folder = await transaction.knowledgeFolder.findFirst({
            where: { tenantId: principal.tenantId, knowledgeBaseId, path },
            select: { id: true },
          });
          folder ??= await transaction.knowledgeFolder.create({
            data: {
              tenantId: principal.tenantId,
              knowledgeBaseId,
              parentId,
              name: segments[index]!,
              path,
              createdById: principal.userId,
            },
            select: { id: true },
          });
          parentId = folder.id;
        }
      }
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-folder.ensured',
        'knowledge_base',
        knowledgeBaseId,
        { paths: requestedPaths },
      );
      const items = await transaction.knowledgeFolder.findMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        orderBy: [{ path: 'asc' }, { id: 'asc' }],
        include: { _count: { select: { documents: true, children: true } } },
      });
      return { items: items.map(mapKnowledgeFolder) };
    });
  }

  async deleteFolder(
    knowledgeBaseId: string,
    folderId: string,
  ): Promise<KnowledgeFolderListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const folders = await transaction.knowledgeFolder.findMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        select: { id: true, parentId: true },
      });
      if (!folders.some((folder) => folder.id === folderId)) {
        throw new NotFoundException('The knowledge folder was not found.');
      }
      const externalFolder = await transaction.knowledgeExternalEntryBinding.findFirst({
        where: { tenantId: principal.tenantId, knowledgeBaseId, folderId },
        select: { id: true },
      });
      if (externalFolder !== null) {
        throw new BadRequestException('腾讯乐享文件夹只能在乐享中修改或删除，然后重新同步。');
      }

      const descendantIds = new Set([folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of folders) {
          if (
            folder.parentId !== null &&
            descendantIds.has(folder.parentId) &&
            !descendantIds.has(folder.id)
          ) {
            descendantIds.add(folder.id);
            changed = true;
          }
        }
      }
      const documents = await transaction.knowledgeDocument.findMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          folderId: { in: [...descendantIds] },
        },
        select: { id: true },
      });
      if (documents.length > 0) {
        await transaction.knowledgeDocument.updateMany({
          where: {
            tenantId: principal.tenantId,
            id: { in: documents.map((document) => document.id) },
          },
          data: { status: 'ARCHIVED', folderId: null },
        });
      }

      await transaction.knowledgeFolder.deleteMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId, id: folderId },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-folder.deleted',
        'knowledge_folder',
        folderId,
        {
          knowledgeBaseId,
          deletedFolderCount: descendantIds.size,
          deletedDocumentCount: documents.length,
        },
      );
      const remaining = await transaction.knowledgeFolder.findMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        orderBy: [{ path: 'asc' }, { id: 'asc' }],
        include: { _count: { select: { documents: true, children: true } } },
      });
      return { items: remaining.map(mapKnowledgeFolder) };
    });
  }

  async readiness(knowledgeBaseId: string): Promise<KnowledgeBaseIndexReadiness> {
    const principal = this.access.requireKnowledgeWrite();
    const capabilities = await this.safeKnowledgeCapabilities(principal.tenantId);
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: principal.tenantId, id: knowledgeBaseId },
        select: { activeEmbeddingIndexVersion: true },
      });
      if (knowledgeBase === null) throw knowledgeBaseNotFound();
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
      const activeEmbeddingIndexVersionId = knowledgeBase.activeEmbeddingIndexVersion?.id ?? null;
      const embeddedChunkCount =
        activeEmbeddingIndexVersionId !== null && currentVersionIds.length > 0
          ? await transaction.knowledgeChunk.count({
              where: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                documentVersionId: { in: currentVersionIds },
                embeddings: { some: { embeddingIndexVersionId: activeEmbeddingIndexVersionId } },
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

  async graphOverview(knowledgeBaseId: string): Promise<KnowledgeGraphOverview> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const scope = knowledgeGraphScopeSql(principal.tenantId, knowledgeBaseId);
      const [overview] = await transaction.$queryRaw<KnowledgeGraphOverviewRow[]>(Prisma.sql`
        WITH ${scope}
        SELECT
          (SELECT count(*)::int FROM current_entity_ids) AS entity_count,
          (SELECT count(*)::int FROM active_relations) AS relation_count,
          (
            SELECT count(*)::int
            FROM public."knowledge_ontology_versions" AS ontology_version
            WHERE ontology_version."tenant_id" = ${principal.tenantId}::uuid
              AND ontology_version."knowledge_base_id" = ${knowledgeBaseId}::uuid
              AND ontology_version."status" = 'PUBLISHED'::"KnowledgeOntologyVersionStatus"
          ) AS published_ontology_version_count,
          (
            SELECT count(*)::int
            FROM public."knowledge_relations" AS source_relation
            WHERE source_relation."tenant_id" = ${principal.tenantId}::uuid
              AND source_relation."knowledge_base_id" = ${knowledgeBaseId}::uuid
              AND source_relation."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"
              AND source_relation."subject_entity_id" IN (
                SELECT "entity_id" FROM current_entity_ids
              )
              AND source_relation."object_entity_id" IN (
                SELECT "entity_id" FROM current_entity_ids
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public."knowledge_graph_retrieval_relations" AS governed_relation
                WHERE governed_relation."tenant_id" = source_relation."tenant_id"
                  AND governed_relation."knowledge_base_id" = source_relation."knowledge_base_id"
                  AND governed_relation."id" = source_relation."id"
              )
          ) AS ungoverned_relation_count,
          (
            SELECT count(*)::int
            FROM public."knowledge_graph_conflicts" AS graph_conflict
            JOIN public."knowledge_graph_projections" AS graph_projection
              ON graph_projection."tenant_id" = graph_conflict."tenant_id"
             AND graph_projection."knowledge_base_id" = graph_conflict."knowledge_base_id"
             AND graph_projection."id" = graph_conflict."projection_id"
             AND graph_projection."status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"
            WHERE graph_conflict."tenant_id" = ${principal.tenantId}::uuid
              AND graph_conflict."knowledge_base_id" = ${knowledgeBaseId}::uuid
              AND graph_conflict."status" IN ('OPEN', 'IN_REVIEW')
          ) AS open_conflict_count,
          (SELECT count(*)::int FROM current_mentions) AS mention_count,
          (SELECT count(*)::int FROM current_evidence) AS evidence_count,
          (
            SELECT count(*)::int
            FROM current_entity_ids AS entity
            WHERE NOT EXISTS (
                SELECT 1
                FROM current_mentions AS mention
                WHERE mention."entity_id" = entity."entity_id"
              )
              AND NOT EXISTS (
                SELECT 1
                FROM active_relations AS relation
                WHERE relation."subject_entity_id" = entity."entity_id"
                   OR relation."object_entity_id" = entity."entity_id"
              )
          ) AS orphan_entity_count,
          (
            SELECT count(*)::int
            FROM active_relations AS relation
            WHERE NOT EXISTS (
              SELECT 1
              FROM current_evidence AS evidence
              WHERE evidence."relation_id" = relation."id"
            )
          ) AS relations_without_evidence_count,
          (SELECT count(*)::int FROM current_chunks) AS published_chunk_count,
          (
            SELECT count(DISTINCT linked."chunk_id")::int
            FROM (
              SELECT "chunk_id" FROM current_mentions
              UNION
              SELECT "chunk_id" FROM current_evidence
            ) AS linked
          ) AS linked_chunk_count,
          (
            SELECT count(*)::int
            FROM latest_versions
            WHERE "status" = 'PROCESSING'::"KnowledgeDocumentVersionStatus"
          ) AS processing_count,
          (
            SELECT count(*)::int
            FROM latest_versions
            WHERE "status" = 'FAILED'::"KnowledgeDocumentVersionStatus"
          ) AS failed_count,
          (
            SELECT max("built_at")
            FROM (
              SELECT max("created_at") AS built_at FROM current_mentions
              UNION ALL
              SELECT max("created_at") AS built_at FROM current_evidence
            ) AS graph_builds
          ) AS last_built_at
      `);
      if (overview === undefined) throw new Error('KNOWLEDGE_GRAPH_OVERVIEW_UNAVAILABLE');

      const entityTypes = await transaction.$queryRaw<KnowledgeGraphTypeCountRow[]>(Prisma.sql`
        WITH ${scope}
        SELECT entity."entity_type" AS key, count(*)::int AS count
        FROM public."knowledge_entities" AS entity
        JOIN current_entity_ids ON current_entity_ids."entity_id" = entity."id"
        WHERE entity."tenant_id" = ${principal.tenantId}::uuid
          AND entity."knowledge_base_id" = ${knowledgeBaseId}::uuid
        GROUP BY entity."entity_type"
        ORDER BY count DESC, key ASC
        LIMIT 100
      `);
      const relationTypes = await transaction.$queryRaw<KnowledgeGraphTypeCountRow[]>(Prisma.sql`
        WITH ${scope}
        SELECT relation."normalized_predicate" AS key, count(*)::int AS count
        FROM active_relations AS relation
        GROUP BY relation."normalized_predicate"
        ORDER BY count DESC, key ASC
        LIMIT 100
      `);

      const readiness = deriveKnowledgeGraphReadiness({
        entityCount: overview.entity_count,
        relationCount: overview.relation_count,
        relationsWithoutEvidenceCount: overview.relations_without_evidence_count,
        publishedChunkCount: overview.published_chunk_count,
        linkedChunkCount: overview.linked_chunk_count,
        processingCount: overview.processing_count,
        failedCount: overview.failed_count,
        publishedOntologyVersionCount: overview.published_ontology_version_count,
        ungovernedRelationCount: overview.ungoverned_relation_count,
        openConflictCount: overview.open_conflict_count,
      });
      return {
        knowledgeBaseId,
        status: readiness.status,
        entityCount: overview.entity_count,
        relationCount: overview.relation_count,
        mentionCount: overview.mention_count,
        evidenceCount: overview.evidence_count,
        orphanEntityCount: overview.orphan_entity_count,
        relationsWithoutEvidenceCount: overview.relations_without_evidence_count,
        publishedChunkCount: overview.published_chunk_count,
        linkedChunkCount: overview.linked_chunk_count,
        mentionCoverage: readiness.mentionCoverage,
        evidenceCoverage: readiness.evidenceCoverage,
        entityTypes: entityTypes.map((row) => ({ type: row.key, count: row.count })),
        relationTypes: relationTypes.map((row) => ({ predicate: row.key, count: row.count })),
        diagnostics: [...readiness.diagnostics],
        lastBuiltAt: overview.last_built_at?.toISOString() ?? null,
      };
    });
  }

  async graph(
    knowledgeBaseId: string,
    request: KnowledgeGraphQuery,
  ): Promise<KnowledgeGraphResponse> {
    const principal = this.access.requireKnowledgeWrite();
    const query = request.query?.trim() || null;
    const entityType = request.entityType?.trim() || null;
    const focusEntityId = request.focusEntityId ?? null;
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const scope = knowledgeGraphScopeSql(principal.tenantId, knowledgeBaseId);
      const filter = knowledgeGraphEntityFilterSql(query, entityType, focusEntityId);
      const [entityCount] = await transaction.$queryRaw<Array<{ readonly count: number }>>(
        Prisma.sql`
          WITH ${scope}
          SELECT count(*)::int AS count
          FROM public."knowledge_entities" AS entity
          JOIN current_entity_ids ON current_entity_ids."entity_id" = entity."id"
          WHERE entity."tenant_id" = ${principal.tenantId}::uuid
            AND entity."knowledge_base_id" = ${knowledgeBaseId}::uuid
            AND ${filter}
        `,
      );
      const entityRows = await transaction.$queryRaw<KnowledgeGraphEntityRow[]>(Prisma.sql`
        WITH ${scope}
        SELECT
          entity."id"::text AS id,
          entity."entity_type" AS entity_type,
          entity."canonical_name" AS canonical_name,
          entity."description" AS description,
          ARRAY(
            SELECT DISTINCT candidate_alias."value"
            FROM (
              SELECT legacy_alias AS "value"
              FROM unnest(entity."aliases") AS legacy_alias
              UNION ALL
              SELECT governed_alias."alias" AS "value"
              FROM public."knowledge_entity_aliases" AS governed_alias
              WHERE governed_alias."tenant_id" = entity."tenant_id"
                AND governed_alias."knowledge_base_id" = entity."knowledge_base_id"
                AND public.knowledge_graph_resolve_canonical_entity(
                  governed_alias."tenant_id",
                  governed_alias."knowledge_base_id",
                  governed_alias."entity_id"
                ) = entity."id"
                AND governed_alias."active"
            ) AS candidate_alias
            WHERE btrim(candidate_alias."value") <> ''
            ORDER BY candidate_alias."value"
          ) AS aliases,
          entity."attributes" AS attributes,
          entity."confidence"::double precision AS confidence,
          (
            SELECT count(*)::int
            FROM current_mentions AS mention
            WHERE mention."entity_id" = entity."id"
          ) AS mention_count,
          (
            SELECT count(*)::int
            FROM active_relations AS relation
            WHERE relation."subject_entity_id" = entity."id"
               OR relation."object_entity_id" = entity."id"
          ) AS relation_count,
          entity."updated_at" AS updated_at
        FROM public."knowledge_entities" AS entity
        JOIN current_entity_ids ON current_entity_ids."entity_id" = entity."id"
        WHERE entity."tenant_id" = ${principal.tenantId}::uuid
          AND entity."knowledge_base_id" = ${knowledgeBaseId}::uuid
          AND ${filter}
        ORDER BY relation_count DESC, mention_count DESC, entity."canonical_name" ASC, entity."id" ASC
        LIMIT ${request.limit}
      `);
      if (entityRows.length === 0) {
        return {
          knowledgeBaseId,
          query,
          entityType,
          focusEntityId,
          totalEntities: entityCount?.count ?? 0,
          totalRelations: 0,
          entities: [],
          relations: [],
        };
      }

      const entityIds = entityRows.map((entity) => entity.id);
      const entityIdSql = Prisma.join(entityIds.map((id) => Prisma.sql`${id}::uuid`));
      const [relationCount] = await transaction.$queryRaw<Array<{ readonly count: number }>>(
        Prisma.sql`
          WITH ${scope}
          SELECT count(*)::int AS count
          FROM active_relations AS relation
          WHERE relation."subject_entity_id" IN (${entityIdSql})
             OR relation."object_entity_id" IN (${entityIdSql})
        `,
      );
      const relationRows = await transaction.$queryRaw<KnowledgeGraphRelationRow[]>(Prisma.sql`
        WITH ${scope}
        SELECT
          relation."id"::text AS id,
          relation."subject_entity_id"::text AS subject_entity_id,
          subject."canonical_name" AS subject_entity_name,
          relation."normalized_predicate" AS predicate,
          relation."object_entity_id"::text AS object_entity_id,
          object."canonical_name" AS object_entity_name,
          relation."attributes" AS attributes,
          relation."confidence"::double precision AS confidence,
          (
            SELECT count(*)::int
            FROM current_evidence AS evidence
            WHERE evidence."relation_id" = relation."id"
          ) AS evidence_count,
          relation."updated_at" AS updated_at
        FROM active_relations AS relation
        JOIN public."knowledge_entities" AS subject
          ON subject."tenant_id" = relation."tenant_id"
         AND subject."knowledge_base_id" = relation."knowledge_base_id"
         AND subject."id" = relation."subject_entity_id"
        JOIN public."knowledge_entities" AS object
          ON object."tenant_id" = relation."tenant_id"
         AND object."knowledge_base_id" = relation."knowledge_base_id"
         AND object."id" = relation."object_entity_id"
        WHERE relation."subject_entity_id" IN (${entityIdSql})
           OR relation."object_entity_id" IN (${entityIdSql})
        ORDER BY evidence_count DESC, relation."confidence" DESC, relation."id" ASC
        LIMIT ${Math.min(200, request.limit * 4)}
      `);

      const evidenceByRelationId = new Map<string, KnowledgeGraphEvidenceRow[]>();
      if (relationRows.length > 0) {
        const relationIdSql = Prisma.join(
          relationRows.map((relation) => Prisma.sql`${relation.id}::uuid`),
        );
        const evidenceRows = await transaction.$queryRaw<KnowledgeGraphEvidenceRow[]>(Prisma.sql`
          WITH ${scope}
          SELECT
            evidence."id"::text AS id,
            evidence."relation_id"::text AS relation_id,
            evidence."chunk_id"::text AS chunk_id,
            evidence."document_id"::text AS document_id,
            evidence."document_version_id"::text AS document_version_id,
            evidence."excerpt" AS excerpt,
            evidence."confidence"::double precision AS confidence
          FROM current_evidence AS evidence
          WHERE evidence."relation_id" IN (${relationIdSql})
          ORDER BY evidence."confidence" DESC, evidence."created_at" DESC, evidence."id" ASC
        `);
        for (const evidence of evidenceRows) {
          const current = evidenceByRelationId.get(evidence.relation_id) ?? [];
          if (current.length < 10) current.push(evidence);
          evidenceByRelationId.set(evidence.relation_id, current);
        }
      }

      return {
        knowledgeBaseId,
        query,
        entityType,
        focusEntityId,
        totalEntities: entityCount?.count ?? 0,
        totalRelations: relationCount?.count ?? 0,
        entities: entityRows.map((entity) => ({
          id: entity.id,
          entityType: entity.entity_type,
          canonicalName: entity.canonical_name,
          description: entity.description,
          aliases: entity.aliases,
          attributes: jsonRecord(entity.attributes),
          confidence: entity.confidence,
          mentionCount: entity.mention_count,
          relationCount: entity.relation_count,
          updatedAt: entity.updated_at.toISOString(),
        })),
        relations: relationRows.map((relation) => ({
          id: relation.id,
          subjectEntityId: relation.subject_entity_id,
          subjectEntityName: relation.subject_entity_name,
          predicate: relation.predicate,
          objectEntityId: relation.object_entity_id,
          objectEntityName: relation.object_entity_name,
          attributes: jsonRecord(relation.attributes),
          confidence: relation.confidence,
          evidenceCount: relation.evidence_count,
          evidence: (evidenceByRelationId.get(relation.id) ?? []).map((evidence) => ({
            id: evidence.id,
            chunkId: evidence.chunk_id,
            documentId: evidence.document_id,
            documentVersionId: evidence.document_version_id,
            excerpt: evidence.excerpt,
            confidence: evidence.confidence,
          })),
          updatedAt: relation.updated_at.toISOString(),
        })),
      };
    });
  }

  async create(request: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    const storageProvider = request.storageProvider ?? 'LOCAL';
    if (storageProvider === 'LEXIANG') {
      await this.providerSpaces.assertLexiangReady(principal.tenantId);
    }
    const capabilities = await this.safeKnowledgeCapabilities(principal.tenantId);
    try {
      const created = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const scopes = normalizeKnowledgeScopes(request.orgUnitScopes, request.orgUnitIds);
        const memberUserIds = uniqueIds(request.memberUserIds ?? []);
        const space = await resolveKnowledgeSpace(
          transaction,
          principal.tenantId,
          principal.userId,
          request.space ?? { type: 'COMPANY' },
        );
        await this.requireOrgUnits(
          transaction,
          principal.tenantId,
          scopes.map((scope) => scope.orgUnitId),
        );
        await this.requireKnowledgeAccessMembers(transaction, principal.tenantId, memberUserIds);
        await lockKnowledgeBaseKeyspace(transaction, principal.tenantId);
        const knowledgeBaseKey = await resolveKnowledgeBaseKey(
          transaction,
          principal.tenantId,
          request.name,
          request.key,
        );
        const knowledgeBase = await transaction.knowledgeBase.create({
          data: {
            tenantId: principal.tenantId,
            key: knowledgeBaseKey,
            name: request.name,
            description: request.description ?? null,
            status: storageProvider === 'LEXIANG' ? 'DRAFT' : request.status,
            spaceType: space.type,
            spaceTargetId: space.targetId,
            spaceTargetName: space.targetName,
            ...(request.retrievalConfig === undefined
              ? {}
              : knowledgeRetrievalConfigData(request.retrievalConfig)),
            ...(request.chunkingConfig === undefined
              ? {}
              : knowledgeChunkingConfigData(request.chunkingConfig)),
            createdById: principal.userId,
          },
          select: { id: true, key: true },
        });
        let activeEmbeddingIndexVersionId: string | null = null;
        if (
          capabilities.embedding.status === 'READY' &&
          isEmbeddingProvider(capabilities.embedding.provider) &&
          capabilities.embedding.model !== null &&
          capabilities.embedding.dimensions !== null
        ) {
          const activeIndex = await transaction.knowledgeEmbeddingIndexVersion.create({
            data: {
              tenantId: principal.tenantId,
              knowledgeBaseId: knowledgeBase.id,
              version: 1,
              status: 'ACTIVE',
              provider: capabilities.embedding.provider,
              model: capabilities.embedding.model,
              dimensions: capabilities.embedding.dimensions,
              distance: 'COSINE',
              normalization: 'L2',
              collectionName: embeddingCollectionName(
                knowledgeBase.id,
                1,
                capabilities.embedding.dimensions,
              ),
              createdById: principal.userId,
              activatedAt: new Date(),
            },
            select: { id: true },
          });
          activeEmbeddingIndexVersionId = activeIndex.id;
          await transaction.knowledgeBase.update({
            where: { id: knowledgeBase.id },
            data: { activeEmbeddingIndexVersionId },
          });
        }
        const ontologyId = randomUUID();
        const ontologyVersionId = randomUUID();
        const bootstrapSchemaHash = createHash('sha256')
          .update('{"entityTypes":[],"predicates":[]}')
          .digest('hex');
        const bootstrapRequestHash = createHash('sha256')
          .update(
            JSON.stringify({
              action: 'SYSTEM_DRAFT_ONTOLOGY_BOOTSTRAP',
              knowledgeBaseId: knowledgeBase.id,
              ontologyId,
              ontologyVersionId,
              schemaHash: bootstrapSchemaHash,
            }),
          )
          .digest('hex');
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."knowledge_ontologies"(
            "id",
            "tenant_id",
            "knowledge_base_id",
            "code",
            "name",
            "description",
            "created_by_user_id",
            "idempotency_key",
            "request_hash"
          ) VALUES (
            ${ontologyId}::uuid,
            ${principal.tenantId}::uuid,
            ${knowledgeBase.id}::uuid,
            'SYSTEM_DRAFT',
            ${`${request.name.slice(0, 180)} relation schema`},
            'System-created draft ontology. Govern entity types and predicates before relation promotion.',
            ${principal.userId}::uuid,
            ${`system:knowledge-base:${knowledgeBase.id}:ontology`},
            ${bootstrapRequestHash}
          )
        `);
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO public."knowledge_ontology_versions"(
            "id",
            "tenant_id",
            "knowledge_base_id",
            "ontology_id",
            "version_number",
            "status",
            "change_summary",
            "schema_hash",
            "created_by_user_id",
            "system_bootstrap",
            "idempotency_key",
            "request_hash"
          ) VALUES (
            ${ontologyVersionId}::uuid,
            ${principal.tenantId}::uuid,
            ${knowledgeBase.id}::uuid,
            ${ontologyId}::uuid,
            1,
            'DRAFT'::"KnowledgeOntologyVersionStatus",
            'System draft: define and independently review the relationship schema.',
            ${bootstrapSchemaHash},
            ${principal.userId}::uuid,
            true,
            ${`system:knowledge-base:${knowledgeBase.id}:ontology-version:1`},
            ${bootstrapRequestHash}
          )
        `);
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
        if (memberUserIds.length > 0) {
          await transaction.knowledgeBaseMember.createMany({
            data: memberUserIds.map((userId) => ({
              tenantId: principal.tenantId,
              knowledgeBaseId: knowledgeBase.id,
              userId,
            })),
          });
        }
        await recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-base.created',
          'knowledge_base',
          knowledgeBase.id,
          {
            key: knowledgeBase.key,
            space: {
              type: space.type,
              targetId: space.targetId,
              targetName: space.targetName,
            },
            orgUnitScopes: scopes,
            memberUserIds,
            draftOntologyId: ontologyId,
            draftOntologyVersionId: ontologyVersionId,
            ontologyStatus: 'DRAFT',
            activeEmbeddingIndexVersionId,
          },
        );
        return mapKnowledgeBase(
          await this.findKnowledgeBase(transaction, principal.tenantId, knowledgeBase.id),
        );
      });
      if (storageProvider === 'LOCAL') return created;

      const externalSpace = await this.providerSpaces.provision(
        principal,
        created.id,
        created.name,
      );
      let result = created;
      if (externalSpace.status === 'ACTIVE' && request.status !== 'DRAFT') {
        result = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
          await transaction.knowledgeBase.update({
            where: { id: created.id },
            data: { status: request.status, version: { increment: 1 } },
          });
          return mapKnowledgeBase(
            await this.findKnowledgeBase(transaction, principal.tenantId, created.id),
          );
        });
      }
      return { ...result, storageProvider: 'LEXIANG', externalSpace };
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('A knowledge base with this key already exists.');
      }
      throw error;
    }
  }

  async listEmbeddingIndexVersions(
    knowledgeBaseId: string,
  ): Promise<KnowledgeEmbeddingIndexVersionListResponse> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const items = await transaction.knowledgeEmbeddingIndexVersion.findMany({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      });
      return { items: items.map(mapKnowledgeEmbeddingIndexVersion) };
    });
  }

  async createEmbeddingIndexVersion(
    knowledgeBaseId: string,
    request: CreateKnowledgeEmbeddingIndexVersionRequest,
  ): Promise<KnowledgeEmbeddingIndexVersion> {
    const principal = this.access.requireKnowledgeWrite();
    const capabilities = await this.safeKnowledgeCapabilities(principal.tenantId);
    if (
      capabilities.embedding.status !== 'READY' ||
      !isEmbeddingProvider(capabilities.embedding.provider) ||
      capabilities.embedding.model === null ||
      capabilities.embedding.dimensions === null
    ) {
      throw new ConflictException('The configured AI Runtime embedding provider is not ready.');
    }
    if (
      capabilities.embedding.provider !== request.provider ||
      capabilities.embedding.model !== request.model ||
      capabilities.embedding.dimensions !== request.dimensions
    ) {
      throw new ConflictException(
        'The requested embedding profile does not match the profile currently served by AI Runtime.',
      );
    }
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: principal.tenantId, id: knowledgeBaseId },
        include: {
          activeEmbeddingIndexVersion: true,
          pendingEmbeddingIndexVersion: true,
        },
      });
      if (knowledgeBase === null) throw knowledgeBaseNotFound();
      if (knowledgeBase.pendingEmbeddingIndexVersion !== null) {
        throw new ConflictException(
          'Finish or activate the existing embedding index rebuild before creating another version.',
        );
      }
      const active = knowledgeBase.activeEmbeddingIndexVersion;
      if (
        active !== null &&
        active.provider === request.provider &&
        active.model === request.model &&
        active.dimensions === request.dimensions &&
        active.distance === request.distance &&
        active.normalization === request.normalization
      ) {
        throw new ConflictException('This embedding profile is already active.');
      }
      const aggregate = await transaction.knowledgeEmbeddingIndexVersion.aggregate({
        where: { tenantId: principal.tenantId, knowledgeBaseId },
        _max: { version: true },
      });
      const version = (aggregate._max.version ?? 0) + 1;
      const created = await transaction.knowledgeEmbeddingIndexVersion.create({
        data: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          version,
          status: 'BUILDING',
          provider: request.provider,
          model: request.model,
          dimensions: request.dimensions,
          distance: request.distance,
          normalization: request.normalization,
          collectionName: embeddingCollectionName(knowledgeBaseId, version, request.dimensions),
          createdById: principal.userId,
        },
      });
      await transaction.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: {
          pendingEmbeddingIndexVersionId: created.id,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-base.embedding-index-version.created',
        'knowledge_embedding_index_version',
        created.id,
        {
          knowledgeBaseId,
          version,
          provider: request.provider,
          model: request.model,
          dimensions: request.dimensions,
          collectionName: created.collectionName,
          rebuildRequired: true,
        },
      );
      return mapKnowledgeEmbeddingIndexVersion(created);
    });
  }

  async activateEmbeddingIndexVersion(
    knowledgeBaseId: string,
    embeddingIndexVersionId: string,
  ): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const knowledgeBase = await transaction.knowledgeBase.findFirst({
        where: { tenantId: principal.tenantId, id: knowledgeBaseId },
        select: {
          activeEmbeddingIndexVersionId: true,
          pendingEmbeddingIndexVersionId: true,
        },
      });
      if (knowledgeBase === null) throw knowledgeBaseNotFound();
      if (knowledgeBase.pendingEmbeddingIndexVersionId !== embeddingIndexVersionId) {
        throw new ConflictException('Only the current pending embedding index can be activated.');
      }
      const target = await transaction.knowledgeEmbeddingIndexVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          id: embeddingIndexVersionId,
          status: 'BUILDING',
        },
      });
      if (target === null) throw new ConflictException('The embedding index is not buildable.');
      const [coverage] = await transaction.$queryRaw<
        Array<{ readonly chunk_count: number; readonly embedded_count: number }>
      >(Prisma.sql`
        SELECT
          count(chunk."id")::int AS chunk_count,
          count(embedding."id")::int AS embedded_count
        FROM public."knowledge_documents" document
        JOIN public."knowledge_chunks" chunk
          ON chunk."tenant_id" = document."tenant_id"
         AND chunk."knowledge_base_id" = document."knowledge_base_id"
         AND chunk."document_id" = document."id"
         AND chunk."document_version_id" = document."current_version_id"
        LEFT JOIN public."knowledge_chunk_embeddings" embedding
          ON embedding."tenant_id" = chunk."tenant_id"
         AND embedding."chunk_id" = chunk."id"
         AND embedding."embedding_index_version_id" = ${embeddingIndexVersionId}::uuid
         AND embedding."content_hash" = chunk."content_hash"
        WHERE document."tenant_id" = ${principal.tenantId}::uuid
          AND document."knowledge_base_id" = ${knowledgeBaseId}::uuid
          AND document."status" = 'READY'
      `);
      if (coverage === undefined || coverage.embedded_count !== coverage.chunk_count) {
        throw new ConflictException(
          `Embedding rebuild is incomplete (${coverage?.embedded_count ?? 0}/${coverage?.chunk_count ?? 0} current chunks).`,
        );
      }
      const activatedAt = new Date();
      if (
        knowledgeBase.activeEmbeddingIndexVersionId !== null &&
        knowledgeBase.activeEmbeddingIndexVersionId !== target.id
      ) {
        await transaction.knowledgeEmbeddingIndexVersion.update({
          where: { id: knowledgeBase.activeEmbeddingIndexVersionId },
          data: { status: 'RETIRED', retiredAt: activatedAt },
        });
      }
      await transaction.knowledgeEmbeddingIndexVersion.update({
        where: { id: target.id },
        data: { status: 'ACTIVE', activatedAt, retiredAt: null, failureCode: null },
      });
      await transaction.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: {
          activeEmbeddingIndexVersionId: target.id,
          pendingEmbeddingIndexVersionId: null,
          version: { increment: 1 },
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-base.embedding-index-version.activated',
        'knowledge_embedding_index_version',
        target.id,
        {
          knowledgeBaseId,
          version: target.version,
          model: target.model,
          dimensions: target.dimensions,
          chunkCount: coverage.chunk_count,
          previousIndexVersionId: knowledgeBase.activeEmbeddingIndexVersionId,
        },
      );
      return mapKnowledgeBase(
        await this.findKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId),
      );
    });
  }

  async update(id: string, request: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    if (request.status === 'ARCHIVED') return this.delete(id, request.expectedVersion);
    const updated = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.knowledgeBase.findFirst({
        where: { id, tenantId: principal.tenantId },
      });
      if (current === null) throw knowledgeBaseNotFound();
      const requestedScopes =
        request.orgUnitScopes !== undefined || request.orgUnitIds !== undefined
          ? normalizeKnowledgeScopes(request.orgUnitScopes, request.orgUnitIds ?? [])
          : null;
      const requestedMemberUserIds =
        request.memberUserIds === undefined ? null : uniqueIds(request.memberUserIds);
      if (requestedScopes !== null) {
        await this.requireOrgUnits(
          transaction,
          principal.tenantId,
          requestedScopes.map((scope) => scope.orgUnitId),
        );
      }
      if (requestedMemberUserIds !== null) {
        await this.requireKnowledgeAccessMembers(
          transaction,
          principal.tenantId,
          requestedMemberUserIds,
        );
      }
      const requestedSpace =
        request.space === undefined
          ? null
          : await resolveKnowledgeSpace(
              transaction,
              principal.tenantId,
              principal.userId,
              request.space,
            );
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
          ...(requestedSpace === null
            ? {}
            : {
                spaceType: requestedSpace.type,
                spaceTargetId: requestedSpace.targetId,
                spaceTargetName: requestedSpace.targetName,
              }),
          ...(request.retrievalConfig === undefined
            ? {}
            : knowledgeRetrievalConfigData(request.retrievalConfig)),
          ...(request.chunkingConfig === undefined
            ? {}
            : knowledgeChunkingConfigData(request.chunkingConfig)),
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
      if (requestedMemberUserIds !== null) {
        await transaction.knowledgeBaseMember.deleteMany({
          where: { tenantId: principal.tenantId, knowledgeBaseId: id },
        });
        if (requestedMemberUserIds.length > 0) {
          await transaction.knowledgeBaseMember.createMany({
            data: requestedMemberUserIds.map((userId) => ({
              tenantId: principal.tenantId,
              knowledgeBaseId: id,
              userId,
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
        {
          previousVersion: current.version,
          version: updated.version,
          previousSpace: {
            type: current.spaceType,
            targetId: current.spaceTargetId,
            targetName: current.spaceTargetName,
          },
          space: {
            type: requestedSpace?.type ?? current.spaceType,
            targetId: requestedSpace?.targetId ?? current.spaceTargetId,
            targetName: requestedSpace?.targetName ?? current.spaceTargetName,
          },
          retrievalConfigChanged: request.retrievalConfig !== undefined,
          chunkingConfigChanged: request.chunkingConfig !== undefined,
          accessScopeChanged: requestedScopes !== null || requestedMemberUserIds !== null,
          ...(requestedScopes === null ? {} : { orgUnitScopes: requestedScopes }),
          ...(requestedMemberUserIds === null ? {} : { memberUserIds: requestedMemberUserIds }),
        },
      );
      return mapKnowledgeBase(updated);
    });
    const renamed =
      request.name === undefined
        ? null
        : await this.providerSpaces.rename(principal, updated.id, request.name);
    if (renamed !== null) {
      return { ...updated, storageProvider: 'LEXIANG', externalSpace: renamed };
    }
    const [result] = await this.attachExternalSpaces(principal.tenantId, [updated]);
    return result!;
  }

  async delete(id: string, expectedVersion: number): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    const current = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeBase.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { id: true, name: true, version: true },
      }),
    );
    if (current === null) throw knowledgeBaseNotFound();
    if (current.version !== expectedVersion) throw optimisticConflict('knowledge base');

    await this.providerSpaces.delete(principal, id);
    const archived = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const result = await transaction.knowledgeBase.updateMany({
        where: { id, tenantId: principal.tenantId, version: expectedVersion },
        data: { status: 'ARCHIVED', version: { increment: 1 } },
      });
      if (result.count !== 1) throw optimisticConflict('knowledge base');
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-base.deleted',
        'knowledge_base',
        id,
        { previousVersion: expectedVersion, remoteDeleteCompleted: true },
      );
      return mapKnowledgeBase(await this.findKnowledgeBase(transaction, principal.tenantId, id));
    });
    const [result] = await this.attachExternalSpaces(principal.tenantId, [archived]);
    return result!;
  }

  async syncExternal(id: string): Promise<KnowledgeBase> {
    const principal = this.access.requireKnowledgeWrite();
    const current = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      transaction.knowledgeBase.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { id: true, name: true, status: true },
      }),
    );
    if (current === null) throw knowledgeBaseNotFound();
    const existingExternalSpace = (await this.providerSpaces.list(principal.tenantId, [id])).get(
      id,
    );
    if (existingExternalSpace === undefined || existingExternalSpace.status === 'DELETED') {
      throw new BadRequestException('该知识库不是可重新同步的腾讯乐享知识库。');
    }
    const externalSpace = await this.providerSpaces.provision(principal, id, current.name);
    await this.providerSpaces.syncEntries(principal, id);
    let knowledgeBase = await this.prisma.withTenant(principal.tenantId, (transaction) =>
      this.findKnowledgeBase(transaction, principal.tenantId, id),
    );
    if (externalSpace.status === 'ACTIVE' && current.status === 'DRAFT') {
      knowledgeBase = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        await transaction.knowledgeBase.update({
          where: { id },
          data: { status: 'ACTIVE', version: { increment: 1 } },
        });
        return this.findKnowledgeBase(transaction, principal.tenantId, id);
      });
    }
    return {
      ...mapKnowledgeBase(knowledgeBase),
      storageProvider: 'LEXIANG',
      externalSpace,
    };
  }

  async createDocument(
    knowledgeBaseId: string,
    request: CreateKnowledgeDocumentRequest,
  ): Promise<KnowledgeDocument> {
    if (request.sourceType === 'FILE' || request.sourceType === 'WEB') {
      throw new BadRequestException(
        'File and web documents must be created through their controlled import endpoints.',
      );
    }
    const content = request.contentText ?? '';
    if (request.status === 'READY' && content.trim().length === 0) {
      throw new BadRequestException('An indexed text document must contain searchable text.');
    }
    const documentId = await this.knowledge.createTextVersion({
      knowledgeBaseId,
      title: request.title,
      sourceType: request.sourceType,
      content,
      publish: request.status === 'READY',
      ...(request.governance === undefined ? {} : { governance: request.governance }),
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
      readonly folderId?: string | null;
      readonly changeSummary?: string;
      readonly governance?: KnowledgeDocumentGovernancePolicy;
    },
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    if (await this.providerSpaces.isManaged(principal.tenantId, knowledgeBaseId)) {
      await this.prisma.withTenant(principal.tenantId, (transaction) =>
        this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId),
      );
      const documentId = await this.providerSpaces.uploadFile(principal, knowledgeBaseId, input);
      return this.getDocument(knowledgeBaseId, documentId);
    }
    const duplicate = await this.inspectUpload(knowledgeBaseId, {
      fileName: input.fileName,
      size: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      folderId: input.folderId ?? null,
    });
    if (duplicate.decision === 'EXACT_DUPLICATE' && duplicate.matchingDocument !== null) {
      return this.getDocument(knowledgeBaseId, duplicate.matchingDocument.id);
    }
    const documentId = await this.knowledge.upload({ knowledgeBaseId, ...input });
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async inspectUpload(
    knowledgeBaseId: string,
    request: InspectKnowledgeUploadRequest,
  ): Promise<KnowledgeUploadInspection> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      if (request.documentId !== undefined) {
        const intendedDocument = await transaction.knowledgeDocument.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            id: request.documentId,
            status: { not: 'ARCHIVED' },
          },
          select: { id: true },
        });
        if (intendedDocument === null) throw knowledgeDocumentNotFound();
      }
      if (request.folderId !== undefined && request.folderId !== null) {
        const folder = await transaction.knowledgeFolder.findFirst({
          where: { tenantId: principal.tenantId, knowledgeBaseId, id: request.folderId },
          select: { id: true },
        });
        if (folder === null) throw new BadRequestException('The knowledge folder was not found.');
      }
      const exact = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          sourceType: 'FILE',
          status: 'READY',
          objectSha256: request.sha256,
          ...(request.documentId === undefined ? {} : { documentId: request.documentId }),
          document: {
            status: { not: 'ARCHIVED' },
            ...(request.documentId === undefined && request.folderId !== undefined
              ? { folderId: request.folderId }
              : {}),
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          versionNumber: true,
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              documentVersion: true,
              updatedAt: true,
            },
          },
        },
      });
      if (exact !== null) {
        return {
          decision: 'EXACT_DUPLICATE',
          matchingDocument: uploadMatch(exact.document, exact.versionNumber),
        };
      }
      const sameName = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          sourceType: 'FILE',
          fileName: { equals: request.fileName, mode: 'insensitive' },
          ...(request.documentId === undefined ? {} : { documentId: request.documentId }),
          document: {
            status: { not: 'ARCHIVED' },
            ...(request.documentId === undefined && request.folderId !== undefined
              ? { folderId: request.folderId }
              : {}),
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          versionNumber: true,
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              documentVersion: true,
              updatedAt: true,
            },
          },
        },
      });
      if (sameName !== null) {
        return {
          decision: 'NEW_VERSION_CANDIDATE',
          matchingDocument: uploadMatch(sameName.document, sameName.versionNumber),
        };
      }
      return { decision: 'NEW_DOCUMENT', matchingDocument: null };
    });
  }

  async importWebDocument(
    knowledgeBaseId: string,
    request: ImportKnowledgeWebDocumentRequest,
  ): Promise<KnowledgeDocument> {
    const documentId = await this.knowledge.importWeb({
      knowledgeBaseId,
      sourceUri: request.url,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.changeSummary === undefined ? {} : { changeSummary: request.changeSummary }),
      ...(request.governance === undefined ? {} : { governance: request.governance }),
    });
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
      readonly governance?: KnowledgeDocumentGovernancePolicy;
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
        select: {
          id: true,
          title: true,
          sourceType: true,
          status: true,
          externalEntryBinding: { select: { id: true } },
        },
      }),
    );
    if (current === null) throw knowledgeDocumentNotFound();
    if (current.externalEntryBinding) {
      throw new BadRequestException('腾讯乐享文档只能在乐享中更新，然后重新同步。');
    }
    if (current.sourceType !== 'FILE') {
      throw new BadRequestException('Only file documents accept uploaded file versions.');
    }
    if (current.status === 'ARCHIVED') {
      throw new ConflictException('An archived document cannot receive a new version.');
    }
    const duplicate = await this.inspectUpload(knowledgeBaseId, {
      fileName: input.fileName,
      size: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      documentId,
    });
    if (duplicate.decision === 'EXACT_DUPLICATE') {
      return this.getDocument(knowledgeBaseId, documentId);
    }
    const uploadedDocumentId = await this.knowledge.uploadFileVersion({
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
    if (current.sourceType === 'FILE' || current.sourceType === 'WEB') {
      throw new BadRequestException(
        'File and web documents must be revised through their controlled import endpoints.',
      );
    }
    const content = request.contentText ?? current.contentText ?? '';
    const publish =
      request.status === 'READY' || (request.status === undefined && current.status === 'READY');
    if (publish && content.trim().length === 0) {
      throw new BadRequestException('An indexed text document must contain searchable text.');
    }
    await this.knowledge.createTextVersion({
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
    const retriedDocumentId = await this.knowledge.retry(documentVersionId);
    if (retriedDocumentId !== documentId) throw knowledgeDocumentNotFound();
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async listPendingParseReviews(
    knowledgeBaseId: string,
  ): Promise<KnowledgeParseReviewQueueResponse> {
    const principal = this.access.requireKnowledgeWrite();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const versions = await transaction.knowledgeDocumentVersion.findMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          parseReviewStatus: 'PENDING',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
        include: knowledgeDocumentVersionInclude,
      });
      return {
        items: versions.map((version) => ({
          ...mapKnowledgeDocumentVersion(version),
          documentId: version.documentId,
          // Review queues expose diagnostics and extracted quality metadata,
          // never the original HTML or the full extracted document body.
          contentText: null,
          graphProjectionId: null,
          graphProjectionStatus: null,
          graphProjectionHash: null,
        })),
      };
    });
  }

  async reviewDocumentVersionParse(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
    request: ReviewKnowledgeDocumentParseRequest,
  ): Promise<KnowledgeDocumentVersionDetail> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          id: documentVersionId,
        },
        select: {
          id: true,
          sourceType: true,
          status: true,
          publishedAt: true,
          createdById: true,
          parseReviewStatus: true,
          parseReviewRevision: true,
          parseQualityScore: true,
        },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      if (version.sourceType !== 'FILE' && version.sourceType !== 'WEB') {
        throw new ConflictException('Only parsed file or web versions require human review.');
      }
      if (version.status !== 'READY' || version.publishedAt !== null) {
        throw new ConflictException('Only an unpublished, fully parsed version can be reviewed.');
      }
      if (version.createdById === principal.userId) {
        throw new ConflictException(
          'The document importer cannot approve or reject their own parsed version.',
        );
      }
      if (version.parseReviewStatus !== 'PENDING') {
        throw new ConflictException('The parse review is no longer pending.');
      }
      const reviewedAt = new Date();
      const reviewStatus = request.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const updated = await transaction.knowledgeDocumentVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: documentVersionId,
          documentId,
          parseReviewStatus: 'PENDING',
          parseReviewRevision: request.expectedReviewRevision,
        },
        data: {
          parseReviewStatus: reviewStatus,
          parseReviewRevision: { increment: 1 },
          parseReviewedById: principal.userId,
          parseReviewedAt: reviewedAt,
          parseReviewNote: request.note ?? null,
        },
      });
      if (updated.count !== 1) throw optimisticConflict('knowledge parse review');
      const eventPayload = {
        knowledgeBaseId,
        documentId,
        documentVersionId,
        decision: request.decision,
        parseQualityScore: version.parseQualityScore?.toNumber() ?? null,
        reviewRevision: request.expectedReviewRevision + 1,
        reviewedAt: reviewedAt.toISOString(),
      };
      const publicEvent = defineKnowledgePublicEvent({
        eventType: 'knowledge.document-version.parse-reviewed.v1',
        payload: eventPayload,
      });
      await Promise.all([
        recordAdminAudit(
          transaction,
          principal,
          `admin.knowledge-document-version.parse-${request.decision.toLowerCase()}`,
          'knowledge_document_version',
          documentVersionId,
          eventPayload,
        ),
        transaction.outboxEvent.create({
          data: {
            tenantId: principal.tenantId,
            aggregateType: 'knowledge_document_version',
            aggregateId: documentVersionId,
            eventType: publicEvent.eventType,
            payload: publicEvent.payload,
          },
        }),
      ]);
    });
    return this.getDocumentVersion(knowledgeBaseId, documentId, documentVersionId);
  }

  async updateDocumentVersionGovernance(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
    request: UpdateKnowledgeDocumentVersionGovernanceRequest,
  ): Promise<KnowledgeDocumentVersionDetail> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          id: documentVersionId,
        },
        select: {
          id: true,
          publishedAt: true,
          governanceRevision: true,
          governanceHash: true,
        },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      if (version.publishedAt !== null) {
        throw new ConflictException(
          'Published knowledge governance is immutable; create a new document version instead.',
        );
      }
      if (version.governanceRevision !== request.expectedRevision) {
        throw optimisticConflict('knowledge governance policy');
      }
      const policy = { ...request.policy, ownerUserId: principal.userId };
      await this.requireKnowledgeGovernanceReferences(
        transaction,
        principal.tenantId,
        documentId,
        policy,
      );
      const updated = await transaction.knowledgeDocumentVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          id: documentVersionId,
          publishedAt: null,
          governanceRevision: request.expectedRevision,
        },
        data: {
          governanceOwnerUserId: policy.ownerUserId,
          classification: policy.classification,
          scopeMode: policy.scopeMode,
          organizationScopeIds: sortedUniqueIds(policy.organizationScopeIds),
          projectScopeIds: sortedUniqueIds(policy.projectScopeIds),
          taskScopeIds: sortedUniqueIds(policy.taskScopeIds),
          roleTemplateScopeIds: sortedUniqueIds(policy.roleTemplateScopeIds),
          dataLabels: sortedUniqueIds(policy.dataLabels),
          effectiveFrom: new Date(policy.effectiveFrom),
          expiresAt: policy.expiresAt === null ? null : new Date(policy.expiresAt),
          retentionUntil: policy.retentionUntil === null ? null : new Date(policy.retentionUntil),
          retentionAction: policy.retentionAction,
          supersedesVersionId: policy.supersedesVersionId,
          governanceRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw optimisticConflict('knowledge governance policy');
      const changed = await transaction.knowledgeDocumentVersion.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id: documentVersionId },
        select: {
          governanceRevision: true,
          governanceHash: true,
          governanceReviewStatus: true,
        },
      });
      const event = {
        knowledgeBaseId,
        documentId,
        documentVersionId,
        previousRevision: request.expectedRevision,
        revision: changed.governanceRevision,
        previousPolicyHash: version.governanceHash.trim(),
        policyHash: changed.governanceHash.trim(),
        reviewStatus: knowledgeGovernanceReviewStatusSchema.parse(changed.governanceReviewStatus),
        classification: policy.classification,
        scopeMode: policy.scopeMode,
      };
      const publicEvent = defineKnowledgePublicEvent({
        eventType: 'knowledge.document-version.governance-updated.v1',
        payload: event,
      });
      await Promise.all([
        recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-document-version.governance-updated',
          'knowledge_document_version',
          documentVersionId,
          event,
        ),
        transaction.outboxEvent.create({
          data: {
            tenantId: principal.tenantId,
            aggregateType: 'knowledge_document_version',
            aggregateId: documentVersionId,
            eventType: publicEvent.eventType,
            payload: publicEvent.payload,
          },
        }),
      ]);
    });
    return this.getDocumentVersion(knowledgeBaseId, documentId, documentVersionId);
  }

  async updateDocumentAccess(
    knowledgeBaseId: string,
    documentId: string,
    request: UpdateKnowledgeDocumentAccessRequest,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const document = await transaction.knowledgeDocument.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          id: documentId,
          status: { not: 'ARCHIVED' },
        },
        select: {
          documentVersion: true,
          currentVersionId: true,
          currentVersion: {
            select: {
              id: true,
              versionNumber: true,
              governanceRevision: true,
              governanceHash: true,
              classification: true,
              projectScopeIds: true,
              taskScopeIds: true,
              roleTemplateScopeIds: true,
              dataLabels: true,
            },
          },
        },
      });
      if (document === null) throw knowledgeDocumentNotFound();
      if (document.currentVersionId === null || document.currentVersion === null) {
        throw new ConflictException('The document has no current searchable version.');
      }
      if (document.currentVersion.versionNumber !== document.documentVersion) {
        throw new ConflictException(
          'Finish or remove the newer document version before changing document access.',
        );
      }
      if (document.currentVersion.governanceRevision !== request.expectedGovernanceRevision) {
        throw optimisticConflict('knowledge document access');
      }

      const orgUnitIds = request.mode === 'RESTRICTED' ? uniqueIds(request.orgUnitIds) : [];
      const memberUserIds = request.mode === 'RESTRICTED' ? uniqueIds(request.memberUserIds) : [];
      if (orgUnitIds.length > 0) {
        const count = await transaction.orgUnit.count({
          where: { tenantId: principal.tenantId, id: { in: orgUnitIds }, status: 'ACTIVE' },
        });
        if (count !== orgUnitIds.length) {
          throw new BadRequestException('One or more document access departments are unavailable.');
        }
      }
      await this.requireKnowledgeAccessMembers(transaction, principal.tenantId, memberUserIds);

      const retainedLabels = document.currentVersion.dataLabels.filter(
        (label) => !isDocumentMemberAccessLabel(label),
      );
      const dataLabels = sortedUniqueIds([
        ...retainedLabels,
        ...memberUserIds.map(documentMemberAccessLabel),
      ]);
      const scopeMode =
        orgUnitIds.length > 0 ||
        memberUserIds.length > 0 ||
        document.currentVersion.projectScopeIds.length > 0 ||
        document.currentVersion.taskScopeIds.length > 0 ||
        document.currentVersion.roleTemplateScopeIds.length > 0 ||
        retainedLabels.length > 0 ||
        document.currentVersion.classification === 'SENSITIVE' ||
        document.currentVersion.classification === 'CONFIDENTIAL'
          ? 'RESTRICTED'
          : 'TENANT';
      const updated = await transaction.knowledgeDocumentVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          id: document.currentVersion.id,
          governanceRevision: request.expectedGovernanceRevision,
        },
        data: {
          scopeMode,
          organizationScopeIds: orgUnitIds,
          dataLabels,
          governanceRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw optimisticConflict('knowledge document access');
      const changed = await transaction.knowledgeDocumentVersion.findFirstOrThrow({
        where: { tenantId: principal.tenantId, id: document.currentVersion.id },
        select: {
          governanceRevision: true,
          governanceHash: true,
          governanceReviewStatus: true,
        },
      });
      const event = {
        knowledgeBaseId,
        documentId,
        documentVersionId: document.currentVersion.id,
        previousRevision: request.expectedGovernanceRevision,
        revision: changed.governanceRevision,
        previousPolicyHash: document.currentVersion.governanceHash.trim(),
        policyHash: changed.governanceHash.trim(),
        reviewStatus: knowledgeGovernanceReviewStatusSchema.parse(changed.governanceReviewStatus),
        classification: document.currentVersion.classification as
          'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'CONFIDENTIAL',
        scopeMode: scopeMode as 'TENANT' | 'RESTRICTED',
      };
      const publicEvent = defineKnowledgePublicEvent({
        eventType: 'knowledge.document-version.governance-updated.v1',
        payload: event,
      });
      await Promise.all([
        recordAdminAudit(
          transaction,
          principal,
          'admin.knowledge-document.access-updated',
          'knowledge_document',
          documentId,
          { ...event, orgUnitIds, memberUserIds },
        ),
        transaction.outboxEvent.create({
          data: {
            tenantId: principal.tenantId,
            aggregateType: 'knowledge_document_version',
            aggregateId: document.currentVersion.id,
            eventType: publicEvent.eventType,
            payload: publicEvent.payload,
          },
        }),
      ]);
    });
    return this.getDocument(knowledgeBaseId, documentId);
  }

  async reviewDocumentVersionGovernance(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
    request: ReviewKnowledgeDocumentGovernanceRequest,
  ): Promise<KnowledgeDocumentVersionDetail> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          id: documentVersionId,
        },
        select: {
          id: true,
          createdById: true,
          governanceOwnerUserId: true,
          governanceRevision: true,
          governanceReviewStatus: true,
          governanceHash: true,
          publishedAt: true,
        },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      if (version.publishedAt !== null) {
        throw new ConflictException('Published knowledge governance can no longer be reviewed.');
      }
      if (
        version.createdById === principal.userId ||
        version.governanceOwnerUserId === principal.userId
      ) {
        throw new ConflictException(
          'The document creator and governance owner cannot review their own knowledge policy.',
        );
      }
      if (
        version.governanceRevision !== request.expectedRevision ||
        version.governanceReviewStatus !== 'PENDING'
      ) {
        throw optimisticConflict('knowledge governance review');
      }
      const reviewStatus = request.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const reviewedAt = new Date();
      const updated = await transaction.knowledgeDocumentVersion.updateMany({
        where: {
          tenantId: principal.tenantId,
          id: documentVersionId,
          documentId,
          publishedAt: null,
          governanceRevision: request.expectedRevision,
          governanceReviewStatus: 'PENDING',
        },
        data: {
          governanceReviewStatus: reviewStatus,
          governanceReviewedById: principal.userId,
          governanceReviewedAt: reviewedAt,
          governanceReviewNote: request.note ?? null,
          governanceRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw optimisticConflict('knowledge governance review');
      const event = {
        knowledgeBaseId,
        documentId,
        documentVersionId,
        decision: request.decision,
        revision: request.expectedRevision + 1,
        policyHash: version.governanceHash.trim(),
        reviewedAt: reviewedAt.toISOString(),
      };
      const publicEvent = defineKnowledgePublicEvent({
        eventType: 'knowledge.document-version.governance-reviewed.v1',
        payload: event,
      });
      await Promise.all([
        recordAdminAudit(
          transaction,
          principal,
          `admin.knowledge-document-version.governance-${request.decision.toLowerCase()}`,
          'knowledge_document_version',
          documentVersionId,
          event,
        ),
        transaction.outboxEvent.create({
          data: {
            tenantId: principal.tenantId,
            aggregateType: 'knowledge_document_version',
            aggregateId: documentVersionId,
            eventType: publicEvent.eventType,
            payload: publicEvent.payload,
          },
        }),
      ]);
    });
    return this.getDocumentVersion(knowledgeBaseId, documentId, documentVersionId);
  }

  async publishDocumentVersion(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
    _request: PublishKnowledgeDocumentVersionRequest,
  ): Promise<KnowledgeDocument> {
    const principal = this.access.requireKnowledgeWrite();
    await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockKnowledgeDocument(transaction, principal.tenantId, documentId);
      await this.requireKnowledgeBase(transaction, principal.tenantId, knowledgeBaseId);
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          id: documentVersionId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
        },
        include: { _count: { select: { chunks: true } } },
      });
      if (version === null) throw new NotFoundException('The document version was not found.');
      if (version.status !== 'READY' || version._count.chunks === 0) {
        throw new ConflictException(
          'Only a fully indexed READY document version can be published.',
        );
      }
      if (version.publishedAt !== null) {
        return;
      }
      const [databaseClock] = await transaction.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT CURRENT_TIMESTAMP AS "databaseNow"
      `;
      if (databaseClock === undefined) {
        throw new Error('The database clock query returned no rows.');
      }
      const publishedAt = databaseClock.databaseNow;
      const document = await transaction.knowledgeDocument.findFirst({
        where: { id: documentId, tenantId: principal.tenantId, knowledgeBaseId },
        select: {
          currentVersionId: true,
          documentVersion: true,
          status: true,
        },
      });
      if (document === null || document.status === 'ARCHIVED') {
        throw knowledgeDocumentNotFound();
      }
      if (document.currentVersionId !== null && version.versionNumber <= document.documentVersion) {
        throw new ConflictException(
          'The READY version is not newer than the current published version.',
        );
      }
      // Graph projection is an optional retrieval enhancement. Activate a candidate
      // when one exists, but never block ordinary document publication on graph governance.
      const graphProjection = await activateKnowledgeGraphProjection(transaction, {
        tenantId: principal.tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
      });
      const promoted = await transaction.knowledgeDocumentVersion.updateMany({
        where: {
          id: version.id,
          tenantId: principal.tenantId,
          status: 'READY',
          publishedAt: null,
        },
        data: {
          publishedAt,
          evaluationRunId: null,
          evaluationDatasetVersionId: null,
          evaluationSnapshotHash: null,
        },
      });
      if (promoted.count !== 1) {
        throw new ConflictException(
          'The document version publication state changed. Refresh and try again.',
        );
      }
      await transaction.knowledgeDocument.update({
        where: { id: documentId },
        data: {
          currentVersionId: version.id,
          status: 'READY',
          documentVersion: version.versionNumber,
          contentText: version.contentText,
          checksum: version.checksum,
          objectKey: version.objectKey,
          mimeType: version.mimeType,
          fileName: version.fileName,
        },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-document-version.published',
        'knowledge_document_version',
        version.id,
        {
          documentId,
          version: version.versionNumber,
          graphProjectionId: graphProjection?.projectionId ?? null,
          graphHash: graphProjection?.graphHash ?? null,
        },
      );
      const publicEvent = defineKnowledgePublicEvent({
        eventType: 'knowledge.document-version.published.v1',
        payload: {
          knowledgeBaseId,
          documentId,
          documentVersionId: version.id,
          version: version.versionNumber,
          graphProjectionId: graphProjection?.projectionId ?? null,
          graphHash: graphProjection?.graphHash ?? null,
          publishedAt: publishedAt.toISOString(),
        },
      });
      await transaction.outboxEvent.create({
        data: {
          tenantId: principal.tenantId,
          aggregateType: 'knowledge_document_version',
          aggregateId: version.id,
          eventType: publicEvent.eventType,
          payload: publicEvent.payload,
        },
      });
    });
    await this.knowledge.syncSearchDocumentVersion({
      knowledgeBaseId,
      documentId,
      documentVersionId,
      active: true,
    });
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
        select: { currentVersionId: true, status: true, title: true },
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
          objectSize: target.objectSize,
          objectSha256: target.objectSha256,
          structuredObjectKey: target.structuredObjectKey,
          structuredObjectSize: target.structuredObjectSize,
          structuredObjectSha256: target.structuredObjectSha256,
          structuredFormat: target.structuredFormat,
          sourceUri: target.sourceUri,
          checksum: target.checksum,
          contentText: target.contentText,
          status: 'READY',
          changeSummary: `Rollback from current to v${target.versionNumber}`,
          parserName: target.parserName,
          parseQualityScore: target.parseQualityScore,
          parseReviewStatus:
            target.sourceType === 'FILE' || target.sourceType === 'WEB'
              ? 'PENDING'
              : 'NOT_REQUIRED',
          parseDiagnostics: target.parseDiagnostics as Prisma.InputJsonObject,
          governanceOwnerUserId: target.governanceOwnerUserId,
          classification: target.classification,
          scopeMode: target.scopeMode,
          organizationScopeIds: target.organizationScopeIds,
          projectScopeIds: target.projectScopeIds,
          taskScopeIds: target.taskScopeIds,
          roleTemplateScopeIds: target.roleTemplateScopeIds,
          dataLabels: target.dataLabels,
          expiresAt: null,
          retentionUntil: target.retentionUntil,
          retentionAction: target.retentionAction,
          supersedesVersionId: document.currentVersionId,
          createdById: principal.userId,
          publishedAt: null,
        },
      });
      const rollbackParents = new Map<
        string,
        {
          id: string;
          parentIndex: number;
          headingPath: string[];
          content: string;
          tokenCount: number;
          contentHash: string;
          metadata: Prisma.InputJsonObject;
        }
      >();
      for (const chunk of target.chunks) {
        const key = JSON.stringify(chunk.headingPath);
        const current = rollbackParents.get(key);
        if (current === undefined) {
          rollbackParents.set(key, {
            id: randomUUID(),
            parentIndex: rollbackParents.size,
            headingPath: chunk.headingPath,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
            metadata: chunk.metadata as Prisma.InputJsonObject,
          });
        } else {
          current.content = `${current.content}\n\n${chunk.content}`;
          current.tokenCount += chunk.tokenCount;
          current.contentHash = createHash('sha256').update(current.content).digest('hex');
        }
      }
      await transaction.knowledgeParentChunk.createMany({
        data: [...rollbackParents.values()].map((parent) => ({
          ...parent,
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          documentVersionId: rollbackVersion.id,
        })),
      });
      const rollbackChunkIds = target.chunks.map(() => randomUUID());
      await transaction.knowledgeChunk.createMany({
        data: target.chunks.map((chunk, index) => {
          const parent = rollbackParents.get(JSON.stringify(chunk.headingPath));
          const id = rollbackChunkIds[index];
          if (parent === undefined || id === undefined) {
            throw new Error('KNOWLEDGE_ROLLBACK_LINEAGE_INVALID');
          }
          return {
            id,
            tenantId: principal.tenantId,
            knowledgeBaseId,
            documentId,
            documentVersionId: rollbackVersion.id,
            parentChunkId: parent.id,
            previousChunkId: index === 0 ? null : (rollbackChunkIds[index - 1] ?? null),
            nextChunkId:
              index + 1 >= rollbackChunkIds.length ? null : (rollbackChunkIds[index + 1] ?? null),
            chunkIndex: chunk.chunkIndex,
            headingPath: chunk.headingPath,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
            metadata: chunk.metadata as Prisma.InputJsonObject,
          };
        }),
      });
      const restoredChunks = await transaction.knowledgeChunk.findMany({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          documentVersionId: rollbackVersion.id,
        },
        orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          chunkIndex: true,
          headingPath: true,
          content: true,
        },
      });
      const graphProjection = projectKnowledgeGraph({
        documentId,
        documentTitle: document.title,
        chunks: restoredChunks,
      });
      await persistKnowledgeGraphProjection(
        transaction,
        {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          documentId,
          documentVersionId: rollbackVersion.id,
          actorUserId: principal.userId,
        },
        graphProjection,
      );
      // Rollback snapshots reuse identical content, so already verified embeddings can be
      // copied without another provider call. Chunk lineage remains version-specific.
      await transaction.$executeRaw`
        INSERT INTO public."knowledge_chunk_embeddings" (
          "id", "tenant_id", "chunk_id", "embedding_index_version_id", "embedding_model",
          "embedding_dimension", "content_hash", "embedding"
        )
        SELECT
          gen_random_uuid(),
          source_embedding."tenant_id",
          restored_chunk."id",
          source_embedding."embedding_index_version_id",
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
        ON CONFLICT ("tenant_id", "chunk_id", "embedding_index_version_id") DO NOTHING
      `;

      await recordAdminAudit(
        transaction,
        principal,
        'admin.knowledge-document-version.rollback-candidate-created',
        'knowledge_document_version',
        rollbackVersion.id,
        {
          documentId,
          fromVersionId: request.expectedCurrentVersionId,
          sourceVersionId: target.id,
          sourceVersion: target.versionNumber,
          rollbackVersionId: rollbackVersion.id,
          rollbackVersion: rollbackVersionNumber,
          publicationRequired: true,
          graphEntityCount: graphProjection.entities.length,
          graphRelationCount: graphProjection.relations.length,
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
      if (request.documentVersionId !== undefined) {
        const candidate = await transaction.knowledgeDocumentVersion.findFirst({
          where: {
            tenantId: principal.tenantId,
            knowledgeBaseId,
            id: request.documentVersionId,
          },
          select: {
            status: true,
            sourceType: true,
            parseReviewStatus: true,
            governanceReviewStatus: true,
            _count: { select: { chunks: true } },
          },
        });
        if (candidate === null) {
          throw new NotFoundException('The candidate knowledge version was not found.');
        }
        if (
          candidate.status !== 'READY' ||
          candidate._count.chunks === 0 ||
          candidate.governanceReviewStatus !== 'APPROVED' ||
          ((candidate.sourceType === 'FILE' || candidate.sourceType === 'WEB') &&
            candidate.parseReviewStatus !== 'APPROVED')
        ) {
          throw new ConflictException(
            'Candidate preview requires an approved, fully indexed READY knowledge version.',
          );
        }
      }
    });

    const startedAt = Date.now();
    const result = await this.knowledge.search({
      tenantId: principal.tenantId,
      userId: simulatedUserId,
      knowledgeBaseIds: [knowledgeBaseId],
      previewDraftKnowledgeBaseIds: [knowledgeBaseId],
      ...(request.documentVersionId === undefined
        ? {}
        : { previewKnowledgeVersionIds: [request.documentVersionId] }),
      query: request.query,
      limit: request.limit,
    });
    const sourceLocations =
      result.items.length === 0
        ? new Map<
            string,
            {
              readonly metadata: Prisma.JsonValue;
              readonly mimeType: string | null;
              readonly fileName: string | null;
              readonly sourceUri: string | null;
              readonly sourceDownloadAvailable: boolean;
              readonly structuredPreviewAvailable: boolean;
            }
          >()
        : await this.prisma.withTenant(principal.tenantId, async (transaction) => {
            const chunks = await transaction.knowledgeChunk.findMany({
              where: {
                tenantId: principal.tenantId,
                knowledgeBaseId,
                id: { in: result.items.map((item) => item.chunkId) },
              },
              select: {
                id: true,
                metadata: true,
                documentVersion: {
                  select: {
                    mimeType: true,
                    fileName: true,
                    sourceUri: true,
                    objectKey: true,
                    structuredObjectKey: true,
                  },
                },
              },
            });
            return new Map(
              chunks.map((chunk) => [
                chunk.id,
                {
                  metadata: chunk.metadata,
                  mimeType: chunk.documentVersion.mimeType,
                  fileName: chunk.documentVersion.fileName,
                  sourceUri: chunk.documentVersion.sourceUri,
                  sourceDownloadAvailable: chunk.documentVersion.objectKey !== null,
                  structuredPreviewAvailable: chunk.documentVersion.structuredObjectKey !== null,
                },
              ]),
            );
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
      relationshipCandidateCount: result.relationshipCandidateCount,
      relationshipExpandedCount: result.relationshipExpandedCount,
      semanticCoverage: result.semanticCoverage,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        stage: diagnostic.stage,
        status: diagnostic.status,
        code: diagnostic.code,
        candidateCount: diagnostic.candidateCount,
      })),
      ...(result.queryRoute === undefined
        ? {}
        : {
            queryRoute: {
              ...result.queryRoute,
              fallback: [...result.queryRoute.fallback],
            },
          }),
      ...(result.structuredQuerySql === undefined
        ? {}
        : { structuredQuerySql: result.structuredQuerySql }),
      noAnswer: result.items.length === 0,
      elapsedMs: Date.now() - startedAt,
      items: result.items.map((item) => {
        const source = sourceLocations.get(item.chunkId);
        const pages = readChunkPages(source?.metadata ?? null);
        return {
          chunkId: item.chunkId,
          knowledgeBaseId: item.knowledgeBaseId,
          knowledgeBaseName: item.knowledgeBaseName,
          documentId: item.documentId,
          documentVersionId: item.documentVersionId,
          documentVersion: item.documentVersion,
          title: item.title,
          headingPath: [...item.headingPath],
          pageStart: item.pageStart ?? pages.pageStart,
          pageEnd: item.pageEnd ?? pages.pageEnd,
          sheetName: item.sheetName ?? readChunkSheetName(source?.metadata ?? null),
          sourceMimeType: source?.mimeType ?? null,
          sourceFileName: source?.fileName ?? null,
          sourceUri: source?.sourceUri ?? item.sourceUri ?? null,
          sourceDownloadAvailable: source?.sourceDownloadAvailable ?? false,
          structuredPreviewAvailable: source?.structuredPreviewAvailable ?? false,
          excerpt: excerpt(item.content),
          keywordScore: item.keywordScore,
          fuzzyScore: item.fuzzyScore,
          semanticScore: item.semanticScore,
          fusionScore: item.fusionScore,
          rerankerScore: item.rerankerScore,
          relationshipScore: item.relationshipScore,
          relationshipEvidence: item.relationshipEvidence.map((evidence) => ({
            relationId: evidence.relationId,
            relationType: evidence.relationType,
            sourceChunkId: evidence.sourceChunkId,
            sourceEntityName: evidence.sourceEntityName,
            targetEntityName: evidence.targetEntityName,
            direction: evidence.direction,
            hopDistance: evidence.hopDistance,
            confidence: evidence.confidence,
            contribution: evidence.contribution,
            path: evidence.path.map((edge) => ({
              relationId: edge.relationId,
              predicate: edge.predicate,
              direction: edge.direction,
              sourceEntityId: edge.sourceEntityId,
              sourceEntityName: edge.sourceEntityName,
              targetEntityId: edge.targetEntityId,
              targetEntityName: edge.targetEntityName,
            })),
          })),
          finalScore: item.finalScore,
        };
      }),
    };
  }

  async rebuildDocumentVersionEmbeddings(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeEmbeddingRebuildResponse> {
    const rebuilt = await this.knowledge.rebuildEmbeddings({
      knowledgeBaseId,
      documentId,
      documentVersionId,
    });
    const document = await this.getDocument(knowledgeBaseId, documentId);
    await this.knowledge.syncSearchDocumentVersion({
      knowledgeBaseId,
      documentId,
      documentVersionId,
      embeddingIndexVersionId: rebuilt.embeddingIndexVersionId,
      active: document.status !== 'ARCHIVED' && document.currentVersionId === documentVersionId,
    });
    return rebuilt;
  }

  rebuildDocumentVersionGraph(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeGraphRebuildResponse> {
    return this.knowledge.rebuildKnowledgeGraph({
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
    const archived = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const current = await transaction.knowledgeDocument.findFirst({
        where: {
          id: documentId,
          tenantId: principal.tenantId,
          knowledgeBaseId,
        },
        include: knowledgeDocumentInclude,
      });
      if (current === null) throw knowledgeDocumentNotFound();
      if (current.externalEntryBinding) {
        throw new BadRequestException('腾讯乐享文档只能在乐享中删除，然后重新同步。');
      }
      if (current.status === 'ARCHIVED') return mapKnowledgeDocument(current);

      await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT knowledge_base."id"
          FROM "knowledge_bases" AS knowledge_base
         WHERE knowledge_base."tenant_id" = ${principal.tenantId}::uuid
           AND knowledge_base."id" = ${knowledgeBaseId}::uuid
         FOR UPDATE
      `);

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
      const remainingDocumentCount = await transaction.knowledgeDocument.count({
        where: {
          tenantId: principal.tenantId,
          knowledgeBaseId,
          status: { not: 'ARCHIVED' },
        },
      });
      if (remainingDocumentCount === 0) {
        const knowledgeBaseResult = await transaction.knowledgeBase.updateMany({
          where: {
            id: knowledgeBaseId,
            tenantId: principal.tenantId,
            status: { not: 'ARCHIVED' },
          },
          data: {
            status: 'ARCHIVED',
            version: { increment: 1 },
          },
        });
        if (knowledgeBaseResult.count === 1) {
          await recordAdminAudit(
            transaction,
            principal,
            'admin.knowledge-base.archived-empty',
            'knowledge_base',
            knowledgeBaseId,
            { reason: 'last-active-document-deleted' },
          );
        }
      }
      return mapKnowledgeDocument(archived);
    });
    await this.knowledge.archiveSearchDocument({ documentId });
    return archived;
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
      const [graphProjection] = await transaction.$queryRaw<KnowledgeGraphProjectionRow[]>(
        Prisma.sql`
          SELECT
            projection."id"::text AS id,
            projection."status"::text AS status,
            projection."graph_hash"
          FROM public."knowledge_graph_projections" projection
          WHERE projection."tenant_id" = ${principal.tenantId}::uuid
            AND projection."knowledge_base_id" = ${knowledgeBaseId}::uuid
            AND projection."document_id" = ${documentId}::uuid
            AND projection."document_version_id" = ${documentVersionId}::uuid
          ORDER BY
            CASE projection."status"
              WHEN 'ACTIVE' THEN 0
              WHEN 'CANDIDATE' THEN 1
              ELSE 2
            END,
            projection."created_at" DESC,
            projection."id"
          LIMIT 1
        `,
      );
      return {
        ...mapKnowledgeDocumentVersion(version),
        documentId: version.documentId,
        contentText: version.contentText,
        graphProjectionId: graphProjection?.id ?? null,
        graphProjectionStatus: graphProjection?.status ?? null,
        graphProjectionHash: graphProjection?.graph_hash.trim() ?? null,
      };
    });
  }

  getStructuredDocumentPreview(
    knowledgeBaseId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<KnowledgeStructuredDocumentPreview> {
    return this.knowledge.readStructuredDocumentPreview({
      knowledgeBaseId,
      documentId,
      documentVersionId,
    });
  }

  getDocumentVersionSource(knowledgeBaseId: string, documentId: string, documentVersionId: string) {
    return this.knowledge.readSourceDocument({
      knowledgeBaseId,
      documentId,
      documentVersionId,
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
            parentChunkId: true,
            previousChunkId: true,
            nextChunkId: true,
            chunkIndex: true,
            headingPath: true,
            content: true,
            tokenCount: true,
            contentHash: true,
            metadata: true,
            parentChunk: {
              select: { headingPath: true, content: true },
            },
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
            parentChunkId: chunk.parentChunkId,
            previousChunkId: chunk.previousChunkId,
            nextChunkId: chunk.nextChunkId,
            chunkIndex: chunk.chunkIndex,
            headingPath: chunk.headingPath,
            parentHeadingPath: chunk.parentChunk.headingPath,
            parentExcerpt: excerpt(chunk.parentChunk.content),
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            contentHash: chunk.contentHash,
            pageStart: pages.pageStart,
            pageEnd: pages.pageEnd,
            sheetName: readChunkSheetName(chunk.metadata),
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

  private async requireKnowledgeAccessMembers(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    requestedIds: readonly string[],
  ): Promise<void> {
    const ids = uniqueIds(requestedIds);
    if (ids.length === 0) return;
    const count = await transaction.user.count({
      where: {
        tenantId,
        id: { in: ids },
        status: 'ACTIVE',
        employments: {
          some: {
            status: 'ACTIVE',
            orgUnit: { status: 'ACTIVE' },
          },
        },
      },
    });
    if (count !== ids.length) {
      throw new BadRequestException(
        'One or more knowledge access members are inactive or have no active employment.',
      );
    }
  }

  private async requireKnowledgeGovernanceReferences(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    documentId: string,
    policy: KnowledgeDocumentGovernancePolicy,
  ): Promise<void> {
    const owner = await transaction.user.findFirst({
      where: { tenantId, id: policy.ownerUserId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (owner === null) {
      throw new BadRequestException('The knowledge governance owner must be an active user.');
    }
    const organizationScopeIds = sortedUniqueIds(policy.organizationScopeIds);
    if (organizationScopeIds.length > 0) {
      const rows = await transaction.$queryRaw<Array<{ readonly count: number }>>(Prisma.sql`
        SELECT count(DISTINCT scoped."id")::int AS count
        FROM (
          SELECT organization."id"
          FROM public."organizations" AS organization
          WHERE organization."tenant_id" = ${tenantId}::uuid
            AND organization."id" IN (
              ${Prisma.join(organizationScopeIds.map((id) => Prisma.sql`${id}::uuid`))}
            )
          UNION
          SELECT org_unit."id"
          FROM public."org_units" AS org_unit
          WHERE org_unit."tenant_id" = ${tenantId}::uuid
            AND org_unit."status" = 'ACTIVE'
            AND org_unit."id" IN (
              ${Prisma.join(organizationScopeIds.map((id) => Prisma.sql`${id}::uuid`))}
            )
        ) AS scoped
      `);
      if (rows[0]?.count !== organizationScopeIds.length) {
        throw new BadRequestException('One or more knowledge organization scopes are unavailable.');
      }
    }
    const taskScopeIds = sortedUniqueIds(policy.taskScopeIds);
    if (taskScopeIds.length > 0) {
      const count = await transaction.task.count({
        where: { tenantId, id: { in: taskScopeIds } },
      });
      if (count !== taskScopeIds.length) {
        throw new BadRequestException('One or more knowledge task scopes are unavailable.');
      }
    }
    const roleTemplateScopeIds = sortedUniqueIds(policy.roleTemplateScopeIds);
    if (roleTemplateScopeIds.length > 0) {
      const count = await transaction.agentTemplate.count({
        where: { tenantId, id: { in: roleTemplateScopeIds } },
      });
      if (count !== roleTemplateScopeIds.length) {
        throw new BadRequestException('One or more knowledge role scopes are unavailable.');
      }
    }
    if (policy.supersedesVersionId !== null) {
      const superseded = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId,
          documentId,
          id: policy.supersedesVersionId,
        },
        select: { id: true },
      });
      if (superseded === null) {
        throw new BadRequestException(
          'The superseded knowledge version must belong to the same document.',
        );
      }
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

  private async attachExternalSpaces(
    tenantId: string,
    knowledgeBases: readonly KnowledgeBase[],
  ): Promise<KnowledgeBase[]> {
    const bindings = await this.providerSpaces.list(
      tenantId,
      knowledgeBases.map((knowledgeBase) => knowledgeBase.id),
    );
    return knowledgeBases.map((knowledgeBase) => {
      const externalSpace = bindings.get(knowledgeBase.id) ?? null;
      return {
        ...knowledgeBase,
        storageProvider: externalSpace === null ? 'LOCAL' : 'LEXIANG',
        externalSpace,
      };
    });
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
  folder: { select: { path: true } },
  externalEntryBinding: { select: { id: true } },
} satisfies Prisma.KnowledgeDocumentInclude;

const knowledgeDocumentSummarySelect = {
  id: true,
  knowledgeBaseId: true,
  folderId: true,
  folder: { select: { path: true } },
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
  activeEmbeddingIndexVersion: true,
  pendingEmbeddingIndexVersion: true,
  orgUnits: { orderBy: { createdAt: 'asc' as const } },
  members: { orderBy: { createdAt: 'asc' as const } },
  documents: {
    orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }],
    select: knowledgeDocumentSummarySelect,
  },
  folders: {
    orderBy: [{ path: 'asc' as const }, { id: 'asc' as const }],
    include: { _count: { select: { documents: true, children: true } } },
  },
  _count: { select: { documents: true } },
} satisfies Prisma.KnowledgeBaseInclude;

function knowledgeRetrievalConfigData(config: KnowledgeRetrievalConfig) {
  return {
    retrievalMode: config.mode,
    retrievalTopK: config.topK,
    retrievalScoreThreshold: config.scoreThreshold,
    retrievalSemanticWeight: config.semanticWeight,
    retrievalKeywordWeight: config.keywordWeight,
    retrievalRerankEnabled: config.rerankEnabled,
    relationshipRetrievalEnabled: config.relationshipRetrievalEnabled,
    maxChunksPerDocument: config.maxChunksPerDocument,
  };
}

function knowledgeChunkingConfigData(config: KnowledgeChunkingConfig) {
  return {
    chunkTargetTokens: config.targetTokens,
    chunkOverlapTokens: config.overlapTokens,
  };
}

function mapKnowledgeBase(knowledgeBase: KnowledgeBaseRecord): KnowledgeBase {
  return {
    id: knowledgeBase.id,
    key: knowledgeBase.key,
    name: knowledgeBase.name,
    description: knowledgeBase.description,
    status: knowledgeBase.status,
    space: {
      type: knowledgeBase.spaceType,
      targetId: knowledgeBase.spaceTargetId,
      targetName: knowledgeBase.spaceTargetName,
    },
    version: knowledgeBase.version,
    retrievalConfig: {
      mode:
        knowledgeBase.retrievalMode === 'VECTOR' || knowledgeBase.retrievalMode === 'FULL_TEXT'
          ? knowledgeBase.retrievalMode
          : 'HYBRID',
      topK: knowledgeBase.retrievalTopK ?? 8,
      scoreThreshold: Number(knowledgeBase.retrievalScoreThreshold ?? 0.08),
      semanticWeight: Number(knowledgeBase.retrievalSemanticWeight ?? 0.7),
      keywordWeight: Number(knowledgeBase.retrievalKeywordWeight ?? 0.3),
      rerankEnabled: knowledgeBase.retrievalRerankEnabled ?? true,
      relationshipRetrievalEnabled: knowledgeBase.relationshipRetrievalEnabled ?? true,
      maxChunksPerDocument: knowledgeBase.maxChunksPerDocument ?? 3,
    },
    chunkingConfig: {
      targetTokens: knowledgeBase.chunkTargetTokens ?? 500,
      overlapTokens: knowledgeBase.chunkOverlapTokens ?? 80,
    },
    activeEmbeddingIndexVersion:
      knowledgeBase.activeEmbeddingIndexVersion == null
        ? null
        : mapKnowledgeEmbeddingIndexVersion(knowledgeBase.activeEmbeddingIndexVersion),
    pendingEmbeddingIndexVersion:
      knowledgeBase.pendingEmbeddingIndexVersion == null
        ? null
        : mapKnowledgeEmbeddingIndexVersion(knowledgeBase.pendingEmbeddingIndexVersion),
    orgUnitIds: knowledgeBase.orgUnits.map((scope) => scope.orgUnitId),
    orgUnitScopes: knowledgeBase.orgUnits.map((scope) => ({
      orgUnitId: scope.orgUnitId,
      includeChildren: scope.includeChildren,
    })),
    memberUserIds: knowledgeBase.members.map((scope) => scope.userId),
    documentCount: knowledgeBase._count.documents,
    folders: (knowledgeBase.folders ?? []).map(mapKnowledgeFolder),
    documents: knowledgeBase.documents.map(mapKnowledgeDocumentSummary),
    updatedAt: knowledgeBase.updatedAt.toISOString(),
  };
}

function mapKnowledgeEmbeddingIndexVersion(
  index: Prisma.KnowledgeEmbeddingIndexVersionGetPayload<object>,
): KnowledgeEmbeddingIndexVersion {
  if (index.distance !== 'COSINE') throw new Error('KNOWLEDGE_INDEX_DISTANCE_UNSUPPORTED');
  if (index.normalization !== 'L2' && index.normalization !== 'NONE') {
    throw new Error('KNOWLEDGE_INDEX_NORMALIZATION_UNSUPPORTED');
  }
  return {
    id: index.id,
    version: index.version,
    status: index.status,
    provider: index.provider,
    model: index.model,
    dimensions: index.dimensions,
    distance: 'COSINE',
    normalization: index.normalization,
    collectionName: index.collectionName,
    createdAt: index.createdAt.toISOString(),
    activatedAt: index.activatedAt?.toISOString() ?? null,
    retiredAt: index.retiredAt?.toISOString() ?? null,
    failureCode: index.failureCode,
  };
}

function embeddingCollectionName(
  knowledgeBaseId: string,
  version: number,
  dimensions: number,
): string {
  return `knowledge_${knowledgeBaseId.replaceAll('-', '').slice(0, 16)}_v${version}_d${dimensions}`;
}

function isEmbeddingProvider(
  provider: KnowledgeCapabilityReadiness['provider'],
): provider is 'openai_compatible' | 'local_fastembed' {
  return provider === 'openai_compatible' || provider === 'local_fastembed';
}

function mapKnowledgeDocumentSummary(
  document: KnowledgeDocumentSummaryRecord | KnowledgeDocumentRecord,
): KnowledgeDocumentSummary {
  return {
    id: document.id,
    knowledgeBaseId: document.knowledgeBaseId,
    folderId: document.folderId,
    folderPath: document.folder?.path ?? null,
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

function mapKnowledgeFolder(folder: {
  id: string;
  knowledgeBaseId: string;
  parentId: string | null;
  name: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { documents: number; children: number };
}) {
  return {
    id: folder.id,
    knowledgeBaseId: folder.knowledgeBaseId,
    parentId: folder.parentId,
    name: folder.name,
    path: folder.path,
    directDocumentCount: folder._count.documents,
    directChildCount: folder._count.children,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}

function normalizeKnowledgeFolderPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  const segments = normalized.split('/');
  if (
    normalized.length < 1 ||
    normalized.length > 2_000 ||
    segments.length > 20 ||
    segments.some(
      (segment) =>
        segment.length < 1 ||
        segment.length > 200 ||
        segment === '.' ||
        segment === '..' ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new BadRequestException('The knowledge folder path is invalid.');
  }
  return segments.join('/');
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
    evaluationRunId: version.evaluationRunId,
    evaluationDatasetVersionId: version.evaluationDatasetVersionId,
    evaluationSnapshotHash: version.evaluationSnapshotHash,
    sourceUri: version.sourceUri,
    parserName: version.parserName,
    parseQualityScore: version.parseQualityScore?.toNumber() ?? null,
    parseReviewStatus: version.parseReviewStatus,
    parseReviewRevision: version.parseReviewRevision,
    parseReviewedById: version.parseReviewedById,
    parseReviewedAt: version.parseReviewedAt?.toISOString() ?? null,
    parseReviewNote: version.parseReviewNote,
    parseDiagnostics:
      typeof version.parseDiagnostics === 'object' &&
      version.parseDiagnostics !== null &&
      !Array.isArray(version.parseDiagnostics)
        ? version.parseDiagnostics
        : {},
    structuredArtifact:
      version.structuredFormat === null ||
      version.structuredObjectSize === null ||
      version.structuredObjectSha256 === null
        ? null
        : {
            format: version.structuredFormat,
            size: version.structuredObjectSize,
            sha256: version.structuredObjectSha256,
          },
    governance: {
      ownerUserId: version.governanceOwnerUserId ?? version.createdById,
      classification: version.classification as
        'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'CONFIDENTIAL',
      scopeMode: version.scopeMode as 'TENANT' | 'RESTRICTED',
      organizationScopeIds: version.organizationScopeIds,
      projectScopeIds: version.projectScopeIds,
      taskScopeIds: version.taskScopeIds,
      roleTemplateScopeIds: version.roleTemplateScopeIds,
      dataLabels: version.dataLabels,
      effectiveFrom: version.effectiveFrom.toISOString(),
      expiresAt: version.expiresAt?.toISOString() ?? null,
      retentionUntil: version.retentionUntil?.toISOString() ?? null,
      retentionAction: version.retentionAction as 'ARCHIVE' | 'REVIEW_DELETE' | 'LEGAL_HOLD',
      supersedesVersionId: version.supersedesVersionId,
      revision: version.governanceRevision,
      reviewStatus: version.governanceReviewStatus as
        'PENDING' | 'APPROVED' | 'REJECTED' | 'MIGRATED',
      reviewedById: version.governanceReviewedById,
      reviewedAt: version.governanceReviewedAt?.toISOString() ?? null,
      reviewNote: version.governanceReviewNote,
      policyHash: version.governanceHash.trim(),
    },
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

function knowledgeGraphScopeSql(tenantId: string, knowledgeBaseId: string): Prisma.Sql {
  return Prisma.sql`
    current_chunks AS (
      SELECT chunk."id", chunk."document_id", chunk."document_version_id"
      FROM public."knowledge_chunks" AS chunk
      JOIN public."knowledge_documents" AS document
        ON document."tenant_id" = chunk."tenant_id"
       AND document."knowledge_base_id" = chunk."knowledge_base_id"
       AND document."id" = chunk."document_id"
       AND document."status" = 'READY'::"KnowledgeDocumentStatus"
       AND document."current_version_id" = chunk."document_version_id"
      JOIN public."knowledge_document_versions" AS version
        ON version."tenant_id" = chunk."tenant_id"
       AND version."knowledge_base_id" = chunk."knowledge_base_id"
       AND version."document_id" = chunk."document_id"
       AND version."id" = chunk."document_version_id"
       AND version."status" = 'READY'::"KnowledgeDocumentVersionStatus"
      WHERE chunk."tenant_id" = ${tenantId}::uuid
        AND chunk."knowledge_base_id" = ${knowledgeBaseId}::uuid
    ),
    current_mentions AS (
      SELECT mention.*
      FROM public."knowledge_entity_mentions" AS mention
      JOIN current_chunks ON current_chunks."id" = mention."chunk_id"
      JOIN public."knowledge_graph_projections" AS mention_projection
        ON mention_projection."tenant_id" = mention."tenant_id"
       AND mention_projection."knowledge_base_id" = mention."knowledge_base_id"
       AND mention_projection."id" = mention."projection_id"
       AND mention_projection."status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"
      JOIN public."knowledge_entities" AS mentioned_entity
        ON mentioned_entity."tenant_id" = mention."tenant_id"
       AND mentioned_entity."knowledge_base_id" = mention."knowledge_base_id"
       AND mentioned_entity."id" = mention."entity_id"
       AND mentioned_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"
      WHERE mention."tenant_id" = ${tenantId}::uuid
        AND mention."knowledge_base_id" = ${knowledgeBaseId}::uuid
    ),
    current_evidence AS (
      SELECT evidence.*
      FROM public."knowledge_relation_evidence" AS evidence
      JOIN current_chunks ON current_chunks."id" = evidence."chunk_id"
      JOIN public."knowledge_graph_projections" AS evidence_projection
        ON evidence_projection."tenant_id" = evidence."tenant_id"
       AND evidence_projection."knowledge_base_id" = evidence."knowledge_base_id"
       AND evidence_projection."id" = evidence."projection_id"
       AND evidence_projection."status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"
      JOIN public."knowledge_graph_retrieval_relations" AS evidenced_relation
        ON evidenced_relation."tenant_id" = evidence."tenant_id"
       AND evidenced_relation."knowledge_base_id" = evidence."knowledge_base_id"
       AND evidenced_relation."id" = evidence."relation_id"
      JOIN public."knowledge_entities" AS evidence_subject
        ON evidence_subject."tenant_id" = evidenced_relation."tenant_id"
       AND evidence_subject."knowledge_base_id" = evidenced_relation."knowledge_base_id"
       AND evidence_subject."id" = evidenced_relation."subject_entity_id"
       AND evidence_subject."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"
      JOIN public."knowledge_entities" AS evidence_object
        ON evidence_object."tenant_id" = evidenced_relation."tenant_id"
       AND evidence_object."knowledge_base_id" = evidenced_relation."knowledge_base_id"
       AND evidence_object."id" = evidenced_relation."object_entity_id"
       AND evidence_object."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"
      WHERE evidence."tenant_id" = ${tenantId}::uuid
        AND evidence."knowledge_base_id" = ${knowledgeBaseId}::uuid
    ),
    current_relations AS (
      SELECT DISTINCT evidence."relation_id"
      FROM current_evidence AS evidence
    ),
    current_entity_ids AS (
      SELECT DISTINCT mention."entity_id" FROM current_mentions AS mention
      UNION
      SELECT relation."subject_entity_id"
      FROM public."knowledge_graph_retrieval_relations" AS relation
      JOIN current_relations ON current_relations."relation_id" = relation."id"
      WHERE relation."tenant_id" = ${tenantId}::uuid
        AND relation."knowledge_base_id" = ${knowledgeBaseId}::uuid
      UNION
      SELECT relation."object_entity_id"
      FROM public."knowledge_graph_retrieval_relations" AS relation
      JOIN current_relations ON current_relations."relation_id" = relation."id"
      WHERE relation."tenant_id" = ${tenantId}::uuid
        AND relation."knowledge_base_id" = ${knowledgeBaseId}::uuid
    ),
    active_relations AS (
      SELECT governed_relation.*, source_relation."updated_at"
      FROM public."knowledge_graph_retrieval_relations" AS governed_relation
      JOIN public."knowledge_relations" AS source_relation
        ON source_relation."tenant_id" = governed_relation."tenant_id"
       AND source_relation."knowledge_base_id" = governed_relation."knowledge_base_id"
       AND source_relation."id" = governed_relation."id"
      JOIN public."knowledge_entities" AS subject_entity
        ON subject_entity."tenant_id" = governed_relation."tenant_id"
       AND subject_entity."knowledge_base_id" = governed_relation."knowledge_base_id"
       AND subject_entity."id" = governed_relation."subject_entity_id"
       AND subject_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"
      JOIN public."knowledge_entities" AS object_entity
        ON object_entity."tenant_id" = governed_relation."tenant_id"
       AND object_entity."knowledge_base_id" = governed_relation."knowledge_base_id"
       AND object_entity."id" = governed_relation."object_entity_id"
       AND object_entity."status" = 'ACTIVE'::"KnowledgeGraphRecordStatus"
      WHERE governed_relation."tenant_id" = ${tenantId}::uuid
        AND governed_relation."knowledge_base_id" = ${knowledgeBaseId}::uuid
        AND governed_relation."subject_entity_id" IN (SELECT "entity_id" FROM current_entity_ids)
        AND governed_relation."object_entity_id" IN (SELECT "entity_id" FROM current_entity_ids)
    ),
    latest_versions AS (
      SELECT DISTINCT ON (version."document_id")
        version."document_id",
        version."status"
      FROM public."knowledge_document_versions" AS version
      JOIN public."knowledge_documents" AS document
        ON document."tenant_id" = version."tenant_id"
       AND document."knowledge_base_id" = version."knowledge_base_id"
       AND document."id" = version."document_id"
       AND document."status" <> 'ARCHIVED'::"KnowledgeDocumentStatus"
      WHERE version."tenant_id" = ${tenantId}::uuid
        AND version."knowledge_base_id" = ${knowledgeBaseId}::uuid
      ORDER BY version."document_id", version."version_number" DESC, version."id" DESC
    )
  `;
}

function knowledgeGraphEntityFilterSql(
  query: string | null,
  entityType: string | null,
  focusEntityId: string | null,
): Prisma.Sql {
  return Prisma.sql`
    (${entityType}::text IS NULL OR entity."entity_type" = ${entityType})
    AND (
      ${query}::text IS NULL
      OR position(lower(${query}) in lower(entity."canonical_name")) > 0
      OR EXISTS (
        SELECT 1
        FROM unnest(entity."aliases") AS alias
        WHERE position(lower(${query}) in lower(alias)) > 0
      )
      OR EXISTS (
        SELECT 1
        FROM public."knowledge_entity_aliases" AS governed_alias
        WHERE governed_alias."tenant_id" = entity."tenant_id"
          AND governed_alias."knowledge_base_id" = entity."knowledge_base_id"
          AND public.knowledge_graph_resolve_canonical_entity(
            governed_alias."tenant_id",
            governed_alias."knowledge_base_id",
            governed_alias."entity_id"
          ) = entity."id"
          AND governed_alias."active"
          AND position(lower(${query}) in lower(governed_alias."normalized_alias")) > 0
      )
    )
    AND (
      ${focusEntityId}::uuid IS NULL
      OR entity."id" = ${focusEntityId}::uuid
      OR EXISTS (
        SELECT 1
        FROM active_relations AS relation
        WHERE (
          relation."subject_entity_id" = ${focusEntityId}::uuid
          AND relation."object_entity_id" = entity."id"
        ) OR (
          relation."object_entity_id" = ${focusEntityId}::uuid
          AND relation."subject_entity_id" = entity."id"
        )
      )
    )
  `;
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sortedUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

const DOCUMENT_MEMBER_ACCESS_LABEL_PREFIX = 'USER:';

function documentMemberAccessLabel(userId: string): string {
  return `${DOCUMENT_MEMBER_ACCESS_LABEL_PREFIX}${userId}`;
}

function isDocumentMemberAccessLabel(label: string): boolean {
  return label.startsWith(DOCUMENT_MEMBER_ACCESS_LABEL_PREFIX);
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

async function lockKnowledgeBase(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  knowledgeBaseId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:knowledge-base:${knowledgeBaseId}`}, 0))::text
  `;
}

async function lockKnowledgeBaseKeyspace(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:knowledge-base:keyspace`}, 0)
    )::text
  `;
}

interface ResolvedKnowledgeSpace {
  readonly type: 'COMPANY' | 'DEPARTMENT' | 'PROJECT' | 'MEMBER';
  readonly targetId: string;
  readonly targetName: string;
}

async function resolveKnowledgeSpace(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actorUserId: string,
  selection: KnowledgeSpaceSelection,
): Promise<ResolvedKnowledgeSpace> {
  if (selection.type === 'COMPANY') {
    const tenant = await transaction.tenant.findFirst({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (tenant === null) throw new NotFoundException('The company knowledge space was not found.');
    return { type: 'COMPANY', targetId: tenant.id, targetName: tenant.name };
  }

  if (selection.type === 'DEPARTMENT') {
    const orgUnit = await transaction.orgUnit.findFirst({
      where: { tenantId, id: selection.targetId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (orgUnit === null) {
      throw new BadRequestException(
        'The department knowledge space must reference an active department.',
      );
    }
    return { type: 'DEPARTMENT', targetId: orgUnit.id, targetName: orgUnit.name };
  }

  if (selection.type === 'MEMBER') {
    const member = await transaction.user.findFirst({
      where: { tenantId, id: actorUserId, status: 'ACTIVE' },
      select: { id: true, displayName: true },
    });
    if (member === null) {
      throw new BadRequestException('The member knowledge space must reference an active member.');
    }
    return { type: 'MEMBER', targetId: member.id, targetName: member.displayName };
  }

  if (selection.targetId !== undefined) {
    const existingProjectSpace = await transaction.knowledgeBase.findFirst({
      where: {
        tenantId,
        spaceType: 'PROJECT',
        spaceTargetId: selection.targetId,
      },
      select: { spaceTargetId: true, spaceTargetName: true },
    });
    if (existingProjectSpace === null) {
      throw new BadRequestException(
        'The project knowledge space was not found. Create a new project space first.',
      );
    }
    return {
      type: 'PROJECT',
      targetId: existingProjectSpace.spaceTargetId,
      targetName: existingProjectSpace.spaceTargetName,
    };
  }

  return {
    type: 'PROJECT',
    targetId: randomUUID(),
    targetName: selection.targetName.trim(),
  };
}

async function resolveKnowledgeBaseKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  name: string,
  explicitKey: string | undefined,
): Promise<string> {
  if (explicitKey !== undefined) {
    const key = explicitKey.trim();
    if (key.length < 2 || key.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
      throw new BadRequestException(
        'Knowledge base key must be a lowercase slug containing letters, numbers, and hyphens.',
      );
    }
    return key;
  }

  const base = generatedKnowledgeBaseKey(name);
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const suffix = ordinal === 1 ? '' : `-${ordinal}`;
    const prefix = base.slice(0, 100 - suffix.length).replace(/-+$/u, '');
    const candidate = `${prefix}${suffix}`;
    const existing = await transaction.knowledgeBase.findFirst({
      where: { tenantId, key: candidate },
      select: { id: true },
    });
    if (existing === null) return candidate;
  }
  throw new ConflictException('No available knowledge base key could be allocated.');
}

function generatedKnowledgeBaseKey(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 100)
    .replace(/-+$/u, '');
  if (normalized.length >= 2) return normalized;
  return `knowledge-${createHash('sha256').update(name.trim()).digest('hex').slice(0, 12)}`;
}

function importedLexiangSpaceName(name: string): string {
  const withoutManagedMarker = name.replace(/ · BMS:[0-9a-f-]{36}$/iu, '').trim();
  return withoutManagedMarker === '' ? name : withoutManagedMarker;
}

function knowledgeBaseNotFound(): NotFoundException {
  return new NotFoundException('The knowledge base was not found.');
}

function knowledgeDocumentNotFound(): NotFoundException {
  return new NotFoundException('The knowledge document was not found.');
}

function uploadMatch(
  document: {
    readonly id: string;
    readonly title: string;
    readonly fileName: string | null;
    readonly documentVersion: number;
    readonly updatedAt: Date;
  },
  matchedVersion: number,
): NonNullable<KnowledgeUploadInspection['matchingDocument']> {
  return {
    id: document.id,
    title: document.title,
    fileName: document.fileName,
    currentVersion: document.documentVersion,
    matchedVersion,
    updatedAt: document.updatedAt.toISOString(),
  };
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

function readChunkSheetName(metadata: Prisma.JsonValue): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const value = metadata.sheetName;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 200) : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}
