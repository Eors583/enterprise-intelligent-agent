BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE public."BusinessValueType" AS ENUM ('CUSTOMER', 'ENTERPRISE', 'ROLE');
CREATE TYPE public."ValueVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE public."ValueConstraintType" AS ENUM (
  'REGULATORY', 'POLICY', 'RISK', 'ETHICAL', 'FINANCIAL', 'BEHAVIORAL'
);
CREATE TYPE public."ValueConstraintSeverity" AS ENUM ('HARD', 'SOFT');
CREATE TYPE public."StrategyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED');
CREATE TYPE public."ObjectiveStatus" AS ENUM (
  'DRAFT', 'ACTIVE', 'AT_RISK', 'ACHIEVED', 'CANCELLED'
);
CREATE TYPE public."BscPerspective" AS ENUM (
  'FINANCIAL', 'CUSTOMER', 'INTERNAL_PROCESS', 'LEARNING_GROWTH'
);
CREATE TYPE public."IndicatorType" AS ENUM ('LEADING', 'LAGGING');
CREATE TYPE public."ObjectiveRelationType" AS ENUM ('PARENT_CHILD', 'CAUSES', 'SUPPORTS');
CREATE TYPE public."ObjectiveRelationStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE public."MetricValueType" AS ENUM (
  'NUMBER', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'COUNT', 'BOOLEAN'
);
CREATE TYPE public."MetricAggregation" AS ENUM (
  'SUM', 'AVERAGE', 'MINIMUM', 'MAXIMUM', 'LATEST', 'COUNT'
);
CREATE TYPE public."MetricDirection" AS ENUM ('INCREASE', 'DECREASE', 'MAINTAIN', 'RANGE');
CREATE TYPE public."MetricDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE public."MetricSubjectType" AS ENUM (
  'VALUE_VERSION', 'STRATEGY', 'OBJECTIVE', 'TASK', 'DELIVERABLE'
);
CREATE TYPE public."ProcessDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE public."ProcessVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE public."ProcessNodeType" AS ENUM ('START', 'ACTIVITY', 'DECISION', 'MILESTONE', 'END');
CREATE TYPE public."TaskStatus" AS ENUM (
  'PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED',
  'ACCEPTED', 'REJECTED', 'CANCELLED'
);
CREATE TYPE public."TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE public."TaskDependencyType" AS ENUM (
  'FINISH_TO_START', 'START_TO_START', 'FINISH_TO_FINISH', 'START_TO_FINISH'
);
CREATE TYPE public."TaskDependencyStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE public."DeliverableStatus" AS ENUM (
  'DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'
);
CREATE TYPE public."AcceptanceDecision" AS ENUM ('ACCEPTED', 'REJECTED', 'CHANGES_REQUESTED');
CREATE TYPE public."AcceptanceStatus" AS ENUM ('ACTIVE', 'VOID');
CREATE TYPE public."EvidenceSourceType" AS ENUM (
  'BUSINESS_SYSTEM', 'DOCUMENT', 'HUMAN_ATTESTATION',
  'AGENT_RUN', 'METRIC', 'PROCESS_EVENT'
);
CREATE TYPE public."EvidenceTrustLevel" AS ENUM (
  'VERIFIED', 'HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED'
);
CREATE TYPE public."EvidenceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'REVOKED');
CREATE TYPE public."EvidenceTargetType" AS ENUM (
  'VALUE_VERSION', 'STRATEGY', 'OBJECTIVE', 'METRIC_OBSERVATION',
  'TASK', 'DELIVERABLE', 'ACCEPTANCE'
);
CREATE TYPE public."EvidenceLinkType" AS ENUM (
  'SUPPORTS', 'REFUTES', 'QUALIFIES', 'DERIVED_FROM'
);
CREATE TYPE public."EvidenceLinkStatus" AS ENUM ('ACTIVE', 'REMOVED');

CREATE TABLE public."value_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "type" public."BusinessValueType" NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT,
  "current_version_id" UUID,
  "current_version_number" INTEGER,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "value_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "value_definitions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "value_definitions_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "value_definitions_tenant_id_code_key" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "value_definitions_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."value_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "value_definition_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "status" public."ValueVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "statement" TEXT NOT NULL,
  "positive_behaviors" JSONB NOT NULL,
  "negative_behaviors" JSONB NOT NULL,
  "change_summary" VARCHAR(500) NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "published_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "value_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "value_versions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "value_versions_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "value_versions_tenant_definition_id_id_key"
    UNIQUE ("tenant_id", "value_definition_id", "id"),
  CONSTRAINT "value_versions_tenant_definition_id_id_version_key"
    UNIQUE ("tenant_id", "value_definition_id", "id", "version"),
  CONSTRAINT "value_versions_tenant_definition_id_version_key"
    UNIQUE ("tenant_id", "value_definition_id", "version"),
  CONSTRAINT "value_versions_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."value_metrics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "value_definition_id" UUID NOT NULL,
  "value_version_id" UUID NOT NULL,
  "value_version_number" INTEGER NOT NULL,
  "metric_definition_id" UUID NOT NULL,
  "metric_definition_version" INTEGER NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "weight" DECIMAL(12,10) NOT NULL,
  "target" JSONB NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "value_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "value_metrics_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "value_metrics_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "value_metrics_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "value_metrics_version_code_key" UNIQUE ("tenant_id", "value_version_id", "code"),
  CONSTRAINT "value_metrics_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."value_constraints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "value_definition_id" UUID NOT NULL,
  "value_version_id" UUID NOT NULL,
  "value_version_number" INTEGER NOT NULL,
  "type" public."ValueConstraintType" NOT NULL,
  "severity" public."ValueConstraintSeverity" NOT NULL,
  "statement" TEXT NOT NULL,
  "required_evidence_types" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "value_constraints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "value_constraints_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "value_constraints_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "value_constraints_tenant_id_code_version_key"
    UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "value_constraints_version_code_key"
    UNIQUE ("tenant_id", "value_version_id", "code"),
  CONSTRAINT "value_constraints_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."strategies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL,
  "status" public."StrategyStatus" NOT NULL DEFAULT 'DRAFT',
  "budget_amount" DECIMAL(30,10),
  "budget_currency" CHAR(3),
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "activated_at" TIMESTAMPTZ(6),
  "closed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "strategies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "strategies_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "strategies_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "strategies_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "strategies_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."strategy_value_versions" (
  "tenant_id" UUID NOT NULL,
  "strategy_id" UUID NOT NULL,
  "strategy_version" INTEGER NOT NULL,
  "value_definition_id" UUID NOT NULL,
  "value_version_id" UUID NOT NULL,
  "value_version_number" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "strategy_value_versions_pkey" PRIMARY KEY (
    "tenant_id", "strategy_id", "strategy_version",
    "value_definition_id", "value_version_id"
  ),
  CONSTRAINT "strategy_value_versions_full_identity_key" UNIQUE (
    "tenant_id", "strategy_id", "strategy_version", "value_definition_id",
    "value_version_id", "value_version_number"
  )
);

CREATE TABLE public."objectives" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "strategy_id" UUID NOT NULL,
  "strategy_version" INTEGER NOT NULL,
  "parent_objective_id" UUID,
  "parent_objective_version" INTEGER,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL,
  "status" public."ObjectiveStatus" NOT NULL DEFAULT 'DRAFT',
  "bsc_perspective" public."BscPerspective" NOT NULL,
  "indicator_type" public."IndicatorType" NOT NULL,
  "weight" DECIMAL(12,10) NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "activated_at" TIMESTAMPTZ(6),
  "achieved_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "objectives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "objectives_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "objectives_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "objectives_strategy_identity_key"
    UNIQUE ("tenant_id", "id", "version", "strategy_id", "strategy_version"),
  CONSTRAINT "objectives_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "objectives_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."objective_value_versions" (
  "tenant_id" UUID NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "strategy_id" UUID NOT NULL,
  "strategy_version" INTEGER NOT NULL,
  "value_definition_id" UUID NOT NULL,
  "value_version_id" UUID NOT NULL,
  "value_version_number" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "objective_value_versions_pkey" PRIMARY KEY (
    "tenant_id", "objective_id", "objective_version",
    "value_definition_id", "value_version_id"
  ),
  CONSTRAINT "objective_value_versions_full_identity_key" UNIQUE (
    "tenant_id", "objective_id", "objective_version", "strategy_id",
    "strategy_version", "value_definition_id", "value_version_id",
    "value_version_number"
  )
);

CREATE TABLE public."objective_role_assignments" (
  "tenant_id" UUID NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "role_assignment_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "objective_role_assignments_pkey" PRIMARY KEY (
    "tenant_id", "objective_id", "objective_version", "role_assignment_id"
  )
);

CREATE TABLE public."objective_relations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "source_objective_id" UUID NOT NULL,
  "source_objective_version" INTEGER NOT NULL,
  "target_objective_id" UUID NOT NULL,
  "target_objective_version" INTEGER NOT NULL,
  "type" public."ObjectiveRelationType" NOT NULL,
  "status" public."ObjectiveRelationStatus" NOT NULL DEFAULT 'ACTIVE',
  "weight" DECIMAL(12,10) NOT NULL,
  "lag_days" INTEGER NOT NULL DEFAULT 0,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "objective_relations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "objective_relations_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "objective_relations_tenant_id_id_version_key"
    UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "objective_relations_tenant_id_code_version_key"
    UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "objective_relations_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."metric_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL,
  "status" public."MetricDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
  "value_type" public."MetricValueType" NOT NULL,
  "unit" VARCHAR(50) NOT NULL,
  "aggregation" public."MetricAggregation" NOT NULL,
  "direction" public."MetricDirection" NOT NULL,
  "bsc_perspective" public."BscPerspective" NOT NULL,
  "indicator_type" public."IndicatorType" NOT NULL,
  "valid_range_minimum" DECIMAL(30,10),
  "valid_range_maximum" DECIMAL(30,10),
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "activated_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "metric_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "metric_definitions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "metric_definitions_tenant_id_id_version_key"
    UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "metric_definitions_tenant_id_code_version_key"
    UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "metric_definitions_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."objective_metric_definitions" (
  "tenant_id" UUID NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "metric_definition_id" UUID NOT NULL,
  "metric_definition_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "objective_metric_definitions_pkey" PRIMARY KEY (
    "tenant_id", "objective_id", "objective_version",
    "metric_definition_id", "metric_definition_version"
  )
);

CREATE TABLE public."process_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL,
  "status" public."ProcessDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
  "current_version_id" UUID,
  "current_version_number" INTEGER,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "process_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_definitions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_definitions_tenant_id_id_code_key" UNIQUE ("tenant_id", "id", "code"),
  CONSTRAINT "process_definitions_tenant_id_code_key" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "process_definitions_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."process_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "process_definition_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "status" public."ProcessVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "change_summary" VARCHAR(500) NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "published_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "process_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_versions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_versions_tenant_id_id_version_key"
    UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "process_versions_tenant_definition_id_id_key"
    UNIQUE ("tenant_id", "process_definition_id", "id"),
  CONSTRAINT "process_versions_tenant_definition_id_id_version_key"
    UNIQUE ("tenant_id", "process_definition_id", "id", "version"),
  CONSTRAINT "process_versions_tenant_definition_id_version_key"
    UNIQUE ("tenant_id", "process_definition_id", "version"),
  CONSTRAINT "process_versions_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."process_nodes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "process_definition_id" UUID NOT NULL,
  "process_version_id" UUID NOT NULL,
  "process_version" INTEGER NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "type" public."ProcessNodeType" NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "configuration" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "process_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_nodes_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "process_nodes_version_identity_key" UNIQUE (
    "tenant_id", "process_definition_id", "process_version_id", "process_version", "id"
  ),
  CONSTRAINT "process_nodes_version_code_identity_key" UNIQUE (
    "tenant_id", "process_definition_id", "process_version_id",
    "process_version", "id", "code"
  ),
  CONSTRAINT "process_nodes_version_code_key"
    UNIQUE ("tenant_id", "process_version_id", "code")
);

