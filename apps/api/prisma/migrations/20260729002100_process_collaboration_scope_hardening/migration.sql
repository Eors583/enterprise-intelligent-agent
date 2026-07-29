BEGIN;

-- Evidence is stored twice on purpose: immutable JSON preserves the signed
-- source envelope while normalized rows support joins. Both representations
-- must describe exactly the same set. Parent-side deferred checks detect
-- omitted rows; child-side deferred checks prevent rows from being appended to
-- an already committed parent.
CREATE OR REPLACE FUNCTION public.validate_process_collaboration_evidence_bijection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  trigger_row jsonb;
  parent_tenant_id uuid;
  parent_id uuid;
  evidence_refs jsonb;
  evidence_mode text;
  collaboration_message_type public."CollaborationMessageType";
  json_count integer;
  join_count integer;
  duplicate_count integer;
  invalid_count integer;
  missing_count integer;
  extra_count integer;
BEGIN
  -- A trigger function is compiled against every relation that invokes it.
  -- Direct OLD/NEW field references are therefore unsafe when parent and child
  -- relations have different shapes, even when hidden behind CASE branches.
  -- Each trigger declares its mode and parent-id JSON key explicitly.
  IF TG_NARGS <> 2
     OR NOT (
       (TG_TABLE_NAME = 'business_events'
         AND TG_ARGV[0] = 'BUSINESS_EVENT' AND TG_ARGV[1] = 'id')
       OR (TG_TABLE_NAME = 'business_event_evidence'
         AND TG_ARGV[0] = 'BUSINESS_EVENT' AND TG_ARGV[1] = 'business_event_id')
       OR (TG_TABLE_NAME = 'correction_cases'
         AND TG_ARGV[0] = 'CORRECTION_CASE' AND TG_ARGV[1] = 'id')
       OR (TG_TABLE_NAME = 'correction_case_evidence'
         AND TG_ARGV[0] = 'CORRECTION_CASE' AND TG_ARGV[1] = 'correction_case_id')
       OR (TG_TABLE_NAME = 'correction_feedback'
         AND TG_ARGV[0] = 'CORRECTION_FEEDBACK' AND TG_ARGV[1] = 'id')
       OR (TG_TABLE_NAME = 'correction_feedback_evidence'
         AND TG_ARGV[0] = 'CORRECTION_FEEDBACK'
         AND TG_ARGV[1] = 'correction_feedback_id')
       OR (TG_TABLE_NAME = 'collaboration_messages'
         AND TG_ARGV[0] = 'COLLABORATION_MESSAGE' AND TG_ARGV[1] = 'id')
       OR (TG_TABLE_NAME = 'collaboration_message_evidence'
         AND TG_ARGV[0] = 'COLLABORATION_MESSAGE'
         AND TG_ARGV[1] = 'collaboration_message_id')
     ) THEN
    RAISE EXCEPTION 'Unsupported evidence trigger binding.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_collaboration_evidence_bijection_table';
  END IF;
  IF TG_OP = 'DELETE' THEN
    trigger_row := to_jsonb(OLD);
  ELSE
    trigger_row := to_jsonb(NEW);
  END IF;
  parent_tenant_id := nullif(trigger_row->>'tenant_id', '')::uuid;
  parent_id := nullif(trigger_row->>TG_ARGV[1], '')::uuid;
  evidence_mode := TG_ARGV[0];
  IF parent_tenant_id IS NULL OR parent_id IS NULL THEN
    RAISE EXCEPTION 'Evidence trigger row is missing its tenant or parent identity.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_collaboration_evidence_bijection_identity';
  END IF;

  IF evidence_mode = 'BUSINESS_EVENT' THEN
    SELECT parent."evidence_refs"
      INTO evidence_refs
    FROM public."business_events" parent
    WHERE parent."tenant_id" = parent_tenant_id
      AND parent."id" = parent_id;
  ELSIF evidence_mode = 'CORRECTION_CASE' THEN
    SELECT parent."evidence_refs"
      INTO evidence_refs
    FROM public."correction_cases" parent
    WHERE parent."tenant_id" = parent_tenant_id
      AND parent."id" = parent_id;
  ELSIF evidence_mode = 'CORRECTION_FEEDBACK' THEN
    SELECT parent."evidence_ids"
      INTO evidence_refs
    FROM public."correction_feedback" parent
    WHERE parent."tenant_id" = parent_tenant_id
      AND parent."id" = parent_id;
  ELSE
    SELECT
      parent."type",
      COALESCE(parent."payload"->'evidenceRefs', '[]'::jsonb)
      INTO collaboration_message_type, evidence_refs
    FROM public."collaboration_messages" parent
    WHERE parent."tenant_id" = parent_tenant_id
      AND parent."id" = parent_id;
  END IF;

  IF evidence_refs IS NULL OR jsonb_typeof(evidence_refs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Evidence JSON must be a present array.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_collaboration_evidence_json_shape';
  END IF;

  IF evidence_mode = 'COLLABORATION_MESSAGE'
     AND collaboration_message_type NOT IN ('DELIVER', 'ESCALATE')
     AND jsonb_array_length(evidence_refs) <> 0 THEN
    RAISE EXCEPTION 'Only DELIVER or ESCALATE may carry Collaboration evidence.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'collaboration_message_evidence_unexpected';
  END IF;

  json_count := jsonb_array_length(evidence_refs);
  IF evidence_mode = 'CORRECTION_FEEDBACK' THEN
    SELECT
      count(*) - count(DISTINCT reference.value #>> '{}'),
      count(*) FILTER (
        WHERE jsonb_typeof(reference.value) IS DISTINCT FROM 'string'
           OR (reference.value #>> '{}')
                !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      INTO duplicate_count, invalid_count
    FROM jsonb_array_elements(evidence_refs) reference(value);

    IF invalid_count <> 0 OR duplicate_count <> 0 THEN
      RAISE EXCEPTION 'Correction feedback Evidence IDs must be unique UUID strings.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'correction_feedback_evidence_json_identity';
    END IF;

    SELECT count(*)
      INTO join_count
    FROM public."correction_feedback_evidence" evidence_join
    WHERE evidence_join."tenant_id" = parent_tenant_id
      AND evidence_join."correction_feedback_id" = parent_id;
    SELECT count(*)
      INTO missing_count
    FROM jsonb_array_elements_text(evidence_refs) reference(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."correction_feedback_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."correction_feedback_id" = parent_id
        AND evidence_join."evidence_id"::text = reference.value
    );
    SELECT count(*)
      INTO extra_count
    FROM public."correction_feedback_evidence" evidence_join
    WHERE evidence_join."tenant_id" = parent_tenant_id
      AND evidence_join."correction_feedback_id" = parent_id
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(evidence_refs) reference(value)
        WHERE reference.value = evidence_join."evidence_id"::text
      );
  ELSE
    SELECT
      count(*) - count(DISTINCT (
        reference.value->>'evidenceId',
        reference.value->>'version'
      )),
      count(*) FILTER (
        WHERE jsonb_typeof(reference.value) IS DISTINCT FROM 'object'
           OR jsonb_typeof(reference.value->'evidenceId') IS DISTINCT FROM 'string'
           OR (reference.value->>'evidenceId')
                !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR jsonb_typeof(reference.value->'version') IS DISTINCT FROM 'number'
           OR (reference.value->>'version') !~ '^[1-9][0-9]*$'
           OR jsonb_typeof(reference.value->'contentHash') IS DISTINCT FROM 'string'
           OR (reference.value->>'contentHash') !~ '^[0-9a-f]{64}$'
      )
      INTO duplicate_count, invalid_count
    FROM jsonb_array_elements(evidence_refs) reference(value);

    IF invalid_count <> 0 OR duplicate_count <> 0 THEN
      RAISE EXCEPTION 'Evidence references must have unique typed identity and hash.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'process_collaboration_evidence_json_identity';
    END IF;

    IF evidence_mode = 'BUSINESS_EVENT' THEN
      SELECT count(*)
        INTO join_count
      FROM public."business_event_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."business_event_id" = parent_id;
      SELECT count(*)
        INTO missing_count
      FROM jsonb_array_elements(evidence_refs) reference
      WHERE NOT EXISTS (
        SELECT 1
        FROM public."business_event_evidence" evidence_join
        WHERE evidence_join."tenant_id" = parent_tenant_id
          AND evidence_join."business_event_id" = parent_id
          AND evidence_join."evidence_id" = (reference->>'evidenceId')::uuid
          AND evidence_join."evidence_version" = (reference->>'version')::integer
          AND evidence_join."content_hash" = reference->>'contentHash'
      );
      SELECT count(*)
        INTO extra_count
      FROM public."business_event_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."business_event_id" = parent_id
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(evidence_refs) reference
          WHERE evidence_join."evidence_id" = (reference->>'evidenceId')::uuid
            AND evidence_join."evidence_version" = (reference->>'version')::integer
            AND evidence_join."content_hash" = reference->>'contentHash'
        );
    ELSIF evidence_mode = 'CORRECTION_CASE' THEN
      SELECT count(*)
        INTO join_count
      FROM public."correction_case_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."correction_case_id" = parent_id;
      SELECT count(*)
        INTO missing_count
      FROM jsonb_array_elements(evidence_refs) reference
      WHERE NOT EXISTS (
        SELECT 1
        FROM public."correction_case_evidence" evidence_join
        WHERE evidence_join."tenant_id" = parent_tenant_id
          AND evidence_join."correction_case_id" = parent_id
          AND evidence_join."evidence_id" = (reference->>'evidenceId')::uuid
          AND evidence_join."evidence_version" = (reference->>'version')::integer
          AND evidence_join."content_hash" = reference->>'contentHash'
      );
      SELECT count(*)
        INTO extra_count
      FROM public."correction_case_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."correction_case_id" = parent_id
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(evidence_refs) reference
          WHERE evidence_join."evidence_id" = (reference->>'evidenceId')::uuid
            AND evidence_join."evidence_version" = (reference->>'version')::integer
            AND evidence_join."content_hash" = reference->>'contentHash'
        );
    ELSE
      SELECT count(*)
        INTO join_count
      FROM public."collaboration_message_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."collaboration_message_id" = parent_id;
      SELECT count(*)
        INTO missing_count
      FROM jsonb_array_elements(evidence_refs) reference
      WHERE NOT EXISTS (
        SELECT 1
        FROM public."collaboration_message_evidence" evidence_join
        WHERE evidence_join."tenant_id" = parent_tenant_id
          AND evidence_join."collaboration_message_id" = parent_id
          AND evidence_join."evidence_id" = (reference->>'evidenceId')::uuid
          AND evidence_join."evidence_version" = (reference->>'version')::integer
          AND evidence_join."content_hash" = reference->>'contentHash'
      );
      SELECT count(*)
        INTO extra_count
      FROM public."collaboration_message_evidence" evidence_join
      WHERE evidence_join."tenant_id" = parent_tenant_id
        AND evidence_join."collaboration_message_id" = parent_id
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(evidence_refs) reference
          WHERE evidence_join."evidence_id" = (reference->>'evidenceId')::uuid
            AND evidence_join."evidence_version" = (reference->>'version')::integer
            AND evidence_join."content_hash" = reference->>'contentHash'
        );
    END IF;
  END IF;

  IF json_count <> join_count OR missing_count <> 0 OR extra_count <> 0 THEN
    RAISE EXCEPTION 'Evidence JSON and normalized rows must be an exact bijection.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_collaboration_evidence_bijection';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "business_events_scope_evidence_bijection_trigger"
  AFTER INSERT OR UPDATE ON public."business_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'BUSINESS_EVENT', 'id'
  );
