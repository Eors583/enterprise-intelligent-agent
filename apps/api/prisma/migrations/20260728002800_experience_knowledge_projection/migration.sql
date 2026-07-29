BEGIN;

CREATE TABLE public."experience_knowledge_projections" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "experience_id" uuid NOT NULL,
  "expected_experience_revision" integer NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "document_id" uuid,
  "document_version_id" uuid,
  "document_version" integer,
  "target_role_template_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "target_org_unit_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "publication_hash" char(64) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'CREATING',
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamptz(6),
  "error_code" varchar(120),
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_knowledge_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "experience_knowledge_projections_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "experience_knowledge_projections_experience_key"
    UNIQUE ("tenant_id", "experience_id"),
  CONSTRAINT "experience_knowledge_projections_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "experience_knowledge_projections_revision_check"
    CHECK ("expected_experience_revision" > 0),
  CONSTRAINT "experience_knowledge_projections_hash_check"
    CHECK (
      "publication_hash" ~ '^[a-f0-9]{64}$'
      AND "request_hash" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "experience_knowledge_projections_status_check"
    CHECK (
      "status" IN ('CREATING', 'PROCESSING', 'READY', 'PUBLISHED', 'FAILED', 'RETIRED')
    ),
  CONSTRAINT "experience_knowledge_projections_target_check"
    CHECK (
      cardinality("target_role_template_ids") > 0
      OR cardinality("target_org_unit_ids") > 0
    ),
  CONSTRAINT "experience_knowledge_projections_identity_shape_check"
    CHECK (
      (
        "status" IN ('CREATING', 'FAILED')
        AND (
          (
            "document_id" IS NULL
            AND "document_version_id" IS NULL
            AND "document_version" IS NULL
          )
          OR (
            "document_id" IS NOT NULL
            AND "document_version_id" IS NOT NULL
            AND "document_version" > 0
          )
        )
      )
      OR (
        "status" IN ('PROCESSING', 'READY', 'PUBLISHED', 'RETIRED')
        AND "document_id" IS NOT NULL
        AND "document_version_id" IS NOT NULL
        AND "document_version" > 0
      )
    ),
  CONSTRAINT "experience_knowledge_projections_lease_shape_check"
    CHECK (
      ("lease_token" IS NULL AND "lease_expires_at" IS NULL)
      OR (
        "lease_token" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
        AND "status" = 'CREATING'
      )
    ),
  CONSTRAINT "experience_knowledge_projections_failure_shape_check"
    CHECK (("status" = 'FAILED') = ("error_code" IS NOT NULL)),
  CONSTRAINT "experience_knowledge_projections_updated_check"
    CHECK ("updated_at" >= "created_at")
);

