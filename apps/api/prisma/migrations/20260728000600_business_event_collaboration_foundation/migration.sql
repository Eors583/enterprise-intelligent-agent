-- P0-3 business-event, delivery, collaboration, and correction ledgers.
-- Events and protocol messages are append-only; mutable aggregate state is
-- revisioned and must be explainable by the immutable ledger in the same tx.

BEGIN;
CREATE TYPE public."BusinessEventSubjectType" AS ENUM (
  'EMPLOYEE',
  'ROLE_ASSIGNMENT',
  'VALUE',
  'STRATEGY',
  'OBJECTIVE',
  'TASK',
  'PROCESS_DEFINITION',
  'PROCESS_INSTANCE',
  'COLLABORATION',
  'CORRECTION',
  'CUSTOMER',
  'METRIC'
);
CREATE TYPE public."BusinessEventSensitivity" AS ENUM (
  'PUBLIC', 'INTERNAL', 'SENSITIVE', 'CONFIDENTIAL'
);
CREATE TYPE public."BusinessEventRetentionAction" AS ENUM (
  'DELETE', 'ANONYMIZE', 'ARCHIVE'
);
CREATE TYPE public."BusinessEventDeliveryStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'PROCESSED', 'RETRY_SCHEDULED', 'DEAD_LETTERED'
);
CREATE TYPE public."BusinessEventEffectStatus" AS ENUM (
  'STARTED', 'APPLIED', 'FAILED', 'UNKNOWN'
);
CREATE TYPE public."CollaborationStatus" AS ENUM (
  'REQUESTED', 'COMMITTED', 'DELIVERED', 'ACCEPTED',
  'REJECTED', 'ESCALATED', 'CANCELLED'
);
CREATE TYPE public."CollaborationMessageType" AS ENUM (
  'REQUEST', 'COMMIT', 'DELIVER', 'ACCEPT', 'REJECT', 'ESCALATE', 'CANCEL'
);
CREATE TYPE public."CollaborationParticipantRole" AS ENUM (
  'REQUESTER', 'RECIPIENT', 'DECISION'
);
CREATE TYPE public."CorrectionCategory" AS ENUM (
  'HARD_CONSTRAINT',
  'THRESHOLD_ANOMALY',
  'OBJECTIVE_DEVIATION',
  'VALUE_CONFLICT',
  'COLLABORATION_RISK',
  'CAPABILITY_RISK'
);
CREATE TYPE public."CorrectionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE public."CorrectionStatus" AS ENUM (
  'OPEN', 'ACKNOWLEDGED', 'ACCEPTED', 'REJECTED',
  'EXPLAINED', 'ESCALATED', 'RESOLVED', 'CANCELLED'
);
CREATE TYPE public."CorrectionFeedbackAction" AS ENUM (
  'ACKNOWLEDGE', 'ACCEPT', 'REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE', 'CANCEL'
);

CREATE TABLE public."business_events" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_type" VARCHAR(160) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "aggregate_type" public."BusinessEventSubjectType" NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "aggregate_version" INTEGER,
  "subject_type" public."BusinessEventSubjectType" NOT NULL,
  "subject_id" UUID NOT NULL,
  "subject_version" INTEGER,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "produced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_scope" JSONB NOT NULL,
  "payload" JSONB NOT NULL,
  "evidence_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "correlation_id" UUID NOT NULL,
  "causation_id" UUID,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "sensitivity" public."BusinessEventSensitivity" NOT NULL,
  "retain_until" TIMESTAMPTZ(6) NOT NULL,
  "retention_action" public."BusinessEventRetentionAction" NOT NULL,
  "legal_hold" BOOLEAN NOT NULL DEFAULT false,
  "source_system" VARCHAR(100) NOT NULL,
  "source_record_id" VARCHAR(500) NOT NULL,
  "source_version" VARCHAR(200) NOT NULL,
  "producer" VARCHAR(160) NOT NULL,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "event_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_events_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "business_events_idempotency_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "business_events_source_identity_key" UNIQUE (
    "tenant_id", "source_system", "source_record_id", "source_version", "event_type"
  ),
  CONSTRAINT "business_events_schema_version_check" CHECK ("schema_version" > 0),
  CONSTRAINT "business_events_subject_version_check" CHECK (
    "subject_version" IS NULL OR "subject_version" > 0
  ),
  CONSTRAINT "business_events_aggregate_version_check" CHECK (
    "aggregate_version" IS NULL OR "aggregate_version" > 0
  ),
  CONSTRAINT "business_events_event_type_check" CHECK (
    "event_type" ~ '^[A-Za-z][A-Za-z0-9]*([._:-][A-Za-z0-9]+)*$'
  ),
  CONSTRAINT "business_events_time_check" CHECK ("produced_at" >= "occurred_at"),
  CONSTRAINT "business_events_retention_check" CHECK ("retain_until" > "produced_at"),
  CONSTRAINT "business_events_no_self_causation_check" CHECK (
    "causation_id" IS NULL OR "causation_id" <> "id"
  ),
  CONSTRAINT "business_events_scope_object_check" CHECK (
    jsonb_typeof("organization_scope") = 'object'
  ),
  CONSTRAINT "business_events_payload_object_check" CHECK (
    jsonb_typeof("payload") = 'object' AND "payload" <> '{}'::jsonb
  ),
  CONSTRAINT "business_events_evidence_refs_array_check" CHECK (
    jsonb_typeof("evidence_refs") = 'array'
  ),
  CONSTRAINT "business_events_permission_labels_array_check" CHECK (
    jsonb_typeof("permission_labels") = 'array'
  ),
  CONSTRAINT "business_events_hash_check" CHECK ("event_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "business_events_text_check" CHECK (
    btrim("idempotency_key") <> ''
    AND btrim("source_system") <> ''
    AND btrim("source_record_id") <> ''
    AND btrim("source_version") <> ''
    AND btrim("producer") <> ''
  )
);

CREATE TABLE public."business_event_evidence" (
  "tenant_id" UUID NOT NULL,
  "business_event_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_event_evidence_pkey" PRIMARY KEY (
    "tenant_id", "business_event_id", "evidence_id", "evidence_version"
  ),
  CONSTRAINT "business_event_evidence_version_check" CHECK ("evidence_version" > 0),
  CONSTRAINT "business_event_evidence_hash_check" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public."business_event_deliveries" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "business_event_id" UUID NOT NULL,
  "consumer_name" VARCHAR(160) NOT NULL,
  "status" public."BusinessEventDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_by" VARCHAR(160),
  "locked_until" TIMESTAMPTZ(6),
  "processed_at" TIMESTAMPTZ(6),
  "dead_lettered_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(160),
  "last_error_detail" TEXT,
  "replay_count" INTEGER NOT NULL DEFAULT 0,
  "replayed_at" TIMESTAMPTZ(6),
  "replayed_by_user_id" UUID,
  "replay_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_event_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_event_deliveries_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "business_event_deliveries_effect_identity_key" UNIQUE (
    "tenant_id", "id", "business_event_id", "consumer_name"
  ),
  CONSTRAINT "business_event_deliveries_consumer_key" UNIQUE (
    "tenant_id", "business_event_id", "consumer_name"
  ),
  CONSTRAINT "business_event_deliveries_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "business_event_deliveries_attempts_check" CHECK (
    "attempts" >= 0 AND "attempts" <= 1000 AND "replay_count" >= 0
  ),
  CONSTRAINT "business_event_deliveries_lease_pair_check" CHECK (
    ("locked_by" IS NULL) = ("locked_until" IS NULL)
  ),
  CONSTRAINT "business_event_deliveries_processing_lease_check" CHECK (
    "status" <> 'PROCESSING' OR "locked_until" IS NOT NULL
  ),
  CONSTRAINT "business_event_deliveries_processed_time_check" CHECK (
    "status" <> 'PROCESSED' OR "processed_at" IS NOT NULL
  ),
  CONSTRAINT "business_event_deliveries_dead_time_check" CHECK (
    "status" <> 'DEAD_LETTERED' OR "dead_lettered_at" IS NOT NULL
  ),
  CONSTRAINT "business_event_deliveries_error_pair_check" CHECK (
    ("last_error_code" IS NULL) = ("last_error_detail" IS NULL)
  ),
  CONSTRAINT "business_event_deliveries_error_state_check" CHECK (
    "status" NOT IN ('RETRY_SCHEDULED', 'DEAD_LETTERED')
    OR "last_error_code" IS NOT NULL
  ),
  CONSTRAINT "business_event_deliveries_replay_shape_check" CHECK (
    (
      "replayed_by_user_id" IS NULL
      AND "replayed_at" IS NULL
      AND "replay_reason" IS NULL
      AND "replay_count" = 0
    )
    OR (
      "replayed_by_user_id" IS NOT NULL
      AND "replayed_at" IS NOT NULL
      AND "replay_reason" IS NOT NULL
      AND btrim("replay_reason") <> ''
      AND "replay_count" > 0
    )
  ),
  CONSTRAINT "business_event_deliveries_text_check" CHECK (
    btrim("consumer_name") <> ''
    AND ("locked_by" IS NULL OR btrim("locked_by") <> '')
    AND ("last_error_code" IS NULL OR btrim("last_error_code") <> '')
    AND ("last_error_detail" IS NULL OR btrim("last_error_detail") <> '')
  )
);

CREATE TABLE public."business_event_effects" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "business_event_id" UUID NOT NULL,
  "delivery_id" UUID NOT NULL,
  "consumer_name" VARCHAR(160) NOT NULL,
  "effect_key" VARCHAR(240) NOT NULL,
  "status" public."BusinessEventEffectStatus" NOT NULL DEFAULT 'STARTED',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "request_hash" VARCHAR(64) NOT NULL,
  "result_hash" VARCHAR(64),
  "provider_receipt" JSONB,
  "error_code" VARCHAR(160),
  "error_detail" TEXT,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_event_effects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_event_effects_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "business_event_effects_once_key" UNIQUE (
    "tenant_id", "consumer_name", "effect_key"
  ),
  CONSTRAINT "business_event_effects_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "business_event_effects_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("result_hash" IS NULL OR "result_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "business_event_effects_receipt_object_check" CHECK (
    "provider_receipt" IS NULL OR jsonb_typeof("provider_receipt") = 'object'
  ),
  CONSTRAINT "business_event_effects_error_pair_check" CHECK (
    ("error_code" IS NULL) = ("error_detail" IS NULL)
  ),
  CONSTRAINT "business_event_effects_terminal_check" CHECK (
    "status" NOT IN ('APPLIED', 'FAILED') OR "completed_at" IS NOT NULL
  ),
  CONSTRAINT "business_event_effects_applied_hash_check" CHECK (
    "status" <> 'APPLIED' OR "result_hash" IS NOT NULL
  ),
  CONSTRAINT "business_event_effects_failed_error_check" CHECK (
    "status" <> 'FAILED' OR "error_code" IS NOT NULL
  ),
  CONSTRAINT "business_event_effects_terminal_time_check" CHECK (
    ("status" = 'STARTED' AND "completed_at" IS NULL)
    OR ("status" <> 'STARTED' AND "completed_at" IS NOT NULL)
  ),
  CONSTRAINT "business_event_effects_unknown_proof_check" CHECK (
    "status" <> 'UNKNOWN'
    OR "provider_receipt" IS NOT NULL
    OR "error_code" IS NOT NULL
  ),
  CONSTRAINT "business_event_effects_text_check" CHECK (
    btrim("consumer_name") <> ''
    AND btrim("effect_key") <> ''
    AND ("error_code" IS NULL OR btrim("error_code") <> '')
    AND ("error_detail" IS NULL OR btrim("error_detail") <> '')
  )
);

