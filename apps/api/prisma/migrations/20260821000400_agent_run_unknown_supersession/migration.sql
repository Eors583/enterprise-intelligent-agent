-- UNKNOWN remains immutable evidence, but a newer user question may supersede
-- its conversational position so one uncertain provider result cannot freeze
-- an enterprise conversation or consume local execution capacity indefinitely.
ALTER TABLE public."agent_runs"
  ADD COLUMN "superseded_by_run_id" UUID,
  ADD COLUMN "superseded_at" TIMESTAMPTZ(6);

ALTER TABLE public."agent_runs"
  ADD CONSTRAINT "agent_runs_superseded_pair_check"
  CHECK (("superseded_by_run_id" IS NULL) = ("superseded_at" IS NULL)),
  ADD CONSTRAINT "agent_runs_superseded_not_self_check"
  CHECK ("superseded_by_run_id" IS NULL OR "superseded_by_run_id" <> "id"),
  ADD CONSTRAINT "agent_runs_superseded_by_fkey"
  FOREIGN KEY ("tenant_id", "superseded_by_run_id")
  REFERENCES public."agent_runs" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "agent_runs_tenant_superseded_by_idx"
  ON public."agent_runs" ("tenant_id", "superseded_by_run_id");

GRANT SELECT ("superseded_by_run_id")
  ON TABLE public."agent_runs" TO enterprise_agent_outbox;

-- Forward-repair already frozen development/upgrade data by binding each
-- unresolved UNKNOWN to the earliest newer Run in the same conversation.
-- The UNKNOWN fact is preserved; only its scheduling ownership changes.
WITH supersessions AS (
  SELECT
    uncertain."tenant_id",
    uncertain."id" AS uncertain_run_id,
    successor."id" AS successor_run_id,
    successor."created_at" AS superseded_at
  FROM public."agent_runs" AS uncertain
  CROSS JOIN LATERAL (
    SELECT later."id", later."created_at"
    FROM public."agent_runs" AS later
    WHERE later."tenant_id" = uncertain."tenant_id"
      AND later."conversation_id" = uncertain."conversation_id"
      AND (
        later."conversation_sequence" > uncertain."conversation_sequence"
        OR (
          later."conversation_sequence" = uncertain."conversation_sequence"
          AND later."turn_index" > uncertain."turn_index"
        )
      )
    ORDER BY later."conversation_sequence", later."turn_index", later."id"
    LIMIT 1
  ) AS successor
  WHERE uncertain."status" = 'UNKNOWN'::public."AgentRunStatus"
    AND uncertain."superseded_by_run_id" IS NULL
), audited AS (
  INSERT INTO public."audit_events" (
    "id",
    "tenant_id",
    "actor_type",
    "actor_id",
    "action",
    "resource_type",
    "resource_id",
    "metadata",
    "occurred_at"
  )
  SELECT
    gen_random_uuid(),
    supersessions."tenant_id",
    'SERVICE'::public."AuditActorType",
    supersessions."successor_run_id",
    'agent.run.unknown_superseded_by_new_question',
    'agent_run',
    supersessions."uncertain_run_id",
    jsonb_build_object(
      'supersededByRunId', supersessions."successor_run_id",
      'source', 'forward_migration'
    ),
    clock_timestamp()
  FROM supersessions
  RETURNING "resource_id"
)
UPDATE public."agent_runs" AS uncertain
SET
  "superseded_by_run_id" = supersessions."successor_run_id",
  "superseded_at" = supersessions."superseded_at",
  "updated_at" = clock_timestamp(),
  "version" = uncertain."version" + 1
FROM supersessions
WHERE uncertain."tenant_id" = supersessions."tenant_id"
  AND uncertain."id" = supersessions."uncertain_run_id"
  AND EXISTS (
    SELECT 1
    FROM audited
    WHERE audited."resource_id" = uncertain."id"
  );

COMMENT ON COLUMN public."agent_runs"."superseded_by_run_id" IS
  'A newer Run may take over conversation scheduling while this Run remains auditable and reconcilable.';
