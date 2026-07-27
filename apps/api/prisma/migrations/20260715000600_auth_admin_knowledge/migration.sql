-- Add first-party authentication, editable directory administration, and the
-- first useful knowledge-management slice. Migrations 001-005 stay immutable.
BEGIN;

CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN', 'MEMBER');
CREATE TYPE "OrgUnitStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "KnowledgeBaseStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');
CREATE TYPE "KnowledgeSourceType" AS ENUM ('TEXT', 'MARKDOWN', 'FILE');

ALTER TABLE public."users"
    ADD COLUMN "email_normalized" varchar(320),
    ADD COLUMN "role" "TenantRole" NOT NULL DEFAULT 'MEMBER';

UPDATE public."users"
SET "email_normalized" = lower(trim("email"));

ALTER TABLE public."users"
    ALTER COLUMN "email_normalized" SET NOT NULL;

CREATE UNIQUE INDEX "users_tenant_id_email_normalized_key"
ON public."users" ("tenant_id", "email_normalized");

ALTER TABLE public."organizations"
    ADD COLUMN "version" integer NOT NULL DEFAULT 1;

ALTER TABLE public."org_units"
    ADD COLUMN "status" "OrgUnitStatus" NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "version" integer NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "org_units_tenant_id_organization_id_id_key"
ON public."org_units" ("tenant_id", "organization_id", "id");

CREATE UNIQUE INDEX "positions_tenant_id_organization_id_id_key"
ON public."positions" ("tenant_id", "organization_id", "id");

-- A department parent, position, and employment assignment must belong to the
-- same legal organization, not merely the same tenant.
ALTER TABLE public."org_units"
    DROP CONSTRAINT "org_units_tenant_id_parent_id_fkey";
ALTER TABLE public."positions"
    DROP CONSTRAINT "positions_tenant_id_org_unit_id_fkey";
ALTER TABLE public."employments"
    DROP CONSTRAINT "employments_tenant_id_org_unit_id_fkey",
    DROP CONSTRAINT "employments_tenant_id_position_id_fkey";

