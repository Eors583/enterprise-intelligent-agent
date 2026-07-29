BEGIN;

-- Manual governance conflicts use the same projection lifecycle as extractor
-- schema gaps. Resolve the one active evidence snapshot at insert time so a
-- current conflict cannot be silently ignored by the trusted retrieval view.
CREATE OR REPLACE FUNCTION public.knowledge_graph_conflict_bind_active_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  matched_projection_count integer := 0;
  matched_projection_id uuid;
  matched_document_version_id uuid;
BEGIN
  IF NEW."projection_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."target_type" = 'RELATION' THEN
    SELECT
      count(*) OVER (),
      candidate."projection_id",
      candidate."document_version_id"
    INTO
      matched_projection_count,
      matched_projection_id,
      matched_document_version_id
    FROM (
      SELECT DISTINCT
        projection."id" AS projection_id,
        projection."document_version_id"
      FROM public."knowledge_relation_evidence" evidence
      JOIN public."knowledge_graph_projections" projection
        ON projection."tenant_id" = evidence."tenant_id"
       AND projection."knowledge_base_id" = evidence."knowledge_base_id"
       AND projection."id" = evidence."projection_id"
       AND projection."status" = 'ACTIVE'
      WHERE evidence."tenant_id" = NEW."tenant_id"
        AND evidence."knowledge_base_id" = NEW."knowledge_base_id"
        AND evidence."relation_id" = NEW."target_id"
    ) candidate
    ORDER BY candidate."projection_id"
    LIMIT 1;
  ELSE
    SELECT
      count(*) OVER (),
      candidate."projection_id",
      candidate."document_version_id"
    INTO
      matched_projection_count,
      matched_projection_id,
      matched_document_version_id
    FROM (
      SELECT DISTINCT
        projection."id" AS projection_id,
        projection."document_version_id"
      FROM public."knowledge_entity_mentions" mention
      JOIN public."knowledge_graph_projections" projection
        ON projection."tenant_id" = mention."tenant_id"
       AND projection."knowledge_base_id" = mention."knowledge_base_id"
       AND projection."id" = mention."projection_id"
       AND projection."status" = 'ACTIVE'
      WHERE mention."tenant_id" = NEW."tenant_id"
        AND mention."knowledge_base_id" = NEW."knowledge_base_id"
        AND mention."entity_id" = NEW."target_id"
    ) candidate
    ORDER BY candidate."projection_id"
    LIMIT 1;
  END IF;

  IF coalesce(matched_projection_count, 0) = 0 THEN
    RAISE EXCEPTION
      'Graph Conflict requires target evidence in one active projection'
      USING ERRCODE = '23514';
  END IF;
  IF matched_projection_count <> 1 THEN
    RAISE EXCEPTION
      'Graph Conflict target is ambiguous across active projections'
      USING ERRCODE = '23514';
  END IF;

  NEW."projection_id" := matched_projection_id;
  NEW."document_version_id" := matched_document_version_id;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS knowledge_graph_conflict_projection_bind_trigger
  ON public."knowledge_graph_conflicts";
CREATE TRIGGER knowledge_graph_conflict_projection_bind_trigger
  BEFORE INSERT
  ON public."knowledge_graph_conflicts"
  FOR EACH ROW
  EXECUTE FUNCTION public.knowledge_graph_conflict_bind_active_projection();

REVOKE ALL ON FUNCTION public.knowledge_graph_conflict_bind_active_projection()
  FROM PUBLIC;

COMMIT;
