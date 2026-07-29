-- Persist a privacy-safe grounding metric on the Agent Run ledger. The admin
-- overview can aggregate citation coverage without receiving SELECT access to
-- message bodies.
ALTER TABLE public."agent_runs"
  ADD COLUMN "grounded_citation_count" integer NOT NULL DEFAULT 0;

UPDATE public."agent_runs" run
SET "grounded_citation_count" = LEAST(
  12,
  CASE
    WHEN jsonb_typeof(output."content" -> 'citations') = 'array'
      THEN jsonb_array_length(output."content" -> 'citations')
    ELSE 0
  END
)
FROM public."messages" output
WHERE output."tenant_id" = run."tenant_id"
  AND output."id" = run."output_message_id"
  AND run."status" = 'SUCCEEDED';

ALTER TABLE public."agent_runs"
  ADD CONSTRAINT "agent_runs_grounded_citation_count_check"
  CHECK (
    "grounded_citation_count" >= 0
    AND "grounded_citation_count" <= 12
  );
