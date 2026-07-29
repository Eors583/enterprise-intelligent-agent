BEGIN;

CREATE TYPE public."MemoryScope" AS ENUM (
  'ENTERPRISE', 'ROLE', 'EMPLOYEE_PRIVATE', 'TASK', 'CONVERSATION'
);
CREATE TYPE public."MemoryStatus" AS ENUM (
  'CANDIDATE', 'ACTIVE', 'ARCHIVED', 'SEALED', 'DELETED'
);
CREATE TYPE public."MemorySourceType" AS ENUM (
  'KNOWLEDGE', 'ROLE_VERSION', 'TASK', 'CONVERSATION',
  'DELIVERABLE', 'EXPERIENCE', 'USER_CONFIRMED'
);
CREATE TYPE public."MemorySensitivity" AS ENUM (
  'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
);
CREATE TYPE public."MemoryRetentionAction" AS ENUM (
  'DELETE', 'ARCHIVE', 'SUMMARIZE', 'SEAL'
);
CREATE TYPE public."MemoryTransitionAction" AS ENUM (
  'ACTIVATE', 'ARCHIVE', 'SEAL', 'DELETE'
);
CREATE TYPE public."ExperienceStatus" AS ENUM (
  'CANDIDATE', 'SANITIZED', 'STRUCTURED', 'APPROVED', 'REJECTED',
  'VALIDATED', 'PUBLISHED', 'MONITORED', 'RETIRED'
);
CREATE TYPE public."ExperienceTransitionAction" AS ENUM (
  'SANITIZE', 'STRUCTURE', 'APPROVE', 'REJECT',
  'VALIDATE', 'PUBLISH', 'MONITOR', 'RETIRE'
);

CREATE TABLE public."memory_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "scope" public."MemoryScope" NOT NULL,
  "status" public."MemoryStatus" NOT NULL DEFAULT 'CANDIDATE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "title" VARCHAR(300) NOT NULL,
  "summary" TEXT NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "source_type" public."MemorySourceType" NOT NULL,
  "source_id" UUID NOT NULL,
  "source_version" INTEGER NOT NULL,
  "source_evidence_count" INTEGER NOT NULL DEFAULT 0,
  "owner_user_id" UUID,
  "role_template_id" UUID,
  "role_version_id" UUID,
  "role_assignment_id" UUID,
  "task_id" UUID,
  "conversation_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sensitivity" public."MemorySensitivity" NOT NULL DEFAULT 'INTERNAL',
  "consent_required" BOOLEAN NOT NULL DEFAULT false,
  "consent_granted_by_user_id" UUID,
  "consent_granted_at" TIMESTAMPTZ(6),
  "consent_purpose" VARCHAR(500),
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "retention_action" public."MemoryRetentionAction" NOT NULL,
  "sealed_at" TIMESTAMPTZ(6),
  "deleted_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_records_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "memory_records_tenant_id_id_version_key"
    UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "memory_records_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "memory_records_positive_identity_check"
    CHECK (
      "version" > 0
      AND "revision" > 0
      AND "source_version" > 0
      AND "source_evidence_count" >= 0
    ),
  CONSTRAINT "memory_records_hash_check"
    CHECK (
      "content_hash" ~ '^[a-f0-9]{64}$'
      AND "request_hash" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "memory_records_text_check"
    CHECK (
      length(btrim("title")) BETWEEN 1 AND 300
      AND length(btrim("summary")) BETWEEN 1 AND 20000
      AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
    ),
  CONSTRAINT "memory_records_permission_labels_check"
    CHECK (public.semantic_permission_labels_valid("permission_labels")),
  CONSTRAINT "memory_records_effective_window_check"
    CHECK (
      ("effective_to" IS NULL OR "effective_to" > "effective_from")
      AND ("expires_at" IS NULL OR "expires_at" > "effective_from")
    ),
  CONSTRAINT "memory_records_status_timestamp_check"
    CHECK (
      ("status" <> 'SEALED' OR "sealed_at" IS NOT NULL)
      AND ("status" = 'DELETED') = ("deleted_at" IS NOT NULL)
    ),
  CONSTRAINT "memory_records_scope_identity_check"
    CHECK (
      (
        "scope" = 'ENTERPRISE'
        AND "owner_user_id" IS NULL
        AND "role_template_id" IS NULL
        AND "role_version_id" IS NULL
        AND "role_assignment_id" IS NULL
        AND "task_id" IS NULL
        AND "conversation_id" IS NULL
      )
      OR (
        "scope" = 'ROLE'
        AND "owner_user_id" IS NULL
        AND "role_template_id" IS NOT NULL
        AND "role_version_id" IS NOT NULL
        AND "role_assignment_id" IS NULL
        AND "task_id" IS NULL
        AND "conversation_id" IS NULL
      )
      OR (
        "scope" = 'EMPLOYEE_PRIVATE'
        AND "owner_user_id" IS NOT NULL
        AND "role_template_id" IS NOT NULL
        AND "role_version_id" IS NOT NULL
        AND "role_assignment_id" IS NOT NULL
        AND "task_id" IS NULL
        AND "conversation_id" IS NULL
      )
      OR (
        "scope" = 'TASK'
        AND "owner_user_id" IS NULL
        AND "role_template_id" IS NULL
        AND "role_version_id" IS NULL
        AND "role_assignment_id" IS NULL
        AND "task_id" IS NOT NULL
        AND "conversation_id" IS NULL
      )
      OR (
        "scope" = 'CONVERSATION'
        AND "owner_user_id" IS NULL
        AND "role_template_id" IS NULL
        AND "role_version_id" IS NULL
        AND "role_assignment_id" IS NULL
        AND "task_id" IS NULL
        AND "conversation_id" IS NOT NULL
        AND "expires_at" IS NOT NULL
      )
    ),
  CONSTRAINT "memory_records_consent_check"
    CHECK (
      (
        "scope" = 'EMPLOYEE_PRIVATE'
        AND "consent_required"
        AND "consent_granted_by_user_id" = "owner_user_id"
        AND "consent_granted_at" IS NOT NULL
        AND length(btrim("consent_purpose")) BETWEEN 1 AND 500
      )
      OR (
        "scope" <> 'EMPLOYEE_PRIVATE'
        AND NOT "consent_required"
        AND "consent_granted_by_user_id" IS NULL
        AND "consent_granted_at" IS NULL
        AND "consent_purpose" IS NULL
      )
    )
);

CREATE TABLE public."memory_source_evidence" (
  "tenant_id" UUID NOT NULL,
  "memory_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_source_evidence_pkey"
    PRIMARY KEY ("tenant_id", "memory_id", "evidence_id", "evidence_version")
);

CREATE TABLE public."memory_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "memory_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "action" public."MemoryTransitionAction" NOT NULL,
  "target_status" public."MemoryStatus" NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "memory_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "memory_commands_tenant_memory_revision_key"
    UNIQUE ("tenant_id", "memory_id", "revision"),
  CONSTRAINT "memory_commands_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "memory_commands_revision_check"
    CHECK (
      "expected_revision" > 0
      AND "revision" = "expected_revision" + 1
    ),
  CONSTRAINT "memory_commands_text_hash_check"
    CHECK (
      length(btrim("reason")) BETWEEN 1 AND 500
      AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
      AND "request_hash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE TABLE public."experience_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "status" public."ExperienceStatus" NOT NULL DEFAULT 'CANDIDATE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "title" VARCHAR(300) NOT NULL,
  "contributor_user_id" UUID NOT NULL,
  "contributor_role_assignment_id" UUID NOT NULL,
  "source_task_id" UUID NOT NULL,
  "source_deliverable_count" INTEGER NOT NULL DEFAULT 0,
  "source_evidence_count" INTEGER NOT NULL,
  "raw_input_hash" CHAR(64) NOT NULL,
  "candidate_summary" TEXT NOT NULL,
  "sanitization" JSONB,
  "structured_content" JSONB,
  "structured_hash" CHAR(64),
  "review" JSONB,
  "validation" JSONB,
  "publication" JSONB,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sensitivity" public."MemorySensitivity" NOT NULL DEFAULT 'INTERNAL',
  "monitored_use_count" INTEGER NOT NULL DEFAULT 0,
  "monitored_adoption_count" INTEGER NOT NULL DEFAULT 0,
  "monitored_complaint_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "experience_candidates_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "experience_candidates_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "experience_candidates_counts_check"
    CHECK (
      "revision" > 0
      AND "source_deliverable_count" >= 0
      AND "source_evidence_count" > 0
      AND "monitored_use_count" >= 0
      AND "monitored_adoption_count" BETWEEN 0 AND "monitored_use_count"
      AND "monitored_complaint_count" BETWEEN 0 AND "monitored_use_count"
    ),
  CONSTRAINT "experience_candidates_hash_check"
    CHECK (
      "raw_input_hash" ~ '^[a-f0-9]{64}$'
      AND "request_hash" ~ '^[a-f0-9]{64}$'
      AND ("structured_hash" IS NULL OR "structured_hash" ~ '^[a-f0-9]{64}$')
    ),
  CONSTRAINT "experience_candidates_text_check"
    CHECK (
      length(btrim("title")) BETWEEN 1 AND 300
      AND length(btrim("candidate_summary")) BETWEEN 1 AND 20000
      AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
    ),
  CONSTRAINT "experience_candidates_permission_labels_check"
    CHECK (public.semantic_permission_labels_valid("permission_labels")),
  CONSTRAINT "experience_candidates_json_check"
    CHECK (
      ("sanitization" IS NULL OR jsonb_typeof("sanitization") = 'object')
      AND ("structured_content" IS NULL OR jsonb_typeof("structured_content") = 'object')
      AND ("review" IS NULL OR jsonb_typeof("review") = 'object')
      AND ("validation" IS NULL OR jsonb_typeof("validation") = 'object')
      AND ("publication" IS NULL OR jsonb_typeof("publication") = 'object')
    ),
  CONSTRAINT "experience_candidates_status_timestamp_check"
    CHECK (("status" = 'RETIRED') = ("retired_at" IS NOT NULL))
);