CREATE TABLE public."tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "strategy_id" UUID NOT NULL,
  "strategy_version" INTEGER NOT NULL,
  "objective_id" UUID NOT NULL,
  "objective_version" INTEGER NOT NULL,
  "value_definition_id" UUID NOT NULL,
  "value_version_id" UUID NOT NULL,
  "value_version_number" INTEGER NOT NULL,
  "process_definition_id" UUID NOT NULL,
  "process_definition_code" VARCHAR(100) NOT NULL,
  "process_version_id" UUID NOT NULL,
  "process_version" INTEGER NOT NULL,
  "process_node_id" UUID NOT NULL,
  "process_node_code" VARCHAR(100) NOT NULL,
  "process_instance_id" UUID,
  "title" VARCHAR(300) NOT NULL,
  "description" TEXT NOT NULL,
  "status" public."TaskStatus" NOT NULL DEFAULT 'PLANNED',
  "priority" public."TaskPriority" NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "ready_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "delivered_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tasks_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tasks_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "tasks_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "tasks_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."task_dependencies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "predecessor_task_id" UUID NOT NULL,
  "predecessor_task_version" INTEGER NOT NULL,
  "successor_task_id" UUID NOT NULL,
  "successor_task_version" INTEGER NOT NULL,
  "type" public."TaskDependencyType" NOT NULL,
  "status" public."TaskDependencyStatus" NOT NULL DEFAULT 'ACTIVE',
  "lag_minutes" INTEGER NOT NULL DEFAULT 0,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "removed_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_dependencies_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "task_dependencies_tenant_id_id_version_key"
    UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "task_dependencies_tenant_id_code_version_key"
    UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "task_dependencies_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."deliverables" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "task_id" UUID NOT NULL,
  "task_version" INTEGER NOT NULL,
  "title" VARCHAR(300) NOT NULL,
  "description" TEXT NOT NULL,
  "status" public."DeliverableStatus" NOT NULL DEFAULT 'DRAFT',
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "submitted_at" TIMESTAMPTZ(6),
  "artifact_uri" TEXT,
  "content_hash" VARCHAR(64),
  "evidence_sealed_at" TIMESTAMPTZ(6),
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "deliverables_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deliverables_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "deliverables_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "deliverables_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "deliverables_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."acceptances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "deliverable_id" UUID NOT NULL,
  "deliverable_version" INTEGER NOT NULL,
  "status" public."AcceptanceStatus" NOT NULL DEFAULT 'ACTIVE',
  "decision" public."AcceptanceDecision" NOT NULL,
  "decided_by_user_id" UUID,
  "decided_by_role_assignment_id" UUID,
  "decided_by_role_template_id" UUID,
  "decided_by_org_unit_id" UUID,
  "decided_at" TIMESTAMPTZ(6) NOT NULL,
  "criteria" JSONB NOT NULL,
  "comment" TEXT NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "evidence_sealed_at" TIMESTAMPTZ(6),
  "voided_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptances_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "acceptances_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "acceptances_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "acceptances_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "status" public."EvidenceStatus" NOT NULL DEFAULT 'DRAFT',
  "source_type" public."EvidenceSourceType" NOT NULL,
  "source_system" VARCHAR(100) NOT NULL,
  "source_record_id" VARCHAR(500) NOT NULL,
  "source_version" VARCHAR(200) NOT NULL,
  "source_uri" TEXT,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "content_hash_algorithm" VARCHAR(16) NOT NULL DEFAULT 'SHA256',
  "content_hash" VARCHAR(64) NOT NULL,
  "trust_level" public."EvidenceTrustLevel" NOT NULL,
  "confidence" DECIMAL(12,10) NOT NULL,
  "summary" TEXT NOT NULL,
  "verified_by_user_id" UUID,
  "verified_by_role_assignment_id" UUID,
  "verified_by_role_template_id" UUID,
  "verified_by_org_unit_id" UUID,
  "verified_at" TIMESTAMPTZ(6),
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "activated_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "evidence_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "evidence_tenant_id_code_version_key" UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "evidence_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."metric_observations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "metric_definition_id" UUID NOT NULL,
  "metric_definition_version" INTEGER NOT NULL,
  "subject_type" public."MetricSubjectType" NOT NULL,
  "subject_value_definition_id" UUID,
  "subject_value_version_id" UUID,
  "subject_strategy_id" UUID,
  "subject_objective_id" UUID,
  "subject_task_id" UUID,
  "subject_deliverable_id" UUID,
  "subject_version" INTEGER NOT NULL,
  "value" DECIMAL(30,10) NOT NULL,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "supersedes_observation_id" UUID,
  "supersedes_observation_version" INTEGER,
  "evidence_sealed_at" TIMESTAMPTZ(6),
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "metric_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "metric_observations_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "metric_observations_tenant_id_id_version_key"
    UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "metric_observations_tenant_id_code_version_key"
    UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "metric_observations_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."evidence_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "previous_version_id" UUID,
  "previous_version_number" INTEGER,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "target_type" public."EvidenceTargetType" NOT NULL,
  "target_value_definition_id" UUID,
  "target_value_version_id" UUID,
  "target_strategy_id" UUID,
  "target_objective_id" UUID,
  "target_metric_observation_id" UUID,
  "target_task_id" UUID,
  "target_deliverable_id" UUID,
  "target_acceptance_id" UUID,
  "target_version" INTEGER NOT NULL,
  "status" public."EvidenceLinkStatus" NOT NULL DEFAULT 'ACTIVE',
  "type" public."EvidenceLinkType" NOT NULL,
  "relevance" DECIMAL(12,10) NOT NULL,
  "statement" VARCHAR(500) NOT NULL,
  "owner_user_id" UUID,
  "owner_role_assignment_id" UUID,
  "owner_role_template_id" UUID,
  "owner_org_unit_id" UUID,
  "permission_labels" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "effective_to" TIMESTAMPTZ(6),
  "removed_at" TIMESTAMPTZ(6),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "evidence_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_links_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "evidence_links_tenant_id_id_version_key" UNIQUE ("tenant_id", "id", "version"),
  CONSTRAINT "evidence_links_tenant_id_code_version_key"
    UNIQUE ("tenant_id", "code", "version"),
  CONSTRAINT "evidence_links_tenant_id_idempotency_key_key"
    UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE public."metric_observation_evidence" (
  "tenant_id" UUID NOT NULL,
  "metric_observation_id" UUID NOT NULL,
  "metric_observation_version" INTEGER NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "metric_observation_evidence_pkey" PRIMARY KEY (
    "tenant_id", "metric_observation_id", "metric_observation_version",
    "evidence_id", "evidence_version"
  )
);

CREATE TABLE public."deliverable_evidence" (
  "tenant_id" UUID NOT NULL,
  "deliverable_id" UUID NOT NULL,
  "deliverable_version" INTEGER NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deliverable_evidence_pkey" PRIMARY KEY (
    "tenant_id", "deliverable_id", "deliverable_version",
    "evidence_id", "evidence_version"
  )
);

CREATE TABLE public."acceptance_evidence" (
  "tenant_id" UUID NOT NULL,
  "acceptance_id" UUID NOT NULL,
  "acceptance_version" INTEGER NOT NULL,
  "evidence_id" UUID NOT NULL,
  "evidence_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_evidence_pkey" PRIMARY KEY (
    "tenant_id", "acceptance_id", "acceptance_version",
    "evidence_id", "evidence_version"
  )
);

ALTER TABLE public."agent_runs" ADD COLUMN "task_id" UUID;

-- All public semantic entities use normalized, tenant-scoped codes and CAS
-- revisions. JSON labels remain arrays so authorization can safely inspect
-- them without accepting an arbitrary object shape.
DO $semantic_common_checks$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_metrics', 'value_constraints',
    'strategies', 'objectives', 'objective_relations', 'metric_definitions',
    'process_definitions', 'tasks', 'task_dependencies', 'deliverables',
    'acceptances', 'evidence', 'metric_observations', 'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I '
      'ADD CONSTRAINT %I CHECK (version > 0), '
      'ADD CONSTRAINT %I CHECK (revision > 0), '
      'ADD CONSTRAINT %I CHECK (code ~ ''^[A-Z0-9]+([._:-][A-Z0-9]+)*$'' '
      'AND length(code) BETWEEN 3 AND 100), '
      'ADD CONSTRAINT %I CHECK (jsonb_typeof(permission_labels) = ''array''), '
      'ADD CONSTRAINT %I CHECK (request_hash ~ ''^[0-9a-f]{64}$''), '
      'ADD CONSTRAINT %I CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200 '
      'AND idempotency_key = btrim(idempotency_key))',
      table_name,
      table_name || '_version_positive_check',
      table_name || '_revision_positive_check',
      table_name || '_code_check',
      table_name || '_permission_labels_array_check',
      table_name || '_request_hash_check',
      table_name || '_idempotency_key_check'
    );
  END LOOP;
END
$semantic_common_checks$;

DO $semantic_effective_checks$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_versions', 'strategies', 'objectives',
    'objective_relations', 'metric_definitions', 'process_definitions',
    'process_versions', 'tasks', 'task_dependencies', 'deliverables',
    'evidence', 'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
      'CHECK (effective_to IS NULL OR effective_to > effective_from)',
      table_name,
      table_name || '_effective_period_check'
    );
  END LOOP;
END
$semantic_effective_checks$;

ALTER TABLE public."value_versions"
  ADD CONSTRAINT "value_versions_version_positive_check" CHECK ("version" > 0),
  ADD CONSTRAINT "value_versions_revision_positive_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "value_versions_behavior_arrays_check" CHECK (
    jsonb_typeof("positive_behaviors") = 'array'
    AND jsonb_array_length("positive_behaviors") > 0
    AND jsonb_typeof("negative_behaviors") = 'array'
    AND jsonb_array_length("negative_behaviors") > 0
  ),
  ADD CONSTRAINT "value_versions_permission_labels_array_check"
    CHECK (jsonb_typeof("permission_labels") = 'array'),
  ADD CONSTRAINT "value_versions_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "value_versions_idempotency_key_check" CHECK (
    length(btrim("idempotency_key")) BETWEEN 1 AND 200
    AND "idempotency_key" = btrim("idempotency_key")
  ),
  ADD CONSTRAINT "value_versions_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "value_versions_state_time_check" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "published_at" IS NOT NULL AND "retired_at" IS NOT NULL)
  );

ALTER TABLE public."process_versions"
  ADD CONSTRAINT "process_versions_version_positive_check" CHECK ("version" > 0),
  ADD CONSTRAINT "process_versions_revision_positive_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "process_versions_permission_labels_array_check"
    CHECK (jsonb_typeof("permission_labels") = 'array'),
  ADD CONSTRAINT "process_versions_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "process_versions_idempotency_key_check" CHECK (
    length(btrim("idempotency_key")) BETWEEN 1 AND 200
    AND "idempotency_key" = btrim("idempotency_key")
  ),
  ADD CONSTRAINT "process_versions_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "process_versions_state_time_check" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "published_at" IS NOT NULL AND "retired_at" IS NOT NULL)
  );

ALTER TABLE public."value_metrics"
  ADD CONSTRAINT "value_metrics_weight_check" CHECK ("weight" > 0 AND "weight" <= 1),
  ADD CONSTRAINT "value_metrics_target_shape_check"
    CHECK (jsonb_typeof("target") = 'object');
ALTER TABLE public."value_constraints"
  ADD CONSTRAINT "value_constraints_required_evidence_array_check"
    CHECK (jsonb_typeof("required_evidence_types") = 'array');
ALTER TABLE public."objectives"
  ADD CONSTRAINT "objectives_weight_check" CHECK ("weight" > 0 AND "weight" <= 1),
  ADD CONSTRAINT "objectives_parent_pair_check" CHECK (
    ("parent_objective_id" IS NULL) = ("parent_objective_version" IS NULL)
  ),
  ADD CONSTRAINT "objectives_not_own_parent_check"
    CHECK ("parent_objective_id" IS NULL OR "parent_objective_id" <> "id");
ALTER TABLE public."objective_relations"
  ADD CONSTRAINT "objective_relations_weight_check" CHECK ("weight" > 0 AND "weight" <= 1),
  ADD CONSTRAINT "objective_relations_lag_check"
    CHECK ("lag_days" BETWEEN 0 AND 36500),
  ADD CONSTRAINT "objective_relations_not_self_check"
    CHECK ("source_objective_id" <> "target_objective_id"),
  ADD CONSTRAINT "objective_relations_parent_lag_check"
    CHECK ("type" <> 'PARENT_CHILD' OR "lag_days" = 0);
ALTER TABLE public."metric_definitions"
  ADD CONSTRAINT "metric_definitions_range_check" CHECK (
    (
      "valid_range_minimum" IS NULL
      AND "valid_range_maximum" IS NULL
      AND "direction" <> 'RANGE'
    )
    OR (
      "valid_range_minimum" IS NOT NULL
      AND "valid_range_maximum" IS NOT NULL
      AND "valid_range_maximum" > "valid_range_minimum"
    )
  );
ALTER TABLE public."process_nodes"
  ADD CONSTRAINT "process_nodes_version_positive_check" CHECK ("process_version" > 0),
  ADD CONSTRAINT "process_nodes_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "process_nodes_code_check" CHECK (
    "code" ~ '^[A-Z0-9]+([._:-][A-Z0-9]+)*$'
    AND length("code") BETWEEN 3 AND 100
  ),
  ADD CONSTRAINT "process_nodes_configuration_object_check"
    CHECK (jsonb_typeof("configuration") = 'object');
ALTER TABLE public."tasks"
  ADD CONSTRAINT "tasks_due_period_check" CHECK (
    "due_at" >= "effective_from"
    AND ("effective_to" IS NULL OR "due_at" <= "effective_to")
  ),
  ADD CONSTRAINT "tasks_no_unverified_process_instance_check"
    CHECK ("process_instance_id" IS NULL);
ALTER TABLE public."task_dependencies"
  ADD CONSTRAINT "task_dependencies_not_self_check"
    CHECK ("predecessor_task_id" <> "successor_task_id"),
  ADD CONSTRAINT "task_dependencies_lag_check"
    CHECK ("lag_minutes" BETWEEN -525600 AND 5256000);
ALTER TABLE public."deliverables"
  ADD CONSTRAINT "deliverables_due_period_check" CHECK (
    "due_at" >= "effective_from"
    AND ("effective_to" IS NULL OR "due_at" <= "effective_to")
  ),
  ADD CONSTRAINT "deliverables_submission_shape_check" CHECK (
    (
      "status" = 'DRAFT'
      AND "submitted_at" IS NULL
      AND "artifact_uri" IS NULL
      AND "content_hash" IS NULL
    )
    OR (
      "status" = 'WITHDRAWN'
      AND (
        (
          "submitted_at" IS NULL
          AND "artifact_uri" IS NULL
          AND "content_hash" IS NULL
        )
        OR (
          "submitted_at" IS NOT NULL
          AND "artifact_uri" IS NOT NULL
          AND "content_hash" ~ '^[0-9a-f]{64}$'
        )
      )
    )
    OR (
      "status" IN ('SUBMITTED', 'ACCEPTED', 'REJECTED')
      AND "submitted_at" IS NOT NULL
      AND "artifact_uri" IS NOT NULL
      AND "content_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT "deliverables_submission_period_check" CHECK (
    "submitted_at" IS NULL
    OR (
      "submitted_at" >= "effective_from"
      AND ("effective_to" IS NULL OR "submitted_at" <= "effective_to")
    )
  );
ALTER TABLE public."acceptances"
  ADD CONSTRAINT "acceptances_criteria_array_check"
    CHECK (jsonb_typeof("criteria") = 'array' AND jsonb_array_length("criteria") > 0),
  ADD CONSTRAINT "acceptances_decider_exactly_one_check" CHECK (
    num_nonnulls(
      "decided_by_user_id", "decided_by_role_assignment_id",
      "decided_by_role_template_id", "decided_by_org_unit_id"
    ) = 1
  ),
  ADD CONSTRAINT "acceptances_void_state_check" CHECK (
    ("status" = 'ACTIVE' AND "voided_at" IS NULL)
    OR ("status" = 'VOID' AND "voided_at" IS NOT NULL)
  );
ALTER TABLE public."evidence"
  ADD CONSTRAINT "evidence_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "evidence_hash_check" CHECK (
    "content_hash_algorithm" = 'SHA256'
    AND "content_hash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "evidence_observed_period_check" CHECK (
    "observed_at" >= "effective_from"
    AND ("effective_to" IS NULL OR "observed_at" <= "effective_to")
  ),
  ADD CONSTRAINT "evidence_verifier_check" CHECK (
    (
      "verified_at" IS NULL
      AND num_nonnulls(
        "verified_by_user_id", "verified_by_role_assignment_id",
        "verified_by_role_template_id", "verified_by_org_unit_id"
      ) = 0
      AND "trust_level" <> 'VERIFIED'
    )
    OR (
      "verified_at" IS NOT NULL
      AND "verified_at" >= "observed_at"
      AND num_nonnulls(
        "verified_by_user_id", "verified_by_role_assignment_id",
        "verified_by_role_template_id", "verified_by_org_unit_id"
      ) = 1
    )
  );
