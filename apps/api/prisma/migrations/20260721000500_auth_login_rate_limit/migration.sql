BEGIN;

-- Login throttling runs before a tenant/user identity is trusted. The table
-- therefore stores only HMAC-derived bucket keys and is intentionally not a
-- tenant business table. Only the dedicated auth role can access it.
CREATE TABLE public."auth_login_rate_limits" (
    "key_hash" varchar(64) NOT NULL,
    "scope" varchar(16) NOT NULL,
    "failure_count" integer NOT NULL DEFAULT 0,
    "window_started_at" timestamptz(6) NOT NULL DEFAULT now(),
    "blocked_until" timestamptz(6),
    "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT "auth_login_rate_limits_pkey" PRIMARY KEY ("key_hash"),
    CONSTRAINT "auth_login_rate_limits_scope_check"
        CHECK ("scope" IN ('ACCOUNT', 'NETWORK')),
    CONSTRAINT "auth_login_rate_limits_failure_count_check"
        CHECK ("failure_count" >= 0),
    CONSTRAINT "auth_login_rate_limits_block_window_check"
        CHECK ("blocked_until" IS NULL OR "blocked_until" >= "window_started_at")
);

CREATE INDEX "auth_login_rate_limits_updated_at_idx"
    ON public."auth_login_rate_limits"("updated_at");

REVOKE ALL PRIVILEGES ON TABLE public."auth_login_rate_limits" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public."auth_login_rate_limits"
    FROM enterprise_agent_app, enterprise_agent_admin, enterprise_agent_outbox, enterprise_agent_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."auth_login_rate_limits"
    TO enterprise_agent_auth;

ALTER TABLE public."auth_login_rate_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auth_login_rate_limits" FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_agent_auth_access
    ON public."auth_login_rate_limits"
    AS PERMISSIVE
    FOR ALL
    TO enterprise_agent_auth
    USING (true)
    WITH CHECK (true);

COMMIT;