ALTER TABLE public."experience_knowledge_projections"
  ADD CONSTRAINT "experience_knowledge_projections_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_knowledge_projections_experience_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_knowledge_projections_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_knowledge_projections_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents" ("tenant_id", "knowledge_base_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_knowledge_projections_document_version_fkey"
    FOREIGN KEY (
      "tenant_id", "knowledge_base_id", "document_id", "document_version_id"
    )
    REFERENCES public."knowledge_document_versions" (
      "tenant_id", "knowledge_base_id", "document_id", "id"
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_knowledge_projections_creator_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT;

CREATE INDEX "experience_knowledge_projections_status_idx"
  ON public."experience_knowledge_projections" (
    "tenant_id", "status", "updated_at" DESC, "id"
  );
CREATE INDEX "experience_knowledge_projections_document_version_idx"
  ON public."experience_knowledge_projections" (
    "tenant_id", "document_version_id"
  );

CREATE OR REPLACE FUNCTION public.guard_experience_knowledge_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  current_user_id uuid;
  role_target_count integer;
  org_target_count integer;
  version_ready boolean;
  version_published boolean;
  version_scope_matches boolean;
BEGIN
  current_user_id := nullif(current_setting('app.user_id', true), '')::uuid;
  NEW."target_role_template_ids" := ARRAY(
    SELECT DISTINCT value
    FROM unnest(NEW."target_role_template_ids") item(value)
    ORDER BY value
  );
  NEW."target_org_unit_ids" := ARRAY(
    SELECT DISTINCT value
    FROM unnest(NEW."target_org_unit_ids") item(value)
    ORDER BY value
  );

  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id";
  IF candidate_record."id" IS NULL THEN
    RAISE EXCEPTION 'EXPERIENCE_PROJECTION_CANDIDATE_MISSING'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF candidate_record."status" <> 'VALIDATED'
       OR candidate_record."revision" <> NEW."expected_experience_revision"
       OR current_user_id IS NULL
       OR NEW."created_by_user_id" <> current_user_id
       OR NEW."status" <> 'CREATING'
       OR NEW."lease_token" IS NULL
       OR NEW."lease_expires_at" <= statement_timestamp()
    THEN
      RAISE EXCEPTION 'EXPERIENCE_PROJECTION_CREATION_NOT_AUTHORIZED'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."experience_id" IS DISTINCT FROM OLD."experience_id"
       OR NEW."expected_experience_revision" IS DISTINCT FROM OLD."expected_experience_revision"
       OR NEW."knowledge_base_id" IS DISTINCT FROM OLD."knowledge_base_id"
       OR NEW."target_role_template_ids" IS DISTINCT FROM OLD."target_role_template_ids"
       OR NEW."target_org_unit_ids" IS DISTINCT FROM OLD."target_org_unit_ids"
       OR NEW."publication_hash" IS DISTINCT FROM OLD."publication_hash"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
       OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'EXPERIENCE_PROJECTION_IDENTITY_IMMUTABLE'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (
      NEW."status" = OLD."status"
      OR (OLD."status" = 'CREATING' AND NEW."status" IN ('PROCESSING', 'FAILED', 'RETIRED'))
      OR (OLD."status" = 'FAILED' AND NEW."status" IN ('CREATING', 'RETIRED'))
      OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('READY', 'PUBLISHED', 'FAILED', 'RETIRED'))
      OR (OLD."status" = 'READY' AND NEW."status" IN ('PUBLISHED', 'FAILED', 'RETIRED'))
      OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED')
    ) THEN
      RAISE EXCEPTION 'EXPERIENCE_PROJECTION_STATE_TRANSITION_INVALID'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT count(*)::integer
    INTO role_target_count
  FROM public."agent_templates" role_template
  WHERE role_template."tenant_id" = NEW."tenant_id"
    AND role_template."id" = ANY(NEW."target_role_template_ids");
  SELECT count(*)::integer
    INTO org_target_count
  FROM public."org_units" org_unit
  WHERE org_unit."tenant_id" = NEW."tenant_id"
    AND org_unit."status" = 'ACTIVE'
    AND org_unit."id" = ANY(NEW."target_org_unit_ids");
  IF role_target_count <> cardinality(NEW."target_role_template_ids")
     OR org_target_count <> cardinality(NEW."target_org_unit_ids")
  THEN
    RAISE EXCEPTION 'EXPERIENCE_PROJECTION_TARGET_SCOPE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."document_version_id" IS NOT NULL THEN
    SELECT
      version."status" = 'READY'
        AND version."checksum" IS NOT NULL
        AND btrim(version."checksum"::text) =
          btrim(NEW."publication_hash"::text)
        AND cardinality(
          ARRAY(
            SELECT chunk."id"
            FROM public."knowledge_chunks" chunk
            WHERE chunk."tenant_id" = version."tenant_id"
              AND chunk."document_version_id" = version."id"
          )
        ) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM public."knowledge_chunks" chunk
          WHERE chunk."tenant_id" = version."tenant_id"
            AND chunk."document_version_id" = version."id"
            AND NOT EXISTS (
              SELECT 1
              FROM public."knowledge_chunk_embeddings" embedding
              WHERE embedding."tenant_id" = chunk."tenant_id"
                AND embedding."chunk_id" = chunk."id"
            )
        ),
      version."status" = 'READY'
        AND version."checksum" IS NOT NULL
        AND btrim(version."checksum"::text) =
          btrim(NEW."publication_hash"::text)
        AND version."published_at" IS NOT NULL
        AND version."governance_review_status" = 'APPROVED'
        AND version."effective_from" <= statement_timestamp()
        AND (
          version."expires_at" IS NULL
          OR version."expires_at" > statement_timestamp()
        )
        AND version."evaluation_run_id" IS NOT NULL
        AND version."evaluation_dataset_version_id" IS NOT NULL
        AND version."evaluation_snapshot_hash" IS NOT NULL
        AND document."status" = 'READY'
        AND document."current_version_id" = version."id"
        AND EXISTS (
          SELECT 1
          FROM public."knowledge_chunks" chunk
          WHERE chunk."tenant_id" = version."tenant_id"
            AND chunk."document_version_id" = version."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public."knowledge_chunks" chunk
          WHERE chunk."tenant_id" = version."tenant_id"
            AND chunk."document_version_id" = version."id"
            AND NOT EXISTS (
              SELECT 1
              FROM public."knowledge_chunk_embeddings" embedding
              WHERE embedding."tenant_id" = chunk."tenant_id"
                AND embedding."chunk_id" = chunk."id"
            )
        ),
      version."governance_owner_user_id" = candidate_record."contributor_user_id"
        AND version."classification" =
          CASE candidate_record."sensitivity"::text
            WHEN 'PUBLIC' THEN 'PUBLIC'
            WHEN 'INTERNAL' THEN 'INTERNAL'
            ELSE 'CONFIDENTIAL'
          END
        AND version."scope_mode" = 'RESTRICTED'
        AND version."role_template_scope_ids" @> NEW."target_role_template_ids"
        AND NEW."target_role_template_ids" @> version."role_template_scope_ids"
        AND version."organization_scope_ids" @> NEW."target_org_unit_ids"
        AND NEW."target_org_unit_ids" @> version."organization_scope_ids"
        AND cardinality(version."project_scope_ids") = 0
        AND cardinality(version."task_scope_ids") = 0
        AND version."data_labels" @> ARRAY(
          SELECT DISTINCT label
          FROM jsonb_array_elements_text(candidate_record."permission_labels") item(label)
        )
        AND ARRAY(
          SELECT DISTINCT label
          FROM jsonb_array_elements_text(candidate_record."permission_labels") item(label)
        ) @> version."data_labels"
      INTO version_ready, version_published, version_scope_matches
    FROM public."knowledge_document_versions" version
    JOIN public."knowledge_documents" document
      ON document."tenant_id" = version."tenant_id"
     AND document."knowledge_base_id" = version."knowledge_base_id"
     AND document."id" = version."document_id"
    WHERE version."tenant_id" = NEW."tenant_id"
      AND version."knowledge_base_id" = NEW."knowledge_base_id"
      AND version."document_id" = NEW."document_id"
      AND version."id" = NEW."document_version_id"
      AND version."version_number" = NEW."document_version";
    IF coalesce(version_scope_matches, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'EXPERIENCE_PROJECTION_KNOWLEDGE_SCOPE_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'READY' AND coalesce(version_ready, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'EXPERIENCE_PROJECTION_KNOWLEDGE_NOT_READY'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'PUBLISHED' AND coalesce(version_published, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'EXPERIENCE_PROJECTION_KNOWLEDGE_NOT_PUBLISHED'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."updated_at" := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "experience_knowledge_projections_guard_trigger"
  BEFORE INSERT OR UPDATE ON public."experience_knowledge_projections"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_knowledge_projection();

ALTER TABLE public."experience_knowledge_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."experience_knowledge_projections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation"
  ON public."experience_knowledge_projections"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "experience_knowledge_projections_admin_manage"
  ON public."experience_knowledge_projections"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

REVOKE ALL ON TABLE public."experience_knowledge_projections" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public."experience_knowledge_projections"
  TO enterprise_agent_admin;
REVOKE ALL ON FUNCTION public.guard_experience_knowledge_projection() FROM PUBLIC;

-- The original Experience foundation used a non-existent PUBLISHED enum value
-- for governed Knowledge Documents/Versions. Published knowledge is represented
-- by READY + current_version_id + published_at.
CREATE OR REPLACE FUNCTION public.guard_experience_validation_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  run_record public."agent_runs"%ROWTYPE;
  dataset_published boolean;
BEGIN
  SELECT * INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."experience_id";
  SELECT * INTO run_record
  FROM public."agent_runs"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."validation_run_id";
  SELECT EXISTS (
    SELECT 1
    FROM public."knowledge_document_versions" version
    JOIN public."knowledge_documents" document
      ON document."tenant_id" = version."tenant_id"
     AND document."knowledge_base_id" = version."knowledge_base_id"
     AND document."id" = version."document_id"
    WHERE version."tenant_id" = NEW."tenant_id"
      AND version."id" = NEW."dataset_version_id"
      AND version."status" = 'READY'
      AND version."published_at" IS NOT NULL
      AND version."governance_review_status" = 'APPROVED'
      AND version."checksum" IS NOT NULL
      AND version."evaluation_run_id" IS NOT NULL
      AND version."evaluation_dataset_version_id" IS NOT NULL
      AND version."evaluation_snapshot_hash" IS NOT NULL
      AND version."effective_from" <= statement_timestamp()
      AND (
        version."expires_at" IS NULL
        OR version."expires_at" > statement_timestamp()
      )
      AND document."status" = 'READY'
      AND document."current_version_id" = version."id"
  ) INTO dataset_published;
  IF candidate_record."id" IS NULL
     OR candidate_record."status" <> 'APPROVED'
     OR NEW."command_revision" <> candidate_record."revision" + 1
     OR NEW."validated_by_user_id" = candidate_record."contributor_user_id"
     OR NEW."validated_by_role_assignment_id" =
       candidate_record."contributor_role_assignment_id"
     OR run_record."id" IS NULL
     OR run_record."status" <> 'SUCCEEDED'
     OR run_record."usage_recorded_at" IS NULL
     OR run_record."total_tokens" <= 0
     OR dataset_published IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Experience validation requires an independent successful run and published dataset.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_validations_evidence_integrity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_experience_publication_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  projection_record public."experience_knowledge_projections"%ROWTYPE;
BEGIN
  SELECT * INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."experience_id";
  SELECT * INTO projection_record
  FROM public."experience_knowledge_projections"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "experience_id" = NEW."experience_id"
    AND "knowledge_base_id" = NEW."knowledge_base_id"
    AND "document_id" = NEW."document_id"
    AND "document_version_id" = NEW."document_version_id"
    AND "document_version" = NEW."document_version"
    AND "publication_hash" = NEW."publication_hash";
  IF candidate_record."id" IS NULL
     OR candidate_record."status" <> 'VALIDATED'
     OR NEW."command_revision" <> candidate_record."revision" + 1
     OR projection_record."id" IS NULL
     OR projection_record."status" <> 'PUBLISHED'
     OR NOT EXISTS (
       SELECT 1
       FROM public."knowledge_documents" document
       JOIN public."knowledge_document_versions" version
         ON version."tenant_id" = document."tenant_id"
        AND version."knowledge_base_id" = document."knowledge_base_id"
        AND version."document_id" = document."id"
        AND version."id" = NEW."document_version_id"
       WHERE document."tenant_id" = NEW."tenant_id"
         AND document."knowledge_base_id" = NEW."knowledge_base_id"
         AND document."id" = NEW."document_id"
         AND document."current_version_id" = NEW."document_version_id"
         AND document."document_version" = NEW."document_version"
         AND document."status" = 'READY'
         AND version."version_number" = NEW."document_version"
         AND version."status" = 'READY'
         AND version."published_at" IS NOT NULL
         AND version."governance_review_status" = 'APPROVED'
         AND version."checksum" IS NOT NULL
         AND btrim(version."checksum"::text) =
           btrim(NEW."publication_hash"::text)
         AND version."evaluation_run_id" IS NOT NULL
         AND version."evaluation_dataset_version_id" IS NOT NULL
         AND version."evaluation_snapshot_hash" IS NOT NULL
         AND version."effective_from" <= statement_timestamp()
         AND (
           version."expires_at" IS NULL
           OR version."expires_at" > statement_timestamp()
         )
     )
  THEN
    RAISE EXCEPTION 'Experience publication requires its exact prepared, evaluated and published Knowledge Version.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publications_knowledge_integrity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_experience_target_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  publication_record public."experience_publications"%ROWTYPE;
  candidate_record public."experience_candidates"%ROWTYPE;
  projection_record public."experience_knowledge_projections"%ROWTYPE;
BEGIN
  SELECT *
    INTO publication_record
  FROM public."experience_publications"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."publication_id";
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = publication_record."tenant_id"
    AND "id" = publication_record."experience_id";
  SELECT *
    INTO projection_record
  FROM public."experience_knowledge_projections"
  WHERE "tenant_id" = publication_record."tenant_id"
    AND "experience_id" = publication_record."experience_id"
    AND "knowledge_base_id" = publication_record."knowledge_base_id"
    AND "document_id" = publication_record."document_id"
    AND "document_version_id" = publication_record."document_version_id"
    AND "document_version" = publication_record."document_version"
    AND "publication_hash" = publication_record."publication_hash";
  IF publication_record."id" IS NULL
     OR candidate_record."id" IS NULL
     OR candidate_record."status" <> 'VALIDATED'
     OR publication_record."command_revision" <> candidate_record."revision" + 1
     OR projection_record."id" IS NULL
     OR projection_record."status" <> 'PUBLISHED'
  THEN
    RAISE EXCEPTION 'Experience publication target is not part of the exact governed projection.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publication_targets_projection_integrity';
  END IF;
  IF TG_TABLE_NAME = 'experience_publication_role_targets' THEN
    IF NOT NEW."role_template_id" = ANY(projection_record."target_role_template_ids") THEN
      RAISE EXCEPTION 'Experience role target is not part of the governed projection.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'experience_publication_role_target_projection_integrity';
    END IF;
  ELSIF TG_TABLE_NAME = 'experience_publication_org_targets' THEN
    IF NOT NEW."org_unit_id" = ANY(projection_record."target_org_unit_ids") THEN
      RAISE EXCEPTION 'Experience organization target is not part of the governed projection.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'experience_publication_org_target_projection_integrity';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported Experience publication target table.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_experience_projection_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  projection_record public."experience_knowledge_projections"%ROWTYPE;
  command_payload jsonb;
  role_targets uuid[];
  org_targets uuid[];
  command_role_targets uuid[];
  command_org_targets uuid[];
  payload_shape_valid boolean;
BEGIN
  SELECT *
    INTO projection_record
  FROM public."experience_knowledge_projections"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "experience_id" = NEW."experience_id"
    AND "knowledge_base_id" = NEW."knowledge_base_id"
    AND "document_id" = NEW."document_id"
    AND "document_version_id" = NEW."document_version_id"
    AND "document_version" = NEW."document_version"
    AND "publication_hash" = NEW."publication_hash";
  SELECT command."payload"
    INTO command_payload
  FROM public."experience_commands" command
  WHERE command."tenant_id" = NEW."tenant_id"
    AND command."experience_id" = NEW."experience_id"
    AND command."revision" = NEW."command_revision"
    AND command."action" = 'PUBLISH';
  payload_shape_valid :=
    command_payload IS NOT NULL
    AND jsonb_typeof(command_payload) = 'object'
    AND NULLIF(command_payload ->> 'knowledgeBaseId', '') IS NOT NULL
    AND NULLIF(command_payload ->> 'documentId', '') IS NOT NULL
    AND NULLIF(command_payload ->> 'documentVersionId', '') IS NOT NULL
    AND COALESCE(command_payload ->> 'documentVersion', '') ~ '^[1-9][0-9]*$'
    AND NULLIF(command_payload ->> 'publicationHash', '') IS NOT NULL
    AND jsonb_typeof(command_payload -> 'targetRoleTemplateIds') = 'array'
    AND jsonb_typeof(command_payload -> 'targetOrgUnitIds') = 'array';
  IF payload_shape_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Experience publication command payload is incomplete or malformed.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publication_projection_completeness';
  END IF;
  IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        command_payload -> 'targetRoleTemplateIds'
      ) item(value)
      WHERE value !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        command_payload -> 'targetOrgUnitIds'
      ) item(value)
      WHERE value !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    )
  THEN
    RAISE EXCEPTION 'Experience publication command targets are malformed.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publication_projection_completeness';
  END IF;
  SELECT coalesce(
    array_agg(target."role_template_id" ORDER BY target."role_template_id"),
    ARRAY[]::uuid[]
  )
    INTO role_targets
  FROM public."experience_publication_role_targets" target
  WHERE target."tenant_id" = NEW."tenant_id"
    AND target."publication_id" = NEW."id";
  SELECT coalesce(
    array_agg(target."org_unit_id" ORDER BY target."org_unit_id"),
    ARRAY[]::uuid[]
  )
    INTO org_targets
  FROM public."experience_publication_org_targets" target
  WHERE target."tenant_id" = NEW."tenant_id"
    AND target."publication_id" = NEW."id";
  SELECT ARRAY(
    SELECT DISTINCT value::uuid
    FROM jsonb_array_elements_text(command_payload -> 'targetRoleTemplateIds') item(value)
    ORDER BY value::uuid
  ) INTO command_role_targets;
  SELECT ARRAY(
    SELECT DISTINCT value::uuid
    FROM jsonb_array_elements_text(command_payload -> 'targetOrgUnitIds') item(value)
    ORDER BY value::uuid
  ) INTO command_org_targets;

  IF projection_record."id" IS NULL
     OR projection_record."status" <> 'PUBLISHED'
     OR role_targets IS DISTINCT FROM projection_record."target_role_template_ids"
     OR org_targets IS DISTINCT FROM projection_record."target_org_unit_ids"
     OR command_payload ->> 'knowledgeBaseId' IS DISTINCT FROM
       projection_record."knowledge_base_id"::text
     OR command_payload ->> 'documentId' IS DISTINCT FROM
       projection_record."document_id"::text
     OR command_payload ->> 'documentVersionId' IS DISTINCT FROM
       projection_record."document_version_id"::text
     OR (command_payload ->> 'documentVersion')::integer IS DISTINCT FROM
       projection_record."document_version"
     OR command_payload ->> 'publicationHash' IS DISTINCT FROM
       btrim(projection_record."publication_hash"::text)
     OR command_role_targets IS DISTINCT FROM projection_record."target_role_template_ids"
     OR command_org_targets IS DISTINCT FROM projection_record."target_org_unit_ids"
  THEN
    RAISE EXCEPTION 'Experience publication is incomplete or differs from its governed projection.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publication_projection_completeness';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "experience_publications_projection_completeness_trigger"
  AFTER INSERT ON public."experience_publications"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_experience_projection_publication();
