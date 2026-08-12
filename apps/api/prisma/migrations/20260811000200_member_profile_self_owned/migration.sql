BEGIN;

REVOKE INSERT, UPDATE, DELETE ON public."member_profiles" FROM enterprise_agent_admin;

DROP POLICY IF EXISTS enterprise_agent_admin_access ON public."member_profiles";

CREATE POLICY enterprise_agent_admin_read ON public."member_profiles"
AS PERMISSIVE FOR SELECT TO enterprise_agent_admin
USING (true);

COMMENT ON TABLE public."member_profiles" IS
  'Tenant-scoped collaboration manuals written by the profile owner through the employee self-service API.';

COMMIT;