ALTER TABLE public."metric_observations"
  ADD CONSTRAINT "metric_observations_period_check" CHECK (
    "period_end" > "period_start" AND "observed_at" >= "period_end"
  ),
  ADD CONSTRAINT "metric_observations_supersedes_pair_check" CHECK (
    ("supersedes_observation_id" IS NULL) =
    ("supersedes_observation_version" IS NULL)
  ),
  ADD CONSTRAINT "metric_observations_subject_exactly_one_check" CHECK (
    (
      "subject_type" = 'VALUE_VERSION'
      AND "subject_value_definition_id" IS NOT NULL
      AND "subject_value_version_id" IS NOT NULL
      AND num_nonnulls(
        "subject_strategy_id", "subject_objective_id",
        "subject_task_id", "subject_deliverable_id"
      ) = 0
    )
    OR (
      "subject_type" = 'STRATEGY'
      AND "subject_strategy_id" IS NOT NULL
      AND num_nonnulls(
        "subject_value_definition_id", "subject_value_version_id",
        "subject_objective_id", "subject_task_id", "subject_deliverable_id"
      ) = 0
    )
    OR (
      "subject_type" = 'OBJECTIVE'
      AND "subject_objective_id" IS NOT NULL
      AND num_nonnulls(
        "subject_value_definition_id", "subject_value_version_id",
        "subject_strategy_id", "subject_task_id", "subject_deliverable_id"
      ) = 0
    )
    OR (
      "subject_type" = 'TASK'
      AND "subject_task_id" IS NOT NULL
      AND num_nonnulls(
        "subject_value_definition_id", "subject_value_version_id",
        "subject_strategy_id", "subject_objective_id", "subject_deliverable_id"
      ) = 0
    )
    OR (
      "subject_type" = 'DELIVERABLE'
      AND "subject_deliverable_id" IS NOT NULL
      AND num_nonnulls(
        "subject_value_definition_id", "subject_value_version_id",
        "subject_strategy_id", "subject_objective_id", "subject_task_id"
      ) = 0
    )
  );
ALTER TABLE public."evidence_links"
  ADD CONSTRAINT "evidence_links_relevance_check"
    CHECK ("relevance" > 0 AND "relevance" <= 1),
  ADD CONSTRAINT "evidence_links_target_exactly_one_check" CHECK (
    (
      "target_type" = 'VALUE_VERSION'
      AND "target_value_definition_id" IS NOT NULL
      AND "target_value_version_id" IS NOT NULL
      AND num_nonnulls(
        "target_strategy_id", "target_objective_id",
        "target_metric_observation_id", "target_task_id",
        "target_deliverable_id", "target_acceptance_id"
      ) = 0
    )
    OR (
      "target_type" = 'STRATEGY'
      AND "target_strategy_id" IS NOT NULL
      AND num_nonnulls(
        "target_value_definition_id", "target_value_version_id",
        "target_objective_id", "target_metric_observation_id",
        "target_task_id", "target_deliverable_id", "target_acceptance_id"
      ) = 0
    )
    OR (
      "target_type" = 'OBJECTIVE'
      AND "target_objective_id" IS NOT NULL
      AND num_nonnulls(
        "target_value_definition_id", "target_value_version_id",
        "target_strategy_id", "target_metric_observation_id",
        "target_task_id", "target_deliverable_id", "target_acceptance_id"
      ) = 0
    )
    OR (
      "target_type" = 'METRIC_OBSERVATION'
      AND "target_metric_observation_id" IS NOT NULL
      AND num_nonnulls(
        "target_value_definition_id", "target_value_version_id",
        "target_strategy_id", "target_objective_id",
        "target_task_id", "target_deliverable_id", "target_acceptance_id"
      ) = 0
    )
    OR (
      "target_type" = 'TASK'
      AND "target_task_id" IS NOT NULL
      AND num_nonnulls(
        "target_value_definition_id", "target_value_version_id",
        "target_strategy_id", "target_objective_id",
        "target_metric_observation_id", "target_deliverable_id",
        "target_acceptance_id"
      ) = 0
    )
    OR (
      "target_type" = 'DELIVERABLE'
      AND "target_deliverable_id" IS NOT NULL
      AND num_nonnulls(
        "target_value_definition_id", "target_value_version_id",
        "target_strategy_id", "target_objective_id",
        "target_metric_observation_id", "target_task_id",
        "target_acceptance_id"
      ) = 0
    )
    OR (
      "target_type" = 'ACCEPTANCE'
      AND "target_acceptance_id" IS NOT NULL
      AND num_nonnulls(
        "target_value_definition_id", "target_value_version_id",
        "target_strategy_id", "target_objective_id",
        "target_metric_observation_id", "target_task_id",
        "target_deliverable_id"
      ) = 0
    )
  );

-- Every business owner is a verified, tenant-scoped foreign key. The CHECK
-- deliberately replaces an unverified (owner_type, owner_id) polymorphic pair.
DO $semantic_owner_constraints$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_versions', 'value_metrics', 'value_constraints',
    'strategies', 'objectives', 'objective_relations', 'metric_definitions',
    'process_definitions', 'process_versions', 'tasks', 'task_dependencies',
    'deliverables', 'acceptances', 'evidence', 'metric_observations',
    'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I '
      'ADD CONSTRAINT %I CHECK (num_nonnulls('
      'owner_user_id, owner_role_assignment_id, owner_role_template_id, owner_org_unit_id'
      ') = 1), '
      'ADD CONSTRAINT %I FOREIGN KEY (tenant_id, owner_user_id) '
      'REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE, '
      'ADD CONSTRAINT %I FOREIGN KEY (tenant_id, owner_role_assignment_id) '
      'REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE, '
      'ADD CONSTRAINT %I FOREIGN KEY (tenant_id, owner_role_template_id) '
      'REFERENCES public.agent_templates(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE, '
      'ADD CONSTRAINT %I FOREIGN KEY (tenant_id, owner_org_unit_id) '
      'REFERENCES public.org_units(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE',
      table_name,
      table_name || '_owner_exactly_one_check',
      table_name || '_owner_user_fkey',
      table_name || '_owner_role_assignment_fkey',
      table_name || '_owner_role_template_fkey',
      table_name || '_owner_org_unit_fkey'
    );
  END LOOP;
END
$semantic_owner_constraints$;

DO $semantic_tenant_constraints$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_versions', 'value_metrics', 'value_constraints',
    'strategies', 'strategy_value_versions', 'objectives',
    'objective_value_versions', 'objective_role_assignments',
    'objective_relations', 'metric_definitions', 'objective_metric_definitions',
    'process_definitions', 'process_versions', 'process_nodes', 'tasks',
    'task_dependencies', 'deliverables', 'acceptances', 'evidence',
    'metric_observations', 'evidence_links', 'metric_observation_evidence',
    'deliverable_evidence', 'acceptance_evidence'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
      'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) '
      'ON DELETE RESTRICT ON UPDATE CASCADE',
      table_name,
      table_name || '_tenant_id_fkey'
    );
  END LOOP;
END
$semantic_tenant_constraints$;

