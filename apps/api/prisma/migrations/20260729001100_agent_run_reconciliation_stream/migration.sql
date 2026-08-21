BEGIN;

ALTER TYPE public."AgentRunStreamEventType"
  ADD VALUE IF NOT EXISTS 'TERMINAL_RECONCILED';

COMMIT;

BEGIN;

ALTER TABLE public."agent_run_stream_events"
  DROP CONSTRAINT "agent_run_stream_events_shape_check",
  ADD CONSTRAINT "agent_run_stream_events_shape_check" CHECK (
    (
      "type" = 'DELTA'::public."AgentRunStreamEventType"
      AND "sequence" < 10000
      AND "delta" IS NOT NULL
      AND octet_length("delta") BETWEEN 1 AND 16384
      AND "delta_hash" ~ '^[a-f0-9]{64}$'
      AND "terminal_status" IS NULL
    )
    OR
    (
      "type" IN (
        'TERMINAL'::public."AgentRunStreamEventType",
        'TERMINAL_ONLY'::public."AgentRunStreamEventType",
        'TERMINAL_RECONCILED'::public."AgentRunStreamEventType"
      )
      AND "delta" IS NULL
      AND "delta_hash" IS NULL
      AND "terminal_status" IN (
        'SUCCEEDED'::public."AgentRunStatus",
        'FAILED'::public."AgentRunStatus",
        'UNKNOWN'::public."AgentRunStatus",
        'CANCELLED'::public."AgentRunStatus"
      )
    )
  );

CREATE UNIQUE INDEX "agent_run_stream_events_one_reconciled_terminal_idx"
  ON public."agent_run_stream_events" ("tenant_id", "run_id")
  WHERE "type" = 'TERMINAL_RECONCILED'::public."AgentRunStreamEventType";

CREATE OR REPLACE FUNCTION public.guard_agent_run_stream_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_sequence integer;
  accumulated_output_bytes bigint;
  current_run_status public."AgentRunStatus";
  expected_delta_hash text;
  existing_event public."agent_run_stream_events"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('agent-run-stream:' || NEW."tenant_id"::text || ':' || NEW."run_id"::text, 0)
  );

  SELECT event.*
  INTO existing_event
  FROM public."agent_run_stream_events" event
  WHERE event."tenant_id" = NEW."tenant_id"
    AND event."run_id" = NEW."run_id"
    AND event."sequence" = NEW."sequence";

  IF FOUND THEN
    IF existing_event."event_id" = NEW."event_id"
       AND existing_event."type" = NEW."type"
       AND existing_event."delta" IS NOT DISTINCT FROM NEW."delta"
       AND existing_event."delta_hash" IS NOT DISTINCT FROM NEW."delta_hash"
       AND existing_event."terminal_status" IS NOT DISTINCT FROM NEW."terminal_status" THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'agent_run_stream_events sequence conflicts with durable content'
      USING ERRCODE = '23505';
  END IF;

  SELECT coalesce(max(event."sequence"), 0) + 1
  INTO expected_sequence
  FROM public."agent_run_stream_events" event
  WHERE event."tenant_id" = NEW."tenant_id"
    AND event."run_id" = NEW."run_id";

  IF NEW."sequence" <> expected_sequence THEN
    RAISE EXCEPTION 'agent_run_stream_events sequence must be contiguous'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."type" = 'DELTA'::public."AgentRunStreamEventType" THEN
    SELECT run."status"
    INTO current_run_status
    FROM public."agent_runs" run
    WHERE run."tenant_id" = NEW."tenant_id"
      AND run."id" = NEW."run_id";
    IF current_run_status <> 'RUNNING'::public."AgentRunStatus" THEN
      RAISE EXCEPTION 'delta stream event requires a RUNNING Agent Run'
        USING ERRCODE = '23514';
    END IF;
    expected_delta_hash := encode(
      digest(convert_to(NEW."delta", 'UTF8'), 'sha256'),
      'hex'
    );
    IF NEW."delta_hash" <> expected_delta_hash THEN
      RAISE EXCEPTION 'agent_run_stream_events delta hash mismatch'
        USING ERRCODE = '23514';
    END IF;

    SELECT coalesce(sum(octet_length(event."delta")), 0) + octet_length(NEW."delta")
    INTO accumulated_output_bytes
    FROM public."agent_run_stream_events" event
    WHERE event."tenant_id" = NEW."tenant_id"
      AND event."run_id" = NEW."run_id"
      AND event."type" = 'DELTA'::public."AgentRunStreamEventType";
    IF accumulated_output_bytes > 1000000 THEN
      RAISE EXCEPTION 'agent_run_stream_events output exceeds one million bytes'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT run."status"
    INTO current_run_status
    FROM public."agent_runs" run
    WHERE run."tenant_id" = NEW."tenant_id"
      AND run."id" = NEW."run_id";
    IF current_run_status IS NULL OR current_run_status <> NEW."terminal_status" THEN
      RAISE EXCEPTION 'terminal stream event must match the durable Agent Run status'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."type" = 'TERMINAL_RECONCILED'::public."AgentRunStreamEventType" THEN
      IF NEW."terminal_status" = 'UNKNOWN'::public."AgentRunStatus"
         OR NOT EXISTS (
           SELECT 1
           FROM public."agent_run_stream_events" prior
           WHERE prior."tenant_id" = NEW."tenant_id"
             AND prior."run_id" = NEW."run_id"
             AND prior."type" IN (
               'TERMINAL'::public."AgentRunStreamEventType",
               'TERMINAL_ONLY'::public."AgentRunStreamEventType"
             )
             AND prior."terminal_status" = 'UNKNOWN'::public."AgentRunStatus"
         ) THEN
        RAISE EXCEPTION 'reconciled terminal requires a prior UNKNOWN terminal marker'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON TYPE public."AgentRunStreamEventType" IS
  'Append-only stream event type; TERMINAL_RECONCILED resolves a prior UNKNOWN marker without rewriting history.';

COMMIT;
