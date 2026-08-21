BEGIN;

-- Cancellation is a two-phase fact once a Run may have crossed the provider
-- boundary. requested_at records durable intent; confirmed_at records the
-- Runtime acknowledgement. A reservation is not released merely because an
-- administrator or SCIM connector requested cancellation.
ALTER TABLE public."agent_runs"
  ADD COLUMN "cancellation_requested_at" timestamptz(6),
  ADD COLUMN "cancellation_reason" varchar(120),
  ADD COLUMN "cancellation_confirmed_at" timestamptz(6),
  ADD CONSTRAINT "agent_runs_cancellation_evidence_check" CHECK (
    (
      "cancellation_requested_at" IS NULL
      AND "cancellation_reason" IS NULL
      AND "cancellation_confirmed_at" IS NULL
    )
    OR
    (
      "cancellation_requested_at" IS NOT NULL
      AND "cancellation_reason" ~ '^[A-Z0-9][A-Z0-9_]{0,119}$'
      AND (
        "cancellation_confirmed_at" IS NULL
        OR "cancellation_confirmed_at" >= "cancellation_requested_at"
      )
    )
  );

CREATE INDEX "agent_runs_pending_cancellation_idx"
  ON public."agent_runs"("tenant_id", "cancellation_requested_at", "id")
  WHERE "cancellation_requested_at" IS NOT NULL
    AND "cancellation_confirmed_at" IS NULL;

-- These roles use column-level UPDATE grants, so newly added evidence columns
-- must be granted explicitly.
GRANT UPDATE (
  "cancellation_requested_at",
  "cancellation_reason"
) ON TABLE public."agent_runs" TO enterprise_agent_admin;
GRANT SELECT (
  "cancellation_requested_at"
) ON TABLE public."agent_runs" TO enterprise_agent_lifecycle;
GRANT UPDATE (
  "cancellation_requested_at",
  "cancellation_reason"
) ON TABLE public."agent_runs" TO enterprise_agent_lifecycle;

-- Admin and lifecycle capabilities may record cancellation intent and may
-- terminate a Run that is still provably QUEUED. They must never forge a
-- provider confirmation, release a provider-backed reservation, or rewrite a
-- terminal execution fact. Runtime confirmation remains an application-worker
-- transition under the normal Agent Run repository locks.
CREATE OR REPLACE FUNCTION public.guard_untrusted_agent_run_cancellation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  untrusted_cancellation_role boolean :=
    current_user = ANY (ARRAY[
      'enterprise_agent_admin',
      'enterprise_agent_lifecycle',
      'enterprise_agent_scim'
    ]);
  execution_fact_changed boolean;
BEGIN
  IF NOT untrusted_cancellation_role THEN
    RETURN NEW;
  END IF;

  IF NEW."cancellation_confirmed_at" IS DISTINCT FROM OLD."cancellation_confirmed_at" THEN
    RAISE EXCEPTION 'Only the Agent Runtime worker may confirm provider cancellation.'
      USING ERRCODE = '42501',
            CONSTRAINT = 'agent_runs_runtime_cancellation_confirmation_guard';
  END IF;

  IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
     AND (
       NEW."cancellation_requested_at" IS DISTINCT FROM OLD."cancellation_requested_at"
       OR NEW."cancellation_reason" IS DISTINCT FROM OLD."cancellation_reason"
     )
  THEN
    RAISE EXCEPTION 'A settled Agent Run cannot acquire new cancellation intent.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_runs_terminal_cancellation_intent_guard';
  END IF;

  IF OLD."cancellation_requested_at" IS NOT NULL
     AND (
       NEW."cancellation_requested_at" IS DISTINCT FROM OLD."cancellation_requested_at"
       OR NEW."cancellation_reason" IS DISTINCT FROM OLD."cancellation_reason"
     )
  THEN
    RAISE EXCEPTION 'Durable Agent Run cancellation intent is immutable.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_runs_cancellation_intent_immutable';
  END IF;

  execution_fact_changed :=
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."reserved_tokens" IS DISTINCT FROM OLD."reserved_tokens"
    OR NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
    OR NEW."error_code" IS DISTINCT FROM OLD."error_code"
    OR NEW."error_message" IS DISTINCT FROM OLD."error_message";

  IF NOT execution_fact_changed THEN
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'QUEUED'
     OR OLD."external_run_id" IS NOT NULL
     OR NEW."status" <> 'CANCELLED'
     OR NEW."external_run_id" IS NOT NULL
     OR NEW."reserved_tokens" <> 0
     OR NEW."finished_at" IS NULL
     OR NEW."error_code" IS NULL
     OR NEW."error_message" IS NULL
  THEN
    RAISE EXCEPTION 'This capability cannot rewrite a provider-backed Agent Run.'
      USING ERRCODE = '42501',
            CONSTRAINT = 'agent_runs_provider_cancellation_guard';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_untrusted_agent_run_cancellation()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS "agent_runs_untrusted_cancellation_guard"
  ON public."agent_runs";
