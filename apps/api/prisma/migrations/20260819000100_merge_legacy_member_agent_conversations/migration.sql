-- Merge legacy two-user and requester-to-Agent direct conversations into the
-- member-assistant timeline introduced by 20260804000100. The legacy shell is
-- retained for audit history; only sources without Agent Runs are moved so no
-- Run/message lineage is rewritten ambiguously.

DROP TABLE IF EXISTS pg_temp.legacy_member_agent_conversation_merges;

CREATE TEMP TABLE legacy_member_agent_conversation_merges ON COMMIT DROP AS
SELECT
  agent_conversation.tenant_id,
  agent_conversation.id AS destination_id,
  human_conversation.id AS source_id,
  requester.user_id AS requester_user_id,
  owner_user.id AS owner_user_id,
  owner_user.display_name AS owner_display_name,
  agent_participant.agent_id
FROM public.conversations AS agent_conversation
JOIN public.conversation_participants AS requester
  ON requester.tenant_id = agent_conversation.tenant_id
 AND requester.conversation_id = agent_conversation.id
 AND requester.type = 'USER'
 AND requester.left_at IS NULL
JOIN public.conversation_participants AS agent_participant
  ON agent_participant.tenant_id = agent_conversation.tenant_id
 AND agent_participant.conversation_id = agent_conversation.id
 AND agent_participant.type = 'AGENT'
 AND agent_participant.left_at IS NULL
JOIN public.agent_instances AS agent
  ON agent.tenant_id = agent_participant.tenant_id
 AND agent.id = agent_participant.agent_id
JOIN public.users AS owner_user
  ON owner_user.tenant_id = agent.tenant_id
 AND owner_user.id = agent.owner_user_id
JOIN public.conversations AS human_conversation
  ON human_conversation.tenant_id = agent_conversation.tenant_id
 AND human_conversation.type = 'DIRECT'
 AND human_conversation.id <> agent_conversation.id
JOIN public.conversation_participants AS human_requester
  ON human_requester.tenant_id = human_conversation.tenant_id
 AND human_requester.conversation_id = human_conversation.id
 AND human_requester.type = 'USER'
 AND human_requester.user_id = requester.user_id
 AND human_requester.left_at IS NULL
JOIN public.conversation_participants AS human_owner
  ON human_owner.tenant_id = human_conversation.tenant_id
 AND human_owner.conversation_id = human_conversation.id
 AND human_owner.type = 'USER'
 AND human_owner.user_id = owner_user.id
 AND human_owner.left_at IS NULL
WHERE agent_conversation.type = 'DIRECT'
  AND agent_conversation.direct_key LIKE 'agent:%'
  AND human_conversation.direct_key LIKE 'human:%'
  AND requester.user_id <> owner_user.id
  AND (
    SELECT count(*)
    FROM public.conversation_participants AS participant
    WHERE participant.tenant_id = agent_conversation.tenant_id
      AND participant.conversation_id = agent_conversation.id
      AND participant.left_at IS NULL
  ) = 2
  AND (
    SELECT count(*)
    FROM public.conversation_participants AS participant
    WHERE participant.tenant_id = human_conversation.tenant_id
      AND participant.conversation_id = human_conversation.id
      AND participant.left_at IS NULL
  ) = 2
  AND NOT EXISTS (
    SELECT 1
    FROM public.agent_runs AS run
    WHERE run.tenant_id = human_conversation.tenant_id
      AND run.conversation_id = human_conversation.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.messages AS source_message
    JOIN public.messages AS destination_message
      ON destination_message.tenant_id = source_message.tenant_id
     AND destination_message.conversation_id = agent_conversation.id
     AND destination_message.sender_key = source_message.sender_key
     AND destination_message.client_message_id = source_message.client_message_id
    WHERE source_message.tenant_id = human_conversation.tenant_id
      AND source_message.conversation_id = human_conversation.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversations AS canonical
    WHERE canonical.tenant_id = agent_conversation.tenant_id
      AND canonical.id <> agent_conversation.id
      AND canonical.direct_key =
        'member-assistant:' || requester.user_id::text || ':' || owner_user.id::text
  );

INSERT INTO public.conversation_participants (
  id,
  tenant_id,
  conversation_id,
  type,
  participant_key,
  user_id,
  agent_id,
  display_name,
  role,
  joined_at,
  left_at
)
SELECT
  gen_random_uuid(),
  merge.tenant_id,
  merge.destination_id,
  'USER',
  'user:' || merge.owner_user_id::text,
  merge.owner_user_id,
  NULL,
  merge.owner_display_name,
  'MEMBER',
  now(),
  NULL
