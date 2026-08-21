BEGIN;

-- The member onboarding form now reads and writes reporting lines. Keep the
-- existing tenant-isolation policy and explicitly authorize only the admin DB
-- role used by the directory administration boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON public."manager_relations"
TO enterprise_agent_admin;

CREATE POLICY enterprise_agent_admin_access ON public."manager_relations"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMIT;
