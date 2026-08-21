BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'enterprise_agent_feedback_projector'
  ) THEN
    CREATE ROLE enterprise_agent_feedback_projector
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_feedback_projector
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format(
    'GRANT enterprise_agent_feedback_projector TO %I',
    current_user
  );
END
$$;
GRANT enterprise_agent_app TO enterprise_agent_feedback_projector;
REVOKE enterprise_agent_admin, enterprise_agent_auth,
  enterprise_agent_evaluation_runner
  FROM enterprise_agent_feedback_projector;

CREATE UNIQUE INDEX IF NOT EXISTS "answer_feedbacks_tenant_id_id_key"
  ON public."answer_feedbacks" ("tenant_id", "id");

CREATE TABLE public."ai_evaluation_answer_feedback_sources" (
  "tenant_id" UUID NOT NULL,
  "bad_case_id" UUID NOT NULL,
  "feedback_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "input_message_id" UUID NOT NULL,
  "agent_run_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "agent_version_id" UUID NOT NULL,
  "reported_by_user_id" UUID NOT NULL,
  "feedback_reason" public."AnswerFeedbackReason" NOT NULL,
  "feedback_recorded_at" TIMESTAMPTZ(6) NOT NULL,
  "prompt_snapshot_hash" CHAR(64) NOT NULL,
  "answer_snapshot_hash" CHAR(64) NOT NULL,
  "citations_snapshot_hash" CHAR(64) NOT NULL,
  "citations" JSONB NOT NULL,
  "source_snapshot_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_pkey"
    PRIMARY KEY ("tenant_id", "bad_case_id"),
  CONSTRAINT "ai_evaluation_answer_feedback_sources_feedback_key"
    UNIQUE ("tenant_id", "feedback_id"),
  CONSTRAINT "ai_evaluation_answer_feedback_sources_message_key"
    UNIQUE ("tenant_id", "message_id"),
  CONSTRAINT "ai_evaluation_answer_feedback_sources_run_key"
    UNIQUE ("tenant_id", "agent_run_id"),
  CONSTRAINT "ai_evaluation_answer_feedback_sources_shape_check" CHECK (
    "prompt_snapshot_hash" ~ '^[a-f0-9]{64}$'
    AND "answer_snapshot_hash" ~ '^[a-f0-9]{64}$'
    AND "citations_snapshot_hash" ~ '^[a-f0-9]{64}$'
    AND "source_snapshot_hash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("citations") = 'array'
    AND jsonb_array_length("citations") <= 12
  ),
  CONSTRAINT "ai_evaluation_answer_feedback_sources_bad_case_fkey"
    FOREIGN KEY ("tenant_id", "bad_case_id")
    REFERENCES public."ai_evaluation_bad_cases" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_feedback_fkey"
    FOREIGN KEY ("tenant_id", "feedback_id")
    REFERENCES public."answer_feedbacks" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_conversation_fkey"
    FOREIGN KEY ("tenant_id", "conversation_id")
    REFERENCES public."conversations" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_message_fkey"
    FOREIGN KEY ("tenant_id", "message_id")
    REFERENCES public."messages" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_input_message_fkey"
    FOREIGN KEY ("tenant_id", "input_message_id")
    REFERENCES public."messages" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_run_fkey"
    FOREIGN KEY ("tenant_id", "agent_run_id")
    REFERENCES public."agent_runs" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_agent_fkey"
    FOREIGN KEY ("tenant_id", "agent_id")
    REFERENCES public."agent_instances" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_agent_version_fkey"
    FOREIGN KEY ("tenant_id", "agent_version_id")
    REFERENCES public."agent_versions" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_evaluation_answer_feedback_sources_reporter_fkey"
    FOREIGN KEY ("tenant_id", "reported_by_user_id")
    REFERENCES public."users" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ai_evaluation_answer_feedback_sources_version_time_idx"
  ON public."ai_evaluation_answer_feedback_sources" (
    "tenant_id", "agent_version_id", "feedback_recorded_at" DESC
  );

ALTER TABLE public."ai_evaluation_answer_feedback_sources"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ai_evaluation_answer_feedback_sources"
  FORCE ROW LEVEL SECURITY;

CREATE POLICY "ai_evaluation_tenant_isolation"
  ON public."ai_evaluation_answer_feedback_sources"
  AS RESTRICTIVE FOR ALL
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_evaluation_runner
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY "ai_evaluation_admin_access"
  ON public."ai_evaluation_answer_feedback_sources"
  AS PERMISSIVE FOR ALL TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

CREATE POLICY "ai_evaluation_feedback_projector_access"
  ON public."ai_evaluation_answer_feedback_sources"
  AS PERMISSIVE FOR ALL TO enterprise_agent_feedback_projector
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public."ai_evaluation_answer_feedback_sources"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_evaluation_runner, enterprise_agent_feedback_projector;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public."ai_evaluation_answer_feedback_sources"
  TO enterprise_agent_admin;
GRANT SELECT, INSERT
  ON TABLE public."ai_evaluation_answer_feedback_sources"
  TO enterprise_agent_feedback_projector;

GRANT SELECT, INSERT
  ON TABLE public."ai_evaluation_bad_cases"
  TO enterprise_agent_feedback_projector;
CREATE POLICY "ai_evaluation_feedback_projector_access"
  ON public."ai_evaluation_bad_cases"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_feedback_projector
  USING (true);
CREATE POLICY "ai_evaluation_feedback_projector_insert"
  ON public."ai_evaluation_bad_cases"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_feedback_projector
  WITH CHECK (true);

GRANT USAGE ON TYPE
  public."AiEvaluationCategory",
  public."AiEvaluationBadCaseStatus"
  TO enterprise_agent_feedback_projector;

CREATE OR REPLACE FUNCTION public.ai_evaluation_sanitize_feedback_input(
  input_text text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  sanitized text;
BEGIN
  sanitized := left(btrim(input_text), 20000);
  sanitized := regexp_replace(
    sanitized,
    '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',
    '[REDACTED_EMAIL]',
    'gi'
  );
  sanitized := regexp_replace(
    sanitized,
    '(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)',
    '\1[REDACTED_PHONE]\2',
    'g'
  );
  sanitized := regexp_replace(
    sanitized,
    '(sk|api|token|secret|password)[-_:= ]+[A-Za-z0-9_./+=-]{8,}',
    '\1=[REDACTED_SECRET]',
    'gi'
  );
  sanitized := regexp_replace(
    sanitized,
    '[A-Za-z0-9_+=/-]{32,}',
    '[REDACTED_TOKEN]',
    'g'
  );
  IF btrim(sanitized) = '' THEN
    RETURN '[REDACTED]';
  END IF;
  RETURN sanitized;
END
$$;

CREATE OR REPLACE FUNCTION public.ai_evaluation_answer_feedback_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."ai_evaluation_bad_cases" bad_case
    WHERE bad_case."tenant_id" = NEW."tenant_id"
      AND bad_case."id" = NEW."bad_case_id"
      AND bad_case."source_type" = 'ANSWER_FEEDBACK'
      AND bad_case."source_id" = NEW."feedback_id"
      AND bad_case."source_version" = 1
      AND bad_case."reported_by_user_id" = NEW."reported_by_user_id"
      AND bad_case."source_snapshot_hash" = NEW."source_snapshot_hash"
  ) THEN
    RAISE EXCEPTION 'Answer-feedback source does not match its Evaluation Bad Case.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_source_binding';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."answer_feedbacks" feedback
    JOIN public."messages" output_message
      ON output_message."tenant_id" = feedback."tenant_id"
     AND output_message."id" = feedback."message_id"
    JOIN public."agent_runs" run
      ON run."tenant_id" = feedback."tenant_id"
     AND run."output_message_id" = output_message."id"
    WHERE feedback."tenant_id" = NEW."tenant_id"
      AND feedback."id" = NEW."feedback_id"
      AND feedback."rating" = 'NOT_HELPFUL'
      AND feedback."reason" = NEW."feedback_reason"
      AND feedback."user_id" = NEW."reported_by_user_id"
      AND output_message."conversation_id" = NEW."conversation_id"
      AND output_message."id" = NEW."message_id"
      AND output_message."sender_type" = 'AGENT'
      AND output_message."sender_agent_id" = NEW."agent_id"
      AND run."id" = NEW."agent_run_id"
      AND run."conversation_id" = NEW."conversation_id"
      AND run."input_message_id" = NEW."input_message_id"
      AND run."requester_user_id" = NEW."reported_by_user_id"
      AND run."agent_id" = NEW."agent_id"
      AND run."agent_version_id" = NEW."agent_version_id"
      AND run."status" = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'Answer-feedback source is not bound to an eligible succeeded Agent Run.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_run_binding';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ai_evaluation_answer_feedback_sources_binding_guard"
  BEFORE INSERT ON public."ai_evaluation_answer_feedback_sources"
  FOR EACH ROW
  EXECUTE FUNCTION public.ai_evaluation_answer_feedback_source_guard();

CREATE TRIGGER "ai_evaluation_answer_feedback_sources_append_only"
  BEFORE UPDATE OR DELETE ON public."ai_evaluation_answer_feedback_sources"
  FOR EACH ROW
  EXECUTE FUNCTION public.ai_evaluation_append_only_guard();

CREATE OR REPLACE FUNCTION public.ai_evaluation_answer_feedback_pair_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."ai_evaluation_answer_feedback_sources" source
    WHERE source."tenant_id" = NEW."tenant_id"
      AND source."bad_case_id" = NEW."id"
      AND source."feedback_id" = NEW."source_id"
      AND source."source_snapshot_hash" = NEW."source_snapshot_hash"
      AND source."reported_by_user_id" = NEW."reported_by_user_id"
  ) THEN
    RAISE EXCEPTION 'An ANSWER_FEEDBACK Bad Case requires a trusted source projection.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_pair_required';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "ai_evaluation_answer_feedback_pair_required"
  AFTER INSERT OR UPDATE OF
    "source_type", "source_id", "source_version",
    "source_snapshot_hash", "reported_by_user_id"
  ON public."ai_evaluation_bad_cases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."source_type" = 'ANSWER_FEEDBACK')
  EXECUTE FUNCTION public.ai_evaluation_answer_feedback_pair_guard();

