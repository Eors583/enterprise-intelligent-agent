BEGIN;

-- Direct-member knowledge access is intentionally modeled inside the
-- knowledge boundary. Business modules must use Knowledge Gateway instead of
-- joining this table.
CREATE TABLE public."knowledge_base_members" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "knowledge_base_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_base_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_base_members_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "knowledge_base_members_tenant_id_knowledge_base_id_fkey"
        FOREIGN KEY ("tenant_id", "knowledge_base_id")
        REFERENCES public."knowledge_bases" ("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "knowledge_base_members_tenant_id_user_id_fkey"
        FOREIGN KEY ("tenant_id", "user_id")
        REFERENCES public."users" ("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_base_members_tenant_id_knowledge_base_id_user_id_key"
ON public."knowledge_base_members" ("tenant_id", "knowledge_base_id", "user_id");

CREATE INDEX "knowledge_base_members_tenant_id_user_id_idx"
ON public."knowledge_base_members" ("tenant_id", "user_id");

REVOKE ALL PRIVILEGES ON public."knowledge_base_members" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."knowledge_base_members"
TO enterprise_agent_admin;
GRANT SELECT ON public."knowledge_base_members" TO enterprise_agent_app;

ALTER TABLE public."knowledge_base_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_base_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."knowledge_base_members"
AS RESTRICTIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_access ON public."knowledge_base_members"
AS PERMISSIVE FOR ALL TO enterprise_agent_app
USING (true)
WITH CHECK (true);

CREATE POLICY enterprise_agent_admin_access ON public."knowledge_base_members"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMIT;
