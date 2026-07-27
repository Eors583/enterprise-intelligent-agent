-- Persist tenant-scoped Agent Runs and relay configuration. Agent execution is
-- driven by a distinct outbox event; the cross-tenant queue role still cannot
-- read business tables and workers must re-enter through the tenant app role.
BEGIN;

CREATE TYPE public."AgentRunStatus" AS ENUM (
    'QUEUED',
    'DISPATCHING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'UNKNOWN',
    'CANCELLED'
);

CREATE TYPE public."AgentRunTrigger" AS ENUM ('USER_MESSAGE', 'RELAY_TURN');

ALTER TABLE public."conversations"
    ADD COLUMN "relay_agent_a_id" uuid,
    ADD COLUMN "relay_agent_b_id" uuid,
    ADD COLUMN "relay_turn_limit" integer,
    ADD CONSTRAINT "conversations_relay_configuration_check"
        CHECK (
            (
                "relay_agent_a_id" IS NULL
                AND "relay_agent_b_id" IS NULL
                AND "relay_turn_limit" IS NULL
            )
            OR (
                "relay_agent_a_id" IS NOT NULL
                AND "relay_agent_b_id" IS NOT NULL
                AND "relay_agent_a_id" <> "relay_agent_b_id"
                AND "relay_turn_limit" BETWEEN 2 AND 8
            )
        );

ALTER TABLE public."conversations"
    ADD CONSTRAINT "conversations_tenant_id_relay_agent_a_id_fkey"
        FOREIGN KEY ("tenant_id", "relay_agent_a_id")
        REFERENCES public."agent_instances"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "conversations_tenant_id_relay_agent_b_id_fkey"
        FOREIGN KEY ("tenant_id", "relay_agent_b_id")
        REFERENCES public."agent_instances"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- Agent Runs refer to messages through tenant-scoped keys. Message ids remain
-- globally unique, while this candidate key proves tenant ownership to every FK.
ALTER TABLE public."messages"
    ADD CONSTRAINT "messages_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
    ADD CONSTRAINT "messages_tenant_id_conversation_id_id_key"
        UNIQUE ("tenant_id", "conversation_id", "id");

CREATE TABLE public."agent_runs" (
    "id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "conversation_id" uuid NOT NULL,
    "input_message_id" uuid NOT NULL,
    "output_message_id" uuid,
    "requester_user_id" uuid NOT NULL,
    "agent_id" uuid NOT NULL,
    "agent_version_id" uuid NOT NULL,
    "parent_run_id" uuid,
    "trigger" public."AgentRunTrigger" NOT NULL DEFAULT 'USER_MESSAGE',
    "turn_index" integer NOT NULL DEFAULT 1,
    "turn_limit" integer NOT NULL DEFAULT 1,
    "status" public."AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" varchar(80) NOT NULL DEFAULT 'ai-runtime',
    "external_run_id" uuid,
    "idempotency_key" varchar(200) NOT NULL,
    "policy_snapshot" jsonb NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "version" integer NOT NULL DEFAULT 1,
    "error_code" varchar(120),
    "error_message" text,
    "dispatch_started_at" timestamptz(6),
    "started_at" timestamptz(6),
    "finished_at" timestamptz(6),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_runs_turn_bounds_check"
        CHECK (
            "turn_limit" BETWEEN 1 AND 8
            AND "turn_index" BETWEEN 1 AND "turn_limit"
        ),
    CONSTRAINT "agent_runs_attempts_nonnegative_check" CHECK ("attempts" >= 0),
    CONSTRAINT "agent_runs_version_positive_check" CHECK ("version" > 0),
    CONSTRAINT "agent_runs_trigger_chain_check"
        CHECK (
            (
                "trigger" = 'USER_MESSAGE'::public."AgentRunTrigger"
                AND "parent_run_id" IS NULL
                AND "turn_index" = 1
            )
            OR (
                "trigger" = 'RELAY_TURN'::public."AgentRunTrigger"
                AND "parent_run_id" IS NOT NULL
                AND "turn_index" >= 2
            )
        )
);

CREATE UNIQUE INDEX "agent_runs_tenant_id_id_key"
    ON public."agent_runs"("tenant_id", "id");
CREATE UNIQUE INDEX "agent_runs_tenant_id_input_message_id_agent_id_key"
    ON public."agent_runs"("tenant_id", "input_message_id", "agent_id");
CREATE UNIQUE INDEX "agent_runs_tenant_id_output_message_id_key"
    ON public."agent_runs"("tenant_id", "output_message_id");
CREATE UNIQUE INDEX "agent_runs_tenant_id_parent_run_id_key"
    ON public."agent_runs"("tenant_id", "parent_run_id");
CREATE UNIQUE INDEX "agent_runs_tenant_id_idempotency_key_key"
    ON public."agent_runs"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "agent_runs_tenant_id_provider_external_run_id_key"
    ON public."agent_runs"("tenant_id", "provider", "external_run_id");
CREATE INDEX "agent_runs_tenant_id_status_created_at_idx"
    ON public."agent_runs"("tenant_id", "status", "created_at");
CREATE INDEX "agent_runs_tenant_id_conversation_id_turn_index_idx"
    ON public."agent_runs"("tenant_id", "conversation_id", "turn_index");
CREATE INDEX "agent_runs_tenant_id_conversation_id_status_created_at_id_idx"
    ON public."agent_runs"("tenant_id", "conversation_id", "status", "created_at", "id");
CREATE UNIQUE INDEX "agent_runs_one_active_per_conversation_idx"
    ON public."agent_runs"("tenant_id", "conversation_id")
    WHERE "status" IN (
          'QUEUED'::public."AgentRunStatus",
          'DISPATCHING'::public."AgentRunStatus",
          'RUNNING'::public."AgentRunStatus",
          'UNKNOWN'::public."AgentRunStatus"
      );

ALTER TABLE public."agent_runs"
    ADD CONSTRAINT "agent_runs_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_conversation_id_fkey"
        FOREIGN KEY ("tenant_id", "conversation_id")
        REFERENCES public."conversations"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_input_message_id_fkey"
        FOREIGN KEY ("tenant_id", "conversation_id", "input_message_id")
        REFERENCES public."messages"("tenant_id", "conversation_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_output_message_id_fkey"
        FOREIGN KEY ("tenant_id", "conversation_id", "output_message_id")
        REFERENCES public."messages"("tenant_id", "conversation_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_requester_user_id_fkey"
        FOREIGN KEY ("tenant_id", "requester_user_id")
        REFERENCES public."users"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_agent_id_fkey"
        FOREIGN KEY ("tenant_id", "agent_id")
        REFERENCES public."agent_instances"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_agent_version_id_fkey"
        FOREIGN KEY ("tenant_id", "agent_version_id")
        REFERENCES public."agent_versions"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "agent_runs_tenant_id_parent_run_id_fkey"
        FOREIGN KEY ("tenant_id", "parent_run_id")
        REFERENCES public."agent_runs"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON TABLE public."agent_runs" TO enterprise_agent_app;

ALTER TABLE public."agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."agent_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public."agent_runs"
AS RESTRICTIVE
FOR ALL
TO enterprise_agent_app
USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

CREATE POLICY enterprise_agent_access
ON public."agent_runs"
AS PERMISSIVE
FOR ALL
TO enterprise_agent_app
USING (true)
WITH CHECK (true);

COMMIT;
