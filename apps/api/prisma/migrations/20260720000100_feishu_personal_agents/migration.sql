-- Allow the tenant administration capability to provision personal agents
-- while reconciling an externally managed directory. Template/version data
-- remains read-only and agent deletion is deliberately not granted.
GRANT SELECT ON TABLE public."agent_templates", public."agent_versions"
TO enterprise_agent_admin;

GRANT SELECT, INSERT, UPDATE ON TABLE public."agent_instances"
TO enterprise_agent_admin;

DO $admin_agent_policies$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'agent_templates', 'agent_versions', 'agent_instances'
    ]
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS enterprise_agent_admin_access ON public.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;
END
$admin_agent_policies$;
