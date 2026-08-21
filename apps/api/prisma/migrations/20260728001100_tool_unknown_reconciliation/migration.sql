-- Durable, status-only reconciliation for ambiguous Tool executions.
-- This migration deliberately does not add compensation or replay the original
-- provider request. A terminal transition requires a pinned status/replay proof
-- bound to the original provider_request_id.

CREATE TYPE public."ToolReconciliationEligibility" AS ENUM (
  'READ_ONLY', 'PROVIDER_IDEMPOTENT', 'INELIGIBLE'
);
CREATE TYPE public."ToolReconciliationResolution" AS ENUM (
  'SUCCEEDED', 'FAILED', 'INCONCLUSIVE'
);
CREATE TYPE public."ToolReconciliationProofType" AS ENUM (
  'STATUS', 'IDEMPOTENT_REPLAY'
);

-- Every reference between tenant-scoped tables must carry the tenant key.
-- Keep the globally unique outbox id as the primary key while exposing a
-- composite candidate key for tenant-safe foreign keys.
ALTER TABLE public."outbox_events"
  ADD CONSTRAINT "outbox_events_tenant_id_id_key"
    UNIQUE ("tenant_id", "id");

CREATE TABLE public."tool_reconciliation_attempts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tool_invocation_id" UUID NOT NULL,
  "tool_version_id" UUID NOT NULL,
  "outbox_event_id" UUID NOT NULL,
  "requested_revision" INTEGER NOT NULL,
  "provider_request_id" VARCHAR(300) NOT NULL,
  "input_hash" VARCHAR(64) NOT NULL,
  "eligibility" public."ToolReconciliationEligibility" NOT NULL,
  "endpoint_ref_hash" VARCHAR(64) NOT NULL,
  "requested_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_reconciliation_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_reconciliation_attempts_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_reconciliation_attempts_outbox_event_key"
    UNIQUE ("outbox_event_id"),
  CONSTRAINT "tool_reconciliation_attempts_revision_check"
    CHECK ("requested_revision" > 0),
  CONSTRAINT "tool_reconciliation_attempts_text_hash_check" CHECK (
    btrim("provider_request_id") <> ''
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND "endpoint_ref_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tool_reconciliation_attempts_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_reconciliation_attempts_invocation_fkey"
    FOREIGN KEY ("tenant_id", "tool_invocation_id")
    REFERENCES public."tool_invocations" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_reconciliation_attempts_version_fkey"
    FOREIGN KEY ("tenant_id", "tool_version_id")
    REFERENCES public."tool_versions" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_reconciliation_attempts_outbox_fkey"
    FOREIGN KEY ("tenant_id", "outbox_event_id")
    REFERENCES public."outbox_events" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE public."tool_reconciliation_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "tool_invocation_id" UUID NOT NULL,
  "invocation_revision" INTEGER NOT NULL,
  "resolution" public."ToolReconciliationResolution" NOT NULL,
  "reason_code" VARCHAR(120) NOT NULL,
  "proof_type" public."ToolReconciliationProofType",
  "proof_id" VARCHAR(200),
  "provider_request_id" VARCHAR(300) NOT NULL,
  "provider_observed_at" TIMESTAMPTZ(6),
  "proof_hash" VARCHAR(64),
  "output_hash" VARCHAR(64),
  "error_code" VARCHAR(120),
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL,
  "receipt_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_reconciliation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_reconciliation_receipts_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_reconciliation_receipts_attempt_key"
    UNIQUE ("attempt_id"),
  CONSTRAINT "tool_reconciliation_receipts_revision_check"
    CHECK ("invocation_revision" > 0),
  CONSTRAINT "tool_reconciliation_receipts_code_hash_check" CHECK (
    "reason_code" ~ '^[A-Z0-9_]{1,120}$'
    AND btrim("provider_request_id") <> ''
    AND ("proof_hash" IS NULL OR "proof_hash" ~ '^[0-9a-f]{64}$')
    AND ("output_hash" IS NULL OR "output_hash" ~ '^[0-9a-f]{64}$')
    AND "receipt_hash" ~ '^[0-9a-f]{64}$'
    AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z0-9_]{1,120}$')
  ),
  CONSTRAINT "tool_reconciliation_receipts_time_check" CHECK (
    "completed_at" >= "started_at"
  ),
  CONSTRAINT "tool_reconciliation_receipts_proof_tuple_check" CHECK (
    (
      "proof_type" IS NULL
      AND "proof_id" IS NULL
      AND "provider_observed_at" IS NULL
      AND "proof_hash" IS NULL
    )
    OR (
      "proof_type" IS NOT NULL
      AND "proof_id" ~ '^[A-Za-z0-9_.:/-]{1,200}$'
      AND "provider_observed_at" IS NOT NULL
      AND "proof_hash" IS NOT NULL
    )
  ),
  CONSTRAINT "tool_reconciliation_receipts_resolution_shape_check" CHECK (
    (
      "resolution" = 'SUCCEEDED'
      AND "proof_type" IS NOT NULL
      AND "output_hash" IS NOT NULL
      AND "error_code" IS NULL
    )
    OR (
      "resolution" = 'FAILED'
      AND "proof_type" IS NOT NULL
      AND "output_hash" IS NULL
      AND "error_code" IS NOT NULL
    )
    OR (
      "resolution" = 'INCONCLUSIVE'
      AND "output_hash" IS NULL
      AND "error_code" IS NULL
    )
  ),
  CONSTRAINT "tool_reconciliation_receipts_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_reconciliation_receipts_attempt_fkey"
    FOREIGN KEY ("tenant_id", "attempt_id")
    REFERENCES public."tool_reconciliation_attempts" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_reconciliation_receipts_invocation_fkey"
    FOREIGN KEY ("tenant_id", "tool_invocation_id")
    REFERENCES public."tool_invocations" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "tool_reconciliation_attempts_invocation_idx"
  ON public."tool_reconciliation_attempts" (
    "tenant_id", "tool_invocation_id", "created_at" DESC
  );
