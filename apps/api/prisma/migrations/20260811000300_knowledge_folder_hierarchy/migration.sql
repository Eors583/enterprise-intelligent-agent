BEGIN;

CREATE TABLE public."knowledge_folders" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "knowledge_base_id" uuid NOT NULL,
    "parent_id" uuid,
    "name" varchar(200) NOT NULL,
    "path" varchar(2000) NOT NULL,
    "created_by_id" uuid NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_folders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_folders_tenant_id_fkey" FOREIGN KEY ("tenant_id")
      REFERENCES public."tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "knowledge_folders_tenant_id_knowledge_base_id_fkey"
      FOREIGN KEY ("tenant_id", "knowledge_base_id")
      REFERENCES public."knowledge_bases" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "knowledge_folders_tenant_id_created_by_id_fkey"
      FOREIGN KEY ("tenant_id", "created_by_id")
      REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_folders_tenant_id_id_key"
  ON public."knowledge_folders" ("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_folders_scope_identity_key"
  ON public."knowledge_folders" ("tenant_id", "knowledge_base_id", "id");
CREATE UNIQUE INDEX "knowledge_folders_scope_path_key"
  ON public."knowledge_folders" ("tenant_id", "knowledge_base_id", "path");
CREATE INDEX "knowledge_folders_parent_name_idx"
  ON public."knowledge_folders" ("tenant_id", "knowledge_base_id", "parent_id", "name");
ALTER TABLE public."knowledge_folders" ADD CONSTRAINT "knowledge_folders_parent_fkey"
  FOREIGN KEY ("tenant_id", "knowledge_base_id", "parent_id")
  REFERENCES public."knowledge_folders" ("tenant_id", "knowledge_base_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE public."knowledge_documents" ADD COLUMN "folder_id" uuid;
ALTER TABLE public."knowledge_documents" ADD CONSTRAINT "knowledge_documents_folder_fkey"
  FOREIGN KEY ("tenant_id", "knowledge_base_id", "folder_id")
  REFERENCES public."knowledge_folders" ("tenant_id", "knowledge_base_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "knowledge_documents_folder_listing_idx"
  ON public."knowledge_documents" ("tenant_id", "knowledge_base_id", "folder_id", "status", "title");

REVOKE ALL PRIVILEGES ON public."knowledge_folders" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."knowledge_folders" TO enterprise_agent_admin;
GRANT SELECT ON public."knowledge_folders" TO enterprise_agent_app;
ALTER TABLE public."knowledge_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_folders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public."knowledge_folders"
AS RESTRICTIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_agent_access ON public."knowledge_folders"
AS PERMISSIVE FOR ALL TO enterprise_agent_app USING (true) WITH CHECK (true);
CREATE POLICY enterprise_agent_admin_access ON public."knowledge_folders"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true);

COMMIT;
