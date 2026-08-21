-- P0-4 Tool Gateway control-plane and immutable execution ledger.
-- The model never writes these tables directly. A dedicated capability role
-- executes a validated command, while every state change is covered by one
-- immutable command, receipt, audit record, and transactional outbox event.

CREATE TYPE public."ToolDefinitionStatus" AS ENUM (
  'DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED'
);
CREATE TYPE public."ToolExecutionAdapter" AS ENUM (
  'HTTP', 'INTERNAL', 'DATABASE', 'QUEUE'
);
CREATE TYPE public."ToolRiskClass" AS ENUM (
  'READ_ONLY',
  'DRAFT_ONLY',
  'CONFIRM_REQUIRED',
  'HIGH_RISK_APPROVAL',
  'FORBIDDEN'
);
CREATE TYPE public."ToolDataClassification" AS ENUM (
  'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
);
CREATE TYPE public."ToolIdempotencyMode" AS ENUM (
  'REQUIRED', 'PROVIDER_SUPPORTED', 'SYSTEM_LEDGER'
);
CREATE TYPE public."ToolDryRunMode" AS ENUM (
  'NATIVE', 'VALIDATE_ONLY', 'UNSUPPORTED'
);
CREATE TYPE public."ToolInvocationStatus" AS ENUM (
  'REQUESTED',
  'POLICY_DENIED',
  'PENDING_CONFIRMATION',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED'
);
CREATE TYPE public."ToolInvocationCommandType" AS ENUM (
  'DENY',
  'REQUEST_CONFIRMATION',
  'CONFIRM',
  'REQUEST_APPROVAL',
  'APPROVE',
  'REJECT',
  'START',
  'SUCCEED',
  'FAIL',
  'MARK_UNKNOWN',
  'CANCEL_CONFIRMED',
  'BEGIN_COMPENSATION',
  'COMPLETE_COMPENSATION',
  'FAIL_COMPENSATION'
);
CREATE TYPE public."ToolInvocationActorType" AS ENUM (
  'USER', 'SYSTEM', 'PROVIDER'
);
CREATE TYPE public."ToolApprovalDecision" AS ENUM (
  'APPROVED', 'REJECTED'
);
CREATE TYPE public."ToolExecutionReceiptSource" AS ENUM (
  'PROVIDER', 'GATEWAY_VALIDATOR', 'COMPENSATOR'
);
CREATE TYPE public."ToolExecutionReceiptOutcome" AS ENUM (
  'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED',
  'COMPENSATED', 'COMPENSATION_FAILED'
);
CREATE TYPE public."ToolDnsDecision" AS ENUM ('ALLOWED', 'DENIED');

CREATE TABLE public."tool_definitions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "status" public."ToolDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
  "current_version_id" UUID,
  "current_version" INTEGER,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_definitions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_definitions_tenant_key_key" UNIQUE ("tenant_id", "key"),
  CONSTRAINT "tool_definitions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "tool_definitions_key_check" CHECK (
    "key" ~ '^[a-z][a-z0-9_.-]{2,99}$'
  ),
  CONSTRAINT "tool_definitions_text_check" CHECK (
    btrim("name") <> '' AND btrim("description") <> ''
  ),
  CONSTRAINT "tool_definitions_current_version_pair_check" CHECK (
    ("current_version_id" IS NULL) = ("current_version" IS NULL)
  ),
  CONSTRAINT "tool_definitions_status_current_version_check" CHECK (
    "status" NOT IN ('PUBLISHED', 'RETIRED')
    OR ("current_version_id" IS NOT NULL AND "current_version" > 0)
  ),
  CONSTRAINT "tool_definitions_permission_labels_array_check" CHECK (
    jsonb_typeof("permission_labels") = 'array'
  )
);

CREATE TABLE public."tool_versions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tool_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "status" public."ToolDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
  "adapter" public."ToolExecutionAdapter" NOT NULL,
  "endpoint_ref" VARCHAR(300) NOT NULL,
  "input_schema" JSONB NOT NULL,
  "output_schema" JSONB NOT NULL,
  "risk_class" public."ToolRiskClass" NOT NULL,
  "data_classification" public."ToolDataClassification" NOT NULL,
  "timeout_ms" INTEGER NOT NULL,
  "max_attempts" INTEGER NOT NULL,
  "idempotency_mode" public."ToolIdempotencyMode" NOT NULL,
  "dry_run_mode" public."ToolDryRunMode" NOT NULL,
  "allowed_http_methods" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "allowed_host_patterns" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sensitive_input_paths" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "compensation_tool_version_id" UUID,
  "configuration_hash" VARCHAR(64) NOT NULL,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "published_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_versions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_versions_tenant_tool_id_id_key" UNIQUE (
    "tenant_id", "tool_id", "id"
  ),
  CONSTRAINT "tool_versions_tenant_tool_version_key" UNIQUE (
    "tenant_id", "tool_id", "version"
  ),
  CONSTRAINT "tool_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "tool_versions_key_check" CHECK (
    "key" ~ '^[a-z][a-z0-9_.-]{2,99}$'
  ),
  CONSTRAINT "tool_versions_text_check" CHECK (
    btrim("name") <> ''
    AND btrim("description") <> ''
    AND btrim("endpoint_ref") <> ''
  ),
  CONSTRAINT "tool_versions_schema_object_check" CHECK (
    jsonb_typeof("input_schema") = 'object'
    AND jsonb_typeof("output_schema") = 'object'
    AND "input_schema"->>'type' = 'object'
    AND "output_schema"->>'type' = 'object'
    AND "input_schema"->'additionalProperties' = 'false'::jsonb
    AND "output_schema"->'additionalProperties' = 'false'::jsonb
  ),
  CONSTRAINT "tool_versions_execution_limits_check" CHECK (
    "timeout_ms" BETWEEN 100 AND 120000
    AND "max_attempts" BETWEEN 1 AND 5
  ),
  CONSTRAINT "tool_versions_json_arrays_check" CHECK (
    jsonb_typeof("allowed_http_methods") = 'array'
    AND jsonb_typeof("allowed_host_patterns") = 'array'
    AND jsonb_typeof("sensitive_input_paths") = 'array'
    AND jsonb_array_length("allowed_http_methods") <= 5
    AND jsonb_array_length("allowed_host_patterns") <= 100
  ),
  CONSTRAINT "tool_versions_http_configuration_check" CHECK (
    (
      "adapter" = 'HTTP'
      AND jsonb_array_length("allowed_http_methods") > 0
      AND jsonb_array_length("allowed_host_patterns") > 0
    )
    OR (
      "adapter" <> 'HTTP'
      AND "allowed_http_methods" = '[]'::jsonb
      AND "allowed_host_patterns" = '[]'::jsonb
    )
  ),
  CONSTRAINT "tool_versions_read_only_http_check" CHECK (
    "adapter" <> 'HTTP'
    OR "risk_class" <> 'READ_ONLY'
    OR NOT jsonb_path_exists(
      "allowed_http_methods",
      '$[*] ? (@ != "GET")'
    )
  ),
  CONSTRAINT "tool_versions_draft_http_check" CHECK (
    "adapter" <> 'HTTP'
    OR "risk_class" <> 'DRAFT_ONLY'
    OR NOT ("allowed_http_methods" ? 'DELETE')
  ),
  CONSTRAINT "tool_versions_forbidden_publish_check" CHECK (
    "risk_class" <> 'FORBIDDEN' OR "status" <> 'PUBLISHED'
  ),
  CONSTRAINT "tool_versions_effective_period_check" CHECK (
    "effective_to" IS NULL OR "effective_to" > "effective_from"
  ),
  CONSTRAINT "tool_versions_publish_time_check" CHECK (
    ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL)
    AND ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL)
  ),
  CONSTRAINT "tool_versions_configuration_hash_check" CHECK (
    "configuration_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tool_versions_no_self_compensation_check" CHECK (
    "compensation_tool_version_id" IS NULL
    OR "compensation_tool_version_id" <> "id"
  )
);

