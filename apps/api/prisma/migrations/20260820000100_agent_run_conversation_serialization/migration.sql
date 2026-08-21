-- Every accepted message receives a database order independent of transaction
-- timestamps. PostgreSQL now() is the transaction start time, so created_at is
-- not sufficient when concurrent transactions wait on a conversation lock.
CREATE SEQUENCE public."messages_sequence_seq";

ALTER TABLE public."messages"
  ADD COLUMN "sequence" bigint;

WITH ordered_messages AS (
  SELECT
    "id",
    row_number() OVER (ORDER BY "created_at", "id")::bigint AS "sequence"
  FROM public."messages"
)
UPDATE public."messages" AS message
SET "sequence" = ordered_messages."sequence"
FROM ordered_messages
WHERE ordered_messages."id" = message."id";

SELECT setval(
  'public."messages_sequence_seq"',
  COALESCE((SELECT max("sequence") + 1 FROM public."messages"), 1),
  false
);

ALTER SEQUENCE public."messages_sequence_seq"
  OWNED BY public."messages"."sequence";

ALTER TABLE public."messages"
  ALTER COLUMN "sequence" SET DEFAULT nextval('public."messages_sequence_seq"'),
  ALTER COLUMN "sequence" SET NOT NULL;

CREATE UNIQUE INDEX "messages_tenant_id_conversation_id_sequence_key"
  ON public."messages"("tenant_id", "conversation_id", "sequence");

-- A relay chain shares its root Run order. This keeps all turns for question N
-- ahead of question N+1 while still allowing different conversations to run in
-- parallel on separate Workers.
CREATE SEQUENCE public."agent_runs_conversation_sequence_seq";

ALTER TABLE public."agent_runs"
  ADD COLUMN "conversation_sequence" bigint;

WITH RECURSIVE run_roots AS (
  SELECT
    run."tenant_id",
    run."id",
    run."id" AS "root_id"
  FROM public."agent_runs" AS run
  WHERE run."parent_run_id" IS NULL

  UNION ALL

  SELECT
    child."tenant_id",
    child."id",
    parent."root_id"
  FROM public."agent_runs" AS child
  JOIN run_roots AS parent
    ON parent."tenant_id" = child."tenant_id"
   AND parent."id" = child."parent_run_id"
), root_order AS (
  SELECT
    root."tenant_id",
    root."id" AS "root_id",
    row_number() OVER (ORDER BY root."created_at", root."id")::bigint AS "sequence"
  FROM public."agent_runs" AS root
  WHERE root."parent_run_id" IS NULL
)
UPDATE public."agent_runs" AS run
SET "conversation_sequence" = root_order."sequence"
FROM run_roots
JOIN root_order
  ON root_order."tenant_id" = run_roots."tenant_id"
 AND root_order."root_id" = run_roots."root_id"
WHERE run."tenant_id" = run_roots."tenant_id"
  AND run."id" = run_roots."id";

SELECT setval(
  'public."agent_runs_conversation_sequence_seq"',
  COALESCE((SELECT max("conversation_sequence") + 1 FROM public."agent_runs"), 1),
  false
);

ALTER SEQUENCE public."agent_runs_conversation_sequence_seq"
  OWNED BY public."agent_runs"."conversation_sequence";

ALTER TABLE public."agent_runs"
  ALTER COLUMN "conversation_sequence"
    SET DEFAULT nextval('public."agent_runs_conversation_sequence_seq"'),
  ALTER COLUMN "conversation_sequence" SET NOT NULL;

DROP INDEX IF EXISTS public."agent_runs_tenant_id_conversation_id_status_created_at_id_idx";

CREATE INDEX "agent_runs_tenant_conversation_status_sequence_idx"
  ON public."agent_runs"(
    "tenant_id",
    "conversation_id",
    "status",
    "conversation_sequence",
    "turn_index",
    "id"
  );

-- conversation_sequence is part of the immutable execution identity. A Run
-- may change lifecycle state, but it cannot move to another position later.
CREATE OR REPLACE FUNCTION public.guard_agent_run_execution_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id"
     OR OLD."conversation_sequence" IS DISTINCT FROM NEW."conversation_sequence"
     OR OLD."input_message_id" IS DISTINCT FROM NEW."input_message_id"
     OR OLD."requester_user_id" IS DISTINCT FROM NEW."requester_user_id"
     OR OLD."agent_id" IS DISTINCT FROM NEW."agent_id"
     OR OLD."agent_version_id" IS DISTINCT FROM NEW."agent_version_id"
     OR OLD."parent_run_id" IS DISTINCT FROM NEW."parent_run_id"
     OR OLD."retry_of_run_id" IS DISTINCT FROM NEW."retry_of_run_id"
     OR OLD."trigger" IS DISTINCT FROM NEW."trigger"
     OR OLD."turn_index" IS DISTINCT FROM NEW."turn_index"
     OR OLD."turn_limit" IS DISTINCT FROM NEW."turn_limit"
     OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR OLD."policy_snapshot" IS DISTINCT FROM NEW."policy_snapshot"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'Agent Run execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

GRANT USAGE, SELECT ON SEQUENCE public."messages_sequence_seq"
  TO enterprise_agent_app;
GRANT USAGE, SELECT ON SEQUENCE public."agent_runs_conversation_sequence_seq"
  TO enterprise_agent_app;
