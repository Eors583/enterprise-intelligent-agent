-- A provider receipt may omit cost metering. Migration 008 preserves that as
-- UNATTESTED, while the FinOps projector independently calculates the amount
-- from an approved immutable Price Snapshot. Admit that narrowly-scoped
-- TRUSTED_SYSTEM projection without weakening Agent Run attestation.
BEGIN;

-- Cost Entries are append-only, so a plain snapshot read is sufficient here.
-- SELECT ... FOR SHARE would require the independent reviewer role to hold
-- UPDATE on the immutable ledger, defeating the exact ACL boundary.
CREATE OR REPLACE FUNCTION public.finops_prepare_cost_verification_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  cost_entry public."finops_cost_entries"%ROWTYPE;
  source_evidence public."evidence"%ROWTYPE;
  actor_user_id UUID;
BEGIN
  actor_user_id := NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF actor_user_id IS NULL OR actor_user_id <> NEW."reviewer_user_id" THEN
    RAISE EXCEPTION 'Cost verification reviewer must match the authenticated actor'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."tenant_id"::text || ':finops-cost-review:' || NEW."cost_entry_id"::text,
      0
    )
  );

  SELECT *
  INTO cost_entry
  FROM public."finops_cost_entries" cost
  WHERE cost."tenant_id" = NEW."tenant_id"
    AND cost."id" = NEW."cost_entry_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cost verification requires a same-tenant Cost Entry'
      USING ERRCODE = '23503';
  END IF;
  IF cost_entry."recorded_by_user_id" = NEW."reviewer_user_id" THEN
    RAISE EXCEPTION 'Cost verification requires an independent maker-checker reviewer'
      USING ERRCODE = '23514';
  END IF;

  NEW."revision" := (
    SELECT coalesce(max(review."revision"), 0) + 1
    FROM public."finops_cost_verification_reviews" review
    WHERE review."tenant_id" = NEW."tenant_id"
      AND review."cost_entry_id" = NEW."cost_entry_id"
  );
  NEW."created_at" := CURRENT_TIMESTAMP;
  NEW."comment" := btrim(NEW."comment");

  IF NEW."decision" = 'PENDING' THEN
    RAISE EXCEPTION 'Cost verification reviews must record a terminal review decision'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."basis" = 'TRUSTED_SOURCE' THEN
    IF NEW."decision" <> 'VERIFIED'
      OR cost_entry."source_authority" NOT IN (
        'RUNTIME_ATTESTED',
        'PROVIDER_BILL',
        'TRUSTED_SYSTEM'
      )
    THEN
      RAISE EXCEPTION 'Trusted-source verification requires an immutable trusted source authority'
        USING ERRCODE = '23514';
    END IF;
    NEW."evidence_content_hash" := NULL;
  ELSIF NEW."basis" = 'TRUSTED_EVIDENCE' THEN
    IF NEW."evidence_id" IS NULL OR NEW."evidence_version" IS NULL THEN
      RAISE EXCEPTION 'Trusted-evidence verification requires an Evidence id and version'
        USING ERRCODE = '23514';
    END IF;
    SELECT *
    INTO source_evidence
    FROM public."evidence" evidence
    WHERE evidence."tenant_id" = NEW."tenant_id"
      AND evidence."id" = NEW."evidence_id"
      AND evidence."version" = NEW."evidence_version"
    FOR SHARE;
    IF NOT FOUND
      OR source_evidence."status" <> 'ACTIVE'
      OR source_evidence."trust_level" <> 'VERIFIED'
      OR source_evidence."verified_at" IS NULL
      OR source_evidence."activated_at" IS NULL
      OR source_evidence."revoked_at" IS NOT NULL
      OR source_evidence."effective_from" > NEW."created_at"
      OR (
        source_evidence."effective_to" IS NOT NULL
        AND source_evidence."effective_to" <= NEW."created_at"
      )
    THEN
      RAISE EXCEPTION 'Cost verification Evidence must be active, verified, and currently effective'
        USING ERRCODE = '23514';
    END IF;
    NEW."evidence_content_hash" := source_evidence."content_hash";
  ELSIF NEW."basis" = 'REVIEWER_JUDGMENT' THEN
    IF NEW."decision" NOT IN ('DISPUTED', 'REJECTED') THEN
      RAISE EXCEPTION 'Reviewer judgment cannot promote a cost to verified ledger truth'
        USING ERRCODE = '23514';
    END IF;
    NEW."evidence_content_hash" := NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported cost verification basis'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP POLICY "finops_projector_cost_insert"
  ON public."finops_cost_entries";

CREATE POLICY "finops_projector_cost_insert"
  ON public."finops_cost_entries"
  AS PERMISSIVE
  FOR INSERT
  TO enterprise_agent_finops_projector
  WITH CHECK (
    "verification_status" = 'VERIFIED'
    AND "idempotency_key" LIKE 'auto-finops:%'
    AND (
      (
        "source_system" = 'agent-runtime'
        AND "source_authority" = 'RUNTIME_ATTESTED'
        AND "agent_run_id" IS NOT NULL
        AND "tool_invocation_id" IS NULL
      )
      OR (
        "source_system" = 'tool-gateway'
        AND "source_authority" IN ('RUNTIME_ATTESTED', 'TRUSTED_SYSTEM')
        AND "agent_run_id" IS NULL
        AND "tool_invocation_id" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public."tool_execution_receipts" receipt
          WHERE receipt."tenant_id" = "finops_cost_entries"."tenant_id"
            AND receipt."id"::text = "finops_cost_entries"."source_record_id"
            AND receipt."tool_invocation_id"
              = "finops_cost_entries"."tool_invocation_id"
            AND (
              (
                "finops_cost_entries"."source_authority" = 'TRUSTED_SYSTEM'
                AND receipt."cost_attestation" = 'UNATTESTED'
              )
              OR (
                "finops_cost_entries"."source_authority" = 'RUNTIME_ATTESTED'
                AND receipt."cost_attestation" IN (
                  'PROVIDER_ATTESTED',
                  'GATEWAY_ATTESTED'
                )
              )
            )
        )
      )
    )
  );

COMMIT;
