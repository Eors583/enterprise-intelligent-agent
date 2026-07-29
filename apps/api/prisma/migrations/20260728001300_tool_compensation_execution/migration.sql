-- Governed Tool compensation execution.
--
-- A compensation is a separate Tool Invocation. Its payload is derived from
-- the immutable original receipt, never accepted from a caller, and it must
-- pass the same policy, confirmation and maker-checker approval gates as every
-- other invocation. The original invocation changes state only in the worker
-- transaction that starts or settles the bound compensation invocation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public."tool_compensation_bindings" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "original_invocation_id" UUID NOT NULL,
  "compensation_invocation_id" UUID NOT NULL,
  "original_tool_version_id" UUID NOT NULL,
  "compensation_tool_version_id" UUID NOT NULL,
  "original_input_hash" VARCHAR(64) NOT NULL,
  "original_provider_request_id" VARCHAR(300) NOT NULL,
  "original_output_hash" VARCHAR(64) NOT NULL,
  "compensation_input_hash" VARCHAR(64) NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "requested_by_role_assignment_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_compensation_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_compensation_bindings_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_compensation_bindings_child_key"
    UNIQUE ("tenant_id", "compensation_invocation_id"),
  CONSTRAINT "tool_compensation_bindings_request_key"
    UNIQUE ("tenant_id", "original_invocation_id", "idempotency_key"),
  CONSTRAINT "tool_compensation_bindings_distinct_invocation_check" CHECK (
    "original_invocation_id" <> "compensation_invocation_id"
  ),
  CONSTRAINT "tool_compensation_bindings_hash_check" CHECK (
    "original_input_hash" ~ '^[0-9a-f]{64}$'
    AND "original_output_hash" ~ '^[0-9a-f]{64}$'
    AND "compensation_input_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tool_compensation_bindings_text_check" CHECK (
    btrim("original_provider_request_id") <> ''
    AND btrim("idempotency_key") <> ''
  ),
  CONSTRAINT "tool_compensation_bindings_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_compensation_bindings_original_invocation_fkey"
    FOREIGN KEY ("tenant_id", "original_invocation_id")
    REFERENCES public."tool_invocations" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_compensation_bindings_compensation_invocation_fkey"
    FOREIGN KEY ("tenant_id", "compensation_invocation_id")
    REFERENCES public."tool_invocations" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_compensation_bindings_original_version_fkey"
    FOREIGN KEY ("tenant_id", "original_tool_version_id")
    REFERENCES public."tool_versions" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_compensation_bindings_compensation_version_fkey"
    FOREIGN KEY ("tenant_id", "compensation_tool_version_id")
    REFERENCES public."tool_versions" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_compensation_bindings_requester_fkey"
    FOREIGN KEY ("tenant_id", "requested_by_user_id")
    REFERENCES public."users" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tool_compensation_bindings_assignment_fkey"
    FOREIGN KEY ("tenant_id", "requested_by_role_assignment_id")
    REFERENCES public."role_assignments" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "tool_compensation_bindings_original_idx"
  ON public."tool_compensation_bindings" (
    "tenant_id", "original_invocation_id", "created_at" DESC
  );

-- At most one unresolved or successful compensation can exist for an
-- original invocation. A denied/cancelled/failed child remains auditable but
-- does not block a new explicitly governed request.
CREATE UNIQUE INDEX "tool_invocations_one_live_compensation_idx"
  ON public."tool_invocations" (
    "tenant_id", "compensation_for_invocation_id"
  )
  WHERE "compensation_for_invocation_id" IS NOT NULL
    AND "status" NOT IN (
      'POLICY_DENIED', 'REJECTED', 'FAILED', 'CANCELLED'
    );

CREATE OR REPLACE FUNCTION public.guard_tool_compensation_version_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  compensation_version public."tool_versions"%ROWTYPE;
  compensation_definition public."tool_definitions"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'PUBLISHED'
     OR NEW."compensation_tool_version_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO compensation_version
  FROM public."tool_versions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."compensation_tool_version_id"
  FOR SHARE;
  SELECT * INTO compensation_definition
  FROM public."tool_definitions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = compensation_version."tool_id"
  FOR SHARE;
  IF compensation_version."id" IS NULL
     OR compensation_version."status" <> 'PUBLISHED'
     OR compensation_version."risk_class" IN (
       'READ_ONLY', 'DRAFT_ONLY', 'FORBIDDEN'
     )
     OR compensation_version."effective_from" > CURRENT_TIMESTAMP
     OR (
       compensation_version."effective_to" IS NOT NULL
       AND compensation_version."effective_to" <= CURRENT_TIMESTAMP
     )
     OR compensation_definition."status" <> 'PUBLISHED'
     OR compensation_definition."current_version_id"
       IS DISTINCT FROM compensation_version."id"
     OR compensation_definition."current_version"
       IS DISTINCT FROM compensation_version."version" THEN
    RAISE EXCEPTION 'A published Tool may reference only the current published side-effecting compensator.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_versions_compensator_published';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_tool_compensation_version_publication()
  FROM PUBLIC;
CREATE TRIGGER "tool_versions_compensation_publication_guard_trigger"
  BEFORE UPDATE ON public."tool_versions"
  FOR EACH ROW
  WHEN (
    NEW."status" = 'PUBLISHED'
    AND NEW."compensation_tool_version_id" IS NOT NULL
  )
  EXECUTE FUNCTION public.guard_tool_compensation_version_publication();

CREATE OR REPLACE FUNCTION public.guard_tool_compensation_invocation_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  original_record public."tool_invocations"%ROWTYPE;
  source_version public."tool_versions"%ROWTYPE;
  compensation_version public."tool_versions"%ROWTYPE;
  compensation_definition public."tool_definitions"%ROWTYPE;
BEGIN
  IF NEW."compensation_for_invocation_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."compensation_for_invocation_id"
  FOR SHARE;
  SELECT * INTO source_version
  FROM public."tool_versions"
  WHERE "tenant_id" = original_record."tenant_id"
    AND "id" = original_record."tool_version_id"
    AND "tool_id" = original_record."tool_id"
    AND "version" = original_record."tool_version"
    AND "configuration_hash" = original_record."tool_configuration_hash"
  FOR SHARE;
  SELECT * INTO compensation_version
  FROM public."tool_versions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_version_id"
    AND "tool_id" = NEW."tool_id"
    AND "version" = NEW."tool_version"
    AND "configuration_hash" = NEW."tool_configuration_hash"
  FOR SHARE;
  SELECT * INTO compensation_definition
  FROM public."tool_definitions"
  WHERE "tenant_id" = compensation_version."tenant_id"
    AND "id" = compensation_version."tool_id"
  FOR SHARE;
  IF original_record."id" IS NULL
     OR original_record."status" <> 'SUCCEEDED'
     OR original_record."dry_run"
     OR original_record."risk_class" IN (
       'READ_ONLY', 'DRAFT_ONLY', 'FORBIDDEN'
     )
     OR original_record."provider_request_id" IS NULL
     OR original_record."output_hash" IS NULL
     OR source_version."id" IS NULL
     OR source_version."compensation_tool_version_id"
       IS DISTINCT FROM NEW."tool_version_id"
     OR compensation_version."id" IS NULL
     OR compensation_version."status" <> 'PUBLISHED'
     OR compensation_version."effective_from" > CURRENT_TIMESTAMP
     OR (
       compensation_version."effective_to" IS NOT NULL
       AND compensation_version."effective_to" <= CURRENT_TIMESTAMP
     )
     OR compensation_version."risk_class" IN (
       'READ_ONLY', 'DRAFT_ONLY', 'FORBIDDEN'
     )
     OR compensation_definition."id" IS NULL
     OR compensation_definition."status" <> 'PUBLISHED'
     OR compensation_definition."current_version_id"
       IS DISTINCT FROM compensation_version."id"
     OR compensation_definition."current_version"
       IS DISTINCT FROM compensation_version."version"
     OR NEW."requester_user_id" <> original_record."requester_user_id"
     OR NEW."role_assignment_id" <> original_record."role_assignment_id"
     OR NEW."task_id" <> original_record."task_id"
     OR NEW."process_instance_id"
       IS DISTINCT FROM original_record."process_instance_id"
     -- A compensation can be requested after its originating process step has
     -- finished. The original step identity remains in the immutable envelope;
     -- the new governed invocation must not claim to run inside a stale step.
     OR NEW."process_step_instance_id" IS NOT NULL
     OR NEW."agent_run_id" IS DISTINCT FROM original_record."agent_run_id"
     OR NEW."correlation_id" <> original_record."correlation_id"
     OR NEW."causation_id" IS DISTINCT FROM original_record."id"
     OR NEW."retry_of_invocation_id" IS NOT NULL
     OR NEW."dry_run"
     OR NEW."input"->>'operation' IS DISTINCT FROM 'COMPENSATE'
     OR NEW."input"->'original'->>'invocationId'
       IS DISTINCT FROM original_record."id"::text
     OR NEW."input"->'original'->>'toolId'
       IS DISTINCT FROM original_record."tool_id"::text
     OR NEW."input"->'original'->>'toolVersionId'
       IS DISTINCT FROM original_record."tool_version_id"::text
     OR (NEW."input"->'original'->>'toolVersion')::integer
       IS DISTINCT FROM original_record."tool_version"
     OR NEW."input"->'original'->>'toolConfigurationHash'
       IS DISTINCT FROM original_record."tool_configuration_hash"
     OR NEW."input"->'original'->>'inputHash'
       IS DISTINCT FROM original_record."input_hash"
     OR NEW."input"->'original'->>'providerRequestId'
       IS DISTINCT FROM original_record."provider_request_id"
     OR NEW."input"->'original'->>'outputHash'
       IS DISTINCT FROM original_record."output_hash"
     OR NEW."input"->'payload'->'input'
       IS DISTINCT FROM original_record."input"
     OR NEW."input"->'payload'->'output'
       IS DISTINCT FROM original_record."output" THEN
    RAISE EXCEPTION 'Compensation Invocation is not bound to one trusted original provider receipt.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_invocations_compensation_binding';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_tool_compensation_invocation_insert()
  FROM PUBLIC;
CREATE TRIGGER "tool_invocations_compensation_insert_guard_trigger"
  BEFORE INSERT ON public."tool_invocations"
  FOR EACH ROW
  WHEN (NEW."compensation_for_invocation_id" IS NOT NULL)
  EXECUTE FUNCTION public.guard_tool_compensation_invocation_insert();

CREATE OR REPLACE FUNCTION public.guard_tool_compensation_binding_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  original_record public."tool_invocations"%ROWTYPE;
  child_record public."tool_invocations"%ROWTYPE;
  source_version public."tool_versions"%ROWTYPE;
BEGIN
  SELECT * INTO original_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."original_invocation_id"
  FOR SHARE;
  SELECT * INTO child_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."compensation_invocation_id"
  FOR SHARE;
  SELECT * INTO source_version
  FROM public."tool_versions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."original_tool_version_id"
  FOR SHARE;
  IF original_record."id" IS NULL
     OR child_record."id" IS NULL
     OR child_record."status" <> 'REQUESTED'
     OR child_record."compensation_for_invocation_id"
       IS DISTINCT FROM original_record."id"
     OR child_record."tool_version_id"
       IS DISTINCT FROM NEW."compensation_tool_version_id"
     OR source_version."id" IS NULL
     OR source_version."compensation_tool_version_id"
       IS DISTINCT FROM NEW."compensation_tool_version_id"
     OR original_record."tool_version_id"
       IS DISTINCT FROM NEW."original_tool_version_id"
     OR original_record."input_hash"
       IS DISTINCT FROM NEW."original_input_hash"
     OR original_record."provider_request_id"
       IS DISTINCT FROM NEW."original_provider_request_id"
     OR original_record."output_hash"
       IS DISTINCT FROM NEW."original_output_hash"
     OR child_record."input_hash"
       IS DISTINCT FROM NEW."compensation_input_hash"
     OR child_record."requester_user_id"
       IS DISTINCT FROM NEW."requested_by_user_id"
     OR child_record."role_assignment_id"
       IS DISTINCT FROM NEW."requested_by_role_assignment_id"
     OR child_record."idempotency_key"
       IS DISTINCT FROM NEW."idempotency_key" THEN
    RAISE EXCEPTION 'Compensation ledger binding does not match its immutable invocations.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_compensation_bindings_invocation_binding';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_tool_compensation_binding_insert()
  FROM PUBLIC;
CREATE TRIGGER "tool_compensation_bindings_insert_guard_trigger"
  BEFORE INSERT ON public."tool_compensation_bindings"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_compensation_binding_insert();

-- Strengthen the original generic compensation proof with the exact child
-- invocation, configured compensation version and immutable provider receipt.
CREATE OR REPLACE FUNCTION public.guard_tool_compensation_command_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  original_record public."tool_invocations"%ROWTYPE;
  child_record public."tool_invocations"%ROWTYPE;
  binding_record public."tool_compensation_bindings"%ROWTYPE;
  receipt_valid boolean;
BEGIN
  SELECT * INTO original_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  SELECT * INTO child_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = (NEW."compensation_proof"->>'compensationInvocationId')::uuid
  FOR SHARE;
  SELECT * INTO binding_record
  FROM public."tool_compensation_bindings"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "original_invocation_id" = NEW."tool_invocation_id"
    AND "compensation_invocation_id" = child_record."id"
  FOR SHARE;
  receipt_valid := NEW."command" = 'BEGIN_COMPENSATION' OR EXISTS (
    SELECT 1
    FROM (
      SELECT receipt."receipt_hash"
      FROM public."tool_execution_receipts" receipt
      WHERE receipt."tenant_id" = NEW."tenant_id"
        AND receipt."tool_invocation_id" = child_record."id"
      UNION ALL
      SELECT receipt."receipt_hash"
      FROM public."tool_reconciliation_receipts" receipt
      WHERE receipt."tenant_id" = NEW."tenant_id"
        AND receipt."tool_invocation_id" = child_record."id"
    ) trusted_receipt
    WHERE trusted_receipt."receipt_hash" =
      NEW."compensation_proof"->>'compensationReceiptHash'
  );
  IF original_record."id" IS NULL
     OR child_record."id" IS NULL
     OR binding_record."id" IS NULL
     OR NEW."compensation_proof" IS NULL
     OR NOT (NEW."compensation_proof" ?& ARRAY[
       'tenantId', 'invocationId', 'toolVersionId', 'inputHash',
       'compensationInvocationId', 'compensationToolVersionId',
       'compensationInputHash', 'originalProviderRequestId',
       'originalOutputHash', 'compensationReceiptHash',
       'authorizedCommand'
     ])
     OR NEW."compensation_proof"->>'tenantId'
       IS DISTINCT FROM original_record."tenant_id"::text
     OR NEW."compensation_proof"->>'invocationId'
       IS DISTINCT FROM original_record."id"::text
     OR NEW."compensation_proof"->>'toolVersionId'
       IS DISTINCT FROM original_record."tool_version_id"::text
     OR NEW."compensation_proof"->>'inputHash'
       IS DISTINCT FROM original_record."input_hash"
     OR NEW."compensation_proof"->>'compensationInvocationId'
       IS DISTINCT FROM child_record."id"::text
     OR NEW."compensation_proof"->>'compensationToolVersionId'
       IS DISTINCT FROM child_record."tool_version_id"::text
     OR NEW."compensation_proof"->>'compensationInputHash'
       IS DISTINCT FROM child_record."input_hash"
     OR NEW."compensation_proof"->>'originalProviderRequestId'
       IS DISTINCT FROM original_record."provider_request_id"
     OR NEW."compensation_proof"->>'originalOutputHash'
       IS DISTINCT FROM original_record."output_hash"
     OR NEW."compensation_proof"->>'authorizedCommand'
       IS DISTINCT FROM NEW."command"::text
     OR (
       NEW."command" = 'BEGIN_COMPENSATION'
       AND (
         original_record."status" <> 'SUCCEEDED'
         OR child_record."status" NOT IN ('APPROVED', 'EXECUTING')
         OR NEW."compensation_proof"->'compensationReceiptHash'
           IS DISTINCT FROM 'null'::jsonb
       )
     )
     OR (
       NEW."command" IN ('COMPLETE_COMPENSATION', 'FAIL_COMPENSATION')
       AND (
         original_record."status" <> 'COMPENSATING'
         OR child_record."status" NOT IN ('EXECUTING', 'SUCCEEDED', 'FAILED')
         OR NOT receipt_valid
       )
     ) THEN
    RAISE EXCEPTION 'Compensation command is not bound to the configured compensator and trusted receipt.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_invocation_commands_compensation_receipt_binding';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_tool_compensation_command_binding()
  FROM PUBLIC;
CREATE TRIGGER "tool_invocation_commands_compensation_binding_trigger"
  BEFORE INSERT ON public."tool_invocation_commands"
  FOR EACH ROW
  WHEN (NEW."command" IN (
    'BEGIN_COMPENSATION', 'COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'
  ))
  EXECUTE FUNCTION public.guard_tool_compensation_command_binding();

-- UNKNOWN compensation delivery is never replayed. If the reconciliation
-- worker later resolves the child from its status-only endpoint, this trigger
-- consumes that immutable reconciliation receipt and settles the original in
-- the same transaction.
CREATE OR REPLACE FUNCTION public.finalize_tool_compensation_after_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  binding_record public."tool_compensation_bindings"%ROWTYPE;
  original_record public."tool_invocations"%ROWTYPE;
  reconciliation_receipt public."tool_reconciliation_receipts"%ROWTYPE;
  compensation_status public."ToolInvocationStatus";
  compensation_outcome public."ToolExecutionReceiptOutcome";
  compensation_command public."ToolInvocationCommandType";
  compensation_proof jsonb;
  compensation_request_hash text;
  compensation_receipt_hash text;
  compensation_started_at timestamptz;
  compensation_error_detail text;
BEGIN
  IF NEW."compensation_for_invocation_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO binding_record
  FROM public."tool_compensation_bindings"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "original_invocation_id" = NEW."compensation_for_invocation_id"
    AND "compensation_invocation_id" = NEW."id"
  FOR SHARE;
  SELECT * INTO original_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."compensation_for_invocation_id"
  FOR UPDATE;
  SELECT * INTO reconciliation_receipt
  FROM public."tool_reconciliation_receipts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "tool_invocation_id" = NEW."id"
    AND "invocation_revision" = NEW."revision"
    AND "provider_request_id" = NEW."provider_request_id"
    AND "resolution"::text = NEW."status"::text
    AND "proof_type" IS NOT NULL
    AND "proof_id" IS NOT NULL
    AND "proof_hash" IS NOT NULL
  ORDER BY "created_at" DESC
  LIMIT 1
  FOR SHARE;
  IF binding_record."id" IS NULL
     OR original_record."id" IS NULL
     OR original_record."status" <> 'COMPENSATING'
     OR reconciliation_receipt."id" IS NULL
     OR binding_record."original_tool_version_id"
       IS DISTINCT FROM original_record."tool_version_id"
     OR binding_record."compensation_tool_version_id"
       IS DISTINCT FROM NEW."tool_version_id"
     OR binding_record."original_input_hash"
       IS DISTINCT FROM original_record."input_hash"
     OR binding_record."original_provider_request_id"
       IS DISTINCT FROM original_record."provider_request_id"
     OR binding_record."original_output_hash"
       IS DISTINCT FROM original_record."output_hash"
     OR binding_record."compensation_input_hash"
       IS DISTINCT FROM NEW."input_hash" THEN
    RAISE EXCEPTION 'Reconciled compensation is not bound to its immutable original receipt.'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tool_compensation_reconciliation_binding';
  END IF;

  compensation_status := CASE
    WHEN NEW."status" = 'SUCCEEDED' THEN 'COMPENSATED'
    ELSE 'COMPENSATION_FAILED'
  END;
  compensation_outcome :=
    compensation_status::text::public."ToolExecutionReceiptOutcome";
  compensation_command := CASE
    WHEN NEW."status" = 'SUCCEEDED' THEN 'COMPLETE_COMPENSATION'
    ELSE 'FAIL_COMPENSATION'
  END;
  compensation_started_at := COALESCE(
    NEW."started_at", reconciliation_receipt."started_at"
  );
  compensation_request_hash := encode(
    digest(
      convert_to(
        concat_ws(
          '|',
          original_record."id"::text,
          original_record."provider_request_id",
          original_record."input_hash",
          NEW."id"::text,
          NEW."tool_version_id"::text,
          NEW."input_hash",
          NEW."provider_request_id"
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  compensation_receipt_hash := encode(
    digest(
      convert_to(
        concat_ws(
          '|',
          original_record."id"::text,
          (original_record."revision" + 1)::text,
          compensation_status::text,
          compensation_request_hash,
          reconciliation_receipt."receipt_hash",
          compensation_started_at::text,
          reconciliation_receipt."completed_at"::text
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  compensation_proof := jsonb_build_object(
    'tenantId', original_record."tenant_id",
    'invocationId', original_record."id",
    'toolVersionId', original_record."tool_version_id",
    'inputHash', original_record."input_hash",
    'compensationInvocationId', NEW."id",
    'compensationToolVersionId', NEW."tool_version_id",
    'compensationInputHash', NEW."input_hash",
    'originalProviderRequestId', original_record."provider_request_id",
    'originalOutputHash', original_record."output_hash",
    'compensationReceiptHash', reconciliation_receipt."receipt_hash",
    'authorizedCommand', compensation_command
  );
  INSERT INTO public."tool_execution_receipts" (
    "id", "tenant_id", "tool_invocation_id", "invocation_revision",
    "execution_attempt", "source", "outcome", "provider_request_id",
    "input_hash", "request_hash", "response_hash", "provider_dry_run",
    "draft_output", "started_at", "completed_at", "latency_ms",
    "cost_micros", "receipt_hash"
  ) VALUES (
    gen_random_uuid(),
    original_record."tenant_id",
    original_record."id",
    original_record."revision" + 1,
    original_record."execution_attempt",
    'COMPENSATOR',
    compensation_outcome,
    NEW."provider_request_id",
    original_record."input_hash",
    compensation_request_hash,
    reconciliation_receipt."receipt_hash",
    original_record."provider_dry_run",
    false,
    compensation_started_at,
    reconciliation_receipt."completed_at",
    GREATEST(
      0,
      floor(
        extract(
          epoch FROM (
            reconciliation_receipt."completed_at" - compensation_started_at
          )
        ) * 1000
      )::integer
    ),
    0,
    compensation_receipt_hash
  );
  INSERT INTO public."tool_invocation_commands" (
    "id", "tenant_id", "tool_invocation_id", "command",
    "expected_revision", "result_revision", "actor_type",
    "actor_user_id", "actor_role_assignment_id",
    "actor_service_principal_id", "reason", "policy_proof",
    "confirmation_proof", "approval_proof", "provider_proof",
    "compensation_proof", "idempotency_key", "request_hash",
    "occurred_at"
  ) VALUES (
    gen_random_uuid(),
    original_record."tenant_id",
    original_record."id",
    compensation_command,
    original_record."revision",
    original_record."revision" + 1,
    'SYSTEM',
    NULL,
    NULL,
    '00000000-0000-7000-8000-00000000a004'::uuid,
    'Reconciliation resolved the compensation child without replaying the original operation.',
    NULL,
    NULL,
    NULL,
    NULL,
    compensation_proof,
    'tool-reconcile-compensation:' || reconciliation_receipt."receipt_hash",
    original_record."input_hash",
    reconciliation_receipt."completed_at"
  );
  compensation_error_detail := CASE
    WHEN NEW."status" = 'FAILED' THEN left(
      'Compensation invocation ' || NEW."id"::text ||
      ' failed after reconciliation: ' ||
      COALESCE(NEW."error_code", 'TOOL_PROVIDER_FAILED') || ' - ' ||
      COALESCE(NEW."error_detail", 'No provider detail was returned.'),
      2000
    )
    ELSE NULL
  END;
  UPDATE public."tool_invocations"
  SET "status" = compensation_status,
      "revision" = "revision" + 1,
      "error_code" = CASE
        WHEN NEW."status" = 'FAILED' THEN 'TOOL_COMPENSATION_FAILED'
        ELSE NULL
      END,
      "error_detail" = compensation_error_detail,
      "completed_at" = reconciliation_receipt."completed_at",
      "updated_at" = reconciliation_receipt."completed_at"
  WHERE "tenant_id" = original_record."tenant_id"
    AND "id" = original_record."id"
    AND "revision" = original_record."revision"
    AND "status" = 'COMPENSATING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original compensation revision changed during reconciliation.'
      USING ERRCODE = '40001',
        CONSTRAINT = 'tool_compensation_reconciliation_cas';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.finalize_tool_compensation_after_reconciliation()
  FROM PUBLIC;
CREATE TRIGGER "tool_invocations_compensation_reconciliation_trigger"
  AFTER UPDATE ON public."tool_invocations"
  FOR EACH ROW
  WHEN (
    OLD."status" = 'UNKNOWN'
    AND NEW."status" IN ('SUCCEEDED', 'FAILED')
    AND NEW."compensation_for_invocation_id" IS NOT NULL
  )
  EXECUTE FUNCTION public.finalize_tool_compensation_after_reconciliation();

CREATE TRIGGER "tool_compensation_bindings_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_compensation_bindings"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();

REVOKE ALL ON TABLE public."tool_compensation_bindings"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_process, enterprise_agent_tool_gateway;
GRANT SELECT ON TABLE public."tool_compensation_bindings"
  TO enterprise_agent_app, enterprise_agent_admin;
GRANT SELECT, INSERT ON TABLE public."tool_compensation_bindings"
  TO enterprise_agent_tool_gateway;

ALTER TABLE public."tool_compensation_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tool_compensation_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tool_tenant_isolation"
  ON public."tool_compensation_bindings"
  AS RESTRICTIVE FOR ALL
  TO enterprise_agent_app, enterprise_agent_admin,
     enterprise_agent_tool_gateway
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "tool_admin_access"
  ON public."tool_compensation_bindings"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin
  USING (true) WITH CHECK (true);
CREATE POLICY "tool_gateway_access"
  ON public."tool_compensation_bindings"
  AS PERMISSIVE FOR ALL TO enterprise_agent_tool_gateway
  USING (true) WITH CHECK (true);
CREATE POLICY "tool_compensation_requester_read"
  ON public."tool_compensation_bindings"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    "requested_by_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
  );