CREATE INDEX "tool_reconciliation_receipts_invocation_idx"
  ON public."tool_reconciliation_receipts" (
    "tenant_id", "tool_invocation_id", "created_at" DESC
  );
CREATE INDEX "tool_reconciliation_receipts_provider_proof_idx"
  ON public."tool_reconciliation_receipts" (
    "tenant_id", "provider_request_id", "proof_type", "proof_id"
  )
  WHERE "proof_type" IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_tool_reconciliation_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_record public."outbox_events"%ROWTYPE;
  invocation_record public."tool_invocations"%ROWTYPE;
  expected_eligibility public."ToolReconciliationEligibility";
BEGIN
  SELECT * INTO event_record
  FROM public."outbox_events"
  WHERE "id" = NEW."outbox_event_id"
  FOR SHARE;
  SELECT * INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  expected_eligibility := CASE
    WHEN invocation_record."risk_class" = 'READ_ONLY' THEN 'READ_ONLY'
    WHEN invocation_record."idempotency_mode" IN (
      'REQUIRED', 'PROVIDER_SUPPORTED'
    ) THEN 'PROVIDER_IDEMPOTENT'
    ELSE 'INELIGIBLE'
  END;
  IF event_record."id" IS NULL
     OR event_record."tenant_id" <> NEW."tenant_id"
     OR event_record."aggregate_type" <> 'TOOL_INVOCATION'
     OR event_record."aggregate_id" <> NEW."tool_invocation_id"
     OR event_record."event_type" <> 'ToolInvocation.ReconciliationRequested'
     OR event_record."status" <> 'PENDING'
     OR event_record."payload"->>'invocationId' IS DISTINCT FROM NEW."tool_invocation_id"::text
     OR (event_record."payload"->>'expectedRevision')::integer
       IS DISTINCT FROM NEW."requested_revision"
     OR invocation_record."id" IS NULL
     OR invocation_record."status" <> 'UNKNOWN'
     OR invocation_record."revision" <> NEW."requested_revision"
     OR invocation_record."tool_version_id" <> NEW."tool_version_id"
     OR invocation_record."provider_request_id"
       IS DISTINCT FROM NEW."provider_request_id"
     OR invocation_record."input_hash" <> NEW."input_hash"
     OR NEW."eligibility" IS DISTINCT FROM expected_eligibility THEN
    RAISE EXCEPTION 'Reconciliation attempt is not bound to the claimed event and UNKNOWN Invocation.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_reconciliation_attempts_binding';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_tool_reconciliation_attempt_insert()
  FROM PUBLIC;
