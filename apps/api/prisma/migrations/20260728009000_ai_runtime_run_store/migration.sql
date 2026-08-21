BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_runtime') THEN
    CREATE ROLE enterprise_agent_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT enterprise_agent_runtime TO %I', current_user);
END
$$;

REVOKE enterprise_agent_runtime
  FROM enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin,
       enterprise_agent_outbox, enterprise_agent_provisioner;

CREATE TABLE public.ai_runtime_runs (
  tenant_id UUID NOT NULL,
  run_id UUID NOT NULL,
  status VARCHAR(24) NOT NULL,
  version INTEGER NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT ai_runtime_runs_pkey PRIMARY KEY (tenant_id, run_id),
  CONSTRAINT ai_runtime_runs_tenant_id_fkey
    FOREIGN KEY (tenant_id)
    REFERENCES public.tenants(id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT ai_runtime_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT ai_runtime_runs_version_check CHECK (version >= 1),
  CONSTRAINT ai_runtime_runs_record_shape_check
    CHECK (
      jsonb_typeof(record) = 'object'
      AND record->>'tenant_id' = tenant_id::text
      AND record->>'run_id' = run_id::text
      AND record->>'status' = status
      AND (record->>'version')::integer = version
    )
);

CREATE INDEX ai_runtime_runs_tenant_status_updated_idx
  ON public.ai_runtime_runs (tenant_id, status, updated_at, run_id);

ALTER TABLE public.ai_runtime_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_runtime_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.ai_runtime_runs
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY enterprise_agent_runtime_access
  ON public.ai_runtime_runs
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_runtime
  USING (true)
  WITH CHECK (true);

CREATE POLICY enterprise_agent_admin_access
  ON public.ai_runtime_runs
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_admin
  USING (true);

REVOKE ALL PRIVILEGES ON TABLE public.ai_runtime_runs FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO enterprise_agent_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.ai_runtime_runs
  TO enterprise_agent_runtime;
GRANT SELECT
  ON TABLE public.ai_runtime_runs
  TO enterprise_agent_admin;

COMMENT ON TABLE public.ai_runtime_runs IS
  'Durable AI Runtime state. The immutable public contract is stored in record; indexed state mirrors are guarded by shape constraints.';

COMMIT;
