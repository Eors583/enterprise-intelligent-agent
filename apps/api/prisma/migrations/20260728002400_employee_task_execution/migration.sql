-- Least-privilege employee Task execution, evidence contribution, Deliverable
-- submission, and Acceptance request boundary.

BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'enterprise_agent_task_executor'
  ) THEN
    CREATE ROLE enterprise_agent_task_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_task_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT enterprise_agent_task_executor TO %I', current_user);
END
$role$;

CREATE TABLE public."employee_task_commands" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "actor_role_assignment_id" uuid NOT NULL,
  "action" varchar(160) NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "response_payload" jsonb NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_task_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_task_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "employee_task_commands_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "employee_task_commands_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_commands_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id")
    REFERENCES public."tasks"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_commands_actor_user_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_commands_actor_assignment_fkey"
    FOREIGN KEY ("tenant_id", "actor_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_commands_action_check" CHECK (
    "action" IN (
      'business.task.execute',
      'business.deliverable.submit',
      'business.evidence.contribute',
      'business.acceptance.request'
    )
  ),
  CONSTRAINT "employee_task_commands_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "employee_task_commands_response_check" CHECK (
    jsonb_typeof("response_payload") = 'object'
  )
);

CREATE INDEX "employee_task_commands_task_idx"
  ON public."employee_task_commands"(
    "tenant_id", "task_id", "created_at" DESC, "id"
  );

CREATE TABLE public."employee_task_acceptance_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "task_version" integer NOT NULL,
  "deliverable_id" uuid NOT NULL,
  "deliverable_version" integer NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "requested_by_role_assignment_id" uuid NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'REQUESTED',
  "revision" integer NOT NULL DEFAULT 1,
  "reason" text NOT NULL,
  "due_at" timestamptz(6) NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "requested_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_task_acceptance_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_task_acceptance_requests_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "employee_task_acceptance_requests_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "employee_task_acceptance_requests_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_acceptance_requests_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_acceptance_requests_deliverable_fkey"
    FOREIGN KEY ("tenant_id", "deliverable_id", "deliverable_version")
    REFERENCES public."deliverables"("tenant_id", "id", "version") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_acceptance_requests_user_fkey"
    FOREIGN KEY ("tenant_id", "requested_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_acceptance_requests_assignment_fkey"
    FOREIGN KEY ("tenant_id", "requested_by_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "employee_task_acceptance_requests_status_check"
    CHECK ("status" = 'REQUESTED'),
  CONSTRAINT "employee_task_acceptance_requests_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "employee_task_acceptance_requests_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 1 AND 20000),
  CONSTRAINT "employee_task_acceptance_requests_due_check"
    CHECK ("due_at" > "requested_at"),
  CONSTRAINT "employee_task_acceptance_requests_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "employee_task_acceptance_requests_task_idx"
  ON public."employee_task_acceptance_requests"(
    "tenant_id", "task_id", "requested_at" DESC, "id"
  );
CREATE INDEX "employee_task_acceptance_requests_deliverable_idx"
  ON public."employee_task_acceptance_requests"(
    "tenant_id", "deliverable_id", "deliverable_version", "requested_at" DESC
  );

CREATE OR REPLACE FUNCTION public.reject_employee_task_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Employee Task command and Acceptance Request ledgers are append-only.'
    USING ERRCODE = '55000';
END
$function$;

REVOKE ALL ON FUNCTION public.reject_employee_task_ledger_mutation() FROM PUBLIC;

CREATE TRIGGER "employee_task_commands_append_only"
BEFORE UPDATE OR DELETE ON public."employee_task_commands"
FOR EACH ROW
EXECUTE FUNCTION public.reject_employee_task_ledger_mutation();
CREATE TRIGGER "employee_task_commands_reject_truncate"
BEFORE TRUNCATE ON public."employee_task_commands"
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_employee_task_ledger_mutation();
CREATE TRIGGER "employee_task_acceptance_requests_append_only"
BEFORE UPDATE OR DELETE ON public."employee_task_acceptance_requests"
FOR EACH ROW
EXECUTE FUNCTION public.reject_employee_task_ledger_mutation();
CREATE TRIGGER "employee_task_acceptance_requests_reject_truncate"
BEFORE TRUNCATE ON public."employee_task_acceptance_requests"
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_employee_task_ledger_mutation();

CREATE OR REPLACE FUNCTION public.employee_task_action_authorized(
  input_tenant_id uuid,
  input_task_id uuid,
  required_action text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    required_action IN (
      'business.task.execute',
      'business.deliverable.submit',
      'business.evidence.contribute',
      'business.acceptance.request'
    )
    AND required_action =
      NULLIF(current_setting('app.action', true), '')
    AND input_tenant_id =
      NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."tasks" task
      JOIN public."role_assignments" assignment
        ON assignment."tenant_id" = task."tenant_id"
       AND assignment."id" =
         NULLIF(current_setting('app.role_assignment_id', true), '')::uuid
      WHERE task."tenant_id" = input_tenant_id
        AND task."id" = input_task_id
        AND assignment."user_id" =
          NULLIF(current_setting('app.user_id', true), '')::uuid
        AND public.memory_assignment_active(
          assignment."tenant_id",
          assignment."id",
          assignment."user_id",
          assignment."role_template_id",
          assignment."role_version_id",
          CURRENT_TIMESTAMP
        )
        AND (
          assignment."permission_scope" -> 'actions' ? required_action
          OR assignment."permission_scope" -> 'actions' ? 'business.*'
          OR assignment."permission_scope" -> 'actions'
            ? ('business.' || split_part(required_action, '.', 2) || '.*')
        )
        AND assignment."permission_scope" -> 'taskIds' ? task."id"::text
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(task."permission_labels") label(value)
          WHERE NOT (
            assignment."permission_scope" -> 'dataLabels' ? label.value
          )
        )
        AND task."effective_from" <= CURRENT_TIMESTAMP
        AND (
          task."effective_to" IS NULL
          OR task."effective_to" > CURRENT_TIMESTAMP
        )
        AND task."status" <> 'CANCELLED'
        AND (
          task."owner_user_id" = assignment."user_id"
          OR task."owner_role_assignment_id" = assignment."id"
          OR task."owner_role_template_id" = assignment."role_template_id"
          OR EXISTS (
            SELECT 1
            FROM public."objective_role_assignments" objective_assignment
            WHERE objective_assignment."tenant_id" = task."tenant_id"
              AND objective_assignment."objective_id" = task."objective_id"
              AND objective_assignment."objective_version" = task."objective_version"
              AND objective_assignment."role_assignment_id" = assignment."id"
          )
        )
    )