ALTER TABLE public."tool_definitions"
  ADD CONSTRAINT "tool_definitions_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_definitions_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."tool_versions"
  ADD CONSTRAINT "tool_versions_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_versions_tool_fkey"
  FOREIGN KEY ("tenant_id", "tool_id")
  REFERENCES public."tool_definitions" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_versions_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_versions_creator_fkey"
  FOREIGN KEY ("tenant_id", "created_by_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_versions_compensation_fkey"
  FOREIGN KEY ("tenant_id", "compensation_tool_version_id")
  REFERENCES public."tool_versions" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."tool_definitions"
  ADD CONSTRAINT "tool_definitions_current_version_fkey"
  FOREIGN KEY ("tenant_id", "id", "current_version_id")
  REFERENCES public."tool_versions" ("tenant_id", "tool_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "tool_definitions_tenant_status_idx"
  ON public."tool_definitions" ("tenant_id", "status", "name");
CREATE INDEX "tool_versions_tenant_status_effective_idx"
  ON public."tool_versions" (
    "tenant_id", "status", "effective_from", "effective_to"
  );

CREATE TABLE public."tool_invocations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tool_id" UUID NOT NULL,
  "tool_version_id" UUID NOT NULL,
  "tool_version" INTEGER NOT NULL,
  "tool_configuration_hash" VARCHAR(64) NOT NULL,
  "adapter" public."ToolExecutionAdapter" NOT NULL,
  "risk_class" public."ToolRiskClass" NOT NULL,
  "data_classification" public."ToolDataClassification" NOT NULL,
  "idempotency_mode" public."ToolIdempotencyMode" NOT NULL,
  "dry_run_mode" public."ToolDryRunMode" NOT NULL,
  "requester_user_id" UUID NOT NULL,
  "role_assignment_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "process_instance_id" UUID,
  "process_step_instance_id" UUID,
  "agent_run_id" UUID,
  "correlation_id" UUID NOT NULL,
  "causation_id" UUID,
  "retry_of_invocation_id" UUID,
  "compensation_for_invocation_id" UUID,
  "status" public."ToolInvocationStatus" NOT NULL DEFAULT 'REQUESTED',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,
  "provider_dispatch_allowed" BOOLEAN NOT NULL,
  "provider_dry_run" BOOLEAN NOT NULL,
  "input" JSONB NOT NULL,
  "input_hash" VARCHAR(64) NOT NULL,
  "redacted_input_summary" JSONB NOT NULL,
  "policy_decision_id" VARCHAR(200) NOT NULL,
  "policy_snapshot" JSONB NOT NULL,
  "confirmed_by_user_id" UUID,
  "confirmed_by_role_assignment_id" UUID,
  "confirmed_at" TIMESTAMPTZ(6),
  "confirmation_reason" VARCHAR(500),
  "confirmation_proof_hash" VARCHAR(64),
  "confirmation_issued_at" TIMESTAMPTZ(6),
  "confirmation_expires_at" TIMESTAMPTZ(6),
  "approver_user_id" UUID,
  "approver_role_assignment_id" UUID,
  "approval_decision" public."ToolApprovalDecision",
  "approval_decided_at" TIMESTAMPTZ(6),
  "approval_reason" VARCHAR(500),
  "approval_proof_hash" VARCHAR(64),
  "approval_issued_at" TIMESTAMPTZ(6),
  "approval_expires_at" TIMESTAMPTZ(6),
  "execution_attempt" INTEGER NOT NULL DEFAULT 0,
  "provider_request_id" VARCHAR(300),
  "output" JSONB,
  "output_hash" VARCHAR(64),
  "error_code" VARCHAR(160),
  "error_detail" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_invocations_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_invocations_tenant_id_id_revision_key" UNIQUE (
    "tenant_id", "id", "revision"
  ),
  CONSTRAINT "tool_invocations_idempotency_key" UNIQUE (
    "tenant_id", "tool_version_id", "idempotency_key"
  ),
  CONSTRAINT "tool_invocations_provider_request_key" UNIQUE (
    "tenant_id", "tool_version_id", "provider_request_id"
  ),
  CONSTRAINT "tool_invocations_version_revision_check" CHECK (
    "tool_version" > 0 AND "revision" > 0
  ),
  CONSTRAINT "tool_invocations_hash_check" CHECK (
    "tool_configuration_hash" ~ '^[0-9a-f]{64}$'
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND ("output_hash" IS NULL OR "output_hash" ~ '^[0-9a-f]{64}$')
    AND (
      "confirmation_proof_hash" IS NULL
      OR "confirmation_proof_hash" ~ '^[0-9a-f]{64}$'
    )
    AND (
      "approval_proof_hash" IS NULL
      OR "approval_proof_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "tool_invocations_json_object_check" CHECK (
    jsonb_typeof("input") = 'object'
    AND jsonb_typeof("redacted_input_summary") = 'object'
    AND jsonb_typeof("policy_snapshot") = 'object'
    AND ("output" IS NULL OR jsonb_typeof("output") = 'object')
  ),
  CONSTRAINT "tool_invocations_text_check" CHECK (
    btrim("idempotency_key") <> '' AND btrim("policy_decision_id") <> ''
  ),
  CONSTRAINT "tool_invocations_process_context_check" CHECK (
    "process_step_instance_id" IS NULL OR "process_instance_id" IS NOT NULL
  ),
  CONSTRAINT "tool_invocations_lineage_check" CHECK (
    ("retry_of_invocation_id" IS NULL OR "retry_of_invocation_id" <> "id")
    AND (
      "compensation_for_invocation_id" IS NULL
      OR "compensation_for_invocation_id" <> "id"
    )
  ),
  CONSTRAINT "tool_invocations_execution_attempt_check" CHECK (
    "execution_attempt" BETWEEN 0 AND 100
  ),
  CONSTRAINT "tool_invocations_output_pair_check" CHECK (
    ("output" IS NULL) = ("output_hash" IS NULL)
  ),
  CONSTRAINT "tool_invocations_error_pair_check" CHECK (
    ("error_code" IS NULL) = ("error_detail" IS NULL)
  ),
  CONSTRAINT "tool_invocations_confirmation_tuple_check" CHECK (
    (
      "confirmed_by_user_id" IS NULL
      AND "confirmed_by_role_assignment_id" IS NULL
      AND "confirmed_at" IS NULL
      AND "confirmation_reason" IS NULL
      AND "confirmation_proof_hash" IS NULL
      AND "confirmation_issued_at" IS NULL
      AND "confirmation_expires_at" IS NULL
    )
    OR (
      "confirmed_by_user_id" IS NOT NULL
      AND "confirmed_by_role_assignment_id" IS NOT NULL
      AND "confirmed_at" IS NOT NULL
      AND btrim("confirmation_reason") <> ''
      AND "confirmation_proof_hash" IS NOT NULL
      AND "confirmation_issued_at" IS NOT NULL
      AND "confirmation_expires_at" > "confirmation_issued_at"
      AND "confirmed_at" BETWEEN "confirmation_issued_at" AND "confirmation_expires_at"
    )
  ),
  CONSTRAINT "tool_invocations_approval_tuple_check" CHECK (
    (
      "approver_user_id" IS NULL
      AND "approver_role_assignment_id" IS NULL
      AND "approval_decision" IS NULL
      AND "approval_decided_at" IS NULL
      AND "approval_reason" IS NULL
      AND "approval_proof_hash" IS NULL
      AND "approval_issued_at" IS NULL
      AND "approval_expires_at" IS NULL
    )
    OR (
      "approver_user_id" IS NOT NULL
      AND "approver_role_assignment_id" IS NOT NULL
      AND "approval_decision" IS NOT NULL
      AND "approval_decided_at" IS NOT NULL
      AND btrim("approval_reason") <> ''
      AND "approval_proof_hash" IS NOT NULL
      AND "approval_issued_at" IS NOT NULL
      AND "approval_expires_at" > "approval_issued_at"
      AND "approval_decided_at" BETWEEN "approval_issued_at" AND "approval_expires_at"
    )
  ),
  CONSTRAINT "tool_invocations_independent_approval_check" CHECK (
    "approver_user_id" IS NULL
    OR (
      "approver_user_id" <> "requester_user_id"
      AND "approver_role_assignment_id" <> "role_assignment_id"
    )
  ),
  CONSTRAINT "tool_invocations_gate_state_check" CHECK (
    (
      "status" IN ('REQUESTED', 'POLICY_DENIED', 'PENDING_CONFIRMATION')
      AND "confirmed_by_user_id" IS NULL
      AND "approver_user_id" IS NULL
    )
    OR (
      "status" = 'PENDING_APPROVAL'
      AND "risk_class" = 'HIGH_RISK_APPROVAL'
      AND "confirmed_by_user_id" IS NOT NULL
      AND "approver_user_id" IS NULL
    )
    OR "status" IN (
      'APPROVED', 'REJECTED', 'EXECUTING', 'SUCCEEDED', 'FAILED',
      'UNKNOWN', 'CANCELLED', 'COMPENSATING', 'COMPENSATED',
      'COMPENSATION_FAILED'
    )
  ),
  CONSTRAINT "tool_invocations_approval_risk_check" CHECK (
    "approver_user_id" IS NULL OR "risk_class" = 'HIGH_RISK_APPROVAL'
  ),
  CONSTRAINT "tool_invocations_dry_run_dispatch_check" CHECK (
    (
      NOT "dry_run"
      AND (
        ("risk_class" <> 'FORBIDDEN' AND "provider_dispatch_allowed")
        OR ("risk_class" = 'FORBIDDEN' AND NOT "provider_dispatch_allowed")
      )
      AND NOT "provider_dry_run"
    )
    OR (
      "dry_run"
      AND "dry_run_mode" = 'NATIVE'
      AND "provider_dispatch_allowed"
      AND "provider_dry_run"
    )
    OR (
      "dry_run"
      AND "dry_run_mode" IN ('VALIDATE_ONLY', 'UNSUPPORTED')
      AND NOT "provider_dispatch_allowed"
      AND NOT "provider_dry_run"
    )
  ),
  CONSTRAINT "tool_invocations_forbidden_dispatch_check" CHECK (
    "risk_class" <> 'FORBIDDEN' OR NOT "provider_dispatch_allowed"
  ),
  CONSTRAINT "tool_invocations_terminal_shape_check" CHECK (
    (
      "status" = 'SUCCEEDED'
      AND "output" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "status" IN ('FAILED', 'COMPENSATION_FAILED')
      AND "error_code" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "status" IN ('POLICY_DENIED', 'REJECTED', 'CANCELLED', 'COMPENSATED')
      AND "completed_at" IS NOT NULL
    )
    OR "status" IN (
      'REQUESTED', 'PENDING_CONFIRMATION', 'PENDING_APPROVAL',
      'APPROVED', 'EXECUTING', 'UNKNOWN', 'COMPENSATING'
    )
  ),
  CONSTRAINT "tool_invocations_started_time_check" CHECK (
    "status" NOT IN (
      'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN',
      'COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED'
    )
    OR "started_at" IS NOT NULL
  ),
  CONSTRAINT "tool_invocations_time_order_check" CHECK (
    ("started_at" IS NULL OR "started_at" >= "created_at")
    AND (
      "completed_at" IS NULL
      OR "completed_at" >= COALESCE("started_at", "created_at")
    )
  ),
  CONSTRAINT "tool_invocations_draft_output_check" CHECK (
    "risk_class" <> 'DRAFT_ONLY'
    OR "status" <> 'SUCCEEDED'
    OR "output"->>'artifactMode' = 'DRAFT'
  )
);

ALTER TABLE public."tool_invocations"
  ADD CONSTRAINT "tool_invocations_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_tool_version_fkey"
  FOREIGN KEY ("tenant_id", "tool_id", "tool_version_id")
  REFERENCES public."tool_versions" ("tenant_id", "tool_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_requester_fkey"
  FOREIGN KEY ("tenant_id", "requester_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_assignment_fkey"
  FOREIGN KEY ("tenant_id", "role_assignment_id")
  REFERENCES public."role_assignments" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_task_fkey"
  FOREIGN KEY ("tenant_id", "task_id")
  REFERENCES public."tasks" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_process_fkey"
  FOREIGN KEY ("tenant_id", "process_instance_id")
  REFERENCES public."process_instances" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_step_fkey"
  FOREIGN KEY ("tenant_id", "process_step_instance_id")
  REFERENCES public."process_step_instances" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_agent_run_fkey"
  FOREIGN KEY ("tenant_id", "agent_run_id")
  REFERENCES public."agent_runs" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_retry_fkey"
  FOREIGN KEY ("tenant_id", "retry_of_invocation_id")
  REFERENCES public."tool_invocations" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_compensation_fkey"
  FOREIGN KEY ("tenant_id", "compensation_for_invocation_id")
  REFERENCES public."tool_invocations" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_confirmer_fkey"
  FOREIGN KEY ("tenant_id", "confirmed_by_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_confirmer_assignment_fkey"
  FOREIGN KEY ("tenant_id", "confirmed_by_role_assignment_id")
  REFERENCES public."role_assignments" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_approver_fkey"
  FOREIGN KEY ("tenant_id", "approver_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocations_approver_assignment_fkey"
  FOREIGN KEY ("tenant_id", "approver_role_assignment_id")
  REFERENCES public."role_assignments" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "tool_invocations_tenant_requester_status_idx"
  ON public."tool_invocations" (
    "tenant_id", "requester_user_id", "status", "created_at" DESC
  );
CREATE INDEX "tool_invocations_tenant_task_status_idx"
  ON public."tool_invocations" (
    "tenant_id", "task_id", "status", "created_at" DESC
  );
CREATE INDEX "tool_invocations_tenant_pending_idx"
  ON public."tool_invocations" ("tenant_id", "status", "updated_at")
  WHERE "status" IN (
    'REQUESTED', 'PENDING_CONFIRMATION', 'PENDING_APPROVAL',
    'APPROVED', 'EXECUTING', 'UNKNOWN', 'COMPENSATING'
  );

CREATE TABLE public."tool_invocation_commands" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tool_invocation_id" UUID NOT NULL,
  "command" public."ToolInvocationCommandType" NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "result_revision" INTEGER NOT NULL,
  "actor_type" public."ToolInvocationActorType" NOT NULL,
  "actor_user_id" UUID,
  "actor_role_assignment_id" UUID,
  "actor_service_principal_id" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "policy_proof" JSONB,
  "confirmation_proof" JSONB,
  "approval_proof" JSONB,
  "provider_proof" JSONB,
  "compensation_proof" JSONB,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_invocation_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_invocation_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_invocation_commands_revision_key" UNIQUE (
    "tenant_id", "tool_invocation_id", "expected_revision"
  ),
  CONSTRAINT "tool_invocation_commands_idempotency_key" UNIQUE (
    "tenant_id", "idempotency_key"
  ),
  CONSTRAINT "tool_invocation_commands_revision_check" CHECK (
    "expected_revision" > 0
    AND "result_revision" = "expected_revision" + 1
  ),
  CONSTRAINT "tool_invocation_commands_actor_shape_check" CHECK (
    (
      "actor_type" = 'USER'
      AND "actor_user_id" IS NOT NULL
      AND "actor_role_assignment_id" IS NOT NULL
      AND "actor_service_principal_id" IS NULL
    )
    OR (
      "actor_type" IN ('SYSTEM', 'PROVIDER')
      AND "actor_user_id" IS NULL
      AND "actor_role_assignment_id" IS NULL
      AND "actor_service_principal_id" IS NOT NULL
    )
  ),
  CONSTRAINT "tool_invocation_commands_text_hash_check" CHECK (
    btrim("reason") <> ''
    AND btrim("idempotency_key") <> ''
    AND "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tool_invocation_commands_proof_object_check" CHECK (
    ("policy_proof" IS NULL OR jsonb_typeof("policy_proof") = 'object')
    AND (
      "confirmation_proof" IS NULL
      OR jsonb_typeof("confirmation_proof") = 'object'
    )
    AND ("approval_proof" IS NULL OR jsonb_typeof("approval_proof") = 'object')
    AND ("provider_proof" IS NULL OR jsonb_typeof("provider_proof") = 'object')
    AND (
      "compensation_proof" IS NULL
      OR jsonb_typeof("compensation_proof") = 'object'
    )
  )
);

ALTER TABLE public."tool_invocation_commands"
  ADD CONSTRAINT "tool_invocation_commands_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocation_commands_invocation_fkey"
  FOREIGN KEY ("tenant_id", "tool_invocation_id")
  REFERENCES public."tool_invocations" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocation_commands_user_fkey"
  FOREIGN KEY ("tenant_id", "actor_user_id")
  REFERENCES public."users" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_invocation_commands_assignment_fkey"
  FOREIGN KEY ("tenant_id", "actor_role_assignment_id")
  REFERENCES public."role_assignments" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE public."tool_execution_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tool_invocation_id" UUID NOT NULL,
  "invocation_revision" INTEGER NOT NULL,
  "execution_attempt" INTEGER NOT NULL,
  "source" public."ToolExecutionReceiptSource" NOT NULL,
  "outcome" public."ToolExecutionReceiptOutcome" NOT NULL,
  "provider_request_id" VARCHAR(300),
  "input_hash" VARCHAR(64) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "response_hash" VARCHAR(64),
  "provider_dry_run" BOOLEAN NOT NULL,
  "draft_output" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL,
  "latency_ms" INTEGER NOT NULL,
  "cost_micros" BIGINT NOT NULL DEFAULT 0,
  "receipt_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_execution_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_execution_receipts_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_execution_receipts_attempt_key" UNIQUE (
    "tenant_id", "tool_invocation_id", "execution_attempt", "source"
  ),
  CONSTRAINT "tool_execution_receipts_provider_request_key" UNIQUE (
    "tenant_id", "provider_request_id"
  ),
  CONSTRAINT "tool_execution_receipts_revision_attempt_check" CHECK (
    "invocation_revision" > 0
    AND "execution_attempt" BETWEEN 0 AND 100
  ),
  CONSTRAINT "tool_execution_receipts_hash_check" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("response_hash" IS NULL OR "response_hash" ~ '^[0-9a-f]{64}$')
    AND "receipt_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tool_execution_receipts_time_check" CHECK (
    "completed_at" >= "started_at"
    AND "latency_ms" >= 0
    AND "cost_micros" >= 0
  ),
  CONSTRAINT "tool_execution_receipts_source_check" CHECK (
    (
      "source" = 'GATEWAY_VALIDATOR'
      AND "provider_request_id" IS NULL
      AND NOT "provider_dry_run"
    )
    OR (
      "source" IN ('PROVIDER', 'COMPENSATOR')
      AND "provider_request_id" IS NOT NULL
    )
  ),
  CONSTRAINT "tool_execution_receipts_response_check" CHECK (
    "outcome" IN ('FAILED', 'UNKNOWN', 'CANCELLED', 'COMPENSATION_FAILED')
    OR "response_hash" IS NOT NULL
  )
);
ALTER TABLE public."tool_execution_receipts"
  ADD CONSTRAINT "tool_execution_receipts_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_execution_receipts_invocation_fkey"
  FOREIGN KEY ("tenant_id", "tool_invocation_id")
  REFERENCES public."tool_invocations" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE public."tool_dns_resolution_proofs" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tool_invocation_id" UUID NOT NULL,
  "invocation_revision" INTEGER NOT NULL,
  "redirect_index" INTEGER NOT NULL DEFAULT 0,
  "requested_url_hash" VARCHAR(64) NOT NULL,
  "redirect_from_url_hash" VARCHAR(64),
  "hostname" VARCHAR(253) NOT NULL,
  "port" INTEGER NOT NULL,
  "tls_server_name" VARCHAR(253) NOT NULL,
  "resolved_ip_addresses" JSONB NOT NULL,
  "pinned_ip_address" INET,
  "resolver_name" VARCHAR(160) NOT NULL,
  "ttl_seconds" INTEGER NOT NULL,
  "decision" public."ToolDnsDecision" NOT NULL,
  "decision_reason" VARCHAR(500) NOT NULL,
  "resolved_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "proof_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_dns_resolution_proofs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_dns_resolution_proofs_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tool_dns_resolution_proofs_redirect_key" UNIQUE (
    "tenant_id", "tool_invocation_id", "invocation_revision", "redirect_index"
  ),
  CONSTRAINT "tool_dns_resolution_proofs_revision_redirect_check" CHECK (
    "invocation_revision" > 0 AND "redirect_index" BETWEEN 0 AND 20
  ),
  CONSTRAINT "tool_dns_resolution_proofs_hash_check" CHECK (
    "requested_url_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "redirect_from_url_hash" IS NULL
      OR "redirect_from_url_hash" ~ '^[0-9a-f]{64}$'
    )
    AND "proof_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tool_dns_resolution_proofs_network_check" CHECK (
    "port" BETWEEN 1 AND 65535
    AND jsonb_typeof("resolved_ip_addresses") = 'array'
    AND jsonb_array_length("resolved_ip_addresses") > 0
    AND "ttl_seconds" BETWEEN 1 AND 86400
    AND "expires_at" > "resolved_at"
    AND "expires_at"
      <= "resolved_at" + make_interval(secs => "ttl_seconds")
  ),
  CONSTRAINT "tool_dns_resolution_proofs_decision_pin_check" CHECK (
    ("decision" = 'ALLOWED' AND "pinned_ip_address" IS NOT NULL)
    OR ("decision" = 'DENIED' AND "pinned_ip_address" IS NULL)
  ),
  CONSTRAINT "tool_dns_resolution_proofs_redirect_check" CHECK (
    ("redirect_index" = 0 AND "redirect_from_url_hash" IS NULL)
    OR ("redirect_index" > 0 AND "redirect_from_url_hash" IS NOT NULL)
  ),
  CONSTRAINT "tool_dns_resolution_proofs_public_pin_check" CHECK (
    "pinned_ip_address" IS NULL
    OR NOT (
      "pinned_ip_address" <<= inet '0.0.0.0/8'
      OR "pinned_ip_address" <<= inet '10.0.0.0/8'
      OR "pinned_ip_address" <<= inet '100.64.0.0/10'
      OR "pinned_ip_address" <<= inet '127.0.0.0/8'
      OR "pinned_ip_address" <<= inet '169.254.0.0/16'
      OR "pinned_ip_address" <<= inet '172.16.0.0/12'
      OR "pinned_ip_address" <<= inet '192.0.0.0/24'
      OR "pinned_ip_address" <<= inet '192.0.2.0/24'
      OR "pinned_ip_address" <<= inet '192.168.0.0/16'
      OR "pinned_ip_address" <<= inet '198.18.0.0/15'
      OR "pinned_ip_address" <<= inet '198.51.100.0/24'
      OR "pinned_ip_address" <<= inet '203.0.113.0/24'
      OR "pinned_ip_address" <<= inet '224.0.0.0/4'
      OR "pinned_ip_address" <<= inet '240.0.0.0/4'
      OR "pinned_ip_address" <<= inet '::/128'
      OR "pinned_ip_address" <<= inet '::1/128'
      OR "pinned_ip_address" <<= inet 'fc00::/7'
      OR "pinned_ip_address" <<= inet 'fe80::/10'
      OR "pinned_ip_address" <<= inet 'ff00::/8'
      OR "pinned_ip_address" <<= inet '2001:db8::/32'
    )
  ),
  CONSTRAINT "tool_dns_resolution_proofs_host_address_check" CHECK (
    "pinned_ip_address" IS NULL
    OR masklen("pinned_ip_address") = CASE family("pinned_ip_address")
      WHEN 4 THEN 32
      WHEN 6 THEN 128
      ELSE -1
    END
  ),
  CONSTRAINT "tool_dns_resolution_proofs_text_check" CHECK (
    btrim("hostname") <> ''
    AND btrim("tls_server_name") <> ''
    AND btrim("resolver_name") <> ''
    AND btrim("decision_reason") <> ''
  )
);
ALTER TABLE public."tool_dns_resolution_proofs"
  ADD CONSTRAINT "tool_dns_resolution_proofs_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tool_dns_resolution_proofs_invocation_fkey"
  FOREIGN KEY ("tenant_id", "tool_invocation_id")
  REFERENCES public."tool_invocations" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "tool_receipts_invocation_created_idx"
  ON public."tool_execution_receipts" (
    "tenant_id", "tool_invocation_id", "created_at" DESC
  );
CREATE INDEX "tool_dns_proofs_invocation_created_idx"
  ON public."tool_dns_resolution_proofs" (
    "tenant_id", "tool_invocation_id", "created_at" DESC
  );

CREATE OR REPLACE FUNCTION public.guard_tool_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_record public."tool_invocations"%ROWTYPE;
BEGIN
  SELECT *
    INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  IF invocation_record."id" IS NULL
     OR NEW."input_hash" <> invocation_record."input_hash"
     OR NEW."invocation_revision" NOT IN (
       invocation_record."revision", invocation_record."revision" + 1
     )
     OR NEW."execution_attempt" NOT IN (
       invocation_record."execution_attempt",
       invocation_record."execution_attempt" + 1
     ) THEN
    RAISE EXCEPTION 'Execution receipt is not bound to the current Invocation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_invocation_binding';
  END IF;
  IF NEW."source" = 'GATEWAY_VALIDATOR' AND (
    invocation_record."dry_run_mode" <> 'VALIDATE_ONLY'
    OR NOT invocation_record."dry_run"
    OR invocation_record."provider_dispatch_allowed"
  ) THEN
    RAISE EXCEPTION 'Gateway validator receipts are only valid for non-dispatch dry runs.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_validator_mode';
  END IF;
  IF NEW."source" = 'PROVIDER' AND NOT invocation_record."provider_dispatch_allowed" THEN
    RAISE EXCEPTION 'A provider receipt cannot exist for VALIDATE_ONLY.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_no_provider_dispatch';
  END IF;
  IF NEW."provider_dry_run" <> invocation_record."provider_dry_run" THEN
    RAISE EXCEPTION 'Receipt dry-run mode must match the immutable Invocation snapshot.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_dry_run_binding';
  END IF;
  IF invocation_record."risk_class" = 'DRAFT_ONLY'
     AND NEW."outcome" = 'SUCCEEDED'
     AND NOT NEW."draft_output" THEN
    RAISE EXCEPTION 'DRAFT_ONLY tools may only return a draft artifact.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_draft_only';
  END IF;
  IF invocation_record."adapter" = 'HTTP'
     AND NEW."source" = 'PROVIDER'
     AND NOT EXISTS (
       SELECT 1
       FROM public."tool_dns_resolution_proofs" proof
       WHERE proof."tenant_id" = NEW."tenant_id"
         AND proof."tool_invocation_id" = NEW."tool_invocation_id"
         AND proof."decision" = 'ALLOWED'
         AND proof."expires_at" > NEW."started_at"
         AND proof."pinned_ip_address" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'HTTP provider receipt requires the live DNS/IP pin used for dispatch.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_receipts_dns_binding';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_execution_receipts_insert_guard_trigger"
  BEFORE INSERT ON public."tool_execution_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_receipt_insert();

CREATE OR REPLACE FUNCTION public.guard_tool_dns_proof_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_record public."tool_invocations"%ROWTYPE;
  host_allowed boolean;
BEGIN
  SELECT *
    INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  IF invocation_record."id" IS NULL
     OR invocation_record."adapter" <> 'HTTP'
     OR NEW."invocation_revision" NOT IN (
       invocation_record."revision", invocation_record."revision" + 1
     )
     OR lower(NEW."tls_server_name") <> lower(NEW."hostname") THEN
    RAISE EXCEPTION 'DNS proof does not match the current HTTP Invocation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_dns_resolution_proofs_invocation_binding';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public."tool_versions" version,
         jsonb_array_elements_text(version."allowed_host_patterns") pattern(value)
    WHERE version."tenant_id" = NEW."tenant_id"
      AND version."id" = invocation_record."tool_version_id"
      AND (
        lower(pattern.value) = lower(NEW."hostname")
        OR (
          pattern.value LIKE '*.%'
          AND lower(NEW."hostname")
            LIKE '%.' || lower(substr(pattern.value, 3))
          AND lower(NEW."hostname") <> lower(substr(pattern.value, 3))
        )
      )
  ) INTO host_allowed;
  IF NOT host_allowed THEN
    RAISE EXCEPTION 'Resolved hostname is outside the published Tool allowlist.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_dns_resolution_proofs_host_allowlist';
  END IF;
  IF NEW."decision" = 'ALLOWED' AND NOT (
    NEW."resolved_ip_addresses" ? host(NEW."pinned_ip_address")
    OR NEW."resolved_ip_addresses" ? NEW."pinned_ip_address"::text
  ) THEN
    RAISE EXCEPTION 'Pinned IP must be one of the trusted DNS answers.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_dns_resolution_proofs_pin_membership';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_dns_resolution_proofs_insert_guard_trigger"
  BEFORE INSERT ON public."tool_dns_resolution_proofs"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_dns_proof_insert();

CREATE OR REPLACE FUNCTION public.guard_tool_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tool Versions are immutable and cannot be deleted.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_versions_no_delete';
  END IF;
  IF (
    NEW."tenant_id", NEW."tool_id", NEW."version", NEW."key",
    NEW."created_by_user_id", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."tool_id", OLD."version", OLD."key",
    OLD."created_by_user_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Tool Version identity is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_versions_identity_immutable';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."name", NEW."description", NEW."owner_user_id", NEW."adapter",
    NEW."endpoint_ref", NEW."input_schema", NEW."output_schema",
    NEW."risk_class", NEW."data_classification", NEW."timeout_ms",
    NEW."max_attempts", NEW."idempotency_mode", NEW."dry_run_mode",
    NEW."allowed_http_methods", NEW."allowed_host_patterns",
    NEW."sensitive_input_paths", NEW."compensation_tool_version_id",
    NEW."configuration_hash", NEW."effective_from", NEW."effective_to"
  ) IS DISTINCT FROM (
    OLD."name", OLD."description", OLD."owner_user_id", OLD."adapter",
    OLD."endpoint_ref", OLD."input_schema", OLD."output_schema",
    OLD."risk_class", OLD."data_classification", OLD."timeout_ms",
    OLD."max_attempts", OLD."idempotency_mode", OLD."dry_run_mode",
    OLD."allowed_http_methods", OLD."allowed_host_patterns",
    OLD."sensitive_input_paths", OLD."compensation_tool_version_id",
    OLD."configuration_hash", OLD."effective_from", OLD."effective_to"
  ) THEN
    RAISE EXCEPTION 'A testing or published Tool Version configuration is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_versions_configuration_immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'TESTING'))
    OR (OLD."status" = 'TESTING' AND NEW."status" IN ('TESTING', 'PUBLISHED', 'RETIRED'))
    OR (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('PUBLISHED', 'RETIRED'))
    OR (OLD."status" = 'RETIRED' AND NEW."status" = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'Invalid Tool Version lifecycle transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_versions_status_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION public.guard_tool_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'DRAFT'
     OR NEW."published_at" IS NOT NULL
     OR NEW."retired_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A Tool Version must start as an unpublished DRAFT.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_versions_initial_state';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_versions_insert_guard_trigger"
  BEFORE INSERT ON public."tool_versions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_version_insert();
CREATE TRIGGER "tool_versions_mutation_guard_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_versions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_version_mutation();

CREATE OR REPLACE FUNCTION public.guard_tool_definition_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_version_valid boolean;
BEGIN
  IF (
    NEW."tenant_id", NEW."key", NEW."owner_user_id", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."key", OLD."owner_user_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Tool Definition identity is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_definitions_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Tool Definition update requires revision CAS.'
      USING ERRCODE = '40001', CONSTRAINT = 'tool_definitions_revision_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'TESTING'))
    OR (OLD."status" = 'TESTING' AND NEW."status" IN ('TESTING', 'PUBLISHED', 'RETIRED'))
    OR (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('PUBLISHED', 'RETIRED'))
    OR (OLD."status" = 'RETIRED' AND NEW."status" = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'Invalid Tool Definition lifecycle transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_definitions_status_transition';
  END IF;
  IF NEW."current_version_id" IS NOT NULL THEN
    SELECT
      version."tool_id" = NEW."id"
      AND version."version" = NEW."current_version"
      AND (
        version."status" = 'PUBLISHED'
        OR (NEW."status" = 'RETIRED' AND version."status" = 'RETIRED')
      )
      AND (
        NEW."status" = 'RETIRED'
        OR (
          version."effective_from" <= CURRENT_TIMESTAMP
          AND (
            version."effective_to" IS NULL
            OR version."effective_to" > CURRENT_TIMESTAMP
          )
        )
      )
    INTO current_version_valid
    FROM public."tool_versions" version
    WHERE version."tenant_id" = NEW."tenant_id"
      AND version."id" = NEW."current_version_id"
    FOR SHARE;
    IF COALESCE(current_version_valid, false) = false THEN
      RAISE EXCEPTION 'The current Tool Version must be published and effective.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_definitions_current_version_valid';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION public.guard_tool_definition_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'DRAFT'
     OR NEW."revision" <> 1
     OR NEW."current_version_id" IS NOT NULL THEN
    RAISE EXCEPTION 'A Tool Definition must start as DRAFT revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_definitions_initial_state';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_definitions_insert_guard_trigger"
  BEFORE INSERT ON public."tool_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_definition_insert();
CREATE TRIGGER "tool_definitions_update_guard_trigger"
  BEFORE UPDATE ON public."tool_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_definition_update();
CREATE TRIGGER "tool_definitions_no_delete_trigger"
  BEFORE DELETE ON public."tool_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_version_mutation();

CREATE OR REPLACE FUNCTION public.guard_tool_invocation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tool_valid boolean;
  assignment_valid boolean;
  task_valid boolean;
  process_valid boolean;
  step_valid boolean;
  run_valid boolean;
BEGIN
  IF NEW."status" <> 'REQUESTED'
     OR NEW."revision" <> 1
     OR NEW."execution_attempt" <> 0
     OR NEW."confirmed_by_user_id" IS NOT NULL
     OR NEW."approver_user_id" IS NOT NULL
     OR NEW."started_at" IS NOT NULL
     OR NEW."completed_at" IS NOT NULL
     OR NEW."output" IS NOT NULL
     OR NEW."error_code" IS NOT NULL THEN
    RAISE EXCEPTION 'A Tool Invocation must start as a clean REQUESTED revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_initial_state';
  END IF;
  SELECT
    definition."status" = 'PUBLISHED'
    AND definition."current_version_id" = version."id"
    AND definition."current_version" = version."version"
    AND version."status" = 'PUBLISHED'
    AND version."effective_from" <= CURRENT_TIMESTAMP
    AND (version."effective_to" IS NULL OR version."effective_to" > CURRENT_TIMESTAMP)
    AND version."configuration_hash" = NEW."tool_configuration_hash"
    AND version."adapter" = NEW."adapter"
    AND version."risk_class" = NEW."risk_class"
    AND version."data_classification" = NEW."data_classification"
    AND version."idempotency_mode" = NEW."idempotency_mode"
    AND version."dry_run_mode" = NEW."dry_run_mode"
  INTO tool_valid
  FROM public."tool_versions" version
  JOIN public."tool_definitions" definition
    ON definition."tenant_id" = version."tenant_id"
   AND definition."id" = version."tool_id"
  WHERE version."tenant_id" = NEW."tenant_id"
    AND version."id" = NEW."tool_version_id"
    AND version."tool_id" = NEW."tool_id"
    AND version."version" = NEW."tool_version"
  FOR SHARE OF version, definition;
  IF COALESCE(tool_valid, false) = false THEN
    RAISE EXCEPTION 'Tool Invocation requires the current published Tool Version snapshot.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_published_version';
  END IF;
  SELECT
    assignment."user_id" = NEW."requester_user_id"
    AND assignment."status" = 'ACTIVE'
    AND assignment."effective_from" <= CURRENT_TIMESTAMP
    AND (
      assignment."effective_to" IS NULL
      OR assignment."effective_to" > CURRENT_TIMESTAMP
    )
    AND employment."status" = 'ACTIVE'
    AND unit."status" = 'ACTIVE'
    AND version."status" = 'PUBLISHED'
  INTO assignment_valid
  FROM public."role_assignments" assignment
  JOIN public."employments" employment
    ON employment."tenant_id" = assignment."tenant_id"
   AND employment."id" = assignment."employment_id"
   AND employment."user_id" = assignment."user_id"
  JOIN public."org_units" unit
    ON unit."tenant_id" = employment."tenant_id"
   AND unit."id" = employment."org_unit_id"
  JOIN public."agent_versions" version
    ON version."tenant_id" = assignment."tenant_id"
   AND version."id" = assignment."role_version_id"
  WHERE assignment."tenant_id" = NEW."tenant_id"
    AND assignment."id" = NEW."role_assignment_id"
  FOR SHARE OF assignment, employment, unit, version;
  IF COALESCE(assignment_valid, false) = false THEN
    RAISE EXCEPTION 'Tool Invocation requester must match an effective Role Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_requester_assignment';
  END IF;
  SELECT task."status" IN ('READY', 'IN_PROGRESS')
    INTO task_valid
  FROM public."tasks" task
  WHERE task."tenant_id" = NEW."tenant_id"
    AND task."id" = NEW."task_id"
  FOR SHARE;
  IF COALESCE(task_valid, false) = false THEN
    RAISE EXCEPTION 'Tool Invocation requires an active Task.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_active_task';
  END IF;
  IF NEW."process_instance_id" IS NOT NULL THEN
    SELECT instance."task_id" = NEW."task_id"
      INTO process_valid
    FROM public."process_instances" instance
    WHERE instance."tenant_id" = NEW."tenant_id"
      AND instance."id" = NEW."process_instance_id"
    FOR SHARE;
    IF COALESCE(process_valid, false) = false THEN
      RAISE EXCEPTION 'Tool Invocation Process Instance does not belong to its Task.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_process_task';
    END IF;
  END IF;
  IF NEW."process_step_instance_id" IS NOT NULL THEN
    SELECT
      step."process_instance_id" = NEW."process_instance_id"
      AND step."status" = 'RUNNING'
    INTO step_valid
    FROM public."process_step_instances" step
    WHERE step."tenant_id" = NEW."tenant_id"
      AND step."id" = NEW."process_step_instance_id"
    FOR SHARE;
    IF COALESCE(step_valid, false) = false THEN
      RAISE EXCEPTION 'Tool Invocation requires the matching running Process Step.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_process_step';
    END IF;
  END IF;
  IF NEW."agent_run_id" IS NOT NULL THEN
    SELECT
      run."requester_user_id" = NEW."requester_user_id"
      AND run."task_id" = NEW."task_id"
    INTO run_valid
    FROM public."agent_runs" run
    WHERE run."tenant_id" = NEW."tenant_id"
      AND run."id" = NEW."agent_run_id"
    FOR SHARE;
    IF COALESCE(run_valid, false) = false THEN
      RAISE EXCEPTION 'Tool Invocation Agent Run does not match requester and Task.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_agent_run_context';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_invocations_insert_guard_trigger"
  BEFORE INSERT ON public."tool_invocations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_invocation_insert();

CREATE OR REPLACE FUNCTION public.guard_tool_invocation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  confirmation_actor_valid boolean;
  approver_actor_valid boolean;
  receipt_valid boolean;
BEGIN
  IF (
    NEW."tenant_id", NEW."tool_id", NEW."tool_version_id", NEW."tool_version",
    NEW."tool_configuration_hash", NEW."adapter", NEW."risk_class",
    NEW."data_classification", NEW."idempotency_mode", NEW."dry_run_mode",
    NEW."requester_user_id", NEW."role_assignment_id", NEW."task_id",
    NEW."process_instance_id", NEW."process_step_instance_id", NEW."agent_run_id",
    NEW."correlation_id", NEW."causation_id", NEW."retry_of_invocation_id",
    NEW."compensation_for_invocation_id", NEW."dry_run",
    NEW."provider_dispatch_allowed", NEW."provider_dry_run",
    NEW."input", NEW."input_hash", NEW."redacted_input_summary",
    NEW."policy_decision_id", NEW."policy_snapshot",
    NEW."idempotency_key", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."tool_id", OLD."tool_version_id", OLD."tool_version",
    OLD."tool_configuration_hash", OLD."adapter", OLD."risk_class",
    OLD."data_classification", OLD."idempotency_mode", OLD."dry_run_mode",
    OLD."requester_user_id", OLD."role_assignment_id", OLD."task_id",
    OLD."process_instance_id", OLD."process_step_instance_id", OLD."agent_run_id",
    OLD."correlation_id", OLD."causation_id", OLD."retry_of_invocation_id",
    OLD."compensation_for_invocation_id", OLD."dry_run",
    OLD."provider_dispatch_allowed", OLD."provider_dry_run",
    OLD."input", OLD."input_hash", OLD."redacted_input_summary",
    OLD."policy_decision_id", OLD."policy_snapshot",
    OLD."idempotency_key", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Tool Invocation execution and policy snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_snapshot_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Tool Invocation transition requires exact revision CAS.'
      USING ERRCODE = '40001', CONSTRAINT = 'tool_invocations_revision_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'REQUESTED' AND NEW."status" IN (
      'POLICY_DENIED', 'PENDING_CONFIRMATION', 'PENDING_APPROVAL', 'APPROVED'
    ))
    OR (
      OLD."status" = 'PENDING_CONFIRMATION'
      AND NEW."status" IN ('PENDING_APPROVAL', 'APPROVED', 'CANCELLED')
    )
    OR (
      OLD."status" = 'PENDING_APPROVAL'
      AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED')
    )
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('EXECUTING', 'CANCELLED'))
    OR (OLD."status" = 'EXECUTING' AND NEW."status" IN (
      'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'
    ))
    OR (OLD."status" = 'SUCCEEDED' AND NEW."status" = 'COMPENSATING')
    OR (
      OLD."status" = 'COMPENSATING'
      AND NEW."status" IN ('COMPENSATED', 'COMPENSATION_FAILED')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid Tool Invocation status transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_status_transition';
  END IF;
  IF NEW."confirmed_by_user_id" IS NOT NULL
     AND OLD."confirmed_by_user_id" IS NULL THEN
    IF NOT (
      (
        OLD."status" = 'PENDING_CONFIRMATION'
        AND NEW."status" IN ('PENDING_APPROVAL', 'APPROVED')
      )
      OR (
        OLD."status" = 'REQUESTED'
        AND NEW."status" = 'PENDING_APPROVAL'
      )
    ) THEN
      RAISE EXCEPTION 'Confirmation proof can only be attached by the confirmation gate.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_confirmation_transition';
    END IF;
    SELECT
      assignment."user_id" = NEW."requester_user_id"
      AND assignment."id" = NEW."role_assignment_id"
      AND assignment."user_id" = NEW."confirmed_by_user_id"
      AND assignment."id" = NEW."confirmed_by_role_assignment_id"
      AND assignment."status" = 'ACTIVE'
      AND assignment."effective_from" <= NEW."confirmed_at"
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > NEW."confirmed_at"
      )
    INTO confirmation_actor_valid
    FROM public."role_assignments" assignment
    WHERE assignment."tenant_id" = NEW."tenant_id"
      AND assignment."id" = NEW."confirmed_by_role_assignment_id"
    FOR SHARE;
    IF COALESCE(confirmation_actor_valid, false) = false THEN
      RAISE EXCEPTION 'Confirmation must be made by the trusted requester Assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_confirmation_actor';
    END IF;
  ELSIF (
    NEW."confirmed_by_user_id", NEW."confirmed_by_role_assignment_id",
    NEW."confirmed_at", NEW."confirmation_reason",
    NEW."confirmation_proof_hash", NEW."confirmation_issued_at",
    NEW."confirmation_expires_at"
  ) IS DISTINCT FROM (
    OLD."confirmed_by_user_id", OLD."confirmed_by_role_assignment_id",
    OLD."confirmed_at", OLD."confirmation_reason",
    OLD."confirmation_proof_hash", OLD."confirmation_issued_at",
    OLD."confirmation_expires_at"
  ) THEN
    RAISE EXCEPTION 'Confirmation proof is append-only.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_confirmation_immutable';
  END IF;
  IF NEW."approver_user_id" IS NOT NULL AND OLD."approver_user_id" IS NULL THEN
    IF OLD."status" <> 'PENDING_APPROVAL'
       OR NEW."status" NOT IN ('APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'Approval proof can only be attached by an approval decision.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_approval_transition';
    END IF;
    SELECT
      assignment."user_id" = NEW."approver_user_id"
      AND assignment."id" = NEW."approver_role_assignment_id"
      AND assignment."user_id" <> NEW."requester_user_id"
      AND assignment."id" <> NEW."role_assignment_id"
      AND assignment."status" = 'ACTIVE'
      AND assignment."effective_from" <= NEW."approval_decided_at"
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > NEW."approval_decided_at"
      )
      AND (
        assignment."permission_scope"->'actions' ? 'tool.approve'
        OR assignment."permission_scope"->'actions' ? ('tool.approve:' || version."key")
        OR assignment."permission_scope"->'actions' ? 'tool.*'
        OR assignment."permission_scope"->'actions' ? '*'
      )
    INTO approver_actor_valid
    FROM public."role_assignments" assignment
    JOIN public."tool_versions" version
      ON version."tenant_id" = assignment."tenant_id"
     AND version."id" = NEW."tool_version_id"
    WHERE assignment."tenant_id" = NEW."tenant_id"
      AND assignment."id" = NEW."approver_role_assignment_id"
    FOR SHARE OF assignment, version;
    IF COALESCE(approver_actor_valid, false) = false THEN
      RAISE EXCEPTION 'High-risk approval requires an independent authorized Assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_approval_actor';
    END IF;
  ELSIF (
    NEW."approver_user_id", NEW."approver_role_assignment_id",
    NEW."approval_decision", NEW."approval_decided_at", NEW."approval_reason",
    NEW."approval_proof_hash", NEW."approval_issued_at", NEW."approval_expires_at"
  ) IS DISTINCT FROM (
    OLD."approver_user_id", OLD."approver_role_assignment_id",
    OLD."approval_decision", OLD."approval_decided_at", OLD."approval_reason",
    OLD."approval_proof_hash", OLD."approval_issued_at", OLD."approval_expires_at"
  ) THEN
    RAISE EXCEPTION 'Approval proof is append-only.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_approval_immutable';
  END IF;
  IF NEW."risk_class" = 'HIGH_RISK_APPROVAL'
     AND NEW."status" IN (
       'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN',
       'COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED'
     )
     AND (
       NEW."confirmed_by_user_id" IS NULL
       OR NEW."approval_decision" IS DISTINCT FROM 'APPROVED'
       OR (
         NEW."status" IN ('APPROVED', 'EXECUTING')
         AND NEW."approval_expires_at" < CURRENT_TIMESTAMP
       )
     ) THEN
    RAISE EXCEPTION 'High-risk execution requires live confirmation and independent approval.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_high_risk_gate';
  END IF;
  IF NEW."status" = 'PENDING_APPROVAL' AND (
    NEW."risk_class" <> 'HIGH_RISK_APPROVAL'
    OR NEW."confirmed_by_user_id" IS NULL
    OR NEW."approval_decision" IS NOT NULL
    OR NEW."confirmation_expires_at" < CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'Pending approval requires a live requester confirmation only.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_pending_approval_gate';
  END IF;
  IF NEW."status" = 'REJECTED' AND (
    NEW."risk_class" <> 'HIGH_RISK_APPROVAL'
    OR NEW."approval_decision" IS DISTINCT FROM 'REJECTED'
  ) THEN
    RAISE EXCEPTION 'Rejected state requires a recorded independent rejection.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_rejection_gate';
  END IF;
  IF NEW."risk_class" = 'CONFIRM_REQUIRED'
     AND NEW."status" IN (
       'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN',
       'COMPENSATING', 'COMPENSATED', 'COMPENSATION_FAILED'
     )
     AND (
       NEW."confirmed_by_user_id" IS NULL
       OR (
         NEW."status" IN ('APPROVED', 'EXECUTING')
         AND NEW."confirmation_expires_at" < CURRENT_TIMESTAMP
       )
     ) THEN
    RAISE EXCEPTION 'Execution requires live requester confirmation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_confirmation_gate';
  END IF;
  IF NEW."status" = 'EXECUTING' THEN
    -- VALIDATE_ONLY is protected by the immutable
    -- provider_dispatch_allowed=false snapshot and by the receipt guard, which
    -- rejects every PROVIDER receipt for that mode. Its single validator
    -- receipt is appended for the terminal transition below. Requiring a
    -- validator receipt here as well would need two receipts for the same
    -- (Invocation, attempt, source), contradicting the immutable-ledger unique
    -- key.
    IF NEW."provider_dispatch_allowed"
       AND NEW."adapter" = 'HTTP' AND NOT EXISTS (
      SELECT 1
      FROM public."tool_dns_resolution_proofs" proof
      WHERE proof."tenant_id" = NEW."tenant_id"
        AND proof."tool_invocation_id" = NEW."id"
        AND proof."invocation_revision" IN (OLD."revision", NEW."revision")
        AND proof."decision" = 'ALLOWED'
        AND proof."expires_at" > CURRENT_TIMESTAMP
        AND proof."pinned_ip_address" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'HTTP execution requires a live public-IP pin and DNS proof.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_http_dns_proof';
    END IF;
  END IF;
  IF NEW."status" IN (
    'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED',
    'COMPENSATED', 'COMPENSATION_FAILED'
  ) AND OLD."status" IN ('EXECUTING', 'COMPENSATING') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public."tool_execution_receipts" receipt
      WHERE receipt."tenant_id" = NEW."tenant_id"
        AND receipt."tool_invocation_id" = NEW."id"
        AND receipt."invocation_revision" = NEW."revision"
        AND receipt."execution_attempt" = NEW."execution_attempt"
        AND receipt."input_hash" = NEW."input_hash"
        AND receipt."outcome"::text = NEW."status"::text
        AND receipt."provider_dry_run" = NEW."provider_dry_run"
        AND (
          NEW."risk_class" <> 'DRAFT_ONLY'
          OR NEW."status" <> 'SUCCEEDED'
          OR receipt."draft_output"
        )
    ) INTO receipt_valid;
    IF NOT receipt_valid THEN
      RAISE EXCEPTION 'Execution outcome requires an exact immutable provider receipt.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_execution_receipt';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_invocations_transition_guard_trigger"
  BEFORE UPDATE ON public."tool_invocations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_invocation_transition();

CREATE OR REPLACE FUNCTION public.guard_tool_command_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_record public."tool_invocations"%ROWTYPE;
  actor_valid boolean;
BEGIN
  SELECT *
    INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id"
  FOR SHARE;
  IF invocation_record."id" IS NULL
     OR NEW."expected_revision" <> invocation_record."revision"
     OR NEW."request_hash" <> invocation_record."input_hash" THEN
    RAISE EXCEPTION 'Tool command must target the current Invocation revision and input hash.'
      USING ERRCODE = '40001', CONSTRAINT = 'tool_invocation_commands_current_revision';
  END IF;
  IF NEW."command" IN ('CONFIRM', 'APPROVE', 'REJECT')
     AND NEW."actor_type" <> 'USER' THEN
    RAISE EXCEPTION 'Confirmation and approval decisions require a human user.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_human_decision';
  END IF;
  IF NEW."command" IN (
    'DENY', 'REQUEST_CONFIRMATION', 'REQUEST_APPROVAL', 'START',
    'BEGIN_COMPENSATION', 'COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'
  ) AND NEW."actor_type" <> 'SYSTEM' THEN
    RAISE EXCEPTION 'This Tool command requires a trusted system principal.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_system_actor';
  END IF;
  IF NEW."command" IN ('SUCCEED', 'FAIL', 'MARK_UNKNOWN')
     AND NEW."actor_type" NOT IN ('SYSTEM', 'PROVIDER') THEN
    RAISE EXCEPTION 'Provider outcomes require a trusted service principal.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_provider_actor';
  END IF;
  IF NEW."command" IN (
    'DENY', 'REQUEST_CONFIRMATION', 'REQUEST_APPROVAL', 'START'
  ) AND (
    NEW."policy_proof" IS NULL
    OR NOT (NEW."policy_proof" ?& ARRAY[
      'tenantId', 'invocationId', 'toolVersionId', 'taskId',
      'inputHash', 'policyDecisionId', 'riskClass', 'dryRun',
      'decision', 'expiresAt'
    ])
    OR NEW."policy_proof"->>'tenantId' IS DISTINCT FROM NEW."tenant_id"::text
    OR NEW."policy_proof"->>'invocationId' IS DISTINCT FROM NEW."tool_invocation_id"::text
    OR NEW."policy_proof"->>'toolVersionId'
      IS DISTINCT FROM invocation_record."tool_version_id"::text
    OR NEW."policy_proof"->>'taskId' IS DISTINCT FROM invocation_record."task_id"::text
    OR NEW."policy_proof"->>'inputHash' IS DISTINCT FROM invocation_record."input_hash"
    OR NEW."policy_proof"->>'policyDecisionId'
      IS DISTINCT FROM invocation_record."policy_decision_id"
    OR NEW."policy_proof"->>'riskClass'
      IS DISTINCT FROM invocation_record."risk_class"::text
    OR (NEW."policy_proof"->>'dryRun')::boolean
      IS DISTINCT FROM invocation_record."dry_run"
    OR NEW."policy_proof"->>'decision' IS DISTINCT FROM CASE NEW."command"
      WHEN 'DENY' THEN 'DENY'
      WHEN 'REQUEST_CONFIRMATION' THEN 'REQUIRE_CONFIRMATION'
      WHEN 'REQUEST_APPROVAL' THEN 'REQUIRE_APPROVAL'
      WHEN 'START' THEN 'ALLOW'
      ELSE NULL
    END
    OR (NEW."policy_proof"->>'expiresAt')::timestamptz <= NEW."occurred_at"
  ) THEN
    RAISE EXCEPTION 'Policy proof is missing, expired, or not bound to this Invocation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_policy_proof';
  END IF;
  IF NEW."command" IN ('CONFIRM', 'REQUEST_APPROVAL') AND (
    NEW."confirmation_proof" IS NULL
    OR NOT (NEW."confirmation_proof" ?& ARRAY[
      'tenantId', 'invocationId', 'toolVersionId', 'taskId',
      'inputHash', 'policyDecisionId', 'requesterUserId',
      'requesterRoleAssignmentId', 'confirmed', 'expiresAt'
    ])
    OR NEW."confirmation_proof"->>'tenantId'
      IS DISTINCT FROM NEW."tenant_id"::text
    OR NEW."confirmation_proof"->>'invocationId'
      IS DISTINCT FROM NEW."tool_invocation_id"::text
    OR NEW."confirmation_proof"->>'toolVersionId'
      IS DISTINCT FROM invocation_record."tool_version_id"::text
    OR NEW."confirmation_proof"->>'taskId'
      IS DISTINCT FROM invocation_record."task_id"::text
    OR NEW."confirmation_proof"->>'inputHash'
      IS DISTINCT FROM invocation_record."input_hash"
    OR NEW."confirmation_proof"->>'policyDecisionId'
      IS DISTINCT FROM invocation_record."policy_decision_id"
    OR NEW."confirmation_proof"->>'requesterUserId'
      IS DISTINCT FROM invocation_record."requester_user_id"::text
    OR NEW."confirmation_proof"->>'requesterRoleAssignmentId'
      IS DISTINCT FROM invocation_record."role_assignment_id"::text
    OR (NEW."confirmation_proof"->>'confirmed')::boolean IS DISTINCT FROM true
    OR (NEW."confirmation_proof"->>'expiresAt')::timestamptz <= NEW."occurred_at"
  ) THEN
    RAISE EXCEPTION 'Confirmation proof is missing, expired, or not fully bound.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_confirmation_proof';
  END IF;
  IF NEW."command" IN ('APPROVE', 'REJECT') AND (
    NEW."approval_proof" IS NULL
    OR NOT (NEW."approval_proof" ?& ARRAY[
      'tenantId', 'invocationId', 'toolVersionId', 'taskId',
      'inputHash', 'policyDecisionId', 'approverUserId',
      'approverRoleAssignmentId', 'actorType', 'decision', 'expiresAt'
    ])
    OR NEW."approval_proof"->>'tenantId' IS DISTINCT FROM NEW."tenant_id"::text
    OR NEW."approval_proof"->>'invocationId'
      IS DISTINCT FROM NEW."tool_invocation_id"::text
    OR NEW."approval_proof"->>'toolVersionId'
      IS DISTINCT FROM invocation_record."tool_version_id"::text
    OR NEW."approval_proof"->>'taskId' IS DISTINCT FROM invocation_record."task_id"::text
    OR NEW."approval_proof"->>'inputHash'
      IS DISTINCT FROM invocation_record."input_hash"
    OR NEW."approval_proof"->>'policyDecisionId'
      IS DISTINCT FROM invocation_record."policy_decision_id"
    OR NEW."approval_proof"->>'approverUserId'
      IS DISTINCT FROM NEW."actor_user_id"::text
    OR NEW."approval_proof"->>'approverRoleAssignmentId'
      IS DISTINCT FROM NEW."actor_role_assignment_id"::text
    OR NEW."approval_proof"->>'actorType' IS DISTINCT FROM 'USER'
    OR NEW."approval_proof"->>'decision' IS DISTINCT FROM CASE NEW."command"
      WHEN 'APPROVE' THEN 'APPROVED'
      WHEN 'REJECT' THEN 'REJECTED'
      ELSE NULL
    END
    OR (NEW."approval_proof"->>'expiresAt')::timestamptz <= NEW."occurred_at"
  ) THEN
    RAISE EXCEPTION 'Approval proof is missing, expired, or not fully bound.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_approval_proof';
  END IF;
  IF NEW."command" IN ('SUCCEED', 'FAIL', 'MARK_UNKNOWN') AND (
    NEW."provider_proof" IS NULL
    OR NOT (NEW."provider_proof" ?& ARRAY[
      'tenantId', 'invocationId', 'toolVersionId',
      'inputHash', 'providerRequestId', 'outcome'
    ])
    OR NEW."provider_proof"->>'tenantId' IS DISTINCT FROM NEW."tenant_id"::text
    OR NEW."provider_proof"->>'invocationId'
      IS DISTINCT FROM NEW."tool_invocation_id"::text
    OR NEW."provider_proof"->>'toolVersionId'
      IS DISTINCT FROM invocation_record."tool_version_id"::text
    OR NEW."provider_proof"->>'inputHash'
      IS DISTINCT FROM invocation_record."input_hash"
    OR COALESCE(btrim(NEW."provider_proof"->>'providerRequestId'), '') = ''
    OR NEW."provider_proof"->>'outcome' IS DISTINCT FROM CASE NEW."command"
      WHEN 'SUCCEED' THEN 'SUCCEEDED'
      WHEN 'FAIL' THEN 'FAILED'
      WHEN 'MARK_UNKNOWN' THEN 'UNKNOWN'
      ELSE NULL
    END
  ) THEN
    RAISE EXCEPTION 'Provider proof is missing or not bound to this Invocation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_provider_proof';
  END IF;
  IF NEW."command" IN (
    'BEGIN_COMPENSATION', 'COMPLETE_COMPENSATION', 'FAIL_COMPENSATION'
  ) AND (
    NEW."compensation_proof" IS NULL
    OR NOT (NEW."compensation_proof" ?& ARRAY[
      'tenantId', 'invocationId', 'toolVersionId',
      'inputHash', 'authorizedCommand'
    ])
    OR NEW."compensation_proof"->>'tenantId'
      IS DISTINCT FROM NEW."tenant_id"::text
    OR NEW."compensation_proof"->>'invocationId'
      IS DISTINCT FROM NEW."tool_invocation_id"::text
    OR NEW."compensation_proof"->>'toolVersionId'
      IS DISTINCT FROM invocation_record."tool_version_id"::text
    OR NEW."compensation_proof"->>'inputHash'
      IS DISTINCT FROM invocation_record."input_hash"
    OR NEW."compensation_proof"->>'authorizedCommand'
      IS DISTINCT FROM NEW."command"::text
  ) THEN
    RAISE EXCEPTION 'Compensation proof is missing or not bound to this Invocation.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_compensation_proof';
  END IF;
  IF NEW."actor_type" = 'USER' THEN
    SELECT
      assignment."user_id" = NEW."actor_user_id"
      AND assignment."status" = 'ACTIVE'
      AND assignment."effective_from" <= NEW."occurred_at"
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > NEW."occurred_at"
      )
      AND employment."status" = 'ACTIVE'
      AND unit."status" = 'ACTIVE'
    INTO actor_valid
    FROM public."role_assignments" assignment
    JOIN public."employments" employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
     AND employment."user_id" = assignment."user_id"
    JOIN public."org_units" unit
      ON unit."tenant_id" = employment."tenant_id"
     AND unit."id" = employment."org_unit_id"
    WHERE assignment."tenant_id" = NEW."tenant_id"
      AND assignment."id" = NEW."actor_role_assignment_id"
    FOR SHARE OF assignment, employment, unit;
    IF COALESCE(actor_valid, false) = false THEN
      RAISE EXCEPTION 'Tool command user does not match an effective Assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_actor_assignment';
    END IF;
    IF NEW."command" = 'CONFIRM' AND (
      NEW."actor_user_id" <> invocation_record."requester_user_id"
      OR NEW."actor_role_assignment_id" <> invocation_record."role_assignment_id"
    ) THEN
      RAISE EXCEPTION 'Only the requester can confirm a Tool Invocation.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_requester_confirmation';
    END IF;
    IF NEW."command" = 'CANCEL_CONFIRMED' AND (
      invocation_record."status" = 'EXECUTING'
      OR NEW."actor_user_id" <> invocation_record."requester_user_id"
      OR NEW."actor_role_assignment_id" <> invocation_record."role_assignment_id"
    ) THEN
      RAISE EXCEPTION 'Only the requester may cancel before dispatch; executing cancellation needs provider proof.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_cancellation_actor';
    END IF;
    IF NEW."command" IN ('APPROVE', 'REJECT') AND (
      NEW."actor_user_id" = invocation_record."requester_user_id"
      OR NEW."actor_role_assignment_id" = invocation_record."role_assignment_id"
    ) THEN
      RAISE EXCEPTION 'A requester cannot approve their own Tool Invocation.'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_independent_approval';
    END IF;
  END IF;
  IF NEW."command" = 'CANCEL_CONFIRMED'
     AND invocation_record."status" = 'EXECUTING'
     AND (
       NEW."actor_type" NOT IN ('SYSTEM', 'PROVIDER')
       OR NEW."provider_proof" IS NULL
       OR NOT (NEW."provider_proof" ?& ARRAY[
         'tenantId', 'invocationId', 'toolVersionId',
         'inputHash', 'providerRequestId', 'outcome'
       ])
       OR NEW."provider_proof"->>'tenantId' IS DISTINCT FROM NEW."tenant_id"::text
       OR NEW."provider_proof"->>'invocationId'
         IS DISTINCT FROM NEW."tool_invocation_id"::text
       OR NEW."provider_proof"->>'toolVersionId'
         IS DISTINCT FROM invocation_record."tool_version_id"::text
       OR NEW."provider_proof"->>'inputHash'
         IS DISTINCT FROM invocation_record."input_hash"
       OR NEW."provider_proof"->>'outcome' IS DISTINCT FROM 'CANCELLED'
     ) THEN
    RAISE EXCEPTION 'Executing cancellation requires a bound provider cancellation proof.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_cancellation_proof';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_invocation_commands_insert_guard_trigger"
  BEFORE INSERT ON public."tool_invocation_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_command_insert();

CREATE OR REPLACE FUNCTION public.validate_tool_command_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_record public."tool_invocations"%ROWTYPE;
  expected_status public."ToolInvocationStatus";
BEGIN
  SELECT *
    INTO invocation_record
  FROM public."tool_invocations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."tool_invocation_id";
  expected_status := CASE
    WHEN NEW."command" = 'DENY' THEN 'POLICY_DENIED'
    WHEN NEW."command" = 'REQUEST_CONFIRMATION' THEN 'PENDING_CONFIRMATION'
    WHEN NEW."command" = 'REQUEST_APPROVAL' THEN 'PENDING_APPROVAL'
    WHEN NEW."command" = 'CONFIRM'
      AND invocation_record."risk_class" = 'HIGH_RISK_APPROVAL'
      THEN 'PENDING_APPROVAL'
    WHEN NEW."command" IN ('CONFIRM', 'APPROVE') THEN 'APPROVED'
    WHEN NEW."command" = 'REJECT' THEN 'REJECTED'
    WHEN NEW."command" = 'START'
      AND NEW."expected_revision" = 1
      THEN 'APPROVED'
    WHEN NEW."command" = 'START' THEN 'EXECUTING'
    WHEN NEW."command" = 'SUCCEED' THEN 'SUCCEEDED'
    WHEN NEW."command" = 'FAIL' THEN 'FAILED'
    WHEN NEW."command" = 'MARK_UNKNOWN' THEN 'UNKNOWN'
    WHEN NEW."command" = 'CANCEL_CONFIRMED' THEN 'CANCELLED'
    WHEN NEW."command" = 'BEGIN_COMPENSATION' THEN 'COMPENSATING'
    WHEN NEW."command" = 'COMPLETE_COMPENSATION' THEN 'COMPENSATED'
    WHEN NEW."command" = 'FAIL_COMPENSATION' THEN 'COMPENSATION_FAILED'
    ELSE NULL
  END;
  IF invocation_record."id" IS NULL
     OR invocation_record."revision" <> NEW."result_revision"
     OR invocation_record."status" IS DISTINCT FROM expected_status THEN
    RAISE EXCEPTION 'Tool command does not exactly cover the resulting status and revision.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocation_commands_status_coverage';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "tool_invocation_commands_transition_trigger"
  AFTER INSERT ON public."tool_invocation_commands"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_tool_command_transition();

CREATE OR REPLACE FUNCTION public.validate_tool_transition_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_command public."ToolInvocationCommandType";
BEGIN
  expected_command := CASE
    WHEN OLD."status" = 'REQUESTED' AND NEW."status" = 'POLICY_DENIED' THEN 'DENY'
    WHEN OLD."status" = 'REQUESTED' AND NEW."status" = 'PENDING_CONFIRMATION'
      THEN 'REQUEST_CONFIRMATION'
    WHEN OLD."status" = 'REQUESTED' AND NEW."status" = 'PENDING_APPROVAL'
      THEN 'REQUEST_APPROVAL'
    WHEN OLD."status" = 'REQUESTED' AND NEW."status" = 'APPROVED' THEN 'START'
    WHEN OLD."status" = 'PENDING_CONFIRMATION'
      AND NEW."status" IN ('PENDING_APPROVAL', 'APPROVED') THEN 'CONFIRM'
    WHEN OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'APPROVED'
      THEN 'APPROVE'
    WHEN OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'REJECTED'
      THEN 'REJECT'
    WHEN OLD."status" = 'APPROVED' AND NEW."status" = 'EXECUTING' THEN 'START'
    WHEN OLD."status" = 'EXECUTING' AND NEW."status" = 'SUCCEEDED' THEN 'SUCCEED'
    WHEN OLD."status" = 'EXECUTING' AND NEW."status" = 'FAILED' THEN 'FAIL'
    WHEN OLD."status" = 'EXECUTING' AND NEW."status" = 'UNKNOWN' THEN 'MARK_UNKNOWN'
    WHEN NEW."status" = 'CANCELLED' THEN 'CANCEL_CONFIRMED'
    WHEN OLD."status" = 'SUCCEEDED' AND NEW."status" = 'COMPENSATING'
      THEN 'BEGIN_COMPENSATION'
    WHEN OLD."status" = 'COMPENSATING' AND NEW."status" = 'COMPENSATED'
      THEN 'COMPLETE_COMPENSATION'
    WHEN OLD."status" = 'COMPENSATING' AND NEW."status" = 'COMPENSATION_FAILED'
      THEN 'FAIL_COMPENSATION'
    ELSE NULL
  END;
  IF expected_command IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public."tool_invocation_commands" command
    WHERE command."tenant_id" = NEW."tenant_id"
      AND command."tool_invocation_id" = NEW."id"
      AND command."expected_revision" = OLD."revision"
      AND command."result_revision" = NEW."revision"
      AND command."command" = expected_command
  ) THEN
    RAISE EXCEPTION 'Every Tool Invocation transition requires one exact command.'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_command_coverage';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "tool_invocations_command_coverage_trigger"
  AFTER UPDATE ON public."tool_invocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_tool_transition_command();

CREATE OR REPLACE FUNCTION public.guard_tool_ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Tool execution ledger records are append-only.'
    USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;
CREATE TRIGGER "tool_invocation_commands_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_invocation_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();
CREATE TRIGGER "tool_execution_receipts_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_execution_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();
CREATE TRIGGER "tool_dns_resolution_proofs_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."tool_dns_resolution_proofs"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();
CREATE TRIGGER "tool_invocations_no_delete_trigger"
  BEFORE DELETE ON public."tool_invocations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_tool_ledger_append_only();

CREATE OR REPLACE FUNCTION public.record_tool_command_side_effects()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_actor_type public."AuditActorType";
  audit_actor_id uuid;
BEGIN
  audit_actor_type := CASE
    WHEN NEW."actor_type" = 'USER' THEN 'USER'::public."AuditActorType"
    ELSE 'SERVICE'::public."AuditActorType"
  END;
  audit_actor_id := COALESCE(NEW."actor_user_id", NEW."actor_service_principal_id");
  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id", audit_actor_type, audit_actor_id,
    'tool.invocation.' || lower(NEW."command"::text),
    'tool_invocation', NEW."tool_invocation_id",
    jsonb_build_object(
      'commandId', NEW."id",
      'expectedRevision', NEW."expected_revision",
      'resultRevision', NEW."result_revision",
      'actorRoleAssignmentId', NEW."actor_role_assignment_id",
      'requestHash', NEW."request_hash"
    ),
    NEW."occurred_at"
  );
  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id",
    "event_type", "payload", "status", "attempts", "available_at", "created_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id", 'TOOL_INVOCATION', NEW."tool_invocation_id",
    'ToolInvocationCommandRecorded',
    jsonb_build_object(
      'schemaVersion', 1,
      'commandId', NEW."id",
      'command', NEW."command",
      'expectedRevision', NEW."expected_revision",
      'resultRevision', NEW."result_revision"
    ),
    'PENDING', 0, CURRENT_TIMESTAMP, NEW."occurred_at"
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER "tool_invocation_commands_side_effects_trigger"
  AFTER INSERT ON public."tool_invocation_commands"
  FOR EACH ROW EXECUTE FUNCTION public.record_tool_command_side_effects();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_tool_gateway'
  ) THEN
    CREATE ROLE enterprise_agent_tool_gateway
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_tool_gateway
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON TABLE
  public."tool_definitions",
  public."tool_versions",
  public."tool_invocations",
  public."tool_invocation_commands",
  public."tool_execution_receipts",
  public."tool_dns_resolution_proofs"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
       enterprise_agent_process, enterprise_agent_tool_gateway;

