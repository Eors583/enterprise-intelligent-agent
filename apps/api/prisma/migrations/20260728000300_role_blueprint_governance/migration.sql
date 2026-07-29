BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE public."AgentVersionReviewStatus" AS ENUM (
  'NOT_SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED'
);

ALTER TABLE public."agent_templates"
  ADD COLUMN "mission" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "responsibilities" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "value_definition" JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "processes" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "tools" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "knowledge_domains" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public."agent_templates"
  ADD CONSTRAINT "agent_templates_structured_role_shape_check"
    CHECK (
      "mission" = btrim("mission")
      AND length("mission") <= 20000
      AND jsonb_typeof("responsibilities") = 'array'
      AND jsonb_typeof("value_definition") = 'object'
      AND jsonb_typeof("capabilities") = 'array'
      AND jsonb_typeof("processes") = 'array'
      AND jsonb_typeof("tools") = 'array'
      AND jsonb_typeof("knowledge_domains") = 'array'
    ),
  ADD CONSTRAINT "agent_templates_revision_check"
    CHECK ("revision" > 0);

ALTER TABLE public."agent_versions"
  ADD COLUMN "review_status" public."AgentVersionReviewStatus" NOT NULL
    DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN "role_definition_snapshot" JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN "blueprint_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "change_summary" VARCHAR(500),
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "created_by_id" UUID,
  ADD COLUMN "review_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "review_requested_by_id" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "reviewed_by_id" UUID,
  ADD COLUMN "review_comment" VARCHAR(1000),
  ADD COLUMN "approved_at" TIMESTAMPTZ(6),
  ADD COLUMN "approved_by_id" UUID,
  ADD COLUMN "published_by_id" UUID,
  ADD COLUMN "retired_at" TIMESTAMPTZ(6),
  ADD COLUMN "retired_by_id" UUID,
  ADD COLUMN "rollback_of_version_id" UUID;

UPDATE public."agent_versions" AS version
SET
  "role_definition_snapshot" = jsonb_build_object(
    'mission', template."mission",
    'responsibilities', template."responsibilities",
    'valueDefinition', template."value_definition",
    'capabilities', template."capabilities",
    'processes', template."processes",
    'tools', template."tools",
    'knowledgeDomains', template."knowledge_domains"
  ),
  "blueprint_revision" = template."revision"
FROM public."agent_templates" AS template
WHERE template."tenant_id" = version."tenant_id"
  AND template."id" = version."template_id";

UPDATE public."agent_versions"
SET "retired_at" = COALESCE("published_at", "created_at")
WHERE "status" = 'RETIRED'::public."AgentVersionStatus"
  AND "retired_at" IS NULL;

CREATE UNIQUE INDEX "agent_versions_tenant_template_id_id_key"
  ON public."agent_versions"("tenant_id", "template_id", "id");
CREATE INDEX "agent_versions_tenant_template_review_status_idx"
  ON public."agent_versions"("tenant_id", "template_id", "review_status", "status");
CREATE INDEX "agent_versions_tenant_rollback_of_version_id_idx"
  ON public."agent_versions"("tenant_id", "rollback_of_version_id");

