BEGIN;

-- Role Assignment revocation owns only the local terminal transition. Keep the
-- admin capability narrower than the application worker's general Run writes.
GRANT UPDATE (
  "status",
  "error_code",
  "error_message",
  "finished_at",
  "reserved_tokens",
  "version",
  "updated_at"
) ON TABLE public."agent_runs" TO enterprise_agent_admin;

DROP POLICY IF EXISTS enterprise_agent_admin_access ON public."agent_runs";
CREATE POLICY enterprise_agent_admin_access
  ON public."agent_runs"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

-- The revocation transaction must commit its external cancellation intent with
-- the assignment and local Run transitions. The separate restrictive policy
-- preserves tenant isolation without widening the cross-tenant outbox worker.
GRANT SELECT, INSERT
  ON TABLE public."outbox_events"
  TO enterprise_agent_admin;

DROP POLICY IF EXISTS enterprise_agent_admin_tenant_isolation
  ON public."outbox_events";
CREATE POLICY enterprise_agent_admin_tenant_isolation
  ON public."outbox_events"
  AS RESTRICTIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

DROP POLICY IF EXISTS enterprise_agent_admin_access ON public."outbox_events";
CREATE POLICY enterprise_agent_admin_access
  ON public."outbox_events"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

COMMIT;