CREATE TRIGGER "tool_reconciliation_attempts_insert_guard_trigger"
  BEFORE INSERT ON public."tool_reconciliation_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_reconciliation_attempt_insert();

CREATE OR REPLACE FUNCTION public.guard_tool_reconciliation_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_record public."tool_reconciliation_attempts"%ROWTYPE;
  invocation_record public."tool_invocations"%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
  FROM public."tool_reconciliation_attempts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."attempt_id"
  FOR SHARE;
  SELECT * INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  IF attempt_record."id" IS NULL
     OR invocation_record."id" IS NULL
     OR attempt_record."tool_invocation_id" <> NEW."tool_invocation_id"
     OR attempt_record."provider_request_id"
       IS DISTINCT FROM NEW."provider_request_id"
     OR invocation_record."provider_request_id"
       IS DISTINCT FROM NEW."provider_request_id"
     OR (
       NEW."resolution" IN ('SUCCEEDED', 'FAILED')
       AND (
         attempt_record."eligibility" = 'INELIGIBLE'
         OR invocation_record."status" <> 'UNKNOWN'
         OR invocation_record."revision" <> attempt_record."requested_revision"
         OR NEW."invocation_revision" <> invocation_record."revision" + 1
       )
     )
     OR (
       NEW."resolution" = 'INCONCLUSIVE'
       AND NEW."invocation_revision" <> invocation_record."revision"
     ) THEN
    RAISE EXCEPTION 'Reconciliation receipt is not bound to its attempt and fixed provider request.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_reconciliation_receipts_binding';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_tool_reconciliation_receipt_insert()
  FROM PUBLIC;
CREATE TRIGGER "tool_reconciliation_receipts_insert_guard_trigger"
  BEFORE INSERT ON public."tool_reconciliation_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_reconciliation_receipt_insert();

-- The original transition guard rejects UNKNOWN -> terminal. Keep it for every
-- other transition and use an exact receipt-bound guard for reconciliation.
DROP TRIGGER "tool_invocations_transition_guard_trigger"
  ON public."tool_invocations";
CREATE TRIGGER "tool_invocations_transition_guard_trigger"
  BEFORE UPDATE ON public."tool_invocations"
  FOR EACH ROW
  WHEN (
    NOT (
      OLD."status" = 'UNKNOWN'
      AND NEW."status" IN ('SUCCEEDED', 'FAILED')
    )
  )
  EXECUTE FUNCTION public.guard_tool_invocation_transition();

