-- Preserve the difference between an attested zero cost and missing metering.
-- Legacy provider zeroes are conservatively treated as unreported; only the
-- gateway's own validate/pre-dispatch receipts are safe to backfill as zero.
BEGIN;

CREATE TYPE public."ToolCostAttestation" AS ENUM (
  'UNATTESTED',
  'PROVIDER_ATTESTED',
  'GATEWAY_ATTESTED'
);

ALTER TABLE public."tool_execution_receipts"
  ALTER COLUMN "cost_micros" DROP NOT NULL,
  ALTER COLUMN "cost_micros" DROP DEFAULT,
  ADD COLUMN "cost_attestation" public."ToolCostAttestation" NOT NULL
    DEFAULT 'GATEWAY_ATTESTED';

UPDATE public."tool_execution_receipts"
SET
  "cost_attestation" = CASE
    WHEN "source" = 'GATEWAY_VALIDATOR'
      THEN 'GATEWAY_ATTESTED'::public."ToolCostAttestation"
    WHEN "cost_micros" > 0
      THEN 'PROVIDER_ATTESTED'::public."ToolCostAttestation"
    ELSE 'UNATTESTED'::public."ToolCostAttestation"
  END,
  "cost_micros" = CASE
    WHEN "source" <> 'GATEWAY_VALIDATOR' AND "cost_micros" = 0 THEN NULL
    ELSE "cost_micros"
  END;

ALTER TABLE public."tool_execution_receipts"
  DROP CONSTRAINT "tool_execution_receipts_time_check",
  ADD CONSTRAINT "tool_execution_receipts_time_check" CHECK (
    "completed_at" >= "started_at"
    AND "latency_ms" >= 0
    AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
  ),
  ADD CONSTRAINT "tool_execution_receipts_cost_attestation_check" CHECK (
    (
      "cost_attestation" = 'UNATTESTED'
      AND "cost_micros" IS NULL
    )
    OR (
      "cost_attestation" = 'PROVIDER_ATTESTED'
      AND "source" IN ('PROVIDER', 'COMPENSATOR')
      AND "cost_micros" IS NOT NULL
    )
    OR (
      "cost_attestation" = 'GATEWAY_ATTESTED'
      AND "source" IN ('GATEWAY_VALIDATOR', 'COMPENSATOR')
      AND "cost_micros" = 0
    )
  );

COMMENT ON COLUMN public."tool_execution_receipts"."cost_attestation" IS
  'UNATTESTED is missing metering, never a zero. Approved immutable FinOps prices may independently settle it.';

REVOKE ALL ON TYPE public."ToolCostAttestation" FROM PUBLIC;
GRANT USAGE ON TYPE public."ToolCostAttestation"
  TO enterprise_agent_app, enterprise_agent_admin,
     enterprise_agent_tool_gateway, enterprise_agent_finops_projector;

COMMIT;
