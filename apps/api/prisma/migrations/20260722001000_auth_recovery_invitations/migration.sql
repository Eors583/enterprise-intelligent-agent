BEGIN;

ALTER TABLE public."auth_login_rate_limits"
    ALTER COLUMN "scope" TYPE varchar(32);
ALTER TABLE public."auth_login_rate_limits"
    DROP CONSTRAINT "auth_login_rate_limits_scope_check";
ALTER TABLE public."auth_login_rate_limits"
    ADD CONSTRAINT "auth_login_rate_limits_scope_check"
        CHECK ("scope" IN (
            'ACCOUNT',
            'NETWORK',
            'RECOVERY_ACCOUNT',
            'RECOVERY_NETWORK'
        ));

CREATE TABLE public."auth_action_tokens" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "purpose" varchar(32) NOT NULL,
    "token_hash" char(64) NOT NULL,
    "delivery_status" varchar(24) NOT NULL DEFAULT 'PENDING',
    "delivery_attempts" integer NOT NULL DEFAULT 0,
    "last_delivery_at" timestamptz(6),
    "expires_at" timestamptz(6) NOT NULL,
    "consumed_at" timestamptz(6),
    "revoked_at" timestamptz(6),
    "created_by_id" uuid,
    "created_at" timestamptz(6) NOT NULL DEFAULT now(),
    "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT "auth_action_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_action_tokens_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "auth_action_tokens_purpose_check"
        CHECK ("purpose" IN ('PASSWORD_RESET', 'MEMBER_INVITATION')),
    CONSTRAINT "auth_action_tokens_delivery_status_check"
        CHECK ("delivery_status" IN ('NOT_CONFIGURED', 'PENDING', 'SENT', 'FAILED')),
    CONSTRAINT "auth_action_tokens_delivery_attempts_check"
        CHECK ("delivery_attempts" >= 0),
    CONSTRAINT "auth_action_tokens_expiry_check"
        CHECK ("expires_at" > "created_at"),
    CONSTRAINT "auth_action_tokens_terminal_check"
        CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL),
    CONSTRAINT "auth_action_tokens_consumed_at_check"
        CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at"),
    CONSTRAINT "auth_action_tokens_revoked_at_check"
        CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at"),
    CONSTRAINT "auth_action_tokens_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "auth_action_tokens_tenant_id_user_id_fkey"
        FOREIGN KEY ("tenant_id", "user_id")
        REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "auth_action_tokens_tenant_id_created_by_id_fkey"
        FOREIGN KEY ("tenant_id", "created_by_id")
        REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "auth_action_tokens_active_user_purpose_key"
    ON public."auth_action_tokens"("tenant_id", "user_id", "purpose")
    WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;
CREATE INDEX "auth_action_tokens_tenant_user_purpose_created_idx"
    ON public."auth_action_tokens"("tenant_id", "user_id", "purpose", "created_at" DESC);
CREATE INDEX "auth_action_tokens_expires_at_idx"
    ON public."auth_action_tokens"("expires_at");

REVOKE ALL PRIVILEGES ON TABLE public."auth_action_tokens" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public."auth_action_tokens"
    FROM enterprise_agent_app, enterprise_agent_outbox, enterprise_agent_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."auth_action_tokens"
    TO enterprise_agent_auth, enterprise_agent_admin;
-- Invitation acceptance can only activate pending employments; other
-- employment columns remain outside the authentication capability.
GRANT UPDATE ("status", "updated_at") ON TABLE public."employments"
    TO enterprise_agent_auth;

ALTER TABLE public."auth_action_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auth_action_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
    ON public."auth_action_tokens"
    AS RESTRICTIVE
    FOR ALL
    TO enterprise_agent_admin
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY auth_action_tokens_auth_access
    ON public."auth_action_tokens"
    AS PERMISSIVE
    FOR ALL
    TO enterprise_agent_auth
    USING (true)
    WITH CHECK (true);

CREATE POLICY auth_action_tokens_admin_access
    ON public."auth_action_tokens"
    AS PERMISSIVE
    FOR ALL
    TO enterprise_agent_admin
    USING (true)
    WITH CHECK (true);

COMMIT;
