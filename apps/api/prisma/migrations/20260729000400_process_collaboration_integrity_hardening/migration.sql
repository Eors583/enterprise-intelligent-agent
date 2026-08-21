BEGIN;

-- A parent-row deferred check alone does not protect an already committed
-- parent from receiving additional normalized evidence rows later. Validate
-- every join-table insert against the immutable parent JSON as well.
CREATE OR REPLACE FUNCTION public.validate_business_ledger_parent_bijection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_count integer;
  join_count integer;
  mismatch_count integer;
BEGIN
  IF TG_TABLE_NAME = 'business_event_evidence' THEN
    SELECT jsonb_array_length(parent."evidence_refs")
      INTO parent_count
    FROM public."business_events" parent
    WHERE parent."tenant_id" = NEW."tenant_id"
      AND parent."id" = NEW."business_event_id";

    SELECT count(*), count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM public."business_events" parent
        CROSS JOIN LATERAL jsonb_array_elements(parent."evidence_refs") reference
        WHERE parent."tenant_id" = evidence_join."tenant_id"
          AND parent."id" = evidence_join."business_event_id"
          AND reference->>'evidenceId' = evidence_join."evidence_id"::text
          AND (reference->>'version')::integer = evidence_join."evidence_version"
          AND reference->>'contentHash' = evidence_join."content_hash"
      )
    )
      INTO join_count, mismatch_count
    FROM public."business_event_evidence" evidence_join
    WHERE evidence_join."tenant_id" = NEW."tenant_id"
      AND evidence_join."business_event_id" = NEW."business_event_id";
  ELSIF TG_TABLE_NAME = 'correction_case_evidence' THEN
    SELECT jsonb_array_length(parent."evidence_refs")
      INTO parent_count
    FROM public."correction_cases" parent
    WHERE parent."tenant_id" = NEW."tenant_id"
      AND parent."id" = NEW."correction_case_id";

    SELECT count(*), count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM public."correction_cases" parent
        CROSS JOIN LATERAL jsonb_array_elements(parent."evidence_refs") reference
        WHERE parent."tenant_id" = evidence_join."tenant_id"
          AND parent."id" = evidence_join."correction_case_id"
          AND reference->>'evidenceId' = evidence_join."evidence_id"::text
          AND (reference->>'version')::integer = evidence_join."evidence_version"
          AND reference->>'contentHash' = evidence_join."content_hash"
      )
    )
      INTO join_count, mismatch_count
    FROM public."correction_case_evidence" evidence_join
    WHERE evidence_join."tenant_id" = NEW."tenant_id"
      AND evidence_join."correction_case_id" = NEW."correction_case_id";
  ELSIF TG_TABLE_NAME = 'correction_feedback_evidence' THEN
    SELECT jsonb_array_length(parent."evidence_ids")
      INTO parent_count
    FROM public."correction_feedback" parent
    WHERE parent."tenant_id" = NEW."tenant_id"
      AND parent."id" = NEW."correction_feedback_id";

    SELECT count(*), count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM public."correction_feedback" parent
        CROSS JOIN LATERAL jsonb_array_elements_text(parent."evidence_ids") reference(value)
        WHERE parent."tenant_id" = evidence_join."tenant_id"
          AND parent."id" = evidence_join."correction_feedback_id"
          AND reference.value = evidence_join."evidence_id"::text
      )
    )
      INTO join_count, mismatch_count
    FROM public."correction_feedback_evidence" evidence_join
    WHERE evidence_join."tenant_id" = NEW."tenant_id"
      AND evidence_join."correction_feedback_id" = NEW."correction_feedback_id";
  ELSE
    RAISE EXCEPTION 'Unsupported evidence join table.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'business_ledger_parent_bijection_table_check';
  END IF;

  IF parent_count IS NULL
     OR parent_count <> join_count
     OR mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Normalized evidence must remain a bijection with immutable parent JSON.'
      USING ERRCODE = '23514',
            CONSTRAINT = TG_TABLE_NAME || '_parent_bijection';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "business_event_evidence_parent_bijection_trigger"
  AFTER INSERT ON public."business_event_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_ledger_parent_bijection();
CREATE CONSTRAINT TRIGGER "correction_case_evidence_parent_bijection_trigger"
  AFTER INSERT ON public."correction_case_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_ledger_parent_bijection();
CREATE CONSTRAINT TRIGGER "correction_feedback_evidence_parent_bijection_trigger"
  AFTER INSERT ON public."correction_feedback_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_ledger_parent_bijection();