ALTER TABLE public."acceptances"
  ADD CONSTRAINT "acceptances_decided_by_user_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptances_decided_by_role_assignment_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptances_decided_by_role_template_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_role_template_id")
    REFERENCES public."agent_templates"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptances_decided_by_org_unit_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_org_unit_id")
    REFERENCES public."org_units"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."evidence"
  ADD CONSTRAINT "evidence_verified_by_user_fkey"
    FOREIGN KEY ("tenant_id", "verified_by_user_id")
    REFERENCES public."users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_verified_by_role_assignment_fkey"
    FOREIGN KEY ("tenant_id", "verified_by_role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_verified_by_role_template_fkey"
    FOREIGN KEY ("tenant_id", "verified_by_role_template_id")
    REFERENCES public."agent_templates"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_verified_by_org_unit_fkey"
    FOREIGN KEY ("tenant_id", "verified_by_org_unit_id")
    REFERENCES public."org_units"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."value_versions"
  ADD CONSTRAINT "value_versions_definition_fkey"
    FOREIGN KEY ("tenant_id", "value_definition_id")
    REFERENCES public."value_definitions"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "value_versions_previous_fkey"
    FOREIGN KEY (
      "tenant_id", "value_definition_id",
      "previous_version_id", "previous_version_number"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."value_definitions"
  ADD CONSTRAINT "value_definitions_current_version_pair_check" CHECK (
    ("current_version_id" IS NULL) = ("current_version_number" IS NULL)
  ),
  ADD CONSTRAINT "value_definitions_current_version_fkey"
    FOREIGN KEY (
      "tenant_id", "id", "current_version_id", "current_version_number"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."value_metrics"
  ADD CONSTRAINT "value_metrics_value_version_fkey"
    FOREIGN KEY (
      "tenant_id", "value_definition_id", "value_version_id", "value_version_number"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "value_metrics_metric_definition_fkey"
    FOREIGN KEY (
      "tenant_id", "metric_definition_id", "metric_definition_version"
    )
    REFERENCES public."metric_definitions"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."value_constraints"
  ADD CONSTRAINT "value_constraints_value_version_fkey"
    FOREIGN KEY (
      "tenant_id", "value_definition_id", "value_version_id", "value_version_number"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."strategies"
  ADD CONSTRAINT "strategies_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "strategies_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."strategies"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "strategies_budget_pair_check" CHECK (
    ("budget_amount" IS NULL) = ("budget_currency" IS NULL)
    AND ("budget_amount" IS NULL OR "budget_amount" >= 0)
  );

ALTER TABLE public."strategy_value_versions"
  ADD CONSTRAINT "strategy_value_versions_strategy_fkey"
    FOREIGN KEY ("tenant_id", "strategy_id", "strategy_version")
    REFERENCES public."strategies"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "strategy_value_versions_value_fkey"
    FOREIGN KEY (
      "tenant_id", "value_definition_id", "value_version_id", "value_version_number"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."objectives"
  ADD CONSTRAINT "objectives_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "objectives_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objectives_strategy_fkey"
    FOREIGN KEY ("tenant_id", "strategy_id", "strategy_version")
    REFERENCES public."strategies"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objectives_parent_fkey"
    FOREIGN KEY (
      "tenant_id", "parent_objective_id", "parent_objective_version",
      "strategy_id", "strategy_version"
    )
    REFERENCES public."objectives"(
      "tenant_id", "id", "version", "strategy_id", "strategy_version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."objective_value_versions"
  ADD CONSTRAINT "objective_value_versions_objective_fkey"
    FOREIGN KEY (
      "tenant_id", "objective_id", "objective_version",
      "strategy_id", "strategy_version"
    )
    REFERENCES public."objectives"(
      "tenant_id", "id", "version", "strategy_id", "strategy_version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objective_value_versions_strategy_value_fkey"
    FOREIGN KEY (
      "tenant_id", "strategy_id", "strategy_version",
      "value_definition_id", "value_version_id", "value_version_number"
    )
    REFERENCES public."strategy_value_versions"(
      "tenant_id", "strategy_id", "strategy_version",
      "value_definition_id", "value_version_id", "value_version_number"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."objective_role_assignments"
  ADD CONSTRAINT "objective_role_assignments_objective_fkey"
    FOREIGN KEY ("tenant_id", "objective_id", "objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objective_role_assignments_assignment_fkey"
    FOREIGN KEY ("tenant_id", "role_assignment_id")
    REFERENCES public."role_assignments"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."objective_relations"
  ADD CONSTRAINT "objective_relations_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "objective_relations_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."objective_relations"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objective_relations_source_fkey"
    FOREIGN KEY ("tenant_id", "source_objective_id", "source_objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objective_relations_target_fkey"
    FOREIGN KEY ("tenant_id", "target_objective_id", "target_objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."metric_definitions"
  ADD CONSTRAINT "metric_definitions_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "metric_definitions_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."metric_definitions"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."objective_metric_definitions"
  ADD CONSTRAINT "objective_metric_definitions_objective_fkey"
    FOREIGN KEY ("tenant_id", "objective_id", "objective_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "objective_metric_definitions_metric_fkey"
    FOREIGN KEY ("tenant_id", "metric_definition_id", "metric_definition_version")
    REFERENCES public."metric_definitions"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."process_versions"
  ADD CONSTRAINT "process_versions_definition_fkey"
    FOREIGN KEY ("tenant_id", "process_definition_id")
    REFERENCES public."process_definitions"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "process_versions_previous_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id",
      "previous_version_id", "previous_version_number"
    )
    REFERENCES public."process_versions"(
      "tenant_id", "process_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."process_definitions"
  ADD CONSTRAINT "process_definitions_current_version_pair_check" CHECK (
    ("current_version_id" IS NULL) = ("current_version_number" IS NULL)
  ),
  ADD CONSTRAINT "process_definitions_current_version_fkey"
    FOREIGN KEY (
      "tenant_id", "id", "current_version_id", "current_version_number"
    )
    REFERENCES public."process_versions"(
      "tenant_id", "process_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."process_nodes"
  ADD CONSTRAINT "process_nodes_version_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id",
      "process_version_id", "process_version"
    )
    REFERENCES public."process_versions"(
      "tenant_id", "process_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."tasks"
  ADD CONSTRAINT "tasks_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "tasks_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_objective_value_fkey"
    FOREIGN KEY (
      "tenant_id", "objective_id", "objective_version",
      "strategy_id", "strategy_version", "value_definition_id",
      "value_version_id", "value_version_number"
    )
    REFERENCES public."objective_value_versions"(
      "tenant_id", "objective_id", "objective_version",
      "strategy_id", "strategy_version", "value_definition_id",
      "value_version_id", "value_version_number"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_process_definition_fkey"
    FOREIGN KEY ("tenant_id", "process_definition_id", "process_definition_code")
    REFERENCES public."process_definitions"("tenant_id", "id", "code")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_process_version_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id",
      "process_version_id", "process_version"
    )
    REFERENCES public."process_versions"(
      "tenant_id", "process_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_process_node_fkey"
    FOREIGN KEY (
      "tenant_id", "process_definition_id", "process_version_id",
      "process_version", "process_node_id", "process_node_code"
    )
    REFERENCES public."process_nodes"(
      "tenant_id", "process_definition_id", "process_version_id",
      "process_version", "id", "code"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."task_dependencies"
  ADD CONSTRAINT "task_dependencies_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "task_dependencies_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."task_dependencies"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_dependencies_predecessor_fkey"
    FOREIGN KEY ("tenant_id", "predecessor_task_id", "predecessor_task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_dependencies_successor_fkey"
    FOREIGN KEY ("tenant_id", "successor_task_id", "successor_task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."deliverables"
  ADD CONSTRAINT "deliverables_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "deliverables_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."deliverables"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "deliverables_task_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "task_version")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."acceptances"
  ADD CONSTRAINT "acceptances_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "acceptances_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."acceptances"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptances_deliverable_fkey"
    FOREIGN KEY ("tenant_id", "deliverable_id", "deliverable_version")
    REFERENCES public."deliverables"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."evidence"
  ADD CONSTRAINT "evidence_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "evidence_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."evidence"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."metric_observations"
  ADD CONSTRAINT "metric_observations_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "metric_observations_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."metric_observations"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_metric_fkey"
    FOREIGN KEY ("tenant_id", "metric_definition_id", "metric_definition_version")
    REFERENCES public."metric_definitions"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_value_subject_fkey"
    FOREIGN KEY (
      "tenant_id", "subject_value_definition_id",
      "subject_value_version_id", "subject_version"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_strategy_subject_fkey"
    FOREIGN KEY ("tenant_id", "subject_strategy_id", "subject_version")
    REFERENCES public."strategies"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_objective_subject_fkey"
    FOREIGN KEY ("tenant_id", "subject_objective_id", "subject_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_task_subject_fkey"
    FOREIGN KEY ("tenant_id", "subject_task_id", "subject_version")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_deliverable_subject_fkey"
    FOREIGN KEY ("tenant_id", "subject_deliverable_id", "subject_version")
    REFERENCES public."deliverables"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observations_supersedes_fkey"
    FOREIGN KEY (
      "tenant_id", "supersedes_observation_id", "supersedes_observation_version"
    )
    REFERENCES public."metric_observations"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."evidence_links"
  ADD CONSTRAINT "evidence_links_lineage_pair_check" CHECK (
    ("previous_version_id" IS NULL) = ("previous_version_number" IS NULL)
  ),
  ADD CONSTRAINT "evidence_links_previous_fkey"
    FOREIGN KEY ("tenant_id", "previous_version_id", "previous_version_number")
    REFERENCES public."evidence_links"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_value_target_fkey"
    FOREIGN KEY (
      "tenant_id", "target_value_definition_id",
      "target_value_version_id", "target_version"
    )
    REFERENCES public."value_versions"(
      "tenant_id", "value_definition_id", "id", "version"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_strategy_target_fkey"
    FOREIGN KEY ("tenant_id", "target_strategy_id", "target_version")
    REFERENCES public."strategies"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_objective_target_fkey"
    FOREIGN KEY ("tenant_id", "target_objective_id", "target_version")
    REFERENCES public."objectives"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_metric_observation_target_fkey"
    FOREIGN KEY ("tenant_id", "target_metric_observation_id", "target_version")
    REFERENCES public."metric_observations"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_task_target_fkey"
    FOREIGN KEY ("tenant_id", "target_task_id", "target_version")
    REFERENCES public."tasks"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_deliverable_target_fkey"
    FOREIGN KEY ("tenant_id", "target_deliverable_id", "target_version")
    REFERENCES public."deliverables"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "evidence_links_acceptance_target_fkey"
    FOREIGN KEY ("tenant_id", "target_acceptance_id", "target_version")
    REFERENCES public."acceptances"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."metric_observation_evidence"
  ADD CONSTRAINT "metric_observation_evidence_observation_fkey"
    FOREIGN KEY (
      "tenant_id", "metric_observation_id", "metric_observation_version"
    )
    REFERENCES public."metric_observations"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "metric_observation_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."deliverable_evidence"
  ADD CONSTRAINT "deliverable_evidence_deliverable_fkey"
    FOREIGN KEY ("tenant_id", "deliverable_id", "deliverable_version")
    REFERENCES public."deliverables"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "deliverable_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."acceptance_evidence"
  ADD CONSTRAINT "acceptance_evidence_acceptance_fkey"
    FOREIGN KEY ("tenant_id", "acceptance_id", "acceptance_version")
    REFERENCES public."acceptances"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_evidence_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_id", "evidence_version")
    REFERENCES public."evidence"("tenant_id", "id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."agent_runs"
  ADD CONSTRAINT "agent_runs_tenant_task_id_fkey"
    FOREIGN KEY ("tenant_id", "task_id")
    REFERENCES public."tasks"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."strategies"
  ADD CONSTRAINT "strategies_state_time_check" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "closed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "closed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'CLOSED' AND "activated_at" IS NOT NULL AND "closed_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "closed_at" IS NULL AND "cancelled_at" IS NOT NULL)
  );
ALTER TABLE public."objectives"
  ADD CONSTRAINT "objectives_state_time_check" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "achieved_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" IN ('ACTIVE', 'AT_RISK') AND "activated_at" IS NOT NULL AND "achieved_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'ACHIEVED' AND "activated_at" IS NOT NULL AND "achieved_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "achieved_at" IS NULL AND "cancelled_at" IS NOT NULL)
  );
ALTER TABLE public."objective_relations"
  ADD CONSTRAINT "objective_relations_state_time_check" CHECK (
    ("status" = 'ACTIVE' AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "retired_at" IS NOT NULL)
  );
ALTER TABLE public."metric_definitions"
  ADD CONSTRAINT "metric_definitions_state_time_check" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "activated_at" IS NOT NULL AND "retired_at" IS NOT NULL)
  );
ALTER TABLE public."task_dependencies"
  ADD CONSTRAINT "task_dependencies_state_time_check" CHECK (
    ("status" = 'ACTIVE' AND "removed_at" IS NULL)
    OR ("status" = 'REMOVED' AND "removed_at" IS NOT NULL)
  );
ALTER TABLE public."evidence"
  ADD CONSTRAINT "evidence_state_time_check" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "revoked_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("status" = 'REVOKED' AND "activated_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
  );
ALTER TABLE public."evidence_links"
  ADD CONSTRAINT "evidence_links_state_time_check" CHECK (
    ("status" = 'ACTIVE' AND "removed_at" IS NULL)
    OR ("status" = 'REMOVED' AND "removed_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "value_versions_one_published_per_definition_idx"
  ON public."value_versions"("tenant_id", "value_definition_id")
  WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "process_versions_one_published_per_definition_idx"
  ON public."process_versions"("tenant_id", "process_definition_id")
  WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "strategies_one_active_per_code_idx"
  ON public."strategies"("tenant_id", "code")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "objectives_one_current_per_code_idx"
  ON public."objectives"("tenant_id", "code")
  WHERE "status" IN ('ACTIVE', 'AT_RISK');
CREATE UNIQUE INDEX "objective_relations_one_active_per_code_idx"
  ON public."objective_relations"("tenant_id", "code")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "metric_definitions_one_active_per_code_idx"
  ON public."metric_definitions"("tenant_id", "code")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "tasks_one_current_per_code_idx"
  ON public."tasks"("tenant_id", "code")
  WHERE "status" IN ('PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED');
CREATE UNIQUE INDEX "deliverables_one_current_per_code_idx"
  ON public."deliverables"("tenant_id", "code")
  WHERE "status" IN ('DRAFT', 'SUBMITTED', 'REJECTED');
CREATE UNIQUE INDEX "acceptances_one_active_per_code_idx"
  ON public."acceptances"("tenant_id", "code")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "evidence_one_active_per_code_idx"
  ON public."evidence"("tenant_id", "code")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "evidence_links_one_active_per_code_idx"
  ON public."evidence_links"("tenant_id", "code")
  WHERE "status" = 'ACTIVE';

ALTER TABLE public."value_versions"
  ADD CONSTRAINT "value_versions_no_overlapping_published_period"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "value_definition_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" = 'PUBLISHED');
ALTER TABLE public."process_versions"
  ADD CONSTRAINT "process_versions_no_overlapping_published_period"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "process_definition_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" = 'PUBLISHED');
ALTER TABLE public."strategies"
  ADD CONSTRAINT "strategies_no_overlapping_active_period"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "code" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE');
ALTER TABLE public."objectives"
  ADD CONSTRAINT "objectives_no_overlapping_current_period"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "code" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" IN ('ACTIVE', 'AT_RISK'));
ALTER TABLE public."metric_definitions"
  ADD CONSTRAINT "metric_definitions_no_overlapping_active_period"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "code" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE');

CREATE INDEX "value_definitions_type_effective_idx"
  ON public."value_definitions"("tenant_id", "type", "effective_from", "effective_to");
CREATE INDEX "value_versions_definition_status_effective_idx"
  ON public."value_versions"("tenant_id", "value_definition_id", "status", "effective_from", "effective_to");
CREATE INDEX "value_metrics_metric_definition_idx"
  ON public."value_metrics"("tenant_id", "metric_definition_id", "metric_definition_version");
CREATE INDEX "strategy_value_versions_value_idx"
  ON public."strategy_value_versions"("tenant_id", "value_definition_id", "value_version_id", "value_version_number");
CREATE INDEX "objectives_strategy_status_idx"
  ON public."objectives"("tenant_id", "strategy_id", "strategy_version", "status");
CREATE INDEX "objectives_parent_idx"
  ON public."objectives"("tenant_id", "parent_objective_id", "parent_objective_version");
CREATE INDEX "objective_relations_source_idx"
  ON public."objective_relations"("tenant_id", "source_objective_id", "source_objective_version", "status");
CREATE INDEX "objective_relations_target_idx"
  ON public."objective_relations"("tenant_id", "target_objective_id", "target_objective_version", "status");
CREATE INDEX "objective_role_assignments_assignment_idx"
  ON public."objective_role_assignments"("tenant_id", "role_assignment_id");
CREATE INDEX "objective_metric_definitions_metric_idx"
  ON public."objective_metric_definitions"("tenant_id", "metric_definition_id", "metric_definition_version");
CREATE INDEX "process_nodes_definition_version_ordinal_idx"
  ON public."process_nodes"("tenant_id", "process_definition_id", "process_version", "ordinal");
CREATE INDEX "tasks_objective_status_due_idx"
  ON public."tasks"("tenant_id", "objective_id", "objective_version", "status", "due_at");
CREATE INDEX "tasks_owner_user_status_due_idx"
  ON public."tasks"("tenant_id", "owner_user_id", "status", "due_at");
CREATE INDEX "tasks_owner_assignment_status_due_idx"
  ON public."tasks"("tenant_id", "owner_role_assignment_id", "status", "due_at");
CREATE INDEX "tasks_process_idx"
  ON public."tasks"("tenant_id", "process_definition_id", "process_version_id", "process_node_id");
CREATE INDEX "task_dependencies_predecessor_idx"
  ON public."task_dependencies"("tenant_id", "predecessor_task_id", "predecessor_task_version", "status");
CREATE INDEX "task_dependencies_successor_idx"
  ON public."task_dependencies"("tenant_id", "successor_task_id", "successor_task_version", "status");
CREATE INDEX "deliverables_task_status_idx"
  ON public."deliverables"("tenant_id", "task_id", "task_version", "status");
CREATE INDEX "acceptances_deliverable_status_idx"
  ON public."acceptances"("tenant_id", "deliverable_id", "deliverable_version", "status");
CREATE INDEX "evidence_source_idx"
  ON public."evidence"("tenant_id", "source_system", "source_record_id", "source_version");
CREATE INDEX "metric_observations_metric_time_idx"
  ON public."metric_observations"("tenant_id", "metric_definition_id", "metric_definition_version", "observed_at");
CREATE INDEX "evidence_links_evidence_status_idx"
  ON public."evidence_links"("tenant_id", "evidence_id", "evidence_version", "status");
CREATE INDEX "agent_runs_tenant_task_id_idx"
  ON public."agent_runs"("tenant_id", "task_id");

CREATE OR REPLACE FUNCTION public.validate_business_version_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_code text;
BEGIN
  IF NEW."previous_version_id" IS NULL THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'The first business version must be version 1.'
        USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_lineage_check';
    END IF;
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT code FROM public.%I WHERE tenant_id = $1 AND id = $2 AND version = $3',
    TG_TABLE_NAME
  )
  INTO previous_code
  USING NEW."tenant_id", NEW."previous_version_id", NEW."previous_version_number";

  IF previous_code IS NULL
    OR previous_code <> NEW."code"
    OR NEW."version" <> NEW."previous_version_number" + 1
  THEN
    RAISE EXCEPTION 'Business version lineage must preserve code and increment by one.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_lineage_check';
  END IF;
  RETURN NEW;
END
$function$;

DO $semantic_lineage_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'strategies', 'objectives', 'objective_relations', 'metric_definitions',
    'tasks', 'task_dependencies', 'deliverables', 'acceptances', 'evidence',
    'metric_observations', 'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.validate_business_version_lineage()',
      table_name || '_lineage_trigger',
      table_name
    );
  END LOOP;
END
$semantic_lineage_triggers$;

CREATE OR REPLACE FUNCTION public.validate_definition_version_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_definition_id uuid;
BEGIN
  IF NEW."previous_version_id" IS NULL THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'The first definition version must be version 1.'
        USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_lineage_check';
    END IF;
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT %I FROM public.%I WHERE tenant_id = $1 AND id = $2 AND version = $3',
    TG_ARGV[0], TG_TABLE_NAME
  )
  INTO previous_definition_id
  USING NEW."tenant_id", NEW."previous_version_id", NEW."previous_version_number";

  IF previous_definition_id IS NULL
    OR previous_definition_id <> (to_jsonb(NEW)->>TG_ARGV[0])::uuid
    OR NEW."version" <> NEW."previous_version_number" + 1
  THEN
    RAISE EXCEPTION 'Definition version lineage must stay in one definition and increment by one.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_lineage_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "value_versions_lineage_trigger"
  BEFORE INSERT ON public."value_versions"
  FOR EACH ROW EXECUTE FUNCTION public.validate_definition_version_lineage('value_definition_id');
CREATE TRIGGER "process_versions_lineage_trigger"
  BEFORE INSERT ON public."process_versions"
  FOR EACH ROW EXECUTE FUNCTION public.validate_definition_version_lineage('process_definition_id');

CREATE OR REPLACE FUNCTION public.validate_objective_relation_semantics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_record record;
  target_record record;
BEGIN
  SELECT "strategy_id", "strategy_version", "indicator_type", "status",
         "effective_from", "effective_to"
  INTO source_record
  FROM public."objectives"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."source_objective_id"
    AND "version" = NEW."source_objective_version";

  SELECT "strategy_id", "strategy_version", "indicator_type", "status",
         "parent_objective_id", "parent_objective_version",
         "effective_from", "effective_to"
  INTO target_record
  FROM public."objectives"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."target_objective_id"
    AND "version" = NEW."target_objective_version";

  IF source_record IS NULL OR target_record IS NULL
    OR source_record."strategy_id" <> target_record."strategy_id"
    OR source_record."strategy_version" <> target_record."strategy_version"
  THEN
    RAISE EXCEPTION 'Objective relations must connect verified versions in one Strategy.'
      USING ERRCODE = '23514', CONSTRAINT = 'objective_relations_strategy_check';
  END IF;
  IF NEW."status" = 'ACTIVE'
    AND (
      source_record."status" NOT IN ('ACTIVE', 'AT_RISK')
      OR target_record."status" NOT IN ('ACTIVE', 'AT_RISK')
    )
  THEN
    RAISE EXCEPTION 'Active Objective relations require active Objective versions.'
      USING ERRCODE = '23514', CONSTRAINT = 'objective_relations_active_objectives_check';
  END IF;
  IF NEW."type" = 'CAUSES'
    AND (
      source_record."indicator_type" <> 'LEADING'
      OR target_record."indicator_type" <> 'LAGGING'
    )
  THEN
    RAISE EXCEPTION 'CAUSES must run from a leading to a lagging Objective.'
      USING ERRCODE = '23514', CONSTRAINT = 'objective_relations_causes_direction_check';
  END IF;
  IF NEW."type" = 'PARENT_CHILD'
    AND (
      target_record."parent_objective_id" IS DISTINCT FROM NEW."source_objective_id"
      OR target_record."parent_objective_version" IS DISTINCT FROM NEW."source_objective_version"
    )
  THEN
    RAISE EXCEPTION 'PARENT_CHILD must match the child Objective parent reference.'
      USING ERRCODE = '23514', CONSTRAINT = 'objective_relations_parent_direction_check';
  END IF;
  IF NEW."effective_from" < source_record."effective_from"
    OR NEW."effective_from" < target_record."effective_from"
    OR (
      source_record."effective_to" IS NOT NULL
      AND (
        NEW."effective_to" IS NULL
        OR NEW."effective_to" > source_record."effective_to"
      )
    )
    OR (
      target_record."effective_to" IS NOT NULL
      AND (
        NEW."effective_to" IS NULL
        OR NEW."effective_to" > target_record."effective_to"
      )
    )
  THEN
    RAISE EXCEPTION 'Objective relation effective period must fit both endpoints.'
      USING ERRCODE = '23514', CONSTRAINT = 'objective_relations_effective_period_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "objective_relations_semantics_trigger"
  BEFORE INSERT OR UPDATE OF
    "source_objective_id", "source_objective_version",
    "target_objective_id", "target_objective_version", "type", "status"
  ON public."objective_relations"
  FOR EACH ROW EXECUTE FUNCTION public.validate_objective_relation_semantics();

CREATE OR REPLACE FUNCTION public.validate_semantic_publication_completeness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  child_count integer;
  secondary_child_count integer;
  total_weight numeric;
BEGIN
  IF TG_TABLE_NAME = 'value_versions'
    AND NEW."status"::text = 'PUBLISHED'
    AND (TG_OP = 'INSERT' OR OLD."status"::text <> 'PUBLISHED')
  THEN
    SELECT count(*), COALESCE(sum("weight"), 0)
    INTO child_count, total_weight
    FROM public."value_metrics"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "value_definition_id" = NEW."value_definition_id"
      AND "value_version_id" = NEW."id"
      AND "value_version_number" = NEW."version";
    IF child_count = 0 OR abs(total_weight - 1) > 0.000000001 THEN
      RAISE EXCEPTION 'A published Value Version requires metrics whose weights total 1.'
        USING ERRCODE = '23514', CONSTRAINT = 'value_versions_publish_metrics_check';
    END IF;
  ELSIF TG_TABLE_NAME = 'strategies'
    AND NEW."status"::text = 'ACTIVE'
    AND (TG_OP = 'INSERT' OR OLD."status"::text <> 'ACTIVE')
  THEN
    SELECT
      count(*),
      count(*) FILTER (
        WHERE value_version."status" = 'PUBLISHED'
          AND value_version."effective_from" <= NEW."effective_from"
          AND (
            value_version."effective_to" IS NULL
            OR (
              NEW."effective_to" IS NOT NULL
              AND value_version."effective_to" >= NEW."effective_to"
            )
          )
      )
    INTO child_count, secondary_child_count
    FROM public."strategy_value_versions" AS link
    JOIN public."value_versions" AS value_version
      ON value_version."tenant_id" = link."tenant_id"
     AND value_version."value_definition_id" = link."value_definition_id"
     AND value_version."id" = link."value_version_id"
     AND value_version."version" = link."value_version_number"
    WHERE link."tenant_id" = NEW."tenant_id"
      AND link."strategy_id" = NEW."id"
      AND link."strategy_version" = NEW."version";
    IF child_count = 0 OR child_count <> secondary_child_count THEN
      RAISE EXCEPTION 'An active Strategy requires at least one published Value Version.'
        USING ERRCODE = '23514', CONSTRAINT = 'strategies_active_values_check';
    END IF;
  ELSIF TG_TABLE_NAME = 'objectives'
    AND NEW."status"::text IN ('ACTIVE', 'AT_RISK')
    AND (TG_OP = 'INSERT' OR OLD."status"::text = 'DRAFT')
  THEN
    SELECT count(*) INTO child_count
    FROM public."strategies" AS strategy
    WHERE strategy."tenant_id" = NEW."tenant_id"
      AND strategy."id" = NEW."strategy_id"
      AND strategy."version" = NEW."strategy_version"
      AND strategy."status" = 'ACTIVE'
      AND strategy."effective_from" <= NEW."effective_from"
      AND (
        strategy."effective_to" IS NULL
        OR (
          NEW."effective_to" IS NOT NULL
          AND strategy."effective_to" >= NEW."effective_to"
        )
      );
    IF child_count <> 1 THEN
      RAISE EXCEPTION 'An active Objective requires an active, period-containing Strategy.'
        USING ERRCODE = '23514', CONSTRAINT = 'objectives_active_strategy_check';
    END IF;
    SELECT
      count(*),
      count(*) FILTER (
        WHERE value_version."status" = 'PUBLISHED'
          AND value_version."effective_from" <= NEW."effective_from"
          AND (
            value_version."effective_to" IS NULL
            OR (
              NEW."effective_to" IS NOT NULL
              AND value_version."effective_to" >= NEW."effective_to"
            )
          )
      )
    INTO child_count, secondary_child_count
    FROM public."objective_value_versions" AS link
    JOIN public."value_versions" AS value_version
      ON value_version."tenant_id" = link."tenant_id"
     AND value_version."value_definition_id" = link."value_definition_id"
     AND value_version."id" = link."value_version_id"
     AND value_version."version" = link."value_version_number"
    WHERE link."tenant_id" = NEW."tenant_id"
      AND link."objective_id" = NEW."id"
      AND link."objective_version" = NEW."version";
    IF child_count = 0 OR child_count <> secondary_child_count THEN
      RAISE EXCEPTION 'An active Objective requires at least one Strategy Value relation.'
        USING ERRCODE = '23514', CONSTRAINT = 'objectives_active_values_check';
    END IF;
    SELECT
      count(*),
      count(*) FILTER (
        WHERE definition."status" = 'ACTIVE'
          AND definition."effective_from" <= NEW."effective_from"
          AND (
            definition."effective_to" IS NULL
            OR (
              NEW."effective_to" IS NOT NULL
              AND definition."effective_to" >= NEW."effective_to"
            )
          )
      )
    INTO child_count, secondary_child_count
    FROM public."objective_metric_definitions" AS link
    JOIN public."metric_definitions" AS definition
      ON definition."tenant_id" = link."tenant_id"
     AND definition."id" = link."metric_definition_id"
     AND definition."version" = link."metric_definition_version"
    WHERE link."tenant_id" = NEW."tenant_id"
      AND link."objective_id" = NEW."id"
      AND link."objective_version" = NEW."version";
    IF child_count = 0 OR child_count <> secondary_child_count THEN
      RAISE EXCEPTION 'An active Objective requires at least one Metric Definition.'
        USING ERRCODE = '23514', CONSTRAINT = 'objectives_active_metrics_check';
    END IF;
    SELECT
      count(*),
      count(*) FILTER (
        WHERE assignment."status" = 'ACTIVE'
          AND employment."status" = 'ACTIVE'
          AND assignment."effective_from" <= COALESCE(NEW."activated_at", CURRENT_TIMESTAMP)
          AND (
            assignment."effective_to" IS NULL
            OR assignment."effective_to" > COALESCE(NEW."activated_at", CURRENT_TIMESTAMP)
          )
      )
    INTO child_count, secondary_child_count
    FROM public."objective_role_assignments" AS link
    JOIN public."role_assignments" AS assignment
      ON assignment."tenant_id" = link."tenant_id"
     AND assignment."id" = link."role_assignment_id"
    JOIN public."employments" AS employment
      ON employment."tenant_id" = assignment."tenant_id"
     AND employment."id" = assignment."employment_id"
    WHERE link."tenant_id" = NEW."tenant_id"
      AND link."objective_id" = NEW."id"
      AND link."objective_version" = NEW."version";
    IF child_count = 0 OR child_count <> secondary_child_count THEN
      RAISE EXCEPTION 'An active Objective requires a responsible Role Assignment.'
        USING ERRCODE = '23514', CONSTRAINT = 'objectives_active_responsible_check';
    END IF;
  ELSIF TG_TABLE_NAME = 'process_versions'
    AND NEW."status"::text = 'PUBLISHED'
    AND (TG_OP = 'INSERT' OR OLD."status"::text <> 'PUBLISHED')
  THEN
    SELECT
      count(*) FILTER (WHERE "type" = 'START'),
      count(*) FILTER (WHERE "type" = 'END')
    INTO child_count, secondary_child_count
    FROM public."process_nodes"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "process_definition_id" = NEW."process_definition_id"
      AND "process_version_id" = NEW."id"
      AND "process_version" = NEW."version";
    IF child_count <> 1 OR secondary_child_count = 0 THEN
      RAISE EXCEPTION 'A published Process Version requires exactly one START and at least one END node.'
        USING ERRCODE = '23514', CONSTRAINT = 'process_versions_publish_nodes_check';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "value_versions_publication_completeness_trigger"
  AFTER INSERT OR UPDATE OF "status" ON public."value_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_semantic_publication_completeness();
CREATE CONSTRAINT TRIGGER "strategies_publication_completeness_trigger"
  AFTER INSERT OR UPDATE OF "status" ON public."strategies"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_semantic_publication_completeness();
CREATE CONSTRAINT TRIGGER "objectives_publication_completeness_trigger"
  AFTER INSERT OR UPDATE OF "status" ON public."objectives"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_semantic_publication_completeness();
CREATE CONSTRAINT TRIGGER "process_versions_publication_completeness_trigger"
  AFTER INSERT OR UPDATE OF "status" ON public."process_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_semantic_publication_completeness();

CREATE OR REPLACE FUNCTION public.validate_task_reference_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  value_record record;
  strategy_record record;
  objective_record record;
  process_definition_record record;
  process_version_record record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND ROW(
      NEW."strategy_id", NEW."strategy_version",
      NEW."objective_id", NEW."objective_version",
      NEW."value_definition_id", NEW."value_version_id", NEW."value_version_number",
      NEW."process_definition_id", NEW."process_definition_code",
      NEW."process_version_id", NEW."process_version",
      NEW."process_node_id", NEW."process_node_code",
      NEW."effective_from", NEW."effective_to", NEW."due_at"
    ) IS NOT DISTINCT FROM ROW(
      OLD."strategy_id", OLD."strategy_version",
      OLD."objective_id", OLD."objective_version",
      OLD."value_definition_id", OLD."value_version_id", OLD."value_version_number",
      OLD."process_definition_id", OLD."process_definition_code",
      OLD."process_version_id", OLD."process_version",
      OLD."process_node_id", OLD."process_node_code",
      OLD."effective_from", OLD."effective_to", OLD."due_at"
    )
  THEN
    RETURN NEW;
  END IF;

  SELECT "status", "effective_from", "effective_to"
  INTO value_record
  FROM public."value_versions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "value_definition_id" = NEW."value_definition_id"
    AND "id" = NEW."value_version_id"
    AND "version" = NEW."value_version_number"
  FOR SHARE;
  SELECT "status", "effective_from", "effective_to"
  INTO strategy_record
  FROM public."strategies"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."strategy_id"
    AND "version" = NEW."strategy_version"
  FOR SHARE;
  SELECT "status", "effective_from", "effective_to"
  INTO objective_record
  FROM public."objectives"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."objective_id"
    AND "version" = NEW."objective_version"
  FOR SHARE;
  SELECT "status", "effective_from", "effective_to"
  INTO process_definition_record
  FROM public."process_definitions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."process_definition_id"
    AND "code" = NEW."process_definition_code"
  FOR SHARE;
  SELECT "status", "effective_from", "effective_to"
  INTO process_version_record
  FROM public."process_versions"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "process_definition_id" = NEW."process_definition_id"
    AND "id" = NEW."process_version_id"
    AND "version" = NEW."process_version"
  FOR SHARE;

  IF value_record IS NULL OR value_record."status" <> 'PUBLISHED'
    OR strategy_record IS NULL OR strategy_record."status" <> 'ACTIVE'
    OR objective_record IS NULL OR objective_record."status" NOT IN ('ACTIVE', 'AT_RISK')
    OR process_definition_record IS NULL OR process_definition_record."status" <> 'ACTIVE'
    OR process_version_record IS NULL OR process_version_record."status" <> 'PUBLISHED'
  THEN
    RAISE EXCEPTION 'A Task requires published/current Value, Strategy, Objective, and Process versions.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_reference_eligibility_check';
  END IF;

  IF NEW."effective_from" < value_record."effective_from"
    OR NEW."effective_from" < strategy_record."effective_from"
    OR NEW."effective_from" < objective_record."effective_from"
    OR NEW."effective_from" < process_definition_record."effective_from"
    OR NEW."effective_from" < process_version_record."effective_from"
    OR NEW."due_at" > COALESCE(value_record."effective_to", 'infinity'::timestamptz)
    OR NEW."due_at" > COALESCE(strategy_record."effective_to", 'infinity'::timestamptz)
    OR NEW."due_at" > COALESCE(objective_record."effective_to", 'infinity'::timestamptz)
    OR NEW."due_at" > COALESCE(process_definition_record."effective_to", 'infinity'::timestamptz)
    OR NEW."due_at" > COALESCE(process_version_record."effective_to", 'infinity'::timestamptz)
    OR (
      NEW."effective_to" IS NOT NULL
      AND (
        NEW."effective_to" > COALESCE(value_record."effective_to", 'infinity'::timestamptz)
        OR NEW."effective_to" > COALESCE(strategy_record."effective_to", 'infinity'::timestamptz)
        OR NEW."effective_to" > COALESCE(objective_record."effective_to", 'infinity'::timestamptz)
        OR NEW."effective_to" > COALESCE(process_definition_record."effective_to", 'infinity'::timestamptz)
        OR NEW."effective_to" > COALESCE(process_version_record."effective_to", 'infinity'::timestamptz)
      )
    )
  THEN
    RAISE EXCEPTION 'A Task effective period must fit every referenced business version.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_reference_effective_period_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "tasks_reference_eligibility_trigger"
  BEFORE INSERT OR UPDATE OF
    "strategy_id", "strategy_version", "objective_id", "objective_version",
    "value_definition_id", "value_version_id", "value_version_number",
    "process_definition_id", "process_definition_code",
    "process_version_id", "process_version", "process_node_id",
    "process_node_code", "effective_from", "effective_to", "due_at"
  ON public."tasks"
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_reference_eligibility();

CREATE OR REPLACE FUNCTION public.enforce_semantic_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_core jsonb;
  new_core jsonb;
  frozen boolean := false;
  mutable_fields text[];
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."previous_version_id" IS DISTINCT FROM OLD."previous_version_id"
    OR NEW."previous_version_number" IS DISTINCT FROM OLD."previous_version_number"
  THEN
    RAISE EXCEPTION 'Business version identity and lineage are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_identity_immutable';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'value_versions' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY['status', 'revision', 'retired_at', 'updated_at'];
    WHEN 'strategies' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY[
        'status', 'revision', 'activated_at', 'closed_at', 'cancelled_at',
        'effective_to', 'updated_at'
      ];
    WHEN 'objectives' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY[
        'status', 'revision', 'activated_at', 'achieved_at', 'cancelled_at',
        'effective_to', 'updated_at'
      ];
    WHEN 'objective_relations' THEN
      frozen := true;
      mutable_fields := ARRAY['status', 'revision', 'retired_at', 'effective_to', 'updated_at'];
    WHEN 'metric_definitions' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY['status', 'revision', 'activated_at', 'retired_at', 'effective_to', 'updated_at'];
    WHEN 'process_versions' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY['status', 'revision', 'retired_at', 'updated_at'];
    WHEN 'tasks' THEN
      frozen := OLD."status" <> 'PLANNED';
      mutable_fields := ARRAY[
        'status', 'revision', 'ready_at', 'started_at', 'delivered_at',
        'completed_at', 'cancelled_at', 'updated_at'
      ];
    WHEN 'task_dependencies' THEN
      frozen := true;
      mutable_fields := ARRAY['status', 'revision', 'removed_at', 'effective_to', 'updated_at'];
    WHEN 'deliverables' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY['status', 'revision', 'updated_at'];
    WHEN 'acceptances' THEN
      frozen := true;
      mutable_fields := ARRAY[
        'status', 'revision', 'evidence_sealed_at', 'voided_at', 'updated_at'
      ];
    WHEN 'evidence' THEN
      frozen := OLD."status" <> 'DRAFT';
      mutable_fields := ARRAY[
        'status', 'revision', 'activated_at', 'revoked_at', 'effective_to', 'updated_at'
      ];
    WHEN 'metric_observations' THEN
      frozen := true;
      mutable_fields := ARRAY['revision', 'evidence_sealed_at', 'updated_at'];
    WHEN 'evidence_links' THEN
      frozen := true;
      mutable_fields := ARRAY['status', 'revision', 'removed_at', 'effective_to', 'updated_at'];
    ELSE
      frozen := false;
  END CASE;

  IF frozen THEN
    old_core := to_jsonb(OLD) - mutable_fields;
    new_core := to_jsonb(NEW) - mutable_fields;
    IF old_core IS DISTINCT FROM new_core THEN
      RAISE EXCEPTION 'Published or active business definition columns are immutable; create a new version.'
        USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_published_core_immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DO $semantic_immutability_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_versions', 'strategies', 'objectives', 'objective_relations',
    'metric_definitions', 'process_versions', 'tasks', 'task_dependencies',
    'deliverables', 'acceptances', 'evidence', 'metric_observations',
    'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_semantic_version_immutability()',
      table_name || '_immutability_trigger',
      table_name
    );
  END LOOP;
END
$semantic_immutability_triggers$;

CREATE OR REPLACE FUNCTION public.guard_semantic_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_data jsonb;
  old_data jsonb;
  new_data jsonb;
  parent_status text;
  parent_sealed_at timestamptz;
BEGIN
  old_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  IF TG_OP = 'UPDATE' THEN
    CASE TG_TABLE_NAME
      WHEN 'value_metrics', 'value_constraints' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'value_definition_id',
          old_data->>'value_version_id', old_data->>'value_version_number'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'value_definition_id',
          new_data->>'value_version_id', new_data->>'value_version_number'
        ) THEN
          RAISE EXCEPTION 'A Value Version child cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'value_version_child_parent_immutable';
        END IF;
      WHEN 'strategy_value_versions' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'strategy_id', old_data->>'strategy_version'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'strategy_id', new_data->>'strategy_version'
        ) THEN
          RAISE EXCEPTION 'A Strategy Value relation cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'strategy_value_parent_immutable';
        END IF;
      WHEN 'objective_value_versions', 'objective_metric_definitions',
           'objective_role_assignments' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'objective_id', old_data->>'objective_version'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'objective_id', new_data->>'objective_version'
        ) THEN
          RAISE EXCEPTION 'An Objective relation cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'objective_relation_parent_immutable';
        END IF;
      WHEN 'process_nodes' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'process_definition_id',
          old_data->>'process_version_id', old_data->>'process_version'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'process_definition_id',
          new_data->>'process_version_id', new_data->>'process_version'
        ) THEN
          RAISE EXCEPTION 'A Process Node cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'process_node_parent_immutable';
        END IF;
      WHEN 'metric_observation_evidence' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'metric_observation_id',
          old_data->>'metric_observation_version'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'metric_observation_id',
          new_data->>'metric_observation_version'
        ) THEN
          RAISE EXCEPTION 'Metric Observation Evidence cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'metric_observation_evidence_parent_immutable';
        END IF;
      WHEN 'deliverable_evidence' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'deliverable_id',
          old_data->>'deliverable_version'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'deliverable_id',
          new_data->>'deliverable_version'
        ) THEN
          RAISE EXCEPTION 'Deliverable Evidence cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'deliverable_evidence_parent_immutable';
        END IF;
      WHEN 'acceptance_evidence' THEN
        IF ROW(
          old_data->>'tenant_id', old_data->>'acceptance_id',
          old_data->>'acceptance_version'
        ) IS DISTINCT FROM ROW(
          new_data->>'tenant_id', new_data->>'acceptance_id',
          new_data->>'acceptance_version'
        ) THEN
          RAISE EXCEPTION 'Acceptance Evidence cannot be re-parented.'
            USING ERRCODE = '23514', CONSTRAINT = 'acceptance_evidence_parent_immutable';
        END IF;
    END CASE;
  END IF;

  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  CASE TG_TABLE_NAME
    WHEN 'value_metrics', 'value_constraints' THEN
      SELECT "status"::text INTO parent_status
      FROM public."value_versions"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'value_version_id')::uuid
        AND "version" = (row_data->>'value_version_number')::integer
      FOR UPDATE;
      IF parent_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Published Value Version children are immutable.'
          USING ERRCODE = '23514', CONSTRAINT = 'value_versions_children_immutable';
      END IF;
    WHEN 'strategy_value_versions' THEN
      SELECT "status"::text INTO parent_status
      FROM public."strategies"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'strategy_id')::uuid
        AND "version" = (row_data->>'strategy_version')::integer
      FOR UPDATE;
      IF parent_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Active Strategy Value relations are immutable.'
          USING ERRCODE = '23514', CONSTRAINT = 'strategies_values_immutable';
      END IF;
    WHEN 'objective_value_versions', 'objective_metric_definitions', 'objective_role_assignments' THEN
      SELECT "status"::text INTO parent_status
      FROM public."objectives"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'objective_id')::uuid
        AND "version" = (row_data->>'objective_version')::integer
      FOR UPDATE;
      IF parent_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Active Objective relations are immutable.'
          USING ERRCODE = '23514', CONSTRAINT = 'objectives_relations_immutable';
      END IF;
    WHEN 'process_nodes' THEN
      SELECT "status"::text INTO parent_status
      FROM public."process_versions"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'process_version_id')::uuid
        AND "version" = (row_data->>'process_version')::integer
      FOR UPDATE;
      IF parent_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Published Process Version nodes are immutable.'
          USING ERRCODE = '23514', CONSTRAINT = 'process_versions_nodes_immutable';
      END IF;
    WHEN 'metric_observation_evidence' THEN
      SELECT "evidence_sealed_at" INTO parent_sealed_at
      FROM public."metric_observations"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'metric_observation_id')::uuid
        AND "version" = (row_data->>'metric_observation_version')::integer
      FOR UPDATE;
      IF parent_sealed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Metric Observation Evidence is sealed.'
          USING ERRCODE = '23514', CONSTRAINT = 'metric_observation_evidence_sealed';
      END IF;
    WHEN 'deliverable_evidence' THEN
      SELECT "evidence_sealed_at" INTO parent_sealed_at
      FROM public."deliverables"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'deliverable_id')::uuid
        AND "version" = (row_data->>'deliverable_version')::integer
      FOR UPDATE;
      IF parent_sealed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Deliverable Evidence is sealed.'
          USING ERRCODE = '23514', CONSTRAINT = 'deliverable_evidence_sealed';
      END IF;
    WHEN 'acceptance_evidence' THEN
      SELECT "evidence_sealed_at" INTO parent_sealed_at
      FROM public."acceptances"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'acceptance_id')::uuid
        AND "version" = (row_data->>'acceptance_version')::integer
      FOR UPDATE;
      IF parent_sealed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Acceptance Evidence is sealed.'
          USING ERRCODE = '23514', CONSTRAINT = 'acceptance_evidence_sealed';
      END IF;
  END CASE;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "value_metrics_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."value_metrics"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "value_constraints_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."value_constraints"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "strategy_value_versions_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."strategy_value_versions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "objective_value_versions_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."objective_value_versions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "objective_metric_definitions_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."objective_metric_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "objective_role_assignments_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."objective_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "process_nodes_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."process_nodes"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "metric_observation_evidence_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."metric_observation_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "deliverable_evidence_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."deliverable_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();
