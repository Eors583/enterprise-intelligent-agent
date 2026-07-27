-- Add durable Feishu directory synchronization state and tenant-scoped external bindings.
BEGIN;

CREATE TYPE public."DirectoryProvider" AS ENUM ('FEISHU');
CREATE TYPE public."DirectorySyncStatus" AS ENUM ('IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE public."employments"
    ADD COLUMN "is_primary" boolean NOT NULL DEFAULT false;

WITH ranked AS (
    SELECT
        "id",
        row_number() OVER (
            PARTITION BY "tenant_id", "user_id", "organization_id"
            ORDER BY
                CASE "status"
                    WHEN 'ACTIVE'::public."EmploymentStatus" THEN 0
                    WHEN 'PENDING'::public."EmploymentStatus" THEN 1
                    WHEN 'SUSPENDED'::public."EmploymentStatus" THEN 2
                    ELSE 3
                END,
                "created_at",
                "id"
        ) AS rank
    FROM public."employments"
)
UPDATE public."employments" AS employment
SET "is_primary" = true
FROM ranked
WHERE ranked."id" = employment."id"
  AND ranked.rank = 1;

CREATE INDEX "employments_tenant_id_user_id_organization_id_is_primary_idx"
    ON public."employments"("tenant_id", "user_id", "organization_id", "is_primary");
CREATE UNIQUE INDEX "employments_one_primary_per_organization_idx"
    ON public."employments"("tenant_id", "user_id", "organization_id")
    WHERE "is_primary" = true;

CREATE TABLE public."directory_integrations" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "provider" public."DirectoryProvider" NOT NULL,
    "status" public."DirectorySyncStatus" NOT NULL DEFAULT 'IDLE',
    "lease_owner" varchar(120),
    "lease_expires_at" timestamptz(6),
    "last_sync_started_at" timestamptz(6),
    "last_sync_finished_at" timestamptz(6),
    "last_successful_sync_at" timestamptz(6),
    "last_error_code" varchar(120),
    "last_summary" jsonb,
    "version" integer NOT NULL DEFAULT 1,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "directory_integrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_integrations_version_positive_check" CHECK ("version" > 0),
    CONSTRAINT "directory_integrations_lease_check" CHECK (
        ("status" = 'RUNNING'::public."DirectorySyncStatus"
            AND "lease_owner" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL)
        OR
        ("status" <> 'RUNNING'::public."DirectorySyncStatus"
            AND "lease_owner" IS NULL
            AND "lease_expires_at" IS NULL)
    ),
    CONSTRAINT "directory_integrations_finish_check" CHECK (
        "last_sync_finished_at" IS NULL
        OR "last_sync_started_at" IS NULL
        OR "last_sync_finished_at" >= "last_sync_started_at"
    )
);

CREATE UNIQUE INDEX "directory_integrations_tenant_id_id_key"
    ON public."directory_integrations"("tenant_id", "id");
CREATE UNIQUE INDEX "directory_integrations_tenant_id_provider_key"
    ON public."directory_integrations"("tenant_id", "provider");
CREATE INDEX "directory_integrations_tenant_id_status_lease_expires_at_idx"
    ON public."directory_integrations"("tenant_id", "status", "lease_expires_at");

CREATE TABLE public."directory_user_bindings" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "integration_id" uuid NOT NULL,
    "external_user_id" varchar(200) NOT NULL,
    "user_id" uuid NOT NULL,
    "open_id" varchar(200),
    "union_id" varchar(200),
    "last_seen_at" timestamptz(6) NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "directory_user_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "directory_user_bindings_external_key"
    ON public."directory_user_bindings"("tenant_id", "integration_id", "external_user_id");
CREATE UNIQUE INDEX "directory_user_bindings_local_key"
    ON public."directory_user_bindings"("tenant_id", "integration_id", "user_id");
CREATE INDEX "directory_user_bindings_tenant_id_user_id_idx"
    ON public."directory_user_bindings"("tenant_id", "user_id");

CREATE TABLE public."directory_org_unit_bindings" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "integration_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "external_department_id" varchar(200) NOT NULL,
    "org_unit_id" uuid NOT NULL,
    "last_seen_at" timestamptz(6) NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "directory_org_unit_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "directory_org_unit_bindings_external_key"
    ON public."directory_org_unit_bindings"("tenant_id", "integration_id", "external_department_id");
CREATE UNIQUE INDEX "directory_org_unit_bindings_local_key"
    ON public."directory_org_unit_bindings"("tenant_id", "integration_id", "org_unit_id");
CREATE INDEX "directory_org_unit_bindings_tenant_id_org_unit_id_idx"
    ON public."directory_org_unit_bindings"("tenant_id", "org_unit_id");

CREATE TABLE public."directory_employment_bindings" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "integration_id" uuid NOT NULL,
    "external_user_id" varchar(200) NOT NULL,
    "external_department_id" varchar(200) NOT NULL,
    "employment_id" uuid NOT NULL,
    "last_seen_at" timestamptz(6) NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "directory_employment_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "directory_employment_bindings_external_key"
    ON public."directory_employment_bindings"(
        "tenant_id", "integration_id", "external_user_id", "external_department_id"
    );
CREATE UNIQUE INDEX "directory_employment_bindings_local_key"
    ON public."directory_employment_bindings"("tenant_id", "integration_id", "employment_id");
CREATE INDEX "directory_employment_bindings_tenant_id_employment_id_idx"
    ON public."directory_employment_bindings"("tenant_id", "employment_id");

ALTER TABLE public."directory_integrations"
    ADD CONSTRAINT "directory_integrations_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_integrations_tenant_id_organization_id_fkey"
        FOREIGN KEY ("tenant_id", "organization_id")
        REFERENCES public."organizations"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."directory_user_bindings"
    ADD CONSTRAINT "directory_user_bindings_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_user_bindings_tenant_id_integration_id_fkey"
        FOREIGN KEY ("tenant_id", "integration_id")
        REFERENCES public."directory_integrations"("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_user_bindings_tenant_id_user_id_fkey"
        FOREIGN KEY ("tenant_id", "user_id")
        REFERENCES public."users"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."directory_org_unit_bindings"
    ADD CONSTRAINT "directory_org_unit_bindings_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_org_unit_bindings_tenant_id_integration_id_fkey"
        FOREIGN KEY ("tenant_id", "integration_id")
        REFERENCES public."directory_integrations"("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_org_unit_bindings_tenant_org_unit_fkey"
        FOREIGN KEY ("tenant_id", "organization_id", "org_unit_id")
        REFERENCES public."org_units"("tenant_id", "organization_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."directory_employment_bindings"
    ADD CONSTRAINT "directory_employment_bindings_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_employment_bindings_tenant_id_integration_id_fkey"
        FOREIGN KEY ("tenant_id", "integration_id")
        REFERENCES public."directory_integrations"("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_employment_bindings_tenant_id_employment_id_fkey"
        FOREIGN KEY ("tenant_id", "employment_id")
        REFERENCES public."employments"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON TABLE public."directory_integrations" TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE ON TABLE public."directory_user_bindings" TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE ON TABLE public."directory_org_unit_bindings" TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE ON TABLE public."directory_employment_bindings" TO enterprise_agent_admin;

DO $directory_rls$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'directory_integrations',
        'directory_user_bindings',
        'directory_org_unit_bindings',
        'directory_employment_bindings'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL '
            'TO enterprise_agent_admin '
            'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;
END
$directory_rls$;

COMMIT;
