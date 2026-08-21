BEGIN;

CREATE TYPE public."AgentRunStreamEventType" AS ENUM (
  'DELTA',
  'TERMINAL',
  'TERMINAL_ONLY'
);

CREATE TABLE public."agent_run_stream_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "event_id" varchar(200) NOT NULL,
  "type" public."AgentRunStreamEventType" NOT NULL,
  "delta" text,
  "delta_hash" character(64),
  "terminal_status" public."AgentRunStatus",
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_run_stream_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_stream_events_sequence_bounds_check"
    CHECK ("sequence" BETWEEN 1 AND 10000),
  CONSTRAINT "agent_run_stream_events_event_id_shape_check"
    CHECK ("event_id" = "run_id"::text || ':' || "sequence"::text),
  CONSTRAINT "agent_run_stream_events_shape_check"
    CHECK (
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
          'TERMINAL_ONLY'::public."AgentRunStreamEventType"
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
    ),
  CONSTRAINT "agent_run_stream_events_tenant_id_run_id_sequence_key"
    UNIQUE ("tenant_id", "run_id", "sequence"),
  CONSTRAINT "agent_run_stream_events_tenant_id_run_id_event_id_key"
    UNIQUE ("tenant_id", "run_id", "event_id"),
  CONSTRAINT "agent_run_stream_events_tenant_id_run_id_fkey"
    FOREIGN KEY ("tenant_id", "run_id")
    REFERENCES public."agent_runs"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

CREATE INDEX "agent_run_stream_events_tenant_id_run_id_created_at_idx"
  ON public."agent_run_stream_events"("tenant_id", "run_id", "created_at");

CREATE UNIQUE INDEX "agent_run_stream_events_one_terminal_idx"
  ON public."agent_run_stream_events"("tenant_id", "run_id")
  WHERE "type" IN (
    'TERMINAL'::public."AgentRunStreamEventType",
    'TERMINAL_ONLY'::public."AgentRunStreamEventType"
  );

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
      -- An at-least-once worker replayed the exact append. Suppress the
      -- duplicate row after the per-Run advisory lock serialized contenders.
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
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.reject_agent_run_stream_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'agent_run_stream_events is append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER "agent_run_stream_events_insert_guard"
BEFORE INSERT ON public."agent_run_stream_events"
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_run_stream_event_insert();

CREATE TRIGGER "agent_run_stream_events_append_only"
BEFORE UPDATE OR DELETE ON public."agent_run_stream_events"
FOR EACH ROW
EXECUTE FUNCTION public.reject_agent_run_stream_event_mutation();

CREATE TRIGGER "agent_run_stream_events_reject_truncate"
BEFORE TRUNCATE ON public."agent_run_stream_events"
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_agent_run_stream_event_mutation();

ALTER TABLE public."agent_run_stream_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."agent_run_stream_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public."agent_run_stream_events"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (
  "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

CREATE POLICY enterprise_agent_stream_read
ON public."agent_run_stream_events"
AS PERMISSIVE
FOR SELECT
TO enterprise_agent_app
USING (true);

CREATE POLICY enterprise_agent_stream_append
ON public."agent_run_stream_events"
AS PERMISSIVE
FOR INSERT
TO enterprise_agent_app
WITH CHECK (true);

CREATE POLICY enterprise_agent_admin_stream_read
ON public."agent_run_stream_events"
AS PERMISSIVE
FOR SELECT
TO enterprise_agent_admin
USING (true);

REVOKE ALL ON TABLE public."agent_run_stream_events" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE public."agent_run_stream_events" TO enterprise_agent_app;
GRANT SELECT ON TABLE public."agent_run_stream_events" TO enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.guard_agent_run_stream_event_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_agent_run_stream_event_mutation() FROM PUBLIC;

COMMENT ON TABLE public."agent_run_stream_events" IS
  'Append-only, tenant-scoped Agent Run output deltas and terminal markers. Prompts and credentials are forbidden.';

COMMIT;
