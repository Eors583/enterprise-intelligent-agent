BEGIN;

-- A monetary value of zero is meaningful only when the Runtime explicitly
-- reported it. Keep the timestamp separate from token usage verification so
-- standard OpenAI-compatible responses (which usually omit cost) are not
-- presented as a trusted zero-cost run.
ALTER TABLE public."agent_runs"
    ADD COLUMN "cost_recorded_at" timestamptz(6);

UPDATE public."agent_runs"
SET "cost_recorded_at" = "usage_recorded_at"
WHERE "usage_recorded_at" IS NOT NULL
  AND "cost_micros" > 0;

-- Old adapters represented missing usage as a trusted all-zero payload. A
-- successful non-empty answer cannot consume zero tokens, so convert those
-- rows back to unverified and restore the conservative reservation.
UPDATE public."agent_runs"
SET "usage_recorded_at" = NULL,
    "reserved_tokens" = GREATEST("reserved_tokens", 20000)
WHERE "status" = 'SUCCEEDED'::"AgentRunStatus"
  AND "usage_recorded_at" IS NOT NULL
  AND "total_tokens" = 0;

ALTER TABLE public."agent_runs"
    DROP CONSTRAINT "agent_runs_total_tokens_consistent_check",
    ADD CONSTRAINT "agent_runs_total_tokens_consistent_check"
        CHECK ("total_tokens" >= "input_tokens" + "output_tokens"),
    ADD CONSTRAINT "agent_runs_unverified_tokens_zero_check"
        CHECK (
            "usage_recorded_at" IS NOT NULL
            OR ("input_tokens" = 0 AND "output_tokens" = 0 AND "total_tokens" = 0)
        ),
    ADD CONSTRAINT "agent_runs_unverified_cost_zero_check"
        CHECK ("cost_recorded_at" IS NOT NULL OR "cost_micros" = 0);

CREATE INDEX "agent_runs_tenant_dispatch_started_at_idx"
    ON public."agent_runs"("tenant_id", "dispatch_started_at")
    WHERE "dispatch_started_at" IS NOT NULL;

-- The original restrictive policy named only the application role. Once the
-- admin read policy was added, admin SELECTs were therefore permissive without
-- a tenant restriction. PUBLIC makes the same tenant predicate mandatory for
-- every current and future role that receives a permissive policy.
DROP POLICY IF EXISTS tenant_isolation ON public."agent_runs";
CREATE POLICY tenant_isolation
ON public."agent_runs"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

COMMIT;
