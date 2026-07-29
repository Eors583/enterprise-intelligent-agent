-- Employee Experience Center and self-only AI usage capability.
--
-- This role is intentionally separate from both enterprise_agent_app and
-- enterprise_agent_admin. It can read only the current user's Agent Runs and
-- Experience Candidates, can append a new candidate with governed provenance,
-- and cannot execute any governance transition or update/delete ledger state.

BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'enterprise_agent_employee_insights'
  ) THEN
    CREATE ROLE enterprise_agent_employee_insights
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_employee_insights
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT enterprise_agent_employee_insights TO %I', current_user);
END
$role$;

GRANT USAGE ON SCHEMA public TO enterprise_agent_employee_insights;
GRANT USAGE ON TYPE
  public."ExperienceStatus",
  public."MemorySensitivity"
TO enterprise_agent_employee_insights;

CREATE OR REPLACE FUNCTION public.employee_insights_task_authorized(
  input_tenant_id uuid,
  input_user_id uuid,
  input_task_id uuid,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    input_tenant_id =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND input_user_id =
      NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
    SELECT 1
    FROM public."tasks" task
    WHERE task."tenant_id" = input_tenant_id
      AND task."id" = input_task_id
      AND task."status" <> 'CANCELLED'
      AND task."effective_from" <= at_time
      AND (task."effective_to" IS NULL OR task."effective_to" > at_time)
      AND (
        task."owner_user_id" = input_user_id
        OR EXISTS (
          SELECT 1
          FROM public."role_assignments" assignment
          WHERE assignment."tenant_id" = task."tenant_id"
            AND assignment."id" = task."owner_role_assignment_id"
            AND assignment."user_id" = input_user_id
            AND public.memory_assignment_active(
              assignment."tenant_id",
              assignment."id",
              assignment."user_id",
              assignment."role_template_id",
              assignment."role_version_id",
              at_time
            )
        )
        OR EXISTS (
          SELECT 1
          FROM public."objective_role_assignments" objective_assignment
          JOIN public."role_assignments" assignment
            ON assignment."tenant_id" = objective_assignment."tenant_id"
           AND assignment."id" = objective_assignment."role_assignment_id"
          WHERE objective_assignment."tenant_id" = task."tenant_id"
            AND objective_assignment."objective_id" = task."objective_id"
            AND objective_assignment."objective_version" = task."objective_version"
            AND assignment."user_id" = input_user_id
            AND public.memory_assignment_active(
              assignment."tenant_id",
              assignment."id",
              assignment."user_id",
              assignment."role_template_id",
              assignment."role_version_id",
              at_time
            )
        )
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.employee_insights_deliverable_authorized(
  input_tenant_id uuid,
  input_user_id uuid,
  input_task_id uuid,
  input_deliverable_id uuid,
  input_deliverable_version integer,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    public.employee_insights_task_authorized(
      input_tenant_id, input_user_id, input_task_id, at_time
    )
    AND EXISTS (
      SELECT 1
      FROM public."deliverables" deliverable
      WHERE deliverable."tenant_id" = input_tenant_id
        AND deliverable."id" = input_deliverable_id
        AND deliverable."version" = input_deliverable_version
        AND deliverable."task_id" = input_task_id
        AND deliverable."status" IN ('SUBMITTED', 'ACCEPTED')
        AND deliverable."evidence_sealed_at" IS NOT NULL
    )
$function$;

CREATE OR REPLACE FUNCTION public.employee_insights_evidence_authorized(
  input_tenant_id uuid,
  input_user_id uuid,
  input_task_id uuid,
  input_evidence_id uuid,
  input_evidence_version integer,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    public.employee_insights_task_authorized(
      input_tenant_id, input_user_id, input_task_id, at_time
    )
    AND EXISTS (
      SELECT 1
      FROM public."evidence" evidence
      WHERE evidence."tenant_id" = input_tenant_id
        AND evidence."id" = input_evidence_id
        AND evidence."version" = input_evidence_version
        AND evidence."status" = 'ACTIVE'
        AND evidence."trust_level" = 'VERIFIED'
        AND evidence."verified_at" IS NOT NULL
        AND evidence."effective_from" <= at_time
        AND (evidence."effective_to" IS NULL OR evidence."effective_to" > at_time)
        AND (
          EXISTS (
            SELECT 1
            FROM public."evidence_links" link
            WHERE link."tenant_id" = evidence."tenant_id"
              AND link."evidence_id" = evidence."id"
              AND link."evidence_version" = evidence."version"
              AND link."status" = 'ACTIVE'
              AND link."target_type" = 'TASK'
              AND link."target_task_id" = input_task_id
              AND link."effective_from" <= at_time
              AND (link."effective_to" IS NULL OR link."effective_to" > at_time)
          )
          OR EXISTS (
            SELECT 1
            FROM public."deliverable_evidence" deliverable_evidence
            JOIN public."deliverables" deliverable
              ON deliverable."tenant_id" = deliverable_evidence."tenant_id"
             AND deliverable."id" = deliverable_evidence."deliverable_id"
             AND deliverable."version" = deliverable_evidence."deliverable_version"
            WHERE deliverable_evidence."tenant_id" = evidence."tenant_id"
              AND deliverable_evidence."evidence_id" = evidence."id"
              AND deliverable_evidence."evidence_version" = evidence."version"
              AND deliverable."task_id" = input_task_id
              AND deliverable."status" IN ('SUBMITTED', 'ACCEPTED')
              AND deliverable."evidence_sealed_at" IS NOT NULL
          )
        )
    )
$function$;

CREATE OR REPLACE FUNCTION public.employee_insights_evidence_visible(
  input_tenant_id uuid,
  input_user_id uuid,
  input_evidence_id uuid,
  input_evidence_version integer,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public."tasks" task
    WHERE task."tenant_id" = input_tenant_id
      AND public.employee_insights_evidence_authorized(
        input_tenant_id,
        input_user_id,
        task."id",
        input_evidence_id,
        input_evidence_version,
        at_time
      )
  )
$function$;

REVOKE ALL ON FUNCTION public.employee_insights_task_authorized(
  uuid, uuid, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee_insights_deliverable_authorized(
  uuid, uuid, uuid, uuid, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee_insights_evidence_authorized(
  uuid, uuid, uuid, uuid, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee_insights_evidence_visible(
  uuid, uuid, uuid, integer, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.memory_assignment_active(
  uuid, uuid, uuid, uuid, uuid, timestamptz
) TO enterprise_agent_employee_insights;
GRANT EXECUTE ON FUNCTION public.employee_insights_task_authorized(
  uuid, uuid, uuid, timestamptz
) TO enterprise_agent_employee_insights;
GRANT EXECUTE ON FUNCTION public.employee_insights_deliverable_authorized(
  uuid, uuid, uuid, uuid, integer, timestamptz
) TO enterprise_agent_employee_insights;
GRANT EXECUTE ON FUNCTION public.employee_insights_evidence_authorized(
  uuid, uuid, uuid, uuid, integer, timestamptz
) TO enterprise_agent_employee_insights;
GRANT EXECUTE ON FUNCTION public.employee_insights_evidence_visible(
  uuid, uuid, uuid, integer, timestamptz
) TO enterprise_agent_employee_insights;

REVOKE ALL ON TABLE
  public."experience_candidates",
  public."experience_source_deliverables",
  public."experience_source_evidence",
  public."experience_commands",
  public."experience_review_evidence",
  public."experience_validations",
  public."experience_publications",
  public."experience_publication_role_targets",
  public."experience_publication_org_targets",
  public."agent_runs",
  public."agent_instances",
  public."tasks",
  public."deliverables",
  public."evidence",
  public."role_assignments",
  public."audit_events",
  public."outbox_events"
FROM enterprise_agent_employee_insights;

GRANT SELECT, INSERT ON TABLE
  public."experience_candidates",
  public."experience_source_deliverables",
  public."experience_source_evidence"
TO enterprise_agent_employee_insights;

GRANT SELECT ON TABLE
  public."agent_runs",
  public."agent_instances",
  public."tasks",
  public."deliverables",
  public."evidence",
  public."role_assignments"
TO enterprise_agent_employee_insights;

GRANT INSERT ON TABLE
  public."audit_events",
  public."outbox_events"
TO enterprise_agent_employee_insights;

CREATE POLICY "employee_insights_candidate_select"
  ON public."experience_candidates"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND "contributor_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY "employee_insights_candidate_insert"
  ON public."experience_candidates"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_employee_insights
  WITH CHECK (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND "contributor_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
    AND public.employee_insights_task_authorized(
      "tenant_id",
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      "source_task_id",
      "created_at"
    )
  );

CREATE POLICY "employee_insights_source_deliverable_select"
  ON public."experience_source_deliverables"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."experience_candidates" candidate
      WHERE candidate."tenant_id" = "experience_source_deliverables"."tenant_id"
        AND candidate."id" = "experience_source_deliverables"."experience_id"
        AND candidate."contributor_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

CREATE POLICY "employee_insights_source_deliverable_insert"
  ON public."experience_source_deliverables"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_employee_insights
  WITH CHECK (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."experience_candidates" candidate
      WHERE candidate."tenant_id" = "experience_source_deliverables"."tenant_id"
        AND candidate."id" = "experience_source_deliverables"."experience_id"
        AND candidate."contributor_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
        AND public.employee_insights_deliverable_authorized(
          candidate."tenant_id",
          candidate."contributor_user_id",
          candidate."source_task_id",
          "experience_source_deliverables"."deliverable_id",
          "experience_source_deliverables"."deliverable_version",
          CURRENT_TIMESTAMP
        )
    )
  );

CREATE POLICY "employee_insights_source_evidence_select"
  ON public."experience_source_evidence"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."experience_candidates" candidate
      WHERE candidate."tenant_id" = "experience_source_evidence"."tenant_id"
        AND candidate."id" = "experience_source_evidence"."experience_id"
        AND candidate."contributor_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

CREATE POLICY "employee_insights_source_evidence_insert"
  ON public."experience_source_evidence"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_employee_insights
  WITH CHECK (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."experience_candidates" candidate
      WHERE candidate."tenant_id" = "experience_source_evidence"."tenant_id"
        AND candidate."id" = "experience_source_evidence"."experience_id"
        AND candidate."contributor_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
        AND public.employee_insights_evidence_authorized(
          candidate."tenant_id",
          candidate."contributor_user_id",
          candidate."source_task_id",
          "experience_source_evidence"."evidence_id",
          "experience_source_evidence"."evidence_version",
          CURRENT_TIMESTAMP
        )
    )
  );

CREATE POLICY "employee_insights_run_select"
  ON public."agent_runs"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND "requester_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY "employee_insights_agent_select"
  ON public."agent_instances"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."agent_runs" run
      WHERE run."tenant_id" = "agent_instances"."tenant_id"
        AND run."agent_id" = "agent_instances"."id"
        AND run."requester_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

CREATE POLICY "employee_insights_task_select"
  ON public."tasks"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND public.employee_insights_task_authorized(
      "tenant_id",
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      "id",
      CURRENT_TIMESTAMP
    )
  );

CREATE POLICY "employee_insights_deliverable_select"
  ON public."deliverables"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND public.employee_insights_deliverable_authorized(
      "tenant_id",
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      "task_id",
      "id",
      "version",
      CURRENT_TIMESTAMP
    )
  );

CREATE POLICY "employee_insights_evidence_select"
  ON public."evidence"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND public.employee_insights_evidence_visible(
      "tenant_id",
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      "id",
      "version",
      CURRENT_TIMESTAMP
    )
  );

CREATE POLICY "employee_insights_assignment_select"
  ON public."role_assignments"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_employee_insights
  USING (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY "employee_insights_audit_insert"
  ON public."audit_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_employee_insights
  WITH CHECK (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND "actor_type" = 'USER'
    AND "actor_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND "action" = 'experience.candidate.created'
    AND "resource_type" = 'EXPERIENCE'
    AND EXISTS (
      SELECT 1
      FROM public."experience_candidates" candidate
      WHERE candidate."tenant_id" = "audit_events"."tenant_id"
        AND candidate."id" = "audit_events"."resource_id"
        AND candidate."contributor_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

CREATE POLICY "employee_insights_outbox_insert"
  ON public."outbox_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_employee_insights
  WITH CHECK (
    "tenant_id" =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND "aggregate_type" = 'EXPERIENCE'
    AND "event_type" = 'ExperienceCandidateCreated'
    AND EXISTS (
      SELECT 1
      FROM public."experience_candidates" candidate
      WHERE candidate."tenant_id" = "outbox_events"."tenant_id"
        AND candidate."id" = "outbox_events"."aggregate_id"
        AND candidate."contributor_user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

COMMIT;
