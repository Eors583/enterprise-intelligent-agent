BEGIN;

ALTER TABLE public."knowledge_ingestion_jobs"
  ADD COLUMN "failure_attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE public."knowledge_ingestion_jobs"
  ADD CONSTRAINT "knowledge_ingestion_jobs_failure_attempts_check"
  CHECK ("failure_attempts" >= 0);

CREATE INDEX "knowledge_ingestion_jobs_failure_priority_idx"
  ON public."knowledge_ingestion_jobs"
  (
    "status",
    "failure_attempts",
    "attempts",
    "available_at",
    "lease_expires_at",
    "created_at",
    "id"
  );

COMMIT;