$function$;

REVOKE ALL ON FUNCTION public.employee_task_action_authorized(
  uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_task_action_authorized(
  uuid, uuid, text
) TO enterprise_agent_task_executor;
GRANT EXECUTE ON FUNCTION public.memory_assignment_active(
  uuid, uuid, uuid, uuid, uuid, timestamptz
) TO enterprise_agent_task_executor;

CREATE OR REPLACE FUNCTION public.employee_submit_task_evidence(
  input_tenant_id uuid,
  input_task_id uuid,
  input_code text,
  input_source_type public."EvidenceSourceType",
  input_source_system text,
  input_source_record_id text,
  input_source_version text,
  input_source_uri text,
  input_observed_at timestamptz,
  input_content_hash text,
  input_summary text,
  input_effective_from timestamptz,
  input_effective_to timestamptz,
  input_permission_labels jsonb,
  input_idempotency_key text,
  input_request_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  evidence_id uuid;
  task_version integer;
  assignment_id uuid :=
    NULLIF(current_setting('app.role_assignment_id', true), '')::uuid;
  user_id uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  existing_hash text;
  link_code text;
BEGIN
  IF NOT public.employee_task_action_authorized(
    input_tenant_id, input_task_id, 'business.evidence.contribute'
  ) THEN
    RAISE EXCEPTION 'Employee Evidence contribution is not authorized.'
      USING ERRCODE = '42501';
  END IF;
  IF input_source_type NOT IN ('DOCUMENT', 'HUMAN_ATTESTATION')
    OR input_permission_labels IS NULL
    OR NOT public.semantic_permission_labels_valid(input_permission_labels)
    OR input_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'Employee Evidence input is invalid.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      input_tenant_id::text || ':employee-evidence:' || input_idempotency_key,
      0
    )
  );
  SELECT evidence."id", evidence."request_hash"
    INTO evidence_id, existing_hash
  FROM public."evidence" evidence
  WHERE evidence."tenant_id" = input_tenant_id
    AND evidence."idempotency_key" = input_idempotency_key;
  IF evidence_id IS NOT NULL THEN
    IF existing_hash <> input_request_hash THEN
      RAISE EXCEPTION 'Evidence idempotency key payload differs.'
        USING ERRCODE = '23505';
    END IF;
    RETURN evidence_id;
  END IF;

  SELECT task."version" INTO STRICT task_version
  FROM public."tasks" task
  WHERE task."tenant_id" = input_tenant_id
    AND task."id" = input_task_id
  FOR SHARE;

  evidence_id := gen_random_uuid();
  INSERT INTO public."evidence" (
    "id", "tenant_id", "code", "version", "revision", "status",
    "source_type", "source_system", "source_record_id", "source_version",
    "source_uri", "observed_at", "content_hash_algorithm", "content_hash",
    "trust_level", "confidence", "summary",
    "verified_by_user_id", "verified_by_role_assignment_id",
    "verified_by_role_template_id", "verified_by_org_unit_id", "verified_at",
    "owner_user_id", "owner_role_assignment_id",
    "owner_role_template_id", "owner_org_unit_id",
    "permission_labels", "effective_from", "effective_to",
    "idempotency_key", "request_hash"
  ) VALUES (
    evidence_id, input_tenant_id, input_code, 1, 1, 'DRAFT',
    input_source_type, input_source_system, input_source_record_id,
    input_source_version, input_source_uri, input_observed_at,
    'SHA256', input_content_hash, 'UNVERIFIED', 0.5, input_summary,
    NULL, NULL, NULL, NULL, NULL,
    NULL, assignment_id, NULL, NULL,
    input_permission_labels, input_effective_from, input_effective_to,
    input_idempotency_key, input_request_hash
  );

  link_code := left(input_code, 94) || '.EVID';
  INSERT INTO public."evidence_links" (
    "id", "tenant_id", "code", "version", "revision",
    "evidence_id", "evidence_version", "target_type",
    "target_task_id", "target_version", "status", "type",
    "relevance", "statement",
    "owner_user_id", "owner_role_assignment_id",
    "owner_role_template_id", "owner_org_unit_id",
    "permission_labels", "effective_from", "effective_to",
    "idempotency_key", "request_hash"
  ) VALUES (
    gen_random_uuid(), input_tenant_id, link_code, 1, 1,
    evidence_id, 1, 'TASK', input_task_id, task_version,
    'ACTIVE', 'SUPPORTS', 1,
    'Employee submitted Evidence candidate for this Task.',
    NULL, assignment_id, NULL, NULL,
    input_permission_labels, input_effective_from, input_effective_to,
    left(input_idempotency_key, 195) || ':link', input_request_hash
  );
  RETURN evidence_id;
