BEGIN;

CREATE TYPE public."FinopsCostVerificationBasis" AS ENUM (
  'TRUSTED_EVIDENCE',
  'TRUSTED_SOURCE',
  'REVIEWER_JUDGMENT'
);

CREATE TABLE public."finops_cost_verification_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "cost_entry_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "decision" public."FinopsVerificationStatus" NOT NULL,
  "basis" public."FinopsCostVerificationBasis" NOT NULL,
  "reviewer_user_id" UUID NOT NULL,
  "evidence_id" UUID,
  "evidence_version" INTEGER,
  "evidence_content_hash" CHAR(64),
  "comment" VARCHAR(1000) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finops_cost_verification_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finops_cost_verification_reviews_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "finops_cost_verification_reviews_cost_revision_key"
    UNIQUE ("tenant_id", "cost_entry_id", "revision"),
  CONSTRAINT "finops_cost_verification_reviews_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "finops_cost_verification_reviews_values_check" CHECK (
    "revision" > 0
    AND "decision" <> 'PENDING'
    AND length(btrim("comment")) BETWEEN 1 AND 1000
    AND "request_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "finops_cost_verification_reviews_evidence_triplet_check" CHECK (
    ("evidence_id" IS NULL) = ("evidence_version" IS NULL)
    AND ("evidence_id" IS NULL) = ("evidence_content_hash" IS NULL)
  ),
  CONSTRAINT "finops_cost_verification_reviews_basis_check" CHECK (
    (
      "basis" = 'TRUSTED_EVIDENCE'
      AND "evidence_id" IS NOT NULL
    )
    OR (
      "basis" = 'TRUSTED_SOURCE'
      AND "decision" = 'VERIFIED'
      AND "evidence_id" IS NULL
    )
    OR (
      "basis" = 'REVIEWER_JUDGMENT'
      AND "decision" IN ('DISPUTED', 'REJECTED')
      AND "evidence_id" IS NULL
    )
  ),
  CONSTRAINT "finops_cost_verification_reviews_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "finops_cost_verification_reviews_cost_fkey"
    FOREIGN KEY ("tenant_id", "cost_entry_id")
    REFERENCES public."finops_cost_entries"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "finops_cost_verification_reviews_reviewer_fkey"
    FOREIGN KEY ("tenant_id", "reviewer_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "finops_cost_verification_reviews_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "finops_cost_verification_reviews_cost_idx"
  ON public."finops_cost_verification_reviews"(
    "tenant_id", "cost_entry_id", "revision" DESC
  );
CREATE INDEX "finops_cost_verification_reviews_reviewer_idx"
  ON public."finops_cost_verification_reviews"(
    "tenant_id", "reviewer_user_id", "created_at" DESC
  );

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
    AND cost."id" = NEW."cost_entry_id"
  FOR SHARE;

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

CREATE TRIGGER "finops_prepare_cost_verification_review_trigger"
  BEFORE INSERT ON public."finops_cost_verification_reviews"
  FOR EACH ROW EXECUTE FUNCTION public.finops_prepare_cost_verification_review();

CREATE TRIGGER "finops_cost_verification_reviews_append_only"
  BEFORE UPDATE OR DELETE ON public."finops_cost_verification_reviews"
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();

ALTER TABLE public."finops_cost_verification_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."finops_cost_verification_reviews" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation"
  ON public."finops_cost_verification_reviews"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY "enterprise_agent_admin_access"
  ON public."finops_cost_verification_reviews"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_admin
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public."finops_cost_verification_reviews"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin;
GRANT SELECT, INSERT ON TABLE public."finops_cost_verification_reviews"
  TO enterprise_agent_admin;

CREATE OR REPLACE VIEW public."finops_effective_cost_verifications"
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  cost."tenant_id",
  cost."id" AS "cost_entry_id",
  cost."verification_status" AS "original_verification_status",
  CASE
    WHEN review."id" IS NULL THEN cost."verification_status"
    WHEN review."decision" IN ('DISPUTED', 'REJECTED') THEN review."decision"
    WHEN review."decision" = 'VERIFIED'
      AND review."basis" = 'TRUSTED_SOURCE'
      AND cost."source_authority" IN (
        'RUNTIME_ATTESTED',
        'PROVIDER_BILL',
        'TRUSTED_SYSTEM'
      )
      THEN 'VERIFIED'::public."FinopsVerificationStatus"
    WHEN review."decision" = 'VERIFIED'
      AND review."basis" = 'TRUSTED_EVIDENCE'
      AND evidence."status" = 'ACTIVE'
      AND evidence."trust_level" = 'VERIFIED'
      AND evidence."verified_at" IS NOT NULL
      AND evidence."activated_at" IS NOT NULL
      AND evidence."revoked_at" IS NULL
      AND evidence."effective_from" <= CURRENT_TIMESTAMP
      AND (
        evidence."effective_to" IS NULL
        OR evidence."effective_to" > CURRENT_TIMESTAMP
      )
      AND evidence."content_hash" = review."evidence_content_hash"
      THEN 'VERIFIED'::public."FinopsVerificationStatus"
    ELSE 'DISPUTED'::public."FinopsVerificationStatus"
  END AS "effective_verification_status",
  review."id" AS "review_id",
  review."revision" AS "review_revision",
  review."decision" AS "review_decision",
  review."basis" AS "review_basis",
  review."reviewer_user_id",
  review."evidence_id",
  review."evidence_version",
  review."evidence_content_hash",
  review."comment" AS "review_comment",
  review."created_at" AS "reviewed_at"
FROM public."finops_cost_entries" cost
LEFT JOIN LATERAL (
  SELECT candidate.*
  FROM public."finops_cost_verification_reviews" candidate
  WHERE candidate."tenant_id" = cost."tenant_id"
    AND candidate."cost_entry_id" = cost."id"
  ORDER BY candidate."revision" DESC
  LIMIT 1
) review ON true
LEFT JOIN public."evidence" evidence
  ON evidence."tenant_id" = review."tenant_id"
  AND evidence."id" = review."evidence_id"
  AND evidence."version" = review."evidence_version";

REVOKE ALL ON TABLE public."finops_effective_cost_verifications"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin;
GRANT SELECT ON TABLE public."finops_effective_cost_verifications"
  TO enterprise_agent_admin;

CREATE OR REPLACE FUNCTION public.finops_effective_cost_verification_status(
  requested_tenant_id UUID,
  requested_cost_entry_id UUID
)
RETURNS public."FinopsVerificationStatus"
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT state."effective_verification_status"
  FROM public."finops_effective_cost_verifications" state
  WHERE state."tenant_id" = requested_tenant_id
    AND state."cost_entry_id" = requested_cost_entry_id
$$;

CREATE OR REPLACE FUNCTION public.finops_budget_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  budget public."finops_budgets"%ROWTYPE;
  reservation public."finops_budget_events"%ROWTYPE;
  committed NUMERIC(30,12);
  observed NUMERIC(30,12);
  settled_amount NUMERIC(30,12);
  effective_verification public."FinopsVerificationStatus";
BEGIN
  SELECT * INTO budget
  FROM public."finops_budgets" b
  WHERE b."tenant_id" = NEW."tenant_id"
    AND b."id" = NEW."budget_id"
    AND b."version" = NEW."budget_version"
  FOR UPDATE;
  IF budget."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Budget events require an active approved Budget Version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."currency" <> budget."currency" THEN
    RAISE EXCEPTION 'Budget event currency must match its Budget Version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."created_at" < budget."period_start"
    OR NEW."created_at" >= budget."period_end"
  THEN
    RAISE EXCEPTION 'Budget event falls outside its immutable budget period'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."type" IN ('SETTLEMENT', 'RELEASE') THEN
    SELECT * INTO reservation
    FROM public."finops_budget_events" e
    WHERE e."tenant_id" = NEW."tenant_id"
      AND e."budget_id" = NEW."budget_id"
      AND e."id" = NEW."reservation_event_id"
      AND e."type" = 'RESERVATION';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Settlement or release must reference a same-budget reservation'
        USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(e."amount"), 0) INTO settled_amount
    FROM public."finops_budget_events" e
    WHERE e."tenant_id" = NEW."tenant_id"
      AND e."budget_id" = NEW."budget_id"
      AND e."reservation_event_id" = NEW."reservation_event_id"
      AND e."type" IN ('SETTLEMENT', 'RELEASE');
    IF settled_amount + NEW."amount" > reservation."amount" THEN
      RAISE EXCEPTION 'Settlement and release total cannot exceed the reservation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."type" = 'SETTLEMENT' THEN
    SELECT
      cost."calculated_amount",
      public.finops_effective_cost_verification_status(cost."tenant_id", cost."id")
    INTO settled_amount, effective_verification
    FROM public."finops_cost_entries" cost
    WHERE cost."tenant_id" = NEW."tenant_id"
      AND cost."id" = NEW."cost_entry_id";
    IF NOT FOUND OR settled_amount <> NEW."amount" THEN
      RAISE EXCEPTION 'Settlement amount must equal the immutable Cost Entry'
        USING ERRCODE = '23514';
    END IF;
    IF effective_verification <> 'VERIFIED' THEN
      RAISE EXCEPTION 'Settlement requires an effectively verified Cost Entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT coalesce(sum(
    CASE
      WHEN "type" = 'RESERVATION' THEN "amount"
      WHEN "type" IN ('SETTLEMENT', 'RELEASE') THEN -"amount"
      ELSE 0
    END
  ), 0) INTO committed
  FROM public."finops_budget_events" e
  WHERE e."tenant_id" = NEW."tenant_id"
    AND e."budget_id" = NEW."budget_id";
  SELECT coalesce(sum(
    CASE WHEN "type" IN ('SETTLEMENT', 'ADJUSTMENT') THEN "amount" ELSE 0 END
  ), 0) INTO observed
  FROM public."finops_budget_events" e
  WHERE e."tenant_id" = NEW."tenant_id"
    AND e."budget_id" = NEW."budget_id";
  IF NEW."type" = 'RESERVATION'
    AND observed + greatest(committed, 0) + NEW."amount" > budget."limit_amount"
  THEN
    RAISE EXCEPTION 'Budget reservation would exceed the active hard limit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.finops_budget_alert_projector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  budget public."finops_budgets"%ROWTYPE;
  observed NUMERIC(30,12);
  settled NUMERIC(30,12);
  outstanding NUMERIC(30,12);
  threshold NUMERIC(30,12);
