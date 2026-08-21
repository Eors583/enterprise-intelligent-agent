BEGIN;

CREATE UNIQUE INDEX "knowledge_external_space_bindings_entry_scope_key"
  ON public."knowledge_external_space_bindings"
  ("tenant_id", "knowledge_base_id", "provider", "external_space_id");

CREATE TABLE public."knowledge_external_entry_bindings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "provider" public."KnowledgeProvider" NOT NULL,
  "external_space_id" varchar(200) NOT NULL,
  "external_entry_id" varchar(200) NOT NULL,
  "external_parent_entry_id" varchar(200),
  "entry_type" varchar(64) NOT NULL,
  "folder_id" uuid,
  "document_id" uuid,
  "remote_name" varchar(300) NOT NULL,
  "remote_created_at" timestamptz(6),
  "remote_updated_at" timestamptz(6),
  "last_synced_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_external_entry_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_external_entry_bindings_identity_check"
    CHECK (
      ("entry_type" = 'folder' AND "folder_id" IS NOT NULL AND "document_id" IS NULL)
      OR
      ("entry_type" <> 'folder' AND "folder_id" IS NULL AND "document_id" IS NOT NULL)
    ),
  CONSTRAINT "knowledge_external_entry_bindings_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_external_entry_bindings_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_external_entry_bindings_space_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "provider", "external_space_id")
    REFERENCES public."knowledge_external_space_bindings"
      ("tenant_id", "knowledge_base_id", "provider", "external_space_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_external_entry_bindings_folder_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "folder_id")
    REFERENCES public."knowledge_folders" ("tenant_id", "knowledge_base_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "knowledge_external_entry_bindings_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents" ("tenant_id", "knowledge_base_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "knowledge_external_entry_bindings_tenant_id_id_key"
  ON public."knowledge_external_entry_bindings" ("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_external_entry_bindings_remote_key"
  ON public."knowledge_external_entry_bindings"
  ("tenant_id", "provider", "external_space_id", "external_entry_id");
CREATE UNIQUE INDEX "knowledge_external_entry_bindings_folder_key"
  ON public."knowledge_external_entry_bindings"
  ("tenant_id", "knowledge_base_id", "folder_id");
CREATE UNIQUE INDEX "knowledge_external_entry_bindings_document_key"
  ON public."knowledge_external_entry_bindings"
  ("tenant_id", "knowledge_base_id", "document_id");
CREATE INDEX "knowledge_external_entry_bindings_parent_idx"
  ON public."knowledge_external_entry_bindings"
  ("tenant_id", "knowledge_base_id", "external_parent_entry_id");

REVOKE ALL PRIVILEGES ON public."knowledge_external_entry_bindings" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public."knowledge_external_entry_bindings" TO enterprise_agent_admin;

ALTER TABLE public."knowledge_external_entry_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_external_entry_bindings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."knowledge_external_entry_bindings"
AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_admin_access ON public."knowledge_external_entry_bindings"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMENT ON TABLE public."knowledge_external_entry_bindings" IS
  'Stable tenant-scoped metadata binding between a Lexiang knowledge entry and its local folder or document shadow.';

COMMIT;
