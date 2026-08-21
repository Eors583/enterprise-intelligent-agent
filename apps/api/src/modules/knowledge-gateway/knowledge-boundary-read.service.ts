import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import type {
  KnowledgeDocumentMaterialization,
  KnowledgeDocumentVersionIdentity,
  KnowledgeEvaluationSnapshot,
  KnowledgeOperationalSummary,
} from './knowledge-gateway.port.js';

type Transaction = Parameters<Parameters<AdminPrismaService['withTenant']>[1]>[0];

interface OperationalSummaryRow {
  readonly active_bases: number;
  readonly total_documents: number;
  readonly ready_documents: number;
  readonly failed_documents: number;
  readonly pending_parse_reviews: number;
  readonly rejected_parse_reviews: number;
  readonly failed_ingestion_jobs: number;
  readonly total_chunks: number;
  readonly chunks_with_embeddings: number;
}

interface MaterializationRow {
  readonly document_status: KnowledgeDocumentMaterialization['documentStatus'];
  readonly document_current_version_id: string | null;
  readonly version_status: KnowledgeDocumentMaterialization['versionStatus'];
  readonly governance_review_status: KnowledgeDocumentMaterialization['governanceReviewStatus'];
  readonly published_at: Date | null;
  readonly ingestion_status: KnowledgeDocumentMaterialization['ingestionStatus'];
  readonly ingestion_error_code: string | null;
  readonly chunk_count: number;
  readonly embedding_count: number;
}

/**
 * The only Prisma-backed read model exported through Knowledge Gateway.
 * Consumers receive stable DTOs or opaque evaluation components and never a
 * Prisma transaction, table name, Qdrant collection, or object-storage key.
 */
@Injectable()
export class KnowledgeBoundaryReadService {
  constructor(@Inject(AdminPrismaService) private readonly prisma: AdminPrismaService) {}