REVOKE ALL ON FUNCTION public.validate_experience_projection_publication() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.retire_experience_knowledge_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" IN ('PUBLISHED', 'MONITORED')
     AND NEW."status" = 'RETIRED'
  THEN
    UPDATE public."knowledge_document_versions" version
    SET "status" = 'ARCHIVED'
    FROM public."experience_publications" publication
    WHERE publication."tenant_id" = NEW."tenant_id"
      AND publication."experience_id" = NEW."id"
      AND version."tenant_id" = publication."tenant_id"
      AND version."id" = publication."document_version_id"
      AND version."status" = 'READY';
    UPDATE public."knowledge_documents" document
    SET "status" = 'ARCHIVED', "updated_at" = statement_timestamp()
    FROM public."experience_publications" publication
    WHERE publication."tenant_id" = NEW."tenant_id"
      AND publication."experience_id" = NEW."id"
      AND document."tenant_id" = publication."tenant_id"
      AND document."id" = publication."document_id"
      AND document."status" = 'READY';
    UPDATE public."experience_knowledge_projections"
    SET "status" = 'RETIRED',
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "error_code" = NULL,
        "updated_at" = statement_timestamp()
    WHERE "tenant_id" = NEW."tenant_id"
      AND "experience_id" = NEW."id"
      AND "status" = 'PUBLISHED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "experience_candidates_retire_knowledge_trigger"
  AFTER UPDATE OF "status" ON public."experience_candidates"
  FOR EACH ROW EXECUTE FUNCTION public.retire_experience_knowledge_projection();
REVOKE ALL ON FUNCTION public.retire_experience_knowledge_projection() FROM PUBLIC;

COMMIT;