END
$function$;

REVOKE ALL ON FUNCTION public.employee_submit_task_evidence(
  uuid, uuid, text, public."EvidenceSourceType", text, text, text, text,
  timestamptz, text, text, timestamptz, timestamptz, jsonb, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_submit_task_evidence(
  uuid, uuid, text, public."EvidenceSourceType", text, text, text, text,
  timestamptz, text, text, timestamptz, timestamptz, jsonb, text, text
) TO enterprise_agent_task_executor;

GRANT USAGE ON SCHEMA public TO enterprise_agent_task_executor;
GRANT USAGE ON TYPE
  public."TaskStatus",
  public."DeliverableStatus",
  public."EvidenceSourceType",
  public."EvidenceStatus",
  public."EvidenceTrustLevel",
  public."EvidenceTargetType",
  public."EvidenceLinkStatus",
  public."EvidenceLinkType",
  public."AuditActorType",
  public."OutboxEventStatus"
TO enterprise_agent_task_executor;

REVOKE ALL ON TABLE
  public."tasks",
  public."deliverables",
  public."evidence",
  public."evidence_links",
  public."deliverable_evidence",
  public."acceptances",
  public."acceptance_evidence",
  public."employee_task_commands",
  public."employee_task_acceptance_requests",
  public."audit_events",
  public."outbox_events"
FROM enterprise_agent_task_executor;

GRANT SELECT ON TABLE
  public."tasks",
  public."deliverables",
  public."evidence",
  public."evidence_links",
  public."deliverable_evidence",
  public."acceptances",
  public."acceptance_evidence"
TO enterprise_agent_task_executor;
GRANT UPDATE (
  "status", "ready_at", "started_at", "delivered_at", "revision", "updated_at"
) ON TABLE public."tasks" TO enterprise_agent_task_executor;
GRANT UPDATE (
  "status", "submitted_at", "artifact_uri", "content_hash",
  "evidence_sealed_at", "revision", "updated_at"
) ON TABLE public."deliverables" TO enterprise_agent_task_executor;
GRANT INSERT ON TABLE public."deliverable_evidence"
  TO enterprise_agent_task_executor;
GRANT SELECT, INSERT ON TABLE
  public."employee_task_commands",
  public."employee_task_acceptance_requests"
TO enterprise_agent_task_executor;
GRANT INSERT ON TABLE
  public."audit_events",
  public."outbox_events"
TO enterprise_agent_task_executor;

GRANT SELECT ON TABLE public."employee_task_acceptance_requests"
  TO enterprise_agent_app;
GRANT SELECT ON TABLE
  public."employee_task_commands",
  public."employee_task_acceptance_requests"
TO enterprise_agent_admin;

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'employee_task_commands',
    'employee_task_acceptance_requests'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      || 'AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$rls$;

CREATE POLICY enterprise_agent_access
  ON public."employee_task_acceptance_requests"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true);

