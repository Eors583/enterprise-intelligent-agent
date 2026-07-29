-- A Process Instance must stop ordinary progression as soon as its Task leaves
-- the active execution lifecycle. Cancellation and compensation remain
-- dedicated recovery paths and are intentionally allowed for terminal Tasks.

CREATE OR REPLACE FUNCTION public.guard_process_instance_task_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  task_status public."TaskStatus";
  is_cancellation_or_compensation boolean;
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  SELECT task."status"
    INTO task_status
  FROM public."tasks" task
  WHERE task."tenant_id" = NEW."tenant_id"
    AND task."id" = NEW."task_id"
    AND task."version" = NEW."task_version"
  FOR SHARE;

  IF task_status IS NULL THEN
    RAISE EXCEPTION 'The Process Instance requires its exact Task snapshot.'
      USING ERRCODE = '23503',
            CONSTRAINT = 'process_instances_task_lifecycle_reference';
  END IF;

  is_cancellation_or_compensation :=
    NEW."status" IN (
      'CANCELLED',
      'COMPENSATING',
      'COMPENSATED',
      'COMPENSATION_FAILED'
    );

  IF task_status NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')
     AND NOT is_cancellation_or_compensation
  THEN
    RAISE EXCEPTION
      'A Task outside READY/IN_PROGRESS/BLOCKED cannot advance its Process Instance.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_instances_task_lifecycle_active';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER "process_instances_task_lifecycle_transition_trigger"
  BEFORE UPDATE OF "status" ON public."process_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_instance_task_lifecycle();

REVOKE ALL ON FUNCTION public.guard_process_instance_task_lifecycle() FROM PUBLIC;