CREATE TRIGGER "acceptance_evidence_parent_immutability_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON public."acceptance_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.guard_semantic_child_mutation();

CREATE OR REPLACE FUNCTION public.enforce_evidence_seal_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD."evidence_sealed_at" IS NOT NULL
    AND NEW."evidence_sealed_at" IS DISTINCT FROM OLD."evidence_sealed_at"
  THEN
    RAISE EXCEPTION 'An evidence seal cannot be removed or replaced.'
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_evidence_seal_immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "metric_observations_evidence_seal_trigger"
  BEFORE UPDATE OF "evidence_sealed_at" ON public."metric_observations"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_seal_monotonic();
CREATE TRIGGER "deliverables_evidence_seal_trigger"
  BEFORE UPDATE OF "evidence_sealed_at" ON public."deliverables"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_seal_monotonic();
CREATE TRIGGER "acceptances_evidence_seal_trigger"
  BEFORE UPDATE OF "evidence_sealed_at" ON public."acceptances"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_seal_monotonic();

CREATE OR REPLACE FUNCTION public.validate_evidence_seal_completeness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  link_count integer;
  current_sealed_at timestamptz;
  current_status text;
BEGIN
  IF TG_TABLE_NAME = 'metric_observations' THEN
    SELECT "evidence_sealed_at"
    INTO current_sealed_at
    FROM public."metric_observations"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."id"
      AND "version" = NEW."version";
    SELECT count(*) INTO link_count
    FROM public."metric_observation_evidence"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "metric_observation_id" = NEW."id"
      AND "metric_observation_version" = NEW."version";
    IF current_sealed_at IS NULL OR link_count = 0 THEN
      RAISE EXCEPTION 'Metric Observation Evidence must be nonempty and sealed.'
        USING ERRCODE = '23514', CONSTRAINT = 'metric_observations_evidence_seal_complete';
    END IF;
  ELSIF TG_TABLE_NAME = 'deliverables' THEN
    SELECT "status"::text, "evidence_sealed_at"
    INTO current_status, current_sealed_at
    FROM public."deliverables"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."id"
      AND "version" = NEW."version";
    SELECT count(*) INTO link_count
    FROM public."deliverable_evidence"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "deliverable_id" = NEW."id"
      AND "deliverable_version" = NEW."version";
    IF current_status = 'DRAFT'
      OR (current_status = 'WITHDRAWN' AND current_sealed_at IS NULL)
    THEN
      IF current_sealed_at IS NOT NULL OR link_count <> 0 THEN
        RAISE EXCEPTION 'Unsubmitted Deliverable Evidence must remain empty and unsealed.'
          USING ERRCODE = '23514', CONSTRAINT = 'deliverables_draft_evidence_check';
      END IF;
    ELSIF current_sealed_at IS NULL OR link_count = 0 THEN
      RAISE EXCEPTION 'Submitted Deliverable Evidence must be nonempty and sealed.'
        USING ERRCODE = '23514', CONSTRAINT = 'deliverables_evidence_seal_complete';
    END IF;
  ELSIF TG_TABLE_NAME = 'acceptances' THEN
    SELECT "evidence_sealed_at"
    INTO current_sealed_at
    FROM public."acceptances"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."id"
      AND "version" = NEW."version";
    SELECT count(*) INTO link_count
    FROM public."acceptance_evidence"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "acceptance_id" = NEW."id"
      AND "acceptance_version" = NEW."version";
    IF current_sealed_at IS NULL OR link_count = 0 THEN
      RAISE EXCEPTION 'Acceptance Evidence must be nonempty and sealed.'
        USING ERRCODE = '23514', CONSTRAINT = 'acceptances_evidence_seal_complete';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "metric_observations_evidence_seal_completeness_trigger"
  AFTER INSERT OR UPDATE ON public."metric_observations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_seal_completeness();
