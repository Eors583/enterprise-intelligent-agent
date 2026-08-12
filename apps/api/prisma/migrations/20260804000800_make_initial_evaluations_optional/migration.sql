-- Evaluation remains available as an optional quality diagnostic, but initial
-- Agent + Knowledge publication must not require a passing Evaluation Run.
-- Keep any attached evaluation references immutable outside publication.

CREATE OR REPLACE FUNCTION public.agent_version_evaluation_publication_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  is_publish_transition boolean;
BEGIN
  is_publish_transition := OLD."status" <> 'PUBLISHED' AND NEW."status" = 'PUBLISHED';

  IF (
    NEW."evaluation_run_id" IS DISTINCT FROM OLD."evaluation_run_id"
    OR NEW."evaluation_dataset_version_id"
      IS DISTINCT FROM OLD."evaluation_dataset_version_id"
    OR NEW."evaluation_snapshot_hash" IS DISTINCT FROM OLD."evaluation_snapshot_hash"
  ) AND NOT is_publish_transition THEN
    RAISE EXCEPTION 'Agent Version evaluation references are immutable outside publication.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_versions_evaluation_reference_immutable';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.knowledge_version_evaluation_publication_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  is_publish_transition boolean;
BEGIN
  is_publish_transition := OLD."published_at" IS NULL AND NEW."published_at" IS NOT NULL;

  IF (
    NEW."evaluation_run_id" IS DISTINCT FROM OLD."evaluation_run_id"
    OR NEW."evaluation_dataset_version_id"
      IS DISTINCT FROM OLD."evaluation_dataset_version_id"
    OR NEW."evaluation_snapshot_hash" IS DISTINCT FROM OLD."evaluation_snapshot_hash"
  ) AND NOT is_publish_transition THEN
    RAISE EXCEPTION 'Knowledge Version evaluation references are immutable outside publication.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'knowledge_document_versions_evaluation_reference_immutable';
  END IF;

  RETURN NEW;
END
$$;
