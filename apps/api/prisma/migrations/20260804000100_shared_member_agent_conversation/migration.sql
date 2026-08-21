-- A shared member conversation keeps human and Agent messages in one timeline.
-- These fields record only who should actively respond; all active human
-- participants continue to receive and read the message.
ALTER TABLE public."messages"
  ADD COLUMN "response_target_type" varchar(16),
  ADD COLUMN "response_target_id" uuid;

ALTER TABLE public."messages"
  ADD CONSTRAINT "messages_response_target_shape_ck"
  CHECK (
    ("response_target_type" IS NULL AND "response_target_id" IS NULL)
    OR
    ("response_target_type" IN ('HUMAN', 'AGENT') AND "response_target_id" IS NOT NULL)
  );

CREATE INDEX "messages_tenant_conversation_response_target_idx"
  ON public."messages" ("tenant_id", "conversation_id", "response_target_type", "response_target_id")
  WHERE "response_target_type" IS NOT NULL;