-- Process execution authorization is fail-closed for all three independent
-- dimensions: action, task and organization. organizationIds is canonical;
-- orgUnitIds remains accepted for legacy assignments.
CREATE OR REPLACE FUNCTION public.build_process_step_assignment_snapshot(
  p_tenant_id uuid,
  p_process_instance_id uuid,
  p_process_node_id uuid,
  p_role_assignment_id uuid,
  p_agent_id uuid,
  p_evaluated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  node_type public."ProcessNodeType";
  node_configuration jsonb;
  task_id uuid;
  task_permission_labels jsonb;
  task_organization_id uuid;
  task_org_unit_id uuid;
  required_action text;
  required_action_namespace text;
  assignment_record record;
  context_organization_id uuid;
  context_org_unit_id uuid;
BEGIN
  SELECT node."type", node."configuration", instance."task_id",
         task."permission_labels", owner_unit."organization_id",
         task."owner_org_unit_id"
    INTO node_type, node_configuration, task_id,
         task_permission_labels, task_organization_id, task_org_unit_id
  FROM public."process_nodes" node
  JOIN public."process_instances" instance
    ON instance."tenant_id" = node."tenant_id"
   AND instance."id" = p_process_instance_id
   AND instance."process_version_id" = node."process_version_id"
   AND instance."process_version" = node."process_version"
  JOIN public."tasks" task
    ON task."tenant_id" = instance."tenant_id"
   AND task."id" = instance."task_id"
   AND task."version" = instance."task_version"
  LEFT JOIN public."org_units" owner_unit
    ON owner_unit."tenant_id" = task."tenant_id"
   AND owner_unit."id" = task."owner_org_unit_id"
  WHERE node."tenant_id" = p_tenant_id
    AND node."id" = p_process_node_id;
  IF node_type IS NULL THEN
    RAISE EXCEPTION 'The Process Step node is not part of its Process Instance.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_node_instance_match';
  END IF;
  IF node_type NOT IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION') THEN
    RAISE EXCEPTION 'Only executable Process Steps may resolve a Role Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_node_type';
  END IF;

  required_action := node_configuration->>'requiredPermissionAction';
  required_action_namespace := split_part(required_action, '.', 1) || '.*';
  SELECT assignment."id", assignment."user_id", assignment."employment_id",
         assignment."role_template_id", assignment."role_version_id",
         assignment."agent_instance_id", assignment."permission_scope",
         assignment."organization_scope", assignment."status",
         assignment."effective_from", assignment."effective_to",
         employment."organization_id", employment."org_unit_id",
         employment."status" AS employment_status,
         unit."status" AS org_unit_status,
         role_version."status" AS role_version_status
    INTO assignment_record
  FROM public."role_assignments" assignment
  JOIN public."employments" employment
    ON employment."tenant_id" = assignment."tenant_id"
   AND employment."id" = assignment."employment_id"
   AND employment."user_id" = assignment."user_id"
  JOIN public."org_units" unit
    ON unit."tenant_id" = employment."tenant_id"
   AND unit."id" = employment."org_unit_id"
   AND unit."organization_id" = employment."organization_id"
  JOIN public."agent_versions" role_version
    ON role_version."tenant_id" = assignment."tenant_id"
   AND role_version."template_id" = assignment."role_template_id"
   AND role_version."id" = assignment."role_version_id"
  WHERE assignment."tenant_id" = p_tenant_id
    AND assignment."id" = p_role_assignment_id
  FOR SHARE OF assignment, employment, unit, role_version;

  context_organization_id := COALESCE(
    task_organization_id,
    assignment_record."organization_id"
  );
  context_org_unit_id := COALESCE(
    task_org_unit_id,
    assignment_record."org_unit_id"
  );
  IF assignment_record."id" IS NULL
     OR assignment_record."status" <> 'ACTIVE'
     OR assignment_record."effective_from" > p_evaluated_at
     OR (
       assignment_record."effective_to" IS NOT NULL
       AND assignment_record."effective_to" <= p_evaluated_at
     )
     OR assignment_record."employment_status" <> 'ACTIVE'
     OR assignment_record."org_unit_status" <> 'ACTIVE'
     OR assignment_record."role_version_status" NOT IN ('PUBLISHED', 'RETIRED')
     OR assignment_record."role_template_id"::text
          IS DISTINCT FROM node_configuration->>'roleTemplateId'
     OR required_action IS NULL
     OR btrim(required_action) = ''
     OR jsonb_typeof(assignment_record."permission_scope"->'actions') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(
         assignment_record."permission_scope"->'actions'
       ) action(value)
       WHERE action.value IN ('*', required_action, required_action_namespace)
     )
     OR jsonb_typeof(assignment_record."permission_scope"->'taskIds') IS DISTINCT FROM 'array'
     OR NOT (
       assignment_record."permission_scope"->'taskIds'
       @> jsonb_build_array(task_id::text)
     )
     OR jsonb_typeof(
       assignment_record."permission_scope"->'permissionLabels'
     ) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(task_permission_labels) required_label(value)
       WHERE NOT (
         assignment_record."permission_scope"->'permissionLabels'
         @> jsonb_build_array(required_label.value)
       )
     )
     OR (
       assignment_record."organization_scope" ? 'organizationIds'
       AND jsonb_typeof(
         assignment_record."organization_scope"->'organizationIds'
       ) IS DISTINCT FROM 'array'
     )
     OR (
       assignment_record."organization_scope" ? 'orgUnitIds'
       AND jsonb_typeof(
         assignment_record."organization_scope"->'orgUnitIds'
       ) IS DISTINCT FROM 'array'
     )
     OR (
       NOT (assignment_record."organization_scope" ? 'organizationIds')
       AND NOT (assignment_record."organization_scope" ? 'orgUnitIds')
     )
     OR NOT (
       COALESCE(
         assignment_record."organization_scope"->'organizationIds',
         '[]'::jsonb
       ) @> jsonb_build_array(context_organization_id::text)
       OR COALESCE(
         assignment_record."organization_scope"->'orgUnitIds',
         '[]'::jsonb
       ) @> jsonb_build_array(context_org_unit_id::text)
     )
  THEN
    RAISE EXCEPTION 'The resolved Role Assignment is not eligible for this Process Step.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_assignment_scope';
  END IF;
  IF node_type = 'HUMAN_APPROVAL' AND p_agent_id IS NOT NULL THEN
    RAISE EXCEPTION 'A human approval Process Step cannot resolve to an Agent actor.'
      USING ERRCODE = '23514', CONSTRAINT = 'human_approval_human_actor';
  END IF;
  IF node_type = 'AGENT_EXECUTION'
     AND (
       p_agent_id IS NULL
       OR p_agent_id IS DISTINCT FROM assignment_record."agent_instance_id"
     )
  THEN
    RAISE EXCEPTION 'An Agent execution must resolve the Role Assignment Agent.'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_execution_agent_match';
  END IF;

  RETURN jsonb_build_object(
    'assignmentId', assignment_record."id",
    'userId', assignment_record."user_id",
    'employmentId', assignment_record."employment_id",
    'organizationId', assignment_record."organization_id",
    'orgUnitId', assignment_record."org_unit_id",
    'roleTemplateId', assignment_record."role_template_id",
    'roleVersionId', assignment_record."role_version_id",
    'roleVersionStatus', assignment_record."role_version_status",
    'agentId', CASE
      WHEN node_type = 'AGENT_EXECUTION' THEN assignment_record."agent_instance_id"
      ELSE NULL
    END,
    'requiredPermissionAction', required_action,
    'evaluatedAt', p_evaluated_at
  );