CREATE TABLE public."collaborations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "correlation_id" UUID NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "task_id" UUID NOT NULL,
  "task_version" INTEGER NOT NULL,
  "requester_role_assignment_id" UUID NOT NULL,
  "status" public."CollaborationStatus" NOT NULL DEFAULT 'REQUESTED',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "common_goal" TEXT NOT NULL,
  "requested_input" TEXT NOT NULL,
  "expected_output_schema" JSONB NOT NULL,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "latest_message_id" UUID,
  "latest_message_hash" VARCHAR(64),
  "latest_occurred_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collaborations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "collaborations_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "collaborations_correlation_key" UNIQUE ("tenant_id", "correlation_id"),
  CONSTRAINT "collaborations_idempotency_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "collaborations_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "collaborations_version_check" CHECK (
    "objective_version" > 0 AND "task_version" > 0
  ),
  CONSTRAINT "collaborations_goal_check" CHECK (
    btrim("common_goal") <> '' AND btrim("requested_input") <> ''
  ),
  CONSTRAINT "collaborations_schema_object_check" CHECK (
    jsonb_typeof("expected_output_schema") = 'object'
    AND "expected_output_schema" <> '{}'::jsonb
  ),
  CONSTRAINT "collaborations_due_check" CHECK ("due_at" > "created_at"),
  CONSTRAINT "collaborations_labels_array_check" CHECK (
    jsonb_typeof("permission_labels") = 'array'
  ),
  CONSTRAINT "collaborations_latest_pair_check" CHECK (
    ("latest_message_id" IS NULL) = ("latest_message_hash" IS NULL)
    AND ("latest_message_id" IS NULL) = ("latest_occurred_at" IS NULL)
    AND (
      ("revision" = 0 AND "latest_message_id" IS NULL)
      OR ("revision" > 0 AND "latest_message_id" IS NOT NULL)
    )
  ),
  CONSTRAINT "collaborations_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("latest_message_hash" IS NULL OR "latest_message_hash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE TABLE public."collaboration_participants" (
  "tenant_id" UUID NOT NULL,
  "collaboration_id" UUID NOT NULL,
  "role_assignment_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "agent_id" UUID,
  "participant_role" public."CollaborationParticipantRole" NOT NULL,
  "assignment_snapshot" JSONB NOT NULL,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collaboration_participants_pkey" PRIMARY KEY (
    "tenant_id", "collaboration_id", "role_assignment_id"
  ),
  CONSTRAINT "collaboration_participants_snapshot_check" CHECK (
    jsonb_typeof("assignment_snapshot") = 'object'
  ),
  CONSTRAINT "collaboration_participants_labels_check" CHECK (
    jsonb_typeof("permission_labels") = 'array'
  )
);

CREATE TABLE public."collaboration_messages" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "collaboration_id" UUID NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL,
  "correlation_id" UUID NOT NULL,
  "causation_id" UUID,
  "type" public."CollaborationMessageType" NOT NULL,
  "sender_type" public."ProcessActorType" NOT NULL,
  "sender_user_id" UUID,
  "sender_agent_id" UUID,
  "sender_role_assignment_id" UUID NOT NULL,
  "recipient_role_assignment_ids" JSONB NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "task_id" UUID NOT NULL,
  "task_version" INTEGER NOT NULL,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "previous_hash" VARCHAR(64),
  "message_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collaboration_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "collaboration_messages_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "collaboration_messages_revision_key" UNIQUE (
    "tenant_id", "collaboration_id", "revision"
  ),
  CONSTRAINT "collaboration_messages_idempotency_key" UNIQUE (
    "tenant_id", "idempotency_key"
  ),
  CONSTRAINT "collaboration_messages_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "collaboration_messages_schema_version_check" CHECK ("schema_version" > 0),
  CONSTRAINT "collaboration_messages_subject_version_check" CHECK (
    "objective_version" > 0 AND "task_version" > 0
  ),
  CONSTRAINT "collaboration_messages_no_self_causation_check" CHECK (
    "causation_id" IS NULL OR "causation_id" <> "id"
  ),
  CONSTRAINT "collaboration_messages_sender_shape_check" CHECK (
    (
      "sender_type" = 'USER'
      AND "sender_user_id" IS NOT NULL
      AND "sender_agent_id" IS NULL
    )
    OR (
      "sender_type" = 'AGENT'
      AND "sender_user_id" IS NULL
      AND "sender_agent_id" IS NOT NULL
    )
  ),
  CONSTRAINT "collaboration_messages_recipients_array_check" CHECK (
    jsonb_typeof("recipient_role_assignment_ids") = 'array'
    AND jsonb_array_length("recipient_role_assignment_ids") > 0
  ),
  CONSTRAINT "collaboration_messages_payload_object_check" CHECK (
    jsonb_typeof("payload") = 'object' AND "payload" <> '{}'::jsonb
  ),
  CONSTRAINT "collaboration_messages_labels_array_check" CHECK (
    jsonb_typeof("permission_labels") = 'array'
  ),
  CONSTRAINT "collaboration_messages_hash_check" CHECK (
    "message_hash" ~ '^[0-9a-f]{64}$'
    AND ("previous_hash" IS NULL OR "previous_hash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE TABLE public."collaboration_message_recipients" (
  "tenant_id" UUID NOT NULL,
  "collaboration_message_id" UUID NOT NULL,
  "role_assignment_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collaboration_message_recipients_pkey" PRIMARY KEY (
    "tenant_id", "collaboration_message_id", "role_assignment_id"
  )
);

CREATE TABLE public."collaboration_message_evidence" (
  "tenant_id" UUID NOT NULL,
  "collaboration_message_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collaboration_message_evidence_pkey" PRIMARY KEY (
    "tenant_id", "collaboration_message_id", "evidence_id", "evidence_version"
  ),
  CONSTRAINT "collaboration_message_evidence_version_check" CHECK ("evidence_version" > 0),
  CONSTRAINT "collaboration_message_evidence_hash_check" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public."correction_cases" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "correlation_id" UUID NOT NULL,
  "subject_type" public."BusinessEventSubjectType" NOT NULL,
  "subject_id" UUID NOT NULL,
  "subject_version" INTEGER,
  "role_assignment_id" UUID NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "task_id" UUID NOT NULL,
  "task_version" INTEGER NOT NULL,
  "process_instance_id" UUID,
  "trigger" TEXT NOT NULL,
  "category" public."CorrectionCategory" NOT NULL,
  "severity" public."CorrectionSeverity" NOT NULL,
  "confidence" NUMERIC(12, 10) NOT NULL,
  "rule_findings" JSONB NOT NULL,
  "model_finding" TEXT,
  "evidence_refs" JSONB NOT NULL,
  "impact" TEXT NOT NULL,
  "suggested_actions" JSONB NOT NULL,
  "required_role_assignment_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" public."CorrectionStatus" NOT NULL DEFAULT 'OPEN',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "correction_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "correction_cases_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "correction_cases_idempotency_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "correction_cases_subject_version_check" CHECK (
    "subject_version" IS NULL OR "subject_version" > 0
  ),
  CONSTRAINT "correction_cases_versions_check" CHECK (
    "objective_version" > 0 AND "task_version" > 0 AND "revision" > 0
  ),
  CONSTRAINT "correction_cases_confidence_check" CHECK (
    "confidence" >= 0 AND "confidence" <= 1
  ),
  CONSTRAINT "correction_cases_nonempty_check" CHECK (
    btrim("trigger") <> '' AND btrim("impact") <> ''
  ),
  CONSTRAINT "correction_cases_arrays_check" CHECK (
    jsonb_typeof("rule_findings") = 'array'
    AND jsonb_array_length("rule_findings") > 0
    AND jsonb_typeof("evidence_refs") = 'array'
    AND jsonb_array_length("evidence_refs") > 0
    AND jsonb_typeof("suggested_actions") = 'array'
    AND jsonb_array_length("suggested_actions") > 0
    AND jsonb_typeof("required_role_assignment_ids") = 'array'
    AND jsonb_typeof("permission_labels") = 'array'
  ),
  CONSTRAINT "correction_cases_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public."correction_case_evidence" (
  "tenant_id" UUID NOT NULL,
  "correction_case_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "correction_case_evidence_pkey" PRIMARY KEY (
    "tenant_id", "correction_case_id", "evidence_id", "evidence_version"
  ),
  CONSTRAINT "correction_case_evidence_version_check" CHECK ("evidence_version" > 0),
  CONSTRAINT "correction_case_evidence_hash_check" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public."correction_feedback" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "correction_case_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" public."CorrectionFeedbackAction" NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "actor_role_assignment_id" UUID NOT NULL,
  "comment" TEXT NOT NULL,
  "evidence_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "correction_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "correction_feedback_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "correction_feedback_revision_key" UNIQUE (
    "tenant_id", "correction_case_id", "revision"
  ),
  CONSTRAINT "correction_feedback_idempotency_key" UNIQUE (
    "tenant_id", "idempotency_key"
  ),
  CONSTRAINT "correction_feedback_revision_check" CHECK ("revision" > 1),
  CONSTRAINT "correction_feedback_comment_check" CHECK (btrim("comment") <> ''),
  CONSTRAINT "correction_feedback_evidence_array_check" CHECK (
    jsonb_typeof("evidence_ids") = 'array'
  )
);

CREATE TABLE public."correction_feedback_evidence" (
  "tenant_id" UUID NOT NULL,
  "correction_feedback_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "correction_feedback_evidence_pkey" PRIMARY KEY (
    "tenant_id", "correction_feedback_id", "evidence_id", "evidence_version"
  ),
  CONSTRAINT "correction_feedback_evidence_version_check" CHECK ("evidence_version" > 0),
  CONSTRAINT "correction_feedback_evidence_hash_check" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
  )
);

-- Tenant-safe foreign keys.
ALTER TABLE public."business_events"
  ADD CONSTRAINT "business_events_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "business_events_causation_fkey"
    FOREIGN KEY ("tenant_id", "causation_id")
    REFERENCES public."business_events"("tenant_id", "id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."business_event_evidence"
  ADD CONSTRAINT "business_event_evidence_event_fkey"
    FOREIGN KEY ("tenant_id", "business_event_id")
    REFERENCES public."business_events"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "business_event_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version") ON DELETE RESTRICT;