CREATE CONSTRAINT TRIGGER "deliverables_evidence_seal_completeness_trigger"
  AFTER INSERT OR UPDATE ON public."deliverables"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_seal_completeness();
CREATE CONSTRAINT TRIGGER "acceptances_evidence_seal_completeness_trigger"
  AFTER INSERT OR UPDATE ON public."acceptances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_seal_completeness();

CREATE OR REPLACE FUNCTION public.assert_task_completion_integrity(
  checked_tenant_id uuid,
  checked_task_id uuid,
  checked_task_version integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  task_status text;
  qualifying_deliverable_count integer;
  qualifying_acceptance_count integer;
BEGIN
  SELECT "status"::text
  INTO task_status
  FROM public."tasks"
  WHERE "tenant_id" = checked_tenant_id
    AND "id" = checked_task_id
    AND "version" = checked_task_version;

  IF task_status IS NULL
    OR task_status NOT IN ('DELIVERED', 'ACCEPTED', 'REJECTED')
  THEN
    RETURN;
  END IF;

  SELECT count(*)
  INTO qualifying_deliverable_count
  FROM public."deliverables" AS deliverable
  WHERE deliverable."tenant_id" = checked_tenant_id
    AND deliverable."task_id" = checked_task_id
    AND deliverable."task_version" = checked_task_version
    AND deliverable."status" IN ('SUBMITTED', 'ACCEPTED', 'REJECTED')
    AND deliverable."evidence_sealed_at" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public."deliverable_evidence" AS evidence_link
      WHERE evidence_link."tenant_id" = deliverable."tenant_id"
        AND evidence_link."deliverable_id" = deliverable."id"
        AND evidence_link."deliverable_version" = deliverable."version"
    );

  IF qualifying_deliverable_count = 0 THEN
    RAISE EXCEPTION 'Delivered or terminal Tasks require a non-Draft Deliverable with sealed Evidence.'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_deliverable_evidence_complete';
  END IF;

  IF task_status IN ('ACCEPTED', 'REJECTED') THEN
    SELECT count(*)
    INTO qualifying_acceptance_count
    FROM public."deliverables" AS deliverable
    JOIN public."acceptances" AS acceptance
      ON acceptance."tenant_id" = deliverable."tenant_id"
     AND acceptance."deliverable_id" = deliverable."id"
     AND acceptance."deliverable_version" = deliverable."version"
    WHERE deliverable."tenant_id" = checked_tenant_id
      AND deliverable."task_id" = checked_task_id
      AND deliverable."task_version" = checked_task_version
      AND deliverable."evidence_sealed_at" IS NOT NULL
      AND acceptance."status" = 'ACTIVE'
      AND acceptance."evidence_sealed_at" IS NOT NULL
      AND (
        (
          task_status = 'ACCEPTED'
          AND deliverable."status" = 'ACCEPTED'
          AND acceptance."decision" = 'ACCEPTED'
        )
        OR (
          task_status = 'REJECTED'
          AND deliverable."status" = 'REJECTED'
          AND acceptance."decision" IN ('REJECTED', 'CHANGES_REQUESTED')
        )
      )
      AND EXISTS (
        SELECT 1
        FROM public."deliverable_evidence" AS deliverable_evidence
        WHERE deliverable_evidence."tenant_id" = deliverable."tenant_id"
          AND deliverable_evidence."deliverable_id" = deliverable."id"
          AND deliverable_evidence."deliverable_version" = deliverable."version"
      )
      AND EXISTS (
        SELECT 1
        FROM public."acceptance_evidence" AS acceptance_evidence
        WHERE acceptance_evidence."tenant_id" = acceptance."tenant_id"
          AND acceptance_evidence."acceptance_id" = acceptance."id"
          AND acceptance_evidence."acceptance_version" = acceptance."version"
      );

    IF qualifying_acceptance_count = 0 THEN
      RAISE EXCEPTION 'Terminal Task status requires matching active Acceptance and sealed Evidence.'
        USING ERRCODE = '23514', CONSTRAINT = 'tasks_acceptance_evidence_complete';
    END IF;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.validate_task_completion_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_data jsonb;
  checked_tenant_id uuid;
  checked_task_id uuid;
  checked_task_version integer;
  parent_deliverable_id uuid;
  parent_deliverable_version integer;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

  CASE TG_TABLE_NAME
    WHEN 'tasks' THEN
      checked_tenant_id := (row_data->>'tenant_id')::uuid;
      checked_task_id := (row_data->>'id')::uuid;
      checked_task_version := (row_data->>'version')::integer;
    WHEN 'deliverables', 'deliverable_evidence' THEN
      checked_tenant_id := (row_data->>'tenant_id')::uuid;
      IF TG_TABLE_NAME = 'deliverables' THEN
        checked_task_id := (row_data->>'task_id')::uuid;
        checked_task_version := (row_data->>'task_version')::integer;
      ELSE
        SELECT "task_id", "task_version"
        INTO checked_task_id, checked_task_version
        FROM public."deliverables"
        WHERE "tenant_id" = checked_tenant_id
          AND "id" = (row_data->>'deliverable_id')::uuid
          AND "version" = (row_data->>'deliverable_version')::integer;
      END IF;
    WHEN 'acceptances', 'acceptance_evidence' THEN
      checked_tenant_id := (row_data->>'tenant_id')::uuid;
      IF TG_TABLE_NAME = 'acceptances' THEN
        parent_deliverable_id := (row_data->>'deliverable_id')::uuid;
        parent_deliverable_version := (row_data->>'deliverable_version')::integer;
      ELSE
        SELECT "deliverable_id", "deliverable_version"
        INTO parent_deliverable_id, parent_deliverable_version
        FROM public."acceptances"
        WHERE "tenant_id" = checked_tenant_id
          AND "id" = (row_data->>'acceptance_id')::uuid
          AND "version" = (row_data->>'acceptance_version')::integer;
      END IF;
      SELECT "task_id", "task_version"
      INTO checked_task_id, checked_task_version
      FROM public."deliverables"
      WHERE "tenant_id" = checked_tenant_id
        AND "id" = parent_deliverable_id
        AND "version" = parent_deliverable_version;
  END CASE;

  IF checked_task_id IS NOT NULL THEN
    PERFORM public.assert_task_completion_integrity(
      checked_tenant_id,
      checked_task_id,
      checked_task_version
    );
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "tasks_completion_integrity_trigger"
  AFTER INSERT OR UPDATE OF "status" ON public."tasks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_completion_integrity();