GRANT SELECT ON TABLE
  public."tool_definitions",
  public."tool_versions",
  public."tool_invocations",
  public."tool_invocation_commands",
  public."tool_execution_receipts",
  public."tool_dns_resolution_proofs"
  TO enterprise_agent_admin;
GRANT SELECT ON TABLE
  public."tool_definitions",
  public."tool_versions",
  public."tool_invocations",
  public."tool_invocation_commands",
  public."tool_execution_receipts"
  TO enterprise_agent_app;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public."tool_invocations"
  TO enterprise_agent_tool_gateway;
GRANT SELECT, INSERT ON TABLE
  public."tool_invocation_commands",
  public."tool_execution_receipts",
  public."tool_dns_resolution_proofs"
  TO enterprise_agent_tool_gateway;
GRANT SELECT ON TABLE
  public."tool_definitions",
  public."tool_versions"
  TO enterprise_agent_tool_gateway;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public."tool_definitions",
  public."tool_versions"
  TO enterprise_agent_admin;

GRANT SELECT ON TABLE
  public."users",
  public."role_assignments",
  public."employments",
  public."org_units",
  public."agent_versions",
  public."tasks",
  public."process_instances",
  public."process_step_instances",
  public."agent_runs"
  TO enterprise_agent_tool_gateway;