CREATE POLICY employee_task_executor_access
  ON public."employee_task_commands"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    "actor_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
    AND "actor_role_assignment_id" =
      NULLIF(current_setting('app.role_assignment_id', true), '')::uuid
    AND "action" = NULLIF(current_setting('app.action', true), '')
    AND public.employee_task_action_authorized(
      "tenant_id", "task_id", "action"
    )
  );
CREATE POLICY employee_task_executor_insert
  ON public."employee_task_commands"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_task_executor
  WITH CHECK (
    "actor_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
    AND "actor_role_assignment_id" =
      NULLIF(current_setting('app.role_assignment_id', true), '')::uuid
    AND "action" = NULLIF(current_setting('app.action', true), '')
    AND public.employee_task_action_authorized(
      "tenant_id", "task_id", "action"
    )
  );

CREATE POLICY employee_task_executor_access
  ON public."employee_task_acceptance_requests"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    "requested_by_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
    AND "requested_by_role_assignment_id" =
      NULLIF(current_setting('app.role_assignment_id', true), '')::uuid
    AND public.employee_task_action_authorized(
      "tenant_id", "task_id", 'business.acceptance.request'
    )
  );
CREATE POLICY employee_task_executor_insert
  ON public."employee_task_acceptance_requests"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_task_executor
  WITH CHECK (
    "requested_by_user_id" =
      NULLIF(current_setting('app.user_id', true), '')::uuid
    AND "requested_by_role_assignment_id" =
      NULLIF(current_setting('app.role_assignment_id', true), '')::uuid
    AND public.employee_task_action_authorized(
      "tenant_id", "task_id", 'business.acceptance.request'
    )
    AND EXISTS (
      SELECT 1
      FROM public."deliverables" deliverable
      WHERE deliverable."tenant_id" =
        employee_task_acceptance_requests."tenant_id"
        AND deliverable."id" =
          employee_task_acceptance_requests."deliverable_id"
        AND deliverable."version" =
          employee_task_acceptance_requests."deliverable_version"
        AND deliverable."task_id" =
          employee_task_acceptance_requests."task_id"
        AND deliverable."status" = 'SUBMITTED'
        AND deliverable."evidence_sealed_at" IS NOT NULL
    )
  );

CREATE POLICY employee_task_executor_select
  ON public."tasks"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    public.employee_task_action_authorized(
      "tenant_id", "id",
      NULLIF(current_setting('app.action', true), '')
    )
  );
CREATE POLICY employee_task_executor_update
  ON public."tasks"
  AS PERMISSIVE FOR UPDATE TO enterprise_agent_task_executor
  USING (
    public.employee_task_action_authorized(
      "tenant_id", "id", 'business.task.execute'
    )
  )
  WITH CHECK (
    public.employee_task_action_authorized(
      "tenant_id", "id", 'business.task.execute'
    )
  );

CREATE POLICY employee_task_executor_select
  ON public."deliverables"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    public.employee_task_action_authorized(
      "tenant_id", "task_id",
      NULLIF(current_setting('app.action', true), '')
    )
  );
CREATE POLICY employee_task_executor_update
  ON public."deliverables"
  AS PERMISSIVE FOR UPDATE TO enterprise_agent_task_executor
  USING (
    public.employee_task_action_authorized(
      "tenant_id", "task_id", 'business.deliverable.submit'
    )
  )
  WITH CHECK (
    public.employee_task_action_authorized(
      "tenant_id", "task_id", 'business.deliverable.submit'
    )
  );

CREATE POLICY employee_task_executor_select
  ON public."evidence_links"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    "status" = 'ACTIVE'
    AND "target_type" = 'TASK'
    AND public.employee_task_action_authorized(
      "tenant_id", "target_task_id",
      NULLIF(current_setting('app.action', true), '')
    )
  );
