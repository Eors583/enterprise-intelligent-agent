-- Turn Feishu directory synchronization into an explicit preview-and-apply
-- workflow with durable runs and record-level diagnostics.
BEGIN;

CREATE TYPE public."DirectorySyncPreviewStatus" AS ENUM (
    'READY',
    'APPLIED',
    'EXPIRED'
);

CREATE TYPE public."DirectorySyncRunStatus" AS ENUM (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'DEAD_LETTER'
);

CREATE TYPE public."DirectorySyncEntityType" AS ENUM (
    'DEPARTMENT',
    'MEMBER'
);

CREATE TYPE public."DirectorySyncChangeAction" AS ENUM (
    'CREATE',
    'UPDATE',
    'ARCHIVE',
    'DEACTIVATE',
    'CONFLICT'
);

CREATE TYPE public."DirectorySyncItemApplyStatus" AS ENUM (
    'PENDING',
    'APPLIED',
    'FAILED'
);

ALTER TABLE public."directory_integrations"
    ADD COLUMN "last_preview_cursor" char(64),
    ADD COLUMN "last_applied_cursor" char(64);

ALTER TABLE public."directory_integrations"
    ADD CONSTRAINT "directory_integrations_last_preview_cursor_check"
        CHECK (
            "last_preview_cursor" IS NULL
            OR "last_preview_cursor" ~ '^[0-9a-f]{64}$'
        ),
    ADD CONSTRAINT "directory_integrations_last_applied_cursor_check"
        CHECK (
            "last_applied_cursor" IS NULL
            OR "last_applied_cursor" ~ '^[0-9a-f]{64}$'
        );

CREATE TABLE public."directory_sync_previews" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "integration_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "requested_by_id" uuid NOT NULL,
    "status" public."DirectorySyncPreviewStatus" NOT NULL DEFAULT 'READY',
    "snapshot_cursor" char(64) NOT NULL,
    "summary" jsonb NOT NULL,
    "expires_at" timestamptz(6) NOT NULL,
    "applied_at" timestamptz(6),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "directory_sync_previews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_sync_previews_snapshot_cursor_check"
        CHECK ("snapshot_cursor" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "directory_sync_previews_summary_shape_check"
        CHECK (jsonb_typeof("summary") = 'object'),
    CONSTRAINT "directory_sync_previews_expiry_check"
        CHECK ("expires_at" > "created_at"),
    CONSTRAINT "directory_sync_previews_applied_state_check"
        CHECK (
            (
                "status" = 'APPLIED'::public."DirectorySyncPreviewStatus"
                AND "applied_at" IS NOT NULL
            )
            OR
            (
                "status" <> 'APPLIED'::public."DirectorySyncPreviewStatus"
                AND "applied_at" IS NULL
            )
        )
);

CREATE UNIQUE INDEX "directory_sync_previews_tenant_id_id_key"
    ON public."directory_sync_previews"("tenant_id", "id");
CREATE UNIQUE INDEX "directory_sync_previews_integration_identity_key"
    ON public."directory_sync_previews"(
        "tenant_id", "id", "integration_id", "organization_id"
    );
CREATE UNIQUE INDEX "directory_sync_previews_one_ready_key"
    ON public."directory_sync_previews"("tenant_id", "integration_id")
    WHERE "status" = 'READY'::public."DirectorySyncPreviewStatus";
CREATE INDEX "directory_sync_previews_expiry_idx"
    ON public."directory_sync_previews"(
        "tenant_id", "integration_id", "status", "expires_at"
    );