CREATE OR REPLACE FUNCTION public.guard_tool_reconciliation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_valid boolean;
BEGIN
  IF OLD."status" <> 'UNKNOWN'
     OR NEW."status" NOT IN ('SUCCEEDED', 'FAILED')
     OR NEW."revision" <> OLD."revision" + 1
     OR (
       to_jsonb(NEW) - ARRAY[
         'status', 'revision', 'output', 'output_hash', 'error_code',
         'error_detail', 'completed_at', 'updated_at'
       ]::text[]
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'status', 'revision', 'output', 'output_hash', 'error_code',
         'error_detail', 'completed_at', 'updated_at'
       ]::text[]
     )
     OR NEW."completed_at" IS NULL
     OR NEW."completed_at" < COALESCE(OLD."started_at", OLD."created_at")
     OR (
       NEW."status" = 'SUCCEEDED'
       AND (NEW."output" IS NULL OR NEW."output_hash" IS NULL
            OR NEW."error_code" IS NOT NULL OR NEW."error_detail" IS NOT NULL)
     )
     OR (
       NEW."status" = 'FAILED'
       AND (NEW."output" IS NOT NULL OR NEW."output_hash" IS NOT NULL
            OR NEW."error_code" IS NULL OR NEW."error_detail" IS NULL)
     ) THEN
    RAISE EXCEPTION 'UNKNOWN may only resolve through the exact reconciliation shape.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_invocations_reconciliation_shape';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public."tool_reconciliation_attempts" attempt
    JOIN public."tool_reconciliation_receipts" receipt
      ON receipt."tenant_id" = attempt."tenant_id"
     AND receipt."attempt_id" = attempt."id"
    WHERE attempt."tenant_id" = NEW."tenant_id"
      AND attempt."tool_invocation_id" = NEW."id"
      AND attempt."requested_revision" = OLD."revision"
      AND attempt."provider_request_id" = NEW."provider_request_id"
      AND attempt."eligibility" <> 'INELIGIBLE'
      AND receipt."tool_invocation_id" = NEW."id"
      AND receipt."invocation_revision" = NEW."revision"
      AND receipt."resolution"::text = NEW."status"::text
      AND receipt."provider_request_id" = NEW."provider_request_id"
      AND receipt."proof_type" IS NOT NULL
      AND receipt."proof_id" IS NOT NULL
      AND receipt."proof_hash" IS NOT NULL
      AND (
        (
          NEW."status" = 'SUCCEEDED'
          AND receipt."output_hash" = NEW."output_hash"
        )
        OR (
          NEW."status" = 'FAILED'
          AND receipt."error_code" = NEW."error_code"
        )
      )
  ) INTO receipt_valid;
  IF NOT receipt_valid THEN
    RAISE EXCEPTION 'UNKNOWN resolution requires one exact immutable reconciliation receipt.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_invocations_reconciliation_receipt';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_invocations_reconciliation_guard_trigger"
  BEFORE UPDATE ON public."tool_invocations"
  FOR EACH ROW
  WHEN (
    OLD."status" = 'UNKNOWN'
    AND NEW."status" IN ('SUCCEEDED', 'FAILED')
  )
  EXECUTE FUNCTION public.guard_tool_reconciliation_transition();

-- The original deferred coverage function has no UNKNOWN mapping. Exclude only
-- the new transition and validate it against the normal immutable command.
DROP TRIGGER "tool_invocations_command_coverage_trigger"
  ON public."tool_invocations";
CREATE CONSTRAINT TRIGGER "tool_invocations_command_coverage_trigger"
  AFTER UPDATE ON public."tool_invocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    NOT (
      OLD."status" = 'UNKNOWN'
      AND NEW."status" IN ('SUCCEEDED', 'FAILED')
    )
  )
  EXECUTE FUNCTION public.validate_tool_transition_command();

CREATE OR REPLACE FUNCTION public.validate_tool_reconciliation_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_command public."ToolInvocationCommandType";
BEGIN
  expected_command := CASE
    WHEN NEW."status" = 'SUCCEEDED' THEN 'SUCCEED'
    WHEN NEW."status" = 'FAILED' THEN 'FAIL'
    ELSE NULL
  END;
  IF expected_command IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public."tool_invocation_commands" command
    WHERE command."tenant_id" = NEW."tenant_id"
      AND command."tool_invocation_id" = NEW."id"
      AND command."expected_revision" = OLD."revision"
      AND command."result_revision" = NEW."revision"
      AND command."command" = expected_command
      AND command."provider_proof"->>'providerRequestId'
        = NEW."provider_request_id"
  ) THEN
    RAISE EXCEPTION 'Reconciliation transition requires one exact provider command.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_invocations_reconciliation_command';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "tool_invocations_reconciliation_command_trigger"
  AFTER UPDATE ON public."tool_invocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    OLD."status" = 'UNKNOWN'
    AND NEW."status" IN ('SUCCEEDED', 'FAILED')
  )
  EXECUTE FUNCTION public.validate_tool_reconciliation_command();

