BEGIN;

-- Forward replacement for databases that applied 022 before the nullable-side lock correction.
-- A Task may name a Role Assignment as its owner without redundantly storing
-- owner_org_unit_id. Resolve that immutable ownership reference through its
-- Employment instead of treating the optional denormalized column as required.
-- If both representations exist they must agree. A non-owner collaborator is
-- still admitted only by an exact Task grant or Objective assignment and is
-- always checked against the Task owner's organization, action and labels.
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
  task_organization_id uuid;
  task_org_unit_id uuid;
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
    explicit_owner_unit."organization_id" AS explicit_owner_organization_id,
    explicit_owner_unit."status" AS explicit_owner_org_unit_status,
    task_owner_assignment."id" AS resolved_owner_assignment_id,
    task_owner_assignment."user_id" AS resolved_owner_user_id,
    task_owner_assignment."role_template_id" AS resolved_owner_role_template_id,
    task_owner_employment."organization_id" AS resolved_owner_organization_id,
    task_owner_employment."org_unit_id" AS resolved_owner_org_unit_id,
    resolved_owner_unit."status" AS resolved_owner_org_unit_status,
    task."status"
  INTO task_record
  FROM public."tasks" task
  LEFT JOIN public."org_units" explicit_owner_unit
    ON explicit_owner_unit."tenant_id" = task."tenant_id"
   AND explicit_owner_unit."id" = task."owner_org_unit_id"
  LEFT JOIN public."role_assignments" task_owner_assignment
    ON task_owner_assignment."tenant_id" = task."tenant_id"
   AND task_owner_assignment."id" = task."owner_role_assignment_id"
   AND task_owner_assignment."status" = 'ACTIVE'
   AND task_owner_assignment."effective_from" <= p_effective_at
   AND (
     task_owner_assignment."effective_to" IS NULL
     OR task_owner_assignment."effective_to" > p_effective_at
   )
  LEFT JOIN public."employments" task_owner_employment
    ON task_owner_employment."tenant_id" = task_owner_assignment."tenant_id"
   AND task_owner_employment."id" = task_owner_assignment."employment_id"
   AND task_owner_employment."user_id" = task_owner_assignment."user_id"
   AND task_owner_employment."status" = 'ACTIVE'
  LEFT JOIN public."org_units" resolved_owner_unit
    ON resolved_owner_unit."tenant_id" = task_owner_employment."tenant_id"
   AND resolved_owner_unit."id" = task_owner_employment."org_unit_id"
   AND resolved_owner_unit."organization_id" = task_owner_employment."organization_id"
  WHERE task."tenant_id" = p_tenant_id
    AND task."id" = p_task_id
  -- PostgreSQL cannot row-lock the nullable side of an outer join. Lock the
  -- immutable Task identity; all derived rows are read from this statement's
  -- single MVCC snapshot and the acting Assignment is locked above.
  FOR SHARE OF task;

  IF task_record."id" IS NULL
     OR task_record."status" NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED') THEN
    RAISE EXCEPTION 'Role Assignment is outside the active Task scope.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_task_scope_check';
  END IF;

  IF task_record."owner_org_unit_id" IS NOT NULL THEN
    IF task_record."explicit_owner_organization_id" IS NULL
       OR task_record."explicit_owner_org_unit_status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Task owner organization scope is missing or inactive.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'trusted_assignment_task_organization_check';
    END IF;
    task_organization_id := task_record."explicit_owner_organization_id";
    task_org_unit_id := task_record."owner_org_unit_id";
    IF task_record."resolved_owner_org_unit_id" IS NOT NULL
       AND (
         task_record."resolved_owner_org_unit_id" <> task_org_unit_id
         OR task_record."resolved_owner_organization_id" <> task_organization_id
       ) THEN
      RAISE EXCEPTION 'Task owner Assignment and explicit organization scope disagree.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'trusted_assignment_task_organization_check';
    END IF;
  ELSIF task_record."resolved_owner_assignment_id" IS NOT NULL THEN
    IF task_record."resolved_owner_organization_id" IS NULL
       OR task_record."resolved_owner_org_unit_id" IS NULL
       OR task_record."resolved_owner_org_unit_status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Task owner Assignment has no active organization context.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'trusted_assignment_task_organization_check';
    END IF;
    task_organization_id := task_record."resolved_owner_organization_id";
    task_org_unit_id := task_record."resolved_owner_org_unit_id";
  ELSIF assignment_record."user_id" = task_record."owner_user_id"
     OR assignment_record."role_template_id" = task_record."owner_role_template_id" THEN
    -- The current Assignment is itself the explicit Task owner identity.
    task_organization_id := assignment_record."organization_id";
    task_org_unit_id := assignment_record."org_unit_id";
  ELSE
    RAISE EXCEPTION 'Task has no trusted owner organization context.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trusted_assignment_task_organization_check';
  END IF;

  action_family := split_part(p_required_action, '.', 2);
  IF NOT COALESCE((
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
         @> jsonb_build_array(task_organization_id::text)
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
         @> jsonb_build_array(task_org_unit_id::text)
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
    'taskOrganizationId', task_organization_id,
    'taskOrgUnitId', task_org_unit_id,
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

REVOKE ALL ON FUNCTION public.build_trusted_assignment_snapshot(
  uuid, uuid, jsonb, timestamptz, uuid, text
) FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
  enterprise_agent_auth, enterprise_agent_provisioner;
GRANT EXECUTE ON FUNCTION public.build_trusted_assignment_snapshot(
  uuid, uuid, jsonb, timestamptz, uuid, text
) TO enterprise_agent_process;

COMMIT;
