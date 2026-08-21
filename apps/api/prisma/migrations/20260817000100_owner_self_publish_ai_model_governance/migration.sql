BEGIN;

ALTER TABLE public."ai_model_catalog_versions"
  DROP CONSTRAINT "ai_model_catalog_versions_workflow_check";

ALTER TABLE public."ai_model_catalog_versions"
  ADD CONSTRAINT "ai_model_catalog_versions_workflow_check" CHECK (
    (
      "status" = 'DRAFT'
      OR ("submitted_by_user_id" IS NOT NULL AND "submitted_at" IS NOT NULL)
    )
    AND (
      "status" NOT IN ('PUBLISHED', 'RETIRED')
      OR (
        "reviewed_by_user_id" IS NOT NULL
        AND "reviewed_at" IS NOT NULL
        AND "published_by_user_id" IS NOT NULL
        AND "published_at" IS NOT NULL
      )
    )
    AND ("status" = 'RETIRED') = ("retired_at" IS NOT NULL)
  );

ALTER TABLE public."ai_model_route_policy_versions"
  DROP CONSTRAINT "ai_model_route_policy_versions_workflow_check";

ALTER TABLE public."ai_model_route_policy_versions"
  ADD CONSTRAINT "ai_model_route_policy_versions_workflow_check" CHECK (
    (
      "status" = 'DRAFT'
      OR ("submitted_by_user_id" IS NOT NULL AND "submitted_at" IS NOT NULL)
    )
    AND (
      "status" NOT IN ('PUBLISHED', 'RETIRED')
      OR (
        "reviewed_by_user_id" IS NOT NULL
        AND "reviewed_at" IS NOT NULL
        AND "published_by_user_id" IS NOT NULL
        AND "published_at" IS NOT NULL
      )
    )
    AND ("status" = 'RETIRED') = ("retired_at" IS NOT NULL)
  );

COMMENT ON CONSTRAINT "ai_model_catalog_versions_workflow_check"
  ON public."ai_model_catalog_versions" IS
  'Requires complete review and publication evidence. Application policy permits an enterprise OWNER to self-publish while delegated ADMIN accounts retain maker-checker.';

COMMENT ON CONSTRAINT "ai_model_route_policy_versions_workflow_check"
  ON public."ai_model_route_policy_versions" IS
  'Requires complete review and publication evidence. Application policy permits an enterprise OWNER to self-publish while delegated ADMIN accounts retain maker-checker.';

COMMIT;