CREATE TABLE public."directory_sync_preview_items" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "preview_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "entity_type" public."DirectorySyncEntityType" NOT NULL,
    "action" public."DirectorySyncChangeAction" NOT NULL,
    "external_id" varchar(200) NOT NULL,
    "display_name" varchar(200) NOT NULL,
    "local_resource_type" varchar(80),
    "local_resource_id" uuid,
    "field_changes" jsonb NOT NULL DEFAULT '{}',
    "diagnostic_code" varchar(120),
    "apply_status" public."DirectorySyncItemApplyStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "directory_sync_preview_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_sync_preview_items_sequence_check"
        CHECK ("sequence" >= 0),
    CONSTRAINT "directory_sync_preview_items_external_id_check"
        CHECK (length(btrim("external_id")) BETWEEN 1 AND 200),
    CONSTRAINT "directory_sync_preview_items_display_name_check"
        CHECK (length(btrim("display_name")) BETWEEN 1 AND 200),
    CONSTRAINT "directory_sync_preview_items_local_identity_check"
        CHECK (
            ("local_resource_type" IS NULL AND "local_resource_id" IS NULL)
            OR
            (
                length(btrim("local_resource_type")) BETWEEN 1 AND 80
                AND "local_resource_id" IS NOT NULL
            )
        ),
    CONSTRAINT "directory_sync_preview_items_field_changes_shape_check"
        CHECK (jsonb_typeof("field_changes") = 'object')
);

CREATE UNIQUE INDEX "directory_sync_preview_items_tenant_id_id_key"
    ON public."directory_sync_preview_items"("tenant_id", "id");
CREATE UNIQUE INDEX "directory_sync_preview_items_sequence_key"
    ON public."directory_sync_preview_items"("tenant_id", "preview_id", "sequence");
CREATE INDEX "directory_sync_preview_items_diagnostics_idx"
    ON public."directory_sync_preview_items"(
        "tenant_id", "preview_id", "apply_status", "entity_type", "action"
    );

CREATE TABLE public."directory_sync_runs" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "integration_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "preview_id" uuid NOT NULL,
    "requested_by_id" uuid NOT NULL,
    "status" public."DirectorySyncRunStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" varchar(200) NOT NULL,
    "request_hash" char(64) NOT NULL,
    "expected_snapshot_cursor" char(64) NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "max_attempts" integer NOT NULL DEFAULT 4,
    "next_attempt_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" varchar(120),
    "lease_expires_at" timestamptz(6),
    "last_error_code" varchar(120),
    "summary" jsonb,
    "started_at" timestamptz(6),
    "finished_at" timestamptz(6),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "directory_sync_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_sync_runs_idempotency_key_check"
        CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200),
    CONSTRAINT "directory_sync_runs_request_hash_check"
        CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "directory_sync_runs_expected_cursor_check"
        CHECK ("expected_snapshot_cursor" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "directory_sync_runs_attempts_check"
        CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
    CONSTRAINT "directory_sync_runs_lease_shape_check"
        CHECK (
            (
                "status" = 'RUNNING'::public."DirectorySyncRunStatus"
                AND "lease_owner" IS NOT NULL
                AND "lease_expires_at" IS NOT NULL
            )
            OR
            (
                "status" <> 'RUNNING'::public."DirectorySyncRunStatus"
                AND "lease_owner" IS NULL
                AND "lease_expires_at" IS NULL
            )
        ),
    CONSTRAINT "directory_sync_runs_summary_shape_check"
        CHECK ("summary" IS NULL OR jsonb_typeof("summary") = 'object'),
    CONSTRAINT "directory_sync_runs_time_order_check"
        CHECK (
            ("started_at" IS NULL OR "started_at" >= "created_at")
            AND
            (
                "finished_at" IS NULL
                OR ("started_at" IS NOT NULL AND "finished_at" >= "started_at")
            )
        ),
    CONSTRAINT "directory_sync_runs_terminal_state_check"
        CHECK (
            (
                "status" IN (
                    'SUCCEEDED'::public."DirectorySyncRunStatus",
                    'FAILED'::public."DirectorySyncRunStatus",
                    'DEAD_LETTER'::public."DirectorySyncRunStatus"
                )
                AND "finished_at" IS NOT NULL
            )
            OR
            (
                "status" IN (
                    'QUEUED'::public."DirectorySyncRunStatus",
                    'RUNNING'::public."DirectorySyncRunStatus"
                )
                AND "finished_at" IS NULL
            )
        )
);

CREATE UNIQUE INDEX "directory_sync_runs_tenant_id_id_key"
    ON public."directory_sync_runs"("tenant_id", "id");