CREATE POLICY employee_task_executor_select
  ON public."evidence"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    EXISTS (
      SELECT 1
      FROM public."evidence_links" link
      WHERE link."tenant_id" = evidence."tenant_id"
        AND link."evidence_id" = evidence."id"
        AND link."evidence_version" = evidence."version"
        AND link."status" = 'ACTIVE'
        AND link."target_type" = 'TASK'
        AND public.employee_task_action_authorized(
          link."tenant_id", link."target_task_id",
          NULLIF(current_setting('app.action', true), '')
        )
    )
  );

CREATE POLICY employee_task_executor_select
  ON public."deliverable_evidence"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    EXISTS (
      SELECT 1
      FROM public."deliverables" deliverable
      WHERE deliverable."tenant_id" = deliverable_evidence."tenant_id"
        AND deliverable."id" = deliverable_evidence."deliverable_id"
        AND deliverable."version" = deliverable_evidence."deliverable_version"
        AND public.employee_task_action_authorized(
          deliverable."tenant_id", deliverable."task_id",
          NULLIF(current_setting('app.action', true), '')
        )
    )
  );
CREATE POLICY employee_task_executor_insert
  ON public."deliverable_evidence"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_task_executor
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public."deliverables" deliverable
      JOIN public."evidence" source_evidence
        ON source_evidence."tenant_id" = deliverable_evidence."tenant_id"
       AND source_evidence."id" = deliverable_evidence."evidence_id"
       AND source_evidence."version" = deliverable_evidence."evidence_version"
       AND source_evidence."status" = 'ACTIVE'
       AND source_evidence."effective_from" <= CURRENT_TIMESTAMP
       AND (
         source_evidence."effective_to" IS NULL
         OR source_evidence."effective_to" > CURRENT_TIMESTAMP
       )
      JOIN public."evidence_links" task_link
        ON task_link."tenant_id" = source_evidence."tenant_id"
       AND task_link."evidence_id" = source_evidence."id"
       AND task_link."evidence_version" = source_evidence."version"
       AND task_link."status" = 'ACTIVE'
       AND task_link."target_type" = 'TASK'
       AND task_link."target_task_id" = deliverable."task_id"
      WHERE deliverable."tenant_id" = deliverable_evidence."tenant_id"
        AND deliverable."id" = deliverable_evidence."deliverable_id"
        AND deliverable."version" = deliverable_evidence."deliverable_version"
        AND deliverable."status" = 'DRAFT'
        AND public.employee_task_action_authorized(
          deliverable."tenant_id", deliverable."task_id",
          'business.deliverable.submit'
        )
    )
  );

CREATE POLICY employee_task_executor_select
  ON public."acceptances"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    EXISTS (
      SELECT 1
      FROM public."deliverables" deliverable
      WHERE deliverable."tenant_id" = acceptances."tenant_id"
        AND deliverable."id" = acceptances."deliverable_id"
        AND deliverable."version" = acceptances."deliverable_version"
        AND public.employee_task_action_authorized(
          deliverable."tenant_id", deliverable."task_id",
          NULLIF(current_setting('app.action', true), '')
        )
    )
  );
CREATE POLICY employee_task_executor_select
  ON public."acceptance_evidence"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_task_executor
  USING (
    EXISTS (
      SELECT 1
      FROM public."acceptances" acceptance
      JOIN public."deliverables" deliverable
        ON deliverable."tenant_id" = acceptance."tenant_id"
       AND deliverable."id" = acceptance."deliverable_id"
       AND deliverable."version" = acceptance."deliverable_version"
      WHERE acceptance."tenant_id" = acceptance_evidence."tenant_id"
        AND acceptance."id" = acceptance_evidence."acceptance_id"
        AND acceptance."version" = acceptance_evidence."acceptance_version"
        AND public.employee_task_action_authorized(
          deliverable."tenant_id", deliverable."task_id",
          NULLIF(current_setting('app.action', true), '')
        )
    )
  );

CREATE POLICY employee_task_executor_insert
  ON public."audit_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_task_executor
  WITH CHECK (
    "actor_type" = 'USER'
    AND "actor_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND "action" LIKE 'business_semantics.employee.%'
    AND "resource_type" IN (
      'task', 'deliverable', 'evidence', 'acceptance_request'
    )
  );
CREATE POLICY employee_task_executor_insert
  ON public."outbox_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_task_executor
  WITH CHECK (
    "event_type" LIKE 'business_semantics.employee.%'
    AND "aggregate_type" IN (
      'task', 'deliverable', 'evidence', 'acceptance_request'
    )
    AND "payload" ->> 'actorId' =
      NULLIF(current_setting('app.user_id', true), '')
  );

COMMIT;