ALTER TABLE public."business_event_deliveries"
  ADD CONSTRAINT "business_event_deliveries_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "business_event_deliveries_event_fkey"
    FOREIGN KEY ("tenant_id", "business_event_id")
    REFERENCES public."business_events"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "business_event_deliveries_replayer_fkey"
    FOREIGN KEY ("tenant_id", "replayed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."business_event_effects"
  ADD CONSTRAINT "business_event_effects_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "business_event_effects_event_fkey"
    FOREIGN KEY ("tenant_id", "business_event_id")
    REFERENCES public."business_events"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "business_event_effects_delivery_fkey"
    FOREIGN KEY (
      "tenant_id", "delivery_id", "business_event_id", "consumer_name"
    )
    REFERENCES public."business_event_deliveries"(
      "tenant_id", "id", "business_event_id", "consumer_name"
    ) ON DELETE RESTRICT;

ALTER TABLE public."collaborations"
  ADD CONSTRAINT "collaborations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaborations_objective_fkey"
    FOREIGN KEY ("tenant_id", "objective_id", "objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaborations_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaborations_requester_fkey"
    FOREIGN KEY ("tenant_id", "requester_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."collaboration_participants"
  ADD CONSTRAINT "collaboration_participants_collaboration_fkey"
    FOREIGN KEY ("tenant_id", "collaboration_id")
    REFERENCES public."collaborations"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_participants_assignment_fkey"
    FOREIGN KEY ("tenant_id", "role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_participants_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_participants_agent_fkey"
    FOREIGN KEY ("tenant_id", "agent_id")
    REFERENCES public."agent_instances"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."collaboration_messages"
  ADD CONSTRAINT "collaboration_messages_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_messages_collaboration_fkey"
    FOREIGN KEY ("tenant_id", "collaboration_id")
    REFERENCES public."collaborations"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_messages_causation_fkey"
    FOREIGN KEY ("tenant_id", "causation_id")
    REFERENCES public."collaboration_messages"("tenant_id", "id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "collaboration_messages_sender_user_fkey"
    FOREIGN KEY ("tenant_id", "sender_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_messages_sender_agent_fkey"
    FOREIGN KEY ("tenant_id", "sender_agent_id")
    REFERENCES public."agent_instances"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_messages_sender_assignment_fkey"
    FOREIGN KEY ("tenant_id", "sender_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_messages_objective_fkey"
    FOREIGN KEY ("tenant_id", "objective_id", "objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_messages_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version") ON DELETE RESTRICT;
ALTER TABLE public."collaborations"
  ADD CONSTRAINT "collaborations_latest_message_fkey"
    FOREIGN KEY ("tenant_id", "latest_message_id")
    REFERENCES public."collaboration_messages"("tenant_id", "id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."collaboration_message_recipients"
  ADD CONSTRAINT "collaboration_message_recipients_message_fkey"
    FOREIGN KEY ("tenant_id", "collaboration_message_id")
    REFERENCES public."collaboration_messages"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_message_recipients_assignment_fkey"
    FOREIGN KEY ("tenant_id", "role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."collaboration_message_evidence"
  ADD CONSTRAINT "collaboration_message_evidence_message_fkey"
    FOREIGN KEY ("tenant_id", "collaboration_message_id")
    REFERENCES public."collaboration_messages"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "collaboration_message_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version") ON DELETE RESTRICT;

ALTER TABLE public."correction_cases"
  ADD CONSTRAINT "correction_cases_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_cases_assignment_fkey"
    FOREIGN KEY ("tenant_id", "role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_cases_objective_fkey"
    FOREIGN KEY ("tenant_id", "objective_id", "objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_cases_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_cases_process_instance_fkey"
    FOREIGN KEY ("tenant_id", "process_instance_id")
    REFERENCES public."process_instances"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."correction_case_evidence"
  ADD CONSTRAINT "correction_case_evidence_case_fkey"
    FOREIGN KEY ("tenant_id", "correction_case_id")
    REFERENCES public."correction_cases"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_case_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version") ON DELETE RESTRICT;
ALTER TABLE public."correction_feedback"
  ADD CONSTRAINT "correction_feedback_case_fkey"
    FOREIGN KEY ("tenant_id", "correction_case_id")
    REFERENCES public."correction_cases"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_feedback_actor_user_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_feedback_actor_assignment_fkey"
    FOREIGN KEY ("tenant_id", "actor_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE public."correction_feedback_evidence"
  ADD CONSTRAINT "correction_feedback_evidence_feedback_fkey"
    FOREIGN KEY ("tenant_id", "correction_feedback_id")
    REFERENCES public."correction_feedback"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "correction_feedback_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version") ON DELETE RESTRICT;

CREATE INDEX "business_events_trace_idx"
  ON public."business_events"("tenant_id", "correlation_id", "produced_at", "id");
CREATE INDEX "business_events_subject_idx"
  ON public."business_events"(
    "tenant_id", "subject_type", "subject_id", "subject_version", "occurred_at"
  );
CREATE INDEX "business_event_deliveries_claim_idx"
  ON public."business_event_deliveries"(
    "status", "available_at", "locked_until", "created_at", "id"
  );
CREATE INDEX "business_event_deliveries_tenant_status_idx"
  ON public."business_event_deliveries"(
    "tenant_id", "status", "updated_at", "id"
  );
CREATE INDEX "collaborations_task_idx"
  ON public."collaborations"("tenant_id", "task_id", "task_version", "updated_at", "id");
CREATE UNIQUE INDEX "collaboration_participants_active_user_key"
  ON public."collaboration_participants"(
    "tenant_id", "collaboration_id", "user_id"
  )
  WHERE "active";
CREATE UNIQUE INDEX "collaboration_participants_active_agent_key"
  ON public."collaboration_participants"(
    "tenant_id", "collaboration_id", "agent_id"
  )
  WHERE "active" AND "agent_id" IS NOT NULL;
CREATE INDEX "collaboration_messages_trace_idx"
  ON public."collaboration_messages"(
    "tenant_id", "collaboration_id", "revision", "occurred_at", "id"
  );
CREATE INDEX "correction_cases_task_idx"
  ON public."correction_cases"(
    "tenant_id", "task_id", "task_version", "status", "updated_at", "id"
  );
CREATE INDEX "correction_feedback_trace_idx"
  ON public."correction_feedback"(
    "tenant_id", "correction_case_id", "revision", "occurred_at", "id"
  );

-- Append-only ledgers.
CREATE OR REPLACE FUNCTION public.guard_business_ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'The business event/protocol ledger is append-only.'
    USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_events',
    'business_event_evidence',
    'collaboration_messages',
    'collaboration_message_recipients',
    'collaboration_message_evidence',
    'correction_case_evidence',
    'correction_feedback',
    'correction_feedback_evidence'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.guard_business_ledger_append_only()',
      table_name || '_append_only_trigger',
      table_name
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_business_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  cause_record record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW."tenant_id"::text || ':business-event:' || NEW."correlation_id"::text, 0)
  );
  IF NEW."causation_id" IS NOT NULL THEN
    SELECT "correlation_id", "produced_at"
      INTO cause_record
    FROM public."business_events"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."causation_id";
    IF cause_record IS NULL
       OR cause_record."correlation_id" <> NEW."correlation_id"
       OR cause_record."produced_at" > NEW."occurred_at" THEN
      RAISE EXCEPTION 'Business Event causation must remain in one monotonic trace.'
        USING ERRCODE = '23514', CONSTRAINT = 'business_events_causation_trace_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "business_events_insert_guard_trigger"
  BEFORE INSERT ON public."business_events"
  FOR EACH ROW EXECUTE FUNCTION public.guard_business_event_insert();

CREATE OR REPLACE FUNCTION public.guard_event_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  evidence_valid boolean;
BEGIN
  SELECT
    evidence."status" = 'ACTIVE'
    AND evidence."content_hash" = NEW."content_hash"
    AND evidence."verified_at" IS NOT NULL
    AND evidence."effective_from" <= CURRENT_TIMESTAMP
    AND (evidence."effective_to" IS NULL OR evidence."effective_to" > CURRENT_TIMESTAMP)
  INTO evidence_valid
  FROM public."evidence" evidence
  WHERE evidence."tenant_id" = NEW."tenant_id"
    AND evidence."id" = NEW."evidence_id"
    AND evidence."version" = NEW."evidence_version"
  FOR SHARE;
  IF COALESCE(evidence_valid, false) = false THEN
    RAISE EXCEPTION 'An event reference requires active evidence with the exact content hash.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_active_evidence_check';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "business_event_evidence_insert_guard_trigger"
  BEFORE INSERT ON public."business_event_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_evidence_insert();
CREATE TRIGGER "collaboration_message_evidence_insert_guard_trigger"
  BEFORE INSERT ON public."collaboration_message_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_evidence_insert();
CREATE TRIGGER "correction_case_evidence_insert_guard_trigger"
  BEFORE INSERT ON public."correction_case_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_evidence_insert();
CREATE TRIGGER "correction_feedback_evidence_insert_guard_trigger"
  BEFORE INSERT ON public."correction_feedback_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_evidence_insert();

CREATE OR REPLACE FUNCTION public.guard_event_delivery_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."status" <> 'PENDING'
     OR NEW."revision" <> 1
     OR NEW."attempts" <> 0
     OR NEW."replay_count" <> 0
     OR NEW."locked_by" IS NOT NULL
     OR NEW."locked_until" IS NOT NULL
     OR NEW."processed_at" IS NOT NULL
     OR NEW."dead_lettered_at" IS NOT NULL
     OR NEW."last_error_code" IS NOT NULL
     OR NEW."last_error_detail" IS NOT NULL
     OR NEW."replayed_at" IS NOT NULL
     OR NEW."replayed_by_user_id" IS NOT NULL
     OR NEW."replay_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'A Business Event Delivery must start as clean PENDING revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_initial_state_check';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "business_event_deliveries_insert_guard_trigger"
  BEFORE INSERT ON public."business_event_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_delivery_insert();

CREATE OR REPLACE FUNCTION public.guard_event_delivery_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (
    NEW."tenant_id", NEW."business_event_id", NEW."consumer_name", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."business_event_id", OLD."consumer_name", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Business Event Delivery identity is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Business Event Delivery transition requires revision CAS.'
      USING ERRCODE = '40001', CONSTRAINT = 'business_event_deliveries_revision_cas';
  END IF;
  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('PROCESSING', 'DEAD_LETTERED'))
    OR (OLD."status" = 'RETRY_SCHEDULED' AND NEW."status" IN ('PROCESSING', 'DEAD_LETTERED'))
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN (
      'PROCESSED', 'RETRY_SCHEDULED', 'DEAD_LETTERED'
    ))
    OR (
      OLD."status" = 'DEAD_LETTERED'
      AND NEW."status" = 'PENDING'
      AND NEW."replay_count" = OLD."replay_count" + 1
      AND NEW."replayed_by_user_id" IS NOT NULL
      AND NEW."replayed_at" IS NOT NULL
      AND NEW."replay_reason" IS NOT NULL
      AND NEW."replayed_by_user_id" =
        nullif(current_setting('app.user_id', true), '')::uuid
      AND EXISTS (
        SELECT 1
        FROM public."users" replay_actor
        WHERE replay_actor."tenant_id" = NEW."tenant_id"
          AND replay_actor."id" = NEW."replayed_by_user_id"
          AND replay_actor."status" = 'ACTIVE'
          AND replay_actor."role" IN ('OWNER', 'ADMIN')
      )
      AND NEW."replayed_at" BETWEEN
        statement_timestamp() - interval '5 minutes'
        AND statement_timestamp() + interval '1 minute'
      AND NEW."available_at" = NEW."replayed_at"
    )
  ) THEN
    RAISE EXCEPTION 'Invalid Business Event Delivery status transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_transition_check';
  END IF;
  IF OLD."status" <> 'DEAD_LETTERED'
     AND NEW."replay_count" <> OLD."replay_count" THEN
    RAISE EXCEPTION 'Only a dead-letter replay can increment replay_count.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_replay_count_check';
  END IF;
  IF (
    OLD."status" <> 'DEAD_LETTERED'
    AND (
      NEW."replayed_at", NEW."replayed_by_user_id", NEW."replay_reason"
    ) IS DISTINCT FROM (
      OLD."replayed_at", OLD."replayed_by_user_id", OLD."replay_reason"
    )
  ) THEN
    RAISE EXCEPTION 'Replay attribution is immutable outside the dead-letter replay transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_replay_attribution_check';
  END IF;
  IF (
    NEW."status" = 'PROCESSING'
    AND (
      NEW."attempts" <> OLD."attempts" + 1
      OR OLD."available_at" > CURRENT_TIMESTAMP
      OR NEW."available_at" <> OLD."available_at"
      OR NEW."locked_by" IS NULL
      OR NEW."locked_until" <= CURRENT_TIMESTAMP
      OR NEW."processed_at" IS NOT NULL
      OR NEW."dead_lettered_at" IS NOT NULL
    )
  ) OR (
    NEW."status" <> 'PROCESSING'
    AND NEW."attempts" <> OLD."attempts"
  ) THEN
    RAISE EXCEPTION 'Business Event Delivery attempts and leases do not match the transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_attempt_lease_check';
  END IF;
  IF (
    NEW."status" = 'PROCESSED'
    AND (
      NEW."locked_by" IS NOT NULL
      OR NEW."processed_at" IS NULL
      OR NEW."dead_lettered_at" IS NOT NULL
      OR NEW."last_error_code" IS NOT NULL
    )
  ) OR (
    NEW."status" = 'RETRY_SCHEDULED'
    AND (
      NEW."locked_by" IS NOT NULL
      OR NEW."processed_at" IS NOT NULL
      OR NEW."dead_lettered_at" IS NOT NULL
      OR NEW."last_error_code" IS NULL
      OR NEW."available_at" <= CURRENT_TIMESTAMP
    )
  ) OR (
    NEW."status" = 'DEAD_LETTERED'
    AND (
      NEW."locked_by" IS NOT NULL
      OR NEW."processed_at" IS NOT NULL
      OR NEW."dead_lettered_at" IS NULL
      OR NEW."last_error_code" IS NULL
    )
  ) OR (
    OLD."status" = 'DEAD_LETTERED'
    AND NEW."status" = 'PENDING'
    AND (
      NEW."locked_by" IS NOT NULL
      OR NEW."processed_at" IS NOT NULL
      OR NEW."dead_lettered_at" IS NOT NULL
      OR NEW."last_error_code" IS NOT NULL
      OR NEW."available_at" < CURRENT_TIMESTAMP
      OR NEW."replayed_at" IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Business Event Delivery state fields do not match the transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_deliveries_state_fields_check';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "business_event_deliveries_transition_trigger"
  BEFORE UPDATE ON public."business_event_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_delivery_transition();
CREATE TRIGGER "business_event_deliveries_no_delete_trigger"
  BEFORE DELETE ON public."business_event_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.guard_business_ledger_append_only();

CREATE OR REPLACE FUNCTION public.guard_event_effect_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (
    NEW."tenant_id", NEW."business_event_id", NEW."delivery_id",
    NEW."consumer_name", NEW."effect_key", NEW."request_hash",
    NEW."started_at", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."business_event_id", OLD."delivery_id",
    OLD."consumer_name", OLD."effect_key", OLD."request_hash",
    OLD."started_at", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Business Event effect identity is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_effects_identity_immutable';
  END IF;
  IF OLD."status" <> 'STARTED'
     OR NEW."status" NOT IN ('APPLIED', 'FAILED', 'UNKNOWN')
     OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Invalid Business Event effect transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_effects_transition_check';
  END IF;
  IF NEW."completed_at" IS NULL
     OR NEW."completed_at" < OLD."started_at"
     OR (
       NEW."status" = 'APPLIED'
       AND (
         NEW."result_hash" IS NULL
         OR NEW."error_code" IS NOT NULL
       )
     )
     OR (
       NEW."status" = 'FAILED'
       AND (
         NEW."result_hash" IS NOT NULL
         OR NEW."error_code" IS NULL
       )
     )
     OR (
       NEW."status" = 'UNKNOWN'
       AND NEW."provider_receipt" IS NULL
       AND NEW."error_code" IS NULL
     ) THEN
    RAISE EXCEPTION 'Business Event effect terminal proof does not match its status.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_effects_terminal_proof_check';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "business_event_effects_transition_trigger"
  BEFORE UPDATE ON public."business_event_effects"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_effect_transition();
CREATE OR REPLACE FUNCTION public.guard_event_effect_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  delivery_valid boolean;
BEGIN
  IF NEW."status" <> 'STARTED'
     OR NEW."revision" <> 1
     OR NEW."result_hash" IS NOT NULL
     OR NEW."provider_receipt" IS NOT NULL
     OR NEW."completed_at" IS NOT NULL
     OR NEW."error_code" IS NOT NULL
     OR NEW."error_detail" IS NOT NULL THEN
    RAISE EXCEPTION 'A Business Event effect must start as STARTED revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_effects_initial_state_check';
  END IF;
  SELECT
    delivery."status" = 'PROCESSING'
    AND delivery."locked_until" > CURRENT_TIMESTAMP
  INTO delivery_valid
  FROM public."business_event_deliveries" delivery
  WHERE delivery."tenant_id" = NEW."tenant_id"
    AND delivery."id" = NEW."delivery_id"
    AND delivery."business_event_id" = NEW."business_event_id"
    AND delivery."consumer_name" = NEW."consumer_name"
  FOR SHARE;
  IF COALESCE(delivery_valid, false) = false THEN
    RAISE EXCEPTION 'A Business Event effect requires the matching actively leased delivery.'
      USING ERRCODE = '23514', CONSTRAINT = 'business_event_effects_delivery_context_check';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "business_event_effects_insert_guard_trigger"
  BEFORE INSERT ON public."business_event_effects"
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_effect_insert();
CREATE TRIGGER "business_event_effects_no_delete_trigger"
  BEFORE DELETE ON public."business_event_effects"
  FOR EACH ROW EXECUTE FUNCTION public.guard_business_ledger_append_only();

CREATE OR REPLACE FUNCTION public.build_trusted_assignment_snapshot(
  p_tenant_id uuid,
  p_role_assignment_id uuid,
  p_permission_labels jsonb,
  p_effective_at timestamptz,
  p_task_id uuid,
  p_required_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  assignment_record record;
  task_record record;
  duplicate_label_count integer;
  action_family text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Trusted Assignment resolution requires the active tenant context.'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_permission_labels) IS DISTINCT FROM 'array'
     OR p_effective_at IS NULL
     OR p_effective_at > CURRENT_TIMESTAMP
     OR (p_task_id IS NULL) <> (p_required_action IS NULL)
     OR (p_required_action IS NOT NULL AND btrim(p_required_action) = '') THEN
    RAISE EXCEPTION 'Trusted Assignment resolution requires current typed labels.'
      USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_resolution_input_check';
  END IF;
  SELECT count(*) - count(DISTINCT item.value)
    INTO duplicate_label_count
  FROM jsonb_array_elements_text(p_permission_labels) item(value);
  IF duplicate_label_count <> 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_permission_labels) item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
         OR btrim(item.value #>> '{}') = ''
     ) THEN
    RAISE EXCEPTION 'Permission labels must be unique nonempty strings.'
      USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_permission_labels_check';
  END IF;

  SELECT
    assignment."id",
    assignment."version" AS assignment_version,
    assignment."user_id",
    assignment."employment_id",
    assignment."role_template_id",
    assignment."role_version_id",
    assignment."agent_instance_id",
    assignment."organization_scope",
    assignment."permission_scope",
    assignment."effective_from",
    assignment."effective_to",
    employment."organization_id",
    employment."org_unit_id",
    role_version."status" AS role_version_status
  INTO assignment_record
  FROM public."role_assignments" assignment
  JOIN public."employments" employment
    ON employment."tenant_id" = assignment."tenant_id"
   AND employment."id" = assignment."employment_id"
   AND employment."user_id" = assignment."user_id"
   AND employment."status" = 'ACTIVE'
  JOIN public."org_units" unit
    ON unit."tenant_id" = employment."tenant_id"
   AND unit."id" = employment."org_unit_id"
   AND unit."organization_id" = employment."organization_id"
   AND unit."status" = 'ACTIVE'
  JOIN public."agent_versions" role_version
    ON role_version."tenant_id" = assignment."tenant_id"
   AND role_version."template_id" = assignment."role_template_id"
   AND role_version."id" = assignment."role_version_id"
   AND role_version."status" IN ('PUBLISHED', 'RETIRED')
  WHERE assignment."tenant_id" = p_tenant_id
    AND assignment."id" = p_role_assignment_id
    AND assignment."status" = 'ACTIVE'
    AND assignment."effective_from" <= p_effective_at
    AND (assignment."effective_to" IS NULL OR assignment."effective_to" > p_effective_at)
  FOR SHARE OF assignment, employment, unit, role_version;

  IF assignment_record."id" IS NULL
     OR (
       jsonb_array_length(p_permission_labels) > 0
       AND (
         jsonb_typeof(
           COALESCE(
             assignment_record."permission_scope"->'dataLabels',
             assignment_record."permission_scope"->'permissionLabels'
           )
         ) IS DISTINCT FROM 'array'
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(p_permission_labels) required_label(value)
           WHERE NOT (
             COALESCE(
               assignment_record."permission_scope"->'dataLabels',
               assignment_record."permission_scope"->'permissionLabels'
             )
             @> jsonb_build_array(required_label.value)
           )
         )
       )
     ) THEN
    RAISE EXCEPTION 'Role Assignment is not currently effective for the governed labels.'
      USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_resolution_check';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT
      task."id",
      task."objective_id",
      task."objective_version",
      task."owner_user_id",
      task."owner_role_assignment_id",
      task."owner_role_template_id",
      task."owner_org_unit_id",
      task."status"
    INTO task_record
    FROM public."tasks" task
    WHERE task."tenant_id" = p_tenant_id
      AND task."id" = p_task_id
    FOR SHARE;
    action_family := split_part(p_required_action, '.', 2);
    IF task_record."id" IS NULL
       OR task_record."status" NOT IN ('READY', 'IN_PROGRESS', 'BLOCKED')
       OR NOT COALESCE((
         assignment_record."id" = task_record."owner_role_assignment_id"
         OR assignment_record."user_id" = task_record."owner_user_id"
         OR assignment_record."role_template_id" = task_record."owner_role_template_id"
         OR EXISTS (
           SELECT 1
           FROM public."objective_role_assignments" objective_assignment
           WHERE objective_assignment."tenant_id" = p_tenant_id
             AND objective_assignment."objective_id" = task_record."objective_id"
             AND objective_assignment."objective_version" = task_record."objective_version"
             AND objective_assignment."role_assignment_id" = assignment_record."id"
         )
       ), false)
       OR (
         assignment_record."organization_scope" ? 'orgUnitIds'
         AND jsonb_typeof(assignment_record."organization_scope"->'orgUnitIds')
           IS DISTINCT FROM 'array'
       )
       OR (
         task_record."owner_org_unit_id" IS NOT NULL
         AND task_record."owner_org_unit_id" <> assignment_record."org_unit_id"
         AND NOT (
           coalesce(
             assignment_record."organization_scope"->'orgUnitIds',
             '[]'::jsonb
           ) @> jsonb_build_array(task_record."owner_org_unit_id"::text)
         )
       )
       OR (
         assignment_record."permission_scope" ? 'taskIds'
         AND (
           jsonb_typeof(assignment_record."permission_scope"->'taskIds')
             IS DISTINCT FROM 'array'
           OR NOT (
             assignment_record."permission_scope"->'taskIds'
             @> jsonb_build_array(p_task_id::text)
           )
         )
       )
       OR (
         NOT (assignment_record."permission_scope" ? 'actions')
         AND p_required_action <> 'business.task.execute'
       )
       OR (
         assignment_record."permission_scope" ? 'actions'
         AND (
           jsonb_typeof(assignment_record."permission_scope"->'actions')
             IS DISTINCT FROM 'array'
           OR NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(
               assignment_record."permission_scope"->'actions'
             ) action(value)
             WHERE action.value IN (
               '*',
               'business.*',
               p_required_action,
               'business.' || action_family || '.*'
             )
           )
         )
       ) THEN
      RAISE EXCEPTION 'Role Assignment is outside the trusted Task/action scope.'
        USING ERRCODE = '23514', CONSTRAINT = 'trusted_assignment_operational_scope_check';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'roleAssignmentId', assignment_record."id",
    'assignmentVersion', assignment_record."assignment_version",
    'userId', assignment_record."user_id",
    'employmentId', assignment_record."employment_id",
    'organizationId', assignment_record."organization_id",
    'orgUnitId', assignment_record."org_unit_id",
    'roleTemplateId', assignment_record."role_template_id",
    'roleVersionId', assignment_record."role_version_id",
    'roleVersionStatus', assignment_record."role_version_status",
    'agentId', assignment_record."agent_instance_id",
    'organizationScope', assignment_record."organization_scope",
    'permissionScope', assignment_record."permission_scope",
    'effectiveFrom', assignment_record."effective_from",
    'effectiveTo', assignment_record."effective_to"
  );
END
$$;

CREATE OR REPLACE FUNCTION public.guard_collaboration_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requester_snapshot jsonb;
  task_valid boolean;
  task_permission_labels jsonb;
BEGIN
  IF NEW."status" <> 'REQUESTED'
     OR NEW."revision" <> 0
     OR NEW."latest_message_id" IS NOT NULL THEN
    RAISE EXCEPTION 'A Collaboration must be inserted as an unadvanced REQUESTED aggregate.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaborations_initial_state_check';
  END IF;
  requester_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."requester_role_assignment_id",
    NEW."permission_labels",
    CURRENT_TIMESTAMP,
    NEW."task_id",
    'business.task.execute'
  );
  SELECT
    task."objective_id" = NEW."objective_id"
    AND task."objective_version" = NEW."objective_version"
    AND task."status" IN ('READY', 'IN_PROGRESS', 'BLOCKED'),
    task."permission_labels"
  INTO task_valid, task_permission_labels
  FROM public."tasks" task
  WHERE task."tenant_id" = NEW."tenant_id"
    AND task."id" = NEW."task_id"
    AND task."version" = NEW."task_version"
  FOR SHARE;
  IF requester_snapshot IS NULL
     OR COALESCE(task_valid, false) = false
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(task_permission_labels) required_label(value)
       WHERE NOT (
         NEW."permission_labels" @> jsonb_build_array(required_label.value)
       )
     ) THEN
    RAISE EXCEPTION 'Collaboration requires an effective requester Assignment and matching active Task.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaborations_request_context_check';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "collaborations_insert_guard_trigger"
  BEFORE INSERT ON public."collaborations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_collaboration_insert();

CREATE OR REPLACE FUNCTION public.guard_collaboration_participant_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  assignment_snapshot jsonb;
  assigned_user uuid;
  assigned_agent uuid;
  requester_id uuid;
  collaboration_task_id uuid;
  collaboration_labels jsonb;
  identity_conflict boolean;
BEGIN
  SELECT "requester_role_assignment_id", "task_id", "permission_labels"
    INTO requester_id, collaboration_task_id, collaboration_labels
  FROM public."collaborations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."collaboration_id"
  FOR SHARE;
  assignment_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."role_assignment_id",
    collaboration_labels,
    CURRENT_TIMESTAMP,
    collaboration_task_id,
    'business.task.execute'
  );
  assigned_user := (assignment_snapshot->>'userId')::uuid;
  assigned_agent := (assignment_snapshot->>'agentId')::uuid;
  SELECT EXISTS (
    SELECT 1
    FROM public."collaboration_participants" participant
    WHERE participant."tenant_id" = NEW."tenant_id"
      AND participant."collaboration_id" = NEW."collaboration_id"
      AND participant."active"
      AND (
        participant."user_id" = assigned_user
        OR (
          assigned_agent IS NOT NULL
          AND participant."agent_id" = assigned_agent
        )
      )
  ) INTO identity_conflict;
  IF assignment_snapshot IS NULL
     OR requester_id IS NULL
     OR NEW."user_id" <> assigned_user
     OR NEW."agent_id" IS DISTINCT FROM assigned_agent
     OR NOT NEW."active"
     OR identity_conflict
     OR (
       NEW."participant_role" = 'REQUESTER'
       AND NEW."role_assignment_id" <> requester_id
     )
     OR (
       NEW."participant_role" <> 'REQUESTER'
       AND NEW."role_assignment_id" = requester_id
     ) THEN
    RAISE EXCEPTION 'Collaboration participant must match an effective independent Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participants_assignment_check';
  END IF;
  NEW."assignment_snapshot" := assignment_snapshot;
  NEW."permission_labels" := collaboration_labels;
  RETURN NEW;
END
$$;
CREATE TRIGGER "collaboration_participants_insert_guard_trigger"
  BEFORE INSERT ON public."collaboration_participants"
  FOR EACH ROW EXECUTE FUNCTION public.guard_collaboration_participant_insert();
CREATE TRIGGER "collaboration_participants_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."collaboration_participants"
  FOR EACH ROW EXECUTE FUNCTION public.guard_business_ledger_append_only();

CREATE OR REPLACE FUNCTION public.guard_collaboration_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  collaboration_record public."collaborations"%ROWTYPE;
  sender_record public."collaboration_participants"%ROWTYPE;
  sender_assignment_snapshot jsonb;
  expected_recipients jsonb;
  next_status public."CollaborationStatus";
  deliverable_valid boolean;
  acceptance_valid boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."tenant_id"::text || ':collaboration:' || NEW."collaboration_id"::text,
      0
    )
  );
  SELECT *
    INTO collaboration_record
  FROM public."collaborations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."collaboration_id"
  FOR UPDATE;
  IF collaboration_record."id" IS NULL
     OR NEW."correlation_id" <> collaboration_record."correlation_id"
     OR NEW."objective_id" <> collaboration_record."objective_id"
     OR NEW."objective_version" <> collaboration_record."objective_version"
     OR NEW."task_id" <> collaboration_record."task_id"
     OR NEW."task_version" <> collaboration_record."task_version"
     OR NEW."permission_labels" <> collaboration_record."permission_labels"
     OR NEW."occurred_at" < collaboration_record."created_at"
     OR NEW."occurred_at" > CURRENT_TIMESTAMP
     OR NEW."revision" <> collaboration_record."revision" + 1
     OR (
       collaboration_record."revision" = 0
       AND (NEW."type" <> 'REQUEST' OR NEW."causation_id" IS NOT NULL)
     )
     OR (
       collaboration_record."revision" > 0
       AND (
         NEW."type" = 'REQUEST'
         OR NEW."causation_id" IS DISTINCT FROM collaboration_record."latest_message_id"
         OR NEW."previous_hash" IS DISTINCT FROM collaboration_record."latest_message_hash"
         OR NEW."occurred_at" < collaboration_record."latest_occurred_at"
       )
     ) THEN
    RAISE EXCEPTION 'Collaboration message breaks its trusted revision/causation trace.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_messages_trace_check';
  END IF;
  IF NEW."type" = 'REQUEST'
     AND (
       NEW."payload"->>'commonGoal' IS DISTINCT FROM collaboration_record."common_goal"
       OR NEW."payload"->>'requestedInput' IS DISTINCT FROM collaboration_record."requested_input"
       OR NEW."payload"->'expectedOutputSchema'
          IS DISTINCT FROM collaboration_record."expected_output_schema"
       OR (NEW."payload"->>'dueAt')::timestamptz
          IS DISTINCT FROM collaboration_record."due_at"
     ) THEN
    RAISE EXCEPTION 'The initial REQUEST message must cover the immutable Collaboration request.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_messages_request_coverage';
  END IF;

  SELECT *
    INTO sender_record
  FROM public."collaboration_participants"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "collaboration_id" = NEW."collaboration_id"
    AND "role_assignment_id" = NEW."sender_role_assignment_id"
    AND "active";
  sender_assignment_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."sender_role_assignment_id",
    collaboration_record."permission_labels",
    CURRENT_TIMESTAMP,
    collaboration_record."task_id",
    'business.task.execute'
  );
  IF sender_record."role_assignment_id" IS NULL
     OR sender_assignment_snapshot IS NULL
     OR (
       NEW."sender_type" = 'USER'
       AND (
         NEW."sender_user_id" IS DISTINCT FROM sender_record."user_id"
         OR NEW."sender_user_id"::text
            IS DISTINCT FROM sender_assignment_snapshot->>'userId'
       )
     )
     OR (
       NEW."sender_type" = 'AGENT'
       AND (
         NEW."sender_agent_id" IS DISTINCT FROM sender_record."agent_id"
         OR NEW."sender_agent_id"::text
            IS DISTINCT FROM sender_assignment_snapshot->>'agentId'
       )
     )
     OR (
       NEW."type" IN ('REQUEST', 'ACCEPT', 'CANCEL')
       AND sender_record."participant_role" <> 'REQUESTER'
     )
     OR (
       NEW."type" = 'REJECT'
       AND (
         (
           collaboration_record."status" = 'REQUESTED'
           AND sender_record."participant_role" <> 'RECIPIENT'
         )
         OR (
           collaboration_record."status" = 'DELIVERED'
           AND sender_record."participant_role" <> 'REQUESTER'
         )
       )
     )
     OR (
       NEW."type" IN ('COMMIT', 'DELIVER')
       AND sender_record."participant_role" <> 'RECIPIENT'
     )
     OR (
       NEW."type" = 'ESCALATE'
       AND sender_record."participant_role" NOT IN ('REQUESTER', 'RECIPIENT')
     ) THEN
    RAISE EXCEPTION 'Collaboration sender is not the trusted actor for this message.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_messages_sender_check';
  END IF;

  SELECT COALESCE(jsonb_agg("role_assignment_id"::text ORDER BY "role_assignment_id"::text), '[]'::jsonb)
    INTO expected_recipients
  FROM public."collaboration_participants"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "collaboration_id" = NEW."collaboration_id"
    AND "active"
    AND (
      (
        NEW."type" = 'ESCALATE'
        AND "participant_role" = 'DECISION'
      )
      OR (
        NEW."type" <> 'ESCALATE'
        AND "role_assignment_id" <> NEW."sender_role_assignment_id"
        AND "participant_role" IN ('REQUESTER', 'RECIPIENT')
      )
    );
  IF (
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
    FROM jsonb_array_elements_text(NEW."recipient_role_assignment_ids") item(value)
  ) <> expected_recipients THEN
    RAISE EXCEPTION 'Collaboration recipients must exactly match authorized participants.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_messages_recipients_check';
  END IF;

  next_status := CASE
    WHEN NEW."type" = 'REQUEST' AND collaboration_record."revision" = 0 THEN 'REQUESTED'
    WHEN NEW."type" = 'COMMIT' AND collaboration_record."status" IN ('REQUESTED', 'REJECTED')
      THEN 'COMMITTED'
    WHEN NEW."type" = 'DELIVER' AND collaboration_record."status" IN ('COMMITTED', 'REJECTED')
      THEN 'DELIVERED'
    WHEN NEW."type" = 'ACCEPT' AND collaboration_record."status" = 'DELIVERED'
      THEN 'ACCEPTED'
    WHEN NEW."type" = 'REJECT' AND collaboration_record."status" IN ('REQUESTED', 'DELIVERED')
      THEN 'REJECTED'
    WHEN NEW."type" = 'ESCALATE' AND collaboration_record."status" NOT IN (
      'ACCEPTED', 'ESCALATED', 'CANCELLED'
    ) THEN 'ESCALATED'
    WHEN NEW."type" = 'CANCEL' AND collaboration_record."status" NOT IN (
      'ACCEPTED', 'ESCALATED', 'CANCELLED'
    ) THEN 'CANCELLED'
    ELSE NULL
  END;
  IF next_status IS NULL THEN
    RAISE EXCEPTION 'Invalid Collaboration protocol transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_messages_transition_check';
  END IF;

  IF NEW."type" = 'DELIVER' THEN
    SELECT
      deliverable."task_id" = NEW."task_id"
      AND deliverable."task_version" = NEW."task_version"
      AND deliverable."status" = 'SUBMITTED'
      AND deliverable."evidence_sealed_at" IS NOT NULL
    INTO deliverable_valid
    FROM public."deliverables" deliverable
    WHERE deliverable."tenant_id" = NEW."tenant_id"
      AND deliverable."id" = (NEW."payload"->>'deliverableId')::uuid
      AND deliverable."version" = (NEW."payload"->>'deliverableVersion')::integer
    FOR SHARE;
    IF COALESCE(deliverable_valid, false) = false THEN
      RAISE EXCEPTION 'DELIVER requires a sealed submitted Deliverable from this Task.'
        USING ERRCODE = '23514', CONSTRAINT = 'collaboration_deliverable_trace_check';
    END IF;
  ELSIF NEW."type" IN ('ACCEPT', 'REJECT')
    AND collaboration_record."status" = 'DELIVERED' THEN
    IF NEW."sender_type" <> 'USER'
       OR NOT NEW."payload" ? 'acceptanceId'
       OR NOT NEW."payload" ? 'acceptanceVersion'
       OR NEW."payload"->>'acceptanceId' IS NULL
       OR NEW."payload"->>'acceptanceVersion' IS NULL THEN
      RAISE EXCEPTION 'A delivery decision requires an Acceptance identity.'
        USING ERRCODE = '23514', CONSTRAINT = 'collaboration_acceptance_identity_required';
    END IF;
    SELECT
      deliverable."task_id" = NEW."task_id"
      AND deliverable."task_version" = NEW."task_version"
      AND acceptance."deliverable_id" =
        (delivered_message."payload"->>'deliverableId')::uuid
      AND acceptance."deliverable_version" =
        (delivered_message."payload"->>'deliverableVersion')::integer
      AND acceptance."status" = 'ACTIVE'
      AND acceptance."evidence_sealed_at" IS NOT NULL
      AND (
        acceptance."decided_by_user_id" = NEW."sender_user_id"
        OR acceptance."decided_by_role_assignment_id" =
          NEW."sender_role_assignment_id"
      )
      AND EXISTS (
        SELECT 1
        FROM public."acceptance_evidence" acceptance_evidence
        WHERE acceptance_evidence."tenant_id" = acceptance."tenant_id"
          AND acceptance_evidence."acceptance_id" = acceptance."id"
          AND acceptance_evidence."acceptance_version" = acceptance."version"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public."acceptance_evidence" acceptance_evidence
        JOIN public."evidence" evidence
          ON evidence."tenant_id" = acceptance_evidence."tenant_id"
         AND evidence."id" = acceptance_evidence."evidence_id"
         AND evidence."version" = acceptance_evidence."evidence_version"
        WHERE acceptance_evidence."tenant_id" = acceptance."tenant_id"
          AND acceptance_evidence."acceptance_id" = acceptance."id"
          AND acceptance_evidence."acceptance_version" = acceptance."version"
          AND (
            evidence."status" <> 'ACTIVE'
            OR evidence."verified_at" IS NULL
            OR evidence."effective_from" > CURRENT_TIMESTAMP
            OR (
              evidence."effective_to" IS NOT NULL
              AND evidence."effective_to" <= CURRENT_TIMESTAMP
            )
          )
      )
      AND (
        (NEW."type" = 'ACCEPT' AND acceptance."decision" = 'ACCEPTED')
        OR (
          NEW."type" = 'REJECT'
          AND acceptance."decision" IN ('REJECTED', 'CHANGES_REQUESTED')
        )
      )
    INTO acceptance_valid
    FROM public."acceptances" acceptance
    JOIN public."deliverables" deliverable
      ON deliverable."tenant_id" = acceptance."tenant_id"
     AND deliverable."id" = acceptance."deliverable_id"
     AND deliverable."version" = acceptance."deliverable_version"
    JOIN public."collaboration_messages" delivered_message
      ON delivered_message."tenant_id" = collaboration_record."tenant_id"
     AND delivered_message."id" = collaboration_record."latest_message_id"
     AND delivered_message."collaboration_id" = collaboration_record."id"
     AND delivered_message."type" = 'DELIVER'
    WHERE acceptance."tenant_id" = NEW."tenant_id"
      AND acceptance."id" = (NEW."payload"->>'acceptanceId')::uuid
      AND acceptance."version" = (NEW."payload"->>'acceptanceVersion')::integer
    FOR SHARE OF acceptance, deliverable;
    IF COALESCE(acceptance_valid, false) = false THEN
      RAISE EXCEPTION 'ACCEPT/REJECT requires the matching sealed Acceptance decision.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_acceptance_trace_check';
    END IF;
  ELSIF NEW."type" = 'REJECT'
    AND collaboration_record."status" = 'REQUESTED'
    AND (
      NEW."payload" ? 'acceptanceId'
      AND NEW."payload"->>'acceptanceId' IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'A request rejection cannot claim a delivery Acceptance.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_request_rejection_shape_check';
  END IF;

  UPDATE public."collaborations"
  SET "status" = next_status,
      "revision" = NEW."revision",
      "latest_message_id" = NEW."id",
      "latest_message_hash" = NEW."message_hash",
      "latest_occurred_at" = NEW."occurred_at",
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."collaboration_id"
    AND "revision" = collaboration_record."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collaboration revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'collaborations_revision_cas';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "collaboration_messages_insert_guard_trigger"
  AFTER INSERT ON public."collaboration_messages"
  FOR EACH ROW EXECUTE FUNCTION public.guard_collaboration_message_insert();

CREATE OR REPLACE FUNCTION public.guard_collaboration_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  message_record record;
  expected_status public."CollaborationStatus";
BEGIN
  IF (
    NEW."tenant_id", NEW."correlation_id", NEW."objective_id", NEW."objective_version",
    NEW."task_id", NEW."task_version", NEW."requester_role_assignment_id",
    NEW."common_goal", NEW."requested_input", NEW."expected_output_schema",
    NEW."due_at", NEW."permission_labels", NEW."idempotency_key",
    NEW."request_hash", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."correlation_id", OLD."objective_id", OLD."objective_version",
    OLD."task_id", OLD."task_version", OLD."requester_role_assignment_id",
    OLD."common_goal", OLD."requested_input", OLD."expected_output_schema",
    OLD."due_at", OLD."permission_labels", OLD."idempotency_key",
    OLD."request_hash", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Collaboration identity and request are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaborations_identity_immutable';
  END IF;
  SELECT "revision", "message_hash", "occurred_at", "type"
    INTO message_record
  FROM public."collaboration_messages"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."latest_message_id"
    AND "collaboration_id" = NEW."id";
  expected_status := CASE
    WHEN OLD."revision" = 0
      AND OLD."status" = 'REQUESTED'
      AND message_record."type" = 'REQUEST'
      THEN 'REQUESTED'
    WHEN OLD."status" = 'REQUESTED' AND message_record."type" = 'COMMIT'
      THEN 'COMMITTED'
    WHEN OLD."status" = 'REJECTED' AND message_record."type" = 'COMMIT'
      THEN 'COMMITTED'
    WHEN OLD."status" IN ('COMMITTED', 'REJECTED')
      AND message_record."type" = 'DELIVER'
      THEN 'DELIVERED'
    WHEN OLD."status" = 'DELIVERED' AND message_record."type" = 'ACCEPT'
      THEN 'ACCEPTED'
    WHEN OLD."status" IN ('REQUESTED', 'DELIVERED')
      AND message_record."type" = 'REJECT'
      THEN 'REJECTED'
    WHEN OLD."status" NOT IN ('ACCEPTED', 'ESCALATED', 'CANCELLED')
      AND message_record."type" = 'ESCALATE'
      THEN 'ESCALATED'
    WHEN OLD."status" NOT IN ('ACCEPTED', 'ESCALATED', 'CANCELLED')
      AND message_record."type" = 'CANCEL'
      THEN 'CANCELLED'
    ELSE NULL
  END;
  IF NEW."revision" <> OLD."revision" + 1
     OR message_record IS NULL
     OR message_record."revision" <> NEW."revision"
     OR message_record."message_hash" <> NEW."latest_message_hash"
     OR message_record."occurred_at" <> NEW."latest_occurred_at"
     OR expected_status IS NULL
     OR NEW."status" <> expected_status THEN
    RAISE EXCEPTION 'Collaboration state must be advanced by its next immutable message.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaborations_message_coverage';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "collaborations_update_guard_trigger"
  BEFORE UPDATE ON public."collaborations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_collaboration_update();
CREATE TRIGGER "collaborations_no_delete_trigger"
  BEFORE DELETE ON public."collaborations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_business_ledger_append_only();

CREATE OR REPLACE FUNCTION public.validate_collaboration_trace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  message_count integer;
  recipient_mismatch integer;
  requester_count integer;
  recipient_count integer;
  decision_count integer;
  current_record public."collaborations"%ROWTYPE;
  message_record record;
  replay_status text := 'REQUESTED';
  expected_revision integer := 1;
  previous_message_id uuid;
  previous_message_hash text;
  previous_occurred_at timestamptz;
BEGIN
  SELECT *
    INTO current_record
  FROM public."collaborations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."id";
  IF current_record."id" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*)
    INTO message_count
  FROM public."collaboration_messages"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "collaboration_id" = NEW."id";
  IF current_record."revision" < 1
     OR message_count <> current_record."revision"
     OR NOT EXISTS (
       SELECT 1
       FROM public."collaboration_messages" message
       WHERE message."tenant_id" = NEW."tenant_id"
         AND message."id" = current_record."latest_message_id"
         AND message."collaboration_id" = NEW."id"
         AND message."revision" = current_record."revision"
         AND message."message_hash" = current_record."latest_message_hash"
         AND message."occurred_at" = current_record."latest_occurred_at"
     ) THEN
    RAISE EXCEPTION 'Collaboration trace is incomplete.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaborations_complete_trace_check';
  END IF;
  FOR message_record IN
    SELECT *
    FROM public."collaboration_messages" message
    WHERE message."tenant_id" = current_record."tenant_id"
      AND message."collaboration_id" = current_record."id"
    ORDER BY message."revision"
  LOOP
    IF message_record."revision" <> expected_revision
       OR message_record."correlation_id" <> current_record."correlation_id"
       OR message_record."objective_id" <> current_record."objective_id"
       OR message_record."objective_version" <> current_record."objective_version"
       OR message_record."task_id" <> current_record."task_id"
       OR message_record."task_version" <> current_record."task_version"
       OR message_record."permission_labels" <> current_record."permission_labels"
       OR (
         expected_revision = 1
         AND (
           message_record."type" <> 'REQUEST'
           OR message_record."causation_id" IS NOT NULL
           OR message_record."previous_hash" IS NOT NULL
         )
       )
       OR (
         expected_revision > 1
         AND (
           message_record."type" = 'REQUEST'
           OR message_record."causation_id" IS DISTINCT FROM previous_message_id
           OR message_record."previous_hash" IS DISTINCT FROM previous_message_hash
           OR message_record."occurred_at" < previous_occurred_at
         )
       ) THEN
      RAISE EXCEPTION 'Collaboration message trace cannot be replayed.'
        USING ERRCODE = '23514', CONSTRAINT = 'collaborations_trace_replay_check';
    END IF;
    IF expected_revision > 1 THEN
      replay_status := CASE
        WHEN replay_status IN ('REQUESTED', 'REJECTED')
          AND message_record."type" = 'COMMIT'
          THEN 'COMMITTED'
        WHEN replay_status IN ('COMMITTED', 'REJECTED')
          AND message_record."type" = 'DELIVER'
          THEN 'DELIVERED'
        WHEN replay_status = 'DELIVERED' AND message_record."type" = 'ACCEPT'
          THEN 'ACCEPTED'
        WHEN replay_status IN ('REQUESTED', 'DELIVERED')
          AND message_record."type" = 'REJECT'
          THEN 'REJECTED'
        WHEN replay_status NOT IN ('ACCEPTED', 'ESCALATED', 'CANCELLED')
          AND message_record."type" = 'ESCALATE'
          THEN 'ESCALATED'
        WHEN replay_status NOT IN ('ACCEPTED', 'ESCALATED', 'CANCELLED')
          AND message_record."type" = 'CANCEL'
          THEN 'CANCELLED'
        ELSE NULL
      END;
      IF replay_status IS NULL THEN
        RAISE EXCEPTION 'Collaboration message sequence contains an illegal transition.'
          USING ERRCODE = '23514', CONSTRAINT = 'collaborations_trace_status_check';
      END IF;
    END IF;
    previous_message_id := message_record."id";
    previous_message_hash := message_record."message_hash";
    previous_occurred_at := message_record."occurred_at";
    expected_revision := expected_revision + 1;
  END LOOP;
  IF expected_revision <> current_record."revision" + 1
     OR replay_status <> current_record."status"::text
     OR previous_message_id IS DISTINCT FROM current_record."latest_message_id" THEN
    RAISE EXCEPTION 'Collaboration aggregate does not match its replayed immutable trace.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaborations_trace_state_check';
  END IF;
  SELECT
    count(*) FILTER (
      WHERE "participant_role" = 'REQUESTER'
        AND "role_assignment_id" = current_record."requester_role_assignment_id"
        AND "active"
    ),
    count(*) FILTER (WHERE "participant_role" = 'RECIPIENT' AND "active"),
    count(*) FILTER (WHERE "participant_role" = 'DECISION' AND "active")
  INTO requester_count, recipient_count, decision_count
  FROM public."collaboration_participants"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "collaboration_id" = NEW."id";
  IF requester_count <> 1
     OR recipient_count < 1
     OR (current_record."status" = 'ESCALATED' AND decision_count < 1) THEN
    RAISE EXCEPTION 'Collaboration requires its exact active requester, recipients, and decision role.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participants_complete_check';
  END IF;
  SELECT count(*)
    INTO recipient_mismatch
  FROM public."collaboration_messages" message
  WHERE message."tenant_id" = NEW."tenant_id"
    AND message."collaboration_id" = NEW."id"
    AND (
      SELECT COALESCE(jsonb_agg(recipient."role_assignment_id"::text ORDER BY recipient."role_assignment_id"::text), '[]'::jsonb)
      FROM public."collaboration_message_recipients" recipient
      WHERE recipient."tenant_id" = message."tenant_id"
        AND recipient."collaboration_message_id" = message."id"
    ) <> (
      SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
      FROM jsonb_array_elements_text(message."recipient_role_assignment_ids") item(value)
    );
  IF recipient_mismatch <> 0 THEN
    RAISE EXCEPTION 'Collaboration recipient join is incomplete.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_recipients_complete_check';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "collaborations_trace_completeness_trigger"
  AFTER INSERT OR UPDATE ON public."collaborations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_collaboration_trace();

CREATE OR REPLACE FUNCTION public.validate_collaboration_message_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  json_count integer;
  join_count integer;
  mismatch_count integer;
  duplicate_count integer;
BEGIN
  SELECT count(*)
    INTO join_count
  FROM public."collaboration_message_evidence"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "collaboration_message_id" = NEW."id";
  IF NEW."type" IN ('DELIVER', 'ESCALATE') THEN
    IF jsonb_typeof(NEW."payload"->'evidenceRefs') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'DELIVER/ESCALATE requires structured evidence references.'
        USING ERRCODE = '23514', CONSTRAINT = 'collaboration_message_evidence_required';
    END IF;
    json_count := jsonb_array_length(NEW."payload"->'evidenceRefs');
    SELECT count(*) - count(
      DISTINCT (
        reference->>'evidenceId',
        reference->>'version'
      )
    )
      INTO duplicate_count
    FROM jsonb_array_elements(NEW."payload"->'evidenceRefs') reference;
    SELECT count(*)
      INTO mismatch_count
    FROM jsonb_array_elements(NEW."payload"->'evidenceRefs') reference
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."collaboration_message_evidence" message_evidence
      WHERE message_evidence."tenant_id" = NEW."tenant_id"
        AND message_evidence."collaboration_message_id" = NEW."id"
        AND message_evidence."evidence_id" = (reference->>'evidenceId')::uuid
        AND message_evidence."evidence_version" = (reference->>'version')::integer
        AND message_evidence."content_hash" = reference->>'contentHash'
        AND (
          NEW."type" <> 'DELIVER'
          OR EXISTS (
            SELECT 1
            FROM public."deliverable_evidence" deliverable_evidence
            WHERE deliverable_evidence."tenant_id" = NEW."tenant_id"
              AND deliverable_evidence."deliverable_id" =
                (NEW."payload"->>'deliverableId')::uuid
              AND deliverable_evidence."deliverable_version" =
                (NEW."payload"->>'deliverableVersion')::integer
              AND deliverable_evidence."evidence_id" = message_evidence."evidence_id"
              AND deliverable_evidence."evidence_version" =
                message_evidence."evidence_version"
          )
        )
    );
    IF json_count < 1
       OR duplicate_count <> 0
       OR json_count <> join_count
       OR mismatch_count <> 0 THEN
      RAISE EXCEPTION 'Collaboration message evidence ledger is incomplete.'
        USING ERRCODE = '23514', CONSTRAINT = 'collaboration_message_evidence_complete';
    END IF;
  ELSIF join_count <> 0 THEN
    RAISE EXCEPTION 'This Collaboration message type cannot attach evidence rows.'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_message_evidence_unexpected';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "collaboration_message_evidence_completeness_trigger"
  AFTER INSERT ON public."collaboration_messages"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_collaboration_message_evidence();

