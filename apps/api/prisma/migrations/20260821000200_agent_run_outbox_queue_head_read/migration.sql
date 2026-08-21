BEGIN;

-- The Outbox worker needs only the execution-order columns required to avoid
-- claiming a queued Run whose conversation predecessor is still active.
GRANT SELECT (
  "id",
  "tenant_id",
  "conversation_id",
  "conversation_sequence",
  "turn_index",
  "status"
) ON TABLE public."agent_runs" TO enterprise_agent_outbox;

-- agent_runs has a PUBLIC restrictive tenant policy. A new permissive policy
-- alone cannot make rows visible to the cross-tenant Outbox worker because all
-- applicable restrictive policies are ANDed. Preserve the tenant predicate for
-- every other role and admit only the fixed, NOLOGIN Outbox role. Column-level
-- grants above remain the outer capability boundary; this role still cannot
-- read prompts, messages, policy snapshots, usage, or output fields.
ALTER POLICY "tenant_isolation"
  ON public."agent_runs"
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_user = 'enterprise_agent_outbox'
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_user = 'enterprise_agent_outbox'
  );

DROP POLICY IF EXISTS "enterprise_agent_outbox_queue_head_read"
  ON public."agent_runs";
CREATE POLICY "enterprise_agent_outbox_queue_head_read"
  ON public."agent_runs"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_outbox
  USING (true);

COMMIT;
