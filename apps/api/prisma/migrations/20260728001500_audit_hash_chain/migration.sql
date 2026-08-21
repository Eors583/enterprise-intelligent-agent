-- Append-only, per-tenant audit hash chain. Every existing and future event is
-- included. The trigger serializes inserts only within the affected tenant so
-- unrelated tenants can continue writing concurrently.

CREATE OR REPLACE FUNCTION public.audit_event_chain_payload(
  p_id uuid,
  p_tenant_id uuid,
  p_actor_type public."AuditActorType",
  p_actor_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_metadata jsonb,
  p_occurred_at timestamptz,
  p_chain_sequence bigint,
  p_previous_hash text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_array(
    p_id::text,
    p_tenant_id::text,
    p_actor_type::text,
    p_actor_id::text,
    p_action,
    p_resource_type,
    p_resource_id::text,
    p_metadata,
    to_char(timezone('UTC', p_occurred_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_chain_sequence::text,
    p_previous_hash
  )::text
$$;

ALTER TABLE public."audit_events"
  ADD COLUMN "chain_sequence" bigint,
  ADD COLUMN "previous_hash" character(64),
  ADD COLUMN "event_hash" character(64);

DO $$
DECLARE
  tenant_record record;
  event_record record;
  next_sequence bigint;
  prior_hash text;
  calculated_hash text;
BEGIN
  FOR tenant_record IN
    SELECT DISTINCT "tenant_id"
    FROM public."audit_events"
    ORDER BY "tenant_id"
  LOOP
    next_sequence := 0;
    prior_hash := NULL;
    FOR event_record IN
      SELECT
        "id",
        "tenant_id",
        "actor_type",
        "actor_id",
        "action",
        "resource_type",
        "resource_id",
        "metadata",
        "occurred_at"
      FROM public."audit_events"
      WHERE "tenant_id" = tenant_record."tenant_id"
      ORDER BY "occurred_at", "id"
    LOOP
      next_sequence := next_sequence + 1;
      calculated_hash := encode(
        digest(
          convert_to(
            public.audit_event_chain_payload(
              event_record."id",
              event_record."tenant_id",
              event_record."actor_type",
              event_record."actor_id",
              event_record."action",
              event_record."resource_type",
              event_record."resource_id",
              event_record."metadata",
              event_record."occurred_at",
              next_sequence,
              prior_hash
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      );
      UPDATE public."audit_events"
      SET
        "chain_sequence" = next_sequence,
        "previous_hash" = prior_hash,
        "event_hash" = calculated_hash
      WHERE "id" = event_record."id";
      prior_hash := calculated_hash;
    END LOOP;
  END LOOP;
END
$$;

ALTER TABLE public."audit_events"
  ALTER COLUMN "chain_sequence" SET DEFAULT 0,
  ALTER COLUMN "chain_sequence" SET NOT NULL,
  ALTER COLUMN "event_hash" SET DEFAULT repeat('0'::text, 64),
  ALTER COLUMN "event_hash" SET NOT NULL,
  ADD CONSTRAINT "audit_events_chain_sequence_positive"
    CHECK ("chain_sequence" > 0),
  ADD CONSTRAINT "audit_events_previous_hash_shape"
    CHECK (
      ("chain_sequence" = 1 AND "previous_hash" IS NULL)
      OR
      ("chain_sequence" > 1 AND "previous_hash" ~ '^[a-f0-9]{64}$')
    ),
  ADD CONSTRAINT "audit_events_event_hash_shape"
    CHECK ("event_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "audit_events_tenant_chain_sequence_key"
    UNIQUE ("tenant_id", "chain_sequence"),
  ADD CONSTRAINT "audit_events_tenant_event_hash_key"
    UNIQUE ("tenant_id", "event_hash");

CREATE OR REPLACE FUNCTION public.assign_audit_event_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prior_sequence bigint;
  prior_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('audit-chain:' || NEW."tenant_id"::text, 0)
  );

  SELECT "chain_sequence", "event_hash"
  INTO prior_sequence, prior_hash
  FROM public."audit_events"
  WHERE "tenant_id" = NEW."tenant_id"
  ORDER BY "chain_sequence" DESC
  LIMIT 1;

  NEW."chain_sequence" := coalesce(prior_sequence, 0) + 1;
  NEW."previous_hash" := prior_hash;
  NEW."event_hash" := encode(
    digest(
      convert_to(
        public.audit_event_chain_payload(
          NEW."id",
          NEW."tenant_id",
          NEW."actor_type",
          NEW."actor_id",
          NEW."action",
          NEW."resource_type",
          NEW."resource_id",
          NEW."metadata",
          NEW."occurred_at",
          NEW."chain_sequence",
          NEW."previous_hash"
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER "audit_events_assign_chain"
BEFORE INSERT ON public."audit_events"
FOR EACH ROW
EXECUTE FUNCTION public.assign_audit_event_chain();

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON public."audit_events"
FOR EACH ROW
EXECUTE FUNCTION public.reject_audit_event_mutation();

CREATE TRIGGER "audit_events_reject_truncate"
BEFORE TRUNCATE ON public."audit_events"
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_audit_event_mutation();

CREATE OR REPLACE FUNCTION public.verify_audit_event_chain(p_tenant_id uuid)
RETURNS TABLE (
  "checked_records" bigint,
  "first_invalid_event_id" uuid,
  "head_sequence" bigint,
  "head_hash" text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_record record;
  expected_sequence bigint := 0;
  expected_previous_hash text := NULL;
  expected_hash text;
  invalid_id uuid := NULL;
  observed_head_hash text := NULL;
BEGIN
  IF current_setting('app.tenant_id', true) IS NULL
     OR current_setting('app.tenant_id', true) = ''
     OR current_setting('app.tenant_id', true)::uuid <> p_tenant_id THEN
    RAISE EXCEPTION 'audit verification requires the active tenant context'
      USING ERRCODE = '42501';
  END IF;

  FOR event_record IN
    SELECT *
    FROM public."audit_events"
    WHERE "tenant_id" = p_tenant_id
    ORDER BY "chain_sequence"
  LOOP
    expected_sequence := expected_sequence + 1;
    expected_hash := encode(
      digest(
        convert_to(
          public.audit_event_chain_payload(
            event_record."id",
            event_record."tenant_id",
            event_record."actor_type",
            event_record."actor_id",
            event_record."action",
            event_record."resource_type",
            event_record."resource_id",
            event_record."metadata",
            event_record."occurred_at",
            event_record."chain_sequence",
            event_record."previous_hash"
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    IF invalid_id IS NULL AND (
      event_record."chain_sequence" <> expected_sequence
      OR event_record."previous_hash" IS DISTINCT FROM expected_previous_hash
      OR event_record."event_hash" <> expected_hash
    ) THEN
      invalid_id := event_record."id";
    END IF;
    expected_previous_hash := event_record."event_hash";
    observed_head_hash := event_record."event_hash";
  END LOOP;

  RETURN QUERY
  SELECT expected_sequence, invalid_id, expected_sequence, observed_head_hash;
END
$$;

REVOKE ALL ON FUNCTION public.audit_event_chain_payload(
  uuid, uuid, public."AuditActorType", uuid, text, text, uuid, jsonb, timestamptz, bigint, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_audit_event_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_audit_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_audit_event_chain(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.verify_audit_event_chain(uuid)
TO enterprise_agent_admin;
