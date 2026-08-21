-- A completed Agent Run is immutable as a lifecycle fact. Retries create a
-- new Run; reconciliation may move UNKNOWN back to RUNNING, but no ordinary
-- application write may revive SUCCEEDED, FAILED, or CANCELLED.
CREATE OR REPLACE FUNCTION public.guard_agent_run_terminal_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" IN (
       'SUCCEEDED'::public."AgentRunStatus",
       'FAILED'::public."AgentRunStatus",
       'CANCELLED'::public."AgentRunStatus"
     )
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A terminal Agent Run status is immutable; create a retry Run instead.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_runs_terminal_status_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "agent_runs_terminal_status_guard"
BEFORE UPDATE OF "status" ON public."agent_runs"
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_run_terminal_status();

REVOKE ALL ON FUNCTION public.guard_agent_run_terminal_status() FROM PUBLIC;

COMMENT ON FUNCTION public.guard_agent_run_terminal_status() IS
  'Prevents a successful, failed, or cancelled Agent Run from being revived; UNKNOWN remains explicitly reconcilable.';