CREATE TRIGGER "tool_reconciliation_attempts_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_reconciliation_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();
CREATE TRIGGER "tool_reconciliation_receipts_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_reconciliation_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();

REVOKE ALL ON TABLE
  public."tool_reconciliation_attempts",
  public."tool_reconciliation_receipts"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_process, enterprise_agent_tool_gateway;
GRANT SELECT ON TABLE
  public."tool_reconciliation_attempts",
  public."tool_reconciliation_receipts"
  TO enterprise_agent_app, enterprise_agent_admin;
GRANT SELECT, INSERT ON TABLE
  public."tool_reconciliation_attempts",
  public."tool_reconciliation_receipts"
  TO enterprise_agent_tool_gateway;
GRANT SELECT ON TABLE public."outbox_events"
  TO enterprise_agent_tool_gateway;

ALTER TABLE public."tool_reconciliation_attempts"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tool_reconciliation_attempts"
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public."tool_reconciliation_receipts"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tool_reconciliation_receipts"
  FORCE ROW LEVEL SECURITY;

CREATE POLICY "tool_tenant_isolation"
  ON public."tool_reconciliation_attempts"
  AS RESTRICTIVE FOR ALL
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_tool_gateway
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "tool_tenant_isolation"
  ON public."tool_reconciliation_receipts"
  AS RESTRICTIVE FOR ALL
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_tool_gateway
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "tool_admin_access"
  ON public."tool_reconciliation_attempts"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin
  USING (true) WITH CHECK (true);
CREATE POLICY "tool_admin_access"
  ON public."tool_reconciliation_receipts"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin
  USING (true) WITH CHECK (true);
CREATE POLICY "tool_gateway_access"
  ON public."tool_reconciliation_attempts"
  AS PERMISSIVE FOR ALL TO enterprise_agent_tool_gateway
  USING (true) WITH CHECK (true);
CREATE POLICY "tool_gateway_access"
  ON public."tool_reconciliation_receipts"
  AS PERMISSIVE FOR ALL TO enterprise_agent_tool_gateway
  USING (true) WITH CHECK (true);
CREATE POLICY "tool_reconciliation_attempts_requester_read"
  ON public."tool_reconciliation_attempts"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    EXISTS (
      SELECT 1 FROM public."tool_invocations" invocation
      WHERE invocation."tenant_id" = "tool_reconciliation_attempts"."tenant_id"
        AND invocation."id" = "tool_reconciliation_attempts"."tool_invocation_id"
        AND invocation."requester_user_id"
          = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
CREATE POLICY "tool_reconciliation_receipts_requester_read"
  ON public."tool_reconciliation_receipts"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    EXISTS (
      SELECT 1 FROM public."tool_invocations" invocation
      WHERE invocation."tenant_id" = "tool_reconciliation_receipts"."tenant_id"
        AND invocation."id" = "tool_reconciliation_receipts"."tool_invocation_id"
        AND invocation."requester_user_id"
          = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

CREATE POLICY "tool_gateway_reconciliation_outbox_tenant"
  ON public."outbox_events"
  AS RESTRICTIVE FOR SELECT TO enterprise_agent_tool_gateway
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "tool_gateway_reconciliation_outbox_read"
  ON public."outbox_events"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_tool_gateway
  USING (
    "event_type" = 'ToolInvocation.ReconciliationRequested'
    AND "aggregate_type" = 'TOOL_INVOCATION'
  );
