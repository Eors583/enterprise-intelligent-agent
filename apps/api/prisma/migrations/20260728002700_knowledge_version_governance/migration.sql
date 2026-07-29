BEGIN;

ALTER TABLE public."knowledge_document_versions"
  ADD COLUMN "governance_owner_user_id" uuid,
  ADD COLUMN "classification" varchar(32) NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN "scope_mode" varchar(32) NOT NULL DEFAULT 'TENANT',
  ADD COLUMN "organization_scope_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN "project_scope_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN "task_scope_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN "role_template_scope_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN "data_labels" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "effective_from" timestamptz(6),
  ADD COLUMN "expires_at" timestamptz(6),
  ADD COLUMN "retention_until" timestamptz(6),
  ADD COLUMN "retention_action" varchar(32) NOT NULL DEFAULT 'ARCHIVE',
  ADD COLUMN "supersedes_version_id" uuid,
  ADD COLUMN "governance_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "governance_review_status" varchar(32) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "governance_reviewed_by_id" uuid,
  ADD COLUMN "governance_reviewed_at" timestamptz(6),
  ADD COLUMN "governance_review_note" varchar(2000),
  ADD COLUMN "governance_hash" char(64) NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';

UPDATE public."knowledge_document_versions"
SET
  "governance_owner_user_id" = "created_by_id",
  "effective_from" = "created_at",
  "governance_review_status" =
    CASE WHEN "published_at" IS NULL THEN 'PENDING' ELSE 'MIGRATED' END;

ALTER TABLE public."knowledge_document_versions"
  ALTER COLUMN "governance_owner_user_id" SET NOT NULL,
  ALTER COLUMN "effective_from" SET NOT NULL,
  ALTER COLUMN "effective_from" SET DEFAULT now();

