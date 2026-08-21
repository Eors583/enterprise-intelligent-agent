-- The original orchestration model rejected a second active Run in the same
-- conversation. Conversation ordering is now enforced by
-- conversation_sequence in the Worker preparation gate, so multiple queued
-- questions must coexist durably.
DROP INDEX IF EXISTS public."agent_runs_one_active_per_conversation_idx";
