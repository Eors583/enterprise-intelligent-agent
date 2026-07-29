BEGIN;

CREATE TYPE public."MarketingObservationDimension" AS ENUM (
  'INDUSTRY', 'MARKET', 'CUSTOMER', 'COMPETITION', 'SELF'
);
CREATE TYPE public."MarketingAssertionType" AS ENUM ('FACT', 'HYPOTHESIS', 'INFERENCE');
CREATE TYPE public."MarketingCandidateOrigin" AS ENUM ('HUMAN', 'AI');
CREATE TYPE public."MarketingEvidenceLinkType" AS ENUM ('SUPPORTS', 'REFUTES', 'QUALIFIES');
CREATE TYPE public."MarketingInsightStatus" AS ENUM (
  'CANDIDATE', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'RETIRED'
);
CREATE TYPE public."MarketingMasterDataStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE public."MarketingTargetAxis" AS ENUM ('REGION', 'CUSTOMER_SEGMENT');
CREATE TYPE public."MarketingTargetStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED');
CREATE TYPE public."MarketingActionPlanStatus" AS ENUM (
  'DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE public."MarketingActionItemStatus" AS ENUM (
  'PLANNED', 'ACTIVE', 'BLOCKED', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE public."MarketingContributionType" AS ENUM (
  'RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'
);

CREATE TABLE public.marketing_observations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  dimension public."MarketingObservationDimension" NOT NULL,
  assertion_type public."MarketingAssertionType" NOT NULL,
  statement TEXT NOT NULL,
  confidence DECIMAL(12,10) NOT NULL,
  origin public."MarketingCandidateOrigin" NOT NULL,
  agent_run_id UUID,
  created_by_user_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_observations_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_observations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_observations_tenant_id_id_version_key
    UNIQUE (tenant_id, id, version),
  CONSTRAINT marketing_observations_tenant_id_code_version_key
    UNIQUE (tenant_id, code, version),
  CONSTRAINT marketing_observations_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_observations_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT marketing_observations_origin_check
    CHECK (
      (origin = 'AI' AND agent_run_id IS NOT NULL)
      OR (origin = 'HUMAN' AND agent_run_id IS NULL)
    ),
  CONSTRAINT marketing_observations_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT marketing_observations_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_observations_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX marketing_observations_dimension_idx
  ON public.marketing_observations(tenant_id, dimension, assertion_type, created_at DESC);
CREATE INDEX marketing_observations_agent_run_idx
  ON public.marketing_observations(tenant_id, agent_run_id)
  WHERE agent_run_id IS NOT NULL;

CREATE TABLE public.marketing_observation_evidence (
  tenant_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  observation_version INTEGER NOT NULL,
  evidence_id UUID NOT NULL,
  evidence_version INTEGER NOT NULL,
  link_type public."MarketingEvidenceLinkType" NOT NULL,
  source_version VARCHAR(200) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_observation_evidence_pkey
    PRIMARY KEY (tenant_id, observation_id, evidence_id),
  CONSTRAINT marketing_observation_evidence_observation_fkey
    FOREIGN KEY (tenant_id, observation_id, observation_version)
    REFERENCES public.marketing_observations(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT marketing_observation_evidence_evidence_fkey
    FOREIGN KEY (tenant_id, evidence_id, evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE INDEX marketing_observation_evidence_source_idx
  ON public.marketing_observation_evidence(tenant_id, evidence_id, evidence_version);

CREATE TABLE public.marketing_insights (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  previous_version_id UUID,
  previous_version_number INTEGER,
  title VARCHAR(200) NOT NULL,
  statement TEXT NOT NULL,
  origin public."MarketingCandidateOrigin" NOT NULL,
  agent_run_id UUID,
  status public."MarketingInsightStatus" NOT NULL DEFAULT 'CANDIDATE',
  created_by_user_id UUID NOT NULL,
  review_requested_by_user_id UUID,
  reviewed_by_user_id UUID,
  published_by_user_id UUID,
  review_comment VARCHAR(1000),
  review_requested_at TIMESTAMPTZ(6),
  reviewed_at TIMESTAMPTZ(6),
  published_at TIMESTAMPTZ(6),
  retired_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_insights_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_insights_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_insights_tenant_id_id_version_key UNIQUE (tenant_id, id, version),
  CONSTRAINT marketing_insights_tenant_id_code_version_key
    UNIQUE (tenant_id, code, version),
  CONSTRAINT marketing_insights_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_insights_version_check CHECK (version > 0 AND revision > 0),
  CONSTRAINT marketing_insights_origin_check
    CHECK (
      (origin = 'AI' AND agent_run_id IS NOT NULL)
      OR (origin = 'HUMAN' AND agent_run_id IS NULL)
    ),
  CONSTRAINT marketing_insights_previous_pair_check
    CHECK (
      (previous_version_id IS NULL AND previous_version_number IS NULL)
      OR (previous_version_id IS NOT NULL AND previous_version_number IS NOT NULL)
    ),
  CONSTRAINT marketing_insights_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT marketing_insights_previous_fkey
    FOREIGN KEY (tenant_id, previous_version_id, previous_version_number)
    REFERENCES public.marketing_insights(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT marketing_insights_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_insights_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_insights_review_requester_fkey
    FOREIGN KEY (tenant_id, review_requested_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_insights_reviewer_fkey
    FOREIGN KEY (tenant_id, reviewed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_insights_publisher_fkey
    FOREIGN KEY (tenant_id, published_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX marketing_insights_status_idx
  ON public.marketing_insights(tenant_id, status, updated_at DESC);
CREATE INDEX marketing_insights_agent_run_idx
  ON public.marketing_insights(tenant_id, agent_run_id)
  WHERE agent_run_id IS NOT NULL;

CREATE TABLE public.marketing_insight_observations (
  tenant_id UUID NOT NULL,
  insight_id UUID NOT NULL,
  insight_version INTEGER NOT NULL,
  observation_id UUID NOT NULL,
  observation_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_insight_observations_pkey
    PRIMARY KEY (tenant_id, insight_id, observation_id),
  CONSTRAINT marketing_insight_observations_insight_fkey
    FOREIGN KEY (tenant_id, insight_id, insight_version)
    REFERENCES public.marketing_insights(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT marketing_insight_observations_observation_fkey
    FOREIGN KEY (tenant_id, observation_id, observation_version)
    REFERENCES public.marketing_observations(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE INDEX marketing_insight_observations_source_idx
  ON public.marketing_insight_observations(tenant_id, observation_id, observation_version);

CREATE TABLE public.marketing_products (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status public."MarketingMasterDataStatus" NOT NULL DEFAULT 'ACTIVE',
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_products_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_products_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_products_tenant_id_code_key UNIQUE (tenant_id, code),
  CONSTRAINT marketing_products_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_products_revision_check CHECK (revision > 0),
  CONSTRAINT marketing_products_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
);

CREATE TABLE public.marketing_regions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status public."MarketingMasterDataStatus" NOT NULL DEFAULT 'ACTIVE',
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_regions_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_regions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_regions_tenant_id_code_key UNIQUE (tenant_id, code),
  CONSTRAINT marketing_regions_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_regions_revision_check CHECK (revision > 0),
  CONSTRAINT marketing_regions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
);

CREATE TABLE public.marketing_customer_segments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status public."MarketingMasterDataStatus" NOT NULL DEFAULT 'ACTIVE',
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_customer_segments_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_customer_segments_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_customer_segments_tenant_id_code_key UNIQUE (tenant_id, code),
  CONSTRAINT marketing_customer_segments_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_customer_segments_revision_check CHECK (revision > 0),
  CONSTRAINT marketing_customer_segments_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
);

CREATE INDEX marketing_products_status_idx
  ON public.marketing_products(tenant_id, status, code);
CREATE INDEX marketing_regions_status_idx
  ON public.marketing_regions(tenant_id, status, code);
CREATE INDEX marketing_customer_segments_status_idx
  ON public.marketing_customer_segments(tenant_id, status, code);

CREATE TABLE public.marketing_targets (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status public."MarketingTargetStatus" NOT NULL DEFAULT 'DRAFT',
  product_id UUID NOT NULL,
  axis public."MarketingTargetAxis" NOT NULL,
  region_id UUID,
  customer_segment_id UUID,
  strategy_id UUID NOT NULL,
  strategy_version INTEGER NOT NULL,
  objective_id UUID NOT NULL,
  objective_version INTEGER NOT NULL,
  value_definition_id UUID NOT NULL,
  value_version_id UUID NOT NULL,
  value_version_number INTEGER NOT NULL,
  responsible_role_assignment_id UUID NOT NULL,
  metric_definition_id UUID NOT NULL,
  metric_definition_version INTEGER NOT NULL,
  baseline_value DECIMAL(30,10),
  target_value DECIMAL(30,10) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  period_start TIMESTAMPTZ(6) NOT NULL,
  period_end TIMESTAMPTZ(6) NOT NULL,
  budget_amount DECIMAL(30,10),
  budget_currency CHAR(3),
  activated_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  cancelled_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_targets_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_targets_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_targets_tenant_id_code_key UNIQUE (tenant_id, code),
  CONSTRAINT marketing_targets_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_targets_period_check CHECK (period_end > period_start),
  CONSTRAINT marketing_targets_budget_check CHECK (
    (budget_amount IS NULL AND budget_currency IS NULL)
    OR (budget_amount >= 0 AND budget_currency IS NOT NULL)
  ),
  CONSTRAINT marketing_targets_axis_check CHECK (
    (axis = 'REGION' AND region_id IS NOT NULL AND customer_segment_id IS NULL)
    OR (
      axis = 'CUSTOMER_SEGMENT'
      AND region_id IS NULL
      AND customer_segment_id IS NOT NULL
    )
  ),
  CONSTRAINT marketing_targets_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_product_fkey
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.marketing_products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_region_fkey
    FOREIGN KEY (tenant_id, region_id)
    REFERENCES public.marketing_regions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_customer_segment_fkey
    FOREIGN KEY (tenant_id, customer_segment_id)
    REFERENCES public.marketing_customer_segments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_objective_value_fkey
    FOREIGN KEY (
      tenant_id, objective_id, objective_version, strategy_id, strategy_version,
      value_definition_id, value_version_id, value_version_number
    )
    REFERENCES public.objective_value_versions(
      tenant_id, objective_id, objective_version, strategy_id, strategy_version,
      value_definition_id, value_version_id, value_version_number
    ) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_objective_role_fkey
    FOREIGN KEY (
      tenant_id, objective_id, objective_version, responsible_role_assignment_id
    )
    REFERENCES public.objective_role_assignments(
      tenant_id, objective_id, objective_version, role_assignment_id
    ) ON DELETE RESTRICT,
  CONSTRAINT marketing_targets_objective_metric_fkey
    FOREIGN KEY (
      tenant_id, objective_id, objective_version,
      metric_definition_id, metric_definition_version
    )
    REFERENCES public.objective_metric_definitions(
      tenant_id, objective_id, objective_version,
      metric_definition_id, metric_definition_version
    ) ON DELETE RESTRICT
);

CREATE INDEX marketing_targets_matrix_idx
  ON public.marketing_targets(tenant_id, product_id, axis, region_id, customer_segment_id, status);
CREATE INDEX marketing_targets_objective_idx
  ON public.marketing_targets(tenant_id, objective_id, objective_version, status);

CREATE TABLE public.marketing_action_plans (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  target_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status public."MarketingActionPlanStatus" NOT NULL DEFAULT 'DRAFT',
  responsible_role_assignment_id UUID NOT NULL,
  period_start TIMESTAMPTZ(6) NOT NULL,
  period_end TIMESTAMPTZ(6) NOT NULL,
  planned_budget_amount DECIMAL(30,10),
  planned_budget_currency CHAR(3),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_action_plans_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_action_plans_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_action_plans_tenant_id_id_version_key
    UNIQUE (tenant_id, id, version),
  CONSTRAINT marketing_action_plans_tenant_id_code_version_key
    UNIQUE (tenant_id, code, version),
  CONSTRAINT marketing_action_plans_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_action_plans_period_check CHECK (period_end > period_start),
  CONSTRAINT marketing_action_plans_budget_check CHECK (
    (planned_budget_amount IS NULL AND planned_budget_currency IS NULL)
    OR (planned_budget_amount >= 0 AND planned_budget_currency IS NOT NULL)
  ),
  CONSTRAINT marketing_action_plans_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_plans_target_fkey
    FOREIGN KEY (tenant_id, target_id)
    REFERENCES public.marketing_targets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_plans_responsible_role_fkey
    FOREIGN KEY (tenant_id, responsible_role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_plans_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX marketing_action_plans_target_idx
  ON public.marketing_action_plans(tenant_id, target_id, status);

CREATE TABLE public.marketing_action_items (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  plan_version INTEGER NOT NULL,
  code VARCHAR(100) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  ordinal INTEGER NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status public."MarketingActionItemStatus" NOT NULL DEFAULT 'PLANNED',
  responsible_role_assignment_id UUID NOT NULL,
  linked_task_id UUID,
  linked_task_version INTEGER,
  contribution_type public."MarketingContributionType" NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  acceptance_evidence_id UUID,
  acceptance_evidence_version INTEGER,
  due_at TIMESTAMPTZ(6) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_action_items_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_action_items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT marketing_action_items_plan_identity_key
    UNIQUE (tenant_id, plan_id, plan_version, id),
  CONSTRAINT marketing_action_items_plan_code_key UNIQUE (tenant_id, plan_id, code),
  CONSTRAINT marketing_action_items_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_action_items_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT marketing_action_items_task_pair_check CHECK (
    (linked_task_id IS NULL AND linked_task_version IS NULL)
    OR (linked_task_id IS NOT NULL AND linked_task_version IS NOT NULL)
  ),
  CONSTRAINT marketing_action_items_acceptance_pair_check CHECK (
    (acceptance_evidence_id IS NULL AND acceptance_evidence_version IS NULL)
    OR (acceptance_evidence_id IS NOT NULL AND acceptance_evidence_version IS NOT NULL)
  ),
  CONSTRAINT marketing_action_items_plan_fkey
    FOREIGN KEY (tenant_id, plan_id, plan_version)
    REFERENCES public.marketing_action_plans(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_items_role_fkey
    FOREIGN KEY (tenant_id, responsible_role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_items_task_fkey
    FOREIGN KEY (tenant_id, linked_task_id, linked_task_version)
    REFERENCES public.tasks(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_items_acceptance_evidence_fkey
    FOREIGN KEY (tenant_id, acceptance_evidence_id, acceptance_evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_items_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX marketing_action_items_plan_idx
  ON public.marketing_action_items(tenant_id, plan_id, plan_version, status, ordinal);
CREATE INDEX marketing_action_items_task_idx
  ON public.marketing_action_items(tenant_id, linked_task_id, linked_task_version)
  WHERE linked_task_id IS NOT NULL;

CREATE TABLE public.marketing_action_item_contributors (
  tenant_id UUID NOT NULL,
  action_item_id UUID NOT NULL,
  role_assignment_id UUID NOT NULL,
  contribution_type public."MarketingContributionType" NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_action_item_contributors_pkey
    PRIMARY KEY (tenant_id, action_item_id, role_assignment_id),
  CONSTRAINT marketing_action_item_contributors_item_fkey
    FOREIGN KEY (tenant_id, action_item_id)
    REFERENCES public.marketing_action_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_item_contributors_role_fkey
    FOREIGN KEY (tenant_id, role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX marketing_action_item_contributors_role_idx
  ON public.marketing_action_item_contributors(
    tenant_id, role_assignment_id, contribution_type
  );

CREATE TABLE public.marketing_action_item_dependencies (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  predecessor_item_id UUID NOT NULL,
  successor_item_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketing_action_item_dependencies_pkey PRIMARY KEY (id),
  CONSTRAINT marketing_action_item_dependencies_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT marketing_action_item_dependencies_edge_key
    UNIQUE (tenant_id, plan_id, predecessor_item_id, successor_item_id),
  CONSTRAINT marketing_action_item_dependencies_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT marketing_action_item_dependencies_self_check
    CHECK (predecessor_item_id <> successor_item_id),
  CONSTRAINT marketing_action_item_dependencies_predecessor_fkey
    FOREIGN KEY (tenant_id, predecessor_item_id)
    REFERENCES public.marketing_action_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_item_dependencies_successor_fkey
    FOREIGN KEY (tenant_id, successor_item_id)
    REFERENCES public.marketing_action_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketing_action_item_dependencies_plan_fkey
    FOREIGN KEY (tenant_id, plan_id)
    REFERENCES public.marketing_action_plans(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX marketing_action_item_dependencies_successor_idx
  ON public.marketing_action_item_dependencies(tenant_id, successor_item_id);

CREATE OR REPLACE FUNCTION public.marketing_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable marketing evidence/history', TG_TABLE_NAME
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER marketing_observations_append_only
  BEFORE UPDATE OR DELETE ON public.marketing_observations
  FOR EACH ROW EXECUTE FUNCTION public.marketing_append_only_guard();
CREATE TRIGGER marketing_observation_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.marketing_observation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.marketing_append_only_guard();
CREATE TRIGGER marketing_insight_observations_append_only
  BEFORE UPDATE OR DELETE ON public.marketing_insight_observations
  FOR EACH ROW EXECUTE FUNCTION public.marketing_append_only_guard();
CREATE TRIGGER marketing_action_item_dependencies_append_only
  BEFORE UPDATE OR DELETE ON public.marketing_action_item_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.marketing_append_only_guard();

CREATE OR REPLACE FUNCTION public.marketing_observation_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  trusted_source_version VARCHAR(200);
  trusted_content_hash VARCHAR(64);
  trusted_status public."EvidenceStatus";
BEGIN
  SELECT source_version, content_hash, status
  INTO trusted_source_version, trusted_content_hash, trusted_status
  FROM public.evidence
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.evidence_id
    AND version = NEW.evidence_version;

  IF trusted_source_version IS NULL
    OR trusted_source_version <> NEW.source_version
    OR trusted_content_hash <> NEW.content_hash
    OR trusted_status <> 'ACTIVE'
  THEN
    RAISE EXCEPTION 'Marketing observation evidence must match an ACTIVE immutable source snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_observation_evidence_snapshot_trigger
  BEFORE INSERT ON public.marketing_observation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.marketing_observation_evidence_guard();

CREATE OR REPLACE FUNCTION public.marketing_insight_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Marketing insight history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.code, NEW.version, NEW.previous_version_id,
    NEW.previous_version_number, NEW.title, NEW.statement, NEW.origin,
    NEW.agent_run_id, NEW.created_by_user_id, NEW.idempotency_key, NEW.request_hash,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.code, OLD.version, OLD.previous_version_id,
    OLD.previous_version_number, OLD.title, OLD.statement, OLD.origin,
    OLD.agent_run_id, OLD.created_by_user_id, OLD.idempotency_key, OLD.request_hash,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Marketing insight version content is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Marketing insight revision must advance exactly once'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'CANDIDATE' AND NEW.status = 'UNDER_REVIEW')
    OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'PUBLISHED')
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'Invalid marketing insight status transition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('APPROVED', 'REJECTED', 'PUBLISHED')
    AND (
      NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id = NEW.created_by_user_id
      OR NEW.reviewed_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'Marketing insight requires an independent human reviewer'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PUBLISHED'
    AND (
      NEW.published_by_user_id IS NULL
      OR NEW.published_by_user_id = NEW.created_by_user_id
      OR NEW.published_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'Marketing insight publisher must be independent from the maker'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_insights_state_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_insights
  FOR EACH ROW EXECUTE FUNCTION public.marketing_insight_state_guard();

CREATE OR REPLACE FUNCTION public.marketing_target_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  references_ready BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  SELECT (
    product.status = 'ACTIVE'
    AND (NEW.region_id IS NULL OR region.status = 'ACTIVE')
    AND (NEW.customer_segment_id IS NULL OR segment.status = 'ACTIVE')
    AND strategy.status = 'ACTIVE'
    AND strategy.effective_from <= NEW.period_start
    AND (strategy.effective_to IS NULL OR strategy.effective_to >= NEW.period_end)
    AND (
      NEW.budget_amount IS NULL
      OR (
        strategy.budget_amount IS NOT NULL
        AND strategy.budget_currency = NEW.budget_currency
        AND NEW.budget_amount <= strategy.budget_amount
      )
    )
    AND objective.status IN ('ACTIVE', 'AT_RISK')
    AND objective.effective_from <= NEW.period_start
    AND (objective.effective_to IS NULL OR objective.effective_to >= NEW.period_end)
    AND value.status = 'PUBLISHED'
    AND value.effective_from <= NEW.period_start
    AND (value.effective_to IS NULL OR value.effective_to >= NEW.period_end)
    AND metric.status = 'ACTIVE'
    AND assignment.status = 'ACTIVE'
    AND assignment.effective_from <= NEW.period_start
    AND (assignment.effective_to IS NULL OR assignment.effective_to >= NEW.period_end)
  )
  INTO references_ready
  FROM public.marketing_products product
  LEFT JOIN public.marketing_regions region
    ON region.tenant_id = NEW.tenant_id AND region.id = NEW.region_id
  LEFT JOIN public.marketing_customer_segments segment
    ON segment.tenant_id = NEW.tenant_id AND segment.id = NEW.customer_segment_id
  JOIN public.strategies strategy
    ON strategy.tenant_id = NEW.tenant_id
   AND strategy.id = NEW.strategy_id
   AND strategy.version = NEW.strategy_version
  JOIN public.objectives objective
    ON objective.tenant_id = NEW.tenant_id
   AND objective.id = NEW.objective_id
   AND objective.version = NEW.objective_version
  JOIN public.value_versions value
    ON value.tenant_id = NEW.tenant_id
   AND value.value_definition_id = NEW.value_definition_id
   AND value.id = NEW.value_version_id
   AND value.version = NEW.value_version_number
  JOIN public.metric_definitions metric
    ON metric.tenant_id = NEW.tenant_id
   AND metric.id = NEW.metric_definition_id
   AND metric.version = NEW.metric_definition_version
  JOIN public.role_assignments assignment
    ON assignment.tenant_id = NEW.tenant_id
   AND assignment.id = NEW.responsible_role_assignment_id
  WHERE product.tenant_id = NEW.tenant_id AND product.id = NEW.product_id;

  IF references_ready IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Marketing Target cannot activate until all governed references are active'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_targets_activation_trigger
  BEFORE INSERT OR UPDATE OF status ON public.marketing_targets
  FOR EACH ROW EXECUTE FUNCTION public.marketing_target_activation_guard();

CREATE OR REPLACE FUNCTION public.marketing_plan_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_record public.marketing_targets%ROWTYPE;
BEGIN
  SELECT * INTO target_record
  FROM public.marketing_targets
  WHERE tenant_id = NEW.tenant_id AND id = NEW.target_id;
  IF NOT FOUND
    OR NEW.period_start < target_record.period_start
    OR NEW.period_end > target_record.period_end
    OR (
      NEW.planned_budget_amount IS NOT NULL
      AND (
        target_record.budget_amount IS NULL
        OR NEW.planned_budget_currency <> target_record.budget_currency
        OR NEW.planned_budget_amount > target_record.budget_amount
      )
    )
  THEN
    RAISE EXCEPTION 'Marketing Action Plan exceeds Target period or budget'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_action_plans_scope_trigger
  BEFORE INSERT OR UPDATE ON public.marketing_action_plans
  FOR EACH ROW EXECUTE FUNCTION public.marketing_plan_scope_guard();

CREATE OR REPLACE FUNCTION public.marketing_action_item_task_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_target public.marketing_targets%ROWTYPE;
  linked_task public.tasks%ROWTYPE;
  plan_record public.marketing_action_plans%ROWTYPE;
BEGIN
  SELECT * INTO plan_record
  FROM public.marketing_action_plans
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.plan_id
    AND version = NEW.plan_version;
  IF NOT FOUND
    OR plan_record.status NOT IN ('DRAFT', 'ACTIVE')
    OR NEW.due_at > plan_record.period_end
  THEN
    RAISE EXCEPTION 'Marketing Action Item must fit within its Action Plan'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.linked_task_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO expected_target
  FROM public.marketing_targets
  WHERE tenant_id = NEW.tenant_id AND id = plan_record.target_id;
  SELECT * INTO linked_task
  FROM public.tasks
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.linked_task_id
    AND version = NEW.linked_task_version;
  IF NOT FOUND
    OR linked_task.strategy_id <> expected_target.strategy_id
    OR linked_task.strategy_version <> expected_target.strategy_version
    OR linked_task.objective_id <> expected_target.objective_id
    OR linked_task.objective_version <> expected_target.objective_version
    OR linked_task.value_definition_id <> expected_target.value_definition_id
    OR linked_task.value_version_id <> expected_target.value_version_id
    OR linked_task.value_version_number <> expected_target.value_version_number
  THEN
    RAISE EXCEPTION 'Linked Task must bind the exact Target Strategy, Objective and Value Version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_action_items_task_trigger
  BEFORE INSERT OR UPDATE ON public.marketing_action_items
  FOR EACH ROW EXECUTE FUNCTION public.marketing_action_item_task_guard();

CREATE OR REPLACE FUNCTION public.marketing_action_dependency_cycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reachable(item_id) AS (
      SELECT NEW.successor_item_id
      UNION
      SELECT dependency.successor_item_id
      FROM public.marketing_action_item_dependencies dependency
      JOIN reachable ON reachable.item_id = dependency.predecessor_item_id
      WHERE dependency.tenant_id = NEW.tenant_id
        AND dependency.plan_id = NEW.plan_id
    )
    SELECT 1 FROM reachable WHERE item_id = NEW.predecessor_item_id
  ) THEN
    RAISE EXCEPTION 'Marketing Action Item dependency graph cannot contain a cycle'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.marketing_action_items predecessor
    JOIN public.marketing_action_items successor
      ON successor.tenant_id = predecessor.tenant_id
     AND successor.plan_id = predecessor.plan_id
    WHERE predecessor.tenant_id = NEW.tenant_id
      AND predecessor.plan_id = NEW.plan_id
      AND predecessor.id = NEW.predecessor_item_id
      AND successor.id = NEW.successor_item_id
  ) THEN
    RAISE EXCEPTION 'Marketing Action Item dependencies must stay within one plan'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_action_dependencies_cycle_trigger
  BEFORE INSERT ON public.marketing_action_item_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.marketing_action_dependency_cycle_guard();

CREATE OR REPLACE FUNCTION public.marketing_master_data_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_referenced BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Marketing master data history cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.id <> OLD.id
    OR NEW.code <> OLD.code
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash
    OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Marketing master data identity is immutable and revision is CAS governed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'Retired Marketing master data is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' THEN
    IF TG_TABLE_NAME = 'marketing_products' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.marketing_targets target
        WHERE target.tenant_id = NEW.tenant_id
          AND target.product_id = NEW.id
          AND target.status IN ('DRAFT', 'ACTIVE')
      ) INTO is_referenced;
    ELSIF TG_TABLE_NAME = 'marketing_regions' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.marketing_targets target
        WHERE target.tenant_id = NEW.tenant_id
          AND target.region_id = NEW.id
          AND target.status IN ('DRAFT', 'ACTIVE')
      ) INTO is_referenced;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.marketing_targets target
        WHERE target.tenant_id = NEW.tenant_id
          AND target.customer_segment_id = NEW.id
          AND target.status IN ('DRAFT', 'ACTIVE')
      ) INTO is_referenced;
    END IF;
    IF is_referenced THEN
      RAISE EXCEPTION 'Referenced Marketing master data cannot retire'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Retired Marketing master data cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_products_governance_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_products
  FOR EACH ROW EXECUTE FUNCTION public.marketing_master_data_guard();
CREATE TRIGGER marketing_regions_governance_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_regions
  FOR EACH ROW EXECUTE FUNCTION public.marketing_master_data_guard();
CREATE TRIGGER marketing_customer_segments_governance_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_customer_segments
  FOR EACH ROW EXECUTE FUNCTION public.marketing_master_data_guard();

CREATE OR REPLACE FUNCTION public.marketing_target_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Marketing Target history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.code, NEW.product_id, NEW.axis, NEW.region_id,
    NEW.customer_segment_id, NEW.strategy_id, NEW.strategy_version,
    NEW.objective_id, NEW.objective_version, NEW.value_definition_id,
    NEW.value_version_id, NEW.value_version_number,
    NEW.responsible_role_assignment_id, NEW.metric_definition_id,
    NEW.metric_definition_version, NEW.baseline_value, NEW.target_value,
    NEW.unit, NEW.period_start, NEW.period_end, NEW.budget_amount,
    NEW.budget_currency, NEW.idempotency_key, NEW.request_hash,
    NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.code, OLD.product_id, OLD.axis, OLD.region_id,
    OLD.customer_segment_id, OLD.strategy_id, OLD.strategy_version,
    OLD.objective_id, OLD.objective_version, OLD.value_definition_id,
    OLD.value_version_id, OLD.value_version_number,
    OLD.responsible_role_assignment_id, OLD.metric_definition_id,
    OLD.metric_definition_version, OLD.baseline_value, OLD.target_value,
    OLD.unit, OLD.period_start, OLD.period_end, OLD.budget_amount,
    OLD.budget_currency, OLD.idempotency_key, OLD.request_hash,
    OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Marketing Target governed identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1
    OR NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'CANCELLED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('CLOSED', 'CANCELLED'))
    )
  THEN
    RAISE EXCEPTION 'Invalid Marketing Target transition or revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_targets_state_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_targets
  FOR EACH ROW EXECUTE FUNCTION public.marketing_target_state_guard();

CREATE OR REPLACE FUNCTION public.marketing_action_plan_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Marketing Action Plan history cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.code, NEW.version, NEW.target_id, NEW.title,
    NEW.description, NEW.responsible_role_assignment_id, NEW.period_start,
    NEW.period_end, NEW.planned_budget_amount, NEW.planned_budget_currency,
    NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.code, OLD.version, OLD.target_id, OLD.title,
    OLD.description, OLD.responsible_role_assignment_id, OLD.period_start,
    OLD.period_end, OLD.planned_budget_amount, OLD.planned_budget_currency,
    OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Marketing Action Plan governed content is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1
    OR NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'CANCELLED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'CANCELLED'))
    )
  THEN
    RAISE EXCEPTION 'Invalid Marketing Action Plan transition or revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM public.marketing_action_items item
        WHERE item.tenant_id = NEW.tenant_id
          AND item.plan_id = NEW.id
          AND item.plan_version = NEW.version
          AND item.status = 'COMPLETED'
      )
      OR EXISTS (
        SELECT 1
        FROM public.marketing_action_items item
        WHERE item.tenant_id = NEW.tenant_id
          AND item.plan_id = NEW.id
          AND item.plan_version = NEW.version
          AND item.status NOT IN ('COMPLETED', 'CANCELLED')
      )
    )
  THEN
    RAISE EXCEPTION 'Completed Marketing Action Plan requires accepted terminal items'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_action_plans_state_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_action_plans
  FOR EACH ROW EXECUTE FUNCTION public.marketing_action_plan_state_guard();

CREATE OR REPLACE FUNCTION public.marketing_action_item_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Marketing Action Item history cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.plan_id, NEW.plan_version, NEW.code, NEW.ordinal,
    NEW.title, NEW.description, NEW.responsible_role_assignment_id,
    NEW.linked_task_id, NEW.linked_task_version, NEW.contribution_type,
    NEW.acceptance_criteria, NEW.due_at, NEW.idempotency_key,
    NEW.request_hash, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.plan_id, OLD.plan_version, OLD.code, OLD.ordinal,
    OLD.title, OLD.description, OLD.responsible_role_assignment_id,
    OLD.linked_task_id, OLD.linked_task_version, OLD.contribution_type,
    OLD.acceptance_criteria, OLD.due_at, OLD.idempotency_key,
    OLD.request_hash, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Marketing Action Item governed content is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1
    OR NOT (
      (OLD.status = 'PLANNED' AND NEW.status IN ('ACTIVE', 'CANCELLED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('BLOCKED', 'COMPLETED', 'CANCELLED'))
      OR (OLD.status = 'BLOCKED' AND NEW.status IN ('ACTIVE', 'COMPLETED', 'CANCELLED'))
    )
  THEN
    RAISE EXCEPTION 'Invalid Marketing Action Item transition or revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED'
    AND (NEW.acceptance_evidence_id IS NULL OR NEW.acceptance_evidence_version IS NULL)
  THEN
    RAISE EXCEPTION 'Completed Marketing Action Item requires acceptance Evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER marketing_action_items_state_trigger
  BEFORE UPDATE OR DELETE ON public.marketing_action_items
  FOR EACH ROW EXECUTE FUNCTION public.marketing_action_item_state_guard();

CREATE TRIGGER marketing_action_item_contributors_append_only
  BEFORE UPDATE OR DELETE ON public.marketing_action_item_contributors
  FOR EACH ROW EXECUTE FUNCTION public.marketing_append_only_guard();

DO $$
DECLARE
  table_name TEXT;
  append_only_tables CONSTANT TEXT[] := ARRAY[
    'marketing_observations',
    'marketing_observation_evidence',
    'marketing_insight_observations',
    'marketing_action_item_contributors',
    'marketing_action_item_dependencies'
  ];
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'marketing_observations',
    'marketing_observation_evidence',
    'marketing_insights',
    'marketing_insight_observations',
    'marketing_products',
    'marketing_regions',
    'marketing_customer_segments',
    'marketing_targets',
    'marketing_action_plans',
    'marketing_action_items',
    'marketing_action_item_contributors',
    'marketing_action_item_dependencies'
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
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
      table_name
    );
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO enterprise_agent_app', table_name);
    IF table_name = ANY(append_only_tables) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO enterprise_agent_admin',
        table_name
      );
    ELSE
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO enterprise_agent_admin',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON TYPE
  public."MarketingObservationDimension",
  public."MarketingAssertionType",
  public."MarketingCandidateOrigin",
  public."MarketingEvidenceLinkType",
  public."MarketingInsightStatus",
  public."MarketingMasterDataStatus",
  public."MarketingTargetAxis",
  public."MarketingTargetStatus",
  public."MarketingActionPlanStatus",
  public."MarketingActionItemStatus",
  public."MarketingContributionType"
  TO enterprise_agent_app, enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.marketing_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_observation_evidence_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_insight_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_target_activation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_plan_scope_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_action_item_task_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_action_dependency_cycle_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_master_data_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_target_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_action_plan_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_action_item_state_guard() FROM PUBLIC;

COMMIT;