CREATE CONSTRAINT TRIGGER "business_event_evidence_scope_bijection_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."business_event_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'BUSINESS_EVENT', 'business_event_id'
  );
CREATE CONSTRAINT TRIGGER "correction_cases_scope_evidence_bijection_trigger"
  AFTER INSERT OR UPDATE ON public."correction_cases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'CORRECTION_CASE', 'id'
  );
CREATE CONSTRAINT TRIGGER "correction_case_evidence_scope_bijection_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."correction_case_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'CORRECTION_CASE', 'correction_case_id'
  );
CREATE CONSTRAINT TRIGGER "correction_feedback_scope_evidence_bijection_trigger"
  AFTER INSERT OR UPDATE ON public."correction_feedback"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'CORRECTION_FEEDBACK', 'id'
  );
CREATE CONSTRAINT TRIGGER "correction_feedback_evidence_scope_bijection_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."correction_feedback_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'CORRECTION_FEEDBACK', 'correction_feedback_id'
  );
CREATE CONSTRAINT TRIGGER "collaboration_messages_scope_evidence_bijection_trigger"
  AFTER INSERT OR UPDATE ON public."collaboration_messages"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'COLLABORATION_MESSAGE', 'id'
  );
CREATE CONSTRAINT TRIGGER "collaboration_message_evidence_scope_bijection_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."collaboration_message_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_collaboration_evidence_bijection(
    'COLLABORATION_MESSAGE', 'collaboration_message_id'
  );

