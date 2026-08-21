-- Make long source-grounded retrieval benchmarks observable without weakening
-- the append-final result ledger. RUNNING rows may only advance their progress;
-- terminal metrics and per-case results remain immutable.

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  ADD COLUMN "processed_case_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "total_case_count" integer NOT NULL DEFAULT 0;

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  DISABLE TRIGGER "ai_knowledge_retrieval_benchmark_runs_guard";
ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  DISABLE TRIGGER "ai_knowledge_retrieval_benchmark_runs_side_effects";

UPDATE public."ai_knowledge_retrieval_benchmark_runs"
SET "total_case_count" = GREATEST(
      jsonb_array_length("case_results"),
      COALESCE(("metrics" ->> 'evaluatedCaseCount')::integer, 0)
    ),
    "processed_case_count" = GREATEST(
      jsonb_array_length("case_results"),
      COALESCE(("metrics" ->> 'evaluatedCaseCount')::integer, 0)
    );

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  ENABLE TRIGGER "ai_knowledge_retrieval_benchmark_runs_guard";
ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  ENABLE TRIGGER "ai_knowledge_retrieval_benchmark_runs_side_effects";

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  ADD CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_progress_check"
  CHECK (
    "total_case_count" BETWEEN 0 AND 500
    AND "processed_case_count" BETWEEN 0 AND "total_case_count"
  );

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  DROP CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_completion_check";

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs"
  ADD CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_completion_check"
  CHECK (
    ("status" = 'RUNNING' AND "metrics" IS NULL AND "finished_at" IS NULL)
    OR
    (
      "status" IN ('PASSED', 'FAILED')
      AND "finished_at" IS NOT NULL
      AND ("status" = 'FAILED' OR "metrics" IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION public.guard_ai_knowledge_retrieval_benchmark_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Knowledge Retrieval Benchmark Runs are append-only.';
  END IF;
  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'Completed Knowledge Retrieval Benchmark Runs are immutable.';
  END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."dataset_version_id" <> OLD."dataset_version_id"
     OR NEW."dataset_content_hash" <> OLD."dataset_content_hash"
     OR NEW."thresholds" <> OLD."thresholds"
     OR NEW."requested_by_user_id" <> OLD."requested_by_user_id"
     OR NEW."idempotency_key" <> OLD."idempotency_key"
     OR NEW."request_hash" <> OLD."request_hash"
     OR NEW."started_at" <> OLD."started_at"
     OR NEW."created_at" <> OLD."created_at"
     OR NEW."total_case_count" <> OLD."total_case_count"
  THEN
    RAISE EXCEPTION 'Knowledge Retrieval Benchmark Run identity is immutable.';
  END IF;
  IF NEW."status" = 'RUNNING' THEN
    IF NEW."processed_case_count" <= OLD."processed_case_count"
       OR NEW."metrics" IS DISTINCT FROM OLD."metrics"
       OR NEW."failures" <> OLD."failures"
       OR NEW."case_results" <> OLD."case_results"
       OR NEW."finished_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'A running benchmark may only advance its progress.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" NOT IN ('PASSED', 'FAILED')
     OR NEW."processed_case_count" < OLD."processed_case_count"
  THEN
    RAISE EXCEPTION 'Only RUNNING to PASSED/FAILED result completion is allowed.';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER "ai_knowledge_retrieval_benchmark_runs_side_effects"
  ON public."ai_knowledge_retrieval_benchmark_runs";

CREATE TRIGGER "ai_knowledge_retrieval_benchmark_runs_side_effects"
  AFTER INSERT OR UPDATE OF "status"
  ON public."ai_knowledge_retrieval_benchmark_runs"
  FOR EACH ROW EXECUTE FUNCTION public.ai_evaluation_append_side_effects();