CREATE UNIQUE INDEX "directory_sync_runs_tenant_id_idempotency_key_key"
    ON public."directory_sync_runs"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "directory_sync_runs_one_active_preview_key"
    ON public."directory_sync_runs"("tenant_id", "preview_id")
    WHERE "status" IN (
        'QUEUED'::public."DirectorySyncRunStatus",
        'RUNNING'::public."DirectorySyncRunStatus"
    );
CREATE INDEX "directory_sync_runs_status_idx"
    ON public."directory_sync_runs"(
        "tenant_id", "integration_id", "status", "created_at" DESC
    );
CREATE INDEX "directory_sync_runs_delivery_claim_idx"
    ON public."directory_sync_runs"(
        "status", "next_attempt_at", "lease_expires_at", "created_at", "id"
    );

ALTER TABLE public."directory_sync_previews"
    ADD CONSTRAINT "directory_sync_previews_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_sync_previews_integration_fkey"
        FOREIGN KEY ("tenant_id", "integration_id", "organization_id")
        REFERENCES public."directory_integrations"(
            "tenant_id", "id", "organization_id"
        )
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_sync_previews_requested_by_fkey"
        FOREIGN KEY ("tenant_id", "requested_by_id")
        REFERENCES public."users"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."directory_sync_preview_items"
    ADD CONSTRAINT "directory_sync_preview_items_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_sync_preview_items_preview_fkey"
        FOREIGN KEY ("tenant_id", "preview_id")
        REFERENCES public."directory_sync_previews"("tenant_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public."directory_sync_runs"
    ADD CONSTRAINT "directory_sync_runs_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_sync_runs_integration_fkey"
        FOREIGN KEY ("tenant_id", "integration_id", "organization_id")
        REFERENCES public."directory_integrations"(
            "tenant_id", "id", "organization_id"
        )
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_sync_runs_preview_fkey"
        FOREIGN KEY ("tenant_id", "preview_id", "integration_id", "organization_id")
        REFERENCES public."directory_sync_previews"(
            "tenant_id", "id", "integration_id", "organization_id"
        )
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "directory_sync_runs_requested_by_fkey"
        FOREIGN KEY ("tenant_id", "requested_by_id")
        REFERENCES public."users"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

DO $directory_sync_rls$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'directory_sync_previews',
        'directory_sync_preview_items',
        'directory_sync_runs'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL '
            'TO PUBLIC '
            'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY enterprise_agent_admin_access ON public.%I AS PERMISSIVE FOR ALL '
            'TO enterprise_agent_admin USING (true) WITH CHECK (true)',
            table_name
        );
    END LOOP;
END
$directory_sync_rls$;

GRANT SELECT, INSERT, UPDATE
    ON TABLE public."directory_sync_previews"
    TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE
    ON TABLE public."directory_sync_preview_items"
    TO enterprise_agent_admin;
GRANT SELECT, INSERT, UPDATE
    ON TABLE public."directory_sync_runs"
    TO enterprise_agent_admin;
GRANT UPDATE (
    "status",
    "available_at",
    "locked_by",
    "locked_until",
    "last_error",
    "provider_name",
    "provider_receipt",
    "published_at"
) ON TABLE public."outbox_events"
    TO enterprise_agent_admin;

-- The cross-tenant worker must be able to claim runs without setting an
-- arbitrary tenant context. Scope the restrictive tenant policy to the
-- tenant-bound admin capability, then add one explicit worker policy.
DROP POLICY tenant_isolation ON public."directory_sync_runs";
CREATE POLICY tenant_isolation
    ON public."directory_sync_runs"
    AS RESTRICTIVE
    FOR ALL
    TO enterprise_agent_admin
    USING (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );
CREATE POLICY enterprise_agent_outbox_access
    ON public."directory_sync_runs"
    AS PERMISSIVE
    FOR ALL
    TO enterprise_agent_outbox
    USING (true)
    WITH CHECK (true);
GRANT SELECT
    ON TABLE public."directory_sync_runs"
    TO enterprise_agent_outbox;
GRANT UPDATE (
    "status",
    "attempts",
    "lease_owner",
    "lease_expires_at",
    "started_at",
    "finished_at",
    "updated_at"
) ON TABLE public."directory_sync_runs"
    TO enterprise_agent_outbox;

COMMIT;