CREATE TRIGGER "agent_runs_untrusted_cancellation_guard"
  BEFORE UPDATE ON public."agent_runs"
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_untrusted_agent_run_cancellation();

-- Preserve existing deprovisioning evidence while distinguishing Runs that
-- were safely cancelled locally from provider-backed Runs awaiting a stop.
ALTER TABLE public."identity_deprovisioning_actions"
  ADD COLUMN "agent_runs_cancellation_requested" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "identity_deprovisioning_actions_cancellation_requested_check"
    CHECK ("agent_runs_cancellation_requested" >= 0);

-- Token resolution necessarily happens before app.tenant_id is known. Replace
-- permissive pre-tenant table access with a bounded capability resolver owned
-- by the migration role. It returns no token digest or connector secret.
DROP POLICY IF EXISTS "identity_scim_token_lookup"
  ON public."scim_service_tokens";
DROP POLICY IF EXISTS "identity_scim_token_telemetry"
  ON public."scim_service_tokens";
DROP POLICY IF EXISTS "identity_scim_tenant_access"
  ON public."scim_connectors";
DROP POLICY IF EXISTS "identity_scim_tenant_access"
  ON public."identity_deprovisioning_actions";
DROP POLICY IF EXISTS "identity_scim_tenant_access"
  ON public."identity_devices";
DROP POLICY IF EXISTS "identity_scim_session_access"
  ON public."auth_sessions";
DROP POLICY IF EXISTS "identity_scim_assignment_access"
  ON public."role_assignments";
DROP POLICY IF EXISTS "identity_scim_run_access"
  ON public."agent_runs";
DROP POLICY IF EXISTS "identity_scim_outbox_access"
  ON public."outbox_events";
DROP POLICY IF EXISTS "identity_scim_audit_access"
  ON public."audit_events";

