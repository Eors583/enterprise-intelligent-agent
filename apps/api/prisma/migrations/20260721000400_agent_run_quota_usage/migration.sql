BEGIN;

ALTER TABLE public."tenants"
    ADD COLUMN "agent_run_concurrency_limit" integer NOT NULL DEFAULT 4,
    ADD COLUMN "agent_run_rate_limit_per_minute" integer NOT NULL DEFAULT 60,
    ADD COLUMN "agent_run_monthly_token_limit" bigint NOT NULL DEFAULT 100000000,
    ADD CONSTRAINT "tenants_agent_run_concurrency_limit_check"
        CHECK ("agent_run_concurrency_limit" BETWEEN 1 AND 1000),
    ADD CONSTRAINT "tenants_agent_run_rate_limit_per_minute_check"
        CHECK ("agent_run_rate_limit_per_minute" BETWEEN 1 AND 100000),
    ADD CONSTRAINT "tenants_agent_run_monthly_token_limit_check"
        CHECK ("agent_run_monthly_token_limit" BETWEEN 1 AND 9223372036854775807);

ALTER TABLE public."agent_runs"
    ADD COLUMN "runtime_provider" varchar(80),
    ADD COLUMN "runtime_model" varchar(256),
    ADD COLUMN "input_tokens" integer NOT NULL DEFAULT 0,
    ADD COLUMN "output_tokens" integer NOT NULL DEFAULT 0,
    ADD COLUMN "total_tokens" integer NOT NULL DEFAULT 0,
    ADD COLUMN "tool_calls" integer NOT NULL DEFAULT 0,
    ADD COLUMN "cost_micros" bigint NOT NULL DEFAULT 0,
    ADD COLUMN "latency_ms" integer,
    ADD COLUMN "reserved_tokens" integer NOT NULL DEFAULT 0,
    ADD COLUMN "usage_recorded_at" timestamptz(6),
    ADD CONSTRAINT "agent_runs_usage_nonnegative_check"
        CHECK (
            "input_tokens" >= 0
            AND "output_tokens" >= 0
            AND "total_tokens" >= 0
            AND "tool_calls" >= 0
            AND "cost_micros" >= 0
            AND "reserved_tokens" >= 0
            AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
        ),
    ADD CONSTRAINT "agent_runs_total_tokens_consistent_check"
        CHECK ("total_tokens" >= GREATEST("input_tokens", "output_tokens"));

CREATE INDEX "agent_runs_tenant_id_finished_at_idx"
    ON public."agent_runs"("tenant_id", "finished_at");
CREATE INDEX "agent_runs_tenant_runtime_model_finished_at_idx"
    ON public."agent_runs"("tenant_id", "runtime_provider", "runtime_model", "finished_at");

-- The existing RLS policies continue to isolate all new columns. Admin only
-- needs tenant quota visibility; mutation remains outside this read-only V1 API.
GRANT SELECT ON TABLE public."tenants" TO enterprise_agent_admin;

COMMIT;
