BEGIN;

CREATE TYPE public."KnowledgeParseReviewStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED'
);

ALTER TABLE public."knowledge_document_versions"
  ADD COLUMN "source_uri" TEXT,
  ADD COLUMN "parser_name" VARCHAR(120),
  ADD COLUMN "parse_quality_score" NUMERIC(5, 4),
  ADD COLUMN "parse_review_status" public."KnowledgeParseReviewStatus"
    NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "parse_review_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "parse_reviewed_by_id" UUID,
  ADD COLUMN "parse_reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "parse_review_note" VARCHAR(2000),
  ADD COLUMN "parse_diagnostics" JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE public."knowledge_document_versions"
SET "parse_review_status" = 'PENDING'
WHERE "source_type" = 'FILE'
  AND "status" = 'READY'
  AND "published_at" IS NULL;

ALTER TABLE public."knowledge_document_versions"
  ADD CONSTRAINT "knowledge_document_versions_parse_reviewer_fkey"
    FOREIGN KEY ("tenant_id", "parse_reviewed_by_id")
    REFERENCES public."users" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "knowledge_document_versions_source_uri_check" CHECK (
    (
      "source_type" = 'WEB'
      AND "source_uri" IS NOT NULL
      AND length("source_uri") BETWEEN 9 AND 2048
      AND "source_uri" ~ '^https://'
    )
    OR (
      "source_type" <> 'WEB'
      AND "source_uri" IS NULL
    )
  ),
  ADD CONSTRAINT "knowledge_document_versions_parse_quality_check" CHECK (
    "parse_quality_score" IS NULL
    OR ("parse_quality_score" >= 0 AND "parse_quality_score" <= 1)
  ),
  ADD CONSTRAINT "knowledge_document_versions_parse_review_revision_check" CHECK (
    "parse_review_revision" > 0
  ),
  ADD CONSTRAINT "knowledge_document_versions_parse_diagnostics_check" CHECK (
    jsonb_typeof("parse_diagnostics") = 'object'
  ),
  ADD CONSTRAINT "knowledge_document_versions_parse_review_shape_check" CHECK (
    (
      "parse_review_status" IN ('NOT_REQUIRED', 'PENDING')
      AND "parse_reviewed_by_id" IS NULL
      AND "parse_reviewed_at" IS NULL
      AND "parse_review_note" IS NULL
    )
    OR (
      "parse_review_status" IN ('APPROVED', 'REJECTED')
      AND "parse_reviewed_by_id" IS NOT NULL
      AND "parse_reviewed_at" IS NOT NULL
      AND "parse_reviewed_by_id" <> "created_by_id"
      AND (
        "parse_review_status" <> 'REJECTED'
        OR "parse_review_note" IS NOT NULL
      )
      AND (
        "parse_review_note" IS NULL
        OR length(btrim("parse_review_note")) BETWEEN 1 AND 2000
      )
    )
  );

CREATE INDEX "knowledge_document_versions_review_queue_idx"
  ON public."knowledge_document_versions" (
    "tenant_id",
    "knowledge_base_id",
    "parse_review_status",
    "created_at" DESC
  );

REVOKE ALL ON TABLE public."knowledge_document_versions" FROM PUBLIC;
GRANT SELECT ON TABLE public."knowledge_document_versions" TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."knowledge_document_versions"
  TO enterprise_agent_admin;

ALTER TABLE public."knowledge_document_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_document_versions" FORCE ROW LEVEL SECURITY;

COMMIT;
