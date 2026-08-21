-- Initial Agent + Knowledge validation must not depend on maker-checker or
-- evaluation release gates. Keep the governance columns for later production
-- rollout, but make them diagnostic/optional for publication.

CREATE OR REPLACE FUNCTION public.enforce_governed_agent_version_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.enforce_governed_agent_template_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

-- Retain policy normalization, revision CAS, immutable published policy and
-- governance hashing. Only the approval/effective-time publication gates are
-- removed for the initial functional-validation phase.
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