CREATE OR REPLACE FUNCTION public.guard_correction_case_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  subject_snapshot jsonb;
  reviewer_snapshot jsonb;
  reviewer_id_text text;
  reviewer_count integer := 0;
  task_valid boolean;
  task_permission_labels jsonb;
  process_valid boolean := true;
BEGIN
  IF NEW."status" <> 'OPEN' OR NEW."revision" <> 1 THEN
    RAISE EXCEPTION 'A Correction Case must be inserted as OPEN revision 1.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_initial_state_check';
  END IF;
  subject_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."role_assignment_id",
    NEW."permission_labels",
    CURRENT_TIMESTAMP,
    NEW."task_id",
    'business.task.execute'
  );
  SELECT
    task."objective_id" = NEW."objective_id"
    AND task."objective_version" = NEW."objective_version",
    task."permission_labels"
  INTO task_valid, task_permission_labels
  FROM public."tasks" task
  WHERE task."tenant_id" = NEW."tenant_id"
    AND task."id" = NEW."task_id"
    AND task."version" = NEW."task_version"
  FOR SHARE;
  IF NEW."process_instance_id" IS NOT NULL THEN
    SELECT
      instance."task_id" = NEW."task_id"
      AND instance."task_version" = NEW."task_version"
    INTO process_valid
    FROM public."process_instances" instance
    WHERE instance."tenant_id" = NEW."tenant_id"
      AND instance."id" = NEW."process_instance_id"
    FOR SHARE;
  END IF;
  IF subject_snapshot IS NULL
     OR COALESCE(task_valid, false) = false
     OR COALESCE(process_valid, false) = false
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(task_permission_labels) required_label(value)
       WHERE NOT (
         NEW."permission_labels" @> jsonb_build_array(required_label.value)
       )
     ) THEN
    RAISE EXCEPTION 'Correction case requires an active subject Assignment and matching Task.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_subject_context_check';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."required_role_assignment_ids") reviewer(value)
    WHERE jsonb_typeof(reviewer.value) IS DISTINCT FROM 'string'
  ) OR (
    SELECT count(*) <> count(DISTINCT reviewer.value)
    FROM jsonb_array_elements_text(
      NEW."required_role_assignment_ids"
    ) reviewer(value)
  ) THEN
    RAISE EXCEPTION 'Correction reviewer Assignment IDs must be unique UUID strings.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_reviewers_shape_check';
  END IF;
  FOR reviewer_id_text IN
    SELECT reviewer.value
    FROM jsonb_array_elements_text(
      NEW."required_role_assignment_ids"
    ) reviewer(value)
  LOOP
    reviewer_snapshot := public.build_trusted_assignment_snapshot(
      NEW."tenant_id",
      reviewer_id_text::uuid,
      NEW."permission_labels",
      CURRENT_TIMESTAMP,
      NEW."task_id",
      'business.task.execute'
    );
    IF reviewer_id_text::uuid = NEW."role_assignment_id"
       OR reviewer_snapshot->>'userId' = subject_snapshot->>'userId' THEN
      RAISE EXCEPTION 'Correction reviewers must be independent of the subject.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_independent_reviewers_check';
    END IF;
    reviewer_count := reviewer_count + 1;
  END LOOP;
  IF reviewer_count = 0 THEN
    RAISE EXCEPTION 'A Correction case requires an independent human reviewer.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_reviewer_required';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "correction_cases_insert_guard_trigger"
  BEFORE INSERT ON public."correction_cases"
  FOR EACH ROW EXECUTE FUNCTION public.guard_correction_case_insert();