CREATE TABLE public."experience_source_deliverables" (
  "tenant_id" UUID NOT NULL,
  "experience_id" UUID NOT NULL,
  "deliverable_id" UUID NOT NULL,
  "deliverable_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_source_deliverables_pkey"
    PRIMARY KEY (
      "tenant_id", "experience_id", "deliverable_id", "deliverable_version"
    )
);

CREATE TABLE public."experience_source_evidence" (
  "tenant_id" UUID NOT NULL,
  "experience_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_source_evidence_pkey"
    PRIMARY KEY (
      "tenant_id", "experience_id", "evidence_id", "evidence_version"
    )
);

CREATE TABLE public."experience_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "experience_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "action" public."ExperienceTransitionAction" NOT NULL,
  "target_status" public."ExperienceStatus" NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "actor_role_assignment_id" UUID NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "payload" JSONB NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "experience_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "experience_commands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "experience_commands_tenant_experience_revision_key"
    UNIQUE ("tenant_id", "experience_id", "revision"),
  CONSTRAINT "experience_commands_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "experience_commands_revision_check"
    CHECK (
      "expected_revision" > 0
      AND "revision" = "expected_revision" + 1
    ),
  CONSTRAINT "experience_commands_payload_check"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "experience_commands_text_hash_check"
    CHECK (
      length(btrim("reason")) BETWEEN 1 AND 500
      AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
      AND "request_hash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE TABLE public."experience_review_evidence" (
  "tenant_id" UUID NOT NULL,
  "experience_id" UUID NOT NULL,
  "command_revision" INTEGER NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_review_evidence_pkey"
    PRIMARY KEY (
      "tenant_id", "experience_id", "command_revision",
      "evidence_id", "evidence_version"
    )
);

CREATE TABLE public."experience_validations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "experience_id" UUID NOT NULL,
  "command_revision" INTEGER NOT NULL,
  "validation_run_id" UUID NOT NULL,
  "dataset_version_id" UUID NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "score" DECIMAL(12,10) NOT NULL,
  "threshold" DECIMAL(12,10) NOT NULL,
  "side_effects" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "validated_by_user_id" UUID NOT NULL,
  "validated_by_role_assignment_id" UUID NOT NULL,
  "validated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "experience_validations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "experience_validations_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "experience_validations_candidate_revision_key"
    UNIQUE ("tenant_id", "experience_id", "command_revision"),
  CONSTRAINT "experience_validations_result_check"
    CHECK (
      "passed"
      AND "score" BETWEEN 0 AND 1
      AND "threshold" BETWEEN 0 AND 1
      AND "score" >= "threshold"
      AND jsonb_typeof("side_effects") = 'array'
    )
);

CREATE TABLE public."experience_publications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "experience_id" UUID NOT NULL,
  "command_revision" INTEGER NOT NULL,
  "knowledge_base_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_version_id" UUID NOT NULL,
  "document_version" INTEGER NOT NULL,
  "publication_hash" CHAR(64) NOT NULL,
  "published_by_user_id" UUID NOT NULL,
  "published_by_role_assignment_id" UUID NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "experience_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "experience_publications_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "experience_publications_candidate_revision_key"
    UNIQUE ("tenant_id", "experience_id", "command_revision"),
  CONSTRAINT "experience_publications_hash_version_check"
    CHECK (
      "document_version" > 0
      AND "publication_hash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE TABLE public."experience_publication_role_targets" (
  "tenant_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "role_template_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_publication_role_targets_pkey"
    PRIMARY KEY ("tenant_id", "publication_id", "role_template_id")
);

CREATE TABLE public."experience_publication_org_targets" (
  "tenant_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "org_unit_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experience_publication_org_targets_pkey"
    PRIMARY KEY ("tenant_id", "publication_id", "org_unit_id")
);

