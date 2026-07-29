BEGIN;

-- This migration is intentionally additive. The 005/006 foundation migrations
-- may already be present in long-lived databases, so fresh-install source
-- hardening alone is not sufficient to protect an upgraded deployment.

-- Serialize participant identity at the database boundary. The immutable
-- Role Assignment ID is not a unique human/Agent identity: two concurrent
-- assignments can resolve to the same user or Agent.
CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_participants_active_user_key"
  ON public."collaboration_participants"(
    "tenant_id", "collaboration_id", "user_id"
  )
  WHERE "active";

CREATE UNIQUE INDEX IF NOT EXISTS "collaboration_participants_active_agent_key"
  ON public."collaboration_participants"(
    "tenant_id", "collaboration_id", "agent_id"
  )
  WHERE "active" AND "agent_id" IS NOT NULL;

-- New Corrections must nominate at least one independently validated reviewer.
-- This supplemental trigger also protects databases that installed the older
-- foundation guard before the reviewer requirement was tightened.
CREATE OR REPLACE FUNCTION public.guard_correction_case_reviewer_liveness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF jsonb_typeof(NEW."required_role_assignment_ids") IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW."required_role_assignment_ids") = 0 THEN
    RAISE EXCEPTION 'A Correction case requires an independent human reviewer.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_cases_reviewer_liveness_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "correction_cases_reviewer_liveness_trigger"
  BEFORE INSERT ON public."correction_cases"
  FOR EACH ROW EXECUTE FUNCTION public.guard_correction_case_reviewer_liveness();

-- Existing LOW/MEDIUM rows created under the old rule may legitimately have no
-- nominated reviewer and cannot be mutated to add one because their governance
-- snapshot is immutable. Preserve maker-checker separation while giving those
-- legacy rows a bounded terminal path: a different, currently trusted and
-- task-scoped actor may make the terminal decision, and evidence is mandatory.
CREATE OR REPLACE FUNCTION public.guard_correction_feedback_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  correction_record public."correction_cases"%ROWTYPE;
  subject_user_id uuid;
  actor_snapshot jsonb;
  actor_user uuid;
  next_status public."CorrectionStatus";
  evidence_valid_count integer;
  evidence_id_count integer;
  high_impact boolean;
  requires_evidence boolean;
  actor_is_subject boolean;
  actor_is_reviewer boolean;
  legacy_independent_reviewer boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."tenant_id"::text || ':correction:' || NEW."correction_case_id"::text,
      0
    )
  );
  SELECT *
    INTO correction_record
  FROM public."correction_cases"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
  FOR UPDATE;
  IF correction_record."id" IS NULL
     OR NEW."revision" <> correction_record."revision" + 1
     OR NEW."occurred_at" < correction_record."updated_at"
     OR NEW."occurred_at" > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Correction feedback revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'correction_feedback_revision_cas';
  END IF;
  SELECT "user_id"
    INTO subject_user_id
  FROM public."role_assignments"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = correction_record."role_assignment_id";
  actor_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."actor_role_assignment_id",
    correction_record."permission_labels",
    CURRENT_TIMESTAMP,
    correction_record."task_id",
    'business.task.execute'
  );
  actor_user := (actor_snapshot->>'userId')::uuid;
  IF actor_snapshot IS NULL OR actor_user <> NEW."actor_user_id" THEN
    RAISE EXCEPTION 'Correction feedback actor is not a trusted active Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_actor_check';
  END IF;

  next_status := CASE
    WHEN NEW."action" = 'ACKNOWLEDGE' AND correction_record."status" = 'OPEN'
      THEN 'ACKNOWLEDGED'
    WHEN NEW."action" = 'ACCEPT' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'ACCEPTED'
    WHEN NEW."action" = 'REJECT' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'REJECTED'
    WHEN NEW."action" = 'EXPLAIN' AND correction_record."status" IN ('OPEN', 'ACKNOWLEDGED')
      THEN 'EXPLAINED'
    WHEN NEW."action" = 'ESCALATE' AND correction_record."status" NOT IN (
      'RESOLVED', 'CANCELLED'
    ) THEN 'ESCALATED'
    WHEN NEW."action" = 'RESOLVE'
      AND (
        correction_record."status" IN (
          'ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED'
        )
        OR (
          correction_record."severity" = 'LOW'
          AND correction_record."status" = 'OPEN'
        )
      ) THEN 'RESOLVED'
    WHEN NEW."action" = 'CANCEL' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
    ) THEN 'CANCELLED'
    ELSE NULL
  END;
  IF next_status IS NULL THEN
    RAISE EXCEPTION 'Invalid Correction feedback transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_transition_check';
  END IF;

  actor_is_subject :=
    NEW."actor_role_assignment_id" = correction_record."role_assignment_id";
  actor_is_reviewer :=
    correction_record."required_role_assignment_ids"
      ? NEW."actor_role_assignment_id"::text;
  high_impact :=
    correction_record."severity" IN ('HIGH', 'CRITICAL')
    OR correction_record."category" = 'CAPABILITY_RISK';
  legacy_independent_reviewer :=
    jsonb_array_length(correction_record."required_role_assignment_ids") = 0
    AND NOT high_impact
    AND NOT actor_is_subject
    AND actor_user IS DISTINCT FROM subject_user_id
    AND NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL');

  IF (
    NEW."action" IN ('ACKNOWLEDGE', 'REJECT', 'EXPLAIN', 'ESCALATE')
    AND NOT actor_is_subject
    AND NOT actor_is_reviewer
  ) OR (
    NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL')
    AND NOT actor_is_reviewer
    AND NOT legacy_independent_reviewer
  ) THEN
    RAISE EXCEPTION 'Correction feedback actor does not hold the required subject or review role.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_actor_role_check';
  END IF;

  requires_evidence :=
    NEW."action" IN ('REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE')
    OR legacy_independent_reviewer
    OR (
      high_impact
      AND NEW."action" IN ('ACCEPT', 'CANCEL')
    );
  IF requires_evidence AND jsonb_array_length(NEW."evidence_ids") = 0 THEN
    RAISE EXCEPTION 'This Correction feedback action requires trusted evidence.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_required';
  END IF;
  IF high_impact AND NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL') THEN
    IF actor_user = subject_user_id
       OR NOT correction_record."required_role_assignment_ids"
         ? NEW."actor_role_assignment_id"::text
       OR NOT actor_is_reviewer THEN
      RAISE EXCEPTION 'A high-impact terminal correction decision requires an independent reviewer and evidence.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'correction_feedback_independent_review_check';
    END IF;
  END IF;
  IF jsonb_array_length(NEW."evidence_ids") > 0 THEN
    SELECT count(DISTINCT value)
      INTO evidence_id_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value);
    IF evidence_id_count <> jsonb_array_length(NEW."evidence_ids") THEN
      RAISE EXCEPTION 'Correction feedback Evidence IDs must be unique.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_unique';
    END IF;
    SELECT count(DISTINCT evidence."id"::text)
      INTO evidence_valid_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value)
    JOIN public."evidence" evidence
      ON evidence."tenant_id" = NEW."tenant_id"
     AND evidence."id" = item.value::uuid
     AND evidence."status" = 'ACTIVE'
     AND evidence."verified_at" IS NOT NULL
     AND evidence."effective_from" <= CURRENT_TIMESTAMP
     AND (evidence."effective_to" IS NULL OR evidence."effective_to" > CURRENT_TIMESTAMP)
    WHERE EXISTS (
      SELECT 1
      FROM public."correction_case_evidence" case_evidence
      WHERE case_evidence."tenant_id" = NEW."tenant_id"
        AND case_evidence."correction_case_id" = NEW."correction_case_id"
        AND case_evidence."evidence_id" = evidence."id"
        AND case_evidence."evidence_version" = evidence."version"
        AND case_evidence."content_hash" = evidence."content_hash"
    );
    IF evidence_valid_count <> evidence_id_count THEN
      RAISE EXCEPTION 'Correction feedback evidence must be active, sealed, and linked to the case.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_check';
    END IF;
  END IF;

  UPDATE public."correction_cases"
  SET "status" = next_status,
      "revision" = NEW."revision",
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
    AND "revision" = correction_record."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'correction_cases_revision_cas';
  END IF;
  RETURN NEW;
