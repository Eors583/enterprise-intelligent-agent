-- Add durable delivery leases for the IM outbox worker. A dedicated role may
-- inspect and update only the outbox queue across tenants; it cannot read any
-- business table and it does not bypass row-level security.
BEGIN;

ALTER TABLE public."outbox_events"
    ADD COLUMN "locked_by" varchar(120),
    ADD COLUMN "locked_until" timestamptz(6),
    ADD COLUMN "last_error" text,
    ADD COLUMN "provider_name" varchar(80),
    ADD COLUMN "provider_receipt" jsonb;

-- Older message events predate the explicit recipient snapshot. Backfill from
-- the same message/conversation state so the worker never needs read access to
-- business tables at delivery time.
UPDATE public."outbox_events" AS event
SET "payload" = jsonb_set(
    event."payload",
    '{recipients}',
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'type', lower(participant."type"::text),
                    'id', COALESCE(participant."user_id", participant."agent_id")::text
                )
                ORDER BY participant."participant_key"
            )
            FROM public."conversation_participants" AS participant
            WHERE participant."tenant_id" = event."tenant_id"
              AND participant."conversation_id" = message."conversation_id"
              AND participant."left_at" IS NULL
              AND participant."participant_key" <> message."sender_key"
        ),
        '[]'::jsonb
    ),
    true
)
FROM public."messages" AS message
WHERE event."event_type" = 'message.created.v1'
  AND event."aggregate_type" = 'message'
  AND message."tenant_id" = event."tenant_id"
  AND message."id" = event."aggregate_id"
  AND NOT (event."payload" ? 'recipients');

-- Preserve databases that delivered events before provider receipts existed.
-- These rows remain terminal and are explicitly marked as legacy rather than
-- being misrepresented as deliveries by the newly configured provider.
UPDATE public."outbox_events"
SET
    "provider_name" = COALESCE("provider_name", 'legacy'),
    "provider_receipt" = COALESCE(
        "provider_receipt",
        '{"outcome":"skipped","deliveredRecipientCount":0,"reason":"legacy_published_without_receipt"}'::jsonb
    )
WHERE "status" = 'PUBLISHED';

ALTER TABLE public."outbox_events"
    ADD CONSTRAINT "outbox_events_attempts_nonnegative_check"
        CHECK ("attempts" >= 0),
    ADD CONSTRAINT "outbox_events_lease_pair_check"
        CHECK (("locked_by" IS NULL) = ("locked_until" IS NULL)),
    ADD CONSTRAINT "outbox_events_published_state_check"
        CHECK (
            "status" <> 'PUBLISHED'
            OR (
                "published_at" IS NOT NULL
                AND "provider_name" IS NOT NULL
                AND "provider_receipt" IS NOT NULL
                AND "locked_by" IS NULL
                AND "locked_until" IS NULL
            )
        );

CREATE INDEX "outbox_events_delivery_claim_idx"
ON public."outbox_events" (
    "event_type",
    "status",
    "available_at",
    "locked_until",
    "created_at",
    "id"
);

DO $outbox_role$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_outbox'
    ) THEN
        CREATE ROLE enterprise_agent_outbox
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ELSE
        ALTER ROLE enterprise_agent_outbox
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;

    -- current_user is expected to be the migration login. Production creates a
    -- separate LOGIN for OUTBOX_DATABASE_URL and grants only this capability
    -- role to it; the API login must not receive this membership.
    EXECUTE format('GRANT enterprise_agent_outbox TO %I', current_user);
END
$outbox_role$;

REVOKE enterprise_agent_outbox FROM enterprise_agent_app;
REVOKE enterprise_agent_outbox FROM enterprise_agent_provisioner;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM enterprise_agent_outbox;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM enterprise_agent_outbox;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM enterprise_agent_outbox;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL PRIVILEGES ON TABLES FROM enterprise_agent_outbox;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL PRIVILEGES ON SEQUENCES FROM enterprise_agent_outbox;

GRANT USAGE ON SCHEMA public TO enterprise_agent_outbox;
GRANT SELECT ON TABLE public."outbox_events" TO enterprise_agent_outbox;
GRANT UPDATE (
    "status",
    "attempts",
    "available_at",
    "locked_by",
    "locked_until",
    "last_error",
    "provider_name",
    "provider_receipt",
    "published_at"
) ON TABLE public."outbox_events" TO enterprise_agent_outbox;

-- The original restrictive policy applies to PUBLIC and therefore also to a
-- cross-tenant worker. Scope it to tenant-bound roles on this queue only, then
-- add one explicit cross-tenant policy for the least-privileged worker role.
DROP POLICY IF EXISTS tenant_isolation ON public."outbox_events";
DROP POLICY IF EXISTS enterprise_agent_outbox_access ON public."outbox_events";

CREATE POLICY tenant_isolation
ON public."outbox_events"
AS RESTRICTIVE
FOR ALL
TO enterprise_agent_app, enterprise_agent_provisioner
USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

CREATE POLICY enterprise_agent_outbox_access
ON public."outbox_events"
AS PERMISSIVE
FOR ALL
TO enterprise_agent_outbox
USING (true)
WITH CHECK (true);

COMMIT;
