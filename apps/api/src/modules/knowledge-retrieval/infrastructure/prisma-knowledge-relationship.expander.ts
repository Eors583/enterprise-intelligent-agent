import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { KnowledgeDataClassification } from '../../ai-safety-model-routing/ai-data-classification.js';
import {
  KnowledgeRelationshipExpander,
  type KnowledgeRelationshipExpansionQuery,
  type KnowledgeRelationshipTargetRecord,
} from '../domain/knowledge-relationship-expander.port.js';
import {
  knowledgeVersionResourcePolicySnapshotSql,
  knowledgeVersionResourcePolicySql,
} from '../knowledge-resource-authorization.js';

interface RelationshipCandidateRow {
  chunk_id: string;
  knowledge_base_id: string;
  knowledge_base_name: string;
  document_id: string;
  document_version_id: string;
  document_version: number;
  title: string;
  heading_path: string[];
  content: string;
  source_type: 'TEXT' | 'MARKDOWN' | 'FILE' | 'WEB';
  classification: KnowledgeDataClassification;
  governance_hash: string;
  content_hash: string;
  updated_at: Date;
  metadata: Prisma.JsonValue;
  resource_policy: Prisma.JsonValue;
  relation_id: string;
  relation_type: string;
  source_chunk_id: string;
  source_entity_name: string;
  target_entity_name: string;
  direction: 'OUTBOUND' | 'INBOUND';
  hop_distance: number;
  confidence: number;
  source_seed_score: number;
  path_relation_ids: string[];
  path_predicates: string[];
  path_directions: Array<'OUTBOUND' | 'INBOUND'>;
  path_entity_ids: string[];
  path_entity_names: string[];
}

/**
 * Traverses at most two entity-relation hops from already-authorized seed chunks.
 *
 * The query repeats tenant, knowledge-base, publication and current-version
 * predicates for seed mentions, relation evidence and target mentions. RLS remains
 * the final database boundary; these explicit predicates also keep the adapter safe
 * when used by privileged maintenance roles.
 */