CREATE OR REPLACE FUNCTION public.guard_correction_feedback_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  correction_record public."correction_cases"%ROWTYPE;
  subject_user_id uuid;
  actor_snapshot jsonb;
  actor_user uuid;
  next_status public."CorrectionStatus";
  evidence_valid_count integer;
  evidence_id_count integer;
  high_impact boolean;
  requires_evidence boolean;
  actor_is_subject boolean;
  actor_is_reviewer boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."tenant_id"::text || ':correction:' || NEW."correction_case_id"::text,
      0
    )
  );
  SELECT *
    INTO correction_record
  FROM public."correction_cases"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
  FOR UPDATE;
  IF correction_record."id" IS NULL
     OR NEW."revision" <> correction_record."revision" + 1
     OR NEW."occurred_at" < correction_record."updated_at"
     OR NEW."occurred_at" > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Correction feedback revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'correction_feedback_revision_cas';
  END IF;
  SELECT "user_id"
    INTO subject_user_id
  FROM public."role_assignments"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = correction_record."role_assignment_id";
  actor_snapshot := public.build_trusted_assignment_snapshot(
    NEW."tenant_id",
    NEW."actor_role_assignment_id",
    correction_record."permission_labels",
    CURRENT_TIMESTAMP,
    correction_record."task_id",
    'business.task.execute'
  );
  actor_user := (actor_snapshot->>'userId')::uuid;
  IF actor_snapshot IS NULL OR actor_user <> NEW."actor_user_id" THEN
    RAISE EXCEPTION 'Correction feedback actor is not a trusted active Assignment.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_actor_check';
  END IF;

  next_status := CASE
    WHEN NEW."action" = 'ACKNOWLEDGE' AND correction_record."status" = 'OPEN'
      THEN 'ACKNOWLEDGED'
    WHEN NEW."action" = 'ACCEPT' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'ACCEPTED'
    WHEN NEW."action" = 'REJECT' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'REJECTED'
    WHEN NEW."action" = 'EXPLAIN' AND correction_record."status" IN ('OPEN', 'ACKNOWLEDGED')
      THEN 'EXPLAINED'
    WHEN NEW."action" = 'ESCALATE' AND correction_record."status" NOT IN (
      'RESOLVED', 'CANCELLED'
    ) THEN 'ESCALATED'
    WHEN NEW."action" = 'RESOLVE' AND correction_record."status" IN (
      'ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'RESOLVED'
    WHEN NEW."action" = 'CANCEL' AND correction_record."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
    ) THEN 'CANCELLED'
    ELSE NULL
  END;
  IF next_status IS NULL THEN
    RAISE EXCEPTION 'Invalid Correction feedback transition.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_transition_check';
  END IF;

  actor_is_subject :=
    NEW."actor_role_assignment_id" = correction_record."role_assignment_id";
  actor_is_reviewer :=
    correction_record."required_role_assignment_ids"
      ? NEW."actor_role_assignment_id"::text;
  IF (
    NEW."action" IN ('ACKNOWLEDGE', 'REJECT', 'EXPLAIN', 'ESCALATE')
    AND NOT actor_is_subject
    AND NOT actor_is_reviewer
  ) OR (
    NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL')
    AND NOT actor_is_reviewer
  ) THEN
    RAISE EXCEPTION 'Correction feedback actor does not hold the required subject or review role.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_actor_role_check';
  END IF;

  high_impact :=
    correction_record."severity" IN ('HIGH', 'CRITICAL')
    OR correction_record."category" = 'CAPABILITY_RISK';
  requires_evidence :=
    NEW."action" IN ('REJECT', 'EXPLAIN', 'ESCALATE', 'RESOLVE')
    OR (
      high_impact
      AND NEW."action" IN ('ACCEPT', 'CANCEL')
    );
  IF requires_evidence AND jsonb_array_length(NEW."evidence_ids") = 0 THEN
    RAISE EXCEPTION 'This Correction feedback action requires trusted evidence.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_required';
  END IF;
  IF high_impact AND NEW."action" IN ('ACCEPT', 'RESOLVE', 'CANCEL') THEN
    IF actor_user = subject_user_id
       OR NOT correction_record."required_role_assignment_ids" ? NEW."actor_role_assignment_id"::text
       OR NOT actor_is_reviewer THEN
      RAISE EXCEPTION 'A high-impact terminal correction decision requires an independent reviewer and evidence.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_independent_review_check';
    END IF;
  END IF;
  IF jsonb_array_length(NEW."evidence_ids") > 0 THEN
    SELECT count(DISTINCT value)
      INTO evidence_id_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value);
    IF evidence_id_count <> jsonb_array_length(NEW."evidence_ids") THEN
      RAISE EXCEPTION 'Correction feedback Evidence IDs must be unique.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_unique';
    END IF;
    SELECT count(DISTINCT evidence."id"::text)
      INTO evidence_valid_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") item(value)
    JOIN public."evidence" evidence
      ON evidence."tenant_id" = NEW."tenant_id"
     AND evidence."id" = item.value::uuid
     AND evidence."status" = 'ACTIVE'
     AND evidence."verified_at" IS NOT NULL
     AND evidence."effective_from" <= CURRENT_TIMESTAMP
     AND (evidence."effective_to" IS NULL OR evidence."effective_to" > CURRENT_TIMESTAMP)
    WHERE EXISTS (
      SELECT 1
      FROM public."correction_case_evidence" case_evidence
      WHERE case_evidence."tenant_id" = NEW."tenant_id"
        AND case_evidence."correction_case_id" = NEW."correction_case_id"
        AND case_evidence."evidence_id" = evidence."id"
        AND case_evidence."evidence_version" = evidence."version"
        AND case_evidence."content_hash" = evidence."content_hash"
    );
    IF evidence_valid_count <> evidence_id_count THEN
      RAISE EXCEPTION 'Correction feedback evidence must be active, sealed, and linked to the case.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_feedback_evidence_check';
    END IF;
  END IF;

  UPDATE public."correction_cases"
  SET "status" = next_status,
      "revision" = NEW."revision",
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."correction_case_id"
    AND "revision" = correction_record."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction revision conflict.'
      USING ERRCODE = '40001', CONSTRAINT = 'correction_cases_revision_cas';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "correction_feedback_insert_guard_trigger"
  AFTER INSERT ON public."correction_feedback"
  FOR EACH ROW EXECUTE FUNCTION public.guard_correction_feedback_insert();