CREATE OR REPLACE FUNCTION public.knowledge_governance_uuid_array_valid(values_to_check uuid[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    array_position(values_to_check, NULL) IS NULL
    AND cardinality(values_to_check) = (
      SELECT count(DISTINCT value)::integer
      FROM unnest(values_to_check) AS item(value)
    )
$$;

CREATE OR REPLACE FUNCTION public.knowledge_governance_text_array_valid(values_to_check text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT
    array_position(values_to_check, NULL) IS NULL
    AND cardinality(values_to_check) = (
      SELECT count(DISTINCT btrim(value))::integer
      FROM unnest(values_to_check) AS item(value)
      WHERE btrim(value) <> ''
    )
$$;

CREATE OR REPLACE FUNCTION public.knowledge_document_version_governance_hash(
  owner_user_id uuid,
  classification_value text,
  scope_mode_value text,
  organization_ids uuid[],
  project_ids uuid[],
  task_ids uuid[],
  role_template_ids uuid[],
  labels text[],
  effective_from_value timestamptz,
  expires_at_value timestamptz,
  retention_until_value timestamptz,
  retention_action_value text,
  supersedes_version_id_value uuid
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(
    digest(
      concat_ws(
        '|',
        owner_user_id::text,
        classification_value,
        scope_mode_value,
        array_to_string(organization_ids, ','),
        array_to_string(project_ids, ','),
        array_to_string(task_ids, ','),
        array_to_string(role_template_ids, ','),
        array_to_string(labels, ','),
        to_char(effective_from_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        coalesce(
          to_char(expires_at_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'NULL'
        ),
        coalesce(
          to_char(retention_until_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'NULL'
        ),
        retention_action_value,
        coalesce(supersedes_version_id_value::text, 'NULL')
      ),
      'sha256'
    ),
    'hex'
  )
$$;

UPDATE public."knowledge_document_versions"
SET "governance_hash" = public.knowledge_document_version_governance_hash(
  "governance_owner_user_id",
  "classification",
  "scope_mode",
  "organization_scope_ids",
  "project_scope_ids",
  "task_scope_ids",
  "role_template_scope_ids",
  "data_labels",
  "effective_from",
  "expires_at",
  "retention_until",
  "retention_action",
  "supersedes_version_id"
);

ALTER TABLE public."knowledge_document_versions"
  ADD CONSTRAINT "knowledge_document_versions_governance_owner_fkey"
    FOREIGN KEY ("tenant_id", "governance_owner_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_document_versions_governance_reviewer_fkey"
    FOREIGN KEY ("tenant_id", "governance_reviewed_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_document_versions_supersedes_fkey"
    FOREIGN KEY ("tenant_id", "document_id", "supersedes_version_id")
    REFERENCES public."knowledge_document_versions"("tenant_id", "document_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_document_versions_classification_check"
    CHECK ("classification" IN ('PUBLIC', 'INTERNAL', 'SENSITIVE', 'CONFIDENTIAL')),
  ADD CONSTRAINT "knowledge_document_versions_scope_mode_check"
    CHECK ("scope_mode" IN ('TENANT', 'RESTRICTED')),
  ADD CONSTRAINT "knowledge_document_versions_retention_action_check"
    CHECK ("retention_action" IN ('ARCHIVE', 'REVIEW_DELETE', 'LEGAL_HOLD')),
  ADD CONSTRAINT "knowledge_document_versions_governance_review_status_check"
    CHECK ("governance_review_status" IN ('PENDING', 'APPROVED', 'REJECTED', 'MIGRATED')),
  ADD CONSTRAINT "knowledge_document_versions_governance_revision_check"
    CHECK ("governance_revision" > 0),
  ADD CONSTRAINT "knowledge_document_versions_governance_hash_check"
    CHECK ("governance_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "knowledge_document_versions_governance_uuid_arrays_check"
    CHECK (
      public.knowledge_governance_uuid_array_valid("organization_scope_ids")
      AND public.knowledge_governance_uuid_array_valid("project_scope_ids")
      AND public.knowledge_governance_uuid_array_valid("task_scope_ids")
      AND public.knowledge_governance_uuid_array_valid("role_template_scope_ids")
    ),
  ADD CONSTRAINT "knowledge_document_versions_governance_labels_check"
    CHECK (public.knowledge_governance_text_array_valid("data_labels")),
  ADD CONSTRAINT "knowledge_document_versions_governance_scope_check"
    CHECK (
      (
        "scope_mode" = 'TENANT'
        AND cardinality("organization_scope_ids") = 0
        AND cardinality("project_scope_ids") = 0
        AND cardinality("task_scope_ids") = 0
        AND cardinality("role_template_scope_ids") = 0
        AND cardinality("data_labels") = 0
        AND "classification" IN ('PUBLIC', 'INTERNAL')
      )
      OR
      (
        "scope_mode" = 'RESTRICTED'
        AND (
          cardinality("organization_scope_ids") > 0
          OR cardinality("project_scope_ids") > 0
          OR cardinality("task_scope_ids") > 0
          OR cardinality("role_template_scope_ids") > 0
          OR cardinality("data_labels") > 0
        )
      )
    ),
  ADD CONSTRAINT "knowledge_document_versions_governance_time_check"
    CHECK (
      ("expires_at" IS NULL OR "expires_at" > "effective_from")
      AND ("retention_until" IS NULL OR "retention_until" >= "effective_from")
    ),
  ADD CONSTRAINT "knowledge_document_versions_governance_review_shape_check"
    CHECK (
      (
        "governance_review_status" = 'PENDING'
        AND "governance_reviewed_by_id" IS NULL
        AND "governance_reviewed_at" IS NULL
        AND "governance_review_note" IS NULL
      )
      OR
      (
        "governance_review_status" = 'MIGRATED'
        AND "governance_reviewed_by_id" IS NULL
        AND "governance_reviewed_at" IS NULL
      )
      OR
      (
        "governance_review_status" IN ('APPROVED', 'REJECTED')
        AND "governance_reviewed_by_id" IS NOT NULL
        AND "governance_reviewed_at" IS NOT NULL
        AND "governance_reviewed_by_id" <> "created_by_id"
        AND "governance_reviewed_by_id" <> "governance_owner_user_id"
        AND (
          "governance_review_status" <> 'REJECTED'
          OR nullif(btrim("governance_review_note"), '') IS NOT NULL
        )
      )
    );

CREATE OR REPLACE FUNCTION public.knowledge_document_version_governance_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  policy_changed boolean := false;
  review_changed boolean := false;
BEGIN
  -- Preserve legacy/low-level creation paths while still producing a complete,
  -- tenant-scoped policy. The composite owner FK is checked after this trigger.
  IF NEW."governance_owner_user_id" IS NULL THEN
    NEW."governance_owner_user_id" := NEW."created_by_id";
  END IF;

  NEW."organization_scope_ids" := ARRAY(
    SELECT DISTINCT value
    FROM unnest(NEW."organization_scope_ids") AS item(value)
    ORDER BY value
  );
  NEW."project_scope_ids" := ARRAY(
    SELECT DISTINCT value
    FROM unnest(NEW."project_scope_ids") AS item(value)
    ORDER BY value
  );
  NEW."task_scope_ids" := ARRAY(
    SELECT DISTINCT value
    FROM unnest(NEW."task_scope_ids") AS item(value)
    ORDER BY value
  );
  NEW."role_template_scope_ids" := ARRAY(
    SELECT DISTINCT value
    FROM unnest(NEW."role_template_scope_ids") AS item(value)
    ORDER BY value
  );
  NEW."data_labels" := ARRAY(
    SELECT DISTINCT btrim(value)
    FROM unnest(NEW."data_labels") AS item(value)
    WHERE btrim(value) <> ''
    ORDER BY btrim(value)
  );

  IF TG_OP = 'INSERT' THEN
    IF NEW."governance_review_status" <> 'PENDING' THEN
      RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_INITIAL_REVIEW_STATUS_INVALID'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."governance_revision" <> 1 THEN
      RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_INITIAL_REVISION_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    policy_changed :=
      NEW."governance_owner_user_id" IS DISTINCT FROM OLD."governance_owner_user_id"
      OR NEW."classification" IS DISTINCT FROM OLD."classification"
      OR NEW."scope_mode" IS DISTINCT FROM OLD."scope_mode"
      OR NEW."organization_scope_ids" IS DISTINCT FROM OLD."organization_scope_ids"
      OR NEW."project_scope_ids" IS DISTINCT FROM OLD."project_scope_ids"
      OR NEW."task_scope_ids" IS DISTINCT FROM OLD."task_scope_ids"
      OR NEW."role_template_scope_ids" IS DISTINCT FROM OLD."role_template_scope_ids"
      OR NEW."data_labels" IS DISTINCT FROM OLD."data_labels"
      OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."retention_until" IS DISTINCT FROM OLD."retention_until"
      OR NEW."retention_action" IS DISTINCT FROM OLD."retention_action"
      OR NEW."supersedes_version_id" IS DISTINCT FROM OLD."supersedes_version_id";
    review_changed :=
      NEW."governance_review_status" IS DISTINCT FROM OLD."governance_review_status"
      OR NEW."governance_reviewed_by_id" IS DISTINCT FROM OLD."governance_reviewed_by_id"
      OR NEW."governance_reviewed_at" IS DISTINCT FROM OLD."governance_reviewed_at"
      OR NEW."governance_review_note" IS DISTINCT FROM OLD."governance_review_note";

    IF OLD."published_at" IS NOT NULL AND (policy_changed OR review_changed) THEN
      RAISE EXCEPTION 'KNOWLEDGE_PUBLISHED_GOVERNANCE_IMMUTABLE'
        USING ERRCODE = '23514';
    END IF;
    IF policy_changed THEN
      IF NEW."governance_revision" <> OLD."governance_revision" + 1 THEN
        RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_POLICY_REVISION_CONFLICT'
          USING ERRCODE = '40001';
      END IF;
      NEW."governance_review_status" := 'PENDING';
      NEW."governance_reviewed_by_id" := NULL;
      NEW."governance_reviewed_at" := NULL;
      NEW."governance_review_note" := NULL;
    ELSIF review_changed THEN
      IF NEW."governance_revision" <> OLD."governance_revision" + 1 THEN
        RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_REVIEW_REVISION_CONFLICT'
          USING ERRCODE = '40001';
      END IF;
      IF OLD."governance_review_status" <> 'PENDING' THEN
        RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_REVIEW_ALREADY_DECIDED'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."governance_revision" <> OLD."governance_revision" THEN
      RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_REVISION_WITHOUT_CHANGE'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."supersedes_version_id" = NEW."id" THEN
    RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_SELF_SUPERSESSION'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."governance_review_status" = 'PENDING' THEN
    NEW."governance_reviewed_by_id" := NULL;
    NEW."governance_reviewed_at" := NULL;
    NEW."governance_review_note" := NULL;
  END IF;
  IF
    NEW."published_at" IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD."published_at" IS NULL)
    AND NEW."governance_review_status" <> 'APPROVED'
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_APPROVAL_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  IF
    NEW."published_at" IS NOT NULL
    AND (
      NEW."effective_from" > NEW."published_at"
      OR (NEW."expires_at" IS NOT NULL AND NEW."expires_at" <= NEW."published_at")
    )
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_GOVERNANCE_NOT_EFFECTIVE_AT_PUBLICATION'
      USING ERRCODE = '23514';
  END IF;

  NEW."governance_hash" := public.knowledge_document_version_governance_hash(
    NEW."governance_owner_user_id",
    NEW."classification",
    NEW."scope_mode",
    NEW."organization_scope_ids",
    NEW."project_scope_ids",
    NEW."task_scope_ids",
    NEW."role_template_scope_ids",
    NEW."data_labels",
    NEW."effective_from",
    NEW."expires_at",
    NEW."retention_until",
    NEW."retention_action",
    NEW."supersedes_version_id"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_document_versions_governance_guard"
BEFORE INSERT OR UPDATE ON public."knowledge_document_versions"
FOR EACH ROW
EXECUTE FUNCTION public.knowledge_document_version_governance_guard();

CREATE INDEX "knowledge_document_versions_governance_review_idx"
  ON public."knowledge_document_versions" (
    "tenant_id", "governance_review_status", "created_at", "id"
  );
CREATE INDEX "knowledge_document_versions_governance_expiry_idx"
  ON public."knowledge_document_versions" (
    "tenant_id", "expires_at", "retention_until"
  );
CREATE INDEX "knowledge_document_versions_governance_org_scope_idx"
  ON public."knowledge_document_versions"
  USING gin ("organization_scope_ids");
CREATE INDEX "knowledge_document_versions_governance_project_scope_idx"
  ON public."knowledge_document_versions"
  USING gin ("project_scope_ids");
CREATE INDEX "knowledge_document_versions_governance_task_scope_idx"
  ON public."knowledge_document_versions"
  USING gin ("task_scope_ids");
CREATE INDEX "knowledge_document_versions_governance_role_scope_idx"
  ON public."knowledge_document_versions"
  USING gin ("role_template_scope_ids");
CREATE INDEX "knowledge_document_versions_governance_label_idx"
  ON public."knowledge_document_versions"
  USING gin ("data_labels");

REVOKE ALL ON FUNCTION public.knowledge_governance_uuid_array_valid(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_governance_text_array_valid(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_document_version_governance_hash(
  uuid, text, text, uuid[], uuid[], uuid[], uuid[], text[],
  timestamptz, timestamptz, timestamptz, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_document_version_governance_guard() FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'enterprise_agent_app',
    'enterprise_agent_admin',
    'enterprise_agent_process'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.knowledge_governance_uuid_array_valid(uuid[]) TO %I',
        role_name
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.knowledge_governance_text_array_valid(text[]) TO %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
