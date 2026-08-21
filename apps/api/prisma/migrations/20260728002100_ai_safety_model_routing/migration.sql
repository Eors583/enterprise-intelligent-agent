BEGIN;

CREATE TYPE public."AiGovernanceStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED'
);
CREATE TYPE public."AiDataClassification" AS ENUM (
  'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
);
CREATE TYPE public."AiModelProvider" AS ENUM (
  'OPENAI_COMPATIBLE', 'MANUS'
);
CREATE TYPE public."AiModelAttemptPhase" AS ENUM (
  'STARTED', 'TERMINAL'
);
CREATE TYPE public."AiModelAttemptOutcome" AS ENUM (
  'STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REJECTED'
);
CREATE TYPE public."AiModelCircuitState" AS ENUM (
  'CLOSED', 'OPEN', 'HALF_OPEN'
);
CREATE TYPE public."AiSafetyDirection" AS ENUM (
  'INPUT', 'OUTPUT'
);
CREATE TYPE public."AiSafetyAction" AS ENUM (
  'ALLOW', 'REDACT', 'BLOCK'
);

CREATE TABLE public."ai_model_catalog_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "route_key" VARCHAR(120) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" public."AiGovernanceStatus" NOT NULL DEFAULT 'DRAFT',
  "provider" public."AiModelProvider" NOT NULL,
  "model_name" VARCHAR(256) NOT NULL,
  "credential_reference" VARCHAR(300) NOT NULL,
  "data_residency" VARCHAR(80) NOT NULL,
  "maximum_classification" public."AiDataClassification" NOT NULL,
  "capabilities" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "max_context_tokens" INTEGER NOT NULL,
  "max_output_tokens" INTEGER NOT NULL,
  "input_cost_micros_per_million" BIGINT NOT NULL,
  "output_cost_micros_per_million" BIGINT NOT NULL,
  "p95_latency_ms" INTEGER NOT NULL,
  "configuration_hash" CHAR(64) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "submitted_by_user_id" UUID,
  "submitted_at" TIMESTAMPTZ(6),
  "reviewed_by_user_id" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "published_by_user_id" UUID,
  "published_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_model_catalog_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_model_catalog_versions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_model_catalog_versions_tenant_route_version_key"
    UNIQUE ("tenant_id", "route_key", "version"),
  CONSTRAINT "ai_model_catalog_versions_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "ai_model_catalog_versions_shape_check" CHECK (
    "route_key" ~ '^[A-Z0-9][A-Z0-9._-]{0,119}$'
    AND "version" > 0 AND "revision" > 0
    AND length(btrim("model_name")) BETWEEN 1 AND 256
    -- PostgreSQL ARE bounds cannot exceed 255. Keep the character allowlist
    -- unbounded in the expression and enforce the exact storage bound with
    -- length instead.
    AND "credential_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
    AND length("credential_reference") BETWEEN 1 AND 300
    AND lower("credential_reference") !~ '(secret|token|key)='
    AND length(btrim("data_residency")) BETWEEN 2 AND 80
    AND jsonb_typeof("capabilities") = 'array'
    AND jsonb_array_length("capabilities") BETWEEN 1 AND 32
    AND "max_context_tokens" BETWEEN 1 AND 2000000
    AND "max_output_tokens" BETWEEN 1 AND 200000
    AND "input_cost_micros_per_million" >= 0
    AND "output_cost_micros_per_million" >= 0
    AND "p95_latency_ms" BETWEEN 1 AND 3600000
    AND "configuration_hash" ~ '^[a-f0-9]{64}$'
    AND "request_hash" ~ '^[a-f0-9]{64}$'
    AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "ai_model_catalog_versions_workflow_check" CHECK (
    (
      "status" = 'DRAFT'
      OR ("submitted_by_user_id" IS NOT NULL AND "submitted_at" IS NOT NULL)
    )
    AND (
      "status" NOT IN ('PUBLISHED', 'RETIRED')
      OR (
        "reviewed_by_user_id" IS NOT NULL
        AND "reviewed_at" IS NOT NULL
        AND "published_by_user_id" IS NOT NULL
        AND "published_at" IS NOT NULL
        AND "reviewed_by_user_id" <> "submitted_by_user_id"
        AND "published_by_user_id" <> "submitted_by_user_id"
      )
    )
    AND ("status" = 'RETIRED') = ("retired_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ai_model_catalog_versions_one_published_route_idx"
  ON public."ai_model_catalog_versions" ("tenant_id", "route_key")
  WHERE "status" = 'PUBLISHED';
CREATE INDEX "ai_model_catalog_versions_readiness_idx"
  ON public."ai_model_catalog_versions" ("tenant_id", "status", "provider", "route_key");

CREATE TABLE public."ai_model_route_policy_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "task_class" VARCHAR(120) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" public."AiGovernanceStatus" NOT NULL DEFAULT 'DRAFT',
  "allowed_residencies" JSONB NOT NULL,
  "maximum_classification" public."AiDataClassification" NOT NULL,
  "required_capabilities" JSONB NOT NULL,
  "max_p95_latency_ms" INTEGER NOT NULL,
  "max_input_cost_micros_per_million" BIGINT NOT NULL,
  "max_output_cost_micros_per_million" BIGINT NOT NULL,
  "maximum_attempts" INTEGER NOT NULL DEFAULT 1,
  "circuit_failure_threshold" INTEGER NOT NULL DEFAULT 5,
  "circuit_open_seconds" INTEGER NOT NULL DEFAULT 60,
  "policy_hash" CHAR(64) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "submitted_by_user_id" UUID,
  "submitted_at" TIMESTAMPTZ(6),
  "reviewed_by_user_id" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "published_by_user_id" UUID,
  "published_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_model_route_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_model_route_policy_versions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_model_route_policy_versions_tenant_task_version_key"
    UNIQUE ("tenant_id", "task_class", "version"),
  CONSTRAINT "ai_model_route_policy_versions_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "ai_model_route_policy_versions_shape_check" CHECK (
    "task_class" ~ '^[A-Z0-9][A-Z0-9._-]{0,119}$'
    AND "version" > 0 AND "revision" > 0
    AND jsonb_typeof("allowed_residencies") = 'array'
    AND jsonb_array_length("allowed_residencies") BETWEEN 1 AND 32
    AND jsonb_typeof("required_capabilities") = 'array'
    AND jsonb_array_length("required_capabilities") BETWEEN 1 AND 32
    AND "max_p95_latency_ms" BETWEEN 1 AND 3600000
    AND "max_input_cost_micros_per_million" >= 0
    AND "max_output_cost_micros_per_million" >= 0
    AND "maximum_attempts" BETWEEN 1 AND 3
    AND "circuit_failure_threshold" BETWEEN 1 AND 100
    AND "circuit_open_seconds" BETWEEN 1 AND 86400
    AND "policy_hash" ~ '^[a-f0-9]{64}$'
    AND "request_hash" ~ '^[a-f0-9]{64}$'
    AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "ai_model_route_policy_versions_workflow_check" CHECK (
    (
      "status" = 'DRAFT'
      OR ("submitted_by_user_id" IS NOT NULL AND "submitted_at" IS NOT NULL)
    )
    AND (
      "status" NOT IN ('PUBLISHED', 'RETIRED')
      OR (
        "reviewed_by_user_id" IS NOT NULL
        AND "reviewed_at" IS NOT NULL
        AND "published_by_user_id" IS NOT NULL
        AND "published_at" IS NOT NULL
        AND "reviewed_by_user_id" <> "submitted_by_user_id"
        AND "published_by_user_id" <> "submitted_by_user_id"
      )
    )
    AND ("status" = 'RETIRED') = ("retired_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ai_model_route_policy_versions_one_published_task_idx"
  ON public."ai_model_route_policy_versions" ("tenant_id", "task_class")
  WHERE "status" = 'PUBLISHED';

CREATE TABLE public."ai_model_route_candidates" (
  "tenant_id" UUID NOT NULL,
  "policy_version_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "catalog_version_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_model_route_candidates_pkey"
    PRIMARY KEY ("tenant_id", "policy_version_id", "ordinal"),
  CONSTRAINT "ai_model_route_candidates_unique_model"
    UNIQUE ("tenant_id", "policy_version_id", "catalog_version_id"),
  CONSTRAINT "ai_model_route_candidates_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 3)
);

CREATE TABLE public."ai_model_circuit_states" (
  "tenant_id" UUID NOT NULL,
  "catalog_version_id" UUID NOT NULL,
  "state" public."AiModelCircuitState" NOT NULL DEFAULT 'CLOSED',
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "opened_until" TIMESTAMPTZ(6),
  "last_reason_code" VARCHAR(120),
  "last_checked_at" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_model_circuit_states_pkey"
    PRIMARY KEY ("tenant_id", "catalog_version_id"),
  CONSTRAINT "ai_model_circuit_states_shape_check" CHECK (
    "consecutive_failures" >= 0 AND "revision" > 0
    AND ("last_reason_code" IS NULL OR "last_reason_code" ~ '^[A-Z0-9_]{1,120}$')
    AND (
      ("state" = 'OPEN' AND "opened_until" IS NOT NULL)
      OR ("state" <> 'OPEN' AND "opened_until" IS NULL)
    )
  )
);

ALTER TABLE public."agent_runs"
  ADD COLUMN "model_route_policy_version_id" UUID,
  ADD COLUMN "model_route_snapshot" JSONB,
  ADD CONSTRAINT "agent_runs_model_route_snapshot_pair_check" CHECK (
    ("model_route_policy_version_id" IS NULL) = ("model_route_snapshot" IS NULL)
  ),
  ADD CONSTRAINT "agent_runs_model_route_snapshot_shape_check" CHECK (
    "model_route_snapshot" IS NULL
    OR (
      jsonb_typeof("model_route_snapshot") = 'object'
      AND ("model_route_snapshot" ->> 'schemaVersion')::integer = 1
      AND jsonb_typeof("model_route_snapshot" -> 'candidates') = 'array'
      AND jsonb_array_length("model_route_snapshot" -> 'candidates') BETWEEN 1 AND 3
      AND ("model_route_snapshot" ->> 'policyVersionId')::uuid
        = "model_route_policy_version_id"
    )
  );
CREATE INDEX "agent_runs_model_route_policy_idx"
  ON public."agent_runs" ("tenant_id", "model_route_policy_version_id", "created_at");

CREATE TABLE public."ai_model_attempt_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "phase" public."AiModelAttemptPhase" NOT NULL,
  "outcome" public."AiModelAttemptOutcome" NOT NULL,
  "catalog_version_id" UUID NOT NULL,
  "route_key" VARCHAR(120) NOT NULL,
  "provider" public."AiModelProvider" NOT NULL,
  "model_name" VARCHAR(256) NOT NULL,
  "reason_code" VARCHAR(120),
  "retry_safe" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "finished_at" TIMESTAMPTZ(6),
  "receipt_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_model_attempt_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_model_attempt_receipts_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_model_attempt_receipts_run_attempt_phase_key"
    UNIQUE ("tenant_id", "run_id", "attempt_number", "phase"),
  CONSTRAINT "ai_model_attempt_receipts_shape_check" CHECK (
    "attempt_number" BETWEEN 1 AND 3
    AND "route_key" ~ '^[A-Z0-9][A-Z0-9._-]{0,119}$'
    AND length(btrim("model_name")) BETWEEN 1 AND 256
    AND ("reason_code" IS NULL OR "reason_code" ~ '^[A-Z0-9_]{1,120}$')
    AND "receipt_hash" ~ '^[a-f0-9]{64}$'
    AND (
      ("phase" = 'STARTED' AND "outcome" = 'STARTED' AND "finished_at" IS NULL)
      OR (
        "phase" = 'TERMINAL'
        AND "outcome" <> 'STARTED'
        AND "finished_at" IS NOT NULL
        AND "finished_at" >= "started_at"
      )
    )
  )
);
CREATE INDEX "ai_model_attempt_receipts_run_idx"
  ON public."ai_model_attempt_receipts" ("tenant_id", "run_id", "attempt_number", "phase");

CREATE TABLE public."ai_safety_decisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "direction" public."AiSafetyDirection" NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1,
  "classification" public."AiDataClassification" NOT NULL,
  "action" public."AiSafetyAction" NOT NULL,
  "reason_codes" JSONB NOT NULL,
  "content_sha256" CHAR(64) NOT NULL,
  "redacted_content_sha256" CHAR(64),
  "detector_version" VARCHAR(120) NOT NULL,
  "decision_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_safety_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_safety_decisions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_safety_decisions_run_direction_sequence_key"
    UNIQUE ("tenant_id", "run_id", "direction", "sequence"),
  CONSTRAINT "ai_safety_decisions_shape_check" CHECK (
    "sequence" > 0
    AND jsonb_typeof("reason_codes") = 'array'
    AND jsonb_array_length("reason_codes") BETWEEN 1 AND 32
    AND "content_sha256" ~ '^[a-f0-9]{64}$'
    AND (
      "redacted_content_sha256" IS NULL
      OR "redacted_content_sha256" ~ '^[a-f0-9]{64}$'
    )
    AND length(btrim("detector_version")) BETWEEN 1 AND 120
    AND "decision_hash" ~ '^[a-f0-9]{64}$'
  )
);
CREATE INDEX "ai_safety_decisions_run_idx"
  ON public."ai_safety_decisions" ("tenant_id", "run_id", "direction", "sequence");

CREATE TABLE public."ai_governance_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "resource_type" VARCHAR(32) NOT NULL,
  "resource_id" UUID NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "response_revision" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_governance_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_governance_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_governance_commands_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "ai_governance_commands_shape_check" CHECK (
    "resource_type" IN ('CATALOG', 'ROUTE_POLICY')
    AND "action" IN ('SUBMIT', 'PUBLISH', 'RETIRE')
    AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
    AND "request_hash" ~ '^[a-f0-9]{64}$'
    AND "response_revision" > 0
  )
);
CREATE INDEX "ai_governance_commands_resource_idx"
  ON public."ai_governance_commands" (
    "tenant_id", "resource_type", "resource_id", "created_at"
  );

ALTER TABLE public."ai_model_catalog_versions"
  ADD CONSTRAINT "ai_model_catalog_versions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_catalog_versions_created_by_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_catalog_versions_submitted_by_fkey"
    FOREIGN KEY ("tenant_id", "submitted_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_catalog_versions_reviewed_by_fkey"
    FOREIGN KEY ("tenant_id", "reviewed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_catalog_versions_published_by_fkey"
    FOREIGN KEY ("tenant_id", "published_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."ai_model_route_policy_versions"
  ADD CONSTRAINT "ai_model_route_policy_versions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_route_policy_versions_created_by_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_route_policy_versions_submitted_by_fkey"
    FOREIGN KEY ("tenant_id", "submitted_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_route_policy_versions_reviewed_by_fkey"
    FOREIGN KEY ("tenant_id", "reviewed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_route_policy_versions_published_by_fkey"
    FOREIGN KEY ("tenant_id", "published_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."ai_model_route_candidates"
  ADD CONSTRAINT "ai_model_route_candidates_policy_fkey"
    FOREIGN KEY ("tenant_id", "policy_version_id")
    REFERENCES public."ai_model_route_policy_versions"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_route_candidates_catalog_fkey"
    FOREIGN KEY ("tenant_id", "catalog_version_id")
    REFERENCES public."ai_model_catalog_versions"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."ai_model_circuit_states"
  ADD CONSTRAINT "ai_model_circuit_states_catalog_fkey"
    FOREIGN KEY ("tenant_id", "catalog_version_id")
    REFERENCES public."ai_model_catalog_versions"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."agent_runs"
  ADD CONSTRAINT "agent_runs_model_route_policy_fkey"
    FOREIGN KEY ("tenant_id", "model_route_policy_version_id")
    REFERENCES public."ai_model_route_policy_versions"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."ai_model_attempt_receipts"
  ADD CONSTRAINT "ai_model_attempt_receipts_run_fkey"
    FOREIGN KEY ("tenant_id", "run_id")
    REFERENCES public."agent_runs"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_model_attempt_receipts_catalog_fkey"
    FOREIGN KEY ("tenant_id", "catalog_version_id")
    REFERENCES public."ai_model_catalog_versions"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."ai_safety_decisions"
  ADD CONSTRAINT "ai_safety_decisions_run_fkey"
    FOREIGN KEY ("tenant_id", "run_id")
    REFERENCES public."agent_runs"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."ai_governance_commands"
  ADD CONSTRAINT "ai_governance_commands_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_governance_commands_actor_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.ai_governance_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" IN ('PUBLISHED', 'RETIRED') THEN
    IF to_jsonb(NEW) - 'status' - 'retired_at' - 'updated_at' - 'revision'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'retired_at' - 'updated_at' - 'revision'
       OR (OLD."status" = 'RETIRED')
       OR (NEW."status" NOT IN ('PUBLISHED', 'RETIRED')) THEN
      RAISE EXCEPTION 'Published AI governance versions are sealed.'
        USING ERRCODE = '23514', CONSTRAINT = 'ai_governance_published_sealed';
    END IF;
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'AI governance updates require compare-and-swap revision increments.'
      USING ERRCODE = '40001', CONSTRAINT = 'ai_governance_revision_cas';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ai_model_catalog_versions_guard"
  BEFORE UPDATE ON public."ai_model_catalog_versions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_version_guard();
CREATE TRIGGER "ai_model_route_policy_versions_guard"
  BEFORE UPDATE ON public."ai_model_route_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_version_guard();

CREATE OR REPLACE FUNCTION public.ai_model_candidate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  policy_status public."AiGovernanceStatus";
  catalog_record public."ai_model_catalog_versions"%ROWTYPE;
  policy_record public."ai_model_route_policy_versions"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Model route candidates are append-only.'
      USING ERRCODE = '23514', CONSTRAINT = 'ai_model_route_candidates_append_only';
  END IF;
  SELECT * INTO policy_record
  FROM public."ai_model_route_policy_versions"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."policy_version_id"
  FOR UPDATE;
  IF policy_record."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only draft route policies can accept candidates.'
      USING ERRCODE = '23514', CONSTRAINT = 'ai_model_route_candidates_draft_only';
  END IF;
  SELECT * INTO catalog_record
  FROM public."ai_model_catalog_versions"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."catalog_version_id";
  IF catalog_record."status" NOT IN ('PUBLISHED', 'IN_REVIEW') THEN
    RAISE EXCEPTION 'Route candidates must reference reviewed model catalog versions.'
      USING ERRCODE = '23514', CONSTRAINT = 'ai_model_route_candidates_reviewed_catalog';
  END IF;
  IF NOT (catalog_record."data_residency" = ANY (
    SELECT jsonb_array_elements_text(policy_record."allowed_residencies")
  )) OR catalog_record."p95_latency_ms" > policy_record."max_p95_latency_ms"
    OR catalog_record."input_cost_micros_per_million"
       > policy_record."max_input_cost_micros_per_million"
    OR catalog_record."output_cost_micros_per_million"
       > policy_record."max_output_cost_micros_per_million"
    OR NOT catalog_record."capabilities" @> policy_record."required_capabilities"
    OR catalog_record."maximum_classification" < policy_record."maximum_classification" THEN
    RAISE EXCEPTION 'Model route candidate violates the policy constraints.'
      USING ERRCODE = '23514', CONSTRAINT = 'ai_model_route_candidate_policy_mismatch';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ai_model_route_candidates_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."ai_model_route_candidates"
  FOR EACH ROW EXECUTE FUNCTION public.ai_model_candidate_guard();

CREATE OR REPLACE FUNCTION public.ai_model_policy_publish_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_count integer;
  published_count integer;
BEGIN
  IF NEW."status" = 'PUBLISHED' AND OLD."status" <> 'PUBLISHED' THEN
    SELECT count(*), count(*) FILTER (WHERE catalog."status" = 'PUBLISHED')
    INTO candidate_count, published_count
    FROM public."ai_model_route_candidates" candidate
    JOIN public."ai_model_catalog_versions" catalog
      ON catalog."tenant_id" = candidate."tenant_id"
     AND catalog."id" = candidate."catalog_version_id"
    WHERE candidate."tenant_id" = NEW."tenant_id"
      AND candidate."policy_version_id" = NEW."id";
    IF candidate_count < 1
       OR candidate_count > NEW."maximum_attempts"
       OR published_count <> candidate_count THEN
      RAISE EXCEPTION 'Published route policies require bounded published candidates.'
        USING ERRCODE = '23514', CONSTRAINT = 'ai_model_route_policy_publish_candidates';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ai_model_route_policy_publish_guard"
  BEFORE UPDATE ON public."ai_model_route_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_model_policy_publish_guard();

CREATE OR REPLACE FUNCTION public.agent_run_model_route_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."model_route_snapshot" IS NOT NULL
     AND NEW."model_route_snapshot" IS DISTINCT FROM OLD."model_route_snapshot" THEN
    RAISE EXCEPTION 'Agent Run model route snapshots are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_run_model_route_snapshot_immutable';
  END IF;
  IF OLD."model_route_snapshot" IS NULL
     AND NEW."model_route_snapshot" IS NOT NULL
     AND OLD."status" <> 'QUEUED' THEN
    RAISE EXCEPTION 'A model route must be snapshotted before dispatch.'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_run_model_route_snapshot_before_dispatch';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "agent_run_model_route_snapshot_guard"
  BEFORE UPDATE OF "model_route_policy_version_id", "model_route_snapshot"
  ON public."agent_runs"
  FOR EACH ROW EXECUTE FUNCTION public.agent_run_model_route_snapshot_guard();

CREATE OR REPLACE FUNCTION public.ai_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'AI governance commands and execution evidence are append-only.'
    USING ERRCODE = '23514', CONSTRAINT = 'ai_evidence_append_only';
END
$$;
CREATE TRIGGER "ai_model_attempt_receipts_append_only"
  BEFORE UPDATE OR DELETE ON public."ai_model_attempt_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER "ai_safety_decisions_append_only"
  BEFORE UPDATE OR DELETE ON public."ai_safety_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER "ai_governance_commands_append_only"
  BEFORE UPDATE OR DELETE ON public."ai_governance_commands"
  FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

CREATE OR REPLACE FUNCTION public.ai_governance_side_effects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid;
  resource_id uuid;
  action_name text;
  event_name text;
BEGIN
  resource_id := COALESCE(
    NULLIF(to_jsonb(NEW) ->> 'id', '')::uuid,
    NULLIF(to_jsonb(NEW) ->> 'run_id', '')::uuid,
    NULLIF(to_jsonb(NEW) ->> 'catalog_version_id', '')::uuid
  );
  actor_id := COALESCE(
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    NULLIF(to_jsonb(NEW) ->> 'created_by_user_id', '')::uuid,
    (
      SELECT run."requester_user_id"
      FROM public."agent_runs" run
      WHERE run."tenant_id" = NEW."tenant_id"
        AND run."id" = NULLIF(to_jsonb(NEW) ->> 'run_id', '')::uuid
    )
  );
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'AI governance changes require an attributable actor.'
      USING ERRCODE = '23514', CONSTRAINT = 'ai_governance_actor_required';
  END IF;
  action_name := replace(TG_TABLE_NAME, 'ai_', 'ai.') || '.' || lower(TG_OP);
  event_name := CASE TG_TABLE_NAME
    WHEN 'ai_model_catalog_versions' THEN 'AiModelCatalogVersionChanged'
    WHEN 'ai_model_route_policy_versions' THEN 'AiModelRoutePolicyVersionChanged'
    WHEN 'ai_model_circuit_states' THEN 'AiModelCircuitStateChanged'
    WHEN 'ai_model_attempt_receipts' THEN 'AiModelAttemptReceiptRecorded'
    ELSE 'AiSafetyDecisionRecorded'
  END;
  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id",
    CASE WHEN NULLIF(current_setting('app.user_id', true), '') IS NULL
      THEN 'SERVICE'::public."AuditActorType"
      ELSE 'USER'::public."AuditActorType"
    END,
    actor_id, action_name, upper(TG_TABLE_NAME), resource_id,
    jsonb_build_object(
      'schemaVersion', 1,
      'operation', TG_OP,
      'status', to_jsonb(NEW) -> 'status',
      'action', to_jsonb(NEW) -> 'action',
      'reasonCodes', to_jsonb(NEW) -> 'reason_codes'
    ),
    CURRENT_TIMESTAMP
  );
  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id", 'AI_GOVERNANCE', resource_id, event_name,
    jsonb_build_object(
      'schemaVersion', 1,
      'resourceType', upper(TG_TABLE_NAME),
      'resourceId', resource_id,
      'operation', TG_OP
    ),
    'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER "ai_model_catalog_versions_side_effects"
  AFTER INSERT OR UPDATE ON public."ai_model_catalog_versions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_side_effects();
CREATE TRIGGER "ai_model_route_policy_versions_side_effects"
  AFTER INSERT OR UPDATE ON public."ai_model_route_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_side_effects();
CREATE TRIGGER "ai_model_circuit_states_side_effects"
  AFTER INSERT OR UPDATE ON public."ai_model_circuit_states"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_side_effects();
CREATE TRIGGER "ai_model_attempt_receipts_side_effects"
  AFTER INSERT ON public."ai_model_attempt_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_side_effects();
CREATE TRIGGER "ai_safety_decisions_side_effects"
  AFTER INSERT ON public."ai_safety_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.ai_governance_side_effects();

DO $$
DECLARE
  table_name text;
  protected_tables text[] := ARRAY[
    'ai_model_catalog_versions',
    'ai_model_route_policy_versions',
    'ai_model_route_candidates',
    'ai_model_circuit_states',
    'ai_model_attempt_receipts',
    'ai_safety_decisions',
    'ai_governance_commands'
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY ai_model_routing_tenant_isolation ON public.%I '
      || 'AS RESTRICTIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY ai_model_routing_app_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public."ai_model_catalog_versions",
  public."ai_model_route_policy_versions",
  public."ai_model_circuit_states"
  TO enterprise_agent_app, enterprise_agent_admin;
GRANT SELECT, INSERT ON TABLE
  public."ai_model_route_candidates",
  public."ai_model_attempt_receipts",
  public."ai_safety_decisions",
  public."ai_governance_commands"
  TO enterprise_agent_app, enterprise_agent_admin;
GRANT USAGE ON TYPE
  public."AiGovernanceStatus",
  public."AiDataClassification",
  public."AiModelProvider",
  public."AiModelAttemptPhase",
  public."AiModelAttemptOutcome",
  public."AiModelCircuitState",
  public."AiSafetyDirection",
  public."AiSafetyAction"
  TO enterprise_agent_app, enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.ai_governance_version_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_model_candidate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_model_policy_publish_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_run_model_route_snapshot_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_governance_side_effects() FROM PUBLIC;

COMMIT;