BEGIN
  SELECT * INTO budget
  FROM public."finops_budgets" b
  WHERE b."tenant_id" = NEW."tenant_id"
    AND b."id" = NEW."budget_id"
    AND b."version" = NEW."budget_version";
  SELECT
    coalesce(sum(
      CASE WHEN "type" IN ('SETTLEMENT', 'ADJUSTMENT') THEN "amount" ELSE 0 END
    ), 0),
    coalesce(sum(
      CASE
        WHEN "type" = 'RESERVATION' THEN "amount"
        WHEN "type" IN ('SETTLEMENT', 'RELEASE') THEN -"amount"
        ELSE 0
      END
    ), 0)
  INTO settled, outstanding
  FROM public."finops_budget_events" e
  WHERE e."tenant_id" = NEW."tenant_id"
    AND e."budget_id" = NEW."budget_id";
  observed := settled + greatest(outstanding, 0);
  threshold := round(budget."limit_amount" * budget."alert_threshold_ratio", 12);
  IF observed >= threshold THEN
    INSERT INTO public."finops_budget_alerts"(
      "tenant_id", "budget_id", "budget_version", "budget_event_id", "type",
      "observed_amount", "threshold_amount", "message"
    ) VALUES (
      NEW."tenant_id", NEW."budget_id", NEW."budget_version", NEW."id",
      CASE WHEN observed > budget."limit_amount"
        THEN 'HARD_LIMIT_EXCEEDED'::public."FinopsBudgetAlertType"
        ELSE 'THRESHOLD_REACHED'::public."FinopsBudgetAlertType"
      END,
      observed,
      CASE WHEN observed > budget."limit_amount" THEN budget."limit_amount" ELSE threshold END,
      CASE WHEN observed > budget."limit_amount"
        THEN 'Actual settlement exceeds the active budget hard limit; policy remains unchanged.'
        ELSE 'Budget alert threshold reached.'
      END
    ) ON CONFLICT ("tenant_id", "budget_event_id", "type") DO NOTHING;
  END IF;
  IF NEW."type" = 'SETTLEMENT' AND NEW."amount" <> (
    SELECT "amount"
    FROM public."finops_budget_events"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."reservation_event_id"
  ) THEN
    INSERT INTO public."finops_budget_alerts"(
      "tenant_id", "budget_id", "budget_version", "budget_event_id", "type",
      "observed_amount", "threshold_amount", "message"
    ) VALUES (
      NEW."tenant_id", NEW."budget_id", NEW."budget_version", NEW."id",
      'SETTLEMENT_MISMATCH', NEW."amount",
      (
        SELECT "amount"
        FROM public."finops_budget_events"
        WHERE "tenant_id" = NEW."tenant_id"
          AND "id" = NEW."reservation_event_id"
      ),
      'Settlement differs from its immutable reservation.'
    ) ON CONFLICT ("tenant_id", "budget_event_id", "type") DO NOTHING;
  END IF;
  IF NEW."type" = 'SETTLEMENT'
    AND public.finops_effective_cost_verification_status(
      NEW."tenant_id",
      NEW."cost_entry_id"
    ) <> 'VERIFIED'
  THEN
    INSERT INTO public."finops_budget_alerts"(
      "tenant_id", "budget_id", "budget_version", "budget_event_id", "type",
      "observed_amount", "threshold_amount", "message"
    ) VALUES (
      NEW."tenant_id", NEW."budget_id", NEW."budget_version", NEW."id",
      'UNVERIFIED_COST', NEW."amount", 0,
      'Settlement references a cost that is not effectively verified ledger truth.'
    ) ON CONFLICT ("tenant_id", "budget_event_id", "type") DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.finops_cost_review_budget_alert_projector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.finops_effective_cost_verification_status(
    NEW."tenant_id",
    NEW."cost_entry_id"
  ) <> 'VERIFIED'
  THEN
    INSERT INTO public."finops_budget_alerts"(
      "tenant_id", "budget_id", "budget_version", "budget_event_id", "type",
      "observed_amount", "threshold_amount", "message"
    )
    SELECT
      event."tenant_id",
      event."budget_id",
      event."budget_version",
      event."id",
      'UNVERIFIED_COST',
      event."amount",
      0,
      'A later independent review invalidated the cost used by this settlement.'
    FROM public."finops_budget_events" event
    WHERE event."tenant_id" = NEW."tenant_id"
      AND event."cost_entry_id" = NEW."cost_entry_id"
      AND event."type" = 'SETTLEMENT'
    ON CONFLICT ("tenant_id", "budget_event_id", "type") DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "finops_cost_review_budget_alert_projector_trigger"
  AFTER INSERT ON public."finops_cost_verification_reviews"
  FOR EACH ROW EXECUTE FUNCTION public.finops_cost_review_budget_alert_projector();

REVOKE ALL ON TYPE public."FinopsCostVerificationBasis" FROM PUBLIC;
GRANT USAGE ON TYPE public."FinopsCostVerificationBasis" TO enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.finops_prepare_cost_verification_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_effective_cost_verification_status(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_cost_review_budget_alert_projector() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finops_effective_cost_verification_status(UUID, UUID)
  TO enterprise_agent_admin;

COMMIT;
