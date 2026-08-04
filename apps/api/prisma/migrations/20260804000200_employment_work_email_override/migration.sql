-- Preserve an administrator-supplied login email for directory-managed
-- employments instead of replacing it during later provider synchronizations.
ALTER TABLE public."employments"
  ADD COLUMN "work_email_overridden" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public."employments"."work_email_overridden" IS
  'True when work_email is a tenant-local override that directory sync must preserve.';

-- Snapshot the delivery address on one-time actions. Existing rows are
-- backfilled conservatively: for a directory member with one current work
-- email use that address, otherwise retain the canonical user email. New code
-- always supplies the exact target at issuance time.
ALTER TABLE public."auth_action_tokens"
  ADD COLUMN "delivery_target_email" varchar(320),
  ADD COLUMN "delivery_target_evidence" varchar(24) NOT NULL DEFAULT 'LEGACY_INFERRED';

UPDATE public."auth_action_tokens" AS action
SET "delivery_target_email" = COALESCE(
  CASE
    WHEN action."purpose" = 'MEMBER_INVITATION' THEN (
      SELECT min(lower(trim(employment."work_email")))
      FROM public."employments" AS employment
      WHERE employment."tenant_id" = action."tenant_id"
        AND employment."user_id" = action."user_id"
        AND employment."status" <> 'TERMINATED'
        AND employment."work_email" IS NOT NULL
      HAVING count(DISTINCT lower(trim(employment."work_email"))) = 1
    )
    ELSE NULL
  END,
  user_account."email"
)
FROM public."users" AS user_account
WHERE user_account."tenant_id" = action."tenant_id"
  AND user_account."id" = action."user_id";

ALTER TABLE public."auth_action_tokens"
  ALTER COLUMN "delivery_target_email" SET NOT NULL,
  ALTER COLUMN "delivery_target_evidence" SET DEFAULT 'ISSUED',
  ADD CONSTRAINT "auth_action_tokens_delivery_target_evidence_check"
    CHECK ("delivery_target_evidence" IN ('ISSUED', 'LEGACY_INFERRED'));

COMMENT ON COLUMN public."auth_action_tokens"."delivery_target_email" IS
  'Immutable delivery target. See delivery_target_evidence before treating a migrated value as historical proof.';

COMMENT ON COLUMN public."auth_action_tokens"."delivery_target_evidence" IS
  'ISSUED is exact issuance evidence; LEGACY_INFERRED is a migration-time reconstruction.';

CREATE FUNCTION public."enforce_auth_action_token_delivery_target_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."delivery_target_email" IS DISTINCT FROM OLD."delivery_target_email"
     OR NEW."delivery_target_evidence" IS DISTINCT FROM OLD."delivery_target_evidence" THEN
    RAISE EXCEPTION 'auth action token delivery target is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public."enforce_auth_action_token_delivery_target_immutable"() FROM PUBLIC;

CREATE TRIGGER "auth_action_tokens_delivery_target_immutable"
BEFORE UPDATE OF "delivery_target_email", "delivery_target_evidence"
ON public."auth_action_tokens"
FOR EACH ROW
EXECUTE FUNCTION public."enforce_auth_action_token_delivery_target_immutable"();
