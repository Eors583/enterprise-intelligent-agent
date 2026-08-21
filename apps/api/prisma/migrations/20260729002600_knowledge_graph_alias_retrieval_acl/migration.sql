-- Approved active aliases participate in direct entity-name graph seeding.
-- Keep alias creation, retirement and correction administrator-only while
-- allowing the tenant-scoped application role to resolve active aliases.

BEGIN;

DROP POLICY IF EXISTS enterprise_agent_app_read_access
  ON public."knowledge_entity_aliases";

CREATE POLICY enterprise_agent_app_read_access
  ON public."knowledge_entity_aliases"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING ("active");

REVOKE INSERT, UPDATE, DELETE
  ON TABLE public."knowledge_entity_aliases"
  FROM enterprise_agent_app;

GRANT SELECT
  ON TABLE public."knowledge_entity_aliases"
  TO enterprise_agent_app;

COMMIT;
