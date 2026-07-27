BEGIN;

-- Application authorization limits this mutation to tenant owners. Database
-- privileges remain column-scoped so the admin role cannot rename, suspend or
-- otherwise mutate the tenant through this capability.
GRANT UPDATE (
  "agent_run_concurrency_limit",
  "agent_run_rate_limit_per_minute",
  "agent_run_monthly_token_limit",
  "updated_at"
) ON TABLE public."tenants" TO enterprise_agent_admin;

COMMIT;