END
$function$;

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
AS $$
DECLARE
  assignment_record record;
  task_record record;
  duplicate_label_count integer;
  action_family text;
  context_organization_id uuid;
  context_org_unit_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Trusted Assignment resolution requires the active tenant context.'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_permission_labels) IS DISTINCT FROM 'array'
     OR p_effective_at IS NULL
     OR p_effective_at > CURRENT_TIMESTAMP
     OR p_task_id IS NULL
     OR p_required_action IS NULL
     OR btrim(p_required_action) = '' THEN
    RAISE EXCEPTION 'Trusted Assignment resolution requires current typed labels.'
      USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_resolution_input_check';
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
      USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_permission_labels_check';
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

  IF assignment_record."id" IS NULL
     OR (
       jsonb_array_length(p_permission_labels) > 0
       AND (
         jsonb_typeof(
           COALESCE(
             assignment_record."permission_scope"->'dataLabels',
             assignment_record."permission_scope"->'permissionLabels'
           )
         ) IS DISTINCT FROM 'array'
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(p_permission_labels) required_label(value)
           WHERE NOT (
             COALESCE(
               assignment_record."permission_scope"->'dataLabels',
               assignment_record."permission_scope"->'permissionLabels'
             )
             @> jsonb_build_array(required_label.value)
           )
         )
       )
     ) THEN
    RAISE EXCEPTION 'Role Assignment is not currently effective for the governed labels.'
      USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_resolution_check';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT
      task."id",
      task."objective_id",
      task."objective_version",
      task."owner_user_id",
      task."owner_role_assignment_id",
      task."owner_role_template_id",
      task."owner_org_unit_id",
      owner_unit."organization_id" AS owner_organization_id,
      task."status"
    INTO task_record
    FROM public."tasks" task
    LEFT JOIN public."org_units" owner_unit
      ON owner_unit."tenant_id" = task."tenant_id"
     AND owner_unit."id" = task."owner_org_unit_id"
    WHERE task."tenant_id" = p_tenant_id
      AND task."id" = p_task_id
    FOR SHARE OF task;

    action_family := split_part(p_required_action, '.', 2);
    context_organization_id := COALESCE(
      task_record."owner_organization_id",
      assignment_record."organization_id"
    );
    context_org_unit_id := COALESCE(
      task_record."owner_org_unit_id",
      assignment_record."org_unit_id"
    );
    IF task_record."id" IS NULL
       OR task_record."status" NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')
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
       ), false)
       OR jsonb_typeof(assignment_record."permission_scope"->'taskIds')
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
       )
       OR (
         assignment_record."organization_scope" ? 'organizationIds'
         AND jsonb_typeof(
           assignment_record."organization_scope"->'organizationIds'
         ) IS DISTINCT FROM 'array'
       )
       OR (
         assignment_record."organization_scope" ? 'orgUnitIds'
         AND jsonb_typeof(
           assignment_record."organization_scope"->'orgUnitIds'
         ) IS DISTINCT FROM 'array'
       )
       OR (
         NOT (assignment_record."organization_scope" ? 'organizationIds')
         AND NOT (assignment_record."organization_scope" ? 'orgUnitIds')
       )
       OR NOT (
         COALESCE(
           assignment_record."organization_scope"->'organizationIds',
           '[]'::jsonb
         ) @> jsonb_build_array(context_organization_id::text)
         OR COALESCE(
           assignment_record."organization_scope"->'orgUnitIds',
           '[]'::jsonb
         ) @> jsonb_build_array(context_org_unit_id::text)
       ) THEN
      RAISE EXCEPTION 'Role Assignment is outside the trusted Task/action/organization scope.'
        USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_operational_scope_check';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'roleAssignmentId', assignment_record."id",
    'assignmentVersion', assignment_record."assignment_version",
    'userId', assignment_record."user_id",
    'employmentId', assignment_record."employment_id",
    'organizationId', assignment_record."organization_id",
    'orgUnitId', assignment_record."org_unit_id",
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
$$;

