BEGIN;

-- A successful persisted answer cannot have trusted all-zero token usage.
-- Convert any pre-existing incompatible rows back to an unverified state and
-- retain a conservative quota hold before enforcing the invariant.
UPDATE public."agent_runs"
SET "input_tokens" = 0,
    "output_tokens" = 0,
    "total_tokens" = 0,
    "usage_recorded_at" = NULL,
    "reserved_tokens" = GREATEST("reserved_tokens", 20000)
WHERE "status" = 'SUCCEEDED'::"AgentRunStatus"
  AND "usage_recorded_at" IS NOT NULL
  AND (
    "total_tokens" = 0
    OR "input_tokens" + "output_tokens" = 0
  );

ALTER TABLE public."agent_runs"
    ADD CONSTRAINT "agent_runs_succeeded_reported_usage_positive_check"
        CHECK (
            "status" <> 'SUCCEEDED'::"AgentRunStatus"
            OR "usage_recorded_at" IS NULL
            OR (
                "total_tokens" > 0
                AND "input_tokens" + "output_tokens" > 0
            )
        );

COMMIT;
