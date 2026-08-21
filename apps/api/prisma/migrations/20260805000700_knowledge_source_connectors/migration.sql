CREATE TYPE public."KnowledgeSourceConnectorStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE public."KnowledgeSourceItemStatus" AS ENUM ('ACTIVE', 'DELETED');
CREATE TYPE public."KnowledgeSourceSyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE public."knowledge_source_connectors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "name" varchar(120) NOT NULL,
  "provider_type" varchar(40) NOT NULL DEFAULT 'HTTPS_MANIFEST',
  "manifest_url" text NOT NULL,
  "status" public."KnowledgeSourceConnectorStatus" NOT NULL DEFAULT 'ACTIVE',
  "cursor" text,
  "last_synced_at" timestamptz(6),
  "created_by_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_source_connectors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_source_connectors_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "knowledge_source_connectors_provider_check" CHECK ("provider_type" = 'HTTPS_MANIFEST'),
  CONSTRAINT "knowledge_source_connectors_manifest_url_check" CHECK ("manifest_url" ~ '^https://'),
  CONSTRAINT "knowledge_source_connectors_kb_fkey" FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_source_connectors_creator_fkey" FOREIGN KEY ("tenant_id", "created_by_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "knowledge_source_connectors_scope_status_idx"
  ON public."knowledge_source_connectors" ("tenant_id", "knowledge_base_id", "status", "updated_at" DESC);

CREATE TABLE public."knowledge_source_sync_runs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "status" public."KnowledgeSourceSyncRunStatus" NOT NULL DEFAULT 'RUNNING',
  "cursor_before" text,
  "cursor_after" text,
  "discovered_count" integer NOT NULL DEFAULT 0,
  "created_count" integer NOT NULL DEFAULT 0,
  "updated_count" integer NOT NULL DEFAULT 0,
  "skipped_count" integer NOT NULL DEFAULT 0,
  "deleted_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "failures" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "requested_by_id" uuid NOT NULL,
  "started_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" timestamptz(6),
  CONSTRAINT "knowledge_source_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_source_sync_runs_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "knowledge_source_sync_runs_counts_check" CHECK (
    "discovered_count" >= 0 AND "created_count" >= 0 AND "updated_count" >= 0
    AND "skipped_count" >= 0 AND "deleted_count" >= 0 AND "failed_count" >= 0
  ),
  CONSTRAINT "knowledge_source_sync_runs_failures_check" CHECK (jsonb_typeof("failures") = 'array'),
  CONSTRAINT "knowledge_source_sync_runs_completion_check" CHECK (
    ("status" = 'RUNNING' AND "finished_at" IS NULL)
    OR ("status" IN ('SUCCEEDED', 'FAILED') AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "knowledge_source_sync_runs_connector_fkey" FOREIGN KEY ("tenant_id", "connector_id")
    REFERENCES public."knowledge_source_connectors" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_source_sync_runs_requester_fkey" FOREIGN KEY ("tenant_id", "requested_by_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_source_sync_runs_one_running_idx"
  ON public."knowledge_source_sync_runs" ("tenant_id", "connector_id") WHERE "status" = 'RUNNING';
CREATE INDEX "knowledge_source_sync_runs_connector_started_idx"
  ON public."knowledge_source_sync_runs" ("tenant_id", "connector_id", "started_at" DESC, "id");

CREATE TABLE public."knowledge_source_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "external_id" varchar(300) NOT NULL,
  "source_revision" varchar(300) NOT NULL,
  "sha256" char(64),
  "source_uri" text,
  "file_name" varchar(300) NOT NULL,
  "mime_type" varchar(160) NOT NULL,
  "source_modified_at" timestamptz(6),
  "document_id" uuid,
  "status" public."KnowledgeSourceItemStatus" NOT NULL DEFAULT 'ACTIVE',
  "last_seen_run_id" uuid,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_source_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_source_items_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "knowledge_source_items_external_identity_key" UNIQUE ("tenant_id", "connector_id", "external_id"),
  CONSTRAINT "knowledge_source_items_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "knowledge_source_items_connector_fkey" FOREIGN KEY ("tenant_id", "connector_id")
    REFERENCES public."knowledge_source_connectors" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_source_items_document_fkey" FOREIGN KEY ("tenant_id", "document_id")
    REFERENCES public."knowledge_documents" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_source_items_last_run_fkey" FOREIGN KEY ("tenant_id", "last_seen_run_id")
    REFERENCES public."knowledge_source_sync_runs" ("tenant_id", "id") ON DELETE SET NULL ("last_seen_run_id") ON UPDATE CASCADE
);

CREATE INDEX "knowledge_source_items_connector_status_idx"
  ON public."knowledge_source_items" ("tenant_id", "connector_id", "status", "updated_at" DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_source_connectors',
    'knowledge_source_sync_runs',
    'knowledge_source_items'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO enterprise_agent_admin USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true)',
      table_name || '_admin_access', table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO enterprise_agent_admin', table_name);
  END LOOP;
END $$;