-- Resolve an Assignment only against a current Task and an explicit action.
-- Every supplied organization dimension must match; a correct organizationId
-- can no longer hide a contradictory orgUnitId (or vice versa).
CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(
  p_tenant_id uuid,
  p_role_assignment_id uuid,
  p_permission_labels jsonb,
  p_effective_at timestamptz,
  p_task_id uuid,
  p_required_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  assignment_record record;
  task_record record;
  duplicate_label_count integer;
  action_family text;
  scoped_labels jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Trusted Assignment resolution requires the active tenant context.'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_permission_labels) IS DISTINCT FROM 'array'
     OR p_effective_at IS NULL
     OR p_effective_at > statement_timestamp()
     OR p_effective_at < statement_timestamp() - interval '5 minutes'
     OR p_task_id IS NULL
     OR p_required_action IS NULL
     OR btrim(p_required_action) = '' THEN
    RAISE EXCEPTION 'Trusted Assignment resolution requires current typed labels, Task and action.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_resolution_input_check';
  END IF;
  SELECT count(*) - count(DISTINCT item.value)
    INTO duplicate_label_count
  FROM jsonb_array_elements_text(p_permission_labels) item(value);
  IF duplicate_label_count <> 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_permission_labels) item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
         OR btrim(item.value #>> '{}') = ''
     ) THEN
    RAISE EXCEPTION 'Permission labels must be unique nonempty strings.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_permission_labels_check';
  END IF;

  SELECT
    assignment."id",
    assignment."version" AS assignment_version,
    assignment."user_id",
    assignment."employment_id",
    assignment."role_template_id",
    assignment."role_version_id",
    assignment."agent_instance_id",
    assignment."organization_scope",
    assignment."permission_scope",
    assignment."effective_from",
    assignment."effective_to",
    employment."organization_id",
    employment."org_unit_id",
    role_version."status" AS role_version_status
  INTO assignment_record
  FROM public."role_assignments" assignment
  JOIN public."employments" employment
    ON employment."tenant_id" = assignment."tenant_id"
   AND employment."id" = assignment."employment_id"
   AND employment."user_id" = assignment."user_id"
   AND employment."status" = 'ACTIVE'
  JOIN public."org_units" unit
    ON unit."tenant_id" = employment."tenant_id"
   AND unit."id" = employment."org_unit_id"
   AND unit."organization_id" = employment."organization_id"
   AND unit."status" = 'ACTIVE'
  JOIN public."agent_versions" role_version
    ON role_version."tenant_id" = assignment."tenant_id"
   AND role_version."template_id" = assignment."role_template_id"
   AND role_version."id" = assignment."role_version_id"
   AND role_version."status" IN ('PUBLISHED', 'RETIRED')
  WHERE assignment."tenant_id" = p_tenant_id
    AND assignment."id" = p_role_assignment_id
    AND assignment."status" = 'ACTIVE'
    AND assignment."effective_from" <= p_effective_at
    AND (assignment."effective_to" IS NULL OR assignment."effective_to" > p_effective_at)
  FOR SHARE OF assignment, employment, unit, role_version;

  IF assignment_record."id" IS NULL THEN
    RAISE EXCEPTION 'Role Assignment is not currently effective.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_resolution_check';
  END IF;

  scoped_labels := COALESCE(
    assignment_record."permission_scope"->'dataLabels',
    assignment_record."permission_scope"->'permissionLabels'
  );
  IF jsonb_array_length(p_permission_labels) > 0
     AND (
       jsonb_typeof(scoped_labels) IS DISTINCT FROM 'array'
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(p_permission_labels) required_label(value)
         WHERE NOT (scoped_labels @> jsonb_build_array(required_label.value))
       )
     ) THEN
    RAISE EXCEPTION 'Role Assignment is not effective for the governed labels.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_resolution_check';
  END IF;

  SELECT
    task."id",
    task."objective_id",
    task."objective_version",
    task."owner_user_id",
    task."owner_role_assignment_id",
    task."owner_role_template_id",
    task."owner_org_unit_id",
    owner_unit."organization_id" AS owner_organization_id,
    owner_unit."status" AS owner_org_unit_status,
    task."status"
  INTO task_record
  FROM public."tasks" task
  JOIN public."org_units" owner_unit
    ON owner_unit."tenant_id" = task."tenant_id"
   AND owner_unit."id" = task."owner_org_unit_id"
  WHERE task."tenant_id" = p_tenant_id
    AND task."id" = p_task_id
  FOR SHARE OF task, owner_unit;

  action_family := split_part(p_required_action, '.', 2);
  IF task_record."id" IS NULL
     OR task_record."status" NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')
     OR task_record."owner_org_unit_id" IS NULL
     OR task_record."owner_organization_id" IS NULL
     OR task_record."owner_org_unit_status" <> 'ACTIVE'
     OR NOT COALESCE((
       assignment_record."id" = task_record."owner_role_assignment_id"
       OR assignment_record."user_id" = task_record."owner_user_id"
       OR assignment_record."role_template_id" = task_record."owner_role_template_id"
       OR EXISTS (
          SELECT 1
          FROM public."objective_role_assignments" objective_assignment
         WHERE objective_assignment."tenant_id" = p_tenant_id
           AND objective_assignment."objective_id" = task_record."objective_id"
            AND objective_assignment."objective_version" = task_record."objective_version"
            AND objective_assignment."role_assignment_id" = assignment_record."id"
        )
       -- Collaboration recipients and nominated Correction reviewers are not
       -- Task owners. Their bounded authority is the exact task grant, which
       -- is checked again with the required action and organization below.
       OR (
         jsonb_typeof(assignment_record."permission_scope"->'taskIds') = 'array'
         AND assignment_record."permission_scope"->'taskIds'
           @> jsonb_build_array(p_task_id::text)
       )
      ), false) THEN
    RAISE EXCEPTION 'Role Assignment is outside the active Task scope.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_task_scope_check';
  END IF;

  IF jsonb_typeof(assignment_record."permission_scope"->'taskIds')
       IS DISTINCT FROM 'array'
     OR NOT (
       assignment_record."permission_scope"->'taskIds'
       @> jsonb_build_array(p_task_id::text)
     )
     OR jsonb_typeof(assignment_record."permission_scope"->'actions')
       IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(
         assignment_record."permission_scope"->'actions'
       ) action(value)
       WHERE action.value IN (
         '*',
         'business.*',
         p_required_action,
         'business.' || action_family || '.*'
       )
     ) THEN
    RAISE EXCEPTION 'Role Assignment is outside the trusted Task/action scope.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_task_action_scope_check';
  END IF;

  IF NOT (assignment_record."organization_scope" ? 'organizationIds')
     AND NOT (assignment_record."organization_scope" ? 'orgUnitIds') THEN
    RAISE EXCEPTION 'Role Assignment has no explicit organization scope.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_organization_scope_check';
  END IF;
  IF assignment_record."organization_scope" ? 'organizationIds' THEN
    IF jsonb_typeof(
         assignment_record."organization_scope"->'organizationIds'
       ) IS DISTINCT FROM 'array'
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(
           assignment_record."organization_scope"->'organizationIds'
         ) item(value)
         WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
            OR (item.value #>> '{}')
                 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       OR NOT (
         assignment_record."organization_scope"->'organizationIds'
         @> jsonb_build_array(task_record."owner_organization_id"::text)
       ) THEN
      RAISE EXCEPTION 'Role Assignment organizationIds do not contain the Task organization.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'trusted_assignment_organization_scope_check';
    END IF;
  END IF;
  IF assignment_record."organization_scope" ? 'orgUnitIds' THEN
    IF jsonb_typeof(
         assignment_record."organization_scope"->'orgUnitIds'
       ) IS DISTINCT FROM 'array'
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(
           assignment_record."organization_scope"->'orgUnitIds'
         ) item(value)
         WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
            OR (item.value #>> '{}')
                 !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       OR NOT (
         assignment_record."organization_scope"->'orgUnitIds'
         @> jsonb_build_array(task_record."owner_org_unit_id"::text)
       ) THEN
      RAISE EXCEPTION 'Role Assignment orgUnitIds do not contain the Task organization unit.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'trusted_assignment_org_unit_scope_check';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'roleAssignmentId', assignment_record."id",
    'assignmentVersion', assignment_record."assignment_version",
    'userId', assignment_record."user_id",
    'employmentId', assignment_record."employment_id",
    'organizationId', assignment_record."organization_id",
    'orgUnitId', assignment_record."org_unit_id",
    'taskOrganizationId', task_record."owner_organization_id",
    'taskOrgUnitId', task_record."owner_org_unit_id",
    'requiredAction', p_required_action,
    'roleTemplateId', assignment_record."role_template_id",
    'roleVersionId', assignment_record."role_version_id",
    'roleVersionStatus', assignment_record."role_version_status",
    'agentId', assignment_record."agent_instance_id",
    'organizationScope', assignment_record."organization_scope",
    'permissionScope', assignment_record."permission_scope",
    'effectiveFrom', assignment_record."effective_from",
    'effectiveTo', assignment_record."effective_to"
  );
END
$function$;

-- The schema represents the current attempt on the Process Step aggregate
-- rather than as one row per attempt. Treat immutable RETRY commands as the
-- attempt ledger: aggregate attempt must always be exactly 1 + RETRY count.
CREATE OR REPLACE FUNCTION public.validate_process_step_retry_attempt_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  trigger_row jsonb;
  trigger_kind text;
  trigger_tenant_id uuid;
  process_step_id uuid;
  step_record record;
  retry_count integer;
  declared_attempt integer;
  command_kind text;
  command_payload jsonb;
  command_result_revision integer;
BEGIN
  IF TG_NARGS <> 2
     OR NOT (
       (TG_TABLE_NAME = 'process_step_instances'
         AND TG_ARGV[0] = 'STEP' AND TG_ARGV[1] = 'id')
       OR (TG_TABLE_NAME = 'process_step_commands'
         AND TG_ARGV[0] = 'COMMAND'
         AND TG_ARGV[1] = 'process_step_instance_id')
     ) THEN
    RAISE EXCEPTION 'Unsupported Process Step attempt trigger binding.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_retry_attempt_trigger_binding';
  END IF;
  IF TG_OP = 'DELETE' THEN
    trigger_row := to_jsonb(OLD);
  ELSE
    trigger_row := to_jsonb(NEW);
  END IF;
  trigger_kind := TG_ARGV[0];
  trigger_tenant_id := nullif(trigger_row->>'tenant_id', '')::uuid;
  process_step_id := nullif(trigger_row->>TG_ARGV[1], '')::uuid;
  IF trigger_tenant_id IS NULL OR process_step_id IS NULL THEN
    RAISE EXCEPTION 'Process Step attempt trigger row is missing its identity.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_retry_attempt_trigger_identity';
  END IF;
  SELECT step."tenant_id", step."status", step."revision", step."attempt"
    INTO step_record
  FROM public."process_step_instances" step
  WHERE step."tenant_id" = trigger_tenant_id
    AND step."id" = process_step_id
  FOR SHARE;
  IF step_record."tenant_id" IS NULL THEN
    RAISE EXCEPTION 'A RETRY attempt requires its Process Step.'
      USING ERRCODE = '23503',
            CONSTRAINT = 'process_step_retry_attempt_step_check';
  END IF;

  SELECT count(*)
    INTO retry_count
  FROM public."process_step_commands" command
  WHERE command."tenant_id" = step_record."tenant_id"
    AND command."process_step_instance_id" = process_step_id
    AND command."command" = 'RETRY'
    AND command."result_revision" <= step_record."revision";
  IF step_record."attempt" <> retry_count + 1
     OR step_record."attempt" NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Process Step attempt must equal one plus its immutable RETRY commands.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_retry_attempt_ledger_check';
  END IF;

  IF trigger_kind = 'COMMAND' THEN
    command_kind := trigger_row->>'command';
    command_payload := COALESCE(trigger_row->'payload', '{}'::jsonb);
    command_result_revision :=
      nullif(trigger_row->>'result_revision', '')::integer;
    IF command_kind <> 'RETRY' AND command_payload ? 'attempt' THEN
      RAISE EXCEPTION 'Only RETRY may declare an attempt, and the aggregate is authoritative.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'process_step_retry_declared_attempt_check';
    END IF;
    IF command_kind = 'RETRY' THEN
      IF step_record."status" <> 'READY'
         OR step_record."revision" <> command_result_revision THEN
        RAISE EXCEPTION 'A RETRY command must produce the matching READY revision.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'process_step_retry_state_check';
      END IF;
      IF command_payload ? 'attempt' THEN
        IF jsonb_typeof(command_payload->'attempt') IS DISTINCT FROM 'number'
           OR (command_payload->>'attempt') !~ '^[1-9][0-9]*$' THEN
          RAISE EXCEPTION 'A declared RETRY attempt must be a positive integer.'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'process_step_retry_declared_attempt_check';
        END IF;
        declared_attempt := (command_payload->>'attempt')::integer;
        IF declared_attempt <> step_record."attempt" THEN
          RAISE EXCEPTION 'A declared RETRY attempt must equal the aggregate attempt.'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'process_step_retry_declared_attempt_check';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "process_step_instances_retry_attempt_contract_trigger"
  AFTER INSERT OR UPDATE ON public."process_step_instances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_step_retry_attempt_contract(
    'STEP', 'id'
  );