ALTER TABLE public."agent_versions"
  ADD CONSTRAINT "agent_versions_revision_check"
    CHECK ("revision" > 0),
  ADD CONSTRAINT "agent_versions_blueprint_revision_check"
    CHECK ("blueprint_revision" > 0),
  ADD CONSTRAINT "agent_versions_role_definition_snapshot_shape_check"
    CHECK (
      "role_definition_snapshot" = '{}'::jsonb
      OR (
        jsonb_typeof("role_definition_snapshot") = 'object'
        AND "role_definition_snapshot" ?& ARRAY[
          'mission',
          'responsibilities',
          'valueDefinition',
          'capabilities',
          'processes',
          'tools',
          'knowledgeDomains'
        ]
        AND jsonb_typeof("role_definition_snapshot"->'mission') = 'string'
        AND jsonb_typeof("role_definition_snapshot"->'responsibilities') = 'array'
        AND jsonb_typeof("role_definition_snapshot"->'valueDefinition') = 'object'
        AND jsonb_typeof("role_definition_snapshot"->'capabilities') = 'array'
        AND jsonb_typeof("role_definition_snapshot"->'processes') = 'array'
        AND jsonb_typeof("role_definition_snapshot"->'tools') = 'array'
        AND jsonb_typeof("role_definition_snapshot"->'knowledgeDomains') = 'array'
      )
    ),
  ADD CONSTRAINT "agent_versions_author_approver_separation_check"
    CHECK (
      "created_by_id" IS NULL
      OR "approved_by_id" IS NULL
      OR "created_by_id" <> "approved_by_id"
    ),
  ADD CONSTRAINT "agent_versions_requester_reviewer_separation_check"
    CHECK (
      "review_requested_by_id" IS NULL
      OR "reviewed_by_id" IS NULL
      OR "review_requested_by_id" <> "reviewed_by_id"
    ),
  ADD CONSTRAINT "agent_versions_change_summary_check"
    CHECK (
      "change_summary" IS NULL
      OR (
        length(btrim("change_summary")) BETWEEN 1 AND 500
        AND "change_summary" = btrim("change_summary")
      )
    ),
  ADD CONSTRAINT "agent_versions_review_comment_check"
    CHECK (
      "review_comment" IS NULL
      OR (
        length(btrim("review_comment")) BETWEEN 1 AND 1000
        AND "review_comment" = btrim("review_comment")
      )
    ),
  ADD CONSTRAINT "agent_versions_review_state_check"
    CHECK (
      (
        "review_status" = 'NOT_SUBMITTED'::public."AgentVersionReviewStatus"
        AND "review_requested_at" IS NULL
        AND "review_requested_by_id" IS NULL
        AND "reviewed_at" IS NULL
        AND "reviewed_by_id" IS NULL
        AND "approved_at" IS NULL
        AND "approved_by_id" IS NULL
      )
      OR (
        "review_status" = 'IN_REVIEW'::public."AgentVersionReviewStatus"
        AND "review_requested_at" IS NOT NULL
        AND "review_requested_by_id" IS NOT NULL
        AND "reviewed_at" IS NULL
        AND "reviewed_by_id" IS NULL
        AND "approved_at" IS NULL
        AND "approved_by_id" IS NULL
      )
      OR (
        "review_status" = 'APPROVED'::public."AgentVersionReviewStatus"
        AND "review_requested_at" IS NOT NULL
        AND "review_requested_by_id" IS NOT NULL
        AND "reviewed_at" IS NOT NULL
        AND "reviewed_by_id" IS NOT NULL
        AND "approved_at" IS NOT NULL
        AND "approved_by_id" IS NOT NULL
      )
      OR (
        "review_status" = 'CHANGES_REQUESTED'::public."AgentVersionReviewStatus"
        AND "review_requested_at" IS NOT NULL
        AND "review_requested_by_id" IS NOT NULL
        AND "reviewed_at" IS NOT NULL
        AND "reviewed_by_id" IS NOT NULL
        AND "approved_at" IS NULL
        AND "approved_by_id" IS NULL
      )
    ),
  ADD CONSTRAINT "agent_versions_rollback_not_self_check"
    CHECK ("rollback_of_version_id" IS NULL OR "rollback_of_version_id" <> "id"),
  ADD CONSTRAINT "agent_versions_retired_state_check"
    CHECK (
      (
        "status" = 'RETIRED'::public."AgentVersionStatus"
        AND "retired_at" IS NOT NULL
      )
      OR (
        "status" <> 'RETIRED'::public."AgentVersionStatus"
        AND "retired_at" IS NULL
        AND "retired_by_id" IS NULL
      )
    ),
  ADD CONSTRAINT "agent_versions_tenant_created_by_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_versions_tenant_review_requested_by_id_fkey"
    FOREIGN KEY ("tenant_id", "review_requested_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_versions_tenant_reviewed_by_id_fkey"
    FOREIGN KEY ("tenant_id", "reviewed_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_versions_tenant_approved_by_id_fkey"
    FOREIGN KEY ("tenant_id", "approved_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_versions_tenant_published_by_id_fkey"
    FOREIGN KEY ("tenant_id", "published_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_versions_tenant_retired_by_id_fkey"
    FOREIGN KEY ("tenant_id", "retired_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_versions_tenant_rollback_of_version_id_fkey"
    FOREIGN KEY ("tenant_id", "rollback_of_version_id")
    REFERENCES public."agent_versions"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.enforce_governed_agent_version_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."status" = 'PUBLISHED'::public."AgentVersionStatus"
    AND EXISTS (
      SELECT 1
      FROM public."agent_templates" AS template
      WHERE template."tenant_id" = NEW."tenant_id"
        AND template."id" = NEW."template_id"
        AND btrim(template."mission") <> ''
    )
    AND (
      NEW."review_status" <> 'APPROVED'::public."AgentVersionReviewStatus"
      OR NEW."created_by_id" IS NULL
      OR NEW."review_requested_at" IS NULL
      OR NEW."review_requested_by_id" IS NULL
      OR NEW."reviewed_at" IS NULL
      OR NEW."reviewed_by_id" IS NULL
      OR NEW."approved_at" IS NULL
      OR NEW."approved_by_id" IS NULL
      OR NEW."created_by_id" = NEW."approved_by_id"
      OR NEW."review_requested_by_id" = NEW."reviewed_by_id"
    )
  THEN
    RAISE EXCEPTION
      'A structured Role Blueprint version requires independent approval before publication.'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'agent_versions_structured_publish_review_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER agent_versions_structured_publish_review_check
AFTER INSERT OR UPDATE
ON public."agent_versions"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.enforce_governed_agent_version_publication();

CREATE OR REPLACE FUNCTION public.enforce_governed_agent_template_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF btrim(NEW."mission") <> ''
    AND EXISTS (
      SELECT 1
      FROM public."agent_versions" AS version
      WHERE version."tenant_id" = NEW."tenant_id"
        AND version."template_id" = NEW."id"
        AND version."status" = 'PUBLISHED'::public."AgentVersionStatus"
        AND (
          version."review_status" <> 'APPROVED'::public."AgentVersionReviewStatus"
          OR version."created_by_id" IS NULL
          OR version."review_requested_at" IS NULL
          OR version."review_requested_by_id" IS NULL
          OR version."reviewed_at" IS NULL
          OR version."reviewed_by_id" IS NULL
          OR version."approved_at" IS NULL
          OR version."approved_by_id" IS NULL
          OR version."created_by_id" = version."approved_by_id"
          OR version."review_requested_by_id" = version."reviewed_by_id"
        )
    )
  THEN
    RAISE EXCEPTION
      'A template with an unapproved published version cannot become a structured Role Blueprint.'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'agent_templates_structured_publish_review_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER agent_templates_structured_publish_review_check
AFTER INSERT OR UPDATE
ON public."agent_templates"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.enforce_governed_agent_template_publication();

CREATE UNIQUE INDEX "agent_instances_tenant_id_id_version_id_key"
  ON public."agent_instances"("tenant_id", "id", "version_id");

ALTER TABLE public."role_assignments"
  ADD COLUMN "idempotency_key" VARCHAR(200),
  ADD COLUMN "request_hash" VARCHAR(64),
  ADD COLUMN "role_template_id" UUID,
  ADD COLUMN "role_version_id" UUID,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

UPDATE public."role_assignments" AS assignment
SET
  "idempotency_key" = 'legacy:' || assignment."id"::TEXT,
  "request_hash" = repeat('0', 64),
  "role_template_id" = version."template_id",
  "role_version_id" = instance."version_id"
FROM public."agent_instances" AS instance
JOIN public."agent_versions" AS version
  ON version."tenant_id" = instance."tenant_id"
 AND version."id" = instance."version_id"
WHERE instance."tenant_id" = assignment."tenant_id"
  AND instance."id" = assignment."agent_instance_id";

ALTER TABLE public."role_assignments"
  ALTER COLUMN "idempotency_key" SET NOT NULL,
  ALTER COLUMN "request_hash" SET NOT NULL,
  ALTER COLUMN "role_template_id" SET NOT NULL,
  ALTER COLUMN "role_version_id" SET NOT NULL;

DROP INDEX IF EXISTS public."role_assignments_user_agent_period_key";

ALTER TABLE public."role_assignments"
  DROP CONSTRAINT IF EXISTS "role_assignments_tenant_id_agent_instance_id_fkey";

CREATE UNIQUE INDEX "role_assignments_tenant_id_idempotency_key"
  ON public."role_assignments"("tenant_id", "idempotency_key");
CREATE INDEX "role_assignments_user_role_period_idx"
  ON public."role_assignments"(
    "tenant_id",
    "user_id",
    "role_template_id",
    "status",
    "effective_from",
    "effective_to"
  );

ALTER TABLE public."role_assignments"
  ADD CONSTRAINT "role_assignments_idempotency_key_check"
    CHECK (
      length(btrim("idempotency_key")) BETWEEN 1 AND 200
      AND "idempotency_key" = btrim("idempotency_key")
    ),
  ADD CONSTRAINT "role_assignments_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "role_assignments_version_check"
    CHECK ("version" > 0),
  ADD CONSTRAINT "role_assignments_tenant_role_template_id_fkey"
    FOREIGN KEY ("tenant_id", "role_template_id")
    REFERENCES public."agent_templates"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_role_version_id_fkey"
    FOREIGN KEY ("tenant_id", "role_template_id", "role_version_id")
    REFERENCES public."agent_versions"("tenant_id", "template_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_agent_instance_version_id_fkey"
    FOREIGN KEY ("tenant_id", "agent_instance_id", "role_version_id")
    REFERENCES public."agent_instances"("tenant_id", "id", "version_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."role_assignments"
  ADD CONSTRAINT "role_assignments_no_overlapping_effective_period"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "user_id" WITH =,
    "role_template_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE (
    "status" IN (
      'PENDING'::public."RoleAssignmentStatus",
      'ACTIVE'::public."RoleAssignmentStatus",
      'SUSPENDED'::public."RoleAssignmentStatus"
    )
  );

-- Dedicated lifecycle capability. It has no membership relationship with any
-- API/admin/auth/outbox/provisioning capability and receives only the columns
-- needed to reconcile assignment state. Production uses a distinct login that
-- can SET ROLE enterprise_agent_lifecycle only.
DO $lifecycle_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_lifecycle'
  ) THEN
    CREATE ROLE enterprise_agent_lifecycle
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_lifecycle
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF current_user = ANY (ARRAY[
    'enterprise_agent_app',
    'enterprise_agent_auth',
    'enterprise_agent_admin',
    'enterprise_agent_outbox',
    'enterprise_agent_provisioner'
  ]) THEN
    RAISE EXCEPTION
      'Migrations must run as a dedicated owner, not an application capability role.';
  END IF;
  EXECUTE format('GRANT enterprise_agent_lifecycle TO %I', current_user);
END
$lifecycle_role$;

REVOKE enterprise_agent_lifecycle
  FROM enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin,
       enterprise_agent_outbox, enterprise_agent_provisioner;
REVOKE enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin,
       enterprise_agent_outbox, enterprise_agent_provisioner
  FROM enterprise_agent_lifecycle;

DO $lifecycle_runtime_boundary$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_runtime') THEN
    EXECUTE 'REVOKE enterprise_agent_lifecycle FROM enterprise_agent_runtime';
    EXECUTE 'REVOKE enterprise_agent_runtime FROM enterprise_agent_lifecycle';
  END IF;
END
$lifecycle_runtime_boundary$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM enterprise_agent_lifecycle;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM enterprise_agent_lifecycle;
REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM enterprise_agent_lifecycle;
GRANT USAGE ON SCHEMA public TO enterprise_agent_lifecycle;

GRANT SELECT ("id", "status")
  ON TABLE public."tenants"
  TO enterprise_agent_lifecycle;
GRANT SELECT ("tenant_id", "id", "status")
  ON TABLE public."users"
  TO enterprise_agent_lifecycle;
GRANT SELECT ("tenant_id", "id", "user_id", "status")
  ON TABLE public."employments"
  TO enterprise_agent_lifecycle;
GRANT SELECT ("tenant_id", "id", "mission")
  ON TABLE public."agent_templates"
  TO enterprise_agent_lifecycle;
GRANT SELECT (
  "tenant_id", "id", "template_id", "status", "review_status",
  "created_by_id", "review_requested_by_id", "reviewed_by_id",
  "approved_by_id", "role_definition_snapshot", "blueprint_revision"
)
  ON TABLE public."agent_versions"
  TO enterprise_agent_lifecycle;
GRANT SELECT (
  "tenant_id", "id", "user_id", "employment_id", "role_template_id",
  "role_version_id", "agent_instance_id", "status", "source",
  "effective_from", "effective_to", "delegated_from_assignment_id",
  "organization_scope", "permission_scope", "memory_policy", "created_by_id",
  "version", "updated_at"
)
  ON TABLE public."role_assignments"
  TO enterprise_agent_lifecycle;
GRANT UPDATE (
  "status", "revoked_at", "revoked_by_id", "revoke_reason", "version", "updated_at"
)
  ON TABLE public."role_assignments"
  TO enterprise_agent_lifecycle;
GRANT SELECT ("tenant_id", "id", "version_id", "status")
  ON TABLE public."agent_instances"
  TO enterprise_agent_lifecycle;
GRANT UPDATE ("status", "updated_at")
  ON TABLE public."agent_instances"
  TO enterprise_agent_lifecycle;
GRANT SELECT (
  "tenant_id", "id", "agent_id", "requester_user_id", "status", "external_run_id"
)
  ON TABLE public."agent_runs"
  TO enterprise_agent_lifecycle;
GRANT UPDATE (
  "status", "version", "error_code", "error_message", "finished_at",
  "updated_at", "reserved_tokens"
)
  ON TABLE public."agent_runs"
  TO enterprise_agent_lifecycle;
GRANT INSERT (
  "tenant_id", "aggregate_type", "aggregate_id", "event_type", "payload"
)
  ON TABLE public."outbox_events"
  TO enterprise_agent_lifecycle;
GRANT INSERT (
  "id", "tenant_id", "actor_type", "actor_id", "action", "resource_type",
  "resource_id", "metadata", "occurred_at"
)
  ON TABLE public."audit_events"
  TO enterprise_agent_lifecycle;

DROP POLICY IF EXISTS enterprise_agent_lifecycle_tenant_enumeration
  ON public."tenants";
CREATE POLICY enterprise_agent_lifecycle_tenant_enumeration
  ON public."tenants"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_lifecycle
  USING (true);

DO $lifecycle_tenant_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'employments',
    'agent_templates',
    'agent_versions',
    'role_assignments',
    'agent_instances',
    'agent_runs',
    'outbox_events',
    'audit_events'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS enterprise_agent_lifecycle_access ON public.%I',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_lifecycle_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO enterprise_agent_lifecycle '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$lifecycle_tenant_policies$;

COMMIT;
