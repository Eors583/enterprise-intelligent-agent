BEGIN;

CREATE TYPE "RoleAssignmentStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED'
);

CREATE TYPE "RoleAssignmentSource" AS ENUM (
  'LOCAL',
  'DIRECTORY',
  'PROJECT',
  'TEMPORARY',
  'DELEGATION',
  'HANDOVER'
);

CREATE TABLE public."role_assignments" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "key" VARCHAR(160) NOT NULL,
  "user_id" UUID NOT NULL,
  "employment_id" UUID NOT NULL,
  "agent_instance_id" UUID NOT NULL,
  "status" "RoleAssignmentStatus" NOT NULL DEFAULT 'PENDING',
  "source" "RoleAssignmentSource" NOT NULL DEFAULT 'LOCAL',
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "organization_scope" JSONB NOT NULL DEFAULT '{}',
  "permission_scope" JSONB NOT NULL DEFAULT '{}',
  "memory_policy" JSONB NOT NULL DEFAULT '{}',
  "delegated_from_assignment_id" UUID,
  "created_by_id" UUID NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by_id" UUID,
  "revoke_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "role_assignments_effective_period_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "role_assignments_key_check"
    CHECK (length(btrim("key")) BETWEEN 1 AND 160 AND "key" = lower(btrim("key"))),
  CONSTRAINT "role_assignments_scope_shape_check"
    CHECK (
      jsonb_typeof("organization_scope") = 'object'
      AND jsonb_typeof("permission_scope") = 'object'
      AND jsonb_typeof("memory_policy") = 'object'
    ),
  CONSTRAINT "role_assignments_delegation_source_check"
    CHECK (
      (
        "source" IN ('DELEGATION', 'HANDOVER')
        AND "delegated_from_assignment_id" IS NOT NULL
      )
      OR (
        "source" NOT IN ('DELEGATION', 'HANDOVER')
        AND "delegated_from_assignment_id" IS NULL
      )
    ),
  CONSTRAINT "role_assignments_not_self_delegated_check"
    CHECK ("delegated_from_assignment_id" IS NULL OR "delegated_from_assignment_id" <> "id"),
  CONSTRAINT "role_assignments_revocation_state_check"
    CHECK (
      (
        "status" = 'REVOKED'
        AND "revoked_at" IS NOT NULL
        AND "revoked_by_id" IS NOT NULL
        AND length(btrim("revoke_reason")) BETWEEN 1 AND 500
      )
      OR (
        "status" <> 'REVOKED'
        AND "revoked_at" IS NULL
        AND "revoked_by_id" IS NULL
        AND "revoke_reason" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "role_assignments_tenant_id_id_key"
  ON public."role_assignments"("tenant_id", "id");
CREATE UNIQUE INDEX "role_assignments_tenant_id_key_key"
  ON public."role_assignments"("tenant_id", "key");
CREATE UNIQUE INDEX "role_assignments_user_agent_period_key"
  ON public."role_assignments"("tenant_id", "user_id", "agent_instance_id", "effective_from");
CREATE INDEX "role_assignments_user_active_idx"
  ON public."role_assignments"("tenant_id", "user_id", "status", "effective_from", "effective_to");
CREATE INDEX "role_assignments_agent_status_idx"
  ON public."role_assignments"("tenant_id", "agent_instance_id", "status");
CREATE INDEX "role_assignments_employment_status_idx"
  ON public."role_assignments"("tenant_id", "employment_id", "status");

CREATE UNIQUE INDEX "employments_tenant_id_id_user_id_key"
  ON public."employments"("tenant_id", "id", "user_id");

ALTER TABLE public."role_assignments"
  ADD CONSTRAINT "role_assignments_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_id_user_id_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_id_employment_id_fkey"
    FOREIGN KEY ("tenant_id", "employment_id", "user_id")
    REFERENCES public."employments"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_id_agent_instance_id_fkey"
    FOREIGN KEY ("tenant_id", "agent_instance_id")
    REFERENCES public."agent_instances"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_id_delegated_from_assignment_id_fkey"
    FOREIGN KEY ("tenant_id", "delegated_from_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_id_created_by_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "role_assignments_tenant_id_revoked_by_id_fkey"
    FOREIGN KEY ("tenant_id", "revoked_by_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE public."role_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."role_assignments" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public."role_assignments"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY enterprise_agent_admin_access
  ON public."role_assignments"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

CREATE POLICY enterprise_agent_access
  ON public."role_assignments"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (true);

GRANT SELECT
  ON TABLE public."role_assignments"
  TO enterprise_agent_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public."role_assignments"
  TO enterprise_agent_admin;

COMMIT;
