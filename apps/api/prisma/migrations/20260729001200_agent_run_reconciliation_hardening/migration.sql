BEGIN;

ALTER TABLE public."agent_run_stream_events"
  DROP CONSTRAINT "agent_run_stream_events_sequence_bounds_check",
  ADD CONSTRAINT "agent_run_stream_events_sequence_bounds_check"
    CHECK ("sequence" BETWEEN 1 AND 10001);

CREATE TABLE public."ai_model_connectivity_probes" (
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "target_catalog_version_id" uuid NOT NULL,
  "requester_user_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_model_connectivity_probes_pkey"
    PRIMARY KEY ("tenant_id", "run_id"),
  CONSTRAINT "ai_model_connectivity_probes_run_fkey"
    FOREIGN KEY ("tenant_id", "run_id")
    REFERENCES public."agent_runs"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT "ai_model_connectivity_probes_catalog_fkey"
    FOREIGN KEY ("tenant_id", "target_catalog_version_id")
    REFERENCES public."ai_model_catalog_versions"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT "ai_model_connectivity_probes_requester_fkey"
    FOREIGN KEY ("tenant_id", "requester_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT "ai_model_connectivity_probes_conversation_fkey"
    FOREIGN KEY ("tenant_id", "conversation_id")
    REFERENCES public."conversations"("tenant_id", "id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

CREATE INDEX "ai_model_connectivity_probes_catalog_created_idx"
  ON public."ai_model_connectivity_probes" (
    "tenant_id",
    "target_catalog_version_id",
    "created_at"
  );

-- Preserve strictly shaped probes created before the dedicated trust record
-- existed. This is intentionally narrower than the application marker alone.
INSERT INTO public."ai_model_connectivity_probes" (
  "tenant_id",
  "run_id",
  "target_catalog_version_id",
  "requester_user_id",
  "conversation_id",
  "created_at"
)
SELECT
  run."tenant_id",
  run."id",
  CASE
    WHEN run."policy_snapshot" ->> 'connectivityProbeCatalogVersionId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN (run."policy_snapshot" ->> 'connectivityProbeCatalogVersionId')::uuid
  END,
  run."requester_user_id",
  run."conversation_id",
  run."created_at"
FROM public."agent_runs" run
JOIN public."conversations" conversation
  ON conversation."tenant_id" = run."tenant_id"
 AND conversation."id" = run."conversation_id"
JOIN public."messages" message
  ON message."tenant_id" = run."tenant_id"
 AND message."conversation_id" = run."conversation_id"
 AND message."id" = run."input_message_id"
JOIN public."ai_model_catalog_versions" catalog
  ON catalog."tenant_id" = run."tenant_id"
 AND catalog."id" = CASE
   WHEN run."policy_snapshot" ->> 'connectivityProbeCatalogVersionId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   THEN (run."policy_snapshot" ->> 'connectivityProbeCatalogVersionId')::uuid
 END
WHERE run."policy_snapshot" -> 'controlledModelConnectivityProbe' = 'true'::jsonb
  AND run."policy_snapshot" ->> 'connectivityProbeCatalogVersionId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND run."idempotency_key" LIKE 'model-connectivity-probe:%'
  AND run."trigger" = 'USER_MESSAGE'::public."AgentRunTrigger"
  AND run."turn_index" = 1
  AND run."turn_limit" = 1
  AND conversation."type" = 'DIRECT'::public."ConversationType"
  AND conversation."direct_key" =
      'model-connectivity-probe:' || run."requester_user_id"::text || ':' || run."agent_id"::text
  AND conversation."title" = '[SYSTEM] Model connectivity probe'
  AND message."sender_type" = 'USER'::public."ConversationParticipantType"
  AND message."sender_user_id" = run."requester_user_id"
  AND message."sender_key" = 'user:' || run."requester_user_id"::text
  AND message."content_type" = 'TEXT'::public."MessageContentType"
  AND message."content" = jsonb_build_object(
    'type',
    'text',
    'text',
    'Reply with exactly MODEL_CONNECTIVITY_OK. This is a controlled administrator connectivity test. Do not call tools.'
  )
  AND catalog."status" = 'PUBLISHED'::public."AiGovernanceStatus"
  AND EXISTS (
    SELECT 1
    FROM public."conversation_participants" participant
    WHERE participant."tenant_id" = run."tenant_id"
      AND participant."conversation_id" = run."conversation_id"
      AND participant."type" = 'USER'::public."ConversationParticipantType"
      AND participant."user_id" = run."requester_user_id"
      AND participant."participant_key" = 'user:' || run."requester_user_id"::text
  )
  AND EXISTS (
    SELECT 1
    FROM public."conversation_participants" participant
    WHERE participant."tenant_id" = run."tenant_id"
      AND participant."conversation_id" = run."conversation_id"
      AND participant."type" = 'AGENT'::public."ConversationParticipantType"
      AND participant."agent_id" = run."agent_id"
      AND participant."participant_key" = 'agent:' || run."agent_id"::text
  );

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
      AND policy."task_class" = version."model_policy" ->> 'taskClass'
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

CREATE OR REPLACE FUNCTION public.reject_ai_model_connectivity_probe_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'ai_model_connectivity_probes is append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION public.guard_agent_run_execution_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id"
     OR OLD."input_message_id" IS DISTINCT FROM NEW."input_message_id"
     OR OLD."requester_user_id" IS DISTINCT FROM NEW."requester_user_id"
     OR OLD."agent_id" IS DISTINCT FROM NEW."agent_id"
     OR OLD."agent_version_id" IS DISTINCT FROM NEW."agent_version_id"
     OR OLD."parent_run_id" IS DISTINCT FROM NEW."parent_run_id"
     OR OLD."retry_of_run_id" IS DISTINCT FROM NEW."retry_of_run_id"
     OR OLD."trigger" IS DISTINCT FROM NEW."trigger"
     OR OLD."turn_index" IS DISTINCT FROM NEW."turn_index"
     OR OLD."turn_limit" IS DISTINCT FROM NEW."turn_limit"
     OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR OLD."policy_snapshot" IS DISTINCT FROM NEW."policy_snapshot"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'Agent Run execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ai_model_connectivity_probes_append_only"
BEFORE UPDATE OR DELETE ON public."ai_model_connectivity_probes"
FOR EACH ROW
EXECUTE FUNCTION public.reject_ai_model_connectivity_probe_mutation();

CREATE TRIGGER "ai_model_connectivity_probes_reject_truncate"
BEFORE TRUNCATE ON public."ai_model_connectivity_probes"
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_ai_model_connectivity_probe_mutation();

CREATE TRIGGER "agent_runs_execution_identity_guard"
BEFORE UPDATE ON public."agent_runs"
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_run_execution_identity();

ALTER TABLE public."ai_model_connectivity_probes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ai_model_connectivity_probes" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public."ai_model_connectivity_probes"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (
  "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

CREATE POLICY enterprise_agent_probe_read
ON public."ai_model_connectivity_probes"
AS PERMISSIVE
FOR SELECT
TO enterprise_agent_app
USING (true);

CREATE POLICY enterprise_agent_admin_probe_read
ON public."ai_model_connectivity_probes"
AS PERMISSIVE
FOR SELECT
TO enterprise_agent_admin
USING (true);

REVOKE ALL ON TABLE public."ai_model_connectivity_probes" FROM PUBLIC;
GRANT SELECT ON TABLE public."ai_model_connectivity_probes"
  TO enterprise_agent_app, enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid)
  TO enterprise_agent_app;
REVOKE ALL ON FUNCTION public.reject_ai_model_connectivity_probe_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_agent_run_execution_identity()
  FROM PUBLIC;

COMMENT ON TABLE public."ai_model_connectivity_probes" IS
  'Immutable provenance for administrator-controlled provider connectivity Runs.';
COMMENT ON FUNCTION public.register_ai_model_connectivity_probe(uuid, uuid, uuid, uuid) IS
  'Registers a strictly shaped system probe; direct table writes remain unavailable to the app role.';

COMMIT;
