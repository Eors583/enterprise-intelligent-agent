BEGIN;

ALTER TABLE public."member_profiles"
  ADD COLUMN "disclosure_policy" jsonb NOT NULL DEFAULT
    '{"IDENTITY":"SELF_ONLY","RESPONSIBILITIES":"SELF_ONLY","COLLABORATION":"SELF_ONLY","RESOURCES":"SELF_ONLY","INTERESTS":"SELF_ONLY","FAQ":"SELF_ONLY"}'::jsonb,
  ADD COLUMN "manual_sharing_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "availability_sharing_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "private_risk_reminders_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "policy_revision" integer NOT NULL DEFAULT 1;

ALTER TABLE public."member_profiles"
  ADD CONSTRAINT "member_profiles_disclosure_policy_check"
  CHECK (
    jsonb_typeof("disclosure_policy") = 'object'
    AND ("disclosure_policy" ->> 'IDENTITY') IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
    AND ("disclosure_policy" ->> 'RESPONSIBILITIES') IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
    AND ("disclosure_policy" ->> 'COLLABORATION') IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
    AND ("disclosure_policy" ->> 'RESOURCES') IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
    AND ("disclosure_policy" ->> 'INTERESTS') IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
    AND ("disclosure_policy" ->> 'FAQ') IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
    AND ("disclosure_policy" - ARRAY[
      'IDENTITY', 'RESPONSIBILITIES', 'COLLABORATION', 'RESOURCES', 'INTERESTS', 'FAQ'
    ]::text[]) = '{}'::jsonb
  ),
  ADD CONSTRAINT "member_profiles_policy_revision_check" CHECK ("policy_revision" > 0);

ALTER TABLE public."agent_runs"
  ADD COLUMN "collaboration_context_snapshot" jsonb;

CREATE TABLE public."work_availabilities" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" varchar(32) NOT NULL,
  "starts_at" timestamptz(6) NOT NULL,
  "ends_at" timestamptz(6),
  "summary" varchar(500),
  "expected_response" varchar(200),
  "emergency_contact_user_id" uuid,
  "disclosure_scope" varchar(32) NOT NULL DEFAULT 'SELF_ONLY',
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_availabilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_availabilities_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "work_availabilities_tenant_id_user_id_key" UNIQUE ("tenant_id", "user_id"),
  CONSTRAINT "work_availabilities_status_check" CHECK (
    "status" IN ('AVAILABLE', 'FOCUSING', 'IN_MEETING', 'TRAVELING', 'ON_LEAVE', 'UNAVAILABLE')
  ),
  CONSTRAINT "work_availabilities_scope_check" CHECK (
    "disclosure_scope" IN ('SELF_ONLY', 'SHARED_WORK', 'DEPARTMENT', 'TENANT')
  ),
  CONSTRAINT "work_availabilities_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "work_availabilities_period_check" CHECK (
    "ends_at" IS NULL OR "ends_at" > "starts_at"
  ),
  CONSTRAINT "work_availabilities_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "work_availabilities_owner_fkey"
    FOREIGN KEY ("tenant_id", "user_id") REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "work_availabilities_emergency_contact_fkey"
    FOREIGN KEY ("tenant_id", "emergency_contact_user_id") REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "work_availabilities_tenant_id_ends_at_updated_at_idx"
  ON public."work_availabilities" ("tenant_id", "ends_at", "updated_at" DESC);

REVOKE ALL PRIVILEGES ON public."work_availabilities" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public."work_availabilities" TO enterprise_agent_app;
GRANT SELECT ON public."work_availabilities" TO enterprise_agent_admin;

ALTER TABLE public."work_availabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."work_availabilities" FORCE ROW LEVEL SECURITY;

CREATE POLICY work_availabilities_tenant_isolation ON public."work_availabilities"
AS RESTRICTIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin
USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY work_availabilities_app_read ON public."work_availabilities"
AS PERMISSIVE FOR SELECT TO enterprise_agent_app
USING (true);

CREATE POLICY work_availabilities_app_self_insert ON public."work_availabilities"
AS PERMISSIVE FOR INSERT TO enterprise_agent_app
WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY work_availabilities_app_self_update ON public."work_availabilities"
AS PERMISSIVE FOR UPDATE TO enterprise_agent_app
USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid)
WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY work_availabilities_admin_read ON public."work_availabilities"
AS PERMISSIVE FOR SELECT TO enterprise_agent_admin
USING (true);

COMMENT ON TABLE public."work_availabilities" IS
  'Owner-maintained minimal work availability; external calendar payloads are never stored here.';

COMMIT;