-- Enforce attempt semantics independently of application code. A new step is
-- attempt 1; only a terminal failure/rejection/timeout -> READY retry may add
-- one, and it must not retain outcome/timing state from the previous attempt.
CREATE OR REPLACE FUNCTION public.guard_process_step_attempt_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."attempt" <> 1 THEN
      RAISE EXCEPTION 'A Process Step must start at attempt 1.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'process_step_instances_initial_attempt_check';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED')
     AND NEW."status" = 'READY' THEN
    IF NEW."attempt" <> OLD."attempt" + 1
       OR NEW."output" IS NOT NULL
       OR NEW."failure_code" IS NOT NULL
       OR NEW."failure_detail" IS NOT NULL
       OR NEW."claimed_at" IS NOT NULL
       OR NEW."started_at" IS NOT NULL
       OR NEW."completed_at" IS NOT NULL
       OR NEW."timed_out_at" IS NOT NULL THEN
      RAISE EXCEPTION 'A RETRY must advance one attempt and clear the previous attempt outcome.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'process_step_instances_retry_reset_check';
    END IF;
  ELSIF NEW."attempt" <> OLD."attempt" THEN
    RAISE EXCEPTION 'Only RETRY may advance a Process Step attempt.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_instances_attempt_transition_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "process_step_instances_attempt_integrity_trigger"
  BEFORE INSERT OR UPDATE ON public."process_step_instances"
  FOR EACH ROW EXECUTE FUNCTION public.guard_process_step_attempt_integrity();

CREATE OR REPLACE FUNCTION public.guard_process_step_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  node_type public."ProcessNodeType";
  parent_status public."ProcessInstanceStatus";
  valid_evidence_count integer;
  requested_evidence_count integer;
  is_retry boolean;