CREATE CONSTRAINT TRIGGER "deliverables_task_completion_reverse_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."deliverables"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_completion_integrity();
CREATE CONSTRAINT TRIGGER "deliverable_evidence_task_completion_reverse_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."deliverable_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_completion_integrity();
CREATE CONSTRAINT TRIGGER "acceptances_task_completion_reverse_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."acceptances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_completion_integrity();
CREATE CONSTRAINT TRIGGER "acceptance_evidence_task_completion_reverse_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."acceptance_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_completion_integrity();

CREATE OR REPLACE FUNCTION public.validate_evidence_association_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_data jsonb;
  parent_status text;
  parent_sealed_at timestamptz;
  link_count integer;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  CASE TG_TABLE_NAME
    WHEN 'metric_observation_evidence' THEN
      SELECT "evidence_sealed_at"
      INTO parent_sealed_at
      FROM public."metric_observations"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'metric_observation_id')::uuid
        AND "version" = (row_data->>'metric_observation_version')::integer;
      IF FOUND THEN
        SELECT count(*) INTO link_count
        FROM public."metric_observation_evidence"
        WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
          AND "metric_observation_id" = (row_data->>'metric_observation_id')::uuid
          AND "metric_observation_version" =
            (row_data->>'metric_observation_version')::integer;
        IF parent_sealed_at IS NULL OR link_count = 0 THEN
          RAISE EXCEPTION 'Metric Observation Evidence must be nonempty and sealed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'metric_observations_evidence_seal_complete';
        END IF;
      END IF;
    WHEN 'deliverable_evidence' THEN
      SELECT "status"::text, "evidence_sealed_at"
      INTO parent_status, parent_sealed_at
      FROM public."deliverables"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'deliverable_id')::uuid
        AND "version" = (row_data->>'deliverable_version')::integer;
      IF FOUND THEN
        SELECT count(*) INTO link_count
        FROM public."deliverable_evidence"
        WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
          AND "deliverable_id" = (row_data->>'deliverable_id')::uuid
          AND "deliverable_version" = (row_data->>'deliverable_version')::integer;
        IF parent_status = 'DRAFT'
          OR (parent_status = 'WITHDRAWN' AND parent_sealed_at IS NULL)
        THEN
          IF parent_sealed_at IS NOT NULL OR link_count <> 0 THEN
            RAISE EXCEPTION 'Unsubmitted Deliverable Evidence must remain empty and unsealed.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'deliverables_draft_evidence_check';
          END IF;
        ELSIF parent_sealed_at IS NULL OR link_count = 0 THEN
          RAISE EXCEPTION 'Submitted Deliverable Evidence must be nonempty and sealed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'deliverables_evidence_seal_complete';
        END IF;
      END IF;
    WHEN 'acceptance_evidence' THEN
      SELECT "evidence_sealed_at"
      INTO parent_sealed_at
      FROM public."acceptances"
      WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
        AND "id" = (row_data->>'acceptance_id')::uuid
        AND "version" = (row_data->>'acceptance_version')::integer;
      IF FOUND THEN
        SELECT count(*) INTO link_count
        FROM public."acceptance_evidence"
        WHERE "tenant_id" = (row_data->>'tenant_id')::uuid
          AND "acceptance_id" = (row_data->>'acceptance_id')::uuid
          AND "acceptance_version" = (row_data->>'acceptance_version')::integer;
        IF parent_sealed_at IS NULL OR link_count = 0 THEN
          RAISE EXCEPTION 'Acceptance Evidence must be nonempty and sealed.'
            USING ERRCODE = '23514',
              CONSTRAINT = 'acceptances_evidence_seal_complete';
        END IF;
      END IF;
  END CASE;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "metric_observation_evidence_parent_complete_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."metric_observation_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_association_parent();
CREATE CONSTRAINT TRIGGER "deliverable_evidence_parent_complete_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."deliverable_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_association_parent();
CREATE CONSTRAINT TRIGGER "acceptance_evidence_parent_complete_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."acceptance_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_association_parent();

CREATE OR REPLACE FUNCTION public.validate_active_process_current_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_data jsonb;
  definition_tenant_id uuid;
  definition_id uuid;
  definition_status text;
  current_version_id uuid;
  current_version_number integer;
  published_count integer;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  definition_tenant_id := (row_data->>'tenant_id')::uuid;
  definition_id := CASE
    WHEN TG_TABLE_NAME = 'process_definitions' THEN (row_data->>'id')::uuid
    ELSE (row_data->>'process_definition_id')::uuid
  END;

  SELECT
    definition."status"::text,
    definition."current_version_id",
    definition."current_version_number"
  INTO definition_status, current_version_id, current_version_number
  FROM public."process_definitions" definition
  WHERE definition."tenant_id" = definition_tenant_id
    AND definition."id" = definition_id;

  IF definition_status = 'ACTIVE' THEN
    SELECT count(*)
    INTO published_count
    FROM public."process_versions" process_version
    WHERE process_version."tenant_id" = definition_tenant_id
      AND process_version."process_definition_id" = definition_id
      AND process_version."id" = current_version_id
      AND process_version."version" = current_version_number
      AND process_version."status" = 'PUBLISHED';
    IF current_version_id IS NULL
      OR current_version_number IS NULL
      OR published_count <> 1
    THEN
      RAISE EXCEPTION 'An active Process Definition requires an exact published current version.'
        USING ERRCODE = '23514',
          CONSTRAINT = 'process_definitions_active_current_version_check';
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "process_definitions_active_current_version_trigger"
  AFTER INSERT OR UPDATE ON public."process_definitions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_active_process_current_version();
CREATE CONSTRAINT TRIGGER "process_versions_active_definition_reverse_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON public."process_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_active_process_current_version();

CREATE OR REPLACE FUNCTION public.prevent_parent_retirement_with_open_tasks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  open_task_exists boolean := false;
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'value_versions' THEN
      IF NEW."status" = 'RETIRED' THEN
        SELECT EXISTS (
          SELECT 1
          FROM public."tasks"
          WHERE "tenant_id" = OLD."tenant_id"
            AND "value_definition_id" = OLD."value_definition_id"
            AND "value_version_id" = OLD."id"
            AND "value_version_number" = OLD."version"
            AND "status" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
        ) INTO open_task_exists;
      END IF;
    WHEN 'strategies' THEN
      IF NEW."status" IN ('CLOSED', 'CANCELLED') THEN
        SELECT EXISTS (
          SELECT 1
          FROM public."tasks"
          WHERE "tenant_id" = OLD."tenant_id"
            AND "strategy_id" = OLD."id"
            AND "strategy_version" = OLD."version"
            AND "status" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
        ) INTO open_task_exists;
      END IF;
    WHEN 'objectives' THEN
      IF NEW."status" IN ('ACHIEVED', 'CANCELLED') THEN
        SELECT EXISTS (
          SELECT 1
          FROM public."tasks"
          WHERE "tenant_id" = OLD."tenant_id"
            AND "objective_id" = OLD."id"
            AND "objective_version" = OLD."version"
            AND "status" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
        ) INTO open_task_exists;
      END IF;
    WHEN 'process_definitions' THEN
      IF NEW."status" = 'RETIRED' THEN
        SELECT EXISTS (
          SELECT 1
          FROM public."tasks"
          WHERE "tenant_id" = OLD."tenant_id"
            AND "process_definition_id" = OLD."id"
            AND "status" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
        ) INTO open_task_exists;
      END IF;
    WHEN 'process_versions' THEN
      IF NEW."status" = 'RETIRED' THEN
        SELECT EXISTS (
          SELECT 1
          FROM public."tasks"
          WHERE "tenant_id" = OLD."tenant_id"
            AND "process_definition_id" = OLD."process_definition_id"
            AND "process_version_id" = OLD."id"
            AND "process_version" = OLD."version"
            AND "status" NOT IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
        ) INTO open_task_exists;
      END IF;
  END CASE;

  IF open_task_exists THEN
    RAISE EXCEPTION 'A referenced business version cannot retire while non-terminal Tasks remain.'
      USING ERRCODE = '23514',
        CONSTRAINT = TG_TABLE_NAME || '_open_tasks_retirement_check';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "value_versions_open_tasks_retirement_trigger"
  BEFORE UPDATE OF "status" ON public."value_versions"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_parent_retirement_with_open_tasks();
CREATE TRIGGER "strategies_open_tasks_retirement_trigger"
  BEFORE UPDATE OF "status" ON public."strategies"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_parent_retirement_with_open_tasks();
CREATE TRIGGER "objectives_open_tasks_retirement_trigger"
  BEFORE UPDATE OF "status" ON public."objectives"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_parent_retirement_with_open_tasks();
CREATE TRIGGER "process_definitions_open_tasks_retirement_trigger"
  BEFORE UPDATE OF "status" ON public."process_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_parent_retirement_with_open_tasks();
CREATE TRIGGER "process_versions_open_tasks_retirement_trigger"
  BEFORE UPDATE OF "status" ON public."process_versions"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_parent_retirement_with_open_tasks();

CREATE OR REPLACE FUNCTION public.enforce_semantic_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_status text := OLD."status"::text;
  new_status text := NEW."status"::text;
  allowed boolean := false;
