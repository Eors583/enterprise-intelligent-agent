BEGIN;

CREATE TYPE public."FinopsProjectionSourceKind" AS ENUM (
  'AGENT_RUN', 'TOOL_RECEIPT'
);
CREATE TYPE public."FinopsProjectionStatus" AS ENUM (
  'PENDING', 'PROJECTED', 'BLOCKED'
);

CREATE TABLE public."finops_projection_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "source_kind" public."FinopsProjectionSourceKind" NOT NULL,
  "source_id" UUID NOT NULL,
  "source_version" VARCHAR(200) NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "projected_source_hash" CHAR(64),
  "status" public."FinopsProjectionStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_by" VARCHAR(160),
  "locked_until" TIMESTAMPTZ(6),
  "diagnostic_code" VARCHAR(120),
  "diagnostic_detail" VARCHAR(1000),
  "projected_entry_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "projected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finops_projection_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finops_projection_jobs_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "finops_projection_jobs_source_key"
    UNIQUE ("tenant_id", "source_kind", "source_id"),
  CONSTRAINT "finops_projection_jobs_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "finops_projection_jobs_hash_check" CHECK (
    "source_hash" ~ '^[a-f0-9]{64}$'
    AND (
      "projected_source_hash" IS NULL
      OR "projected_source_hash" ~ '^[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT "finops_projection_jobs_attempts_check" CHECK (
    "attempts" BETWEEN 0 AND 100000
  ),
  CONSTRAINT "finops_projection_jobs_lock_pair_check" CHECK (
    ("locked_by" IS NULL) = ("locked_until" IS NULL)
  ),
  CONSTRAINT "finops_projection_jobs_diagnostic_pair_check" CHECK (
    ("diagnostic_code" IS NULL) = ("diagnostic_detail" IS NULL)
  ),
  CONSTRAINT "finops_projection_jobs_entries_check" CHECK (
    jsonb_typeof("projected_entry_ids") = 'array'
  ),
  CONSTRAINT "finops_projection_jobs_state_check" CHECK (
    (
      "status" = 'PROJECTED'
      AND "projected_source_hash" = "source_hash"
      AND "projected_at" IS NOT NULL
      AND jsonb_array_length("projected_entry_ids") > 0
      AND "diagnostic_code" IS NULL
    )
    OR (
      "status" = 'BLOCKED'
      AND "diagnostic_code" IS NOT NULL
      AND (
        (
          "projected_at" IS NULL
          AND "projected_source_hash" IS NULL
          AND jsonb_array_length("projected_entry_ids") = 0
        )
        OR (
          "projected_at" IS NOT NULL
          AND "projected_source_hash" IS NOT NULL
          AND "projected_source_hash" <> "source_hash"
          AND jsonb_array_length("projected_entry_ids") > 0
        )
      )
    )
    OR (
      "status" = 'PENDING'
      AND "projected_at" IS NULL
      AND jsonb_array_length("projected_entry_ids") = 0
      AND "diagnostic_code" IS NULL
    )
  )
);

CREATE INDEX "finops_projection_jobs_claim_idx"
  ON public."finops_projection_jobs" (
    "tenant_id", "status", "available_at", "locked_until",
    "created_at", "id"
  );

CREATE TABLE public."finops_projection_diagnostics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "source_kind" public."FinopsProjectionSourceKind" NOT NULL,
  "source_id" UUID NOT NULL,
  "source_version" VARCHAR(200) NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "code" VARCHAR(120) NOT NULL,
  "detail" VARCHAR(1000) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" public."FinopsAlertStatus" NOT NULL DEFAULT 'OPEN',
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "finops_projection_diagnostics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finops_projection_diagnostics_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "finops_projection_diagnostics_source_version_code_key"
    UNIQUE (
      "tenant_id", "source_kind", "source_id", "source_version", "code"
    ),
  CONSTRAINT "finops_projection_diagnostics_job_fkey"
    FOREIGN KEY ("tenant_id", "job_id")
    REFERENCES public."finops_projection_jobs" ("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "finops_projection_diagnostics_hash_check" CHECK (
    "source_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "finops_projection_diagnostics_metadata_check" CHECK (
    jsonb_typeof("metadata") = 'object'
  ),
  CONSTRAINT "finops_projection_diagnostics_status_check" CHECK (
    ("status" = 'OPEN' AND "resolved_at" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL)
  )
);