BEGIN
  IF (
    NEW."tenant_id", NEW."process_instance_id", NEW."process_definition_id",
    NEW."process_version_id", NEW."process_version", NEW."process_node_id",
    NEW."process_node_code", NEW."idempotency_key",
    NEW."request_hash", NEW."input", NEW."available_at", NEW."due_at",
    NEW."compensation_for_step_id", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."process_instance_id", OLD."process_definition_id",
    OLD."process_version_id", OLD."process_version", OLD."process_node_id",
    OLD."process_node_code", OLD."idempotency_key",
    OLD."request_hash", OLD."input", OLD."available_at", OLD."due_at",
    OLD."compensation_for_step_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Process Step identity and execution snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Process Step transition requires an exact revision increment.'
      USING ERRCODE = '40001', CONSTRAINT = 'process_step_instances_revision_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'WAITING' AND NEW."status" IN ('READY', 'SKIPPED', 'CANCELLED'))
    OR (OLD."status" = 'READY' AND NEW."status" IN (
      'RUNNING', 'TIMED_OUT', 'CANCELLED', 'SKIPPED'
    ))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN (
      'COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED'
    ))
    OR (OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED') AND NEW."status" = 'READY')
    OR (OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED') AND NEW."status" = 'CANCELLED')
    OR (OLD."status" IN (
      'COMPLETED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'COMPENSATION_FAILED'
    ) AND NEW."status" = 'COMPENSATING')
    OR (OLD."status" = 'COMPENSATING' AND NEW."status" IN ('COMPENSATED', 'COMPENSATION_FAILED'))
  ) THEN
    RAISE EXCEPTION 'Invalid Process Step status transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_instances_status_transition_check';
  END IF;

  is_retry :=
    OLD."status" IN ('REJECTED', 'TIMED_OUT', 'FAILED')
    AND NEW."status" = 'READY';
  IF NEW."attempt" <> OLD."attempt" + (
    CASE WHEN is_retry THEN 1 ELSE 0 END
  ) THEN
    RAISE EXCEPTION 'Process Step attempt may increment exactly once only on RETRY.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'process_step_instances_attempt_transition_check';
  END IF;

  SELECT instance."status"
    INTO parent_status
  FROM public."process_instances" instance
  WHERE instance."tenant_id" = NEW."tenant_id"
    AND instance."id" = NEW."process_instance_id"
  FOR SHARE;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'The parent Process Instance does not exist.'
      USING ERRCODE = '23503', CONSTRAINT = 'process_step_instances_parent_check';
  END IF;
  IF parent_status IN ('COMPLETED', 'COMPENSATED', 'COMPENSATION_FAILED')
     OR (
       parent_status = 'CANCELLED'
       AND NEW."status" NOT IN ('CANCELLED', 'COMPENSATING')
     )
  THEN
    RAISE EXCEPTION 'A terminal Process Instance cannot advance normal Process Steps.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_parent_terminal';
  END IF;

  SELECT "type"
    INTO node_type
  FROM public."process_nodes"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."process_node_id";

  IF node_type IN ('HUMAN_APPROVAL', 'AGENT_EXECUTION')
     AND NEW."status" = 'SKIPPED'
  THEN
    RAISE EXCEPTION 'A human or Agent execution step cannot be skipped.'
      USING ERRCODE = '23514', CONSTRAINT = 'executable_process_step_no_skip';
  END IF;
  IF OLD."resolved_role_assignment_id" IS NOT NULL
     AND (
       NEW."resolved_role_assignment_id" IS DISTINCT FROM OLD."resolved_role_assignment_id"
       OR NEW."resolved_agent_id" IS DISTINCT FROM OLD."resolved_agent_id"
       OR NEW."assignment_snapshot" IS DISTINCT FROM OLD."assignment_snapshot"
     )
  THEN
    RAISE EXCEPTION 'A resolved Process Step identity and snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_immutable';
  END IF;
  IF OLD."resolved_role_assignment_id" IS NULL
     AND NEW."resolved_role_assignment_id" IS NOT NULL
  THEN
    IF NOT (OLD."status" = 'WAITING' AND NEW."status" = 'READY') THEN
      RAISE EXCEPTION 'A Process Step may resolve an assignment only while activating.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_transition';
    END IF;
    NEW."assignment_snapshot" := public.build_process_step_assignment_snapshot(
      NEW."tenant_id",
      NEW."process_instance_id",
      NEW."process_node_id",
      NEW."resolved_role_assignment_id",
      NEW."resolved_agent_id",
      CURRENT_TIMESTAMP
    );
  ELSIF NEW."resolved_role_assignment_id" IS NULL
     AND (NEW."resolved_agent_id" IS NOT NULL OR NEW."assignment_snapshot" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Process Step resolution fields must be supplied as one trusted unit.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_resolution_shape';
  END IF;
  IF node_type = 'HUMAN_APPROVAL' AND NEW."status" IN ('RUNNING', 'COMPLETED', 'REJECTED') THEN
    IF NEW."resolved_role_assignment_id" IS NULL OR NEW."resolved_agent_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A human approval step requires a human Role Assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'human_approval_human_actor';
    END IF;
    IF NEW."status" IN ('COMPLETED', 'REJECTED') AND (
      NEW."output" IS NULL
      OR jsonb_typeof(NEW."output"->'evidenceIds') <> 'array'
      OR jsonb_array_length(NEW."output"->'evidenceIds') < 1
    ) THEN
      RAISE EXCEPTION 'A human approval decision requires evidence.'
      USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_required';
    END IF;
    IF NEW."status" IN ('COMPLETED', 'REJECTED') THEN
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW."output"->'evidenceIds') item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
           OR (item.value #>> '{}')
                !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ) THEN
        RAISE EXCEPTION 'Human approval evidence IDs must be UUID strings.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_id_shape';
      END IF;
      requested_evidence_count := jsonb_array_length(NEW."output"->'evidenceIds');
      IF requested_evidence_count <> (
        SELECT count(DISTINCT item.value #>> '{}')
        FROM jsonb_array_elements(NEW."output"->'evidenceIds') item(value)
      ) THEN
        RAISE EXCEPTION 'Human approval evidence IDs must be unique.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_unique';
      END IF;
      SELECT count(*)
        INTO valid_evidence_count
      FROM public."evidence" evidence
      WHERE evidence."tenant_id" = NEW."tenant_id"
        AND evidence."id" IN (
          SELECT (item.value #>> '{}')::uuid
          FROM jsonb_array_elements(NEW."output"->'evidenceIds') item(value)
        )
        AND evidence."status" = 'ACTIVE'
        AND evidence."verified_at" IS NOT NULL
        AND evidence."effective_from" <= CURRENT_TIMESTAMP
        AND (
          evidence."effective_to" IS NULL
          OR evidence."effective_to" > CURRENT_TIMESTAMP
        );
      IF valid_evidence_count <> requested_evidence_count THEN
        RAISE EXCEPTION 'Human approval requires current verified Evidence records.'
          USING ERRCODE = '23514', CONSTRAINT = 'human_approval_evidence_valid';
      END IF;
    END IF;
  END IF;

  IF NEW."output" IS DISTINCT FROM OLD."output"
     AND NEW."status" NOT IN ('COMPLETED', 'REJECTED')
     AND NOT is_retry
  THEN
    RAISE EXCEPTION 'Step output may be written only by COMPLETE or REJECT.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_output_transition_check';
  END IF;
  IF (
       NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
       OR NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail"
     )
     AND NEW."status" NOT IN ('FAILED', 'COMPENSATION_FAILED')
     AND NOT is_retry
  THEN
    RAISE EXCEPTION 'Step failure detail may be written only by a failure transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_failure_transition_check';
  END IF;
  IF NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at"
     AND NEW."status" <> 'RUNNING'
     AND NOT is_retry
  THEN
    RAISE EXCEPTION 'Step claimed_at may be written only by CLAIM.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_claim_transition_check';
  END IF;
  IF NEW."started_at" IS DISTINCT FROM OLD."started_at"
     AND NEW."status" NOT IN ('RUNNING', 'COMPENSATING')
     AND NOT is_retry
  THEN
    RAISE EXCEPTION 'Step started_at does not match this transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_started_transition_check';
  END IF;
  IF NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
     AND NEW."status" NOT IN ('COMPLETED', 'REJECTED', 'COMPENSATED')
     AND NOT is_retry
  THEN
    RAISE EXCEPTION 'Step completed_at does not match this terminal transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_completed_transition_check';
  END IF;
  IF NEW."timed_out_at" IS DISTINCT FROM OLD."timed_out_at"
     AND NEW."status" <> 'TIMED_OUT'
     AND NOT is_retry
  THEN
    RAISE EXCEPTION 'Step timed_out_at may be written only by TIMEOUT.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_step_timeout_transition_check';
  END IF;

  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

-- A LOW correction may be closed directly by an independently nominated
-- reviewer. Subject self-closure remains forbidden; higher-risk corrections
-- keep the staged maker-checker path and evidence requirements.
CREATE OR REPLACE FUNCTION public.guard_correction_feedback_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  correction_record public."correction_cases"%ROWTYPE;
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
     OR NEW."occurred_at" > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Correction feedback revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'correction_feedback_revision_cas';
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
    CURRENT_TIMESTAMP,
    correction_record."task_id",
    'business.task.execute'
  );
  actor_user := (actor_snapshot->>'userId')::uuid;
  IF actor_snapshot IS NULL OR actor_user <> NEW."actor_user_id" THEN
    RAISE EXCEPTION 'Correction feedback actor is not a trusted active Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_actor_check';
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
    WHEN NEW."action" = 'EXPLAIN' AND correction_record."status" IN ('OPEN', 'ACKNOWLEDGED')
      THEN 'EXPLAINED'
    WHEN NEW."action" = 'ESCALATE' AND correction_record."status" NOT IN (
      'RESOLVED', 'CANCELLED'
    ) THEN 'ESCALATED'
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
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_transition_check';
  END IF;

  actor_is_subject :=
    NEW."actor_role_assignment_id" = correction_record."role_assignment_id";
  actor_is_reviewer :=
    correction_record."required_role_assignment_ids"
      ? NEW."actor_role_assignment_id"::text;
  IF (
    NEW."action" IN ('ACKNOWLEDGE', 'REJECT', 'EXPLAIN', 'ESCALATE')
    AND NOT actor_is_subject
    AND NOT actor_is_reviewer
  ) OR (
    NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL')
    AND NOT actor_is_reviewer
  ) THEN
    RAISE EXCEPTION 'Correction feedback actor does not hold the required subject or review role.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_actor_role_check';
  END IF;

  high_impact :=
    correction_record."severity" IN ('HIGH', 'CRITICAL')
    OR correction_record."category" = 'CAPABILITY_RISK';
  requires_evidence :=
    NEW."action" IN ('REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE')
    OR (
      high_impact
      AND NEW."action" IN ('ACCEPT', 'CANCEL')
    );
  IF requires_evidence AND jsonb_array_length(NEW."evidence_ids") = 0 THEN
    RAISE EXCEPTION 'This Correction feedback action requires trusted evidence.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_required';
  END IF;
  IF high_impact AND NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL') THEN
    IF actor_user = subject_user_id
       OR NOT correction_record."required_role_assignment_ids" ? NEW."actor_role_assignment_id"::text
       OR NOT actor_is_reviewer THEN
      RAISE EXCEPTION 'A high-impact terminal correction decision requires an independent reviewer and evidence.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_independent_review_check';
    END IF;
  END IF;
  IF jsonb_array_length(NEW."evidence_ids") > 0 THEN
    SELECT count(DISTINCT value)
      INTO evidence_id_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value);
    IF evidence_id_count <> jsonb_array_length(NEW."evidence_ids") THEN
      RAISE EXCEPTION 'Correction feedback Evidence IDs must be unique.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_unique';
    END IF;
    SELECT count(DISTINCT evidence."id"::text)
      INTO evidence_valid_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value)
    JOIN public."evidence" evidence
      ON evidence."tenant_id" = NEW."tenant_id"
     AND evidence."id" = item.value::uuid
     AND evidence."status" = 'ACTIVE'
     AND evidence."verified_at" IS NOT NULL
     AND evidence."effective_from" <= CURRENT_TIMESTAMP
     AND (evidence."effective_to" IS NULL OR evidence."effective_to" > CURRENT_TIMESTAMP)
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
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_check';
    END IF;
  END IF;

  UPDATE public."correction_cases"
  SET "status" = next_status,
      "revision" = NEW."revision",
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
    AND "revision" = correction_record."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'correction_cases_revision_cas';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_correction_case_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  feedback_action public."CorrectionFeedbackAction";
  expected_status public."CorrectionStatus";