END
$$;

-- A dead-letter replay is a human governance action, not merely a legal status
-- transition. Bind the attribution to the active tenant/session caller, require
-- an active tenant administrator, and bound the replay timestamp.
CREATE OR REPLACE FUNCTION public.guard_event_delivery_replay_attribution_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_tenant_id uuid :=
    nullif(current_setting('app.tenant_id', true), '')::uuid;
  session_user_id uuid :=
    nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF NOT (
    OLD."status" = 'DEAD_LETTERED'
    AND NEW."status" = 'PENDING'
  ) THEN
    IF (
      NEW."replay_count",
      NEW."replayed_at",
      NEW."replayed_by_user_id",
      NEW."replay_reason"
    ) IS DISTINCT FROM (
      OLD."replay_count",
      OLD."replayed_at",
      OLD."replayed_by_user_id",
      OLD."replay_reason"
    ) THEN
      RAISE EXCEPTION 'Replay attribution may change only during a dead-letter replay.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'business_event_deliveries_replay_attribution_v2_check';
    END IF;
    RETURN NEW;
  END IF;

  IF session_tenant_id IS NULL
     OR session_user_id IS NULL
     OR NEW."tenant_id" IS DISTINCT FROM session_tenant_id
     OR NEW."replayed_by_user_id" IS DISTINCT FROM session_user_id
     OR NEW."replay_count" <> OLD."replay_count" + 1
     OR NEW."replayed_at" IS NULL
     OR NEW."replayed_at" NOT BETWEEN
       statement_timestamp() - interval '5 minutes'
       AND statement_timestamp() + interval '1 minute'
     OR NEW."available_at" IS DISTINCT FROM NEW."replayed_at"
     OR NEW."replay_reason" IS NULL
     OR btrim(NEW."replay_reason") = ''
     OR NOT EXISTS (
       SELECT 1
       FROM public."users" replay_actor
       WHERE replay_actor."tenant_id" = NEW."tenant_id"
         AND replay_actor."id" = session_user_id
         AND replay_actor."status" = 'ACTIVE'
         AND replay_actor."role" IN ('OWNER', 'ADMIN')
     ) THEN
    RAISE EXCEPTION 'Dead-letter replay attribution requires the active tenant administrator.'
      USING ERRCODE = '42501',
            CONSTRAINT = 'business_event_deliveries_replay_actor_v2_check';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "business_event_deliveries_replay_attribution_v2_trigger"
  BEFORE UPDATE ON public."business_event_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_delivery_replay_attribution_v2();

REVOKE ALL ON FUNCTION public.guard_correction_case_reviewer_liveness()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_correction_feedback_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_event_delivery_replay_attribution_v2()
  FROM PUBLIC;

COMMIT;