CREATE INDEX "finops_projection_diagnostics_open_idx"
  ON public."finops_projection_diagnostics" (
    "tenant_id", "status", "opened_at" DESC, "id"
  );

-- Approved Price Snapshots are immutable. The foundation trigger used
-- SELECT ... FOR SHARE, which unnecessarily required every append-only ledger
-- writer to hold UPDATE on the pricing catalog. Recreate the same verifier as a
-- read-only SELECT so the projector can retain exact least privilege.
CREATE OR REPLACE FUNCTION public."finops_prepare_cost_entry"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  price public."finops_price_snapshots"%ROWTYPE;
BEGIN
  SELECT * INTO price
  FROM public."finops_price_snapshots" p
  WHERE p."tenant_id" = NEW."tenant_id"
    AND p."id" = NEW."price_snapshot_id";
  IF NOT FOUND OR price."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'Cost entry requires an approved immutable Price Snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."incurred_at" < price."effective_from"
    OR (
      price."effective_to" IS NOT NULL
      AND NEW."incurred_at" >= price."effective_to"
    )
  THEN
    RAISE EXCEPTION 'Price Snapshot is not effective at the cost occurrence time'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."formula_expression" <> '(quantity / unitSize) * unitPrice' THEN
    RAISE EXCEPTION 'Unsupported or unversioned FinOps cost formula'
      USING ERRCODE = '23514';
  END IF;
  NEW."price_snapshot_version" := price."version";
  NEW."resource_kind" := price."resource_kind";
  NEW."currency" := price."currency";
  NEW."calculated_amount" :=
    round((NEW."quantity" / price."unit_size") * price."unit_price", 12);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public."guard_finops_projection_diagnostic"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FinOps Projection diagnostics cannot be deleted.'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW."tenant_id", NEW."job_id", NEW."source_kind", NEW."source_id",
    NEW."source_version", NEW."source_hash", NEW."code", NEW."detail",
    NEW."metadata", NEW."opened_at"
  ) IS DISTINCT FROM ROW(
    OLD."tenant_id", OLD."job_id", OLD."source_kind", OLD."source_id",
    OLD."source_version", OLD."source_hash", OLD."code", OLD."detail",
    OLD."metadata", OLD."opened_at"
  )
  OR OLD."status" <> 'OPEN'
  OR NEW."status" <> 'RESOLVED'
  OR NEW."resolved_at" IS NULL THEN
    RAISE EXCEPTION 'Only OPEN to RESOLVED diagnostic transitions are allowed.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "finops_projection_diagnostics_guard_trigger"
  BEFORE UPDATE OR DELETE ON public."finops_projection_diagnostics"
  FOR EACH ROW EXECUTE FUNCTION public."guard_finops_projection_diagnostic"();

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'enterprise_agent_finops_projector'
  ) THEN
    CREATE ROLE enterprise_agent_finops_projector
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_finops_projector
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO enterprise_agent_finops_projector;

