-- A gateway-side validation or policy failure is still an execution attempt.
-- Persist an append-only receipt without a provider request id so operators can
-- distinguish "never dispatched" from an ambiguous provider delivery.

ALTER TABLE public."tool_execution_receipts"
  DROP CONSTRAINT "tool_execution_receipts_source_check",
  ADD CONSTRAINT "tool_execution_receipts_source_check" CHECK (
    (
      "source" = 'GATEWAY_VALIDATOR'
      AND "provider_request_id" IS NULL
    )
    OR (
      "source" IN ('PROVIDER', 'COMPENSATOR')
      AND "provider_request_id" IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION public.guard_tool_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_record public."tool_invocations"%ROWTYPE;
BEGIN
  SELECT *
    INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  IF invocation_record."id" IS NULL
     OR NEW."input_hash" <> invocation_record."input_hash"
     OR NEW."invocation_revision" NOT IN (
       invocation_record."revision", invocation_record."revision" + 1
     )
     OR NEW."execution_attempt" NOT IN (
       invocation_record."execution_attempt",
       invocation_record."execution_attempt" + 1
     ) THEN
    RAISE EXCEPTION 'Execution receipt is not bound to the current Invocation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_invocation_binding';
  END IF;
  IF NEW."source" = 'GATEWAY_VALIDATOR' AND NOT (
    (
      invocation_record."dry_run_mode" = 'VALIDATE_ONLY'
      AND invocation_record."dry_run"
      AND NOT invocation_record."provider_dispatch_allowed"
    )
    OR (
      invocation_record."status" = 'EXECUTING'
      AND invocation_record."provider_dispatch_allowed"
      AND NEW."outcome" = 'FAILED'
      AND NEW."provider_request_id" IS NULL
      AND NEW."response_hash" IS NULL
      AND NEW."cost_micros" = 0
    )
  ) THEN
    RAISE EXCEPTION 'Gateway receipts must be validate-only results or failed pre-dispatch attempts.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_validator_mode';
  END IF;
  IF NEW."source" = 'PROVIDER' AND NOT invocation_record."provider_dispatch_allowed" THEN
    RAISE EXCEPTION 'A provider receipt cannot exist for VALIDATE_ONLY.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_no_provider_dispatch';
  END IF;
  IF NEW."provider_dry_run" <> invocation_record."provider_dry_run" THEN
    RAISE EXCEPTION 'Receipt dry-run mode must match the immutable Invocation snapshot.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_dry_run_binding';
  END IF;
  IF invocation_record."risk_class" = 'DRAFT_ONLY'
     AND NEW."outcome" = 'SUCCEEDED'
     AND NOT NEW."draft_output" THEN
    RAISE EXCEPTION 'DRAFT_ONLY tools may only return a draft artifact.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_draft_only';
  END IF;
  IF invocation_record."adapter" = 'HTTP'
     AND NEW."source" = 'PROVIDER'
     AND NOT EXISTS (
       SELECT 1
       FROM public."tool_dns_resolution_proofs" proof
       WHERE proof."tenant_id" = NEW."tenant_id"
         AND proof."tool_invocation_id" = NEW."tool_invocation_id"
         AND proof."decision" = 'ALLOWED'
         AND proof."expires_at" > NEW."started_at"
         AND proof."pinned_ip_address" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'HTTP provider receipt requires the live DNS/IP pin used for dispatch.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_dns_binding';
  END IF;
  RETURN NEW;
END
$$;
