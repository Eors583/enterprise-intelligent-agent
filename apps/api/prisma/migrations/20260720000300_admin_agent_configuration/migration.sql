GRANT SELECT ON TABLE public."agent_runs" TO enterprise_agent_admin;

DROP POLICY IF EXISTS enterprise_agent_admin_access ON public."agent_runs";
CREATE POLICY enterprise_agent_admin_access
ON public."agent_runs"
AS PERMISSIVE
FOR SELECT
TO enterprise_agent_admin
USING (true);
