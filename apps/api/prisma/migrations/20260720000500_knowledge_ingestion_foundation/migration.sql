ALTER TYPE "KnowledgeDocumentStatus" ADD VALUE IF NOT EXISTS 'PROCESSING' AFTER 'DRAFT';
ALTER TYPE "KnowledgeDocumentStatus" ADD VALUE IF NOT EXISTS 'FAILED' AFTER 'READY';

CREATE TYPE "KnowledgeDocumentVersionStatus" AS ENUM (
  'DRAFT', 'PROCESSING', 'READY', 'FAILED', 'ARCHIVED'
);
CREATE TYPE "KnowledgeIngestionStage" AS ENUM (
  'UPLOADED', 'SECURITY_CHECK', 'PARSING', 'CHUNKING', 'INDEXING', 'READY'
);
CREATE TYPE "KnowledgeIngestionStatus" AS ENUM (
  'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE public."knowledge_documents"
  ADD COLUMN "current_version_id" uuid;

CREATE TABLE public."knowledge_document_versions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "source_type" "KnowledgeSourceType" NOT NULL,
  "mime_type" varchar(160),
  "file_name" varchar(300),
  "object_key" text,
  "checksum" char(64),
  "content_text" text,
  "status" "KnowledgeDocumentVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "change_summary" varchar(500),
  "created_by_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "published_at" timestamptz(6),
  CONSTRAINT "knowledge_document_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_document_versions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_document_versions_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_document_versions_document_fkey"
    FOREIGN KEY ("tenant_id", "document_id")
    REFERENCES public."knowledge_documents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_document_versions_created_by_fkey"
    FOREIGN KEY ("tenant_id", "created_by_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "knowledge_document_versions_tenant_id_id_key"
  ON public."knowledge_document_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_document_versions_document_identity_key"
  ON public."knowledge_document_versions"("tenant_id", "document_id", "id");
CREATE UNIQUE INDEX "knowledge_document_versions_number_key"
  ON public."knowledge_document_versions"("tenant_id", "document_id", "version_number");
CREATE INDEX "knowledge_document_versions_lookup_idx"
  ON public."knowledge_document_versions"("tenant_id", "knowledge_base_id", "status", "created_at" DESC);

INSERT INTO public."knowledge_document_versions" (
  "tenant_id", "knowledge_base_id", "document_id", "version_number", "source_type",
  "mime_type", "file_name", "object_key", "checksum", "content_text", "status",
  "change_summary", "created_by_id", "created_at", "published_at"
)
SELECT
  "tenant_id", "knowledge_base_id", "id", "document_version", "source_type",
  "mime_type", "file_name", "object_key", "checksum", "content_text",
  CASE "status"::text
    WHEN 'READY' THEN 'READY'::"KnowledgeDocumentVersionStatus"
    WHEN 'ARCHIVED' THEN 'ARCHIVED'::"KnowledgeDocumentVersionStatus"
    ELSE 'DRAFT'::"KnowledgeDocumentVersionStatus"
  END,
  '从旧版知识文档模型迁移', "created_by_id", "created_at",
  CASE WHEN "status"::text = 'READY' THEN "updated_at" ELSE NULL END
FROM public."knowledge_documents";

UPDATE public."knowledge_documents" AS document
SET "current_version_id" = version."id"
FROM public."knowledge_document_versions" AS version
WHERE version."tenant_id" = document."tenant_id"
  AND version."document_id" = document."id"
  AND version."version_number" = document."document_version";

ALTER TABLE public."knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_current_version_fkey"
  FOREIGN KEY ("tenant_id", "id", "current_version_id")
  REFERENCES public."knowledge_document_versions"("tenant_id", "document_id", "id")
  ON DELETE RESTRICT;

CREATE TABLE public."knowledge_chunks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "chunk_index" integer NOT NULL,
  "heading_path" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "content" text NOT NULL,
  "token_count" integer NOT NULL,
  "content_hash" char(64) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_chunks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_chunks_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_chunks_document_fkey"
    FOREIGN KEY ("tenant_id", "document_id")
    REFERENCES public."knowledge_documents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_chunks_document_version_fkey"
    FOREIGN KEY ("tenant_id", "document_id", "document_version_id")
    REFERENCES public."knowledge_document_versions"("tenant_id", "document_id", "id")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX "knowledge_chunks_tenant_id_id_key"
  ON public."knowledge_chunks"("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_chunks_version_index_key"
  ON public."knowledge_chunks"("tenant_id", "document_version_id", "chunk_index");
CREATE UNIQUE INDEX "knowledge_chunks_version_hash_key"
  ON public."knowledge_chunks"("tenant_id", "document_version_id", "content_hash");
CREATE INDEX "knowledge_chunks_scope_idx"
  ON public."knowledge_chunks"("tenant_id", "knowledge_base_id", "document_id");
CREATE INDEX "knowledge_chunks_content_trgm_idx"
  ON public."knowledge_chunks" USING gin ("content" gin_trgm_ops);

-- Keep previously published documents searchable after introducing chunks.
-- A later re-ingestion can replace this compatibility chunk with the normal
-- heading-aware 400-800 token chunks without changing the cited version id.
INSERT INTO public."knowledge_chunks" (
  "tenant_id", "knowledge_base_id", "document_id", "document_version_id",
  "chunk_index", "heading_path", "content", "token_count", "content_hash", "metadata"
)
SELECT
  version."tenant_id",
  version."knowledge_base_id",
  version."document_id",
  version."id",
  0,
  ARRAY[]::text[],
  version."content_text",
  GREATEST(1, CEIL(char_length(version."content_text") / 2.0)::integer),
  COALESCE(version."checksum", md5(version."content_text") || md5(version."content_text")),
  jsonb_build_object('migrationBackfill', true)
FROM public."knowledge_document_versions" AS version
JOIN public."knowledge_documents" AS document
  ON document."tenant_id" = version."tenant_id"
 AND document."id" = version."document_id"
 AND document."current_version_id" = version."id"
WHERE version."status" = 'READY'
  AND NULLIF(btrim(version."content_text"), '') IS NOT NULL
ON CONFLICT ("tenant_id", "document_version_id", "chunk_index") DO NOTHING;

CREATE TABLE public."knowledge_ingestion_jobs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "stage" "KnowledgeIngestionStage" NOT NULL DEFAULT 'UPLOADED',
  "status" "KnowledgeIngestionStatus" NOT NULL DEFAULT 'PENDING',
  "progress" integer NOT NULL DEFAULT 0 CHECK ("progress" BETWEEN 0 AND 100),
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "error_code" varchar(120),
  "error_message" varchar(500),
  "started_at" timestamptz(6),
  "finished_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_ingestion_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_ingestion_jobs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_ingestion_jobs_document_version_fkey"
    FOREIGN KEY ("tenant_id", "document_version_id")
    REFERENCES public."knowledge_document_versions"("tenant_id", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "knowledge_ingestion_jobs_tenant_id_id_key"
  ON public."knowledge_ingestion_jobs"("tenant_id", "id");
CREATE INDEX "knowledge_ingestion_jobs_status_idx"
  ON public."knowledge_ingestion_jobs"("tenant_id", "status", "created_at");
CREATE INDEX "knowledge_ingestion_jobs_version_idx"
  ON public."knowledge_ingestion_jobs"("tenant_id", "document_version_id", "created_at" DESC);

GRANT SELECT ON TABLE public."knowledge_document_versions", public."knowledge_chunks"
  TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public."knowledge_document_versions", public."knowledge_chunks", public."knowledge_ingestion_jobs"
  TO enterprise_agent_admin;

DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_document_versions', 'knowledge_chunks', 'knowledge_ingestion_jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
      'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;

  EXECUTE 'CREATE POLICY enterprise_agent_access ON public."knowledge_document_versions" AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true)';
  EXECUTE 'CREATE POLICY enterprise_agent_access ON public."knowledge_chunks" AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true)';
END
$policies$;
