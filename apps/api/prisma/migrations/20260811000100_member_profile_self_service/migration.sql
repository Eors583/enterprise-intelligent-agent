BEGIN;

GRANT INSERT, UPDATE ON public."member_profiles" TO enterprise_agent_app;

CREATE POLICY enterprise_agent_app_self_insert ON public."member_profiles"
AS PERMISSIVE FOR INSERT TO enterprise_agent_app
WITH CHECK (
  "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);

CREATE POLICY enterprise_agent_app_self_update ON public."member_profiles"
AS PERMISSIVE FOR UPDATE TO enterprise_agent_app
USING (
  "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
)
WITH CHECK (
  "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);

COMMIT;
