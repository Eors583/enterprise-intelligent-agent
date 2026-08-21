-- Relationship expansion runs through the tenant-scoped application role.
-- Projection state is required to distinguish trusted ACTIVE graph evidence
-- from CANDIDATE/OBSOLETE evidence, but graph projection mutations remain an
-- administrator-only capability.

BEGIN;

DROP POLICY IF EXISTS enterprise_agent_app_read_access
  ON public."knowledge_graph_projections";

CREATE POLICY enterprise_agent_app_read_access
  ON public."knowledge_graph_projections"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING ("status" = 'ACTIVE'::public."KnowledgeGraphProjectionStatus");

REVOKE INSERT, UPDATE, DELETE
  ON TABLE public."knowledge_graph_projections"
  FROM enterprise_agent_app;

GRANT SELECT
  ON TABLE public."knowledge_graph_projections"
  TO enterprise_agent_app;

GRANT USAGE
  ON TYPE public."KnowledgeGraphProjectionStatus"
  TO enterprise_agent_app;

COMMIT;
