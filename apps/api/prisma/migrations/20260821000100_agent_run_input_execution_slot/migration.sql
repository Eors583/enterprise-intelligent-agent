-- One accepted input message owns one logical answer slot. Failed and
-- cancelled attempts remain auditable, but an in-flight, uncertain, or
-- successful answer prevents another Run for the same input message.
--
-- Prisma deploy executes each migration in a transaction, so CONCURRENTLY is
-- not valid here. Production rollout must schedule the brief write lock (or
-- introduce a separately governed, transaction-free index deployment path).
CREATE UNIQUE INDEX
  "agent_runs_one_answer_per_input_message_idx"
ON public."agent_runs" ("tenant_id", "input_message_id")
WHERE "status" IN (
  'QUEUED'::public."AgentRunStatus",
  'DISPATCHING'::public."AgentRunStatus",
  'RUNNING'::public."AgentRunStatus",
  'UNKNOWN'::public."AgentRunStatus",
  'SUCCEEDED'::public."AgentRunStatus"
);

-- Supports both the claim-time queue-head optimization and the authoritative
-- prepare-time conversation ordering check.
CREATE INDEX
  "agent_runs_active_conversation_order_idx"
ON public."agent_runs" (
  "tenant_id",
  "conversation_id",
  "conversation_sequence",
  "turn_index"
)
WHERE "status" IN (
  'QUEUED'::public."AgentRunStatus",
  'DISPATCHING'::public."AgentRunStatus",
  'RUNNING'::public."AgentRunStatus",
  'UNKNOWN'::public."AgentRunStatus"
);
