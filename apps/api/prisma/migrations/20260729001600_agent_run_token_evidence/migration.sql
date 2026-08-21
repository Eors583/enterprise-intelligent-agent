BEGIN;

CREATE TYPE public."AgentRunTokenEvidence" AS ENUM (
  'UNREPORTED',
  'PROVIDER_REPORTED',
  'QUOTA_UPPER_BOUND'
);

ALTER TABLE public."agent_runs"
  ADD COLUMN "token_evidence" public."AgentRunTokenEvidence"
    NOT NULL DEFAULT 'UNREPORTED',
  ADD COLUMN "quota_charged_tokens" integer NOT NULL DEFAULT 0,
  ADD COLUMN "quota_settled_at" timestamptz(6);

-- Existing positive Runtime usage remains provider evidence. Legacy all-zero
-- rows deliberately stay UNREPORTED: a timestamp alone must not turn 0/0/0
-- into a trusted provider receipt.
UPDATE public."agent_runs"
SET
  "token_evidence" = 'PROVIDER_REPORTED'::public."AgentRunTokenEvidence",
  "reserved_tokens" = 0
WHERE "usage_recorded_at" IS NOT NULL
  AND "total_tokens" > 0
  AND "status" IN (
    'SUCCEEDED'::public."AgentRunStatus",
    'FAILED'::public."AgentRunStatus",
    'CANCELLED'::public."AgentRunStatus"
  );

-- Resolve only confirmed terminal reservations. UNKNOWN can still be running
-- remotely and therefore retains both its concurrency slot and reservation.
UPDATE public."agent_runs"
SET
  "token_evidence" = 'QUOTA_UPPER_BOUND'::public."AgentRunTokenEvidence",
  "quota_charged_tokens" = "reserved_tokens",
  "quota_settled_at" = COALESCE("finished_at", "updated_at"),
  "usage_recorded_at" = NULL,
  "reserved_tokens" = 0
WHERE "status" IN (
    'SUCCEEDED'::public."AgentRunStatus",
    'FAILED'::public."AgentRunStatus",
    'CANCELLED'::public."AgentRunStatus"
  )
  AND (
    "usage_recorded_at" IS NULL
    OR "total_tokens" = 0
  )
  AND "reserved_tokens" > 0;

ALTER TABLE public."agent_runs"
  ADD CONSTRAINT "agent_runs_token_evidence_check"
  CHECK (
    (
      "token_evidence" = 'PROVIDER_REPORTED'::public."AgentRunTokenEvidence"
      AND "usage_recorded_at" IS NOT NULL
      AND "total_tokens" > 0
      AND "quota_charged_tokens" = 0
      AND "quota_settled_at" IS NULL
    )
    OR
    (
      "token_evidence" = 'QUOTA_UPPER_BOUND'::public."AgentRunTokenEvidence"
      AND "usage_recorded_at" IS NULL
      AND "quota_charged_tokens" > 0
      AND "quota_settled_at" IS NOT NULL
      AND "reserved_tokens" = 0
      AND "status" IN (
        'SUCCEEDED'::public."AgentRunStatus",
        'FAILED'::public."AgentRunStatus",
        'CANCELLED'::public."AgentRunStatus"
      )
    )
    OR
    (
      "token_evidence" = 'UNREPORTED'::public."AgentRunTokenEvidence"
      AND "quota_charged_tokens" = 0
      AND "quota_settled_at" IS NULL
    )
  ),
  ADD CONSTRAINT "agent_runs_unknown_quota_hold_check"
  CHECK (
    "status" <> 'UNKNOWN'::public."AgentRunStatus"
    OR (
      "token_evidence" = 'UNREPORTED'::public."AgentRunTokenEvidence"
      AND "quota_charged_tokens" = 0
      AND "quota_settled_at" IS NULL
    )
  );

CREATE INDEX "agent_runs_tenant_token_evidence_finished_at_idx"
  ON public."agent_runs" ("tenant_id", "token_evidence", "finished_at");

COMMENT ON COLUMN public."agent_runs"."token_evidence" IS
  'Trust boundary for token accounting. QUOTA_UPPER_BOUND is a conservative quota charge, never provider usage.';
COMMENT ON COLUMN public."agent_runs"."quota_charged_tokens" IS
  'Conservative terminal quota charge copied from the reservation when provider token usage is unavailable.';
COMMENT ON COLUMN public."agent_runs"."quota_settled_at" IS
  'Time a terminal reservation was converted into a conservative quota upper-bound charge.';

COMMIT;