CREATE OR REPLACE FUNCTION public.guard_correction_case_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  feedback_action public."CorrectionFeedbackAction";
  expected_status public."CorrectionStatus";
BEGIN
  IF (
    NEW."tenant_id", NEW."correlation_id", NEW."subject_type", NEW."subject_id",
    NEW."subject_version", NEW."role_assignment_id", NEW."objective_id",
    NEW."objective_version", NEW."task_id", NEW."task_version",
    NEW."process_instance_id", NEW."trigger", NEW."category", NEW."severity",
    NEW."confidence", NEW."rule_findings", NEW."model_finding",
    NEW."evidence_refs", NEW."impact", NEW."suggested_actions",
    NEW."required_role_assignment_ids", NEW."permission_labels",
    NEW."idempotency_key", NEW."request_hash", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."correlation_id", OLD."subject_type", OLD."subject_id",
    OLD."subject_version", OLD."role_assignment_id", OLD."objective_id",
    OLD."objective_version", OLD."task_id", OLD."task_version",
    OLD."process_instance_id", OLD."trigger", OLD."category", OLD."severity",
    OLD."confidence", OLD."rule_findings", OLD."model_finding",
    OLD."evidence_refs", OLD."impact", OLD."suggested_actions",
    OLD."required_role_assignment_ids", OLD."permission_labels",
    OLD."idempotency_key", OLD."request_hash", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Correction case evidence and subject snapshot are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_identity_immutable';
  END IF;
  SELECT feedback."action"
    INTO feedback_action
  FROM public."correction_feedback" feedback
  WHERE feedback."tenant_id" = NEW."tenant_id"
    AND feedback."correction_case_id" = NEW."id"
    AND feedback."revision" = NEW."revision";
  expected_status := CASE
    WHEN feedback_action = 'ACKNOWLEDGE' AND OLD."status" = 'OPEN'
      THEN 'ACKNOWLEDGED'
    WHEN feedback_action = 'ACCEPT' AND OLD."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'ACCEPTED'
    WHEN feedback_action = 'REJECT' AND OLD."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'REJECTED'
    WHEN feedback_action = 'EXPLAIN' AND OLD."status" IN ('OPEN', 'ACKNOWLEDGED')
      THEN 'EXPLAINED'
    WHEN feedback_action = 'ESCALATE' AND OLD."status" NOT IN (
      'RESOLVED', 'CANCELLED'
    ) THEN 'ESCALATED'
    WHEN feedback_action = 'RESOLVE' AND OLD."status" IN (
      'ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED'
    ) THEN 'RESOLVED'
    WHEN feedback_action = 'CANCEL' AND OLD."status" IN (
      'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
    ) THEN 'CANCELLED'
    ELSE NULL
  END;
  IF NEW."revision" <> OLD."revision" + 1
     OR feedback_action IS NULL
     OR expected_status IS NULL
     OR NEW."status" <> expected_status THEN
    RAISE EXCEPTION 'Correction state must be advanced by immutable feedback.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_feedback_coverage';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "correction_cases_update_guard_trigger"
  BEFORE UPDATE ON public."correction_cases"
  FOR EACH ROW EXECUTE FUNCTION public.guard_correction_case_update();
CREATE TRIGGER "correction_cases_no_delete_trigger"
  BEFORE DELETE ON public."correction_cases"
  FOR EACH ROW EXECUTE FUNCTION public.guard_business_ledger_append_only();

CREATE OR REPLACE FUNCTION public.validate_correction_trace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_record public."correction_cases"%ROWTYPE;
  feedback_record record;
  feedback_count integer;
  expected_revision integer := 2;
  replay_status text := 'OPEN';
  previous_occurred_at timestamptz;
BEGIN
  SELECT *
    INTO current_record
  FROM public."correction_cases"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."id";
  IF current_record."id" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*)
    INTO feedback_count
  FROM public."correction_feedback" feedback
  WHERE feedback."tenant_id" = current_record."tenant_id"
    AND feedback."correction_case_id" = current_record."id";
  IF feedback_count <> current_record."revision" - 1 THEN
    RAISE EXCEPTION 'Correction feedback trace is incomplete.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_complete_trace_check';
  END IF;
  FOR feedback_record IN
    SELECT *
    FROM public."correction_feedback" feedback
    WHERE feedback."tenant_id" = current_record."tenant_id"
      AND feedback."correction_case_id" = current_record."id"
    ORDER BY feedback."revision"
  LOOP
    IF feedback_record."revision" <> expected_revision
       OR (
         previous_occurred_at IS NOT NULL
         AND feedback_record."occurred_at" < previous_occurred_at
       )
       OR feedback_record."occurred_at" < current_record."created_at" THEN
      RAISE EXCEPTION 'Correction feedback trace cannot be replayed.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_trace_replay_check';
    END IF;
    replay_status := CASE
      WHEN feedback_record."action" = 'ACKNOWLEDGE' AND replay_status = 'OPEN'
        THEN 'ACKNOWLEDGED'
      WHEN feedback_record."action" = 'ACCEPT' AND replay_status IN (
        'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
      ) THEN 'ACCEPTED'
      WHEN feedback_record."action" = 'REJECT' AND replay_status IN (
        'OPEN', 'ACKNOWLEDGED', 'EXPLAINED', 'ESCALATED'
      ) THEN 'REJECTED'
      WHEN feedback_record."action" = 'EXPLAIN'
        AND replay_status IN ('OPEN', 'ACKNOWLEDGED')
        THEN 'EXPLAINED'
      WHEN feedback_record."action" = 'ESCALATE'
        AND replay_status NOT IN ('RESOLVED', 'CANCELLED')
        THEN 'ESCALATED'
      WHEN feedback_record."action" = 'RESOLVE' AND replay_status IN (
        'ACKNOWLEDGED', 'ACCEPTED', 'EXPLAINED', 'ESCALATED'
      ) THEN 'RESOLVED'
      WHEN feedback_record."action" = 'CANCEL' AND replay_status IN (
        'OPEN', 'ACKNOWLEDGED', 'REJECTED', 'ESCALATED'
      ) THEN 'CANCELLED'
      ELSE NULL
    END;
    IF replay_status IS NULL THEN
      RAISE EXCEPTION 'Correction feedback sequence contains an illegal transition.'
        USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_trace_status_check';
    END IF;
    previous_occurred_at := feedback_record."occurred_at";
    expected_revision := expected_revision + 1;
  END LOOP;
  IF expected_revision <> current_record."revision" + 1
     OR replay_status <> current_record."status"::text THEN
    RAISE EXCEPTION 'Correction aggregate does not match its immutable feedback trace.'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_cases_trace_state_check';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "correction_cases_trace_completeness_trigger"
  AFTER INSERT OR UPDATE ON public."correction_cases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_correction_trace();

