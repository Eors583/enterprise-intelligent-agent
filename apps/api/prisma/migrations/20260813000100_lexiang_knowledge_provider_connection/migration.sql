BEGIN;

CREATE TYPE public."KnowledgeProvider" AS ENUM ('LEXIANG');
CREATE TYPE public."KnowledgeProviderConnectionStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'UNAVAILABLE',
  'DISABLED'
);

CREATE TABLE public."knowledge_provider_connections" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider" public."KnowledgeProvider" NOT NULL,
  "status" public."KnowledgeProviderConnectionStatus" NOT NULL DEFAULT 'PENDING',
  "app_key" varchar(200) NOT NULL,
  "credential_ciphertext" text,
  "last_health_at" timestamptz(6),
  "last_health_code" varchar(120),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_provider_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_provider_connections_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_provider_connections_credentials_check"
    CHECK (
      ("status" = 'DISABLED' AND "credential_ciphertext" IS NULL)
      OR ("status" <> 'DISABLED' AND "credential_ciphertext" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "knowledge_provider_connections_tenant_id_id_key"
  ON public."knowledge_provider_connections" ("tenant_id", "id");
CREATE UNIQUE INDEX "knowledge_provider_connections_tenant_id_provider_key"
  ON public."knowledge_provider_connections" ("tenant_id", "provider");
CREATE INDEX "knowledge_provider_connections_status_idx"
  ON public."knowledge_provider_connections" ("tenant_id", "status", "updated_at" DESC);

REVOKE ALL PRIVILEGES ON public."knowledge_provider_connections" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public."knowledge_provider_connections" TO enterprise_agent_admin;

ALTER TABLE public."knowledge_provider_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."knowledge_provider_connections" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."knowledge_provider_connections"
AS RESTRICTIVE FOR ALL TO enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_admin_access ON public."knowledge_provider_connections"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMENT ON TABLE public."knowledge_provider_connections" IS
  'Tenant-scoped external knowledge provider connection metadata. Provider secrets are stored only as authenticated ciphertext.';
COMMENT ON COLUMN public."knowledge_provider_connections"."credential_ciphertext" IS
  'AES-GCM envelope bound to tenant, provider, and AppKey; plaintext credentials and access tokens are forbidden.';

COMMIT;
