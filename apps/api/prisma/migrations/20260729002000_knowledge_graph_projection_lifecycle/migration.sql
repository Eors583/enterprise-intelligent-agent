BEGIN;

CREATE TYPE public."KnowledgeGraphProjectionStatus" AS ENUM (
  'CANDIDATE',
  'ACTIVE',
  'OBSOLETE'
);

CREATE TABLE public."knowledge_graph_projections" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "status" public."KnowledgeGraphProjectionStatus" NOT NULL DEFAULT 'CANDIDATE',
  "graph_hash" char(64) NOT NULL,
  "entity_count" integer NOT NULL DEFAULT 0,
  "mention_count" integer NOT NULL DEFAULT 0,
  "relation_count" integer NOT NULL DEFAULT 0,
  "evidence_count" integer NOT NULL DEFAULT 0,
  "created_by_user_id" uuid NOT NULL,
  "candidate_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at" timestamptz(6),
  "obsoleted_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_graph_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_graph_projections_scope_identity_key"
    UNIQUE (
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "id"
    ),
  CONSTRAINT "knowledge_graph_projections_tenant_identity_key"
    UNIQUE ("tenant_id", "knowledge_base_id", "id"),
  CONSTRAINT "knowledge_graph_projections_hash_check"
    CHECK ("graph_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "knowledge_graph_projections_counts_check"
    CHECK (
      "entity_count" >= 0
      AND "mention_count" >= 0
      AND "relation_count" >= 0
      AND "evidence_count" >= 0
    ),
  CONSTRAINT "knowledge_graph_projections_lifecycle_shape_check"
    CHECK (
      (
        "status" = 'CANDIDATE'
        AND "activated_at" IS NULL
        AND "obsoleted_at" IS NULL
      )
      OR (
        "status" = 'ACTIVE'
        AND "activated_at" IS NOT NULL
        AND "obsoleted_at" IS NULL
      )
      OR (
        "status" = 'OBSOLETE'
        AND "obsoleted_at" IS NOT NULL
      )
    ),
  CONSTRAINT "knowledge_graph_projections_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_graph_projections_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_graph_projections_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents"("tenant_id", "knowledge_base_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_graph_projections_document_version_fkey"
    FOREIGN KEY (
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id"
    )
    REFERENCES public."knowledge_document_versions"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_graph_projections_creator_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_graph_projections_one_active_document_idx"
  ON public."knowledge_graph_projections"(
    "tenant_id", "knowledge_base_id", "document_id"
  )
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "knowledge_graph_projections_one_candidate_document_idx"
  ON public."knowledge_graph_projections"(
    "tenant_id", "knowledge_base_id", "document_id"
  )
  WHERE "status" = 'CANDIDATE';
CREATE INDEX "knowledge_graph_projections_version_idx"
  ON public."knowledge_graph_projections"(
    "tenant_id", "knowledge_base_id", "document_version_id", "status"
  );

-- Give every historical document version an explicit graph snapshot. Current
-- published versions become ACTIVE, unpublished versions remain CANDIDATE and
-- prior published versions are OBSOLETE. The hash is a migration attestation;
-- all subsequent projections use the extractor's canonical graph hash.
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
  "created_by_user_id",
  "candidate_at",
  "activated_at",
  "obsoleted_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  version."tenant_id",
  version."knowledge_base_id",
  version."document_id",
  version."id",
  CASE
    WHEN document."current_version_id" = version."id"
      THEN 'ACTIVE'::public."KnowledgeGraphProjectionStatus"
    WHEN version."published_at" IS NULL
      AND version."status" IN ('DRAFT', 'PROCESSING', 'READY', 'FAILED')
      AND NOT EXISTS (
        SELECT 1
        FROM public."knowledge_document_versions" newer
        WHERE newer."tenant_id" = version."tenant_id"
          AND newer."document_id" = version."document_id"
          AND newer."version_number" > version."version_number"
          AND newer."published_at" IS NULL
      )
      THEN 'CANDIDATE'::public."KnowledgeGraphProjectionStatus"
    ELSE 'OBSOLETE'::public."KnowledgeGraphProjectionStatus"
  END,
  encode(
    digest(
      concat_ws(
        '|',
        'MIGRATED',
        version."id"::text,
        coalesce(version."checksum", ''),
        coalesce(version."governance_hash", ''),
        coalesce(version."parser_name", '')
      ),
      'sha256'
    ),
    'hex'
  ),
  (
    SELECT count(DISTINCT mention."entity_id")::integer
    FROM public."knowledge_entity_mentions" mention
    WHERE mention."tenant_id" = version."tenant_id"
      AND mention."knowledge_base_id" = version."knowledge_base_id"
      AND mention."document_version_id" = version."id"
  ),
  (
    SELECT count(*)::integer
    FROM public."knowledge_entity_mentions" mention
    WHERE mention."tenant_id" = version."tenant_id"
      AND mention."knowledge_base_id" = version."knowledge_base_id"
      AND mention."document_version_id" = version."id"
  ),
  (
    SELECT count(DISTINCT evidence."relation_id")::integer
    FROM public."knowledge_relation_evidence" evidence
    WHERE evidence."tenant_id" = version."tenant_id"
      AND evidence."knowledge_base_id" = version."knowledge_base_id"
      AND evidence."document_version_id" = version."id"
  ),
  (
    SELECT count(*)::integer
    FROM public."knowledge_relation_evidence" evidence
    WHERE evidence."tenant_id" = version."tenant_id"
      AND evidence."knowledge_base_id" = version."knowledge_base_id"
      AND evidence."document_version_id" = version."id"
  ),
  version."created_by_id",
  version."created_at",
  CASE
    WHEN document."current_version_id" = version."id"
      THEN coalesce(version."published_at", version."created_at")
    ELSE NULL
  END,
  CASE
    WHEN document."current_version_id" IS DISTINCT FROM version."id"
      AND (
        version."published_at" IS NOT NULL
        OR version."status" = 'ARCHIVED'
        OR EXISTS (
          SELECT 1
          FROM public."knowledge_document_versions" newer
          WHERE newer."tenant_id" = version."tenant_id"
            AND newer."document_id" = version."document_id"
            AND newer."version_number" > version."version_number"
            AND newer."published_at" IS NULL
        )
      )
      THEN coalesce(version."published_at", version."created_at")
    ELSE NULL
  END,
  version."created_at",
  CURRENT_TIMESTAMP
FROM public."knowledge_document_versions" version
JOIN public."knowledge_documents" document
  ON document."tenant_id" = version."tenant_id"
 AND document."knowledge_base_id" = version."knowledge_base_id"
 AND document."id" = version."document_id";

ALTER TABLE public."knowledge_entity_mentions"
  ADD COLUMN "projection_id" uuid;
ALTER TABLE public."knowledge_relation_evidence"
  ADD COLUMN "projection_id" uuid;

UPDATE public."knowledge_entity_mentions" mention
SET "projection_id" = projection."id"
FROM public."knowledge_graph_projections" projection
WHERE projection."tenant_id" = mention."tenant_id"
  AND projection."knowledge_base_id" = mention."knowledge_base_id"
  AND projection."document_id" = mention."document_id"
  AND projection."document_version_id" = mention."document_version_id";

UPDATE public."knowledge_relation_evidence" evidence
SET "projection_id" = projection."id"
FROM public."knowledge_graph_projections" projection
WHERE projection."tenant_id" = evidence."tenant_id"
  AND projection."knowledge_base_id" = evidence."knowledge_base_id"
  AND projection."document_id" = evidence."document_id"
  AND projection."document_version_id" = evidence."document_version_id";

ALTER TABLE public."knowledge_entity_mentions"
  ALTER COLUMN "projection_id" SET NOT NULL,
  ADD CONSTRAINT "knowledge_entity_mentions_projection_fkey"
    FOREIGN KEY (
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "projection_id"
    )
    REFERENCES public."knowledge_graph_projections"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE public."knowledge_relation_evidence"
  ALTER COLUMN "projection_id" SET NOT NULL,
  ADD CONSTRAINT "knowledge_relation_evidence_projection_fkey"
    FOREIGN KEY (
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "projection_id"
    )
    REFERENCES public."knowledge_graph_projections"(
      "tenant_id",
      "knowledge_base_id",
      "document_id",
      "document_version_id",
      "id"
    )
    ON DELETE CASCADE ON UPDATE NO ACTION;

DROP INDEX public."knowledge_entity_mentions_location_key";
CREATE UNIQUE INDEX "knowledge_entity_mentions_location_key"
  ON public."knowledge_entity_mentions"(
    "tenant_id",
    "projection_id",
    "entity_id",
    "chunk_id",
    "start_offset",
    "end_offset"
  );

DROP INDEX public."knowledge_relation_evidence_location_key";
CREATE UNIQUE INDEX "knowledge_relation_evidence_location_key"
  ON public."knowledge_relation_evidence"(
    "tenant_id",
    "projection_id",
    "relation_id",
    "chunk_id",
    coalesce("start_offset", -1),
    coalesce("end_offset", -1),
    md5("excerpt")
  );

CREATE INDEX "knowledge_entity_mentions_projection_idx"
  ON public."knowledge_entity_mentions"("tenant_id", "projection_id");
CREATE INDEX "knowledge_relation_evidence_projection_idx"
  ON public."knowledge_relation_evidence"("tenant_id", "projection_id");

ALTER TABLE public."knowledge_graph_conflicts"
  ADD COLUMN "projection_id" uuid,
  ADD COLUMN "document_version_id" uuid,
  ADD COLUMN "schema_predicate" varchar(200),
  ADD COLUMN "schema_subject_type" varchar(100),
  ADD COLUMN "schema_object_type" varchar(100),
  ADD COLUMN "occurrence_count" integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT "knowledge_graph_conflicts_occurrence_count_check"
    CHECK ("occurrence_count" > 0),
  ADD CONSTRAINT "knowledge_graph_conflicts_projection_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "projection_id")
    REFERENCES public."knowledge_graph_projections"(
      "tenant_id", "knowledge_base_id", "id"
    )
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_graph_conflicts_document_version_fkey"
    FOREIGN KEY ("tenant_id", "document_version_id")
    REFERENCES public."knowledge_document_versions"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_graph_conflicts_schema_gap_shape_check"
    CHECK (
      "conflict_type" <> 'ONTOLOGY.SCHEMA.GAP'
      OR (
        "projection_id" IS NOT NULL
        AND "document_version_id" IS NOT NULL
        AND nullif(btrim("schema_predicate"), '') IS NOT NULL
        AND nullif(btrim("schema_subject_type"), '') IS NOT NULL
        AND nullif(btrim("schema_object_type"), '') IS NOT NULL
      )
    );

-- Best-effort linkage for old instance conflicts. New writes always carry the
-- exact projection/version and the aggregate schema signature.
WITH conflict_projection_source AS (
  SELECT DISTINCT ON (conflict."id")
    conflict."id" AS conflict_id,
    evidence."projection_id",
    evidence."document_version_id",
    relation."normalized_predicate",
    subject."entity_type" AS subject_type,
    object."entity_type" AS object_type
  FROM public."knowledge_graph_conflicts" conflict
  JOIN public."knowledge_relations" relation
    ON relation."tenant_id" = conflict."tenant_id"
   AND relation."knowledge_base_id" = conflict."knowledge_base_id"
   AND relation."id" = conflict."target_id"
  JOIN public."knowledge_relation_evidence" evidence
    ON evidence."tenant_id" = relation."tenant_id"
   AND evidence."knowledge_base_id" = relation."knowledge_base_id"
   AND evidence."relation_id" = relation."id"
  JOIN public."knowledge_entities" subject
    ON subject."tenant_id" = relation."tenant_id"
   AND subject."knowledge_base_id" = relation."knowledge_base_id"
   AND subject."id" = relation."subject_entity_id"
  JOIN public."knowledge_entities" object
    ON object."tenant_id" = relation."tenant_id"
   AND object."knowledge_base_id" = relation."knowledge_base_id"
   AND object."id" = relation."object_entity_id"
  JOIN public."knowledge_graph_projections" projection
    ON projection."tenant_id" = evidence."tenant_id"
   AND projection."knowledge_base_id" = evidence."knowledge_base_id"
   AND projection."id" = evidence."projection_id"
  WHERE conflict."target_type" = 'RELATION'
  ORDER BY
    conflict."id",
    CASE projection."status" WHEN 'ACTIVE' THEN 0 WHEN 'CANDIDATE' THEN 1 ELSE 2 END,
    evidence."created_at" DESC,
    evidence."id"
)
UPDATE public."knowledge_graph_conflicts" conflict
SET
  "projection_id" = source."projection_id",
  "document_version_id" = source."document_version_id",
  "schema_predicate" = source."normalized_predicate",
  "schema_subject_type" = source."subject_type",
  "schema_object_type" = source."object_type"
FROM conflict_projection_source source
WHERE conflict."id" = source.conflict_id;

CREATE INDEX "knowledge_graph_conflicts_projection_status_idx"
  ON public."knowledge_graph_conflicts"(
    "tenant_id", "knowledge_base_id", "projection_id", "status"
  );
CREATE INDEX "knowledge_graph_conflicts_schema_gap_idx"
  ON public."knowledge_graph_conflicts"(
    "tenant_id",
    "knowledge_base_id",
    "projection_id",
    "schema_predicate",
    "schema_subject_type",
    "schema_object_type",
    "status"
  )
  WHERE "conflict_type" = 'ONTOLOGY.SCHEMA.GAP';

CREATE OR REPLACE FUNCTION public.knowledge_graph_projection_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Knowledge Graph Projection history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CANDIDATE'
      OR NEW."activated_at" IS NOT NULL
      OR NEW."obsoleted_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'A new Knowledge Graph Projection must be CANDIDATE'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW."tenant_id",
    NEW."knowledge_base_id",
    NEW."document_id",
    NEW."document_version_id",
    NEW."created_by_user_id",
    NEW."candidate_at",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."tenant_id",
    OLD."knowledge_base_id",
    OLD."document_id",
    OLD."document_version_id",
    OLD."created_by_user_id",
    OLD."candidate_at",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Knowledge Graph Projection identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'CANDIDATE' AND NEW."status" = 'ACTIVE' THEN
    IF NEW."activated_at" IS NULL OR NEW."obsoleted_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Projection activation requires an activation timestamp'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('CANDIDATE', 'ACTIVE') AND NEW."status" = 'OBSOLETE' THEN
    IF NEW."obsoleted_at" IS NULL THEN
      RAISE EXCEPTION 'Projection retirement requires an obsoleted timestamp'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid Knowledge Graph Projection lifecycle transition'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "knowledge_graph_projection_lifecycle_guard"
  BEFORE INSERT OR UPDATE OR DELETE
  ON public."knowledge_graph_projections"
  FOR EACH ROW
  EXECUTE FUNCTION public.knowledge_graph_projection_lifecycle_guard();

-- Schema-gap rows are aggregate governance work items rather than one conflict
-- per extracted relation. Their structural signature is immutable; evidence
-- samples and occurrence_count may grow only while the gap remains OPEN.
CREATE OR REPLACE FUNCTION public.knowledge_graph_conflict_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_exists boolean;
  correction public."knowledge_graph_corrections"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."target_type" = 'ENTITY' THEN
      SELECT EXISTS(
        SELECT 1 FROM public."knowledge_entities" entity
        WHERE entity."tenant_id" = NEW."tenant_id"
          AND entity."knowledge_base_id" = NEW."knowledge_base_id"
          AND entity."id" = NEW."target_id"
      ) INTO target_exists;
    ELSE
      SELECT EXISTS(
        SELECT 1 FROM public."knowledge_relations" relation
        WHERE relation."tenant_id" = NEW."tenant_id"
          AND relation."knowledge_base_id" = NEW."knowledge_base_id"
          AND relation."id" = NEW."target_id"
      ) INTO target_exists;
    END IF;
    IF NOT target_exists THEN
      RAISE EXCEPTION 'Graph Conflict target does not exist in the same tenant and knowledge base'
        USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Graph Conflict history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF
    OLD."conflict_type" = 'ONTOLOGY.SCHEMA.GAP'
    AND OLD."status" = 'OPEN'
    AND NEW."status" = 'OPEN'
    AND ROW(
      NEW."tenant_id",
      NEW."knowledge_base_id",
      NEW."target_type",
      NEW."target_id",
      NEW."conflict_key",
      NEW."conflict_type",
      NEW."projection_id",
      NEW."document_version_id",
      NEW."schema_predicate",
      NEW."schema_subject_type",
      NEW."schema_object_type",
      NEW."detected_by_user_id",
      NEW."idempotency_key",
      NEW."request_hash",
      NEW."created_at"
    ) IS NOT DISTINCT FROM ROW(
      OLD."tenant_id",
      OLD."knowledge_base_id",
      OLD."target_type",
      OLD."target_id",
      OLD."conflict_key",
      OLD."conflict_type",
      OLD."projection_id",
      OLD."document_version_id",
      OLD."schema_predicate",
      OLD."schema_subject_type",
      OLD."schema_object_type",
      OLD."detected_by_user_id",
      OLD."idempotency_key",
      OLD."request_hash",
      OLD."created_at"
    )
    AND NEW."occurrence_count" >= OLD."occurrence_count"
    AND NEW."revision" = OLD."revision" + 1
  THEN
    RETURN NEW;
  END IF;
  IF ROW(
    NEW."tenant_id",
    NEW."knowledge_base_id",
    NEW."target_type",
    NEW."target_id",
    NEW."conflict_key",
    NEW."conflict_type",
    NEW."details",
    NEW."evidence",
    NEW."projection_id",
    NEW."document_version_id",
    NEW."schema_predicate",
    NEW."schema_subject_type",
    NEW."schema_object_type",
    NEW."occurrence_count",
    NEW."detected_by_user_id",
    NEW."idempotency_key",
    NEW."request_hash",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."tenant_id",
    OLD."knowledge_base_id",
    OLD."target_type",
    OLD."target_id",
    OLD."conflict_key",
    OLD."conflict_type",
    OLD."details",
    OLD."evidence",
    OLD."projection_id",
    OLD."document_version_id",
    OLD."schema_predicate",
    OLD."schema_subject_type",
    OLD."schema_object_type",
    OLD."occurrence_count",
    OLD."detected_by_user_id",
    OLD."idempotency_key",
    OLD."request_hash",
    OLD."created_at"
  ) OR NEW."revision" <> OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'Graph Conflict evidence is immutable or revision is stale'
      USING ERRCODE = '40001';
  END IF;
  IF OLD."status" = 'OPEN' AND NEW."status" = 'IN_REVIEW' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('OPEN', 'IN_REVIEW')
    AND NEW."status" IN ('RESOLVED', 'REJECTED')
  THEN
    IF NEW."reviewed_by_user_id" IS NULL
      OR NEW."review_comment" IS NULL
      OR NEW."resolved_at" IS NULL
    THEN
      RAISE EXCEPTION 'Conflict resolution requires human review evidence'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'RESOLVED' THEN
      SELECT * INTO correction
      FROM public."knowledge_graph_corrections" candidate
      WHERE candidate."tenant_id" = NEW."tenant_id"
        AND candidate."knowledge_base_id" = NEW."knowledge_base_id"
        AND candidate."id" = NEW."resolution_correction_id";
      IF correction."status" <> 'APPLIED'
        OR correction."action" <> 'RESOLVE_CONFLICT'
        OR (correction."patch"->>'conflictId')::uuid <> NEW."id"
      THEN
        RAISE EXCEPTION 'Resolved conflict requires a matching applied correction'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid Graph Conflict lifecycle transition'
    USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE VIEW public."knowledge_graph_retrieval_relations"
WITH (security_barrier = true)
AS
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
  relation."status",
  governance."valid_from",
  governance."valid_to",
  governance."ontology_version_id",
  governance."predicate_definition_id"
FROM public."knowledge_relations" relation
JOIN public."knowledge_relation_governance" governance
  ON governance."tenant_id" = relation."tenant_id"
 AND governance."knowledge_base_id" = relation."knowledge_base_id"
 AND governance."relation_id" = relation."id"
JOIN public."knowledge_ontology_versions" version
  ON version."tenant_id" = governance."tenant_id"
 AND version."knowledge_base_id" = governance."knowledge_base_id"
 AND version."id" = governance."ontology_version_id"
 AND version."status" = 'PUBLISHED'
JOIN public."knowledge_ontology_predicates" predicate
  ON predicate."tenant_id" = governance."tenant_id"
 AND predicate."knowledge_base_id" = governance."knowledge_base_id"
 AND predicate."id" = governance."predicate_definition_id"
JOIN public."knowledge_entities" subject
  ON subject."tenant_id" = relation."tenant_id"
 AND subject."knowledge_base_id" = relation."knowledge_base_id"
 AND subject."id" = public.knowledge_graph_resolve_canonical_entity(
    relation."tenant_id",
    relation."knowledge_base_id",
    relation."subject_entity_id"
 )
 AND subject."status" = 'ACTIVE'
JOIN public."knowledge_entities" object
  ON object."tenant_id" = relation."tenant_id"
 AND object."knowledge_base_id" = relation."knowledge_base_id"
 AND object."id" = public.knowledge_graph_resolve_canonical_entity(
    relation."tenant_id",
    relation."knowledge_base_id",
    relation."object_entity_id"
 )
 AND object."status" = 'ACTIVE'
WHERE relation."tenant_id" =
    NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND relation."status" = 'ACTIVE'
  AND governance."valid_from" <= CURRENT_TIMESTAMP
  AND (governance."valid_to" IS NULL OR governance."valid_to" > CURRENT_TIMESTAMP)
  AND EXISTS (
    SELECT 1
    FROM public."knowledge_relation_evidence" active_evidence
    JOIN public."knowledge_graph_projections" active_projection
      ON active_projection."tenant_id" = active_evidence."tenant_id"
     AND active_projection."knowledge_base_id" = active_evidence."knowledge_base_id"
     AND active_projection."id" = active_evidence."projection_id"
     AND active_projection."status" = 'ACTIVE'
    WHERE active_evidence."tenant_id" = relation."tenant_id"
      AND active_evidence."knowledge_base_id" = relation."knowledge_base_id"
      AND active_evidence."relation_id" = relation."id"
  )
  AND (
    predicate."allow_self_loop"
    OR public.knowledge_graph_resolve_canonical_entity(
      relation."tenant_id", relation."knowledge_base_id", relation."subject_entity_id"
    ) <> public.knowledge_graph_resolve_canonical_entity(
      relation."tenant_id", relation."knowledge_base_id", relation."object_entity_id"
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public."knowledge_graph_conflicts" conflict
    JOIN public."knowledge_graph_projections" conflict_projection
      ON conflict_projection."tenant_id" = conflict."tenant_id"
     AND conflict_projection."knowledge_base_id" = conflict."knowledge_base_id"
     AND conflict_projection."id" = conflict."projection_id"
     AND conflict_projection."status" = 'ACTIVE'
    WHERE conflict."tenant_id" = relation."tenant_id"
      AND conflict."knowledge_base_id" = relation."knowledge_base_id"
      AND conflict."status" IN ('OPEN', 'IN_REVIEW')
      AND (
        (conflict."target_type" = 'RELATION' AND conflict."target_id" = relation."id")
        OR (
          conflict."target_type" = 'ENTITY'
          AND conflict."target_id" IN (
            relation."subject_entity_id",
            relation."object_entity_id",
            public.knowledge_graph_resolve_canonical_entity(
              relation."tenant_id",
              relation."knowledge_base_id",
              relation."subject_entity_id"
            ),
            public.knowledge_graph_resolve_canonical_entity(
              relation."tenant_id",
              relation."knowledge_base_id",
              relation."object_entity_id"
            )
          )
        )
      )
  );

ALTER TABLE public."knowledge_graph_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_graph_projections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation
  ON public."knowledge_graph_projections"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY enterprise_agent_admin_access
  ON public."knowledge_graph_projections"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public."knowledge_graph_projections"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE ON TABLE public."knowledge_graph_projections"
  TO enterprise_agent_admin;
GRANT USAGE ON TYPE public."KnowledgeGraphProjectionStatus"
  TO enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.knowledge_graph_projection_lifecycle_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_conflict_guard()
  FROM PUBLIC;

COMMIT;
