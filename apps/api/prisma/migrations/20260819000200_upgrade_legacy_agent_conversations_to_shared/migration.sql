-- Promote remaining requester-to-Agent legacy conversations that have no
-- separate human thread into real member/Agent shared conversations.

DROP TABLE IF EXISTS pg_temp.legacy_agent_conversation_upgrades;

CREATE TEMP TABLE legacy_agent_conversation_upgrades ON COMMIT DROP AS
SELECT
  conversation.tenant_id,
  conversation.id AS conversation_id,
  requester.user_id AS requester_user_id,
  owner_user.id AS owner_user_id,
  owner_user.display_name AS owner_display_name
FROM public.conversations AS conversation
JOIN public.conversation_participants AS requester
  ON requester.tenant_id = conversation.tenant_id
 AND requester.conversation_id = conversation.id
 AND requester.type = 'USER'
 AND requester.left_at IS NULL
JOIN public.conversation_participants AS agent_participant
  ON agent_participant.tenant_id = conversation.tenant_id
 AND agent_participant.conversation_id = conversation.id
 AND agent_participant.type = 'AGENT'
 AND agent_participant.left_at IS NULL
JOIN public.agent_instances AS agent
  ON agent.tenant_id = agent_participant.tenant_id
 AND agent.id = agent_participant.agent_id
JOIN public.users AS owner_user
  ON owner_user.tenant_id = agent.tenant_id
 AND owner_user.id = agent.owner_user_id
WHERE conversation.type = 'DIRECT'
  AND conversation.direct_key LIKE 'agent:%'
  AND (
    SELECT count(*)
    FROM public.conversation_participants AS participant
    WHERE participant.tenant_id = conversation.tenant_id
      AND participant.conversation_id = conversation.id
      AND participant.left_at IS NULL
      AND participant.type = 'USER'
  ) = 1
  AND (
    SELECT count(*)
    FROM public.conversation_participants AS participant
    WHERE participant.tenant_id = conversation.tenant_id
      AND participant.conversation_id = conversation.id
      AND participant.left_at IS NULL
      AND participant.type = 'AGENT'
  ) = 1
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversations AS canonical
    WHERE canonical.tenant_id = conversation.tenant_id
      AND canonical.id <> conversation.id
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
  upgrade.tenant_id,
  upgrade.conversation_id,
  'USER',
  'user:' || upgrade.owner_user_id::text,
  upgrade.owner_user_id,
  NULL,
  upgrade.owner_display_name,
  'MEMBER',
  now(),
  NULL
FROM legacy_agent_conversation_upgrades AS upgrade
ON CONFLICT (tenant_id, conversation_id, participant_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  left_at = NULL;

UPDATE public.conversations AS conversation
SET direct_key =
      'member-assistant:' || upgrade.requester_user_id::text || ':' || upgrade.owner_user_id::text,
    title = upgrade.owner_display_name,
    updated_at = now()
FROM legacy_agent_conversation_upgrades AS upgrade
WHERE conversation.tenant_id = upgrade.tenant_id
  AND conversation.id = upgrade.conversation_id;