@Injectable()
export class PrismaKnowledgeRelationshipExpander extends KnowledgeRelationshipExpander {
  async expand(
    transaction: Prisma.TransactionClient,
    input: KnowledgeRelationshipExpansionQuery,
  ): Promise<readonly KnowledgeRelationshipTargetRecord[]> {
    const accessibleIds = [...new Set(input.accessibleKnowledgeBaseIds)].slice(0, 50);
    const seedChunkIds = [...new Set(input.seedChunkIds)].slice(0, 20);
    const entityQuery = normalizeEntityQuery(input.query);
    if (accessibleIds.length === 0 || (seedChunkIds.length === 0 && entityQuery.length < 2)) {
      return [];
    }

    const previewIds = [...new Set(input.previewDraftKnowledgeBaseIds)]
      .filter((id) => accessibleIds.includes(id))
      .slice(0, 50);
    const previewVersionIds = [...new Set(input.previewKnowledgeVersionIds)].slice(0, 20);
    const accessibleSql = Prisma.join(accessibleIds.map((id) => Prisma.sql`${id}::uuid`));
    const previewVersionSql = previewVersionIds.map((id) => Prisma.sql`${id}::uuid`);
    const seedsSql =
      seedChunkIds.length === 0
        ? Prisma.sql`NULL::uuid`
        : Prisma.join(seedChunkIds.map((id) => Prisma.sql`${id}::uuid`));
    const knowledgeBaseStatusSql =
      previewIds.length === 0
        ? Prisma.sql`knowledge_base."status" = 'ACTIVE'`
        : Prisma.sql`(
            knowledge_base."status" = 'ACTIVE'
            OR (
              knowledge_base."status" = 'DRAFT'
              AND knowledge_base."id" IN (
                ${Prisma.join(previewIds.map((id) => Prisma.sql`${id}::uuid`))}
              )
            )
          )`;
    const candidateLimit = Math.min(200, Math.max(1, Math.trunc(input.candidateLimit)));
    const evidenceResourceFilterSql = knowledgeVersionResourcePolicySql(
      Prisma.sql`evidence_version`,
      input.authorizationFilters,
    );
    const seedResourceFilterSql = knowledgeVersionResourcePolicySql(
      Prisma.sql`seed_version`,
      input.authorizationFilters,
    );
    const targetResourceFilterSql = knowledgeVersionResourcePolicySql(
      Prisma.sql`target_version`,
      input.authorizationFilters,
    );
    const targetPolicySql = knowledgeVersionResourcePolicySnapshotSql(Prisma.sql`target_version`);
    const evidenceProjectionScopeSql =
      previewVersionSql.length === 0
        ? Prisma.sql`evidence_projection."status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"`
        : Prisma.sql`(
            evidence_projection."status" = 'CANDIDATE'::"KnowledgeGraphProjectionStatus"
            AND evidence_projection."document_version_id" IN (${Prisma.join(previewVersionSql)})
          )`;
    const seedProjectionScopeSql =
      previewVersionSql.length === 0
        ? Prisma.sql`seed_projection."status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"`
        : Prisma.sql`(
            seed_projection."status" = 'CANDIDATE'::"KnowledgeGraphProjectionStatus"
            AND seed_projection."document_version_id" IN (${Prisma.join(previewVersionSql)})
          )`;
    const targetProjectionScopeSql =
      previewVersionSql.length === 0
        ? Prisma.sql`target_projection."status" = 'ACTIVE'::"KnowledgeGraphProjectionStatus"`
        : Prisma.sql`(
            target_projection."status" = 'CANDIDATE'::"KnowledgeGraphProjectionStatus"
            AND target_projection."document_version_id" IN (${Prisma.join(previewVersionSql)})
          )`;
    const evidenceDocumentVersionScopeSql =
      previewVersionSql.length === 0
        ? Prisma.sql`evidence_document."current_version_id" = evidence."document_version_id"`
        : Prisma.sql`evidence."document_version_id" IN (${Prisma.join(previewVersionSql)})`;
    const seedDocumentVersionScopeSql =
      previewVersionSql.length === 0
        ? Prisma.sql`seed_document."current_version_id" = seed_chunk."document_version_id"`
        : Prisma.sql`seed_chunk."document_version_id" IN (${Prisma.join(previewVersionSql)})`;
    const targetDocumentVersionScopeSql =
      previewVersionSql.length === 0
        ? Prisma.sql`target_document."current_version_id" = target_chunk."document_version_id"`
        : Prisma.sql`target_chunk."document_version_id" IN (${Prisma.join(previewVersionSql)})`;

    const rows = await transaction.$queryRaw<RelationshipCandidateRow[]>(Prisma.sql`
      WITH RECURSIVE current_relation_evidence AS MATERIALIZED (
        SELECT
          evidence."tenant_id",
          evidence."knowledge_base_id",
          evidence."relation_id",
          max(evidence."confidence"::double precision) AS evidence_confidence
        FROM public."knowledge_relation_evidence" AS evidence
        JOIN public."knowledge_graph_projections" AS evidence_projection
         ON evidence_projection."tenant_id" = evidence."tenant_id"
         AND evidence_projection."knowledge_base_id" = evidence."knowledge_base_id"
         AND evidence_projection."id" = evidence."projection_id"
         AND ${evidenceProjectionScopeSql}
        JOIN public."knowledge_documents" AS evidence_document
          ON evidence_document."tenant_id" = evidence."tenant_id"
         AND evidence_document."knowledge_base_id" = evidence."knowledge_base_id"
         AND evidence_document."id" = evidence."document_id"
         AND evidence_document."status" = 'READY'
         AND ${evidenceDocumentVersionScopeSql}
        JOIN public."knowledge_document_versions" AS evidence_version
          ON evidence_version."tenant_id" = evidence."tenant_id"
         AND evidence_version."knowledge_base_id" = evidence."knowledge_base_id"
         AND evidence_version."document_id" = evidence."document_id"
         AND evidence_version."id" = evidence."document_version_id"
         AND evidence_version."status" = 'READY'
        WHERE evidence."tenant_id" = ${input.tenantId}::uuid
          AND evidence."knowledge_base_id" IN (${accessibleSql})
          AND ${evidenceResourceFilterSql}
        GROUP BY evidence."tenant_id", evidence."knowledge_base_id", evidence."relation_id"
      ),
      eligible_relations AS MATERIALIZED (
        SELECT
          relation."id",
          relation."tenant_id",
          relation."knowledge_base_id",
          public.knowledge_graph_resolve_canonical_entity(
            relation."tenant_id",
            relation."knowledge_base_id",
            relation."subject_entity_id"
          ) AS "subject_entity_id",
          public.knowledge_graph_resolve_canonical_entity(
            relation."tenant_id",
            relation."knowledge_base_id",
            relation."object_entity_id"
          ) AS "object_entity_id",
          relation."predicate",
          relation."normalized_predicate",
          relation."attributes",
          relation."confidence",
          relation."status"
        FROM public."knowledge_relations" relation
        WHERE relation."tenant_id" = ${input.tenantId}::uuid
          AND relation."knowledge_base_id" IN (${accessibleSql})
          AND relation."status" = 'ACTIVE'
      ),
      eligible_seed_mentions AS MATERIALIZED (
        SELECT
          mention."chunk_id" AS seed_chunk_id,
          mention."knowledge_base_id",
          public.knowledge_graph_resolve_canonical_entity(
            mention."tenant_id",
            mention."knowledge_base_id",
            mention."entity_id"
          ) AS "entity_id",
          entity."canonical_name" AS source_entity_name,
          least(
            mention."confidence"::double precision,
            entity."confidence"::double precision
          )::double precision AS path_confidence,
          greatest(
            CASE
              WHEN lower(entity."canonical_name") = lower(${entityQuery}) THEN 1.0
              WHEN lower(entity."normalized_name") = lower(${entityQuery}) THEN 0.98
              ELSE 0.0
            END,
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM unnest(entity."aliases") AS alias
                WHERE lower(alias) = lower(${entityQuery})
              ) OR EXISTS (
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
                  AND lower(governed_alias."normalized_alias") = lower(${entityQuery})
              ) THEN 0.96
              ELSE 0.0
            END,
            CASE
              WHEN position(lower(${entityQuery}) in lower(entity."canonical_name")) > 0
                OR position(lower(${entityQuery}) in lower(entity."normalized_name")) > 0
                OR (
                  length(entity."canonical_name") >= 4
                  AND position(lower(entity."canonical_name") in lower(${entityQuery})) > 0
                )
                OR (
                  length(entity."normalized_name") >= 4
                  AND position(lower(entity."normalized_name") in lower(${entityQuery})) > 0
                )
                OR EXISTS (
                  SELECT 1
                  FROM unnest(entity."aliases") AS alias
                  WHERE position(lower(${entityQuery}) in lower(alias)) > 0
                     OR (
                       length(alias) >= 4
                       AND position(lower(alias) in lower(${entityQuery})) > 0
                     )
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
                    AND (
                      position(
                        lower(${entityQuery})
                        in lower(governed_alias."normalized_alias")
                      ) > 0
                      OR (
                        length(governed_alias."normalized_alias") >= 4
                        AND position(
                          lower(governed_alias."normalized_alias")
                          in lower(${entityQuery})
                        ) > 0
                      )
                    )
                )
              THEN 0.82
              ELSE 0.0
            END
          )::double precision AS entity_match_score,
          mention."confidence"::double precision AS mention_confidence,
          mention."id" AS mention_id
        FROM public."knowledge_entity_mentions" AS mention
        JOIN public."knowledge_graph_projections" AS seed_projection
         ON seed_projection."tenant_id" = mention."tenant_id"
         AND seed_projection."knowledge_base_id" = mention."knowledge_base_id"
         AND seed_projection."id" = mention."projection_id"
         AND ${seedProjectionScopeSql}
        JOIN public."knowledge_entities" AS entity
          ON entity."tenant_id" = mention."tenant_id"
         AND entity."knowledge_base_id" = mention."knowledge_base_id"
         AND entity."id" = public.knowledge_graph_resolve_canonical_entity(
           mention."tenant_id",
           mention."knowledge_base_id",
           mention."entity_id"
         )
         AND entity."status" = 'ACTIVE'
        JOIN public."knowledge_chunks" AS seed_chunk
          ON seed_chunk."tenant_id" = mention."tenant_id"
         AND seed_chunk."knowledge_base_id" = mention."knowledge_base_id"
         AND seed_chunk."document_id" = mention."document_id"
         AND seed_chunk."document_version_id" = mention."document_version_id"
         AND seed_chunk."id" = mention."chunk_id"
        JOIN public."knowledge_documents" AS seed_document
          ON seed_document."tenant_id" = seed_chunk."tenant_id"
         AND seed_document."knowledge_base_id" = seed_chunk."knowledge_base_id"
         AND seed_document."id" = seed_chunk."document_id"
         AND seed_document."status" = 'READY'
         AND ${seedDocumentVersionScopeSql}
        JOIN public."knowledge_document_versions" AS seed_version
          ON seed_version."tenant_id" = seed_chunk."tenant_id"
         AND seed_version."knowledge_base_id" = seed_chunk."knowledge_base_id"
         AND seed_version."document_id" = seed_chunk."document_id"
         AND seed_version."id" = seed_chunk."document_version_id"
         AND seed_version."status" = 'READY'
        JOIN public."knowledge_bases" AS knowledge_base
          ON knowledge_base."tenant_id" = mention."tenant_id"
         AND knowledge_base."id" = mention."knowledge_base_id"
         AND ${knowledgeBaseStatusSql}
        WHERE mention."tenant_id" = ${input.tenantId}::uuid
          AND mention."knowledge_base_id" IN (${accessibleSql})
          AND ${seedResourceFilterSql}
      ),
      requested_seed_mentions AS (
        SELECT
          eligible.*,
          0.0::double precision AS source_seed_score,
          0::integer AS source_priority
        FROM eligible_seed_mentions AS eligible
        WHERE eligible.seed_chunk_id IN (${seedsSql})
      ),
      direct_seed_mentions AS (
        SELECT
          eligible.*,
          eligible.entity_match_score AS source_seed_score,
          1::integer AS source_priority
        FROM eligible_seed_mentions AS eligible
        WHERE length(${entityQuery}) >= 2
          AND eligible.entity_match_score >= 0.8
        ORDER BY
          eligible.entity_match_score DESC,
          eligible.mention_confidence DESC,
          eligible.seed_chunk_id ASC,
          eligible."entity_id" ASC
        LIMIT 20
      ),
      seed_mentions AS MATERIALIZED (
        SELECT DISTINCT ON (combined.seed_chunk_id, combined."entity_id")
          combined.seed_chunk_id,
          combined."knowledge_base_id",
          combined."entity_id",
          combined.source_entity_name,
          combined.path_confidence,
          combined.source_seed_score
        FROM (
          SELECT * FROM requested_seed_mentions
          UNION ALL
          SELECT * FROM direct_seed_mentions
        ) AS combined
        ORDER BY
          combined.seed_chunk_id,
          combined."entity_id",
          combined.source_priority DESC,
          combined.source_seed_score DESC,
          combined.mention_confidence DESC,
          combined.mention_id ASC
      ),
      eligible_target_mentions AS MATERIALIZED (
        SELECT
          mention.*,
          public.knowledge_graph_resolve_canonical_entity(
            mention."tenant_id",
            mention."knowledge_base_id",
            mention."entity_id"
          ) AS canonical_entity_id
        FROM public."knowledge_entity_mentions" AS mention
        JOIN public."knowledge_graph_projections" AS target_projection
         ON target_projection."tenant_id" = mention."tenant_id"
         AND target_projection."knowledge_base_id" = mention."knowledge_base_id"
         AND target_projection."id" = mention."projection_id"
         AND ${targetProjectionScopeSql}
        WHERE mention."tenant_id" = ${input.tenantId}::uuid
          AND mention."knowledge_base_id" IN (${accessibleSql})
      ),
      relationship_walk AS (
        SELECT
          seed.seed_chunk_id,
          seed."knowledge_base_id",
          seed."entity_id" AS root_entity_id,
          seed.source_entity_name,
          seed.source_seed_score,
          step.next_entity_id AS current_entity_id,
          relation."id" AS terminal_relation_id,
          coalesce(nullif(relation."normalized_predicate", ''), relation."predicate")::text
            AS predicate_path,
          step.direction::text AS root_direction,
          1::integer AS hop_distance,
          least(
            seed.path_confidence,
            relation."confidence"::double precision,
            evidence.evidence_confidence,
            next_entity."confidence"::double precision
          )::double precision AS path_confidence,
          ARRAY[seed."entity_id", step.next_entity_id]::uuid[] AS visited_entities,
          ARRAY[relation."id"]::uuid[] AS path_relation_ids,
          ARRAY[
            coalesce(nullif(relation."normalized_predicate", ''), relation."predicate")::text
          ]::text[] AS path_predicates,
          ARRAY[step.direction::text]::text[] AS path_directions,
          ARRAY[seed."entity_id", step.next_entity_id]::uuid[] AS path_entity_ids,
          ARRAY[seed.source_entity_name, next_entity."canonical_name"]::text[]
            AS path_entity_names
        FROM seed_mentions AS seed
        JOIN eligible_relations AS relation
          ON relation."tenant_id" = ${input.tenantId}::uuid
         AND relation."knowledge_base_id" = seed."knowledge_base_id"
         AND relation."status" = 'ACTIVE'
         AND (
           relation."subject_entity_id" = seed."entity_id"
           OR relation."object_entity_id" = seed."entity_id"
         )
        CROSS JOIN LATERAL (
          SELECT
            CASE
              WHEN relation."subject_entity_id" = seed."entity_id"
                THEN relation."object_entity_id"
              ELSE relation."subject_entity_id"
            END AS next_entity_id,
            CASE
              WHEN relation."subject_entity_id" = seed."entity_id"
                THEN 'OUTBOUND'
              ELSE 'INBOUND'
            END AS direction
        ) AS step
        JOIN current_relation_evidence AS evidence
          ON evidence."tenant_id" = relation."tenant_id"
         AND evidence."knowledge_base_id" = relation."knowledge_base_id"
         AND evidence."relation_id" = relation."id"
        JOIN public."knowledge_entities" AS next_entity
          ON next_entity."tenant_id" = relation."tenant_id"
         AND next_entity."knowledge_base_id" = relation."knowledge_base_id"
         AND next_entity."id" = step.next_entity_id
         AND next_entity."status" = 'ACTIVE'
        WHERE step.next_entity_id <> seed."entity_id"

        UNION ALL

        SELECT
          walk.seed_chunk_id,
          walk."knowledge_base_id",
          walk.root_entity_id,
          walk.source_entity_name,
          walk.source_seed_score,
          step.next_entity_id AS current_entity_id,
          relation."id" AS terminal_relation_id,
          (walk.predicate_path || ' > ' ||
            coalesce(nullif(relation."normalized_predicate", ''), relation."predicate"))::text
            AS predicate_path,
          walk.root_direction,
          (walk.hop_distance + 1)::integer AS hop_distance,
          least(
            walk.path_confidence,
            relation."confidence"::double precision,
            evidence.evidence_confidence,
            next_entity."confidence"::double precision
          )::double precision AS path_confidence,
          (walk.visited_entities || step.next_entity_id)::uuid[] AS visited_entities,
          (walk.path_relation_ids || relation."id")::uuid[] AS path_relation_ids,
          (
            walk.path_predicates ||
            coalesce(nullif(relation."normalized_predicate", ''), relation."predicate")::text
          )::text[] AS path_predicates,
          (walk.path_directions || step.direction::text)::text[] AS path_directions,
          (walk.path_entity_ids || step.next_entity_id)::uuid[] AS path_entity_ids,
          (walk.path_entity_names || next_entity."canonical_name")::text[] AS path_entity_names
        FROM relationship_walk AS walk
        JOIN eligible_relations AS relation
          ON relation."tenant_id" = ${input.tenantId}::uuid
         AND relation."knowledge_base_id" = walk."knowledge_base_id"
         AND relation."status" = 'ACTIVE'
         AND (
           relation."subject_entity_id" = walk.current_entity_id
           OR relation."object_entity_id" = walk.current_entity_id
         )
        CROSS JOIN LATERAL (
          SELECT
            CASE
              WHEN relation."subject_entity_id" = walk.current_entity_id
                THEN relation."object_entity_id"
              ELSE relation."subject_entity_id"
            END AS next_entity_id,
            CASE
              WHEN relation."subject_entity_id" = walk.current_entity_id
                THEN 'OUTBOUND'
              ELSE 'INBOUND'
            END AS direction
        ) AS step
        JOIN current_relation_evidence AS evidence
          ON evidence."tenant_id" = relation."tenant_id"
         AND evidence."knowledge_base_id" = relation."knowledge_base_id"
         AND evidence."relation_id" = relation."id"
        JOIN public."knowledge_entities" AS next_entity
          ON next_entity."tenant_id" = relation."tenant_id"
         AND next_entity."knowledge_base_id" = relation."knowledge_base_id"
         AND next_entity."id" = step.next_entity_id
         AND next_entity."status" = 'ACTIVE'
        WHERE walk.hop_distance < 2
          AND NOT (step.next_entity_id = ANY(walk.visited_entities))
      ),
      raw_candidates AS (
        SELECT DISTINCT ON (
          walk.seed_chunk_id,
          target_chunk."id",
          walk.terminal_relation_id,
          walk.path_relation_ids
        )
          target_chunk."id" AS chunk_id,
          target_chunk."knowledge_base_id" AS knowledge_base_id,
          knowledge_base."name" AS knowledge_base_name,
          target_chunk."document_id" AS document_id,
          target_chunk."document_version_id" AS document_version_id,
          target_version."version_number" AS document_version,
          target_document."title" AS title,
          target_chunk."heading_path" AS heading_path,
          target_chunk."content" AS content,
          target_chunk."content_hash" AS content_hash,
          target_version."source_type"::text AS source_type,
          target_version."classification"::text AS classification,
          target_version."governance_hash" AS governance_hash,
          coalesce(target_version."published_at", target_version."created_at") AS updated_at,
          target_chunk."metadata" AS metadata,
          ${targetPolicySql} AS resource_policy,
          walk.terminal_relation_id AS relation_id,
          walk.predicate_path AS relation_type,
          walk.seed_chunk_id AS source_chunk_id,
          walk.source_entity_name,
          target_entity."canonical_name" AS target_entity_name,
          walk.root_direction AS direction,
          walk.hop_distance,
          walk.source_seed_score,
          walk.path_relation_ids,
          walk.path_predicates,
          walk.path_directions,
          walk.path_entity_ids,
          walk.path_entity_names,
          least(
            walk.path_confidence,
            target_mention."confidence"::double precision,
            target_entity."confidence"::double precision
          )::double precision AS confidence
        FROM relationship_walk AS walk
        JOIN public."knowledge_entities" AS target_entity
          ON target_entity."tenant_id" = ${input.tenantId}::uuid
         AND target_entity."knowledge_base_id" = walk."knowledge_base_id"
         AND target_entity."id" = walk.current_entity_id
         AND target_entity."status" = 'ACTIVE'
        JOIN eligible_target_mentions AS target_mention
          ON target_mention."tenant_id" = target_entity."tenant_id"
         AND target_mention."knowledge_base_id" = target_entity."knowledge_base_id"
         AND target_mention.canonical_entity_id = target_entity."id"
        JOIN public."knowledge_chunks" AS target_chunk
          ON target_chunk."tenant_id" = target_mention."tenant_id"
         AND target_chunk."knowledge_base_id" = target_mention."knowledge_base_id"
         AND target_chunk."document_id" = target_mention."document_id"
         AND target_chunk."document_version_id" = target_mention."document_version_id"
         AND target_chunk."id" = target_mention."chunk_id"
        JOIN public."knowledge_bases" AS knowledge_base
          ON knowledge_base."tenant_id" = target_chunk."tenant_id"
         AND knowledge_base."id" = target_chunk."knowledge_base_id"
         AND ${knowledgeBaseStatusSql}
        JOIN public."knowledge_documents" AS target_document
          ON target_document."tenant_id" = target_chunk."tenant_id"
         AND target_document."knowledge_base_id" = target_chunk."knowledge_base_id"
         AND target_document."id" = target_chunk."document_id"
         AND target_document."status" = 'READY'
         AND ${targetDocumentVersionScopeSql}
        JOIN public."knowledge_document_versions" AS target_version
          ON target_version."tenant_id" = target_chunk."tenant_id"
         AND target_version."knowledge_base_id" = target_chunk."knowledge_base_id"
         AND target_version."document_id" = target_chunk."document_id"
         AND target_version."id" = target_chunk."document_version_id"
         AND target_version."status" = 'READY'
        WHERE target_chunk."tenant_id" = ${input.tenantId}::uuid
          AND target_chunk."knowledge_base_id" IN (${accessibleSql})
          AND target_chunk."id" <> walk.seed_chunk_id
          AND ${targetResourceFilterSql}
        ORDER BY
          walk.seed_chunk_id,
          target_chunk."id",
          walk.terminal_relation_id,
          walk.path_relation_ids,
          target_mention."confidence" DESC,
          target_mention."id" ASC
      ),
      target_priority AS (
        SELECT
          chunk_id,
          max(confidence * 0.8 + source_seed_score * 0.2) AS target_priority,
          min(hop_distance) AS minimum_hop
        FROM raw_candidates
        GROUP BY chunk_id
        ORDER BY target_priority DESC, minimum_hop ASC, chunk_id ASC
        LIMIT ${candidateLimit}
      ),
      bounded_candidates AS (
        SELECT
          candidate.*,
          row_number() OVER (
            PARTITION BY candidate.chunk_id
            ORDER BY
              candidate.confidence DESC,
              candidate.source_seed_score DESC,
              candidate.hop_distance ASC,
              candidate.relation_id ASC,
              candidate.source_chunk_id ASC
          ) AS evidence_rank
        FROM raw_candidates AS candidate
        JOIN target_priority ON target_priority.chunk_id = candidate.chunk_id
      )
      SELECT *
      FROM bounded_candidates
      WHERE evidence_rank <= 8
      ORDER BY
        (confidence * 0.8 + source_seed_score * 0.2) DESC,
        hop_distance ASC,
        chunk_id ASC,
        relation_id ASC
    `);

    return groupRelationshipRows(rows);
  }
}

