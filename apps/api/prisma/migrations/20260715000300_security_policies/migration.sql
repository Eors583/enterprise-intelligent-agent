-- Harden the application database role and make tenant isolation an
-- unavoidable RLS boundary. This migration is data preserving: existing rows
-- are neither rewritten nor validated by the new message trigger.
BEGIN;

-- Seed/bootstrap writes are deliberately separated from the API role. The
-- migration login receives membership so an explicit SET LOCAL ROLE can be
-- used by provisioning tooling; enterprise_agent_app receives no membership.
DO $provisioner_role$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_provisioner'
    ) THEN
        CREATE ROLE enterprise_agent_provisioner
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ELSE
        ALTER ROLE enterprise_agent_provisioner
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;

    EXECUTE format('GRANT enterprise_agent_provisioner TO %I', current_user);
    IF EXISTS (
        SELECT 1
        FROM pg_auth_members AS membership
        JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        JOIN pg_roles AS member_role ON member_role.oid = membership.member
        WHERE granted_role.rolname = 'enterprise_agent_provisioner'
          AND member_role.rolname = 'enterprise_agent_app'
    ) THEN
        REVOKE enterprise_agent_provisioner FROM enterprise_agent_app;
    END IF;
END
$provisioner_role$;

-- The initial migration intentionally bootstrapped a broad application role.
-- Remove those grants (including access to _prisma_migrations) before adding
-- back only the permissions exercised by the current application.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM enterprise_agent_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM enterprise_agent_app;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM enterprise_agent_app;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM enterprise_agent_provisioner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM enterprise_agent_provisioner;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM enterprise_agent_provisioner;

-- Undo the initial migration owner's grants on tables and sequences created in
-- the future. New relations must be granted explicitly in a reviewed migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL PRIVILEGES ON TABLES FROM enterprise_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL PRIVILEGES ON SEQUENCES FROM enterprise_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL PRIVILEGES ON TABLES FROM enterprise_agent_provisioner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL PRIVILEGES ON SEQUENCES FROM enterprise_agent_provisioner;

GRANT USAGE ON SCHEMA public TO enterprise_agent_app;
GRANT USAGE ON SCHEMA public TO enterprise_agent_provisioner;

-- Tenant, directory, employment, and agent catalog data is read-only for the
-- API role. Administrative writes belong to a separate privileged workflow.
GRANT SELECT ON TABLE
    "tenants",
    "users",
    "organizations",
    "org_units",
    "positions",
    "employments",
    "manager_relations",
    "agent_templates",
    "agent_versions",
    "agent_instances"
TO enterprise_agent_app;

-- Provisioning is intentionally limited to the relations populated by seed.ts.
-- It has no conversation, message, outbox, audit, or migration-metadata access.
GRANT SELECT, INSERT, UPDATE ON TABLE
    "tenants",
    "users",
    "organizations",
    "org_units",
    "positions",
    "employments",
    "agent_templates",
    "agent_versions",
    "agent_instances"
TO enterprise_agent_provisioner;

GRANT SELECT, INSERT, UPDATE ON TABLE "conversations" TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_participants" TO enterprise_agent_app;
GRANT SELECT, INSERT ON TABLE "messages" TO enterprise_agent_app;

-- Prisma create() emits INSERT ... RETURNING for these append-only records, so
-- SELECT is required in addition to INSERT. UPDATE and DELETE remain denied.
GRANT SELECT, INSERT ON TABLE "outbox_events", "audit_events" TO enterprise_agent_app;

-- _prisma_migrations normally has no PUBLIC grants, but revoke them explicitly
-- when the relation exists so the application can never inherit metadata access
-- through PUBLIC.
DO $migration_metadata$
BEGIN
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations" FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations" FROM enterprise_agent_app;
        REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations" FROM enterprise_agent_provisioner;
    END IF;
END
$migration_metadata$;

-- PostgreSQL ORs permissive policies but ANDs every applicable restrictive
-- policy. Keeping tenant_isolation restrictive means a future permissive policy
-- cannot accidentally expose a different tenant. Base policies are scoped to
-- the application and provisioning roles; every other non-bypass role remains
-- default-denied even if it has table privileges.
DO $tenant_policies$
DECLARE
    table_name text;
    tenant_column text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'tenants',
        'users',
        'organizations',
        'org_units',
        'positions',
        'employments',
        'manager_relations',
        'agent_templates',
        'agent_versions',
        'agent_instances',
        'conversations',
        'conversation_participants',
        'messages',
        'outbox_events',
        'audit_events'
    ]
    LOOP
        tenant_column := CASE WHEN table_name = 'tenants' THEN 'id' ELSE 'tenant_id' END;

        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', table_name);
        EXECUTE format('DROP POLICY IF EXISTS enterprise_agent_access ON public.%I', table_name);
        EXECUTE format(
            'DROP POLICY IF EXISTS enterprise_agent_provisioning_access ON public.%I',
            table_name
        );

        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
            'USING (%I = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (%I = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name,
            tenant_column,
            tenant_column
        );

        EXECUTE format(
            'CREATE POLICY enterprise_agent_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_app USING (true) WITH CHECK (true)',
            table_name
        );

        IF table_name = ANY (ARRAY[
            'tenants',
            'users',
            'organizations',
            'org_units',
            'positions',
            'employments',
            'agent_templates',
            'agent_versions',
            'agent_instances'
        ]) THEN
            EXECUTE format(
                'CREATE POLICY enterprise_agent_provisioning_access ON public.%I '
                'AS PERMISSIVE FOR ALL TO enterprise_agent_provisioner '
                'USING (true) WITH CHECK (true)',
                table_name
            );
        END IF;
    END LOOP;
END
$tenant_policies$;

-- A message principal must be an active participant in that exact tenant and
-- conversation. The same predicate handles USER and AGENT senders. FOR SHARE
-- serializes this check with a concurrent participant departure, while the
-- single generic check-violation message does not reveal whether another tenant,
-- conversation, or principal exists.
CREATE OR REPLACE FUNCTION public.enforce_message_sender_is_active_participant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    PERFORM 1
    FROM public.conversation_participants AS participant
    WHERE participant.tenant_id = NEW.tenant_id
      AND participant.conversation_id = NEW.conversation_id
      AND participant.type = NEW.sender_type
      AND participant.participant_key = NEW.sender_key
      AND participant.left_at IS NULL
      AND (
          (
              NEW.sender_type = 'USER'
              AND participant.user_id = NEW.sender_user_id
              AND participant.agent_id IS NULL
          )
          OR
          (
              NEW.sender_type = 'AGENT'
              AND participant.agent_id = NEW.sender_agent_id
              AND participant.user_id IS NULL
          )
      )
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'message sender is not an active conversation participant';
    END IF;

    RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES
ON FUNCTION public.enforce_message_sender_is_active_participant()
FROM PUBLIC;
GRANT EXECUTE
ON FUNCTION public.enforce_message_sender_is_active_participant()
TO enterprise_agent_app;

DROP TRIGGER IF EXISTS messages_active_participant_check ON public."messages";
CREATE TRIGGER messages_active_participant_check
BEFORE INSERT OR UPDATE OF
    "tenant_id",
    "conversation_id",
    "sender_type",
    "sender_user_id",
    "sender_agent_id",
    "sender_key"
ON public."messages"
FOR EACH ROW
EXECUTE FUNCTION public.enforce_message_sender_is_active_participant();

COMMIT;