CREATE CONSTRAINT TRIGGER "process_step_commands_retry_attempt_contract_trigger"
  AFTER INSERT ON public."process_step_commands"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_process_step_retry_attempt_contract(
    'COMMAND', 'process_step_instance_id'
  );

-- New Corrections always nominate a reviewer. Older low/medium rows that were
-- created without one retain the bounded independent-review terminal path in
-- guard_correction_feedback_insert below.
CREATE OR REPLACE FUNCTION public.guard_correction_case_reviewer_liveness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF jsonb_typeof(NEW."required_role_assignment_ids") IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW."required_role_assignment_ids") = 0 THEN
    RAISE EXCEPTION 'A Correction case requires an independent human reviewer.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_cases_reviewer_liveness_check';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS "correction_cases_reviewer_liveness_trigger"
  ON public."correction_cases";
CREATE TRIGGER "correction_cases_reviewer_liveness_trigger"
  BEFORE INSERT ON public."correction_cases"
  FOR EACH ROW EXECUTE FUNCTION public.guard_correction_case_reviewer_liveness();

CREATE OR REPLACE FUNCTION public.guard_correction_feedback_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  correction_record public."correction_cases"%ROWTYPE;
  task_status public."TaskStatus";
  subject_user_id uuid;
  actor_snapshot jsonb;
  actor_user uuid;
  next_status public."CorrectionStatus";
  evidence_valid_count integer;
  evidence_id_count integer;
  high_impact boolean;
  requires_evidence boolean;
  actor_is_subject boolean;
  actor_is_reviewer boolean;
  legacy_independent_reviewer boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."tenant_id"::text || ':correction:' || NEW."correction_case_id"::text,
      0
    )
  );
  SELECT *
    INTO correction_record
  FROM public."correction_cases"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
  FOR UPDATE;
  IF correction_record."id" IS NULL
     OR NEW."revision" <> correction_record."revision" + 1
     OR NEW."occurred_at" < correction_record."updated_at"
     OR NEW."occurred_at" > statement_timestamp() THEN
    RAISE EXCEPTION 'Correction feedback revision conflict.'
      USING ERRCODE = '40001',
            CONSTRAINT = 'correction_feedback_revision_cas';
  END IF;

  SELECT task."status"
    INTO task_status
  FROM public."tasks" task
  WHERE task."tenant_id" = correction_record."tenant_id"
    AND task."id" = correction_record."task_id"
    AND task."version" = correction_record."task_version"
  FOR SHARE;
  IF task_status IS NULL
     OR task_status NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED') THEN
    RAISE EXCEPTION 'A terminal or missing Task cannot advance a Correction.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_feedback_active_task_check';
  END IF;

  SELECT "user_id"
    INTO subject_user_id
  FROM public."role_assignments"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = correction_record."role_assignment_id";
  actor_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."actor_role_assignment_id",
    correction_record."permission_labels",
    statement_timestamp(),
    correction_record."task_id",
    'business.task.execute'
  );
  actor_user := (actor_snapshot->>'userId')::uuid;
  IF actor_snapshot IS NULL OR actor_user <> NEW."actor_user_id" THEN
    RAISE EXCEPTION 'Correction feedback actor is not a trusted active Assignment.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_feedback_actor_check';
  END IF;

  next_status := CASE
    WHEN NEW."action" = 'ACKNOWLEDGE' AND correction_record."status" = 'OPEN'
      THEN 'ACKNOWLEDGED'
    WHEN NEW."action" = 'ACCEPT' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'ACCEPTED'
    WHEN NEW."action" = 'REJECT' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'REJECTED'
    WHEN NEW."action" = 'EXPLAIN'
      AND correction_record."status" IN ('OPEN', 'ACKNOWLEDGED')
      THEN 'EXPLAINED'
    WHEN NEW."action" = 'ESCALATE'
      AND correction_record."status" NOT IN ('RESOLVED', 'CANCELLED')
      THEN 'ESCALATED'
    WHEN NEW."action" = 'RESOLVE'
      AND (
        correction_record."status" IN (
          'ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED'
        )
        OR (
          correction_record."severity" = 'LOW'
          AND correction_record."status" = 'OPEN'
        )
      ) THEN 'RESOLVED'
    WHEN NEW."action" = 'CANCEL' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
    ) THEN 'CANCELLED'
    ELSE NULL
  END;
  IF next_status IS NULL THEN
    RAISE EXCEPTION 'Invalid Correction feedback transition.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_feedback_transition_check';
  END IF;

  actor_is_subject :=
    NEW."actor_role_assignment_id" = correction_record."role_assignment_id";
  actor_is_reviewer :=
    correction_record."required_role_assignment_ids"
      ? NEW."actor_role_assignment_id"::text;
  high_impact :=
    correction_record."severity" IN ('HIGH', 'CRITICAL')
    OR correction_record."category" = 'CAPABILITY_RISK';
  legacy_independent_reviewer :=
    jsonb_array_length(correction_record."required_role_assignment_ids") = 0
    AND NOT high_impact
    AND NOT actor_is_subject
    AND actor_user IS DISTINCT FROM subject_user_id
    AND NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL');

  IF (
    NEW."action" IN ('ACKNOWLEDGE', 'REJECT', 'EXPLAIN', 'ESCALATE')
    AND NOT actor_is_subject
    AND NOT actor_is_reviewer
  ) OR (
    NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL')
    AND NOT actor_is_reviewer
    AND NOT legacy_independent_reviewer
  ) THEN
    RAISE EXCEPTION 'Correction feedback actor does not hold the required subject or review role.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_feedback_actor_role_check';
  END IF;

  requires_evidence :=
    NEW."action" IN ('REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE')
    OR legacy_independent_reviewer
    OR (
      high_impact
      AND NEW."action" IN ('ACCEPT', 'CANCEL')
    );
  IF requires_evidence AND jsonb_array_length(NEW."evidence_ids") = 0 THEN
    RAISE EXCEPTION 'This Correction feedback action requires trusted evidence.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_feedback_evidence_required';
  END IF;
  IF high_impact AND NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL') THEN
    IF actor_user = subject_user_id
       OR NOT correction_record."required_role_assignment_ids"
         ? NEW."actor_role_assignment_id"::text
       OR NOT actor_is_reviewer THEN
      RAISE EXCEPTION 'A high-impact terminal correction decision requires an independent reviewer and evidence.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'correction_feedback_independent_review_check';
    END IF;
  END IF;
  IF jsonb_array_length(NEW."evidence_ids") > 0 THEN
    SELECT count(DISTINCT value)
      INTO evidence_id_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value);
    IF evidence_id_count <> jsonb_array_length(NEW."evidence_ids") THEN
      RAISE EXCEPTION 'Correction feedback Evidence IDs must be unique.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'correction_feedback_evidence_unique';
    END IF;
    SELECT count(DISTINCT evidence."id"::text)
      INTO evidence_valid_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value)
    JOIN public."evidence" evidence
      ON evidence."tenant_id" = NEW."tenant_id"
     AND evidence."id" = item.value::uuid
     AND evidence."status" = 'ACTIVE'
     AND evidence."verified_at" IS NOT NULL
     AND evidence."effective_from" <= statement_timestamp()
     AND (
       evidence."effective_to" IS NULL
       OR evidence."effective_to" > statement_timestamp()
     )
    WHERE EXISTS (
      SELECT 1
      FROM public."correction_case_evidence" case_evidence
      WHERE case_evidence."tenant_id" = NEW."tenant_id"
        AND case_evidence."correction_case_id" = NEW."correction_case_id"
        AND case_evidence."evidence_id" = evidence."id"
        AND case_evidence."evidence_version" = evidence."version"
        AND case_evidence."content_hash" = evidence."content_hash"
    );
    IF evidence_valid_count <> evidence_id_count THEN
      RAISE EXCEPTION 'Correction feedback evidence must be active, sealed, and linked to the case.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'correction_feedback_evidence_check';
    END IF;
  END IF;

  UPDATE public."correction_cases"
  SET "status" = next_status,
      "revision" = NEW."revision",
      "updated_at" = statement_timestamp()
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
    AND "revision" = correction_record."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction revision conflict.'
      USING ERRCODE = '40001',
            CONSTRAINT = 'correction_cases_revision_cas';
  END IF;
  RETURN NEW;
