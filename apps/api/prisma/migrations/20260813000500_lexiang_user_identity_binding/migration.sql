BEGIN;

CREATE TABLE public."knowledge_provider_user_bindings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "provider" public."KnowledgeProvider" NOT NULL,
  "user_id" uuid NOT NULL,
  "external_staff_id" varchar(200) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'ACTIVE',
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_provider_user_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_provider_user_bindings_status_check"
    CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "knowledge_provider_user_bindings_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_provider_user_bindings_connection_fkey"
    FOREIGN KEY ("tenant_id", "connection_id")
    REFERENCES public."knowledge_provider_connections" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_provider_user_bindings_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id") REFERENCES public."users" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "knowledge_provider_user_bindings_tenant_id_id_key"
  ON public."knowledge_provider_user_bindings" ("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_provider_user_bindings_user_key"
  ON public."knowledge_provider_user_bindings" ("tenant_id", "connection_id", "user_id");
CREATE UNIQUE INDEX "knowledge_provider_user_bindings_staff_key"
  ON public."knowledge_provider_user_bindings" ("tenant_id", "connection_id", "external_staff_id");
CREATE INDEX "knowledge_provider_user_bindings_lookup_idx"
  ON public."knowledge_provider_user_bindings" ("tenant_id", "provider", "status", "user_id");

REVOKE ALL PRIVILEGES ON public."knowledge_provider_user_bindings" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public."knowledge_provider_user_bindings" TO enterprise_agent_admin;

ALTER TABLE public."knowledge_provider_user_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_provider_user_bindings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."knowledge_provider_user_bindings"
AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_admin_access ON public."knowledge_provider_user_bindings"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMENT ON TABLE public."knowledge_provider_user_bindings" IS
  'Trusted tenant-scoped mapping from a BMS-AI user to one Lexiang staff identity. External retrieval fails closed when no active mapping exists.';
COMMENT ON COLUMN public."knowledge_provider_user_bindings"."external_staff_id" IS
  'Provider staff identifier used only inside the knowledge boundary; never a shared system-bot fallback.';

COMMIT;