  readOperationalSummary(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<KnowledgeOperationalSummary> {
    return this.withPrincipal(input, async (transaction) => {
      const [row] = await transaction.$queryRaw<OperationalSummaryRow[]>(Prisma.sql`
        SELECT
          (SELECT count(*)::int FROM public."knowledge_bases"
            WHERE "tenant_id" = ${input.tenantId}::uuid AND "status" = 'ACTIVE') AS active_bases,
          (SELECT count(*)::int FROM public."knowledge_documents"
            WHERE "tenant_id" = ${input.tenantId}::uuid) AS total_documents,
          (SELECT count(*)::int FROM public."knowledge_documents"
            WHERE "tenant_id" = ${input.tenantId}::uuid AND "status" = 'READY') AS ready_documents,
          (SELECT count(*)::int FROM public."knowledge_documents"
            WHERE "tenant_id" = ${input.tenantId}::uuid AND "status" = 'FAILED') AS failed_documents,
          (SELECT count(*)::int FROM public."knowledge_document_versions"
            WHERE "tenant_id" = ${input.tenantId}::uuid
              AND "parse_review_status" = 'PENDING') AS pending_parse_reviews,
          (SELECT count(*)::int FROM public."knowledge_document_versions"
            WHERE "tenant_id" = ${input.tenantId}::uuid
              AND "parse_review_status" = 'REJECTED') AS rejected_parse_reviews,
          (SELECT count(*)::int FROM public."knowledge_ingestion_jobs"
            WHERE "tenant_id" = ${input.tenantId}::uuid
              AND "status" = 'FAILED') AS failed_ingestion_jobs,
          (SELECT count(*)::int FROM public."knowledge_chunks"
            WHERE "tenant_id" = ${input.tenantId}::uuid) AS total_chunks,
          (SELECT count(DISTINCT "chunk_id")::int FROM public."knowledge_chunk_embeddings"
            WHERE "tenant_id" = ${input.tenantId}::uuid) AS chunks_with_embeddings
      `);
      if (row === undefined) throw new Error('Knowledge operational summary returned no row.');
      return {
        activeBases: row.active_bases,
        totalDocuments: row.total_documents,
        readyDocuments: row.ready_documents,
        failedDocuments: row.failed_documents,
        pendingParseReviews: row.pending_parse_reviews,
        rejectedParseReviews: row.rejected_parse_reviews,
        failedIngestionJobs: row.failed_ingestion_jobs,
        totalChunks: row.total_chunks,
        chunksWithEmbeddings: row.chunks_with_embeddings,
      };
    });
  }

  requireActiveKnowledgeBase(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly knowledgeBaseId: string;
  }): Promise<void> {
    return this.withPrincipal(input, async (transaction) => {
      const base = await transaction.knowledgeBase.findFirst({
        where: { tenantId: input.tenantId, id: input.knowledgeBaseId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (base === null)
        throw new NotFoundException('The target active Knowledge Base was not found.');
    });
  }

  validateKnowledgeBaseSelection(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly knowledgeBaseIds: readonly string[];
    readonly orgUnitId?: string;
  }): Promise<void> {
    return this.withPrincipal(input, async (transaction) => {
      const knowledgeBases = await transaction.knowledgeBase.findMany({
        where: {
          tenantId: input.tenantId,
          id: { in: [...input.knowledgeBaseIds] },
          status: 'ACTIVE',
        },
        include: { orgUnits: true },
      });
      if (knowledgeBases.length !== input.knowledgeBaseIds.length) {
        throw new ConflictException(
          'The knowledge selection contains a missing, inactive, or cross-tenant knowledge base.',
        );
      }
      if (input.orgUnitId === undefined) return;
      const orgUnits = await transaction.orgUnit.findMany({
        where: { tenantId: input.tenantId, status: 'ACTIVE' },
        select: { id: true, parentId: true },
      });
      const parentById = new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit.parentId]));
      if (!parentById.has(input.orgUnitId)) {
        throw new ConflictException('The department is no longer active.');
      }
      const inaccessible = knowledgeBases.filter(
        (knowledgeBase) =>
          knowledgeBase.orgUnits.length > 0 &&
          !knowledgeBase.orgUnits.some(
            (scope) =>
              scope.orgUnitId === input.orgUnitId ||
              (scope.includeChildren &&
                isOrgUnitAncestor(scope.orgUnitId, input.orgUnitId as string, parentById)),
          ),
      );
      if (inaccessible.length > 0) {
        throw new ConflictException(
          'The knowledge selection contains a base outside the Agent department scope.',
        );
      }
    });
  }

  countOrgUnitBindings(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly orgUnitId: string;
  }): Promise<number> {
    return this.withPrincipal(input, (transaction) =>
      transaction.knowledgeBaseOrgUnit.count({
        where: { tenantId: input.tenantId, orgUnitId: input.orgUnitId },
      }),
    );
  }

  findDocumentVersionByChangeSummary(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly changeSummary: string;
    readonly documentId?: string;
  }): Promise<KnowledgeDocumentVersionIdentity | null> {
    return this.withPrincipal(input, async (transaction) => {
      const version = await transaction.knowledgeDocumentVersion.findFirst({
        where: {
          tenantId: input.tenantId,
          changeSummary: input.changeSummary,
          ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, documentId: true, versionNumber: true },
      });
      return version === null
        ? null
        : {
            documentId: version.documentId,
            documentVersionId: version.id,
            documentVersion: version.versionNumber,
          };
    });
  }

  readDocumentMaterialization(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly documentVersionId: string;
  }): Promise<KnowledgeDocumentMaterialization | null> {
    return this.withPrincipal(input, async (transaction) => {
      const [row] = await transaction.$queryRaw<MaterializationRow[]>(Prisma.sql`
        SELECT
          document."status"::text AS document_status,
          document."current_version_id" AS document_current_version_id,
          version."status"::text AS version_status,
          version."governance_review_status"::text AS governance_review_status,
          version."published_at",
          latest_job."status"::text AS ingestion_status,
          latest_job."error_code" AS ingestion_error_code,
          coalesce(chunk_stats.chunk_count, 0)::int AS chunk_count,
          coalesce(chunk_stats.embedding_count, 0)::int AS embedding_count
        FROM public."knowledge_document_versions" version
        JOIN public."knowledge_documents" document
          ON document."tenant_id" = version."tenant_id"
         AND document."id" = version."document_id"
        LEFT JOIN LATERAL (
          SELECT job."status", job."error_code"
          FROM public."knowledge_ingestion_jobs" job
          WHERE job."tenant_id" = version."tenant_id"
            AND job."document_version_id" = version."id"
          ORDER BY job."created_at" DESC, job."id" DESC
          LIMIT 1
        ) latest_job ON true
        LEFT JOIN LATERAL (
          SELECT
            count(*)::int AS chunk_count,
            count(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM public."knowledge_chunk_embeddings" embedding
                WHERE embedding."tenant_id" = chunk."tenant_id"
                  AND embedding."chunk_id" = chunk."id"
              )
            )::int AS embedding_count
          FROM public."knowledge_chunks" chunk
          WHERE chunk."tenant_id" = version."tenant_id"
            AND chunk."document_version_id" = version."id"
        ) chunk_stats ON true
        WHERE version."tenant_id" = ${input.tenantId}::uuid
          AND version."id" = ${input.documentVersionId}::uuid
        LIMIT 1
      `);
      return row === undefined
        ? null
        : {
            documentStatus: row.document_status,
            documentCurrentVersionId: row.document_current_version_id,
            versionStatus: row.version_status,
            governanceReviewStatus: row.governance_review_status,
            publishedAt: row.published_at,
            ingestionStatus: row.ingestion_status,
            ingestionErrorCode: row.ingestion_error_code,
            chunkCount: row.chunk_count,
            embeddingCount: row.embedding_count,
          };
    });
  }

  readEvaluationCorpus(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly versionIds: readonly string[];
    readonly allowUnpublishedCandidate: boolean;
    readonly maximumBytes: number;
  }): Promise<string> {
    return this.withPrincipal(input, async (transaction) => {
      const publicationBoundary = input.allowUnpublishedCandidate
        ? Prisma.empty
        : Prisma.sql`AND version."published_at" IS NOT NULL`;
      const rows = await transaction.$queryRaw<
        Array<{ document_version_id: string; chunk_index: number; content: string }>
      >(Prisma.sql`
        SELECT chunk."document_version_id", chunk."chunk_index", chunk."content"
        FROM public."knowledge_chunks" chunk
        JOIN public."knowledge_document_versions" version
          ON version."tenant_id" = chunk."tenant_id"
         AND version."id" = chunk."document_version_id"
        WHERE chunk."tenant_id" = ${input.tenantId}::uuid
          AND chunk."document_version_id" IN (
            ${Prisma.join(input.versionIds.map((id) => Prisma.sql`${id}::uuid`))}
          )
          AND version."status" = 'READY'
          AND version."governance_review_status" = 'APPROVED'
          AND (
            version."source_type" NOT IN ('FILE', 'WEB')
            OR version."parse_review_status" = 'APPROVED'
          )
          ${publicationBoundary}
          AND version."effective_from" <= CURRENT_TIMESTAMP
          AND (version."expires_at" IS NULL OR version."expires_at" > CURRENT_TIMESTAMP)
        ORDER BY chunk."document_version_id", chunk."chunk_index"
      `);
      if (
        rows.length === 0 ||
        new Set(rows.map(({ document_version_id }) => document_version_id)).size !==
          input.versionIds.length
      ) {
        throw new ConflictException(
          input.allowUnpublishedCandidate
            ? 'Knowledge evaluation requires an approved, effective, non-empty READY candidate.'
            : 'Knowledge evaluation requires published, approved, non-empty knowledge chunks.',
        );
      }
      const content = rows
        .map(
          ({ document_version_id, chunk_index, content: chunk }) =>
            `[${document_version_id}:${chunk_index}]\n${chunk}`,
        )
        .join('\n\n');
      if (Buffer.byteLength(content, 'utf8') > input.maximumBytes) {
        throw new ConflictException(
          'The sealed knowledge evaluation corpus exceeds the trusted runner payload limit.',
        );
      }
      return content;
    });
  }

  captureEvaluationSnapshot(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly versionIds: readonly string[];
    readonly mode: 'SUBJECT' | 'COMPOSITE';
    readonly expectedSubjectVersion?: number;
  }): Promise<KnowledgeEvaluationSnapshot> {
    return this.withPrincipal(input, async (transaction) => {
      if (input.mode === 'SUBJECT') {
        const subjectId = input.versionIds[0];
        if (subjectId === undefined || input.versionIds.length !== 1) {
          throw new NotFoundException('Knowledge Version was not found.');
        }
        const rows = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT version."id", version."version_number", version."checksum",
                 version."status"::text AS status, version."knowledge_base_id",
                 version."document_id", btrim(version."governance_hash") AS governance_hash,
                 version."governance_revision", version."governance_review_status",
                 version."governance_reviewed_by_id", version."governance_reviewed_at",
                 version."classification", version."scope_mode",
                 version."organization_scope_ids", version."project_scope_ids",
                 version."task_scope_ids", version."role_template_scope_ids",
                 version."data_labels", version."supersedes_version_id",
                 version."effective_from", version."expires_at",
                 version."retention_until", version."retention_action",
                 version."source_type"::text AS source_type, version."object_sha256",
                 version."parser_name", version."parse_quality_score"::text AS parse_quality_score,
                 version."parse_review_status"::text AS parse_review_status,
                 version."parse_review_revision", version."parse_reviewed_by_id",
                 version."parse_reviewed_at", version."parse_diagnostics"
          FROM public."knowledge_document_versions" version
          WHERE version."tenant_id" = ${input.tenantId}::uuid
            AND version."id" = ${subjectId}::uuid
            AND version."version_number" = ${input.expectedSubjectVersion ?? null}
        `);
        const version = rows[0];
        if (version === undefined) throw new NotFoundException('Knowledge Version was not found.');
        return {
          schemaVersion: 'knowledge-evaluation-snapshot.v1',
          components: {
            version,
            ...(await this.loadKnowledgeArtifacts(transaction, input.tenantId, [subjectId])),
          },
        };
      }

      const knowledge =
        input.versionIds.length === 0
          ? []
          : await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
              SELECT version."id", version."version_number", version."checksum",
                     version."status"::text AS status,
                     btrim(version."governance_hash") AS governance_hash,
                     version."governance_revision", version."governance_review_status",
                     version."governance_reviewed_by_id", version."governance_reviewed_at",
                     version."classification", version."scope_mode",
                     version."organization_scope_ids", version."project_scope_ids",
                     version."task_scope_ids", version."role_template_scope_ids",
                     version."data_labels", version."supersedes_version_id",
                     version."effective_from", version."expires_at",
                     version."retention_until", version."retention_action",
                     version."source_type"::text AS source_type, version."object_sha256",
                     version."parser_name", version."parse_quality_score"::text AS parse_quality_score,
                     version."parse_review_status"::text AS parse_review_status,
                     version."parse_review_revision", version."parse_reviewed_by_id",
                     version."parse_reviewed_at", version."parse_diagnostics"
              FROM public."knowledge_document_versions" version
              WHERE version."tenant_id" = ${input.tenantId}::uuid
                AND version."id" IN (${Prisma.join(input.versionIds.map((id) => Prisma.sql`${id}::uuid`))})
              ORDER BY version."id"
            `);
      if (knowledge.length !== input.versionIds.length) {
        throw new NotFoundException(
          'One or more Knowledge Versions in the composite release snapshot were not found.',
        );
      }
      return {
        schemaVersion: 'knowledge-evaluation-snapshot.v1',
        components: {
          knowledge,
          ...(await this.loadKnowledgeArtifacts(transaction, input.tenantId, input.versionIds)),
        },
      };
    });
  }

  private async loadKnowledgeArtifacts(
    transaction: Transaction,
    tenantId: string,
    versionIds: readonly string[],
  ): Promise<Readonly<Record<string, readonly Record<string, unknown>[]>>> {
    if (versionIds.length === 0) return emptyKnowledgeArtifacts();
    const ids = versionIds.map((id) => Prisma.sql`${id}::uuid`);
    const chunks = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT chunk."id", chunk."document_version_id", chunk."chunk_index",
             chunk."heading_path", chunk."content_hash", chunk."token_count", chunk."metadata"
      FROM public."knowledge_chunks" chunk
      WHERE chunk."tenant_id" = ${tenantId}::uuid
        AND chunk."document_version_id" IN (${Prisma.join(ids)})
      ORDER BY chunk."document_version_id", chunk."chunk_index", chunk."id"
    `);
    const embeddings = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT embedding."chunk_id", chunk."document_version_id",
             embedding."embedding_model", embedding."embedding_dimension", embedding."content_hash",
             encode(digest(convert_to(embedding."embedding"::text, 'UTF8'), 'sha256'), 'hex') AS embedding_hash
      FROM public."knowledge_chunk_embeddings" embedding
      JOIN public."knowledge_chunks" chunk
        ON chunk."tenant_id" = embedding."tenant_id" AND chunk."id" = embedding."chunk_id"
      WHERE embedding."tenant_id" = ${tenantId}::uuid
        AND chunk."document_version_id" IN (${Prisma.join(ids)})
      ORDER BY chunk."document_version_id", embedding."chunk_id", embedding."embedding_model"
    `);
    const graphProjections = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT projection."id", projection."knowledge_base_id", projection."document_id",
             projection."document_version_id", projection."status"::text AS status,
             btrim(projection."graph_hash") AS graph_hash, projection."entity_count",
             projection."mention_count", projection."relation_count", projection."evidence_count",
             projection."candidate_at", projection."activated_at", projection."obsoleted_at"
      FROM public."knowledge_graph_projections" projection
      WHERE projection."tenant_id" = ${tenantId}::uuid
        AND projection."document_version_id" IN (${Prisma.join(ids)})
      ORDER BY projection."document_version_id", projection."id"
    `);
    const relations = await transaction.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT relation."id", relation_evidence."document_version_id", relation_evidence."projection_id",
             relation."subject_entity_id", relation."normalized_predicate", relation."object_entity_id",
             relation."attributes", relation."confidence"::text AS relation_confidence,
             relation."status"::text AS relation_status, relation_evidence."id" AS evidence_id,
             relation_evidence."chunk_id", relation_evidence."excerpt", relation_evidence."start_offset",
             relation_evidence."end_offset", relation_evidence."confidence"::text AS evidence_confidence,
             relation_evidence."extractor", relation_evidence."metadata"
      FROM public."knowledge_relation_evidence" relation_evidence
      JOIN public."knowledge_relations" relation
        ON relation."tenant_id" = relation_evidence."tenant_id"
       AND relation."knowledge_base_id" = relation_evidence."knowledge_base_id"
       AND relation."id" = relation_evidence."relation_id"
      WHERE relation_evidence."tenant_id" = ${tenantId}::uuid
        AND relation_evidence."document_version_id" IN (${Prisma.join(ids)})
      ORDER BY relation_evidence."document_version_id", relation."id", relation_evidence."id"
    `);
    const relationGovernance = await transaction.$queryRaw<
      Array<Record<string, unknown>>
    >(Prisma.sql`
      SELECT DISTINCT governance."id", governance."knowledge_base_id", governance."relation_id",
             governance."ontology_version_id", governance."predicate_definition_id",
             governance."valid_from", governance."valid_to", governance."correction_id",
             governance."approved_by_user_id", governance."revision"
      FROM public."knowledge_relation_governance" governance
      JOIN public."knowledge_relation_evidence" relation_evidence
        ON relation_evidence."tenant_id" = governance."tenant_id"
       AND relation_evidence."knowledge_base_id" = governance."knowledge_base_id"
       AND relation_evidence."relation_id" = governance."relation_id"
      WHERE governance."tenant_id" = ${tenantId}::uuid
        AND relation_evidence."document_version_id" IN (${Prisma.join(ids)})
      ORDER BY governance."knowledge_base_id", governance."relation_id", governance."id"
    `);
    const ontologyVersionIds = relationGovernance
      .map((row) => row.ontology_version_id)
      .filter((id): id is string => typeof id === 'string');
    const ontologySql = ontologyVersionIds.map((id) => Prisma.sql`${id}::uuid`);
    const ontologyVersions = await optionalRows(
      transaction,
      ontologySql,
      () => Prisma.sql`
      SELECT version."id", version."knowledge_base_id", version."ontology_id",
             version."version_number", version."revision", version."status"::text AS status,
             version."change_summary", btrim(version."schema_hash") AS schema_hash,
             version."submitted_by_user_id", version."reviewed_by_user_id", version."review_comment",
             version."submitted_at", version."reviewed_at", version."published_at",
             version."retired_at", version."system_bootstrap"
      FROM public."knowledge_ontology_versions" version
      WHERE version."tenant_id" = ${tenantId}::uuid
        AND version."id" IN (${Prisma.join(ontologySql)})
      ORDER BY version."knowledge_base_id", version."ontology_id", version."version_number", version."id"
    `,
    );
    const ontologyEntityTypes = await optionalRows(
      transaction,
      ontologySql,
      () => Prisma.sql`
      SELECT entity_type."id", entity_type."knowledge_base_id", entity_type."ontology_version_id",
             entity_type."key", entity_type."name", entity_type."description", entity_type."attributes_schema"
      FROM public."knowledge_ontology_entity_types" entity_type
      WHERE entity_type."tenant_id" = ${tenantId}::uuid
        AND entity_type."ontology_version_id" IN (${Prisma.join(ontologySql)})
      ORDER BY entity_type."ontology_version_id", entity_type."key", entity_type."id"
    `,
    );
    const ontologyPredicates = await optionalRows(
      transaction,
      ontologySql,
      () => Prisma.sql`
      SELECT predicate."id", predicate."knowledge_base_id", predicate."ontology_version_id",
             predicate."key", predicate."predicate", predicate."label", predicate."domain_type_key",
             predicate."range_type_key", predicate."inverse_predicate_key", predicate."symmetric",
             predicate."functional", predicate."allow_self_loop", predicate."temporal",
             predicate."attributes_schema"
      FROM public."knowledge_ontology_predicates" predicate
      WHERE predicate."tenant_id" = ${tenantId}::uuid
        AND predicate."ontology_version_id" IN (${Prisma.join(ontologySql)})
      ORDER BY predicate."ontology_version_id", predicate."key", predicate."id"
    `,
    );
    const projectionIds = graphProjections
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string');
    const projectionSql = projectionIds.map((id) => Prisma.sql`${id}::uuid`);
    const graphConflicts = await optionalRows(
      transaction,
      projectionSql,
      () => Prisma.sql`
      SELECT conflict."id", conflict."knowledge_base_id", conflict."projection_id",
             conflict."document_version_id", conflict."conflict_key", conflict."conflict_type",
             conflict."schema_predicate", conflict."schema_subject_type", conflict."schema_object_type",
             conflict."occurrence_count", conflict."details", conflict."evidence",
             conflict."status"::text AS status, conflict."revision",
             conflict."resolution_correction_id", conflict."review_comment", conflict."resolved_at"
      FROM public."knowledge_graph_conflicts" conflict
      WHERE conflict."tenant_id" = ${tenantId}::uuid
        AND conflict."projection_id" IN (${Prisma.join(projectionSql)})
      ORDER BY conflict."projection_id", conflict."conflict_key", conflict."id"
    `,
    );
    return {
      chunks,
      embeddings,
      graphConflicts,
      graphProjections,
      ontologyEntityTypes,
      ontologyPredicates,
      ontologyVersions,
      relations,
      relationGovernance,
    };
  }

  private withPrincipal<T>(
    input: { readonly tenantId: string; readonly userId: string },
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withTenant(input.tenantId, async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.user_id', ${input.userId}, true)`;
      return operation(transaction);
    });
  }
}

function emptyKnowledgeArtifacts(): Readonly<Record<string, readonly Record<string, unknown>[]>> {
  return {
    chunks: [],
    embeddings: [],
    graphConflicts: [],
    graphProjections: [],
    ontologyEntityTypes: [],
    ontologyPredicates: [],
    ontologyVersions: [],
    relations: [],
    relationGovernance: [],
  };
}

function optionalRows(
  transaction: Transaction,
  ids: readonly Prisma.Sql[],
  query: () => Prisma.Sql,
): Promise<Array<Record<string, unknown>>> {
  return ids.length === 0
    ? Promise.resolve([])
    : transaction.$queryRaw<Array<Record<string, unknown>>>(query());
}

function isOrgUnitAncestor(
  candidateAncestorId: string,
  orgUnitId: string,
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  const visited = new Set<string>();
  let current = parentById.get(orgUnitId) ?? null;
  while (current !== null && !visited.has(current)) {
    if (current === candidateAncestorId) return true;
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}