GRANT INSERT ON TABLE
  public."audit_events",
  public."outbox_events"
  TO enterprise_agent_tool_gateway;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tool_definitions',
    'tool_versions',
    'tool_invocations',
    'tool_invocation_commands',
    'tool_execution_receipts',
    'tool_dns_resolution_proofs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tool_tenant_isolation ON public.%I '
      || 'AS RESTRICTIVE FOR ALL TO enterprise_agent_app, enterprise_agent_admin, '
      || 'enterprise_agent_tool_gateway '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tool_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tool_gateway_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_tool_gateway '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$$;

CREATE POLICY "tool_app_definition_read"
  ON public."tool_definitions"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING ("status" = 'PUBLISHED');
CREATE POLICY "tool_app_version_read"
  ON public."tool_versions"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    "status" = 'PUBLISHED'
    AND "effective_from" <= CURRENT_TIMESTAMP
    AND ("effective_to" IS NULL OR "effective_to" > CURRENT_TIMESTAMP)
  );
CREATE POLICY "tool_app_invocation_read"
  ON public."tool_invocations"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    "requester_user_id"
      = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY "tool_app_command_read"
  ON public."tool_invocation_commands"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    EXISTS (
      SELECT 1
      FROM public."tool_invocations" invocation
      WHERE invocation."tenant_id" = "tool_invocation_commands"."tenant_id"
        AND invocation."id" = "tool_invocation_commands"."tool_invocation_id"
        AND invocation."requester_user_id"
          = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
CREATE POLICY "tool_app_receipt_read"
  ON public."tool_execution_receipts"
  AS PERMISSIVE FOR SELECT TO enterprise_agent_app
  USING (
    EXISTS (
      SELECT 1
      FROM public."tool_invocations" invocation
      WHERE invocation."tenant_id" = "tool_execution_receipts"."tenant_id"
        AND invocation."id" = "tool_execution_receipts"."tool_invocation_id"
        AND invocation."requester_user_id"
          = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'role_assignments',
    'employments',
    'org_units',
    'agent_versions',
    'tasks',
    'process_instances',
    'process_step_instances',
    'agent_runs'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY tool_gateway_parent_tenant ON public.%I '
      || 'AS RESTRICTIVE FOR SELECT TO enterprise_agent_tool_gateway '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tool_gateway_parent_read ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_tool_gateway USING (true)',
      table_name
    );
  END LOOP;
END
$$;

CREATE POLICY "tool_gateway_audit_tenant"
  ON public."audit_events"
  AS RESTRICTIVE FOR INSERT TO enterprise_agent_tool_gateway
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "tool_gateway_audit_insert"
  ON public."audit_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_tool_gateway
  WITH CHECK (true);
CREATE POLICY "tool_gateway_outbox_tenant"
  ON public."outbox_events"
  AS RESTRICTIVE FOR INSERT TO enterprise_agent_tool_gateway
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "tool_gateway_outbox_insert"
  ON public."outbox_events"
  AS PERMISSIVE FOR INSERT TO enterprise_agent_tool_gateway
  WITH CHECK (true);
