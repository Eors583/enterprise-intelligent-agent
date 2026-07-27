-- Durable asynchronous knowledge ingestion queue. HTTP requests enqueue work;
-- the least-privileged cross-tenant worker only claims and defers queue rows.
-- Tenant-scoped content publication remains owned by enterprise_agent_admin.

ALTER TABLE public."knowledge_ingestion_jobs"
  ADD COLUMN "available_at" timestamptz(6) NOT NULL DEFAULT now(),
  ADD COLUMN "claimed_by" varchar(200),
  ADD COLUMN "lease_expires_at" timestamptz(6);

ALTER TABLE public."knowledge_document_versions"
  ADD COLUMN "object_size" integer,
  ADD COLUMN "object_sha256" char(64),
  ADD CONSTRAINT "knowledge_document_versions_object_integrity_check"
    CHECK (
      ("object_size" IS NULL AND "object_sha256" IS NULL)
      OR
      (
        "object_key" IS NOT NULL
        AND "object_size" IS NOT NULL
        AND "object_size" >= 0
        AND "object_sha256" ~ '^[0-9a-f]{64}$'
      )
    );

-- A deployment may interrupt an older in-process RUNNING job. Make it eligible
-- for the new worker without inventing another document version or queue row.
UPDATE public."knowledge_ingestion_jobs"
SET
  "status" = 'PENDING'::"KnowledgeIngestionStatus",
  "available_at" = now(),
  "claimed_by" = NULL,
  "lease_expires_at" = NULL,
  "finished_at" = NULL
WHERE "status" = 'RUNNING'::"KnowledgeIngestionStatus";

-- Older releases did not enforce one live queue row per document version.
-- Retain the newest active row and terminally supersede every older duplicate
-- before creating the partial unique index, so an in-place production upgrade
-- cannot fail on historical retry races.
WITH ranked_active_jobs AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "tenant_id", "document_version_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS active_rank
  FROM public."knowledge_ingestion_jobs"
  WHERE "status" IN (
    'PENDING'::"KnowledgeIngestionStatus",
    'RUNNING'::"KnowledgeIngestionStatus"
  )
)
UPDATE public."knowledge_ingestion_jobs" AS job
SET
  "status" = 'FAILED'::"KnowledgeIngestionStatus",
  "claimed_by" = NULL,
  "lease_expires_at" = NULL,
  "error_code" = 'KNOWLEDGE_INGESTION_SUPERSEDED',
  "error_message" = 'A newer ingestion job superseded this active queue row.',
  "finished_at" = now(),
  "updated_at" = now()
FROM ranked_active_jobs AS ranked
WHERE ranked."id" = job."id"
  AND ranked.active_rank > 1;

ALTER TABLE public."knowledge_ingestion_jobs"
  ADD CONSTRAINT "knowledge_ingestion_jobs_lease_pair_check"
    CHECK (("claimed_by" IS NULL) = ("lease_expires_at" IS NULL)),
  ADD CONSTRAINT "knowledge_ingestion_jobs_claim_state_check"
    CHECK (
      ("status" = 'RUNNING'::"KnowledgeIngestionStatus"
        AND "claimed_by" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL)
      OR
      ("status" <> 'RUNNING'::"KnowledgeIngestionStatus"
        AND "claimed_by" IS NULL
        AND "lease_expires_at" IS NULL)
    );

CREATE INDEX "knowledge_ingestion_jobs_claim_idx"
  ON public."knowledge_ingestion_jobs"(
    "status", "available_at", "lease_expires_at", "created_at", "id"
  );

CREATE UNIQUE INDEX "knowledge_ingestion_jobs_active_version_key"
  ON public."knowledge_ingestion_jobs"("tenant_id", "document_version_id")
  WHERE "status" IN (
    'PENDING'::"KnowledgeIngestionStatus",
    'RUNNING'::"KnowledgeIngestionStatus"
  );

REVOKE ALL PRIVILEGES ON TABLE public."knowledge_ingestion_jobs"
  FROM enterprise_agent_outbox;
GRANT SELECT (
  "id",
  "tenant_id",
  "document_version_id",
  "status",
  "attempts",
  "available_at",
  "claimed_by",
  "lease_expires_at",
  "created_at",
  "started_at"
) ON TABLE public."knowledge_ingestion_jobs" TO enterprise_agent_outbox;
GRANT UPDATE (
  "stage",
  "status",
  "progress",
  "attempts",
  "available_at",
  "claimed_by",
  "lease_expires_at",
  "error_code",
  "error_message",
  "started_at",
  "finished_at",
  "updated_at"
) ON TABLE public."knowledge_ingestion_jobs" TO enterprise_agent_outbox;

-- The original restrictive PUBLIC policy also applies to a cross-tenant
-- worker. Scope tenant isolation to the tenant-bound roles for this queue,
-- retaining one explicit least-privileged cross-tenant worker policy.
DROP POLICY IF EXISTS tenant_isolation ON public."knowledge_ingestion_jobs";
DROP POLICY IF EXISTS enterprise_agent_outbox_access ON public."knowledge_ingestion_jobs";

CREATE POLICY tenant_isolation
ON public."knowledge_ingestion_jobs"
AS RESTRICTIVE
FOR ALL
TO enterprise_agent_admin, enterprise_agent_app
USING (
  "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

CREATE POLICY enterprise_agent_outbox_access
ON public."knowledge_ingestion_jobs"
AS PERMISSIVE
FOR ALL
TO enterprise_agent_outbox
USING (true)
WITH CHECK (true);
