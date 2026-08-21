BEGIN;

ALTER TABLE public."agent_runs"
  ADD COLUMN "memory_context_snapshot" JSONB;

ALTER TABLE public."agent_runs"
  ADD CONSTRAINT "agent_runs_memory_context_snapshot_check"
  CHECK (
    "memory_context_snapshot" IS NULL
    OR (
      jsonb_typeof("memory_context_snapshot") = 'object'
      AND ("memory_context_snapshot" ->> 'schemaVersion') = '1'
      AND ("memory_context_snapshot" ->> 'purpose') = 'AGENT_RUN_CONTEXT'
      AND jsonb_typeof("memory_context_snapshot" -> 'contexts') = 'array'
      AND ("memory_context_snapshot" ->> 'snapshotSha256') ~ '^[a-f0-9]{64}$'
      AND ("memory_context_snapshot" ->> 'resolvedAt') IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION public.guard_agent_run_memory_context_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."memory_context_snapshot" IS NOT NULL
     AND NEW."memory_context_snapshot" IS DISTINCT FROM OLD."memory_context_snapshot" THEN
    RAISE EXCEPTION 'Agent Run memory context snapshot is immutable after dispatch.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_runs_memory_context_snapshot_immutable';
  END IF;

  IF OLD."memory_context_snapshot" IS NULL
     AND NEW."memory_context_snapshot" IS NOT NULL
     AND NOT (
       OLD."status" = 'QUEUED'::public."AgentRunStatus"
       AND NEW."status" = 'DISPATCHING'::public."AgentRunStatus"
     ) THEN
    RAISE EXCEPTION 'Agent Run memory context may only be sealed during dispatch.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_runs_memory_context_snapshot_dispatch_only';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_runs_memory_context_snapshot_guard"
  BEFORE UPDATE OF "memory_context_snapshot", "status"
  ON public."agent_runs"
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_agent_run_memory_context_snapshot();

REVOKE ALL ON FUNCTION public.guard_agent_run_memory_context_snapshot() FROM PUBLIC;

COMMIT;