CREATE OR REPLACE FUNCTION public.project_not_helpful_answer_feedback_bad_case(
  feedback_id uuid
)
RETURNS TABLE ("bad_case_id" uuid, "created" boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_id uuid;
  actor_user_id uuid;
  context record;
  raw_citations jsonb;
  citation_snapshot jsonb;
  prompt_text text;
  answer_text text;
  prompt_hash char(64);
  answer_hash char(64);
  citation_hash char(64);
  snapshot_hash char(64);
  candidate_bad_case_id uuid;
  inserted_bad_case_id uuid;
BEGIN
  tenant_id := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  actor_user_id := NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF tenant_id IS NULL OR actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated tenant and user context are required.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(tenant_id::text || ':' || feedback_id::text, 0)
  );

  SELECT
    feedback."id" AS feedback_id,
    feedback."reason" AS feedback_reason,
    feedback."comment" AS feedback_comment,
    feedback."updated_at" AS feedback_recorded_at,
    output_message."conversation_id" AS conversation_id,
    output_message."id" AS message_id,
    output_message."content" AS output_content,
    input_message."id" AS input_message_id,
    input_message."content" AS input_content,
    run."id" AS agent_run_id,
    run."agent_id" AS agent_id,
    run."agent_version_id" AS agent_version_id
  INTO context
  FROM public."answer_feedbacks" feedback
  JOIN public."messages" output_message
    ON output_message."tenant_id" = feedback."tenant_id"
   AND output_message."id" = feedback."message_id"
  JOIN public."agent_runs" run
    ON run."tenant_id" = feedback."tenant_id"
   AND run."conversation_id" = output_message."conversation_id"
   AND run."output_message_id" = output_message."id"
  JOIN public."messages" input_message
    ON input_message."tenant_id" = run."tenant_id"
   AND input_message."conversation_id" = run."conversation_id"
   AND input_message."id" = run."input_message_id"
  JOIN public."users" reporter
    ON reporter."tenant_id" = feedback."tenant_id"
   AND reporter."id" = feedback."user_id"
   AND reporter."status" = 'ACTIVE'
  JOIN public."conversation_participants" participant
    ON participant."tenant_id" = feedback."tenant_id"
   AND participant."conversation_id" = output_message."conversation_id"
   AND participant."type" = 'USER'
   AND participant."user_id" = feedback."user_id"
   AND participant."left_at" IS NULL
  WHERE feedback."tenant_id" = tenant_id
    AND feedback."id" = feedback_id
    AND feedback."user_id" = actor_user_id
    AND feedback."rating" = 'NOT_HELPFUL'
    AND feedback."reason" IS NOT NULL
    AND output_message."sender_type" = 'AGENT'
    AND output_message."sender_agent_id" = run."agent_id"
    AND output_message."content_type" = 'TEXT'
    AND run."requester_user_id" = actor_user_id
    AND run."status" = 'SUCCEEDED'
  FOR SHARE OF feedback, output_message, run, input_message;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The negative feedback is missing, forged, or ineligible for evaluation.'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(context.input_content) <> 'object'
     OR context.input_content ->> 'type' <> 'text'
     OR NULLIF(btrim(context.input_content ->> 'text'), '') IS NULL
     OR jsonb_typeof(context.output_content) <> 'object'
     OR context.output_content ->> 'type' <> 'text'
     OR NULLIF(btrim(context.output_content ->> 'text'), '') IS NULL THEN
    RAISE EXCEPTION 'Only complete text Agent Run snapshots can become evaluation bad cases.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_text_snapshot';
  END IF;

  prompt_text := context.input_content ->> 'text';
  answer_text := context.output_content ->> 'text';
  raw_citations := COALESCE(context.output_content -> 'citations', '[]'::jsonb);
  IF jsonb_typeof(raw_citations) <> 'array'
     OR jsonb_array_length(raw_citations) > 12 THEN
    RAISE EXCEPTION 'Agent answer citations are malformed.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_citations_shape';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(raw_citations) citation(value)
    WHERE jsonb_typeof(citation.value) <> 'object'
      OR COALESCE(citation.value ->> 'knowledgeBaseId', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR COALESCE(citation.value ->> 'documentId', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR COALESCE(citation.value ->> 'documentVersionId', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR COALESCE(citation.value ->> 'chunkId', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  ) THEN
    RAISE EXCEPTION 'Agent answer citations lack immutable knowledge lineage.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_citations_lineage';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(raw_citations) citation(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."knowledge_chunks" chunk
      WHERE chunk."tenant_id" = tenant_id
        AND chunk."knowledge_base_id"
          = (citation.value ->> 'knowledgeBaseId')::uuid
        AND chunk."document_id" = (citation.value ->> 'documentId')::uuid
        AND chunk."document_version_id"
          = (citation.value ->> 'documentVersionId')::uuid
        AND chunk."id" = (citation.value ->> 'chunkId')::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Agent answer citation lineage is not owned by the current tenant.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_citations_tenant';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'knowledgeBaseId', citation.value ->> 'knowledgeBaseId',
        'documentId', citation.value ->> 'documentId',
        'documentVersionId', citation.value ->> 'documentVersionId',
        'chunkId', citation.value ->> 'chunkId'
      )
      ORDER BY citation.ordinality
    ),
    '[]'::jsonb
  )
  INTO citation_snapshot
  FROM jsonb_array_elements(raw_citations)
    WITH ORDINALITY AS citation(value, ordinality);

  prompt_hash := encode(
    digest(convert_to(prompt_text, 'UTF8'), 'sha256'),
    'hex'
  );
  answer_hash := encode(
    digest(convert_to(answer_text, 'UTF8'), 'sha256'),
    'hex'
  );
  citation_hash := encode(
    digest(convert_to(citation_snapshot::text, 'UTF8'), 'sha256'),
    'hex'
  );
  snapshot_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'tenantId', tenant_id,
          'feedbackId', context.feedback_id,
          'feedbackReason', context.feedback_reason,
          'feedbackCommentHash', encode(
            digest(
              convert_to(COALESCE(context.feedback_comment, ''), 'UTF8'),
              'sha256'
            ),
            'hex'
          ),
          'feedbackRecordedAt', context.feedback_recorded_at,
          'conversationId', context.conversation_id,
          'messageId', context.message_id,
          'inputMessageId', context.input_message_id,
          'agentRunId', context.agent_run_id,
          'agentId', context.agent_id,
          'agentVersionId', context.agent_version_id,
          'promptSnapshotHash', prompt_hash,
          'answerSnapshotHash', answer_hash,
          'citationsSnapshotHash', citation_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT bad_case."id"
  INTO candidate_bad_case_id
  FROM public."ai_evaluation_bad_cases" bad_case
  JOIN public."ai_evaluation_answer_feedback_sources" source
    ON source."tenant_id" = bad_case."tenant_id"
   AND source."bad_case_id" = bad_case."id"
  WHERE bad_case."tenant_id" = tenant_id
    AND bad_case."source_type" = 'ANSWER_FEEDBACK'
    AND bad_case."source_id" = feedback_id
    AND bad_case."source_version" = 1
    AND source."feedback_id" = feedback_id;

  IF candidate_bad_case_id IS NOT NULL THEN
    RETURN QUERY SELECT candidate_bad_case_id, false;
    RETURN;
  END IF;

  candidate_bad_case_id := gen_random_uuid();
  INSERT INTO public."ai_evaluation_bad_cases" (
    "id", "tenant_id", "source_type", "source_id", "source_version",
    "category", "sanitized_input", "source_snapshot_hash",
    "reported_by_user_id", "idempotency_key", "request_hash"
  ) VALUES (
    candidate_bad_case_id,
    tenant_id,
    'ANSWER_FEEDBACK',
    feedback_id,
    1,
    CASE context.feedback_reason
      WHEN 'IRRELEVANT_CITATION' THEN 'CITATION'::public."AiEvaluationCategory"
      WHEN 'OTHER' THEN 'GOAL_ALIGNMENT'::public."AiEvaluationCategory"
      ELSE 'FACTUALITY'::public."AiEvaluationCategory"
    END,
    public.ai_evaluation_sanitize_feedback_input(prompt_text),
    snapshot_hash,
    actor_user_id,
    'answer-feedback:' || feedback_id::text || ':v1',
    snapshot_hash
  )
  ON CONFLICT ("tenant_id", "source_type", "source_id", "source_version")
  DO NOTHING
  RETURNING "id" INTO inserted_bad_case_id;

  IF inserted_bad_case_id IS NULL THEN
    SELECT bad_case."id"
    INTO candidate_bad_case_id
    FROM public."ai_evaluation_bad_cases" bad_case
    WHERE bad_case."tenant_id" = tenant_id
      AND bad_case."source_type" = 'ANSWER_FEEDBACK'
      AND bad_case."source_id" = feedback_id
      AND bad_case."source_version" = 1;
    RAISE EXCEPTION 'A conflicting untrusted ANSWER_FEEDBACK Bad Case already exists.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_bad_case_conflict';
  END IF;

  INSERT INTO public."ai_evaluation_answer_feedback_sources" (
    "tenant_id", "bad_case_id", "feedback_id", "conversation_id",
    "message_id", "input_message_id", "agent_run_id", "agent_id",
    "agent_version_id", "reported_by_user_id", "feedback_reason",
    "feedback_recorded_at", "prompt_snapshot_hash", "answer_snapshot_hash",
    "citations_snapshot_hash", "citations", "source_snapshot_hash"
  ) VALUES (
    tenant_id, candidate_bad_case_id, feedback_id, context.conversation_id,
    context.message_id, context.input_message_id, context.agent_run_id,
    context.agent_id, context.agent_version_id, actor_user_id,
    context.feedback_reason, context.feedback_recorded_at, prompt_hash,
    answer_hash, citation_hash, citation_snapshot, snapshot_hash
  );

  RETURN QUERY SELECT candidate_bad_case_id, true;
END
$$;

ALTER FUNCTION public.ai_evaluation_sanitize_feedback_input(text)
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.ai_evaluation_answer_feedback_source_guard()
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.ai_evaluation_answer_feedback_pair_guard()
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.project_not_helpful_answer_feedback_bad_case(uuid)
  OWNER TO enterprise_agent_feedback_projector;

REVOKE ALL ON FUNCTION public.ai_evaluation_sanitize_feedback_input(text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_evaluation_answer_feedback_source_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_evaluation_answer_feedback_pair_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_not_helpful_answer_feedback_bad_case(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.project_not_helpful_answer_feedback_bad_case(uuid)
  TO enterprise_agent_app, enterprise_agent_admin;

COMMIT;
