-- Persist live, ground-truth-based knowledge retrieval benchmarks separately from
-- model-output evaluation Runs. The benchmark is synchronous, tenant isolated,
-- idempotent, append-final after completion, and emits the standard AI evaluation
-- audit/outbox side effects.

CREATE TABLE public."ai_knowledge_retrieval_benchmark_runs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "dataset_version_id" uuid NOT NULL,
  "dataset_content_hash" char(64) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'RUNNING',
  "thresholds" jsonb NOT NULL,
  "metrics" jsonb,
  "failures" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "case_results" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "requested_by_user_id" uuid NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "started_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_status_check"
    CHECK ("status" IN ('RUNNING', 'PASSED', 'FAILED')),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_hashes_check"
    CHECK (
      "dataset_content_hash" ~ '^[a-f0-9]{64}$'
      AND "request_hash" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_json_check"
    CHECK (
      jsonb_typeof("thresholds") = 'object'
      AND ("metrics" IS NULL OR jsonb_typeof("metrics") = 'object')
      AND jsonb_typeof("failures") = 'array'
      AND jsonb_typeof("case_results") = 'array'
      AND jsonb_array_length("case_results") <= 500
    ),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_completion_check"
    CHECK (
      ("status" = 'RUNNING' AND "metrics" IS NULL AND "finished_at" IS NULL)
      OR
      ("status" IN ('PASSED', 'FAILED') AND "metrics" IS NOT NULL AND "finished_at" IS NOT NULL)
    ),
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_dataset_fkey"
    FOREIGN KEY ("tenant_id", "dataset_version_id")
    REFERENCES public."ai_evaluation_dataset_versions" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_knowledge_retrieval_benchmark_runs_requester_fkey"
    FOREIGN KEY ("tenant_id", "requested_by_user_id")
    REFERENCES public."users" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ai_knowledge_retrieval_benchmark_runs_version_created_idx"
  ON public."ai_knowledge_retrieval_benchmark_runs"
  ("tenant_id", "dataset_version_id", "created_at" DESC, "id");

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
  IF NEW."status" NOT IN ('PASSED', 'FAILED')
     OR NEW."id" <> OLD."id"
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."dataset_version_id" <> OLD."dataset_version_id"
     OR NEW."dataset_content_hash" <> OLD."dataset_content_hash"
     OR NEW."thresholds" <> OLD."thresholds"
     OR NEW."requested_by_user_id" <> OLD."requested_by_user_id"
     OR NEW."idempotency_key" <> OLD."idempotency_key"
     OR NEW."request_hash" <> OLD."request_hash"
     OR NEW."started_at" <> OLD."started_at"
     OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'Only RUNNING to PASSED/FAILED result completion is allowed.';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ai_knowledge_retrieval_benchmark_runs_guard"
  BEFORE UPDATE OR DELETE ON public."ai_knowledge_retrieval_benchmark_runs"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_knowledge_retrieval_benchmark_run();

CREATE TRIGGER "ai_knowledge_retrieval_benchmark_runs_side_effects"
  AFTER INSERT OR UPDATE ON public."ai_knowledge_retrieval_benchmark_runs"
  FOR EACH ROW EXECUTE FUNCTION public.ai_evaluation_append_side_effects();

ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ai_knowledge_retrieval_benchmark_tenant_isolation"
  ON public."ai_knowledge_retrieval_benchmark_runs"
  AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "ai_knowledge_retrieval_benchmark_admin_access"
  ON public."ai_knowledge_retrieval_benchmark_runs"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public."ai_knowledge_retrieval_benchmark_runs"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin, enterprise_agent_evaluation_runner;
GRANT SELECT, INSERT, UPDATE ON TABLE public."ai_knowledge_retrieval_benchmark_runs"
  TO enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.guard_ai_knowledge_retrieval_benchmark_run() FROM PUBLIC;
