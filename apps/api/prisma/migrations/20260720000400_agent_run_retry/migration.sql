ALTER TABLE "agent_runs"
  DROP CONSTRAINT IF EXISTS "agent_runs_tenant_id_input_message_id_agent_id_key";

ALTER TABLE "agent_runs"
  ADD COLUMN "retry_of_run_id" UUID;

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_retry_of_run_fk"
  FOREIGN KEY ("tenant_id", "retry_of_run_id")
  REFERENCES "agent_runs"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "agent_runs_tenant_id_input_message_id_agent_id_idx"
  ON "agent_runs"("tenant_id", "input_message_id", "agent_id");