CREATE OR REPLACE FUNCTION public.resolve_scim_capability(
  p_token_hash text,
  p_connector_key text
)
RETURNS TABLE (
  "service_token_id" uuid,
  "tenant_id" uuid,
  "connector_id" uuid,
  "connector_key" text,
  "scopes" text[],
  "allow_user_create" boolean,
  "allow_group_create" boolean,
  "deactivate_user_on_scim_disable" boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
DECLARE
  resolved record;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_connector_key !~ '^[a-z0-9][a-z0-9._-]{0,99}$' THEN
    RETURN;
  END IF;

  UPDATE public."scim_service_tokens" AS token
  SET "last_used_at" = CURRENT_TIMESTAMP
  FROM public."scim_connectors" AS connector
  WHERE token."token_hash" = p_token_hash
    AND token."status" = 'ACTIVE'
    AND (token."expires_at" IS NULL OR token."expires_at" > CURRENT_TIMESTAMP)
    AND connector."tenant_id" = token."tenant_id"
    AND connector."id" = token."connector_id"
    AND connector."status" = 'ACTIVE'
    AND connector."key" = p_connector_key
  RETURNING
    token."id" AS service_token_id,
    token."tenant_id",
    token."connector_id",
    connector."key" AS connector_key,
    token."scopes",
    connector."allow_user_create",
    connector."allow_group_create",
    connector."deactivate_user_on_scim_disable"
  INTO resolved
  ;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    resolved.service_token_id::uuid,
    resolved.tenant_id::uuid,
    resolved.connector_id::uuid,
    resolved.connector_key::text,
    resolved.scopes::text[],
    resolved.allow_user_create::boolean,
    resolved.allow_group_create::boolean,
    resolved.deactivate_user_on_scim_disable::boolean;
END
$function$;

REVOKE ALL ON FUNCTION public.resolve_scim_capability(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_scim_capability(text, text)
  TO enterprise_agent_scim;

-- The SCIM role can no longer enumerate either side of the pre-tenant join.
-- All post-resolution operations use the returned IDs under tenant RLS.
REVOKE ALL PRIVILEGES ON TABLE
  public."scim_service_tokens",
  public."scim_connectors"
FROM enterprise_agent_scim;
REVOKE UPDATE ("last_used_at")
  ON TABLE public."scim_service_tokens"
  FROM enterprise_agent_scim;

-- Local access cut-off is a trigger-only capability. SCIM endpoints retain
-- their users/scim_* CRUD grants, but cannot directly rewrite sessions,
-- devices, assignments, Agent Runs, audit, Outbox, or deprovision evidence.
REVOKE ALL PRIVILEGES ON TABLE
  public."auth_sessions",
  public."identity_devices",
  public."role_assignments",
  public."agent_runs",
  public."outbox_events",
  public."audit_events",
  public."identity_deprovisioning_actions"
FROM enterprise_agent_scim;
REVOKE SELECT (
  "tenant_id", "id", "user_id", "revoked_at", "revoked_reason", "version"
) ON TABLE public."auth_sessions" FROM enterprise_agent_scim;
REVOKE UPDATE (
  "revoked_at", "revoked_reason", "version"
) ON TABLE public."auth_sessions" FROM enterprise_agent_scim;
REVOKE SELECT (
  "tenant_id", "id", "user_id", "status", "revision"
) ON TABLE public."identity_devices" FROM enterprise_agent_scim;
REVOKE UPDATE (
  "status", "revoked_at", "revoke_reason", "revision", "updated_at"
) ON TABLE public."identity_devices" FROM enterprise_agent_scim;
REVOKE SELECT (
  "tenant_id", "id", "user_id", "agent_instance_id", "status", "version"
) ON TABLE public."role_assignments" FROM enterprise_agent_scim;
REVOKE UPDATE (
  "status", "version", "updated_at"
) ON TABLE public."role_assignments" FROM enterprise_agent_scim;
REVOKE SELECT (
  "tenant_id", "id", "requester_user_id", "status", "version",
  "external_run_id", "cancellation_requested_at"
) ON TABLE public."agent_runs" FROM enterprise_agent_scim;
REVOKE UPDATE (
  "status", "error_code", "error_message", "finished_at",
  "reserved_tokens", "version", "updated_at",
  "cancellation_requested_at", "cancellation_reason"
) ON TABLE public."agent_runs" FROM enterprise_agent_scim;
REVOKE UPDATE ("status") ON TABLE public."users" FROM enterprise_agent_scim;

-- SCIM active=true -> false remains the synchronous local access cut-off.
-- Only QUEUED Runs are terminal locally. Runs that may have crossed the
-- provider boundary retain their status and reservation until Runtime confirms
-- cancellation through the normal Agent Run cancellation worker.
CREATE OR REPLACE FUNCTION public.apply_scim_user_deprovisioning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
DECLARE
  revoked_session_count integer := 0;
  revoked_device_count integer := 0;
  suspended_assignment_count integer := 0;
  locally_cancelled_run_count integer := 0;
  cancellation_requested_run_count integer := 0;
  outbox_id uuid := gen_random_uuid();
BEGIN
  IF NOT OLD."active" OR NEW."active" THEN
    RETURN NEW;
  END IF;

  -- The connector configuration is authoritative. It is read inside this
  -- reviewed definer boundary rather than trusted from request/session state.
  IF NOT EXISTS (
    SELECT 1
    FROM public."scim_connectors" AS connector
    WHERE connector."tenant_id" = NEW."tenant_id"
      AND connector."id" = NEW."connector_id"
      AND connector."deactivate_user_on_scim_disable"
  ) THEN
    RETURN NEW;
  END IF;

  -- Serialize against concurrent admin login/session issuance for this user.
  PERFORM 1
  FROM public."users" AS target_user
  WHERE target_user."tenant_id" = NEW."tenant_id"
    AND target_user."id" = NEW."user_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCIM target user does not exist in this tenant'
      USING ERRCODE = '23503',
            CONSTRAINT = 'scim_users_user_fkey';
  END IF;

  UPDATE public."users"
  SET "status" = 'INACTIVE', "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."user_id"
    AND "status" <> 'INACTIVE';

  UPDATE public."auth_sessions"
  SET
    "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP),
    "revoked_reason" = COALESCE("revoked_reason", 'SCIM_DEPROVISIONING'),
    "version" = "version" + 1
  WHERE "tenant_id" = NEW."tenant_id"
    AND "user_id" = NEW."user_id"
    AND "revoked_at" IS NULL;
  GET DIAGNOSTICS revoked_session_count = ROW_COUNT;

  UPDATE public."identity_devices"
  SET
    "status" = 'REVOKED',
    "revoked_at" = CURRENT_TIMESTAMP,
    "revoke_reason" = 'SCIM_DEPROVISIONING',
    "revision" = "revision" + 1,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "user_id" = NEW."user_id"
    AND "status" = 'ACTIVE';
  GET DIAGNOSTICS revoked_device_count = ROW_COUNT;

  UPDATE public."role_assignments"
  SET
    "status" = 'SUSPENDED',
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "user_id" = NEW."user_id"
    AND "status" IN ('PENDING', 'ACTIVE');
  GET DIAGNOSTICS suspended_assignment_count = ROW_COUNT;

  -- Serialize quota accounting with dispatch, settlement, and administrative
  -- assignment revocation before releasing any QUEUED reservation.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW."tenant_id"::text || ':agent-run-quota', 0)
  );

  UPDATE public."agent_runs" AS run
  SET
    "status" = 'CANCELLED',
    "error_code" = 'IDENTITY_DEPROVISIONED',
    "error_message" = 'Requester identity was deprovisioned by SCIM.',
    "finished_at" = CURRENT_TIMESTAMP,
    "reserved_tokens" = 0,
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE run."tenant_id" = NEW."tenant_id"
    AND run."requester_user_id" = NEW."user_id"
    AND run."status" = 'QUEUED'
    AND run."external_run_id" IS NULL
    AND run."cancellation_requested_at" IS NULL;
  GET DIAGNOSTICS locally_cancelled_run_count = ROW_COUNT;

  WITH cancellation_requested AS (
    UPDATE public."agent_runs" AS run
    SET
      "cancellation_requested_at" = CURRENT_TIMESTAMP,
      "cancellation_reason" = 'IDENTITY_DEPROVISIONED',
      "version" = "version" + 1,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE run."tenant_id" = NEW."tenant_id"
      AND run."requester_user_id" = NEW."user_id"
      AND (
        run."status" IN ('DISPATCHING', 'RUNNING', 'UNKNOWN')
        OR (run."status" = 'QUEUED' AND run."external_run_id" IS NOT NULL)
      )
      AND run."cancellation_requested_at" IS NULL
    RETURNING run."id", run."external_run_id"
  )
  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  )
  SELECT
    gen_random_uuid(),
    NEW."tenant_id",
    'agent_run',
    requested."id",
    'agent.run_cancel_requested.v1',
    jsonb_build_object(
      'runId', requested."id",
      'reasonCode', 'IDENTITY_DEPROVISIONED',
      'scimUserId', NEW."id",
      'externalRunId', requested."external_run_id"
    ),
    'PENDING',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM cancellation_requested AS requested;
  GET DIAGNOSTICS cancellation_requested_run_count = ROW_COUNT;

  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  )
  VALUES (
    outbox_id,
    NEW."tenant_id",
    'User',
    NEW."user_id",
    'IdentityPrincipalDeprovisioned.v1',
    jsonb_build_object(
      'tenantId', NEW."tenant_id",
      'userId', NEW."user_id",
      'connectorId', NEW."connector_id",
      'scimUserId', NEW."id",
      'sessionsRevoked', revoked_session_count,
      'devicesRevoked', revoked_device_count,
      'assignmentsSuspended', suspended_assignment_count,
      'agentRunsCancelled', locally_cancelled_run_count,
      'agentRunsCancellationRequested', cancellation_requested_run_count
    ),
    'PENDING',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  )
  VALUES (
    gen_random_uuid(),
    NEW."tenant_id",
    'SERVICE',
    NEW."connector_id",
    'identity.scim.user.deprovisioned',
    'User',
    NEW."user_id",
    jsonb_build_object(
      'connectorId', NEW."connector_id",
      'scimUserId', NEW."id",
      'sessionsRevoked', revoked_session_count,
      'devicesRevoked', revoked_device_count,
      'assignmentsSuspended', suspended_assignment_count,
      'agentRunsCancelled', locally_cancelled_run_count,
      'agentRunsCancellationRequested', cancellation_requested_run_count
    ),
    CURRENT_TIMESTAMP
  );

  INSERT INTO public."identity_deprovisioning_actions" (
    "tenant_id", "connector_id", "scim_user_id", "user_id",
    "sessions_revoked", "devices_revoked", "assignments_suspended",
    "agent_runs_cancelled", "agent_runs_cancellation_requested",
    "outbox_event_id", "occurred_at"
  )
  VALUES (
    NEW."tenant_id",
    NEW."connector_id",
    NEW."id",
    NEW."user_id",
    revoked_session_count,
    revoked_device_count,
    suspended_assignment_count,
    locally_cancelled_run_count,
    cancellation_requested_run_count,
    outbox_id,
    CURRENT_TIMESTAMP
  );
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.apply_scim_user_deprovisioning() FROM PUBLIC;

ALTER TABLE public."identity_deprovisioning_actions"
  ALTER COLUMN "agent_runs_cancellation_requested" DROP DEFAULT;

COMMIT;
