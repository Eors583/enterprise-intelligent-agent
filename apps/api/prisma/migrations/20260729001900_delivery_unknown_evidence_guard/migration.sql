BEGIN;

-- Event ids are globally unique. Keep the tenant-qualified key for efficient
-- RLS lookups while also enforcing the public delivery identity promised by
-- the contract: one consumer delivery per immutable event.
CREATE UNIQUE INDEX "outbox_event_deliveries_event_consumer_key_global"
  ON public."outbox_event_deliveries" ("event_id", "consumer_key");

ALTER TABLE public."outbox_event_deliveries"
  ADD CONSTRAINT "outbox_event_deliveries_unknown_evidence_check"
  CHECK (
    "status" <> 'UNKNOWN'::public."OutboxEventStatus"
    OR (
      "attempts" > 0
      AND "first_attempted_at" IS NOT NULL
      AND "provider_name" IS NOT NULL
      AND btrim("provider_name") <> ''
      AND "provider_receipt" IS NOT NULL
      AND jsonb_typeof("provider_receipt") = 'object'
      AND "last_error" IS NOT NULL
      AND btrim("last_error") <> ''
      AND "acknowledged_at" IS NULL
      AND "locked_by" IS NULL
      AND "locked_until" IS NULL
    )
  ) NOT VALID;

-- Existing UNKNOWN rows are immutable evidence and are never rewritten to a
-- successful outcome. Fresh or already-complete datasets can validate the
-- constraint immediately; older incomplete rows remain visible for the
-- audited reconciliation command while every new write is still enforced.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."outbox_event_deliveries"
    WHERE "status" = 'UNKNOWN'::public."OutboxEventStatus"
      AND NOT (
        "attempts" > 0
        AND "first_attempted_at" IS NOT NULL
        AND "provider_name" IS NOT NULL
        AND btrim("provider_name") <> ''
        AND "provider_receipt" IS NOT NULL
        AND jsonb_typeof("provider_receipt") = 'object'
        AND "last_error" IS NOT NULL
        AND btrim("last_error") <> ''
        AND "acknowledged_at" IS NULL
        AND "locked_by" IS NULL
        AND "locked_until" IS NULL
      )
  ) THEN
    ALTER TABLE public."outbox_event_deliveries"
      VALIDATE CONSTRAINT "outbox_event_deliveries_unknown_evidence_check";
  END IF;
END
$$;

COMMENT ON CONSTRAINT "outbox_event_deliveries_unknown_evidence_check"
  ON public."outbox_event_deliveries" IS
  'UNKNOWN is a conservative delivery outcome backed by an attempted provider call, receipt, and diagnostic evidence.';

COMMIT;
