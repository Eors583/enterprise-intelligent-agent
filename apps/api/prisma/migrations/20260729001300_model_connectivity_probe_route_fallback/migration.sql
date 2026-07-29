BEGIN;

CREATE OR REPLACE FUNCTION public.register_ai_model_connectivity_probe(
  requested_tenant_id uuid,
  requested_run_id uuid,
  requested_catalog_version_id uuid,
  requested_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  stored_run public."agent_runs"%ROWTYPE;
  stored_probe public."ai_model_connectivity_probes"%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid
       IS DISTINCT FROM requested_tenant_id
     OR NULLIF(current_setting('app.user_id', true), '')::uuid
       IS DISTINCT FROM requested_user_id THEN
    RAISE EXCEPTION 'model connectivity probe actor context is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT run.*
  INTO stored_run
  FROM public."agent_runs" run
  WHERE run."tenant_id" = requested_tenant_id
    AND run."id" = requested_run_id
  FOR SHARE;

  IF NOT FOUND
     OR stored_run."status" <> 'QUEUED'::public."AgentRunStatus"
     OR stored_run."external_run_id" IS NOT NULL
     OR stored_run."requester_user_id" <> requested_user_id
     OR stored_run."trigger" <> 'USER_MESSAGE'::public."AgentRunTrigger"
     OR stored_run."turn_index" <> 1
     OR stored_run."turn_limit" <> 1
     OR stored_run."idempotency_key" NOT LIKE 'model-connectivity-probe:%'
     OR stored_run."policy_snapshot" -> 'controlledModelConnectivityProbe' <> 'true'::jsonb
     OR stored_run."policy_snapshot" ->> 'connectivityProbeCatalogVersionId'
        <> requested_catalog_version_id::text THEN
    RAISE EXCEPTION 'model connectivity probe Run provenance is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."conversations" conversation
    WHERE conversation."tenant_id" = requested_tenant_id
      AND conversation."id" = stored_run."conversation_id"
      AND conversation."type" = 'DIRECT'::public."ConversationType"
      AND conversation."direct_key" =
          'model-connectivity-probe:' || requested_user_id::text || ':' || stored_run."agent_id"::text
      AND conversation."title" = '[SYSTEM] Model connectivity probe'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public."messages" message
    WHERE message."tenant_id" = requested_tenant_id
      AND message."conversation_id" = stored_run."conversation_id"
      AND message."id" = stored_run."input_message_id"
      AND message."sender_type" = 'USER'::public."ConversationParticipantType"
      AND message."sender_user_id" = requested_user_id
      AND message."sender_key" = 'user:' || requested_user_id::text
      AND message."content_type" = 'TEXT'::public."MessageContentType"
      AND message."content" = jsonb_build_object(
        'type',
        'text',
        'text',
        'Reply with exactly MODEL_CONNECTIVITY_OK. This is a controlled administrator connectivity test. Do not call tools.'
      )
  ) OR (
    SELECT count(*)
    FROM public."conversation_participants" participant
    WHERE participant."tenant_id" = requested_tenant_id
      AND participant."conversation_id" = stored_run."conversation_id"
      AND participant."left_at" IS NULL
      AND (
        (
          participant."type" = 'USER'::public."ConversationParticipantType"
          AND participant."user_id" = requested_user_id
          AND participant."participant_key" = 'user:' || requested_user_id::text
        )
        OR (
          participant."type" = 'AGENT'::public."ConversationParticipantType"
          AND participant."agent_id" = stored_run."agent_id"
          AND participant."participant_key" = 'agent:' || stored_run."agent_id"::text
        )
      )
  ) <> 2 OR (
    SELECT count(*)
    FROM public."conversation_participants" participant
    WHERE participant."tenant_id" = requested_tenant_id
      AND participant."conversation_id" = stored_run."conversation_id"
      AND participant."left_at" IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'model connectivity probe conversation provenance is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."ai_model_catalog_versions" catalog
    JOIN public."ai_model_route_candidates" candidate
      ON candidate."tenant_id" = catalog."tenant_id"
     AND candidate."catalog_version_id" = catalog."id"
    JOIN public."ai_model_route_policy_versions" policy
      ON policy."tenant_id" = candidate."tenant_id"
     AND policy."id" = candidate."policy_version_id"
    JOIN public."agent_versions" version
      ON version."tenant_id" = requested_tenant_id
     AND version."id" = stored_run."agent_version_id"
    WHERE catalog."tenant_id" = requested_tenant_id
      AND catalog."id" = requested_catalog_version_id
      AND catalog."status" = 'PUBLISHED'::public."AiGovernanceStatus"
      AND policy."status" = 'PUBLISHED'::public."AiGovernanceStatus"
      AND policy."task_class" = CASE
        WHEN version."model_policy" ->> 'taskClass'
             ~ '^[A-Z0-9][A-Z0-9._-]{0,119}$'
          THEN version."model_policy" ->> 'taskClass'
        ELSE 'GENERAL_QA'
      END
  ) THEN
    RAISE EXCEPTION 'model connectivity probe target is not a published route candidate'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public."ai_model_connectivity_probes" (
    "tenant_id",
    "run_id",
    "target_catalog_version_id",
    "requester_user_id",
    "conversation_id"
  )
  VALUES (
    requested_tenant_id,
    requested_run_id,
    requested_catalog_version_id,
    requested_user_id,
    stored_run."conversation_id"
  )
  ON CONFLICT ("tenant_id", "run_id") DO NOTHING;

  SELECT probe.*
  INTO stored_probe
  FROM public."ai_model_connectivity_probes" probe
  WHERE probe."tenant_id" = requested_tenant_id
    AND probe."run_id" = requested_run_id;

  IF stored_probe."target_catalog_version_id" <> requested_catalog_version_id
     OR stored_probe."requester_user_id" <> requested_user_id
     OR stored_probe."conversation_id" <> stored_run."conversation_id" THEN
    RAISE EXCEPTION 'model connectivity probe idempotency record conflicts'
      USING ERRCODE = '23505';
  END IF;

  RETURN requested_run_id;
END
$$;

REVOKE ALL ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid)
  TO enterprise_agent_app;

COMMENT ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid) IS
  'Registers a strictly shaped system probe using the same GENERAL_QA fallback as the trusted route resolver.';

COMMIT;
