BEGIN;

ALTER TABLE public."employments"
  ADD COLUMN "country_or_region" varchar(120);

CREATE TABLE public."member_profiles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "personal_summary" text,
  "education_background" text,
  "career_overview" text,
  "job_responsibilities" text,
  "communication_preference" text,
  "collaboration_habits" text,
  "routine_schedule" text,
  "contact_information" text,
  "core_skills" text,
  "available_resources" text,
  "hobbies" text,
  "clubs" text,
  "faqs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_profiles_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "member_profiles_tenant_id_user_id_key" UNIQUE ("tenant_id", "user_id"),
  CONSTRAINT "member_profiles_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "member_profiles_tenant_id_user_id_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users" ("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_profiles_faqs_array_check"
    CHECK (jsonb_typeof("faqs") = 'array')
);

CREATE INDEX "member_profiles_tenant_id_updated_at_idx"
  ON public."member_profiles" ("tenant_id", "updated_at");

REVOKE ALL PRIVILEGES ON public."member_profiles" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."member_profiles" TO enterprise_agent_admin;
GRANT SELECT ON public."member_profiles" TO enterprise_agent_app;

ALTER TABLE public."member_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."member_profiles" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public."member_profiles"
AS RESTRICTIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY enterprise_agent_app_read ON public."member_profiles"
AS PERMISSIVE FOR SELECT TO enterprise_agent_app
USING (true);

CREATE POLICY enterprise_agent_admin_access ON public."member_profiles"
AS PERMISSIVE FOR ALL TO enterprise_agent_admin
USING (true)
WITH CHECK (true);

COMMENT ON TABLE public."member_profiles" IS
  'Tenant-scoped personal collaboration manual maintained alongside the enterprise directory.';

COMMIT;