function groupRelationshipRows(
  rows: readonly RelationshipCandidateRow[],
): KnowledgeRelationshipTargetRecord[] {
  const targets = new Map<string, KnowledgeRelationshipTargetRecord>();
  for (const row of rows) {
    if (row.hop_distance !== 1 && row.hop_distance !== 2) continue;
    if (
      row.path_relation_ids.length !== row.hop_distance ||
      row.path_predicates.length !== row.hop_distance ||
      row.path_directions.length !== row.hop_distance ||
      row.path_entity_ids.length !== row.hop_distance + 1 ||
      row.path_entity_names.length !== row.hop_distance + 1
    ) {
      continue;
    }
    const path = row.path_relation_ids.flatMap((relationId, index) => {
      const predicate = row.path_predicates[index];
      const direction = row.path_directions[index];
      const sourceEntityId = row.path_entity_ids[index];
      const sourceEntityName = row.path_entity_names[index];
      const targetEntityId = row.path_entity_ids[index + 1];
      const targetEntityName = row.path_entity_names[index + 1];
      return predicate === undefined ||
        direction === undefined ||
        sourceEntityId === undefined ||
        sourceEntityName === undefined ||
        targetEntityId === undefined ||
        targetEntityName === undefined
        ? []
        : [
            {
              relationId,
              predicate,
              direction,
              sourceEntityId,
              sourceEntityName,
              targetEntityId,
              targetEntityName,
            },
          ];
    });
    if (path.length !== row.hop_distance) continue;
    const evidence = {
      relationId: row.relation_id,
      relationType: row.relation_type,
      sourceChunkId: row.source_chunk_id,
      targetChunkId: row.chunk_id,
      sourceEntityName: row.source_entity_name,
      targetEntityName: row.target_entity_name,
      direction: row.direction,
      hopDistance: row.hop_distance,
      confidence: row.confidence,
      sourceSeedScore: row.source_seed_score,
      path,
    } as const;
    const existing = targets.get(row.chunk_id);
    if (existing !== undefined) {
      targets.set(row.chunk_id, {
        ...existing,
        evidence: [...existing.evidence, evidence],
      });
      continue;
    }
    targets.set(row.chunk_id, {
      chunkId: row.chunk_id,
      knowledgeBaseId: row.knowledge_base_id,
      knowledgeBaseName: row.knowledge_base_name,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      documentVersion: row.document_version,
      title: row.title,
      headingPath: row.heading_path,
      content: row.content,
      sourceType: row.source_type,
      classification: row.classification,
      governanceHash: row.governance_hash,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
      metadata: row.metadata,
      resourcePolicy: row.resource_policy,
      evidence: [evidence],
    });
  }
  return [...targets.values()];
}

function normalizeEntityQuery(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 300);
}
