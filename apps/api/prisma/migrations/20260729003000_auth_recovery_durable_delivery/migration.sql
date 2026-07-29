BEGIN;

CREATE UNIQUE INDEX "auth_action_tokens_tenant_id_id_key"
    ON public."auth_action_tokens"("tenant_id", "id");

CREATE TABLE public."auth_recovery_deliveries" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "action_token_id" uuid NOT NULL,
    "payload_ciphertext" bytea,
    "payload_key_id" varchar(120),
    "payload_format_version" integer,
    "status" varchar(24) NOT NULL DEFAULT 'PENDING',
    "attempts" integer NOT NULL DEFAULT 0,
    "available_at" timestamptz(6) NOT NULL DEFAULT now(),
    "locked_by" varchar(160),
    "locked_until" timestamptz(6),
    "last_error_code" varchar(120),
    "delivered_at" timestamptz(6),
    "expires_at" timestamptz(6) NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT now(),
    "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT "auth_recovery_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_recovery_deliveries_action_token_key" UNIQUE ("action_token_id"),
    CONSTRAINT "auth_recovery_deliveries_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
    CONSTRAINT "auth_recovery_deliveries_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "auth_recovery_deliveries_action_token_fkey"
        FOREIGN KEY ("tenant_id", "action_token_id")
        REFERENCES public."auth_action_tokens"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "auth_recovery_deliveries_payload_check"
        CHECK (
            (
                "status" IN ('PENDING', 'PROCESSING')
                AND octet_length("payload_ciphertext") > 0
                AND length(btrim("payload_key_id")) > 0
                AND "payload_format_version" = 1
            )
            OR
            (
                "status" NOT IN ('PENDING', 'PROCESSING')
                AND "payload_ciphertext" IS NULL
                AND "payload_key_id" IS NULL
                AND "payload_format_version" IS NULL
            )
        ),
    CONSTRAINT "auth_recovery_deliveries_status_check"
        CHECK ("status" IN (
            'PENDING',
            'PROCESSING',
            'NOT_CONFIGURED',
            'SENT',
            'FAILED',
            'EXPIRED'
        )),
    CONSTRAINT "auth_recovery_deliveries_attempts_check"
        CHECK ("attempts" >= 0),
    CONSTRAINT "auth_recovery_deliveries_lease_check"
        CHECK (
            ("status" = 'PROCESSING' AND "locked_by" IS NOT NULL AND "locked_until" IS NOT NULL)
            OR
            ("status" <> 'PROCESSING' AND "locked_by" IS NULL AND "locked_until" IS NULL)
        ),
    CONSTRAINT "auth_recovery_deliveries_expiry_check"
        CHECK ("expires_at" > "created_at"),
    CONSTRAINT "auth_recovery_deliveries_delivered_at_check"
        CHECK (
            ("status" IN ('SENT', 'NOT_CONFIGURED') AND "delivered_at" IS NOT NULL)
            OR
            ("status" NOT IN ('SENT', 'NOT_CONFIGURED'))
        )
);

CREATE INDEX "auth_recovery_deliveries_claim_idx"
    ON public."auth_recovery_deliveries"(
        "status", "available_at", "locked_until", "created_at", "id"
    );
CREATE INDEX "auth_recovery_deliveries_tenant_status_idx"
    ON public."auth_recovery_deliveries"("tenant_id", "status", "created_at" DESC);
CREATE INDEX "auth_recovery_deliveries_expires_at_idx"
    ON public."auth_recovery_deliveries"("expires_at");

REVOKE ALL PRIVILEGES ON TABLE public."auth_recovery_deliveries" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public."auth_recovery_deliveries"
    FROM enterprise_agent_app, enterprise_agent_outbox, enterprise_agent_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."auth_recovery_deliveries"
    TO enterprise_agent_auth, enterprise_agent_admin;

ALTER TABLE public."auth_recovery_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."auth_recovery_deliveries" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
    ON public."auth_recovery_deliveries"
    AS RESTRICTIVE
    FOR ALL
    TO enterprise_agent_admin
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY auth_recovery_deliveries_auth_access
    ON public."auth_recovery_deliveries"
    AS PERMISSIVE
    FOR ALL
    TO enterprise_agent_auth
    USING (true)
    WITH CHECK (true);

CREATE POLICY auth_recovery_deliveries_admin_access
    ON public."auth_recovery_deliveries"
    AS PERMISSIVE
    FOR ALL
    TO enterprise_agent_admin
    USING (true)
    WITH CHECK (true);

COMMIT;
