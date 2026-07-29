BEGIN;

-- Message rows are append-only to the application/projector role. PostgreSQL
-- row-locking clauses require UPDATE privilege, so only lock the mutable
-- feedback and Run records. The input/output message snapshots remain
-- immutable by table privilege.
DO $migration$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.project_not_helpful_answer_feedback_bad_case(uuid)'::regprocedure
  )
  INTO function_definition;

  IF strpos(
    function_definition,
    'FOR SHARE OF feedback, output_message, run, input_message'
  ) > 0 THEN
    function_definition := replace(
      function_definition,
      'FOR SHARE OF feedback, output_message, run, input_message',
      'FOR SHARE OF feedback, run'
    );
    EXECUTE function_definition;
  ELSIF strpos(function_definition, 'FOR SHARE OF feedback, run') = 0 THEN
    RAISE EXCEPTION
      'Unexpected answer-feedback projection function lock shape.'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER FUNCTION public.project_not_helpful_answer_feedback_bad_case(uuid)
  OWNER TO enterprise_agent_feedback_projector;

REVOKE ALL ON FUNCTION public.project_not_helpful_answer_feedback_bad_case(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.project_not_helpful_answer_feedback_bad_case(uuid)
  TO enterprise_agent_app, enterprise_agent_admin;

COMMIT;