ALTER TABLE public."org_units"
    ADD CONSTRAINT "org_units_tenant_id_organization_id_parent_id_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "parent_id")
    REFERENCES public."org_units" ("tenant_id", "organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."positions"
    ADD CONSTRAINT "positions_tenant_id_organization_id_org_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "org_unit_id")
    REFERENCES public."org_units" ("tenant_id", "organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."employments"
    ADD CONSTRAINT "employments_tenant_id_organization_id_org_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "org_unit_id")
    REFERENCES public."org_units" ("tenant_id", "organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "employments_tenant_id_organization_id_position_id_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "position_id")
    REFERENCES public."positions" ("tenant_id", "organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE public."password_credentials" (
    "user_id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "password_hash" text NOT NULL,
    "password_changed_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "password_credentials_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "password_credentials_tenant_id_user_id_fkey"
        FOREIGN KEY ("tenant_id", "user_id")
        REFERENCES public."users" ("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "password_credentials_tenant_id_user_id_key"
ON public."password_credentials" ("tenant_id", "user_id");

CREATE TABLE public."auth_sessions" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "access_token_hash" char(64) NOT NULL,
    "refresh_token_hash" char(64) NOT NULL,
    "label" varchar(120),
    "access_expires_at" timestamptz(6) NOT NULL,
    "refresh_expires_at" timestamptz(6) NOT NULL,
    "last_used_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" timestamptz(6),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_sessions_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "auth_sessions_tenant_id_user_id_fkey"
        FOREIGN KEY ("tenant_id", "user_id")
        REFERENCES public."users" ("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "auth_sessions_access_token_hash_key"
ON public."auth_sessions" ("access_token_hash");
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key"
ON public."auth_sessions" ("refresh_token_hash");
CREATE INDEX "auth_sessions_tenant_id_user_id_revoked_at_idx"
ON public."auth_sessions" ("tenant_id", "user_id", "revoked_at");
CREATE INDEX "auth_sessions_access_expires_at_idx"
ON public."auth_sessions" ("access_expires_at");
CREATE INDEX "auth_sessions_refresh_expires_at_idx"
ON public."auth_sessions" ("refresh_expires_at");

CREATE TABLE public."knowledge_bases" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "key" varchar(100) NOT NULL,
    "name" varchar(200) NOT NULL,
    "description" text,
    "status" "KnowledgeBaseStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" uuid NOT NULL,
    "version" integer NOT NULL DEFAULT 1,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_bases_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "knowledge_bases_tenant_id_created_by_id_fkey"
        FOREIGN KEY ("tenant_id", "created_by_id")
        REFERENCES public."users" ("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_bases_tenant_id_id_key"
ON public."knowledge_bases" ("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_bases_tenant_id_key_key"
ON public."knowledge_bases" ("tenant_id", "key");
CREATE INDEX "knowledge_bases_tenant_id_status_name_idx"
ON public."knowledge_bases" ("tenant_id", "status", "name");

CREATE TABLE public."knowledge_base_org_units" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "knowledge_base_id" uuid NOT NULL,
    "org_unit_id" uuid NOT NULL,
    "include_children" boolean NOT NULL DEFAULT true,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_base_org_units_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_base_org_units_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "knowledge_base_org_units_tenant_id_knowledge_base_id_fkey"
        FOREIGN KEY ("tenant_id", "knowledge_base_id")
        REFERENCES public."knowledge_bases" ("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "knowledge_base_org_units_tenant_id_org_unit_id_fkey"
        FOREIGN KEY ("tenant_id", "org_unit_id")
        REFERENCES public."org_units" ("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_base_org_units_tenant_id_knowledge_base_id_org_unit_id_key"
ON public."knowledge_base_org_units" ("tenant_id", "knowledge_base_id", "org_unit_id");
CREATE INDEX "knowledge_base_org_units_tenant_id_org_unit_id_idx"
ON public."knowledge_base_org_units" ("tenant_id", "org_unit_id");

CREATE TABLE public."knowledge_documents" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "knowledge_base_id" uuid NOT NULL,
    "title" varchar(300) NOT NULL,
    "source_type" "KnowledgeSourceType" NOT NULL,
    "mime_type" varchar(160),
    "file_name" varchar(300),
    "content_text" text,
    "object_key" text,
    "checksum" char(64),
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "document_version" integer NOT NULL DEFAULT 1,
    "created_by_id" uuid NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_documents_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "knowledge_documents_tenant_id_knowledge_base_id_fkey"
        FOREIGN KEY ("tenant_id", "knowledge_base_id")
        REFERENCES public."knowledge_bases" ("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "knowledge_documents_tenant_id_created_by_id_fkey"
        FOREIGN KEY ("tenant_id", "created_by_id")
        REFERENCES public."users" ("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_documents_tenant_id_id_key"
ON public."knowledge_documents" ("tenant_id", "id");
CREATE INDEX "knowledge_documents_tenant_id_knowledge_base_id_status_updated_at_idx"
ON public."knowledge_documents" ("tenant_id", "knowledge_base_id", "status", "updated_at" DESC);

-- Serialize tree mutations and reject self/descendant parenting in the
-- database as a second line of defence behind the Admin service validation.
CREATE OR REPLACE FUNCTION public.enforce_org_unit_acyclic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.tenant_id::text || ':' || NEW.organization_id::text, 0)
    );

    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'org unit cannot be its own parent';
    END IF;

    IF EXISTS (
        WITH RECURSIVE descendants AS (
            SELECT child.id
            FROM public.org_units AS child
            WHERE child.tenant_id = NEW.tenant_id
              AND child.organization_id = NEW.organization_id
              AND child.parent_id = NEW.id
            UNION ALL
            SELECT child.id
            FROM public.org_units AS child
            JOIN descendants AS ancestor ON child.parent_id = ancestor.id
            WHERE child.tenant_id = NEW.tenant_id
              AND child.organization_id = NEW.organization_id
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'org unit move would create a cycle';
    END IF;

    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.enforce_org_unit_acyclic() FROM PUBLIC;

CREATE TRIGGER org_units_acyclic_check
BEFORE INSERT OR UPDATE OF "tenant_id", "organization_id", "parent_id"
ON public."org_units"
FOR EACH ROW EXECUTE FUNCTION public.enforce_org_unit_acyclic();

DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_auth') THEN
        CREATE ROLE enterprise_agent_auth
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_admin') THEN
        CREATE ROLE enterprise_agent_admin
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    EXECUTE format('GRANT enterprise_agent_auth TO %I', current_user);
    EXECUTE format('GRANT enterprise_agent_admin TO %I', current_user);
END
$roles$;

REVOKE enterprise_agent_auth, enterprise_agent_admin FROM enterprise_agent_app;
REVOKE enterprise_agent_auth, enterprise_agent_admin FROM enterprise_agent_provisioner;
REVOKE enterprise_agent_auth, enterprise_agent_admin FROM enterprise_agent_outbox;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM enterprise_agent_auth;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM enterprise_agent_admin;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM enterprise_agent_auth;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM enterprise_agent_admin;
GRANT USAGE ON SCHEMA public TO enterprise_agent_auth, enterprise_agent_admin;

GRANT SELECT ON public."tenants", public."users", public."organizations", public."org_units",
    public."employments", public."password_credentials", public."auth_sessions", public."audit_events"
TO enterprise_agent_auth;
GRANT INSERT ON public."tenants", public."users", public."organizations", public."org_units",
    public."employments", public."password_credentials", public."auth_sessions", public."audit_events"
TO enterprise_agent_auth;
GRANT UPDATE ON public."users", public."password_credentials", public."auth_sessions"
TO enterprise_agent_auth;

GRANT SELECT, INSERT, UPDATE ON public."users", public."organizations", public."org_units",
    public."positions", public."employments", public."password_credentials",
    public."knowledge_bases", public."knowledge_documents"
TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."knowledge_base_org_units"
TO enterprise_agent_admin;
GRANT SELECT, UPDATE ON public."auth_sessions" TO enterprise_agent_admin;
GRANT SELECT, INSERT ON public."audit_events" TO enterprise_agent_admin;

GRANT SELECT ON public."knowledge_bases", public."knowledge_base_org_units",
    public."knowledge_documents"
TO enterprise_agent_app;

GRANT EXECUTE ON FUNCTION public.enforce_org_unit_acyclic()
TO enterprise_agent_auth, enterprise_agent_admin;

-- Auth must resolve a workspace and opaque token hash before a tenant context
-- exists. Its cross-tenant visibility is limited to identity tables only.
DO $identity_policies$
DECLARE
    table_name text;
    tenant_column text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['tenants', 'users']
    LOOP
        tenant_column := CASE WHEN table_name = 'tenants' THEN 'id' ELSE 'tenant_id' END;
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', table_name);
        EXECUTE format('DROP POLICY IF EXISTS enterprise_agent_auth_access ON public.%I', table_name);
        EXECUTE format('DROP POLICY IF EXISTS enterprise_agent_admin_access ON public.%I', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL '
            'TO enterprise_agent_app, enterprise_agent_provisioner, enterprise_agent_admin '
            'USING (%I = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (%I = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name,
            tenant_column,
            tenant_column
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_auth_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_auth USING (true) WITH CHECK (true)',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;
END
$identity_policies$;

-- Existing tenant tables keep their restrictive tenant policy. These extra
-- permissive policies only make the new capability roles eligible after the
-- required app.tenant_id has been set in their transaction.
DO $existing_admin_policies$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'organizations', 'org_units', 'positions', 'employments', 'audit_events'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS enterprise_agent_admin_access ON public.%I', table_name);
        EXECUTE format(
            'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY[
        'organizations', 'org_units', 'employments', 'audit_events'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS enterprise_agent_auth_access ON public.%I', table_name);
        EXECUTE format(
            'CREATE POLICY enterprise_agent_auth_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_auth USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;
END
$existing_admin_policies$;

ALTER TABLE public."password_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."password_credentials" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."auth_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auth_sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."password_credentials"
AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_auth_access ON public."password_credentials"
AS PERMISSIVE FOR ALL TO enterprise_agent_auth USING (true) WITH CHECK (true);
CREATE POLICY enterprise_agent_admin_access ON public."password_credentials"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON public."auth_sessions"
AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_auth_access ON public."auth_sessions"
AS PERMISSIVE FOR ALL TO enterprise_agent_auth USING (true) WITH CHECK (true);
CREATE POLICY enterprise_agent_admin_access ON public."auth_sessions"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true);

DO $knowledge_policies$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'knowledge_bases', 'knowledge_base_org_units', 'knowledge_documents'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL '
            'TO enterprise_agent_app, enterprise_agent_admin '
            'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_app USING (true) WITH CHECK (true)',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;
END
$knowledge_policies$;

COMMIT;
