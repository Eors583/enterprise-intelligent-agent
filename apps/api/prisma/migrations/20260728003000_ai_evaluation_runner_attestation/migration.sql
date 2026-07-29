BEGIN;

ALTER TABLE public."ai_evaluation_runs"
  ADD COLUMN "execution_attestation_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "execution_nonce" CHAR(64),
  ADD COLUMN "execution_request_hash" CHAR(64),
  ADD COLUMN "execution_idempotency_key" VARCHAR(200),
  ADD COLUMN "execution_requested_at" TIMESTAMPTZ(6);

ALTER TABLE public."ai_evaluation_runs"
  ALTER COLUMN "execution_attestation_required" SET DEFAULT true;

ALTER TABLE public."ai_evaluation_runs"
  ADD CONSTRAINT "ai_evaluation_runs_execution_shape_check" CHECK (
    (
      "execution_nonce" IS NULL
      AND "execution_request_hash" IS NULL
      AND "execution_idempotency_key" IS NULL
      AND "execution_requested_at" IS NULL
    )
    OR (
      "execution_nonce" ~ '^[a-f0-9]{64}$'
      AND "execution_request_hash" ~ '^[a-f0-9]{64}$'
      AND length(btrim("execution_idempotency_key")) BETWEEN 1 AND 200
      AND "execution_requested_at" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "ai_evaluation_runs_execution_required_check" CHECK (
    NOT "execution_attestation_required"
    OR "status" = 'CREATED'
    OR "status" = 'CANCELLED'
    OR (
      "execution_nonce" IS NOT NULL
      AND "execution_request_hash" IS NOT NULL
      AND "execution_idempotency_key" IS NOT NULL
      AND "execution_requested_at" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "ai_evaluation_runs_runner_nonce_key"
  ON public."ai_evaluation_runs" ("tenant_id", "runner_id", "execution_nonce")
  WHERE "execution_nonce" IS NOT NULL;

CREATE TABLE public."ai_evaluation_runner_attestations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "runner_id" UUID NOT NULL,
  "nonce" CHAR(64) NOT NULL,
  "execution_request_hash" CHAR(64) NOT NULL,
  "result_payload_hash" CHAR(64) NOT NULL,
  "evidence_bundle_uri" TEXT NOT NULL,
  "evidence_bundle_hash" CHAR(64) NOT NULL,
  "evidence_bundle" JSONB NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL,
  "key_fingerprint" CHAR(64) NOT NULL,
  "signature" CHAR(64) NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL,
  "verified_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_evaluation_runner_attestations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_evaluation_runner_attestations_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ai_evaluation_runner_attestations_run_key"
    UNIQUE ("tenant_id", "run_id"),
  CONSTRAINT "ai_evaluation_runner_attestations_nonce_key"
    UNIQUE ("tenant_id", "runner_id", "nonce"),
  CONSTRAINT "ai_evaluation_runner_attestations_hash_check" CHECK (
    "nonce" ~ '^[a-f0-9]{64}$'
    AND "execution_request_hash" ~ '^[a-f0-9]{64}$'
    AND "result_payload_hash" ~ '^[a-f0-9]{64}$'
    AND "evidence_bundle_hash" ~ '^[a-f0-9]{64}$'
    AND "key_fingerprint" ~ '^[a-f0-9]{64}$'
    AND "signature" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "ai_evaluation_runner_attestations_shape_check" CHECK (
    "algorithm" = 'HMAC-SHA256'
    AND jsonb_typeof("evidence_bundle") = 'object'
    AND "evidence_bundle" ?& ARRAY[
      'schema_version', 'tenant_id', 'run_id', 'runner_id', 'nonce',
      'request_hash', 'subject_snapshot_hash', 'dataset_content_hash',
      'case_results', 'metrics', 'generated_at'
    ]
    AND "evidence_bundle" ->> 'schema_version' = '1'
    AND ("evidence_bundle" ->> 'tenant_id')
      IS NOT DISTINCT FROM "tenant_id"::text
    AND ("evidence_bundle" ->> 'run_id')
      IS NOT DISTINCT FROM "run_id"::text
    AND ("evidence_bundle" ->> 'runner_id')
      IS NOT DISTINCT FROM "runner_id"::text
    AND ("evidence_bundle" ->> 'nonce')
      IS NOT DISTINCT FROM btrim("nonce")
    AND ("evidence_bundle" ->> 'request_hash')
      IS NOT DISTINCT FROM btrim("execution_request_hash")
    AND ("evidence_bundle" ->> 'subject_snapshot_hash') ~ '^[a-f0-9]{64}$'
    AND ("evidence_bundle" ->> 'dataset_content_hash') ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("evidence_bundle" -> 'case_results') = 'array'
    AND jsonb_typeof("evidence_bundle" -> 'metrics') = 'array'
    AND "verified_at" >= "issued_at"
    AND "consumed_at" = "verified_at"
  )
);

ALTER TABLE public."ai_evaluation_runner_attestations"
  ADD CONSTRAINT "ai_evaluation_runner_attestations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ai_evaluation_runner_attestations_run_fkey"
    FOREIGN KEY ("tenant_id", "run_id")
    REFERENCES public."ai_evaluation_runs"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ai_evaluation_runner_attestations_runner_fkey"
    FOREIGN KEY ("tenant_id", "runner_id")
    REFERENCES public."ai_evaluation_runners"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."ai_evaluation_runner_attestations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ai_evaluation_runner_attestations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_evaluation_tenant_isolation"
  ON public."ai_evaluation_runner_attestations"
  AS RESTRICTIVE FOR ALL TO enterprise_agent_admin, enterprise_agent_evaluation_runner
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "ai_evaluation_admin_access"
  ON public."ai_evaluation_runner_attestations"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin
  USING (true) WITH CHECK (true);
CREATE POLICY "ai_evaluation_runner_attestation_read"
  ON public."ai_evaluation_runner_attestations"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_evaluation_runner
  USING (
    "runner_id" = NULLIF(current_setting('app.evaluation_runner_id', true), '')::uuid
  );

REVOKE ALL ON TABLE public."ai_evaluation_runner_attestations"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_evaluation_runner;
GRANT SELECT, INSERT ON TABLE public."ai_evaluation_runner_attestations"
  TO enterprise_agent_admin;
GRANT SELECT ON TABLE public."ai_evaluation_runner_attestations"
  TO enterprise_agent_evaluation_runner;

CREATE OR REPLACE FUNCTION public.ai_evaluation_runner_attestation_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_record public."ai_evaluation_runs"%ROWTYPE;
  session_runner_id uuid :=
    NULLIF(current_setting('app.evaluation_runner_id', true), '')::uuid;
  verified_result_hash text :=
    NULLIF(current_setting('app.evaluation_attestation_result_hash', true), '');
BEGIN
  SELECT run.*
    INTO run_record
  FROM public."ai_evaluation_runs" run
  WHERE run."tenant_id" = NEW."tenant_id"
    AND run."id" = NEW."run_id"
  FOR UPDATE;
  IF NOT FOUND
     OR run_record."status" <> 'RUNNING'
     OR session_runner_id IS NULL
     OR session_runner_id <> NEW."runner_id"
     OR run_record."runner_id" <> NEW."runner_id"
     OR btrim(run_record."execution_nonce") <> btrim(NEW."nonce")
     OR btrim(run_record."execution_request_hash")
          <> btrim(NEW."execution_request_hash")
     OR verified_result_hash IS NULL
     OR verified_result_hash <> btrim(NEW."result_payload_hash")
     OR run_record."runner_attestation_key_fingerprint"
          <> NEW."key_fingerprint"
     OR NOT EXISTS (
       SELECT 1
       FROM public."ai_evaluation_runners" runner
       CROSS JOIN LATERAL jsonb_array_elements_text(
         runner."allowed_evidence_origins"
       ) allowed(origin)
       WHERE runner."tenant_id" = NEW."tenant_id"
         AND runner."id" = NEW."runner_id"
         AND runner."status" = 'ACTIVE'
         AND starts_with(NEW."evidence_bundle_uri", allowed.origin)
     ) THEN
    RAISE EXCEPTION 'Runner attestation does not bind the active sealed execution request.'
      USING ERRCODE = '42501',
            CONSTRAINT = 'ai_evaluation_runner_attestation_binding';
  END IF;
  IF NEW."issued_at" < run_record."execution_requested_at" - interval '5 minutes'
     OR NEW."issued_at" > CURRENT_TIMESTAMP + interval '5 minutes'
     OR NEW."verified_at" > CURRENT_TIMESTAMP + interval '5 minutes' THEN
    RAISE EXCEPTION 'Runner attestation timestamp is outside the accepted execution window.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_runner_attestation_time';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ai_evaluation_runner_attestations_insert_guard"
  BEFORE INSERT ON public."ai_evaluation_runner_attestations"
  FOR EACH ROW EXECUTE FUNCTION public.ai_evaluation_runner_attestation_insert_guard();

CREATE TRIGGER "ai_evaluation_runner_attestations_append_only"
  BEFORE UPDATE OR DELETE ON public."ai_evaluation_runner_attestations"
  FOR EACH ROW EXECUTE FUNCTION public.ai_evaluation_append_only_guard();

CREATE OR REPLACE FUNCTION public.ai_evaluation_run_mutation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_runner_id uuid :=
    NULLIF(current_setting('app.evaluation_runner_id', true), '')::uuid;
  session_user_id uuid :=
    NULLIF(current_setting('app.user_id', true), '')::uuid;
  verified_result_hash text :=
    NULLIF(current_setting('app.evaluation_attestation_result_hash', true), '');
BEGIN
  IF NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."dataset_version_id" <> OLD."dataset_version_id"
     OR NEW."subject_type" <> OLD."subject_type"
     OR NEW."subject_id" <> OLD."subject_id"
     OR NEW."subject_version" <> OLD."subject_version"
     OR NEW."subject_snapshot_hash" <> OLD."subject_snapshot_hash"
     OR NEW."runner_id" <> OLD."runner_id"
     OR NEW."runner_name" <> OLD."runner_name"
     OR NEW."runner_attestation_key_fingerprint"
          <> OLD."runner_attestation_key_fingerprint"
     OR NEW."external_run_id" <> OLD."external_run_id"
     OR NEW."expected_case_count" <> OLD."expected_case_count"
     OR NEW."idempotency_key" <> OLD."idempotency_key"
     OR NEW."request_hash" <> OLD."request_hash"
     OR NEW."created_by_user_id" <> OLD."created_by_user_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'Evaluation Run identity and evaluated snapshot are immutable.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_runs_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Evaluation Run updates require exact CAS revision increments.'
      USING ERRCODE = '40001',
            CONSTRAINT = 'ai_evaluation_runs_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'CREATED' AND NEW."status" IN ('RUNNING', 'CANCELLED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('SUBMITTED', 'CANCELLED'))
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('PASSED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'Illegal evaluation Run transition.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_runs_transition';
  END IF;
  IF OLD."status" = 'CREATED' AND NEW."status" = 'RUNNING' THEN
    IF NOT NEW."execution_attestation_required"
       OR NEW."started_at" IS NULL
       OR NEW."execution_nonce" IS NULL
       OR NEW."execution_request_hash" IS NULL
       OR NEW."execution_idempotency_key" IS NULL
       OR NEW."execution_requested_at" IS NULL THEN
      RAISE EXCEPTION 'Evaluation Run start requires a sealed execution request and nonce.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'ai_evaluation_runs_execution_request_required';
    END IF;
  ELSIF NEW."execution_attestation_required"
          IS DISTINCT FROM OLD."execution_attestation_required"
     OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
     OR NEW."execution_nonce" IS DISTINCT FROM OLD."execution_nonce"
     OR NEW."execution_request_hash" IS DISTINCT FROM OLD."execution_request_hash"
     OR NEW."execution_idempotency_key" IS DISTINCT FROM OLD."execution_idempotency_key"
     OR NEW."execution_requested_at" IS DISTINCT FROM OLD."execution_requested_at" THEN
    RAISE EXCEPTION 'Evaluation Run execution request is immutable after start.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_runs_execution_request_immutable';
  END IF;
  IF NOT (OLD."status" = 'RUNNING' AND NEW."status" = 'SUBMITTED')
     AND (
       NEW."submitted_case_count" IS DISTINCT FROM OLD."submitted_case_count"
       OR NEW."evidence_bundle_uri" IS DISTINCT FROM OLD."evidence_bundle_uri"
       OR NEW."evidence_bundle_hash" IS DISTINCT FROM OLD."evidence_bundle_hash"
       OR NEW."runner_attestation" IS DISTINCT FROM OLD."runner_attestation"
       OR NEW."result_submitted_by_runner_id"
            IS DISTINCT FROM OLD."result_submitted_by_runner_id"
       OR NEW."result_submitted_by_user_id"
            IS DISTINCT FROM OLD."result_submitted_by_user_id"
       OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
     ) THEN
    RAISE EXCEPTION 'Evaluation Run submission evidence is immutable outside submission.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_runs_submission_immutable';
  END IF;
  IF OLD."status" = 'RUNNING' AND NEW."status" = 'SUBMITTED' THEN
    IF session_runner_id IS NULL
       OR session_runner_id <> NEW."runner_id"
       OR NEW."result_submitted_by_runner_id" IS DISTINCT FROM session_runner_id
       OR NEW."result_submitted_by_user_id" IS NOT NULL
       OR NOT NEW."runner_evidence_verified"
       OR verified_result_hash IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public."ai_evaluation_runner_attestations" attestation
         WHERE attestation."tenant_id" = NEW."tenant_id"
           AND attestation."run_id" = NEW."id"
           AND attestation."runner_id" = NEW."runner_id"
           AND btrim(attestation."nonce") = btrim(NEW."execution_nonce")
           AND btrim(attestation."execution_request_hash")
                = btrim(NEW."execution_request_hash")
           AND btrim(attestation."result_payload_hash") = verified_result_hash
           AND attestation."consumed_at" = attestation."verified_at"
       ) THEN
      RAISE EXCEPTION 'Evaluation Run results require a verified one-time runner attestation.'
        USING ERRCODE = '42501',
              CONSTRAINT = 'ai_evaluation_runs_attested_runner_required';
    END IF;
  END IF;
  IF NOT (
       (OLD."status" = 'RUNNING' AND NEW."status" = 'SUBMITTED')
       OR (
         OLD."status" = 'SUBMITTED'
         AND NEW."status" IN ('PASSED', 'FAILED')
       )
     )
     AND (
       NEW."runner_evidence_verified" IS DISTINCT FROM OLD."runner_evidence_verified"
       OR NEW."verified_by_user_id" IS DISTINCT FROM OLD."verified_by_user_id"
       OR NEW."verification_evidence_count"
            IS DISTINCT FROM OLD."verification_evidence_count"
       OR NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
     ) THEN
    RAISE EXCEPTION 'Evaluation Run verification fields are immutable outside verification.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_runs_verification_immutable';
  END IF;
  IF OLD."status" = 'SUBMITTED' AND NEW."status" IN ('PASSED', 'FAILED') THEN
    IF session_runner_id IS NOT NULL
       OR session_user_id IS NULL
       OR NEW."verified_by_user_id" IS DISTINCT FROM session_user_id
       OR NOT OLD."runner_evidence_verified"
       OR NOT NEW."runner_evidence_verified" THEN
      RAISE EXCEPTION 'Evaluation Run verification must bind to an authenticated human verifier.'
        USING ERRCODE = '42501',
              CONSTRAINT = 'ai_evaluation_runs_verifier_binding';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.ai_evaluation_result_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_record public."ai_evaluation_runs"%ROWTYPE;
  threshold_record public."ai_evaluation_thresholds"%ROWTYPE;
  session_runner_id uuid :=
    NULLIF(current_setting('app.evaluation_runner_id', true), '')::uuid;
  verified_result_hash text :=
    NULLIF(current_setting('app.evaluation_attestation_result_hash', true), '');
BEGIN
  SELECT run.*
    INTO run_record
  FROM public."ai_evaluation_runs" run
  WHERE run."tenant_id" = NEW."tenant_id"
    AND run."id" = NEW."run_id"
  FOR UPDATE;
  IF run_record."status" <> 'RUNNING'
     OR session_runner_id IS NULL
     OR session_runner_id <> run_record."runner_id"
     OR verified_result_hash IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public."ai_evaluation_runner_attestations" attestation
       WHERE attestation."tenant_id" = NEW."tenant_id"
         AND attestation."run_id" = NEW."run_id"
         AND attestation."runner_id" = session_runner_id
         AND btrim(attestation."result_payload_hash") = verified_result_hash
     ) THEN
    RAISE EXCEPTION 'Evaluation results require a verified active runner attestation.'
      USING ERRCODE = '42501',
            CONSTRAINT = 'ai_evaluation_results_attestation_required';
  END IF;
  IF TG_TABLE_NAME = 'ai_evaluation_case_results' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public."ai_evaluation_cases" test_case
      WHERE test_case."tenant_id" = NEW."tenant_id"
        AND test_case."id" = NEW."case_id"
        AND test_case."dataset_version_id" = run_record."dataset_version_id"
    ) THEN
      RAISE EXCEPTION 'Case Result does not belong to the Run dataset snapshot.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'ai_evaluation_case_results_dataset_match';
    END IF;
  ELSE
    SELECT threshold.*
      INTO threshold_record
    FROM public."ai_evaluation_thresholds" threshold
    WHERE threshold."tenant_id" = NEW."tenant_id"
      AND threshold."dataset_version_id" = run_record."dataset_version_id"
      AND threshold."metric" = NEW."metric";
    IF NOT FOUND
       OR threshold_record."direction" <> NEW."direction"
       OR threshold_record."threshold" <> NEW."threshold"
       OR threshold_record."minimum_sample_count" <> NEW."minimum_sample_count" THEN
      RAISE EXCEPTION 'Metric Result must use the sealed dataset threshold.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'ai_evaluation_metric_results_threshold_match';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.ai_evaluation_attestation_side_effects()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id", 'SERVICE', NEW."runner_id",
    'ai.evaluation.runner_attestation.verified',
    'AI_EVALUATION_RUNNER_ATTESTATION', NEW."id",
    jsonb_build_object(
      'schemaVersion', 1,
      'runId', NEW."run_id",
      'requestHash', btrim(NEW."execution_request_hash"),
      'resultPayloadHash', btrim(NEW."result_payload_hash"),
      'keyFingerprint', btrim(NEW."key_fingerprint")
    ),
    CURRENT_TIMESTAMP
  );
  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id", 'AI_EVALUATION', NEW."run_id",
    'AiEvaluationRunnerAttestationVerified',
    jsonb_build_object(
      'schemaVersion', 1,
      'runId', NEW."run_id",
      'runnerId', NEW."runner_id",
      'attestationId', NEW."id",
      'resultPayloadHash', btrim(NEW."result_payload_hash")
    ),
    'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER "ai_evaluation_runner_attestations_side_effects"
  AFTER INSERT ON public."ai_evaluation_runner_attestations"
  FOR EACH ROW EXECUTE FUNCTION public.ai_evaluation_attestation_side_effects();

REVOKE ALL ON FUNCTION public.ai_evaluation_runner_attestation_insert_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_evaluation_attestation_side_effects()
  FROM PUBLIC;

COMMIT;