BEGIN
  IF (
    NEW."tenant_id", NEW."correlation_id", NEW."subject_type", NEW."subject_id",
    NEW."subject_version", NEW."role_assignment_id", NEW."objective_id",
    NEW."objective_version", NEW."task_id", NEW."task_version",
    NEW."process_instance_id", NEW."trigger", NEW."category", NEW."severity",
    NEW."confidence", NEW."rule_findings", NEW."model_finding",
    NEW."evidence_refs", NEW."impact", NEW."suggested_actions",
    NEW."required_role_assignment_ids", NEW."permission_labels",
    NEW."idempotency_key", NEW."request_hash", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."correlation_id", OLD."subject_type", OLD."subject_id",
    OLD."subject_version", OLD."role_assignment_id", OLD."objective_id",
    OLD."objective_version", OLD."task_id", OLD."task_version",
    OLD."process_instance_id", OLD."trigger", OLD."category", OLD."severity",
    OLD."confidence", OLD."rule_findings", OLD."model_finding",
    OLD."evidence_refs", OLD."impact", OLD."suggested_actions",
    OLD."required_role_assignment_ids", OLD."permission_labels",
    OLD."idempotency_key", OLD."request_hash", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Correction case evidence and subject snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_identity_immutable';
  END IF;
  SELECT feedback."action"
    INTO feedback_action
  FROM public."correction_feedback" feedback
  WHERE feedback."tenant_id" = NEW."tenant_id"
    AND feedback."correction_case_id" = NEW."id"
    AND feedback."revision" = NEW."revision";
  expected_status := CASE
    WHEN feedback_action = 'ACKNOWLEDGE' AND OLD."status" = 'OPEN'
      THEN 'ACKNOWLEDGED'
    WHEN feedback_action = 'ACCEPT' AND OLD."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'ACCEPTED'
    WHEN feedback_action = 'REJECT' AND OLD."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'REJECTED'
    WHEN feedback_action = 'EXPLAIN' AND OLD."status" IN ('OPEN', 'ACKNOWLEDGED')
      THEN 'EXPLAINED'
    WHEN feedback_action = 'ESCALATE' AND OLD."status" NOT IN (
      'RESOLVED', 'CANCELLED'
    ) THEN 'ESCALATED'
    WHEN feedback_action = 'RESOLVE'
      AND (
        OLD."status" IN ('ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED')
        OR (OLD."severity" = 'LOW' AND OLD."status" = 'OPEN')
      ) THEN 'RESOLVED'
    WHEN feedback_action = 'CANCEL' AND OLD."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
    ) THEN 'CANCELLED'
    ELSE NULL
  END;
  IF NEW."revision" <> OLD."revision" + 1
     OR feedback_action IS NULL
     OR expected_status IS NULL
     OR NEW."status" <> expected_status THEN
    RAISE EXCEPTION 'Correction state must be advanced by immutable feedback.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_feedback_coverage';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