FROM legacy_member_agent_conversation_merges AS merge
ON CONFLICT (tenant_id, conversation_id, participant_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  left_at = NULL;

UPDATE public.messages AS message
SET conversation_id = merge.destination_id
FROM legacy_member_agent_conversation_merges AS merge
WHERE message.tenant_id = merge.tenant_id
  AND message.conversation_id = merge.source_id;

UPDATE public.memory_records AS memory
SET conversation_id = merge.destination_id,
    updated_at = now()
FROM legacy_member_agent_conversation_merges AS merge
WHERE memory.tenant_id = merge.tenant_id
  AND memory.conversation_id = merge.source_id;

UPDATE public.ai_model_connectivity_probes AS probe
SET conversation_id = merge.destination_id
FROM legacy_member_agent_conversation_merges AS merge
WHERE probe.tenant_id = merge.tenant_id
  AND probe.conversation_id = merge.source_id;

UPDATE public.ai_evaluation_answer_feedback_sources AS source
SET conversation_id = merge.destination_id
FROM legacy_member_agent_conversation_merges AS merge
WHERE source.tenant_id = merge.tenant_id
  AND source.conversation_id = merge.source_id;

INSERT INTO public.conversation_user_states (
  id,
  tenant_id,
  conversation_id,
  user_id,
  unread_count,
  last_read_message_id,
  last_read_at,
  pinned_at,
  archived_at,
  muted_until,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  state.tenant_id,
  merge.destination_id,
  state.user_id,
  state.unread_count,
  state.last_read_message_id,
  state.last_read_at,
  state.pinned_at,
  state.archived_at,
  state.muted_until,
  state.created_at,
  now()
FROM public.conversation_user_states AS state
JOIN legacy_member_agent_conversation_merges AS merge
  ON merge.tenant_id = state.tenant_id
 AND merge.source_id = state.conversation_id
ON CONFLICT (tenant_id, conversation_id, user_id)
DO UPDATE SET
  unread_count = GREATEST(public.conversation_user_states.unread_count, EXCLUDED.unread_count),
  last_read_message_id = CASE
    WHEN EXCLUDED.last_read_at > public.conversation_user_states.last_read_at
      OR public.conversation_user_states.last_read_at IS NULL
    THEN EXCLUDED.last_read_message_id
    ELSE public.conversation_user_states.last_read_message_id
  END,
  last_read_at = GREATEST(public.conversation_user_states.last_read_at, EXCLUDED.last_read_at),
  pinned_at = GREATEST(public.conversation_user_states.pinned_at, EXCLUDED.pinned_at),
  archived_at = CASE
    WHEN public.conversation_user_states.archived_at IS NULL OR EXCLUDED.archived_at IS NULL
    THEN NULL
    ELSE GREATEST(public.conversation_user_states.archived_at, EXCLUDED.archived_at)
  END,
  muted_until = GREATEST(public.conversation_user_states.muted_until, EXCLUDED.muted_until),
  updated_at = now();

DELETE FROM public.conversation_user_states AS state
USING legacy_member_agent_conversation_merges AS merge
WHERE state.tenant_id = merge.tenant_id
  AND state.conversation_id = merge.source_id;

UPDATE public.conversation_participants AS participant
SET left_at = COALESCE(participant.left_at, now())
FROM legacy_member_agent_conversation_merges AS merge
WHERE participant.tenant_id = merge.tenant_id
  AND participant.conversation_id = merge.source_id;

UPDATE public.conversations AS destination
SET direct_key =
      'member-assistant:' || merge.requester_user_id::text || ':' || merge.owner_user_id::text,
    title = merge.owner_display_name,
    last_message_at = GREATEST(destination.last_message_at, source.last_message_at),
    updated_at = now()
FROM legacy_member_agent_conversation_merges AS merge
JOIN public.conversations AS source
  ON source.tenant_id = merge.tenant_id
 AND source.id = merge.source_id
WHERE destination.tenant_id = merge.tenant_id
  AND destination.id = merge.destination_id;

UPDATE public.conversations AS source
SET direct_key = 'merged-history:' || source.id::text,
    title = source.title || '（已合并）',
    last_message_at = NULL,
    updated_at = now()
FROM legacy_member_agent_conversation_merges AS merge
WHERE source.tenant_id = merge.tenant_id
  AND source.id = merge.source_id;
