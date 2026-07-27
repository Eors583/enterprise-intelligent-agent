-- Record the outcome-unknown boundary separately from a confirmed delivery
-- failure. PostgreSQL requires a newly-added enum value to be committed before
-- it can safely be referenced by a constraint.
BEGIN;

ALTER TYPE public."OutboxEventStatus" ADD VALUE 'UNKNOWN';

COMMIT;

BEGIN;

ALTER TABLE public."outbox_events"
    ADD COLUMN "first_attempted_at" timestamptz(6);

-- 004 predates the durable first-attempt timestamp. Preserve already-attempted
-- rows conservatively: terminal rows have necessarily had at least one attempt,
-- while pending retries use their creation time as the earliest known bound.
UPDATE public."outbox_events"
SET
    "attempts" = GREATEST("attempts", 1),
    "first_attempted_at" = COALESCE("published_at", "created_at")
WHERE "attempts" > 0
   OR "status" <> 'PENDING'::"OutboxEventStatus";

UPDATE public."outbox_events"
SET "last_error" = 'LEGACY_FAILURE: delivery failed before durable error tracking'
WHERE "status" = 'FAILED'::"OutboxEventStatus"
  AND "last_error" IS NULL;

ALTER TABLE public."outbox_events"
    DROP CONSTRAINT "outbox_events_published_state_check",
    ADD CONSTRAINT "outbox_events_attempt_state_check"
        CHECK (
            ("attempts" = 0 AND "first_attempted_at" IS NULL)
            OR ("attempts" > 0 AND "first_attempted_at" IS NOT NULL)
        ),
    ADD CONSTRAINT "outbox_events_delivery_state_check"
        CHECK (
            (
                "status" = 'PENDING'::"OutboxEventStatus"
                AND "published_at" IS NULL
                AND "provider_name" IS NULL
                AND "provider_receipt" IS NULL
            )
            OR (
                "status" = 'PUBLISHED'::"OutboxEventStatus"
                AND "published_at" IS NOT NULL
                AND "provider_name" IS NOT NULL
                AND "provider_receipt" IS NOT NULL
                AND "last_error" IS NULL
                AND "locked_by" IS NULL
                AND "locked_until" IS NULL
            )
            OR (
                "status" = 'FAILED'::"OutboxEventStatus"
                AND "published_at" IS NULL
                AND "provider_name" IS NULL
                AND "provider_receipt" IS NULL
                AND "last_error" IS NOT NULL
                AND "locked_by" IS NULL
                AND "locked_until" IS NULL
            )
            OR (
                "status" = 'UNKNOWN'::"OutboxEventStatus"
                AND "published_at" IS NULL
                AND "provider_name" IS NOT NULL
                AND "provider_receipt" = '{"outcome":"unknown","deliveredRecipientCount":0,"reason":"delivery_outcome_unknown"}'::jsonb
                AND "last_error" IS NOT NULL
                AND "locked_by" IS NULL
                AND "locked_until" IS NULL
            )
        );

-- 004 already grants status/provider/error/lease transitions. Only the newly
-- introduced claim timestamp needs an additional column-level privilege.
GRANT UPDATE ("first_attempted_at")
ON TABLE public."outbox_events"
TO enterprise_agent_outbox;

COMMIT;
