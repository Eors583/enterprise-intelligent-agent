-- A Process Step belongs to the Task referenced by its Process Instance.
-- The original runtime guards validate the Process Instance lifecycle, but a
-- Task can independently leave its active execution states. Fail closed here
-- so a delivered/accepted/rejected/cancelled Task cannot continue ordinary
-- work while still allowing the dedicated cancellation and compensation paths.

CREATE OR REPLACE FUNCTION public.guard_process_step_task_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  task_status public."TaskStatus";
  node_type public."ProcessNodeType";
  is_cancellation_or_compensation boolean;
BEGIN
  SELECT task."status", node."type"
    INTO task_status, node_type
  FROM public."process_instances" instance
  JOIN public."tasks" task
    ON task."tenant_id" = instance."tenant_id"
   AND task."id" = instance."task_id"
   AND task."version" = instance."task_version"
  JOIN public."process_nodes" node
    ON node."tenant_id" = instance."tenant_id"
   AND node."id" = NEW."process_node_id"
   AND node."process_version_id" = instance."process_version_id"
   AND node."process_version" = instance."process_version"
  WHERE instance."tenant_id" = NEW."tenant_id"
    AND instance."id" = NEW."process_instance_id"
  FOR SHARE OF instance, task, node;

  IF task_status IS NULL OR node_type IS NULL THEN
    RAISE EXCEPTION 'The Process Step requires a matching Task and Process node.'
      USING ERRCODE = '23503',
            CONSTRAINT = 'process_step_task_lifecycle_reference';
  END IF;

  is_cancellation_or_compensation :=
    NEW."status" IN (
      'CANCELLED',
      'COMPENSATING',
      'COMPENSATED',
      'COMPENSATION_FAILED'
    )
    OR NEW."compensation_for_step_id" IS NOT NULL
    OR node_type = 'COMPENSATION';

  IF task_status NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')
     AND NOT is_cancellation_or_compensation
  THEN
    RAISE EXCEPTION
      'A Task outside READY/IN_PROGRESS/BLOCKED cannot advance ordinary Process Steps.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_task_lifecycle_active';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER "process_step_task_lifecycle_insert_trigger"
  BEFORE INSERT ON public."process_step_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_step_task_lifecycle();

CREATE TRIGGER "process_step_task_lifecycle_transition_trigger"
  BEFORE UPDATE OF "status" ON public."process_step_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_step_task_lifecycle();

REVOKE ALL ON FUNCTION public.guard_process_step_task_lifecycle() FROM PUBLIC;