ALTER TABLE public."memory_records"
  ADD CONSTRAINT "memory_records_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_owner_user_fkey"
    FOREIGN KEY ("tenant_id", "owner_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_creator_user_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_role_template_fkey"
    FOREIGN KEY ("tenant_id", "role_template_id")
    REFERENCES public."agent_templates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_role_version_fkey"
    FOREIGN KEY ("tenant_id", "role_template_id", "role_version_id")
    REFERENCES public."agent_versions" ("tenant_id", "template_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_role_assignment_fkey"
    FOREIGN KEY ("tenant_id", "role_assignment_id")
    REFERENCES public."role_assignments" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id")
    REFERENCES public."tasks" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_records_conversation_fkey"
    FOREIGN KEY ("tenant_id", "conversation_id")
    REFERENCES public."conversations" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."memory_source_evidence"
  ADD CONSTRAINT "memory_source_evidence_memory_fkey"
    FOREIGN KEY ("tenant_id", "memory_id")
    REFERENCES public."memory_records" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_source_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence" ("tenant_id", "id", "version") ON DELETE RESTRICT;

ALTER TABLE public."memory_commands"
  ADD CONSTRAINT "memory_commands_memory_fkey"
    FOREIGN KEY ("tenant_id", "memory_id")
    REFERENCES public."memory_records" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "memory_commands_actor_user_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."experience_candidates"
  ADD CONSTRAINT "experience_candidates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenants" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_candidates_contributor_user_fkey"
    FOREIGN KEY ("tenant_id", "contributor_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_candidates_contributor_assignment_fkey"
    FOREIGN KEY ("tenant_id", "contributor_role_assignment_id")
    REFERENCES public."role_assignments" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_candidates_source_task_fkey"
    FOREIGN KEY ("tenant_id", "source_task_id")
    REFERENCES public."tasks" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."experience_source_deliverables"
  ADD CONSTRAINT "experience_source_deliverables_candidate_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_source_deliverables_deliverable_fkey"
    FOREIGN KEY ("tenant_id", "deliverable_id", "deliverable_version")
    REFERENCES public."deliverables" ("tenant_id", "id", "version") ON DELETE RESTRICT;

ALTER TABLE public."experience_source_evidence"
  ADD CONSTRAINT "experience_source_evidence_candidate_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_source_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence" ("tenant_id", "id", "version") ON DELETE RESTRICT;

ALTER TABLE public."experience_commands"
  ADD CONSTRAINT "experience_commands_candidate_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_commands_actor_user_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_commands_actor_assignment_fkey"
    FOREIGN KEY ("tenant_id", "actor_role_assignment_id")
    REFERENCES public."role_assignments" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."experience_review_evidence"
  ADD CONSTRAINT "experience_review_evidence_candidate_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_review_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence" ("tenant_id", "id", "version") ON DELETE RESTRICT;

ALTER TABLE public."experience_validations"
  ADD CONSTRAINT "experience_validations_candidate_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_validations_run_fkey"
    FOREIGN KEY ("tenant_id", "validation_run_id")
    REFERENCES public."agent_runs" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_validations_dataset_version_fkey"
    FOREIGN KEY ("tenant_id", "dataset_version_id")
    REFERENCES public."knowledge_document_versions" ("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_validations_validator_user_fkey"
    FOREIGN KEY ("tenant_id", "validated_by_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_validations_validator_assignment_fkey"
    FOREIGN KEY ("tenant_id", "validated_by_role_assignment_id")
    REFERENCES public."role_assignments" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."experience_publications"
  ADD CONSTRAINT "experience_publications_candidate_fkey"
    FOREIGN KEY ("tenant_id", "experience_id")
    REFERENCES public."experience_candidates" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publications_knowledge_base_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id")
    REFERENCES public."knowledge_bases" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publications_document_fkey"
    FOREIGN KEY ("tenant_id", "knowledge_base_id", "document_id")
    REFERENCES public."knowledge_documents" (
      "tenant_id", "knowledge_base_id", "id"
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publications_document_version_fkey"
    FOREIGN KEY (
      "tenant_id", "knowledge_base_id", "document_id", "document_version_id"
    )
    REFERENCES public."knowledge_document_versions" (
      "tenant_id", "knowledge_base_id", "document_id", "id"
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publications_publisher_user_fkey"
    FOREIGN KEY ("tenant_id", "published_by_user_id")
    REFERENCES public."users" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publications_publisher_assignment_fkey"
    FOREIGN KEY ("tenant_id", "published_by_role_assignment_id")
    REFERENCES public."role_assignments" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."experience_publication_role_targets"
  ADD CONSTRAINT "experience_publication_role_targets_publication_fkey"
    FOREIGN KEY ("tenant_id", "publication_id")
    REFERENCES public."experience_publications" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publication_role_targets_role_fkey"
    FOREIGN KEY ("tenant_id", "role_template_id")
    REFERENCES public."agent_templates" ("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE public."experience_publication_org_targets"
  ADD CONSTRAINT "experience_publication_org_targets_publication_fkey"
    FOREIGN KEY ("tenant_id", "publication_id")
    REFERENCES public."experience_publications" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "experience_publication_org_targets_org_unit_fkey"
    FOREIGN KEY ("tenant_id", "org_unit_id")
    REFERENCES public."org_units" ("tenant_id", "id") ON DELETE RESTRICT;

CREATE INDEX "memory_records_scope_lookup_idx"
  ON public."memory_records" (
    "tenant_id", "scope", "status", "effective_from", "expires_at", "id" DESC
  );
CREATE INDEX "memory_records_owner_lookup_idx"
  ON public."memory_records" (
    "tenant_id", "owner_user_id", "status", "id" DESC
  );
CREATE INDEX "memory_records_role_lookup_idx"
  ON public."memory_records" (
    "tenant_id", "role_template_id", "role_version_id", "status", "id" DESC
  );
CREATE INDEX "memory_records_task_lookup_idx"
  ON public."memory_records" ("tenant_id", "task_id", "status", "id" DESC);
CREATE INDEX "memory_records_conversation_lookup_idx"
  ON public."memory_records" ("tenant_id", "conversation_id", "status", "id" DESC);
CREATE INDEX "memory_commands_trace_idx"
  ON public."memory_commands" ("tenant_id", "memory_id", "revision");
CREATE INDEX "experience_candidates_status_lookup_idx"
  ON public."experience_candidates" ("tenant_id", "status", "id" DESC);
CREATE INDEX "experience_candidates_task_lookup_idx"
  ON public."experience_candidates" ("tenant_id", "source_task_id", "id" DESC);
CREATE INDEX "experience_commands_trace_idx"
  ON public."experience_commands" ("tenant_id", "experience_id", "revision");

CREATE OR REPLACE FUNCTION public.memory_labels_covered(
  available_labels jsonb,
  required_labels jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    public.semantic_permission_labels_valid(available_labels)
    AND public.semantic_permission_labels_valid(required_labels)
    AND (
      available_labels ? '*'
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(required_labels) required(label)
        WHERE NOT available_labels ? required.label
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.memory_assignment_active(
  input_tenant_id uuid,
  input_assignment_id uuid,
  input_user_id uuid,
  input_role_template_id uuid,
  input_role_version_id uuid,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
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
     AND version."template_id" = assignment."role_template_id"
     AND version."id" = assignment."role_version_id"
    JOIN public."users" account
      ON account."tenant_id" = assignment."tenant_id"
     AND account."id" = assignment."user_id"
    WHERE assignment."tenant_id" = input_tenant_id
      AND assignment."id" = input_assignment_id
      AND assignment."user_id" = input_user_id
      AND assignment."role_template_id" = input_role_template_id
      AND assignment."role_version_id" = input_role_version_id
      AND assignment."status" = 'ACTIVE'
      AND employment."status" = 'ACTIVE'
      AND unit."status" = 'ACTIVE'
      AND account."status" = 'ACTIVE'
      AND version."status" IN ('PUBLISHED', 'RETIRED')
      AND assignment."effective_from" <= at_time
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > at_time
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.memory_record_accessible(
  memory public."memory_records",
  input_user_id uuid,
  input_purpose text,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account_role text;
  normalized_purpose text :=
    lower(regexp_replace(btrim(COALESCE(input_purpose, '')), '\s+', ' ', 'g'));
BEGIN
  IF input_user_id IS NULL
     OR memory."effective_from" > at_time
     OR (memory."effective_to" IS NOT NULL AND memory."effective_to" <= at_time)
     OR (memory."expires_at" IS NOT NULL AND memory."expires_at" <= at_time)
     OR memory."status" = 'DELETED' THEN
    RETURN false;
  END IF;

  SELECT account."role"::text
    INTO account_role
  FROM public."users" account
  WHERE account."tenant_id" = memory."tenant_id"
    AND account."id" = input_user_id
    AND account."status" = 'ACTIVE';
  IF account_role IS NULL THEN
    RETURN false;
  END IF;

  IF account_role IN ('OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN')
     AND memory."scope" <> 'EMPLOYEE_PRIVATE' THEN
    RETURN true;
  END IF;

  CASE memory."scope"
    WHEN 'ENTERPRISE' THEN
      RETURN
        jsonb_array_length(memory."permission_labels") = 0
        AND EXISTS (
          SELECT 1
          FROM public."employments" employment
          JOIN public."org_units" unit
            ON unit."tenant_id" = employment."tenant_id"
           AND unit."id" = employment."org_unit_id"
          WHERE employment."tenant_id" = memory."tenant_id"
            AND employment."user_id" = input_user_id
            AND employment."status" = 'ACTIVE'
            AND unit."status" = 'ACTIVE'
        );
    WHEN 'ROLE' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public."role_assignments" assignment
        JOIN public."employments" employment
          ON employment."tenant_id" = assignment."tenant_id"
         AND employment."id" = assignment."employment_id"
        JOIN public."org_units" unit
          ON unit."tenant_id" = employment."tenant_id"
         AND unit."id" = employment."org_unit_id"
        JOIN public."agent_versions" version
          ON version."tenant_id" = assignment."tenant_id"
         AND version."template_id" = assignment."role_template_id"
         AND version."id" = assignment."role_version_id"
        WHERE assignment."tenant_id" = memory."tenant_id"
          AND assignment."user_id" = input_user_id
          AND assignment."role_template_id" = memory."role_template_id"
          AND assignment."role_version_id" = memory."role_version_id"
          AND assignment."status" = 'ACTIVE'
          AND employment."status" = 'ACTIVE'
          AND unit."status" = 'ACTIVE'
          AND version."status" IN ('PUBLISHED', 'RETIRED')
          AND assignment."effective_from" <= at_time
          AND (
            assignment."effective_to" IS NULL
            OR assignment."effective_to" > at_time
          )
          AND public.memory_labels_covered(
            COALESCE(
              assignment."memory_policy" -> 'permissionLabels',
              assignment."memory_policy" -> 'labels',
              '[]'::jsonb
            ),
            memory."permission_labels"
          )
      );
    WHEN 'EMPLOYEE_PRIVATE' THEN
      RETURN
        memory."owner_user_id" = input_user_id
        AND memory."consent_required"
        AND memory."consent_granted_by_user_id" = input_user_id
        AND (
          normalized_purpose = '__memory_manage__'
          OR lower(
            regexp_replace(btrim(memory."consent_purpose"), '\s+', ' ', 'g')
          ) = normalized_purpose
        )
        AND public.memory_assignment_active(
          memory."tenant_id",
          memory."role_assignment_id",
          input_user_id,
          memory."role_template_id",
          memory."role_version_id",
          at_time
        )
        AND EXISTS (
          SELECT 1
          FROM public."role_assignments" assignment
          WHERE assignment."tenant_id" = memory."tenant_id"
            AND assignment."id" = memory."role_assignment_id"
            AND public.memory_labels_covered(
              COALESCE(
                assignment."memory_policy" -> 'permissionLabels',
                assignment."memory_policy" -> 'labels',
                '[]'::jsonb
              ),
              memory."permission_labels"
            )
        );
    WHEN 'TASK' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public."tasks" task
        WHERE task."tenant_id" = memory."tenant_id"
          AND task."id" = memory."task_id"
          AND task."status" <> 'CANCELLED'
          AND task."effective_from" <= at_time
          AND (task."effective_to" IS NULL OR task."effective_to" > at_time)
          AND public.memory_labels_covered(
            task."permission_labels",
            memory."permission_labels"
          )
          AND (
            task."owner_user_id" = input_user_id
            OR EXISTS (
              SELECT 1
              FROM public."role_assignments" assignment
              WHERE assignment."tenant_id" = task."tenant_id"
                AND assignment."id" = task."owner_role_assignment_id"
                AND assignment."user_id" = input_user_id
                AND assignment."status" = 'ACTIVE'
                AND assignment."effective_from" <= at_time
                AND (
                  assignment."effective_to" IS NULL
                  OR assignment."effective_to" > at_time
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public."objective_role_assignments" objective_assignment
              JOIN public."role_assignments" assignment
                ON assignment."tenant_id" = objective_assignment."tenant_id"
               AND assignment."id" = objective_assignment."role_assignment_id"
              WHERE objective_assignment."tenant_id" = task."tenant_id"
                AND objective_assignment."objective_id" = task."objective_id"
                AND objective_assignment."objective_version" = task."objective_version"
                AND assignment."user_id" = input_user_id
                AND assignment."status" = 'ACTIVE'
                AND assignment."effective_from" <= at_time
                AND (
                  assignment."effective_to" IS NULL
                  OR assignment."effective_to" > at_time
                )
            )
          )
      );
    WHEN 'CONVERSATION' THEN
      RETURN
        jsonb_array_length(memory."permission_labels") = 0
        AND EXISTS (
          SELECT 1
          FROM public."conversation_participants" participant
          WHERE participant."tenant_id" = memory."tenant_id"
            AND participant."conversation_id" = memory."conversation_id"
            AND participant."user_id" = input_user_id
            AND participant."left_at" IS NULL
        );
  END CASE;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.memory_record_creatable(
  memory public."memory_records",
  input_user_id uuid,
  input_purpose text,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account_role text;
BEGIN
  IF memory."created_by_user_id" <> input_user_id
     OR memory."status" <> 'CANDIDATE'
     OR memory."revision" <> 1
     OR memory."version" <> 1 THEN
    RETURN false;
  END IF;
  IF memory."scope" = 'ENTERPRISE' THEN
    SELECT account."role"::text
      INTO account_role
    FROM public."users" account
    WHERE account."tenant_id" = memory."tenant_id"
      AND account."id" = input_user_id
      AND account."status" = 'ACTIVE';
    IF account_role NOT IN ('OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN') THEN
      RETURN false;
    END IF;
  END IF;
  RETURN public.memory_record_accessible(
    memory, input_user_id, input_purpose, at_time
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_memory_record_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."scope" = 'EMPLOYEE_PRIVATE'
     AND NOT public.memory_assignment_active(
       NEW."tenant_id",
       NEW."role_assignment_id",
       NEW."owner_user_id",
       NEW."role_template_id",
       NEW."role_version_id",
       NEW."effective_from"
     ) THEN
    RAISE EXCEPTION 'Employee-private memory requires an active exact Role Assignment.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_private_assignment_check';
  END IF;
  IF NEW."scope" = 'ROLE'
     AND NOT EXISTS (
       SELECT 1
       FROM public."agent_versions" version
       WHERE version."tenant_id" = NEW."tenant_id"
         AND version."template_id" = NEW."role_template_id"
         AND version."id" = NEW."role_version_id"
         AND version."status" IN ('PUBLISHED', 'RETIRED')
     ) THEN
    RAISE EXCEPTION 'Role memory requires a published or retired immutable Role Version.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_role_version_status_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "memory_records_insert_guard_trigger"
  BEFORE INSERT ON public."memory_records"
  FOR EACH ROW EXECUTE FUNCTION public.guard_memory_record_insert();

CREATE OR REPLACE FUNCTION public.guard_memory_record_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  command_record public."memory_commands"%ROWTYPE;
BEGIN
  IF (
    NEW."tenant_id", NEW."scope", NEW."version", NEW."title", NEW."summary",
    NEW."content_hash", NEW."source_type", NEW."source_id", NEW."source_version",
    NEW."source_evidence_count", NEW."owner_user_id", NEW."role_template_id",
    NEW."role_version_id", NEW."role_assignment_id", NEW."task_id",
    NEW."conversation_id", NEW."permission_labels", NEW."sensitivity",
    NEW."consent_required", NEW."consent_granted_by_user_id",
    NEW."consent_granted_at", NEW."consent_purpose", NEW."effective_from",
    NEW."effective_to", NEW."expires_at", NEW."retention_action",
    NEW."created_by_user_id", NEW."idempotency_key", NEW."request_hash",
    NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."scope", OLD."version", OLD."title", OLD."summary",
    OLD."content_hash", OLD."source_type", OLD."source_id", OLD."source_version",
    OLD."source_evidence_count", OLD."owner_user_id", OLD."role_template_id",
    OLD."role_version_id", OLD."role_assignment_id", OLD."task_id",
    OLD."conversation_id", OLD."permission_labels", OLD."sensitivity",
    OLD."consent_required", OLD."consent_granted_by_user_id",
    OLD."consent_granted_at", OLD."consent_purpose", OLD."effective_from",
    OLD."effective_to", OLD."expires_at", OLD."retention_action",
    OLD."created_by_user_id", OLD."idempotency_key", OLD."request_hash",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Memory identity, consent, source, scope and content are immutable.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_immutable_snapshot';
  END IF;

  SELECT *
    INTO command_record
  FROM public."memory_commands" command
  WHERE command."tenant_id" = NEW."tenant_id"
    AND command."memory_id" = NEW."id"
    AND command."revision" = NEW."revision";
  IF NEW."revision" <> OLD."revision" + 1
     OR command_record."id" IS NULL
     OR command_record."expected_revision" <> OLD."revision"
     OR command_record."target_status" <> NEW."status"
     OR (
       command_record."action" = 'SEAL'
       AND NEW."sealed_at" IS DISTINCT FROM command_record."occurred_at"
     )
     OR (
       command_record."action" <> 'SEAL'
       AND NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
     )
     OR (
       command_record."action" = 'DELETE'
       AND NEW."deleted_at" IS DISTINCT FROM command_record."occurred_at"
     )
     OR (
       command_record."action" <> 'DELETE'
       AND NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
     ) THEN
    RAISE EXCEPTION 'Memory state must be advanced by one exact immutable command.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_command_coverage';
  END IF;
  NEW."updated_at" := command_record."occurred_at";
  RETURN NEW;
END;
$$;
CREATE TRIGGER "memory_records_update_guard_trigger"
  BEFORE UPDATE ON public."memory_records"
  FOR EACH ROW EXECUTE FUNCTION public.guard_memory_record_update();

CREATE OR REPLACE FUNCTION public.guard_memory_command_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  memory_record public."memory_records"%ROWTYPE;
  expected_status public."MemoryStatus";
  current_user_id uuid :=
    NULLIF(current_setting('app.user_id', true), '')::uuid;
  current_purpose text := current_setting('app.memory_purpose', true);
BEGIN
  SELECT *
    INTO memory_record
  FROM public."memory_records"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."memory_id"
  FOR UPDATE;
  IF memory_record."id" IS NULL THEN
    RAISE EXCEPTION 'Memory does not exist.'
      USING ERRCODE = '23503', CONSTRAINT = 'memory_commands_memory_exists';
  END IF;
  expected_status := CASE
    WHEN memory_record."status" = 'CANDIDATE' AND NEW."action" = 'ACTIVATE'
      THEN 'ACTIVE'
    WHEN memory_record."status" = 'CANDIDATE' AND NEW."action" = 'DELETE'
      THEN 'DELETED'
    WHEN memory_record."status" = 'ACTIVE' AND NEW."action" = 'ARCHIVE'
      THEN 'ARCHIVED'
    WHEN memory_record."status" = 'ACTIVE' AND NEW."action" = 'SEAL'
      THEN 'SEALED'
    WHEN memory_record."status" = 'ACTIVE' AND NEW."action" = 'DELETE'
      THEN 'DELETED'
    WHEN memory_record."status" = 'ARCHIVED' AND NEW."action" = 'ACTIVATE'
      THEN 'ACTIVE'
    WHEN memory_record."status" = 'ARCHIVED' AND NEW."action" = 'SEAL'
      THEN 'SEALED'
    WHEN memory_record."status" = 'ARCHIVED' AND NEW."action" = 'DELETE'
      THEN 'DELETED'
    WHEN memory_record."status" = 'SEALED' AND NEW."action" = 'ARCHIVE'
      THEN 'ARCHIVED'
    WHEN memory_record."status" = 'SEALED' AND NEW."action" = 'DELETE'
      THEN 'DELETED'
    ELSE NULL
  END;
  IF current_user_id IS NULL
     OR NEW."actor_user_id" <> current_user_id
     OR NEW."expected_revision" <> memory_record."revision"
     OR NEW."revision" <> memory_record."revision" + 1
     OR expected_status IS NULL
     OR NEW."target_status" <> expected_status
     OR NEW."occurred_at" < memory_record."created_at"
     OR NOT public.memory_record_accessible(
       memory_record, current_user_id, current_purpose, NEW."occurred_at"
     ) THEN
    RAISE EXCEPTION 'Memory command actor, revision, scope or transition is invalid.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_commands_transition_guard';
  END IF;

  UPDATE public."memory_records"
  SET "status" = expected_status,
      "revision" = NEW."revision",
      "sealed_at" = CASE
        WHEN NEW."action" = 'SEAL' THEN NEW."occurred_at"
        ELSE "sealed_at"
      END,
      "deleted_at" = CASE
        WHEN NEW."action" = 'DELETE' THEN NEW."occurred_at"
        ELSE "deleted_at"
      END,
      "updated_at" = NEW."occurred_at"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."memory_id";
  RETURN NEW;
END;
$$;
CREATE TRIGGER "memory_commands_insert_guard_trigger"
  AFTER INSERT ON public."memory_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_memory_command_insert();

CREATE OR REPLACE FUNCTION public.guard_memory_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Memory evidence and command ledgers are append-only.'
    USING ERRCODE = '23514', CONSTRAINT = 'memory_ledger_append_only';
END;
$$;
CREATE TRIGGER "memory_records_no_delete_trigger"
  BEFORE DELETE ON public."memory_records"
  FOR EACH ROW EXECUTE FUNCTION public.guard_memory_append_only();
CREATE TRIGGER "memory_commands_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."memory_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_memory_append_only();
CREATE TRIGGER "memory_source_evidence_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."memory_source_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_memory_append_only();

CREATE OR REPLACE FUNCTION public.validate_memory_trace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  memory_record public."memory_records"%ROWTYPE;
  command_record record;
  replay_status public."MemoryStatus" := 'CANDIDATE';
  expected_revision integer := 2;
  prior_time timestamptz;
  evidence_count integer;
BEGIN
  SELECT *
    INTO memory_record
  FROM public."memory_records"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."id";
  IF memory_record."id" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*)
    INTO evidence_count
  FROM public."memory_source_evidence" evidence
  WHERE evidence."tenant_id" = memory_record."tenant_id"
    AND evidence."memory_id" = memory_record."id";
  IF evidence_count <> memory_record."source_evidence_count" THEN
    RAISE EXCEPTION 'Memory source evidence trace is incomplete.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_source_evidence_completeness';
  END IF;
  FOR command_record IN
    SELECT *
    FROM public."memory_commands" command
    WHERE command."tenant_id" = memory_record."tenant_id"
      AND command."memory_id" = memory_record."id"
    ORDER BY command."revision"
  LOOP
    IF command_record."revision" <> expected_revision
       OR command_record."expected_revision" <> expected_revision - 1
       OR (
         prior_time IS NOT NULL
         AND command_record."occurred_at" < prior_time
       ) THEN
      RAISE EXCEPTION 'Memory command trace is not contiguous.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'memory_records_command_trace_contiguous';
    END IF;
    replay_status := CASE
      WHEN replay_status = 'CANDIDATE' AND command_record."action" = 'ACTIVATE'
        THEN 'ACTIVE'
      WHEN replay_status = 'CANDIDATE' AND command_record."action" = 'DELETE'
        THEN 'DELETED'
      WHEN replay_status = 'ACTIVE' AND command_record."action" = 'ARCHIVE'
        THEN 'ARCHIVED'
      WHEN replay_status = 'ACTIVE' AND command_record."action" = 'SEAL'
        THEN 'SEALED'
      WHEN replay_status = 'ACTIVE' AND command_record."action" = 'DELETE'
        THEN 'DELETED'
      WHEN replay_status = 'ARCHIVED' AND command_record."action" = 'ACTIVATE'
        THEN 'ACTIVE'
      WHEN replay_status = 'ARCHIVED' AND command_record."action" = 'SEAL'
        THEN 'SEALED'
      WHEN replay_status = 'ARCHIVED' AND command_record."action" = 'DELETE'
        THEN 'DELETED'
      WHEN replay_status = 'SEALED' AND command_record."action" = 'ARCHIVE'
        THEN 'ARCHIVED'
      WHEN replay_status = 'SEALED' AND command_record."action" = 'DELETE'
        THEN 'DELETED'
      ELSE NULL
    END;
    IF replay_status IS NULL
       OR replay_status <> command_record."target_status" THEN
      RAISE EXCEPTION 'Memory command trace contains an illegal transition.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'memory_records_command_trace_status';
    END IF;
    expected_revision := expected_revision + 1;
    prior_time := command_record."occurred_at";
  END LOOP;
  IF expected_revision <> memory_record."revision" + 1
     OR replay_status <> memory_record."status" THEN
    RAISE EXCEPTION 'Memory aggregate does not match its immutable command trace.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_command_trace_complete';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "memory_records_trace_trigger"
  AFTER INSERT OR UPDATE ON public."memory_records"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_memory_trace();

CREATE OR REPLACE FUNCTION public.experience_actor_has_permission(
  input_tenant_id uuid,
  input_user_id uuid,
  input_assignment_id uuid,
  required_permission text,
  at_time timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."role_assignments" assignment
    JOIN public."users" account
      ON account."tenant_id" = assignment."tenant_id"
     AND account."id" = assignment."user_id"
    JOIN public."employments" employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
     AND employment."user_id" = assignment."user_id"
    JOIN public."org_units" unit
      ON unit."tenant_id" = employment."tenant_id"
     AND unit."id" = employment."org_unit_id"
    JOIN public."agent_versions" version
      ON version."tenant_id" = assignment."tenant_id"
     AND version."template_id" = assignment."role_template_id"
     AND version."id" = assignment."role_version_id"
    WHERE assignment."tenant_id" = input_tenant_id
      AND assignment."id" = input_assignment_id
      AND assignment."user_id" = input_user_id
      AND assignment."status" = 'ACTIVE'
      AND account."status" = 'ACTIVE'
      AND employment."status" = 'ACTIVE'
      AND unit."status" = 'ACTIVE'
      AND version."status" IN ('PUBLISHED', 'RETIRED')
      AND assignment."effective_from" <= at_time
      AND (
        assignment."effective_to" IS NULL
        OR assignment."effective_to" > at_time
      )
      AND (
        account."role" IN ('OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN')
        OR COALESCE(assignment."permission_scope" -> 'permissions', '[]'::jsonb)
          ? required_permission
        OR COALESCE(assignment."permission_scope" -> 'bundles', '[]'::jsonb)
          ? required_permission
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.guard_experience_candidate_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  assignment_record public."role_assignments"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'CANDIDATE'
     OR NEW."revision" <> 1
     OR NEW."sanitization" IS NOT NULL
     OR NEW."structured_content" IS NOT NULL
     OR NEW."structured_hash" IS NOT NULL
     OR NEW."review" IS NOT NULL
     OR NEW."validation" IS NOT NULL
     OR NEW."publication" IS NOT NULL
     OR NEW."retired_at" IS NOT NULL THEN
    RAISE EXCEPTION 'Experience Candidate must begin as an empty governed candidate.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_initial_state_check';
  END IF;
  SELECT *
    INTO assignment_record
  FROM public."role_assignments" assignment
  WHERE assignment."tenant_id" = NEW."tenant_id"
    AND assignment."id" = NEW."contributor_role_assignment_id"
    AND assignment."user_id" = NEW."contributor_user_id";
  IF assignment_record."id" IS NULL
     OR NOT public.memory_assignment_active(
       NEW."tenant_id",
       assignment_record."id",
       NEW."contributor_user_id",
       assignment_record."role_template_id",
       assignment_record."role_version_id",
       NEW."created_at"
     ) THEN
    RAISE EXCEPTION 'Experience contributor must be an active exact Role Assignment.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_contributor_active_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_candidates_insert_guard_trigger"
  BEFORE INSERT ON public."experience_candidates"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_candidate_insert();

CREATE OR REPLACE FUNCTION public.guard_experience_source_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  deliverable_record public."deliverables"%ROWTYPE;
  evidence_record public."evidence"%ROWTYPE;
BEGIN
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id";
  IF candidate_record."id" IS NULL
     OR candidate_record."status" <> 'CANDIDATE'
     OR candidate_record."revision" <> 1 THEN
    RAISE EXCEPTION 'Experience provenance can only be attached to a new candidate.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_source_candidate_state_check';
  END IF;
  IF TG_TABLE_NAME = 'experience_source_deliverables' THEN
    SELECT *
      INTO deliverable_record
    FROM public."deliverables"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."deliverable_id"
      AND "version" = NEW."deliverable_version";
    IF deliverable_record."id" IS NULL
       OR deliverable_record."task_id" <> candidate_record."source_task_id"
       OR deliverable_record."status" NOT IN ('SUBMITTED', 'ACCEPTED')
       OR deliverable_record."evidence_sealed_at" IS NULL THEN
      RAISE EXCEPTION 'Experience source Deliverable must be sealed and belong to the source Task.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'experience_source_deliverable_integrity';
    END IF;
  ELSE
    SELECT *
      INTO evidence_record
    FROM public."evidence"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."evidence_id"
      AND "version" = NEW."evidence_version";
    IF evidence_record."id" IS NULL
       OR evidence_record."status" <> 'ACTIVE'
       OR evidence_record."trust_level" <> 'VERIFIED'
       OR evidence_record."verified_at" IS NULL THEN
      RAISE EXCEPTION 'Experience source Evidence must be active and verified.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'experience_source_evidence_integrity';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_source_deliverables_insert_guard_trigger"
  BEFORE INSERT ON public."experience_source_deliverables"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_source_insert();
CREATE TRIGGER "experience_source_evidence_insert_guard_trigger"
  BEFORE INSERT ON public."experience_source_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_source_insert();

CREATE OR REPLACE FUNCTION public.guard_experience_review_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  evidence_record public."evidence"%ROWTYPE;
BEGIN
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id";
  SELECT *
    INTO evidence_record
  FROM public."evidence"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."evidence_id"
    AND "version" = NEW."evidence_version";
  IF candidate_record."id" IS NULL
     OR candidate_record."status" <> 'STRUCTURED'
     OR NEW."command_revision" <> candidate_record."revision" + 1
     OR evidence_record."id" IS NULL
     OR evidence_record."status" <> 'ACTIVE'
     OR evidence_record."trust_level" <> 'VERIFIED'
     OR evidence_record."verified_at" IS NULL THEN
    RAISE EXCEPTION 'Review evidence must be verified and bound to the next review command.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_review_evidence_integrity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_review_evidence_insert_guard_trigger"
  BEFORE INSERT ON public."experience_review_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_review_evidence_insert();

CREATE OR REPLACE FUNCTION public.guard_experience_validation_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  run_record public."agent_runs"%ROWTYPE;
  dataset_record public."knowledge_document_versions"%ROWTYPE;
BEGIN
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id";
  SELECT *
    INTO run_record
  FROM public."agent_runs"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."validation_run_id";
  SELECT *
    INTO dataset_record
  FROM public."knowledge_document_versions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."dataset_version_id";
  IF candidate_record."id" IS NULL
     OR candidate_record."status" <> 'APPROVED'
     OR NEW."command_revision" <> candidate_record."revision" + 1
     OR NEW."validated_by_user_id" = candidate_record."contributor_user_id"
     OR NEW."validated_by_role_assignment_id" =
       candidate_record."contributor_role_assignment_id"
     OR run_record."id" IS NULL
     OR run_record."status" <> 'SUCCEEDED'
     OR run_record."usage_recorded_at" IS NULL
     OR run_record."total_tokens" <= 0
     OR dataset_record."id" IS NULL
     OR dataset_record."status" <> 'PUBLISHED'
     OR dataset_record."published_at" IS NULL THEN
    RAISE EXCEPTION 'Experience validation requires an independent successful run and published dataset.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_validations_evidence_integrity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_validations_insert_guard_trigger"
  BEFORE INSERT ON public."experience_validations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_validation_insert();

CREATE OR REPLACE FUNCTION public.guard_experience_publication_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
BEGIN
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id";
  IF candidate_record."id" IS NULL
     OR candidate_record."status" <> 'VALIDATED'
     OR NEW."command_revision" <> candidate_record."revision" + 1
     OR NOT EXISTS (
       SELECT 1
       FROM public."knowledge_documents" document
       JOIN public."knowledge_document_versions" version
         ON version."tenant_id" = document."tenant_id"
        AND version."knowledge_base_id" = document."knowledge_base_id"
        AND version."document_id" = document."id"
        AND version."id" = NEW."document_version_id"
       WHERE document."tenant_id" = NEW."tenant_id"
         AND document."knowledge_base_id" = NEW."knowledge_base_id"
         AND document."id" = NEW."document_id"
         AND document."current_version_id" = NEW."document_version_id"
         AND document."document_version" = NEW."document_version"
         AND document."status" = 'PUBLISHED'
         AND version."version_number" = NEW."document_version"
         AND version."status" = 'PUBLISHED'
         AND version."published_at" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Experience publication requires the current immutable published Knowledge version.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publications_knowledge_integrity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_publications_insert_guard_trigger"
  BEFORE INSERT ON public."experience_publications"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_publication_insert();

CREATE OR REPLACE FUNCTION public.guard_experience_target_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  publication_record public."experience_publications"%ROWTYPE;
  candidate_record public."experience_candidates"%ROWTYPE;
BEGIN
  SELECT *
    INTO publication_record
  FROM public."experience_publications"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."publication_id";
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = publication_record."tenant_id"
    AND "id" = publication_record."experience_id";
  IF publication_record."id" IS NULL
     OR candidate_record."id" IS NULL
     OR candidate_record."status" <> 'VALIDATED'
     OR publication_record."command_revision" <> candidate_record."revision" + 1 THEN
    RAISE EXCEPTION 'Publication targets must be attached before the exact publish command.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_publication_targets_state_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_publication_role_targets_insert_guard_trigger"
  BEFORE INSERT ON public."experience_publication_role_targets"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_target_insert();
CREATE TRIGGER "experience_publication_org_targets_insert_guard_trigger"
  BEFORE INSERT ON public."experience_publication_org_targets"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_target_insert();

CREATE OR REPLACE FUNCTION public.guard_experience_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Experience provenance, evidence, commands and publication records are append-only.'
    USING ERRCODE = '23514', CONSTRAINT = 'experience_ledger_append_only';
END;
$$;

CREATE TRIGGER "experience_candidates_no_delete_trigger"
  BEFORE DELETE ON public."experience_candidates"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_source_deliverables_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_source_deliverables"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_source_evidence_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_source_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_commands_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_review_evidence_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_review_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_validations_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_validations"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_publications_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_publications"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_publication_role_targets_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_publication_role_targets"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();
CREATE TRIGGER "experience_publication_org_targets_append_only_trigger"
  BEFORE UPDATE OR DELETE ON public."experience_publication_org_targets"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_append_only();

CREATE OR REPLACE FUNCTION public.guard_experience_candidate_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  command_record public."experience_commands"%ROWTYPE;
BEGIN
  IF (
    NEW."tenant_id", NEW."title", NEW."contributor_user_id",
    NEW."contributor_role_assignment_id", NEW."source_task_id",
    NEW."source_deliverable_count", NEW."source_evidence_count",
    NEW."raw_input_hash", NEW."candidate_summary", NEW."permission_labels",
    NEW."sensitivity", NEW."expires_at", NEW."idempotency_key",
    NEW."request_hash", NEW."created_at"
  ) IS DISTINCT FROM (
    OLD."tenant_id", OLD."title", OLD."contributor_user_id",
    OLD."contributor_role_assignment_id", OLD."source_task_id",
    OLD."source_deliverable_count", OLD."source_evidence_count",
    OLD."raw_input_hash", OLD."candidate_summary", OLD."permission_labels",
    OLD."sensitivity", OLD."expires_at", OLD."idempotency_key",
    OLD."request_hash", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Experience candidate identity, provenance and policy snapshot are immutable.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_immutable_snapshot';
  END IF;
  SELECT *
    INTO command_record
  FROM public."experience_commands" command
  WHERE command."tenant_id" = NEW."tenant_id"
    AND command."experience_id" = NEW."id"
    AND command."revision" = NEW."revision";
  IF NEW."revision" <> OLD."revision" + 1
     OR command_record."id" IS NULL
     OR command_record."expected_revision" <> OLD."revision"
     OR command_record."target_status" <> NEW."status" THEN
    RAISE EXCEPTION 'Experience state must be advanced by one exact immutable command.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_command_coverage';
  END IF;
  NEW."updated_at" := command_record."occurred_at";
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_candidates_update_guard_trigger"
  BEFORE UPDATE ON public."experience_candidates"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_candidate_update();

CREATE OR REPLACE FUNCTION public.guard_experience_command_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  expected_status public."ExperienceStatus";
  required_permission text;
  current_user_id uuid :=
    NULLIF(current_setting('app.user_id', true), '')::uuid;
  evidence_count integer;
  validation_record public."experience_validations"%ROWTYPE;
  publication_record public."experience_publications"%ROWTYPE;
  role_target_count integer;
  org_target_count integer;
  payload_use_count integer;
  payload_adoption_count integer;
  payload_complaint_count integer;
  expected_review_decision text;
BEGIN
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id"
  FOR UPDATE;
  IF candidate_record."id" IS NULL THEN
    RAISE EXCEPTION 'Experience Candidate does not exist.'
      USING ERRCODE = '23503',
            CONSTRAINT = 'experience_commands_candidate_exists';
  END IF;
  expected_status := CASE
    WHEN candidate_record."status" = 'CANDIDATE' AND NEW."action" = 'SANITIZE'
      THEN 'SANITIZED'
    WHEN candidate_record."status" = 'SANITIZED' AND NEW."action" = 'STRUCTURE'
      THEN 'STRUCTURED'
    WHEN candidate_record."status" = 'STRUCTURED' AND NEW."action" = 'APPROVE'
      THEN 'APPROVED'
    WHEN candidate_record."status" = 'STRUCTURED' AND NEW."action" = 'REJECT'
      THEN 'REJECTED'
    WHEN candidate_record."status" = 'APPROVED' AND NEW."action" = 'VALIDATE'
      THEN 'VALIDATED'
    WHEN candidate_record."status" = 'VALIDATED' AND NEW."action" = 'PUBLISH'
      THEN 'PUBLISHED'
    WHEN candidate_record."status" = 'PUBLISHED' AND NEW."action" = 'MONITOR'
      THEN 'MONITORED'
    WHEN candidate_record."status" = 'MONITORED' AND NEW."action" = 'MONITOR'
      THEN 'MONITORED'
    WHEN candidate_record."status" IN ('PUBLISHED', 'MONITORED')
      AND NEW."action" = 'RETIRE'
      THEN 'RETIRED'
    ELSE NULL
  END;
  required_permission := CASE NEW."action"
    WHEN 'SANITIZE' THEN 'EXPERIENCE_SANITIZE'
    WHEN 'STRUCTURE' THEN 'EXPERIENCE_STRUCTURE'
    WHEN 'APPROVE' THEN 'EXPERIENCE_REVIEW'
    WHEN 'REJECT' THEN 'EXPERIENCE_REVIEW'
    WHEN 'VALIDATE' THEN 'EXPERIENCE_VALIDATE'
    WHEN 'PUBLISH' THEN 'EXPERIENCE_PUBLISH'
    WHEN 'MONITOR' THEN 'EXPERIENCE_MONITOR'
    WHEN 'RETIRE' THEN 'EXPERIENCE_RETIRE'
  END;
  IF current_user_id IS NULL
     OR NEW."actor_user_id" <> current_user_id
     OR NEW."expected_revision" <> candidate_record."revision"
     OR NEW."revision" <> candidate_record."revision" + 1
     OR expected_status IS NULL
     OR NEW."target_status" <> expected_status
     OR NEW."occurred_at" < candidate_record."created_at"
     OR NOT public.experience_actor_has_permission(
       NEW."tenant_id",
       NEW."actor_user_id",
       NEW."actor_role_assignment_id",
       required_permission,
       NEW."occurred_at"
     ) THEN
    RAISE EXCEPTION 'Experience command actor, revision, permission or transition is invalid.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_commands_transition_guard';
  END IF;

  IF NEW."action" = 'SANITIZE' THEN
      IF NOT (
        NEW."payload" ?& ARRAY[
          'sanitizedContent', 'sanitizedHash', 'piiRemoved', 'secretsRemoved',
          'customerIdentifiersRemoved', 'findings', 'sanitizedByUserId',
          'sanitizedAt'
        ]
        AND length(btrim(NEW."payload" ->> 'sanitizedContent')) BETWEEN 1 AND 20000
        AND NEW."payload" ->> 'sanitizedHash' ~ '^[a-f0-9]{64}$'
        AND (NEW."payload" ->> 'piiRemoved')::boolean
        AND (NEW."payload" ->> 'secretsRemoved')::boolean
        AND (NEW."payload" ->> 'customerIdentifiersRemoved')::boolean
        AND jsonb_typeof(NEW."payload" -> 'findings') = 'array'
        AND NEW."payload" ->> 'sanitizedByUserId' = NEW."actor_user_id"::text
        AND (NEW."payload" ->> 'sanitizedAt')::timestamptz = NEW."occurred_at"
      ) THEN
        RAISE EXCEPTION 'Experience sanitization proof is incomplete.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_sanitization_proof';
      END IF;
  ELSIF NEW."action" = 'STRUCTURE' THEN
      IF NOT (
        NEW."payload" ?& ARRAY['structuredContent', 'structuredHash']
        AND NEW."payload" ->> 'structuredHash' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(NEW."payload" -> 'structuredContent') = 'object'
        AND length(btrim(NEW."payload" #>> '{structuredContent,scenario}'))
          BETWEEN 1 AND 20000
        AND length(btrim(NEW."payload" #>> '{structuredContent,problem}'))
          BETWEEN 1 AND 20000
        AND jsonb_typeof(NEW."payload" #> '{structuredContent,steps}') = 'array'
        AND jsonb_array_length(NEW."payload" #> '{structuredContent,steps}') > 0
        AND jsonb_typeof(NEW."payload" #> '{structuredContent,outcomes}') = 'array'
        AND jsonb_array_length(NEW."payload" #> '{structuredContent,outcomes}') > 0
        AND jsonb_typeof(
          NEW."payload" #> '{structuredContent,applicabilityBoundaries}'
        ) = 'array'
        AND jsonb_array_length(
          NEW."payload" #> '{structuredContent,applicabilityBoundaries}'
        ) > 0
      ) THEN
        RAISE EXCEPTION 'Experience structured proof is incomplete.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_structure_proof';
      END IF;
  ELSIF NEW."action" IN ('APPROVE', 'REJECT') THEN
      expected_review_decision := CASE
        WHEN NEW."action" = 'APPROVE' THEN 'APPROVED'
        ELSE 'REJECTED'
      END;
      SELECT count(*)
        INTO evidence_count
      FROM public."experience_review_evidence" evidence
      WHERE evidence."tenant_id" = NEW."tenant_id"
        AND evidence."experience_id" = NEW."experience_id"
        AND evidence."command_revision" = NEW."revision";
      IF NEW."actor_user_id" = candidate_record."contributor_user_id"
         OR NEW."actor_role_assignment_id" =
           candidate_record."contributor_role_assignment_id"
         OR NEW."payload" ->> 'reviewerUserId' <> NEW."actor_user_id"::text
         OR NEW."payload" ->> 'reviewerRoleAssignmentId' <>
           NEW."actor_role_assignment_id"::text
         OR NEW."payload" ->> 'decision' <> expected_review_decision
         OR length(btrim(NEW."payload" ->> 'reason')) = 0
         OR jsonb_typeof(NEW."payload" -> 'evidenceIds') <> 'array'
         OR jsonb_array_length(NEW."payload" -> 'evidenceIds') = 0
         OR evidence_count <> jsonb_array_length(NEW."payload" -> 'evidenceIds')
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(NEW."payload" -> 'evidenceIds') item(id)
           WHERE NOT EXISTS (
             SELECT 1
             FROM public."experience_review_evidence" evidence
             WHERE evidence."tenant_id" = NEW."tenant_id"
               AND evidence."experience_id" = NEW."experience_id"
               AND evidence."command_revision" = NEW."revision"
               AND evidence."evidence_id" = item.id::uuid
           )
         ) THEN
        RAISE EXCEPTION 'Experience review must be independent and fully evidenced.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_review_proof';
      END IF;
  ELSIF NEW."action" = 'VALIDATE' THEN
      SELECT *
        INTO validation_record
      FROM public."experience_validations" validation
      WHERE validation."tenant_id" = NEW."tenant_id"
        AND validation."experience_id" = NEW."experience_id"
        AND validation."command_revision" = NEW."revision";
      IF validation_record."id" IS NULL
         OR NEW."actor_user_id" = candidate_record."contributor_user_id"
         OR NEW."actor_role_assignment_id" =
           candidate_record."contributor_role_assignment_id"
         OR NEW."payload" ->> 'validationRunId' <>
           validation_record."validation_run_id"::text
         OR NEW."payload" ->> 'datasetVersionId' <>
           validation_record."dataset_version_id"::text
         OR (NEW."payload" ->> 'passed')::boolean IS NOT TRUE
         OR (NEW."payload" ->> 'score')::numeric <> validation_record."score"
         OR (NEW."payload" ->> 'threshold')::numeric <>
           validation_record."threshold"
         OR NEW."payload" ->> 'validatedByUserId' <>
           NEW."actor_user_id"::text THEN
        RAISE EXCEPTION 'Experience validation command is not bound to its independent evidence.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_validation_proof';
      END IF;
  ELSIF NEW."action" = 'PUBLISH' THEN
      SELECT *
        INTO publication_record
      FROM public."experience_publications" publication
      WHERE publication."tenant_id" = NEW."tenant_id"
        AND publication."experience_id" = NEW."experience_id"
        AND publication."command_revision" = NEW."revision";
      SELECT count(*)
        INTO role_target_count
      FROM public."experience_publication_role_targets" target
      WHERE target."tenant_id" = NEW."tenant_id"
        AND target."publication_id" = publication_record."id";
      SELECT count(*)
        INTO org_target_count
      FROM public."experience_publication_org_targets" target
      WHERE target."tenant_id" = NEW."tenant_id"
        AND target."publication_id" = publication_record."id";
      IF publication_record."id" IS NULL
         OR role_target_count + org_target_count = 0
         OR NEW."payload" ->> 'knowledgeBaseId' <>
           publication_record."knowledge_base_id"::text
         OR NEW."payload" ->> 'documentId' <>
           publication_record."document_id"::text
         OR NEW."payload" ->> 'documentVersionId' <>
           publication_record."document_version_id"::text
         OR (NEW."payload" ->> 'documentVersion')::integer <>
           publication_record."document_version"
         OR NEW."payload" ->> 'publicationHash' <>
           publication_record."publication_hash"
         OR jsonb_array_length(NEW."payload" -> 'targetRoleTemplateIds') <>
           role_target_count
         OR jsonb_array_length(NEW."payload" -> 'targetOrgUnitIds') <>
           org_target_count
         OR NEW."payload" ->> 'publishedByUserId' <>
           NEW."actor_user_id"::text THEN
        RAISE EXCEPTION 'Experience publication command is not bound to its governed target evidence.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_publication_proof';
      END IF;
  ELSIF NEW."action" = 'MONITOR' THEN
      payload_use_count := (NEW."payload" ->> 'useCount')::integer;
      payload_adoption_count := (NEW."payload" ->> 'adoptionCount')::integer;
      payload_complaint_count := (NEW."payload" ->> 'complaintCount')::integer;
      IF payload_use_count < candidate_record."monitored_use_count"
         OR payload_adoption_count < candidate_record."monitored_adoption_count"
         OR payload_complaint_count < candidate_record."monitored_complaint_count"
         OR payload_adoption_count > payload_use_count
         OR payload_complaint_count > payload_use_count THEN
        RAISE EXCEPTION 'Experience monitoring counters must be monotonic and consistent.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_monitoring_proof';
      END IF;
  ELSIF NEW."action" = 'RETIRE' THEN
      IF NEW."payload" ? 'replacementExperienceId'
         AND NEW."payload" ? 'rollbackDocumentVersionId'
         AND NEW."payload" ->> 'replacementExperienceId' IS NOT NULL
         AND NEW."payload" ->> 'rollbackDocumentVersionId' IS NOT NULL THEN
        RAISE EXCEPTION 'Experience retirement must choose replacement or rollback, not both.'
          USING ERRCODE = '23514',
                CONSTRAINT = 'experience_commands_retirement_proof';
      END IF;
  END IF;

  UPDATE public."experience_candidates"
  SET "status" = expected_status,
      "revision" = NEW."revision",
      "sanitization" = CASE
        WHEN NEW."action" = 'SANITIZE' THEN NEW."payload"
        ELSE "sanitization"
      END,
      "structured_content" = CASE
        WHEN NEW."action" = 'STRUCTURE'
          THEN NEW."payload" -> 'structuredContent'
        ELSE "structured_content"
      END,
      "structured_hash" = CASE
        WHEN NEW."action" = 'STRUCTURE'
          THEN NEW."payload" ->> 'structuredHash'
        ELSE "structured_hash"
      END,
      "review" = CASE
        WHEN NEW."action" IN ('APPROVE', 'REJECT') THEN NEW."payload"
        ELSE "review"
      END,
      "validation" = CASE
        WHEN NEW."action" = 'VALIDATE' THEN NEW."payload"
        ELSE "validation"
      END,
      "publication" = CASE
        WHEN NEW."action" = 'PUBLISH' THEN NEW."payload"
        ELSE "publication"
      END,
      "monitored_use_count" = CASE
        WHEN NEW."action" = 'MONITOR'
          THEN (NEW."payload" ->> 'useCount')::integer
        ELSE "monitored_use_count"
      END,
      "monitored_adoption_count" = CASE
        WHEN NEW."action" = 'MONITOR'
          THEN (NEW."payload" ->> 'adoptionCount')::integer
        ELSE "monitored_adoption_count"
      END,
      "monitored_complaint_count" = CASE
        WHEN NEW."action" = 'MONITOR'
          THEN (NEW."payload" ->> 'complaintCount')::integer
        ELSE "monitored_complaint_count"
      END,
      "retired_at" = CASE
        WHEN NEW."action" = 'RETIRE' THEN NEW."occurred_at"
        ELSE "retired_at"
      END,
      "updated_at" = NEW."occurred_at"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."experience_id";
  RETURN NEW;
END;
$$;
CREATE TRIGGER "experience_commands_insert_guard_trigger"
  AFTER INSERT ON public."experience_commands"
  FOR EACH ROW EXECUTE FUNCTION public.guard_experience_command_insert();

CREATE OR REPLACE FUNCTION public.validate_experience_trace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_record public."experience_candidates"%ROWTYPE;
  command_record record;
  replay_status public."ExperienceStatus" := 'CANDIDATE';
  expected_revision integer := 2;
  prior_time timestamptz;
  deliverable_count integer;
  evidence_count integer;
BEGIN
  SELECT *
    INTO candidate_record
  FROM public."experience_candidates"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."id";
  IF candidate_record."id" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*)
    INTO deliverable_count
  FROM public."experience_source_deliverables" source
  WHERE source."tenant_id" = candidate_record."tenant_id"
    AND source."experience_id" = candidate_record."id";
  SELECT count(*)
    INTO evidence_count
  FROM public."experience_source_evidence" source
  WHERE source."tenant_id" = candidate_record."tenant_id"
    AND source."experience_id" = candidate_record."id";
  IF deliverable_count <> candidate_record."source_deliverable_count"
     OR evidence_count <> candidate_record."source_evidence_count" THEN
    RAISE EXCEPTION 'Experience candidate provenance trace is incomplete.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_source_completeness';
  END IF;

  FOR command_record IN
    SELECT *
    FROM public."experience_commands" command
    WHERE command."tenant_id" = candidate_record."tenant_id"
      AND command."experience_id" = candidate_record."id"
    ORDER BY command."revision"
  LOOP
    IF command_record."revision" <> expected_revision
       OR command_record."expected_revision" <> expected_revision - 1
       OR (
         prior_time IS NOT NULL
         AND command_record."occurred_at" < prior_time
       ) THEN
      RAISE EXCEPTION 'Experience command trace is not contiguous.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'experience_candidates_trace_contiguous';
    END IF;
    replay_status := CASE
      WHEN replay_status = 'CANDIDATE' AND command_record."action" = 'SANITIZE'
        THEN 'SANITIZED'
      WHEN replay_status = 'SANITIZED' AND command_record."action" = 'STRUCTURE'
        THEN 'STRUCTURED'
      WHEN replay_status = 'STRUCTURED' AND command_record."action" = 'APPROVE'
        THEN 'APPROVED'
      WHEN replay_status = 'STRUCTURED' AND command_record."action" = 'REJECT'
        THEN 'REJECTED'
      WHEN replay_status = 'APPROVED' AND command_record."action" = 'VALIDATE'
        THEN 'VALIDATED'
      WHEN replay_status = 'VALIDATED' AND command_record."action" = 'PUBLISH'
        THEN 'PUBLISHED'
      WHEN replay_status = 'PUBLISHED' AND command_record."action" = 'MONITOR'
        THEN 'MONITORED'
      WHEN replay_status = 'MONITORED' AND command_record."action" = 'MONITOR'
        THEN 'MONITORED'
      WHEN replay_status IN ('PUBLISHED', 'MONITORED')
        AND command_record."action" = 'RETIRE'
        THEN 'RETIRED'
      ELSE NULL
    END;
    IF replay_status IS NULL
       OR replay_status <> command_record."target_status" THEN
      RAISE EXCEPTION 'Experience command trace contains an illegal transition.'
        USING ERRCODE = '23514',
              CONSTRAINT = 'experience_candidates_trace_status';
    END IF;
    expected_revision := expected_revision + 1;
    prior_time := command_record."occurred_at";
  END LOOP;
  IF expected_revision <> candidate_record."revision" + 1
     OR replay_status <> candidate_record."status" THEN
    RAISE EXCEPTION 'Experience aggregate does not match its immutable command trace.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_trace_complete';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "experience_candidates_trace_trigger"
  AFTER INSERT OR UPDATE ON public."experience_candidates"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_experience_trace();

CREATE OR REPLACE FUNCTION public.validate_memory_audit_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  command_action text;
  required_action text;
BEGIN
  IF NEW."revision" = 1 THEN
    required_action := 'memory.candidate.created';
  ELSE
    SELECT lower(command."action"::text)
      INTO command_action
    FROM public."memory_commands" command
    WHERE command."tenant_id" = NEW."tenant_id"
      AND command."memory_id" = NEW."id"
      AND command."revision" = NEW."revision";
    required_action := 'memory.' || command_action;
  END IF;
  IF required_action IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public."audit_events" audit
       WHERE audit."tenant_id" = NEW."tenant_id"
         AND audit."resource_type" = 'MEMORY'
         AND audit."resource_id" = NEW."id"
         AND audit."action" = required_action
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public."outbox_events" outbox
       WHERE outbox."tenant_id" = NEW."tenant_id"
         AND outbox."aggregate_type" = 'MEMORY'
         AND outbox."aggregate_id" = NEW."id"
         AND (
           NEW."revision" = 1
           OR (outbox."payload" ->> 'revision')::integer = NEW."revision"
         )
     ) THEN
    RAISE EXCEPTION 'Memory write must atomically record AuditLog and Outbox evidence.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'memory_records_audit_outbox_coverage';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "memory_records_audit_outbox_trigger"
  AFTER INSERT OR UPDATE ON public."memory_records"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_memory_audit_outbox();

CREATE OR REPLACE FUNCTION public.validate_experience_audit_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  command_action text;
  required_action text;
BEGIN
  IF NEW."revision" = 1 THEN
    required_action := 'experience.candidate.created';
  ELSE
    SELECT lower(command."action"::text)
      INTO command_action
    FROM public."experience_commands" command
    WHERE command."tenant_id" = NEW."tenant_id"
      AND command."experience_id" = NEW."id"
      AND command."revision" = NEW."revision";
    required_action := 'experience.' || command_action;
  END IF;
  IF required_action IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public."audit_events" audit
       WHERE audit."tenant_id" = NEW."tenant_id"
         AND audit."resource_type" = 'EXPERIENCE'
         AND audit."resource_id" = NEW."id"
         AND audit."action" = required_action
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public."outbox_events" outbox
       WHERE outbox."tenant_id" = NEW."tenant_id"
         AND outbox."aggregate_type" = 'EXPERIENCE'
         AND outbox."aggregate_id" = NEW."id"
         AND (
           NEW."revision" = 1
           OR (outbox."payload" ->> 'revision')::integer = NEW."revision"
         )
     ) THEN
    RAISE EXCEPTION 'Experience write must atomically record AuditLog and Outbox evidence.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'experience_candidates_audit_outbox_coverage';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "experience_candidates_audit_outbox_trigger"
  AFTER INSERT OR UPDATE ON public."experience_candidates"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_experience_audit_outbox();

DO $$
DECLARE
  table_name text;
  protected_tables text[] := ARRAY[
    'memory_records',
    'memory_source_evidence',
    'memory_commands',
    'experience_candidates',
    'experience_source_deliverables',
    'experience_source_evidence',
    'experience_commands',
    'experience_review_evidence',
    'experience_validations',
    'experience_publications',
    'experience_publication_role_targets',
    'experience_publication_org_targets'
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables
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
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM enterprise_agent_app',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM enterprise_agent_admin',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I '
      || 'TO enterprise_agent_admin',
      table_name
    );
  END LOOP;
END;
$$;

CREATE POLICY "memory_records_app_select"
  ON public."memory_records"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (
    public.memory_record_accessible(
      memory_records,
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      current_setting('app.memory_purpose', true),
      CURRENT_TIMESTAMP
    )
  );
CREATE POLICY "memory_records_app_insert"
  ON public."memory_records"
  AS PERMISSIVE
  FOR INSERT
  TO enterprise_agent_app
  WITH CHECK (
    public.memory_record_creatable(
      memory_records,
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      current_setting('app.memory_purpose', true),
      CURRENT_TIMESTAMP
    )
  );

CREATE POLICY "memory_source_evidence_app_select"
  ON public."memory_source_evidence"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (
    EXISTS (
      SELECT 1
      FROM public."memory_records" memory
      WHERE memory."tenant_id" = memory_source_evidence."tenant_id"
        AND memory."id" = memory_source_evidence."memory_id"
        AND public.memory_record_accessible(
          memory,
          NULLIF(current_setting('app.user_id', true), '')::uuid,
          current_setting('app.memory_purpose', true),
          CURRENT_TIMESTAMP
        )
    )
  );
CREATE POLICY "memory_source_evidence_app_insert"
  ON public."memory_source_evidence"
  AS PERMISSIVE
  FOR INSERT
  TO enterprise_agent_app
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public."memory_records" memory
      WHERE memory."tenant_id" = memory_source_evidence."tenant_id"
        AND memory."id" = memory_source_evidence."memory_id"
        AND public.memory_record_creatable(
          memory,
          NULLIF(current_setting('app.user_id', true), '')::uuid,
          current_setting('app.memory_purpose', true),
          CURRENT_TIMESTAMP
        )
    )
  );

CREATE POLICY "memory_commands_app_select"
  ON public."memory_commands"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_app
  USING (
    "actor_user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."memory_records" memory
      WHERE memory."tenant_id" = memory_commands."tenant_id"
        AND memory."id" = memory_commands."memory_id"
        AND public.memory_record_accessible(
          memory,
          NULLIF(current_setting('app.user_id', true), '')::uuid,
          current_setting('app.memory_purpose', true),
          CURRENT_TIMESTAMP
        )
    )
  );
CREATE POLICY "memory_commands_app_insert"
  ON public."memory_commands"
  AS PERMISSIVE
  FOR INSERT
  TO enterprise_agent_app
  WITH CHECK (
    "actor_user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."memory_records" memory
      WHERE memory."tenant_id" = memory_commands."tenant_id"
        AND memory."id" = memory_commands."memory_id"
        AND public.memory_record_accessible(
          memory,
          NULLIF(current_setting('app.user_id', true), '')::uuid,
          current_setting('app.memory_purpose', true),
          CURRENT_TIMESTAMP
        )
    )
  );

GRANT SELECT, INSERT ON TABLE public."memory_records"
  TO enterprise_agent_app;
GRANT SELECT, INSERT ON TABLE public."memory_source_evidence"
  TO enterprise_agent_app;
GRANT SELECT, INSERT ON TABLE public."memory_commands"
  TO enterprise_agent_app;

GRANT USAGE ON TYPE
  public."MemoryScope",
  public."MemoryStatus",
  public."MemorySourceType",
  public."MemorySensitivity",
  public."MemoryRetentionAction",
  public."MemoryTransitionAction",
  public."ExperienceStatus",
  public."ExperienceTransitionAction"
TO enterprise_agent_app, enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.memory_labels_covered(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.memory_assignment_active(
  uuid, uuid, uuid, uuid, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.memory_record_accessible(
  public."memory_records", uuid, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.memory_record_creatable(
  public."memory_records", uuid, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.experience_actor_has_permission(
  uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;
-- The following SECURITY DEFINER functions are trigger-only guards. PostgreSQL
-- validates EXECUTE when each trigger is created, so runtime application roles
-- do not need direct invocation rights. Revoke the default PUBLIC privilege and
-- leave execution solely to the function owner through the installed triggers.
REVOKE ALL ON FUNCTION public.guard_memory_command_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_memory_trace() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_experience_source_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_experience_review_evidence_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_experience_validation_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_experience_publication_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_experience_target_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_experience_command_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_experience_trace() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_memory_audit_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_experience_audit_outbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.memory_labels_covered(jsonb, jsonb)
  TO enterprise_agent_app, enterprise_agent_admin;
GRANT EXECUTE ON FUNCTION public.memory_assignment_active(
  uuid, uuid, uuid, uuid, uuid, timestamptz
) TO enterprise_agent_app, enterprise_agent_admin;
GRANT EXECUTE ON FUNCTION public.memory_record_accessible(
  public."memory_records", uuid, text, timestamptz
) TO enterprise_agent_app, enterprise_agent_admin;
GRANT EXECUTE ON FUNCTION public.memory_record_creatable(
  public."memory_records", uuid, text, timestamptz
) TO enterprise_agent_app, enterprise_agent_admin;
GRANT EXECUTE ON FUNCTION public.experience_actor_has_permission(
  uuid, uuid, uuid, text, timestamptz
) TO enterprise_agent_admin;

COMMIT;
