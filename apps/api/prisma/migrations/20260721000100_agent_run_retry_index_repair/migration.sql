-- The orchestration migration created this object with CREATE UNIQUE INDEX.
-- 20260720000400 attempted to remove it with ALTER TABLE ... DROP CONSTRAINT,
-- which is a no-op for a standalone index. Remove the legacy uniqueness so a
-- failed run can be regenerated with the same input message and Agent.
DROP INDEX IF EXISTS public."agent_runs_tenant_id_input_message_id_agent_id_key";
