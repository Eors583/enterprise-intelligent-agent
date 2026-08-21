BEGIN;

CREATE TYPE public."KnowledgeExternalSpaceStatus" AS ENUM (
  'PROVISIONING',
  'ACTIVE',
  'SYNC_FAILED',
  'DELETING',
  'DELETE_FAILED',
  'DELETED'
);

ALTER TABLE public."knowledge_provider_connections"
  ADD COLUMN "team_id" varchar(200),
  ADD COLUMN "operator_staff_id" varchar(200);

CREATE TABLE public."knowledge_external_space_bindings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "provider" public."KnowledgeProvider" NOT NULL,
  "status" public."KnowledgeExternalSpaceStatus" NOT NULL DEFAULT 'PROVISIONING',
  "external_team_id" varchar(200) NOT NULL,
  "external_space_id" varchar(200),
  "external_root_entry_id" varchar(200),
  "remote_name" varchar(200),
  "remote_description" text,
  "remote_logo" varchar(1000),
  "visible_type" integer,
  "manager_inherit_type" varchar(24),
  "member_inherit_type" varchar(24),
  "last_synced_at" timestamptz(6),
  "last_error_code" varchar(120),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_external_space_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_external_space_bindings_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_external_space_bindings_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_external_space_bindings_connection_fkey"
    FOREIGN KEY ("tenant_id", "connection_id")
    REFERENCES public."knowledge_provider_connections" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_external_space_bindings_visible_type_check"
    CHECK ("visible_type" IS NULL OR "visible_type" BETWEEN 0 AND 2),
  CONSTRAINT "knowledge_external_space_bindings_remote_identity_check"
    CHECK (
      "status" <> 'ACTIVE'
      OR "external_space_id" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "knowledge_external_space_bindings_tenant_id_id_key"
  ON public."knowledge_external_space_bindings" ("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_external_space_bindings_knowledge_base_key"
  ON public."knowledge_external_space_bindings" ("tenant_id", "knowledge_base_id");
CREATE UNIQUE INDEX "knowledge_external_space_bindings_external_space_key"
  ON public."knowledge_external_space_bindings" ("tenant_id", "provider", "external_space_id");
CREATE INDEX "knowledge_external_space_bindings_connection_status_idx"
  ON public."knowledge_external_space_bindings" ("tenant_id", "connection_id", "status");

REVOKE ALL PRIVILEGES ON public."knowledge_external_space_bindings" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public."knowledge_external_space_bindings" TO enterprise_agent_admin;

ALTER TABLE public."knowledge_external_space_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_external_space_bindings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."knowledge_external_space_bindings"
AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_admin_access ON public."knowledge_external_space_bindings"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMENT ON TABLE public."knowledge_external_space_bindings" IS
  'Stable tenant-scoped binding between an authoritative local knowledge base and a managed external knowledge space.';

COMMIT;