CREATE OR REPLACE FUNCTION public."finops_projection_tenants"()
RETURNS TABLE ("tenant_id" UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT DISTINCT source."tenant_id"
  FROM (
    SELECT run."tenant_id"
    FROM public."agent_runs" run
    WHERE run."status" IN (
      'SUCCEEDED'::public."AgentRunStatus",
      'FAILED'::public."AgentRunStatus",
      'UNKNOWN'::public."AgentRunStatus",
      'CANCELLED'::public."AgentRunStatus"
    )
    UNION
    SELECT receipt."tenant_id"
    FROM public."tool_execution_receipts" receipt
    WHERE receipt."source" IN (
      'PROVIDER'::public."ToolExecutionReceiptSource",
      'COMPENSATOR'::public."ToolExecutionReceiptSource"
    )
  ) source
$$;

REVOKE ALL ON FUNCTION public."finops_projection_tenants"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public."finops_projection_tenants"()
  TO enterprise_agent_finops_projector;

REVOKE ALL ON TABLE
  public."finops_projection_jobs",
  public."finops_projection_diagnostics"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_finops_projector;

GRANT SELECT ON TABLE
  public."finops_projection_jobs",
  public."finops_projection_diagnostics"
  TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public."finops_projection_jobs",
  public."finops_projection_diagnostics"
  TO enterprise_agent_finops_projector;

GRANT SELECT ON TABLE
  public."agent_runs",
  public."tool_invocations",
  public."tool_versions",
  public."tool_execution_receipts",
  public."finops_price_snapshots",
  public."finops_cost_entries"
  TO enterprise_agent_finops_projector;
GRANT INSERT ON TABLE
  public."finops_cost_entries",
  public."audit_events",
  public."outbox_events"
  TO enterprise_agent_finops_projector;

GRANT USAGE ON TYPE
  public."FinopsProjectionSourceKind",
  public."FinopsProjectionStatus",
  public."FinopsAlertStatus",
  public."FinopsCostSubjectType",
  public."FinopsResourceKind",
  public."FinopsVerificationStatus",
  public."FinopsSourceAuthority",
  public."AgentRunStatus",
  public."ToolInvocationStatus",
  public."ToolExecutionReceiptSource",
  public."ToolExecutionReceiptOutcome",
  public."AuditActorType"
  TO enterprise_agent_finops_projector;

ALTER TABLE public."finops_projection_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."finops_projection_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation"
  ON public."finops_projection_jobs"
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "finops_projection_jobs_admin_read"
  ON public."finops_projection_jobs"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_admin
  USING (true);
CREATE POLICY "finops_projection_jobs_projector_access"
  ON public."finops_projection_jobs"
  AS PERMISSIVE FOR ALL TO enterprise_agent_finops_projector
  USING (true)
  WITH CHECK (true);

ALTER TABLE public."finops_projection_diagnostics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."finops_projection_diagnostics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation"
  ON public."finops_projection_diagnostics"
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "finops_projection_diagnostics_admin_read"
  ON public."finops_projection_diagnostics"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_admin
  USING (true);
CREATE POLICY "finops_projection_diagnostics_projector_access"
  ON public."finops_projection_diagnostics"
  AS PERMISSIVE FOR ALL TO enterprise_agent_finops_projector
  USING (true)
  WITH CHECK (true);

CREATE POLICY "finops_projector_agent_run_read"
  ON public."agent_runs"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_finops_projector
  USING (true);
CREATE POLICY "finops_projector_tool_invocation_read"
  ON public."tool_invocations"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_finops_projector
  USING (true);
CREATE POLICY "finops_projector_tool_version_read"
  ON public."tool_versions"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_finops_projector
  USING (true);
CREATE POLICY "finops_projector_tool_receipt_read"
  ON public."tool_execution_receipts"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_finops_projector
  USING (true);
CREATE POLICY "finops_projector_price_read"
  ON public."finops_price_snapshots"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_finops_projector
  USING (true);
CREATE POLICY "finops_projector_cost_read"
  ON public."finops_cost_entries"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_finops_projector
  USING (true);
CREATE POLICY "finops_projector_cost_insert"
  ON public."finops_cost_entries"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_finops_projector
  WITH CHECK (
    "verification_status" = 'VERIFIED'
    AND "source_authority" = 'RUNTIME_ATTESTED'
    AND "source_system" IN ('agent-runtime', 'tool-gateway')
    AND "idempotency_key" LIKE 'auto-finops:%'
  );

CREATE POLICY "finops_projector_audit_tenant"
  ON public."audit_events"
  AS RESTRICTIVE FOR INSERT TO enterprise_agent_finops_projector
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "finops_projector_audit_insert"
  ON public."audit_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_finops_projector
  WITH CHECK (
    "actor_type" = 'SERVICE'
    AND "actor_id" = '00000000-0000-7000-8000-00000000f017'::uuid
    AND "action" IN (
      'finops.cost.auto_projected',
      'finops.projection.blocked',
      'finops.projection.resolved'
    )
  );
CREATE POLICY "finops_projector_outbox_tenant"
  ON public."outbox_events"
  AS RESTRICTIVE FOR INSERT TO enterprise_agent_finops_projector
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "finops_projector_outbox_insert"
  ON public."outbox_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_finops_projector
  WITH CHECK (
    "event_type" IN (
      'finops.cost.auto_projected.v1',
      'finops.projection.blocked.v1',
      'finops.projection.resolved.v1'
    )
    AND "aggregate_type" IN (
      'FINOPS_COST_ENTRY',
      'FINOPS_PROJECTION_DIAGNOSTIC'
    )
    AND "payload"->>'tenantId' =
      NULLIF(current_setting('app.tenant_id', true), '')
    AND "payload"->>'actorId' =
      '00000000-0000-7000-8000-00000000f017'
  );

REVOKE ALL ON FUNCTION public."guard_finops_projection_diagnostic"() FROM PUBLIC;

COMMIT;