CREATE OR REPLACE FUNCTION public.validate_business_ledger_join_completeness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  json_count integer;
  join_count integer;
  mismatch_count integer;
  duplicate_count integer;
BEGIN
  IF TG_TABLE_NAME = 'business_events' THEN
    json_count := jsonb_array_length(NEW."evidence_refs");
    SELECT count(*) - count(
      DISTINCT (
        reference->>'evidenceId',
        reference->>'version'
      )
    )
      INTO duplicate_count
    FROM jsonb_array_elements(NEW."evidence_refs") reference;
    SELECT count(*) INTO join_count
    FROM public."business_event_evidence"
    WHERE "tenant_id" = NEW."tenant_id" AND "business_event_id" = NEW."id";
    SELECT count(*) INTO mismatch_count
    FROM jsonb_array_elements(NEW."evidence_refs") reference
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."business_event_evidence" event_evidence
      WHERE event_evidence."tenant_id" = NEW."tenant_id"
        AND event_evidence."business_event_id" = NEW."id"
        AND event_evidence."evidence_id" = (reference->>'evidenceId')::uuid
        AND event_evidence."evidence_version" = (reference->>'version')::integer
        AND event_evidence."content_hash" = reference->>'contentHash'
    );
  ELSIF TG_TABLE_NAME = 'correction_cases' THEN
    json_count := jsonb_array_length(NEW."evidence_refs");
    SELECT count(*) - count(
      DISTINCT (
        reference->>'evidenceId',
        reference->>'version'
      )
    )
      INTO duplicate_count
    FROM jsonb_array_elements(NEW."evidence_refs") reference;
    SELECT count(*) INTO join_count
    FROM public."correction_case_evidence"
    WHERE "tenant_id" = NEW."tenant_id" AND "correction_case_id" = NEW."id";
    SELECT count(*) INTO mismatch_count
    FROM jsonb_array_elements(NEW."evidence_refs") reference
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."correction_case_evidence" case_evidence
      WHERE case_evidence."tenant_id" = NEW."tenant_id"
        AND case_evidence."correction_case_id" = NEW."id"
        AND case_evidence."evidence_id" = (reference->>'evidenceId')::uuid
        AND case_evidence."evidence_version" = (reference->>'version')::integer
        AND case_evidence."content_hash" = reference->>'contentHash'
    );
  ELSE
    json_count := jsonb_array_length(NEW."evidence_ids");
    SELECT count(*) - count(DISTINCT reference.value)
      INTO duplicate_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") reference(value);
    SELECT count(*) INTO join_count
    FROM public."correction_feedback_evidence"
    WHERE "tenant_id" = NEW."tenant_id" AND "correction_feedback_id" = NEW."id";
    SELECT count(*) INTO mismatch_count
    FROM jsonb_array_elements_text(NEW."evidence_ids") reference(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public."correction_feedback_evidence" feedback_evidence
      WHERE feedback_evidence."tenant_id" = NEW."tenant_id"
        AND feedback_evidence."correction_feedback_id" = NEW."id"
        AND feedback_evidence."evidence_id" = reference.value::uuid
    );
  END IF;
  IF duplicate_count <> 0
     OR json_count <> join_count
     OR mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Evidence JSON and normalized evidence ledger must be complete.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_evidence_join_complete';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "business_events_evidence_completeness_trigger"
  AFTER INSERT ON public."business_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_ledger_join_completeness();