END
$function$;

-- Role Assignment IDs are not identity: two assignments can resolve to one
-- user or Agent. A second independently named index makes the deployed
-- invariant auditable and causes migration to fail closed if legacy duplicates
-- exist instead of silently preserving them.
CREATE UNIQUE INDEX "collaboration_participants_scope_active_user_key"
  ON public."collaboration_participants"(
    "tenant_id", "collaboration_id", "user_id"
  )
  WHERE "active";
CREATE UNIQUE INDEX "collaboration_participants_scope_active_agent_key"
  ON public."collaboration_participants"(
    "tenant_id", "collaboration_id", "agent_id"
  )
  WHERE "active" AND "agent_id" IS NOT NULL;

-- Replay is an administrator-attributed governance action. The application
-- must use the process capability role, bind actor and tenant to the request
-- context, and use this statement's timestamp; a caller-supplied recent time
-- is no longer accepted.
CREATE OR REPLACE FUNCTION public.guard_event_delivery_replay_attribution_v3()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  session_tenant_id uuid :=
    nullif(current_setting('app.tenant_id', true), '')::uuid;
  session_user_id uuid :=
    nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF NOT (
    OLD."status" = 'DEAD_LETTERED'
    AND NEW."status" = 'PENDING'
  ) THEN
    IF (
      NEW."replay_count",
      NEW."replayed_at",
      NEW."replayed_by_user_id",
      NEW."replay_reason"
    ) IS DISTINCT FROM (
      OLD."replay_count",
      OLD."replayed_at",
      OLD."replayed_by_user_id",
      OLD."replay_reason"
    ) THEN
      RAISE EXCEPTION 'Replay attribution may change only during a dead-letter replay.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'business_event_deliveries_replay_attribution_v3_check';
    END IF;
    RETURN NEW;
  END IF;

  IF session_tenant_id IS NULL
     OR session_user_id IS NULL
     OR NOT pg_has_role(current_user, 'enterprise_agent_process', 'USAGE')
     OR NEW."tenant_id" IS DISTINCT FROM session_tenant_id
     OR NEW."replayed_by_user_id" IS DISTINCT FROM session_user_id
     OR NEW."replay_count" <> OLD."replay_count" + 1
     OR NEW."replayed_at" IS DISTINCT FROM statement_timestamp()
     OR NEW."available_at" IS DISTINCT FROM NEW."replayed_at"
     OR NEW."replay_reason" IS NULL
     OR btrim(NEW."replay_reason") = ''
     OR NOT EXISTS (
       SELECT 1
       FROM public."users" replay_actor
       WHERE replay_actor."tenant_id" = session_tenant_id
         AND replay_actor."id" = session_user_id
         AND replay_actor."status" = 'ACTIVE'
         AND replay_actor."role" IN ('OWNER', 'ADMIN')
     ) THEN
    RAISE EXCEPTION 'Dead-letter replay requires the current active tenant administrator and process capability.'
      USING ERRCODE = '42501',
            CONSTRAINT = 'business_event_deliveries_replay_actor_v3_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "business_event_deliveries_replay_attribution_v3_trigger"
  BEFORE UPDATE ON public."business_event_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_delivery_replay_attribution_v3();

REVOKE ALL ON FUNCTION public.validate_process_collaboration_evidence_bijection()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_trusted_assignment_snapshot(
  uuid, uuid, jsonb, timestamptz, uuid, text
) FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
  enterprise_agent_auth, enterprise_agent_provisioner;
GRANT EXECUTE ON FUNCTION public.build_trusted_assignment_snapshot(
  uuid, uuid, jsonb, timestamptz, uuid, text
) TO enterprise_agent_process;
REVOKE ALL ON FUNCTION public.validate_process_step_retry_attempt_contract()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_correction_case_reviewer_liveness()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_correction_feedback_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_event_delivery_replay_attribution_v3()
  FROM PUBLIC;

COMMIT;