-- Keep the deferred aggregate replay validator aligned with the row-level
-- transition guards above. Without this additive replacement, a valid LOW
-- OPEN -> RESOLVED transition is accepted row-by-row but rejected at COMMIT.
CREATE OR REPLACE FUNCTION public.validate_correction_trace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_record public."correction_cases"%ROWTYPE;
  feedback_record record;
  feedback_count integer;
  expected_revision integer := 2;
  replay_status text := 'OPEN';
  previous_occurred_at timestamptz;
BEGIN
  SELECT *
    INTO current_record
  FROM public."correction_cases"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."id";
  IF current_record."id" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*)
    INTO feedback_count
  FROM public."correction_feedback" feedback
  WHERE feedback."tenant_id" = current_record."tenant_id"
    AND feedback."correction_case_id" = current_record."id";
  IF feedback_count <> current_record."revision" - 1 THEN
    RAISE EXCEPTION 'Correction feedback trace is incomplete.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_complete_trace_check';
  END IF;
  FOR feedback_record IN
    SELECT *
    FROM public."correction_feedback" feedback
    WHERE feedback."tenant_id" = current_record."tenant_id"
      AND feedback."correction_case_id" = current_record."id"
    ORDER BY feedback."revision"
  LOOP
    IF feedback_record."revision" <> expected_revision
       OR (
         previous_occurred_at IS NOT NULL
         AND feedback_record."occurred_at" < previous_occurred_at
       )
       OR feedback_record."occurred_at" < current_record."created_at" THEN
      RAISE EXCEPTION 'Correction feedback trace cannot be replayed.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_trace_replay_check';
    END IF;
    replay_status := CASE
      WHEN feedback_record."action" = 'ACKNOWLEDGE' AND replay_status = 'OPEN'
        THEN 'ACKNOWLEDGED'
      WHEN feedback_record."action" = 'ACCEPT' AND replay_status IN (
        'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
      ) THEN 'ACCEPTED'
      WHEN feedback_record."action" = 'REJECT' AND replay_status IN (
        'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
      ) THEN 'REJECTED'
      WHEN feedback_record."action" = 'EXPLAIN'
        AND replay_status IN ('OPEN', 'ACKNOWLEDGED')
        THEN 'EXPLAINED'
      WHEN feedback_record."action" = 'ESCALATE'
        AND replay_status NOT IN ('RESOLVED', 'CANCELLED')
        THEN 'ESCALATED'
      WHEN feedback_record."action" = 'RESOLVE'
        AND (
          replay_status IN ('ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED')
          OR (current_record."severity" = 'LOW' AND replay_status = 'OPEN')
        ) THEN 'RESOLVED'
      WHEN feedback_record."action" = 'CANCEL' AND replay_status IN (
        'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
      ) THEN 'CANCELLED'
      ELSE NULL
    END;
    IF replay_status IS NULL THEN
      RAISE EXCEPTION 'Correction feedback sequence contains an illegal transition.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_trace_status_check';
    END IF;
    previous_occurred_at := feedback_record."occurred_at";
    expected_revision := expected_revision + 1;
  END LOOP;
  IF expected_revision <> current_record."revision" + 1
     OR replay_status <> current_record."status"::text THEN
    RAISE EXCEPTION 'Correction aggregate does not match its immutable feedback trace.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_trace_state_check';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.validate_business_ledger_parent_bijection()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_process_step_attempt_integrity()
  FROM PUBLIC;

COMMIT;