BEGIN
  IF new_status = old_status THEN
    RETURN NEW;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'value_versions' THEN
      allowed := (old_status = 'DRAFT' AND new_status = 'PUBLISHED')
        OR (old_status = 'PUBLISHED' AND new_status = 'RETIRED');
    WHEN 'strategies' THEN
      allowed := (old_status = 'DRAFT' AND new_status IN ('ACTIVE', 'CANCELLED'))
        OR (old_status = 'ACTIVE' AND new_status IN ('CLOSED', 'CANCELLED'));
    WHEN 'objectives' THEN
      allowed := (old_status = 'DRAFT' AND new_status IN ('ACTIVE', 'CANCELLED'))
        OR (
          old_status = 'ACTIVE'
          AND new_status IN ('AT_RISK', 'ACHIEVED', 'CANCELLED')
        )
        OR (
          old_status = 'AT_RISK'
          AND new_status IN ('ACTIVE', 'ACHIEVED', 'CANCELLED')
        );
    WHEN 'objective_relations' THEN
      allowed := old_status = 'ACTIVE' AND new_status = 'RETIRED';
    WHEN 'metric_definitions' THEN
      allowed := (old_status = 'DRAFT' AND new_status = 'ACTIVE')
        OR (old_status = 'ACTIVE' AND new_status = 'RETIRED');
    WHEN 'process_definitions' THEN
      allowed := (old_status = 'DRAFT' AND new_status = 'ACTIVE')
        OR (old_status = 'ACTIVE' AND new_status = 'RETIRED');
    WHEN 'process_versions' THEN
      allowed := (old_status = 'DRAFT' AND new_status = 'PUBLISHED')
        OR (old_status = 'PUBLISHED' AND new_status = 'RETIRED');
    WHEN 'tasks' THEN
      allowed := (old_status = 'PLANNED' AND new_status IN ('READY', 'CANCELLED'))
        OR (
          old_status = 'READY'
          AND new_status IN ('IN_PROGRESS', 'BLOCKED', 'CANCELLED')
        )
        OR (
          old_status = 'IN_PROGRESS'
          AND new_status IN ('BLOCKED', 'DELIVERED', 'CANCELLED')
        )
        OR (
          old_status = 'BLOCKED'
          AND new_status IN ('READY', 'IN_PROGRESS', 'CANCELLED')
        )
        OR (
          old_status = 'DELIVERED'
          AND new_status IN ('ACCEPTED', 'REJECTED', 'CANCELLED')
        );
    WHEN 'task_dependencies' THEN
      allowed := old_status = 'ACTIVE' AND new_status = 'REMOVED';
    WHEN 'deliverables' THEN
      allowed := (old_status = 'DRAFT' AND new_status IN ('SUBMITTED', 'WITHDRAWN'))
        OR (
          old_status = 'SUBMITTED'
          AND new_status IN ('ACCEPTED', 'REJECTED', 'WITHDRAWN')
        );
    WHEN 'acceptances' THEN
      allowed := old_status = 'ACTIVE' AND new_status = 'VOID';
    WHEN 'evidence' THEN
      allowed := (old_status = 'DRAFT' AND new_status = 'ACTIVE')
        OR (old_status = 'ACTIVE' AND new_status = 'REVOKED');
    WHEN 'evidence_links' THEN
      allowed := old_status = 'ACTIVE' AND new_status = 'REMOVED';
  END CASE;
  IF NOT allowed THEN
    RAISE EXCEPTION 'Illegal % status transition: % -> %.', TG_TABLE_NAME, old_status, new_status
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_status_transition_check';
  END IF;
  RETURN NEW;
END
$function$;

DO $semantic_transition_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_versions', 'strategies', 'objectives', 'objective_relations',
    'metric_definitions', 'process_definitions', 'process_versions', 'tasks',
    'task_dependencies', 'deliverables', 'acceptances', 'evidence', 'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OF status ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_semantic_status_transition()',
      table_name || '_status_transition_trigger',
      table_name
    );
  END LOOP;
END
$semantic_transition_triggers$;

CREATE OR REPLACE FUNCTION public.enforce_process_definition_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
  THEN
    RAISE EXCEPTION 'Process Definition identity is immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_definitions_identity_immutable';
  END IF;
  IF OLD."status" <> 'DRAFT'
    AND (
      to_jsonb(NEW) - ARRAY[
        'status', 'revision', 'current_version_id', 'current_version_number',
        'effective_to', 'updated_at'
      ]
      IS DISTINCT FROM
      to_jsonb(OLD) - ARRAY[
        'status', 'revision', 'current_version_id', 'current_version_number',
        'effective_to', 'updated_at'
      ]
    )
  THEN
    RAISE EXCEPTION 'Active Process Definition columns are immutable.'
      USING ERRCODE = '23514', CONSTRAINT = 'process_definitions_active_core_immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "process_definitions_immutability_trigger"
  BEFORE UPDATE ON public."process_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_process_definition_immutability();

CREATE OR REPLACE FUNCTION public.preserve_task_reference_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  conflicting_task_id uuid;
BEGIN
  IF NEW."effective_from" IS NOT DISTINCT FROM OLD."effective_from"
    AND NEW."effective_to" IS NOT DISTINCT FROM OLD."effective_to"
  THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'value_definitions' THEN
      SELECT "id" INTO conflicting_task_id
      FROM public."tasks"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "value_definition_id" = NEW."id"
        AND (
          "effective_from" < NEW."effective_from"
          OR (
            NEW."effective_to" IS NOT NULL
            AND (
              "effective_to" IS NULL
              OR "effective_to" > NEW."effective_to"
              OR "due_at" > NEW."effective_to"
            )
          )
        )
      LIMIT 1;
    WHEN 'value_versions' THEN
      SELECT "id" INTO conflicting_task_id
      FROM public."tasks"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "value_definition_id" = NEW."value_definition_id"
        AND "value_version_id" = NEW."id"
        AND "value_version_number" = NEW."version"
        AND (
          "effective_from" < NEW."effective_from"
          OR (
            NEW."effective_to" IS NOT NULL
            AND (
              "effective_to" IS NULL
              OR "effective_to" > NEW."effective_to"
              OR "due_at" > NEW."effective_to"
            )
          )
        )
      LIMIT 1;
    WHEN 'strategies' THEN
      SELECT "id" INTO conflicting_task_id
      FROM public."tasks"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "strategy_id" = NEW."id"
        AND "strategy_version" = NEW."version"
        AND (
          "effective_from" < NEW."effective_from"
          OR (
            NEW."effective_to" IS NOT NULL
            AND (
              "effective_to" IS NULL
              OR "effective_to" > NEW."effective_to"
              OR "due_at" > NEW."effective_to"
            )
          )
        )
      LIMIT 1;
    WHEN 'objectives' THEN
      SELECT "id" INTO conflicting_task_id
      FROM public."tasks"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "objective_id" = NEW."id"
        AND "objective_version" = NEW."version"
        AND (
          "effective_from" < NEW."effective_from"
          OR (
            NEW."effective_to" IS NOT NULL
            AND (
              "effective_to" IS NULL
              OR "effective_to" > NEW."effective_to"
              OR "due_at" > NEW."effective_to"
            )
          )
        )
      LIMIT 1;
    WHEN 'process_definitions' THEN
      SELECT "id" INTO conflicting_task_id
      FROM public."tasks"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "process_definition_id" = NEW."id"
        AND (
          "effective_from" < NEW."effective_from"
          OR (
            NEW."effective_to" IS NOT NULL
            AND (
              "effective_to" IS NULL
              OR "effective_to" > NEW."effective_to"
              OR "due_at" > NEW."effective_to"
            )
          )
        )
      LIMIT 1;
    WHEN 'process_versions' THEN
      SELECT "id" INTO conflicting_task_id
      FROM public."tasks"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "process_definition_id" = NEW."process_definition_id"
        AND "process_version_id" = NEW."id"
        AND "process_version" = NEW."version"
        AND (
          "effective_from" < NEW."effective_from"
          OR (
            NEW."effective_to" IS NOT NULL
            AND (
              "effective_to" IS NULL
              OR "effective_to" > NEW."effective_to"
              OR "due_at" > NEW."effective_to"
            )
          )
        )
      LIMIT 1;
  END CASE;

  IF conflicting_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'Effective-period change would invalidate Task %.', conflicting_task_id
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_task_period_preservation';
  END IF;
  RETURN NEW;
END
$function$;

DO $task_reference_period_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_versions', 'strategies', 'objectives',
    'process_definitions', 'process_versions'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OF effective_from, effective_to ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.preserve_task_reference_period()',
      table_name || '_task_period_preservation_trigger',
      table_name
    );
  END LOOP;
END
$task_reference_period_triggers$;

CREATE OR REPLACE FUNCTION public.reject_objective_parent_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  cycle_found boolean;
BEGIN
  IF NEW."parent_objective_id" IS NULL THEN
    RETURN NEW;
  END IF;
  WITH RECURSIVE ancestors("id", "version", "parent_id", "parent_version") AS (
    SELECT
      objective."id", objective."version",
      objective."parent_objective_id", objective."parent_objective_version"
    FROM public."objectives" AS objective
    WHERE objective."tenant_id" = NEW."tenant_id"
      AND objective."id" = NEW."parent_objective_id"
      AND objective."version" = NEW."parent_objective_version"
    UNION
    SELECT
      parent."id", parent."version",
      parent."parent_objective_id", parent."parent_objective_version"
    FROM public."objectives" AS parent
    JOIN ancestors
      ON parent."tenant_id" = NEW."tenant_id"
     AND parent."id" = ancestors."parent_id"
     AND parent."version" = ancestors."parent_version"
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestors
    WHERE "id" = NEW."id" AND "version" = NEW."version"
  )
  INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'Objective parent graph must be acyclic.'
      USING ERRCODE = '23514', CONSTRAINT = 'objectives_parent_acyclic';
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "objectives_parent_cycle_trigger"
  AFTER INSERT OR UPDATE OF "parent_objective_id", "parent_objective_version"
  ON public."objectives"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.reject_objective_parent_cycle();

CREATE OR REPLACE FUNCTION public.reject_task_dependency_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  cycle_found boolean;
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  WITH RECURSIVE reachable("task_id", "task_version") AS (
    SELECT NEW."successor_task_id", NEW."successor_task_version"
    UNION
    SELECT dependency."successor_task_id", dependency."successor_task_version"
    FROM public."task_dependencies" AS dependency
    JOIN reachable
      ON dependency."predecessor_task_id" = reachable."task_id"
     AND dependency."predecessor_task_version" = reachable."task_version"
    WHERE dependency."tenant_id" = NEW."tenant_id"
      AND dependency."status" = 'ACTIVE'
  )
  SELECT EXISTS (
    SELECT 1 FROM reachable
    WHERE "task_id" = NEW."predecessor_task_id"
      AND "task_version" = NEW."predecessor_task_version"
  )
  INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'Active Task dependency graph must be acyclic.'
      USING ERRCODE = '23514', CONSTRAINT = 'task_dependencies_active_acyclic';
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "task_dependencies_cycle_trigger"
  AFTER INSERT OR UPDATE OF
    "predecessor_task_id", "predecessor_task_version",
    "successor_task_id", "successor_task_version", "status"
  ON public."task_dependencies"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.reject_task_dependency_cycle();

CREATE OR REPLACE FUNCTION public.semantic_permission_labels_valid(labels jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(labels) <> 'array' THEN false
    ELSE
      jsonb_array_length(labels) <= 50
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(labels) AS item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
          OR length(item.value #>> '{}') NOT BETWEEN 2 AND 100
          OR (item.value #>> '{}') <> lower(item.value #>> '{}')
          OR (item.value #>> '{}') !~ '^[a-z0-9]+([._:/-][a-z0-9]+)*$'
      )
      AND (
        SELECT count(*) = count(DISTINCT item.value #>> '{}')
        FROM jsonb_array_elements(labels) AS item(value)
      )
  END
$function$;

DO $semantic_permission_label_constraints$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_versions', 'value_metrics', 'value_constraints',
    'strategies', 'objectives', 'objective_relations', 'metric_definitions',
    'process_definitions', 'process_versions', 'tasks', 'task_dependencies',
    'deliverables', 'acceptances', 'evidence', 'metric_observations',
    'evidence_links'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
      'CHECK (public.semantic_permission_labels_valid(permission_labels))',
      table_name,
      table_name || '_permission_labels_valid_check'
    );
  END LOOP;
END
$semantic_permission_label_constraints$;

CREATE OR REPLACE FUNCTION public.enforce_agent_run_task_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD."task_id" IS NOT NULL AND NEW."task_id" IS DISTINCT FROM OLD."task_id" THEN
    RAISE EXCEPTION 'An Agent Run Task identity cannot be changed once assigned.'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_runs_task_id_immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "agent_runs_task_id_immutability_trigger"
  BEFORE UPDATE OF "task_id" ON public."agent_runs"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_run_task_identity();

ALTER TABLE public."process_definitions"
  ADD CONSTRAINT "process_definitions_state_current_check" CHECK (
    (
      "status" = 'DRAFT'
      AND "current_version_id" IS NULL
      AND "current_version_number" IS NULL
    )
    OR (
      "status" IN ('ACTIVE', 'RETIRED')
      AND "current_version_id" IS NOT NULL
      AND "current_version_number" IS NOT NULL
    )
  );

ALTER TABLE public."tasks"
  ADD CONSTRAINT "tasks_state_time_check" CHECK (
    (
      "status" = 'PLANNED'
      AND "ready_at" IS NULL AND "started_at" IS NULL
      AND "delivered_at" IS NULL AND "completed_at" IS NULL
      AND "cancelled_at" IS NULL
    )
    OR (
      "status" = 'READY'
      AND "ready_at" IS NOT NULL AND "started_at" IS NULL
      AND "delivered_at" IS NULL AND "completed_at" IS NULL
      AND "cancelled_at" IS NULL
    )
    OR (
      "status" IN ('IN_PROGRESS', 'BLOCKED')
      AND "ready_at" IS NOT NULL
      AND "delivered_at" IS NULL AND "completed_at" IS NULL
      AND "cancelled_at" IS NULL
    )
    OR (
      "status" = 'DELIVERED'
      AND "ready_at" IS NOT NULL AND "started_at" IS NOT NULL
      AND "delivered_at" IS NOT NULL AND "completed_at" IS NULL
      AND "cancelled_at" IS NULL
    )
    OR (
      "status" IN ('ACCEPTED', 'REJECTED')
      AND "ready_at" IS NOT NULL AND "started_at" IS NOT NULL
      AND "delivered_at" IS NOT NULL AND "completed_at" IS NOT NULL
      AND "cancelled_at" IS NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "completed_at" IS NULL AND "cancelled_at" IS NOT NULL
    )
  );

-- Read paths use the application capability; every mutation is confined to
-- the admin capability. FORCE RLS keeps table owners inside the same boundary.
DO $semantic_rls_acl$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'value_definitions', 'value_versions', 'value_metrics', 'value_constraints',
    'strategies', 'strategy_value_versions', 'objectives',
    'objective_value_versions', 'objective_role_assignments',
    'objective_relations', 'metric_definitions', 'objective_metric_definitions',
    'process_definitions', 'process_versions', 'process_nodes', 'tasks',
    'task_dependencies', 'deliverables', 'acceptances', 'evidence',
    'metric_observations', 'evidence_links', 'metric_observation_evidence',
    'deliverable_evidence', 'acceptance_evidence'
  ]
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', table_name);
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I '
      'FROM enterprise_agent_app, enterprise_agent_admin',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE public.%I TO enterprise_agent_app',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO enterprise_agent_admin',
      table_name
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'AS RESTRICTIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_access ON public.%I '
      'AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      'USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$semantic_rls_acl$;

COMMIT;