CREATE CONSTRAINT TRIGGER "correction_cases_evidence_completeness_trigger"
  AFTER INSERT ON public."correction_cases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_ledger_join_completeness();
CREATE CONSTRAINT TRIGGER "correction_feedback_evidence_completeness_trigger"
  AFTER INSERT ON public."correction_feedback"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_ledger_join_completeness();

-- Least-privilege capability ACL and RLS.
REVOKE ALL ON FUNCTION public.build_trusted_assignment_snapshot(
  uuid, uuid, jsonb, timestamptz, uuid, text
) FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin,
  enterprise_agent_auth, enterprise_agent_provisioner;
GRANT EXECUTE ON FUNCTION public.build_trusted_assignment_snapshot(
  uuid, uuid, jsonb, timestamptz, uuid, text
) TO enterprise_agent_process;

REVOKE ALL PRIVILEGES ON TABLE
  public."business_events",
  public."business_event_evidence",
  public."business_event_deliveries",
  public."business_event_effects",
  public."collaborations",
  public."collaboration_participants",
  public."collaboration_messages",
  public."collaboration_message_recipients",
  public."collaboration_message_evidence",
  public."correction_cases",
  public."correction_case_evidence",
  public."correction_feedback",
  public."correction_feedback_evidence"
  FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin, enterprise_agent_process;

GRANT SELECT ON TABLE
  public."business_events",
  public."business_event_evidence",
  public."business_event_deliveries",
  public."business_event_effects",
  public."collaborations",
  public."collaboration_participants",
  public."collaboration_messages",
  public."collaboration_message_recipients",
  public."collaboration_message_evidence",
  public."correction_cases",
  public."correction_case_evidence",
  public."correction_feedback",
  public."correction_feedback_evidence"
  TO enterprise_agent_app, enterprise_agent_admin, enterprise_agent_process;

GRANT INSERT ON TABLE
  public."business_events",
  public."business_event_evidence",
  public."business_event_deliveries",
  public."business_event_effects",
  public."collaborations",
  public."collaboration_participants",
  public."collaboration_messages",
  public."collaboration_message_recipients",
  public."collaboration_message_evidence",
  public."correction_cases",
  public."correction_case_evidence",
  public."correction_feedback",
  public."correction_feedback_evidence"
  TO enterprise_agent_process;
GRANT UPDATE ON TABLE
  public."business_event_deliveries",
  public."business_event_effects",
  public."collaborations",
  public."correction_cases"
  TO enterprise_agent_process;
GRANT SELECT ("role") ON TABLE public."users" TO enterprise_agent_process;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_events',
    'business_event_evidence',
    'business_event_deliveries',
    'business_event_effects',
    'collaborations',
    'collaboration_participants',
    'collaboration_messages',
    'collaboration_message_recipients',
    'collaboration_message_evidence',
    'correction_cases',
    'correction_case_evidence',
    'correction_feedback',
    'correction_feedback_evidence'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      || 'AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_access ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_admin USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_process_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_process '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$$;
COMMIT;
