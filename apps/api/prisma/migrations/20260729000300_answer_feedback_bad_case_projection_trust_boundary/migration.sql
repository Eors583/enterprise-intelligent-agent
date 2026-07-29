BEGIN;

-- Derive every immutable source field from tenant-owned primary records. This
-- helper is deliberately not callable by application or administrator roles;
-- only the narrow SECURITY DEFINER projection and binding trigger may use it.
CREATE OR REPLACE FUNCTION public.ai_evaluation_derive_answer_feedback_source(
  context_tenant_id uuid,
  target_feedback_id uuid,
  context_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_context record;
  raw_citations jsonb;
  citation_snapshot jsonb;
  prompt_text text;
  answer_text text;
  prompt_hash char(64);
  answer_hash char(64);
  citation_hash char(64);
  snapshot_hash char(64);
  sanitized_input text;
  category public."AiEvaluationCategory";
BEGIN
  IF context_tenant_id IS NULL
     OR target_feedback_id IS NULL
     OR context_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'A complete answer-feedback derivation identity is required.'
      USING ERRCODE = '42501';
  END IF;

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
  INTO source_context
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
  WHERE feedback."tenant_id" = context_tenant_id
    AND feedback."id" = target_feedback_id
    AND feedback."user_id" = context_actor_user_id
    AND feedback."rating" = 'NOT_HELPFUL'
    AND feedback."reason" IS NOT NULL
    AND output_message."sender_type" = 'AGENT'
    AND output_message."sender_agent_id" = run."agent_id"
    AND output_message."content_type" = 'TEXT'
    AND run."requester_user_id" = context_actor_user_id
    AND run."status" = 'SUCCEEDED'
  FOR SHARE OF feedback, run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The negative feedback is missing, forged, or ineligible for evaluation.'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(source_context.input_content) <> 'object'
     OR source_context.input_content ->> 'type' <> 'text'
     OR NULLIF(btrim(source_context.input_content ->> 'text'), '') IS NULL
     OR jsonb_typeof(source_context.output_content) <> 'object'
     OR source_context.output_content ->> 'type' <> 'text'
     OR NULLIF(btrim(source_context.output_content ->> 'text'), '') IS NULL THEN
    RAISE EXCEPTION 'Only complete text Agent Run snapshots can become evaluation bad cases.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_text_snapshot';
  END IF;

  prompt_text := source_context.input_content ->> 'text';
  answer_text := source_context.output_content ->> 'text';
  raw_citations := COALESCE(source_context.output_content -> 'citations', '[]'::jsonb);
  IF jsonb_typeof(raw_citations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Agent answer citations are malformed.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_citations_shape';
  END IF;
  IF jsonb_array_length(raw_citations) > 12 THEN
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
      WHERE chunk."tenant_id" = context_tenant_id
        AND chunk."knowledge_base_id" = (citation.value ->> 'knowledgeBaseId')::uuid
        AND chunk."document_id" = (citation.value ->> 'documentId')::uuid
        AND chunk."document_version_id" = (citation.value ->> 'documentVersionId')::uuid
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

  prompt_hash := encode(digest(convert_to(prompt_text, 'UTF8'), 'sha256'), 'hex');
  answer_hash := encode(digest(convert_to(answer_text, 'UTF8'), 'sha256'), 'hex');
  citation_hash := encode(
    digest(convert_to(citation_snapshot::text, 'UTF8'), 'sha256'),
    'hex'
  );
  snapshot_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'tenantId', context_tenant_id,
          'feedbackId', source_context.feedback_id,
          'feedbackReason', source_context.feedback_reason,
          'feedbackCommentHash', encode(
            digest(
              convert_to(COALESCE(source_context.feedback_comment, ''), 'UTF8'),
              'sha256'
            ),
            'hex'
          ),
          'feedbackRecordedAt', source_context.feedback_recorded_at,
          'conversationId', source_context.conversation_id,
          'messageId', source_context.message_id,
          'inputMessageId', source_context.input_message_id,
          'agentRunId', source_context.agent_run_id,
          'agentId', source_context.agent_id,
          'agentVersionId', source_context.agent_version_id,
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
  sanitized_input := public.ai_evaluation_sanitize_feedback_input(prompt_text);
  category := CASE source_context.feedback_reason
    WHEN 'IRRELEVANT_CITATION' THEN 'CITATION'::public."AiEvaluationCategory"
    WHEN 'OTHER' THEN 'GOAL_ALIGNMENT'::public."AiEvaluationCategory"
    ELSE 'FACTUALITY'::public."AiEvaluationCategory"
  END;

  RETURN jsonb_build_object(
    'tenantId', context_tenant_id,
    'feedbackId', source_context.feedback_id,
    'conversationId', source_context.conversation_id,
    'messageId', source_context.message_id,
    'inputMessageId', source_context.input_message_id,
    'agentRunId', source_context.agent_run_id,
    'agentId', source_context.agent_id,
    'agentVersionId', source_context.agent_version_id,
    'reportedByUserId', context_actor_user_id,
    'feedbackReason', source_context.feedback_reason,
    'feedbackRecordedAt', source_context.feedback_recorded_at,
    'promptSnapshotHash', prompt_hash,
    'answerSnapshotHash', answer_hash,
    'citationsSnapshotHash', citation_hash,
    'citations', citation_snapshot,
    'sourceSnapshotHash', snapshot_hash,
    'sanitizedInput', sanitized_input,
    'category', category
  );
END
$$;

CREATE OR REPLACE FUNCTION public.ai_evaluation_answer_feedback_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_source jsonb;
BEGIN
  expected_source := public.ai_evaluation_derive_answer_feedback_source(
    NEW."tenant_id",
    NEW."feedback_id",
    NEW."reported_by_user_id"
  );

  IF NEW."conversation_id" IS DISTINCT FROM
       (expected_source ->> 'conversationId')::uuid
     OR NEW."message_id" IS DISTINCT FROM
       (expected_source ->> 'messageId')::uuid
     OR NEW."input_message_id" IS DISTINCT FROM
       (expected_source ->> 'inputMessageId')::uuid
     OR NEW."agent_run_id" IS DISTINCT FROM
       (expected_source ->> 'agentRunId')::uuid
     OR NEW."agent_id" IS DISTINCT FROM
       (expected_source ->> 'agentId')::uuid
     OR NEW."agent_version_id" IS DISTINCT FROM
       (expected_source ->> 'agentVersionId')::uuid
     OR NEW."feedback_reason"::text IS DISTINCT FROM
       expected_source ->> 'feedbackReason'
     OR NEW."feedback_recorded_at" IS DISTINCT FROM
       (expected_source ->> 'feedbackRecordedAt')::timestamptz THEN
    RAISE EXCEPTION 'Answer-feedback source identity was not derived from primary records.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_source_binding';
  END IF;

  IF btrim(NEW."prompt_snapshot_hash") IS DISTINCT FROM
       expected_source ->> 'promptSnapshotHash'
     OR btrim(NEW."answer_snapshot_hash") IS DISTINCT FROM
       expected_source ->> 'answerSnapshotHash'
     OR btrim(NEW."citations_snapshot_hash") IS DISTINCT FROM
       expected_source ->> 'citationsSnapshotHash'
     OR NEW."citations" IS DISTINCT FROM expected_source -> 'citations'
     OR btrim(NEW."source_snapshot_hash") IS DISTINCT FROM
       expected_source ->> 'sourceSnapshotHash' THEN
    RAISE EXCEPTION 'Answer-feedback snapshot hashes must be recomputed from primary records.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_hash_binding';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."ai_evaluation_bad_cases" bad_case
    WHERE bad_case."tenant_id" = NEW."tenant_id"
      AND bad_case."id" = NEW."bad_case_id"
      AND bad_case."source_type" = 'ANSWER_FEEDBACK'
      AND bad_case."source_id" = NEW."feedback_id"
      AND bad_case."source_version" = 1
      AND bad_case."reported_by_user_id" = NEW."reported_by_user_id"
      AND btrim(bad_case."source_snapshot_hash")
        = expected_source ->> 'sourceSnapshotHash'
      AND btrim(bad_case."request_hash")
        = expected_source ->> 'sourceSnapshotHash'
      AND bad_case."sanitized_input" = expected_source ->> 'sanitizedInput'
      AND bad_case."category"::text = expected_source ->> 'category'
  ) THEN
    RAISE EXCEPTION 'Answer-feedback source does not match its Evaluation Bad Case.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_bad_case_binding';
  END IF;
  RETURN NEW;
END
$$;

-- Existing ANSWER_FEEDBACK rows are never silently grandfathered. Eligible
-- exact rows are backfilled from primary records; any mismatch aborts the
-- migration and requires an explicit operator remediation before retry.
DO $upgrade$
DECLARE
  candidate record;
  expected_source jsonb;
  existing_source jsonb;
BEGIN
  FOR candidate IN
    SELECT bad_case.*
    FROM public."ai_evaluation_bad_cases" bad_case
    WHERE bad_case."source_type" = 'ANSWER_FEEDBACK'
    ORDER BY bad_case."tenant_id", bad_case."id"
  LOOP
    expected_source := public.ai_evaluation_derive_answer_feedback_source(
      candidate."tenant_id",
      candidate."source_id",
      candidate."reported_by_user_id"
    );
    IF candidate."source_version" <> 1
       OR btrim(candidate."source_snapshot_hash") IS DISTINCT FROM
         expected_source ->> 'sourceSnapshotHash'
       OR btrim(candidate."request_hash") IS DISTINCT FROM
         expected_source ->> 'sourceSnapshotHash'
       OR candidate."sanitized_input" IS DISTINCT FROM
         expected_source ->> 'sanitizedInput'
       OR candidate."category"::text IS DISTINCT FROM
         expected_source ->> 'category' THEN
      RAISE EXCEPTION
        'Legacy ANSWER_FEEDBACK Bad Case % cannot be upgraded without changing evidence.',
        candidate."id"
        USING ERRCODE = '23514',
              CONSTRAINT = 'ai_evaluation_answer_feedback_legacy_mismatch';
    END IF;

    SELECT to_jsonb(source)
    INTO existing_source
    FROM public."ai_evaluation_answer_feedback_sources" source
    WHERE source."tenant_id" = candidate."tenant_id"
      AND source."bad_case_id" = candidate."id";

    IF existing_source IS NULL THEN
      INSERT INTO public."ai_evaluation_answer_feedback_sources" (
        "tenant_id", "bad_case_id", "feedback_id", "conversation_id",
        "message_id", "input_message_id", "agent_run_id", "agent_id",
        "agent_version_id", "reported_by_user_id", "feedback_reason",
        "feedback_recorded_at", "prompt_snapshot_hash", "answer_snapshot_hash",
        "citations_snapshot_hash", "citations", "source_snapshot_hash"
      ) VALUES (
        candidate."tenant_id",
        candidate."id",
        (expected_source ->> 'feedbackId')::uuid,
        (expected_source ->> 'conversationId')::uuid,
        (expected_source ->> 'messageId')::uuid,
        (expected_source ->> 'inputMessageId')::uuid,
        (expected_source ->> 'agentRunId')::uuid,
        (expected_source ->> 'agentId')::uuid,
        (expected_source ->> 'agentVersionId')::uuid,
        (expected_source ->> 'reportedByUserId')::uuid,
        (expected_source ->> 'feedbackReason')::public."AnswerFeedbackReason",
        (expected_source ->> 'feedbackRecordedAt')::timestamptz,
        expected_source ->> 'promptSnapshotHash',
        expected_source ->> 'answerSnapshotHash',
        expected_source ->> 'citationsSnapshotHash',
        expected_source -> 'citations',
        expected_source ->> 'sourceSnapshotHash'
      );
    ELSIF existing_source ->> 'feedback_id' IS DISTINCT FROM
          expected_source ->> 'feedbackId'
       OR existing_source ->> 'conversation_id' IS DISTINCT FROM
          expected_source ->> 'conversationId'
       OR existing_source ->> 'message_id' IS DISTINCT FROM
          expected_source ->> 'messageId'
       OR existing_source ->> 'input_message_id' IS DISTINCT FROM
          expected_source ->> 'inputMessageId'
       OR existing_source ->> 'agent_run_id' IS DISTINCT FROM
          expected_source ->> 'agentRunId'
       OR existing_source ->> 'agent_id' IS DISTINCT FROM
          expected_source ->> 'agentId'
       OR existing_source ->> 'agent_version_id' IS DISTINCT FROM
          expected_source ->> 'agentVersionId'
       OR existing_source ->> 'reported_by_user_id' IS DISTINCT FROM
          expected_source ->> 'reportedByUserId'
       OR existing_source ->> 'feedback_reason' IS DISTINCT FROM
          expected_source ->> 'feedbackReason'
       OR (existing_source ->> 'feedback_recorded_at')::timestamptz
          IS DISTINCT FROM
          (expected_source ->> 'feedbackRecordedAt')::timestamptz
       OR btrim(existing_source ->> 'prompt_snapshot_hash') IS DISTINCT FROM
          expected_source ->> 'promptSnapshotHash'
       OR btrim(existing_source ->> 'answer_snapshot_hash') IS DISTINCT FROM
          expected_source ->> 'answerSnapshotHash'
       OR btrim(existing_source ->> 'citations_snapshot_hash') IS DISTINCT FROM
          expected_source ->> 'citationsSnapshotHash'
       OR existing_source -> 'citations' IS DISTINCT FROM
          expected_source -> 'citations'
       OR btrim(existing_source ->> 'source_snapshot_hash') IS DISTINCT FROM
          expected_source ->> 'sourceSnapshotHash' THEN
      RAISE EXCEPTION
        'Existing answer-feedback source for Bad Case % fails trusted recomputation.',
        candidate."id"
        USING ERRCODE = '23514',
              CONSTRAINT = 'ai_evaluation_answer_feedback_existing_source_mismatch';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public."ai_evaluation_bad_cases" bad_case
    LEFT JOIN public."ai_evaluation_answer_feedback_sources" source
      ON source."tenant_id" = bad_case."tenant_id"
     AND source."bad_case_id" = bad_case."id"
    WHERE bad_case."source_type" = 'ANSWER_FEEDBACK'
      AND source."bad_case_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'ANSWER_FEEDBACK Bad Case upgrade left an untrusted orphan.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'ai_evaluation_answer_feedback_upgrade_incomplete';
  END IF;
END
$upgrade$;

-- The source ledger is append-only. Administrators may inspect it; only the
-- projector identity may append a row, and neither identity can mutate or
-- delete a recorded snapshot.
DROP POLICY IF EXISTS "ai_evaluation_feedback_projector_access"
  ON public."ai_evaluation_answer_feedback_sources";
CREATE POLICY "ai_evaluation_feedback_projector_read"
  ON public."ai_evaluation_answer_feedback_sources"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_feedback_projector
  USING (true);
CREATE POLICY "ai_evaluation_feedback_projector_insert"
  ON public."ai_evaluation_answer_feedback_sources"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_feedback_projector
  WITH CHECK (true);
ALTER POLICY "ai_evaluation_tenant_isolation"
  ON public."ai_evaluation_answer_feedback_sources"
  TO enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_evaluation_runner, enterprise_agent_feedback_projector;

REVOKE ALL ON TABLE public."ai_evaluation_answer_feedback_sources"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_evaluation_runner, enterprise_agent_feedback_projector;
GRANT SELECT ON TABLE public."ai_evaluation_answer_feedback_sources"
  TO enterprise_agent_admin;
GRANT SELECT, INSERT ON TABLE public."ai_evaluation_answer_feedback_sources"
  TO enterprise_agent_feedback_projector;
REVOKE UPDATE, DELETE ON TABLE public."ai_evaluation_answer_feedback_sources"
  FROM enterprise_agent_admin, enterprise_agent_feedback_projector;

ALTER FUNCTION public.ai_evaluation_sanitize_feedback_input(text)
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.ai_evaluation_derive_answer_feedback_source(uuid, uuid, uuid)
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.ai_evaluation_answer_feedback_source_guard()
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.ai_evaluation_answer_feedback_pair_guard()
  OWNER TO enterprise_agent_feedback_projector;
ALTER FUNCTION public.project_not_helpful_answer_feedback_bad_case(uuid)
  OWNER TO enterprise_agent_feedback_projector;

REVOKE ALL ON FUNCTION public.ai_evaluation_sanitize_feedback_input(text)
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_auth, enterprise_agent_evaluation_runner;
REVOKE ALL ON FUNCTION
  public.ai_evaluation_derive_answer_feedback_source(uuid, uuid, uuid)
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_auth, enterprise_agent_evaluation_runner;
REVOKE ALL ON FUNCTION public.ai_evaluation_answer_feedback_source_guard()
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_auth, enterprise_agent_evaluation_runner;
REVOKE ALL ON FUNCTION public.ai_evaluation_answer_feedback_pair_guard()
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_auth, enterprise_agent_evaluation_runner;
REVOKE ALL ON FUNCTION public.project_not_helpful_answer_feedback_bad_case(uuid)
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
    enterprise_agent_auth, enterprise_agent_evaluation_runner;
GRANT EXECUTE ON FUNCTION
  public.project_not_helpful_answer_feedback_bad_case(uuid)
  TO enterprise_agent_app, enterprise_agent_admin;

COMMIT;
