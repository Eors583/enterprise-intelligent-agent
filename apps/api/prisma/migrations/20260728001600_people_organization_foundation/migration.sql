BEGIN;

CREATE TYPE public."CompetencyCategory" AS ENUM (
  'KNOWLEDGE', 'SKILL', 'EXPERIENCE', 'BEHAVIOR', 'TOOL'
);
CREATE TYPE public."CompetencyDefinitionStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE public."CompetencyVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE public."CompetencyAssessmentStatus" AS ENUM (
  'CANDIDATE', 'UNDER_REVIEW', 'EFFECTIVE', 'REJECTED', 'DISPUTED', 'SUPERSEDED'
);
CREATE TYPE public."CompetencyConfirmationRole" AS ENUM ('EMPLOYEE', 'MANAGER', 'HR');
CREATE TYPE public."CompetencyConfirmationDecision" AS ENUM (
  'CONFIRM', 'REJECT', 'REQUEST_MORE_EVIDENCE'
);
CREATE TYPE public."CompetencyAttributionFactor" AS ENUM (
  'GOAL_REASONABLENESS', 'RESOURCE', 'PERMISSION', 'PROCESS',
  'UPSTREAM_DOWNSTREAM', 'MARKET_CHANGE', 'CAPABILITY'
);
CREATE TYPE public."CompetencyAppealStatus" AS ENUM (
  'OPEN', 'UNDER_REVIEW', 'UPHELD', 'OVERTURNED', 'CLOSED'
);
CREATE TYPE public."DevelopmentPlanStatus" AS ENUM (
  'DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE public."DevelopmentActionType" AS ENUM (
  'PRACTICE_TASK', 'COURSE', 'MENTORING', 'SHADOWING', 'ASSESSMENT'
);
CREATE TYPE public."DevelopmentActionStatus" AS ENUM (
  'PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE public."TriangleResponsibility" AS ENUM ('CUSTOMER', 'SOLUTION', 'DELIVERY');
CREATE TYPE public."TriangleTeamStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE public."TriangleHealthDimension" AS ENUM (
  'TASK_RESPONSE_LATENCY', 'INPUT_OUTPUT_COMPLETENESS', 'PROCESS_RETURN_RATE',
  'COMMITMENT_FULFILLMENT', 'CUSTOMER_CLOSURE', 'SHARED_OBJECTIVE_RESULT'
);
CREATE TYPE public."TriangleHealthRating" AS ENUM ('HEALTHY', 'WATCH', 'AT_RISK');
CREATE TYPE public."OrganizationChangeType" AS ENUM (
  'ORG_UNIT_MOVE', 'ROLE_REASSIGNMENT', 'REPORTING_LINE',
  'TEAM_RECONFIGURATION', 'EMPLOYEE_OFFBOARDING'
);
CREATE TYPE public."OrganizationImpactArea" AS ENUM (
  'OBJECTIVE', 'PROCESS', 'PERMISSION', 'TASK', 'AGENT_ASSIGNMENT'
);
CREATE TYPE public."OrganizationImpactRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE public."OrganizationChangeStatus" AS ENUM (
  'PROPOSED', 'ANALYZED', 'CONFIRMED', 'APPLIED', 'REJECTED'
);

CREATE TABLE public.competency_definitions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  category public."CompetencyCategory" NOT NULL,
  description TEXT NOT NULL,
  status public."CompetencyDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
  current_version_id UUID,
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_definitions_pkey PRIMARY KEY (id),
  CONSTRAINT competency_definitions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_definitions_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT competency_definitions_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT competency_definitions_revision_check CHECK (revision > 0),
  CONSTRAINT competency_definitions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT competency_definitions_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.competency_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  competency_definition_id UUID NOT NULL,
  version INTEGER NOT NULL,
  status public."CompetencyVersionStatus" NOT NULL DEFAULT 'DRAFT',
  change_summary TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  activated_by_user_id UUID,
  activated_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_versions_pkey PRIMARY KEY (id),
  CONSTRAINT competency_versions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_versions_definition_id_key
    UNIQUE (tenant_id, competency_definition_id, id),
  CONSTRAINT competency_versions_identity_key
    UNIQUE (tenant_id, competency_definition_id, id, version),
  CONSTRAINT competency_versions_number_key
    UNIQUE (tenant_id, competency_definition_id, version),
  CONSTRAINT competency_versions_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT competency_versions_positive_check CHECK (version > 0 AND revision > 0),
  CONSTRAINT competency_versions_definition_fkey
    FOREIGN KEY (tenant_id, competency_definition_id)
    REFERENCES public.competency_definitions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_versions_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_versions_activator_fkey
    FOREIGN KEY (tenant_id, activated_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE public.competency_definitions
  ADD CONSTRAINT competency_definitions_current_version_fkey
  FOREIGN KEY (tenant_id, id, current_version_id)
  REFERENCES public.competency_versions(tenant_id, competency_definition_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX competency_versions_one_active_idx
  ON public.competency_versions(tenant_id, competency_definition_id)
  WHERE status = 'ACTIVE';

CREATE TABLE public.competency_levels (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  competency_definition_id UUID NOT NULL,
  competency_version_id UUID NOT NULL,
  competency_version INTEGER NOT NULL,
  level INTEGER NOT NULL,
  name VARCHAR(200) NOT NULL,
  task_complexity TEXT NOT NULL,
  evidence_requirements JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_levels_pkey PRIMARY KEY (id),
  CONSTRAINT competency_levels_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_levels_version_level_key
    UNIQUE (tenant_id, competency_version_id, level),
  CONSTRAINT competency_levels_range_check CHECK (level BETWEEN 1 AND 10),
  CONSTRAINT competency_levels_version_fkey
    FOREIGN KEY (tenant_id, competency_definition_id, competency_version_id, competency_version)
    REFERENCES public.competency_versions(tenant_id, competency_definition_id, id, version)
    ON DELETE RESTRICT
);

CREATE TABLE public.competency_behavior_anchors (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  competency_level_id UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  statement TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_behavior_anchors_pkey PRIMARY KEY (id),
  CONSTRAINT competency_behavior_anchors_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_behavior_anchors_ordinal_key
    UNIQUE (tenant_id, competency_level_id, ordinal),
  CONSTRAINT competency_behavior_anchors_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT competency_behavior_anchors_level_fkey
    FOREIGN KEY (tenant_id, competency_level_id)
    REFERENCES public.competency_levels(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.role_competency_requirements (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  competency_definition_id UUID NOT NULL,
  competency_version_id UUID NOT NULL,
  competency_version INTEGER NOT NULL,
  role_template_id UUID NOT NULL,
  role_version_id UUID NOT NULL,
  required_level INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT role_competency_requirements_pkey PRIMARY KEY (id),
  CONSTRAINT role_competency_requirements_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT role_competency_requirements_role_key
    UNIQUE (tenant_id, competency_version_id, role_version_id),
  CONSTRAINT role_competency_requirements_level_check CHECK (required_level BETWEEN 1 AND 10),
  CONSTRAINT role_competency_requirements_version_fkey
    FOREIGN KEY (tenant_id, competency_definition_id, competency_version_id, competency_version)
    REFERENCES public.competency_versions(tenant_id, competency_definition_id, id, version)
    ON DELETE RESTRICT,
  CONSTRAINT role_competency_requirements_level_fkey
    FOREIGN KEY (tenant_id, competency_version_id, required_level)
    REFERENCES public.competency_levels(tenant_id, competency_version_id, level)
    ON DELETE RESTRICT,
  CONSTRAINT role_competency_requirements_role_fkey
    FOREIGN KEY (tenant_id, role_template_id, role_version_id)
    REFERENCES public.agent_versions(tenant_id, template_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.competency_evidence (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  subject_user_id UUID NOT NULL,
  competency_definition_id UUID NOT NULL,
  competency_version_id UUID NOT NULL,
  competency_version INTEGER NOT NULL,
  demonstrated_level INTEGER NOT NULL,
  evidence_id UUID NOT NULL,
  evidence_version INTEGER NOT NULL,
  task_id UUID,
  task_version INTEGER,
  deliverable_id UUID,
  deliverable_version INTEGER,
  metric_observation_id UUID,
  metric_observation_version INTEGER,
  review_reference VARCHAR(500),
  valid_from TIMESTAMPTZ(6) NOT NULL,
  valid_until TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_evidence_pkey PRIMARY KEY (id),
  CONSTRAINT competency_evidence_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_evidence_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT competency_evidence_level_check CHECK (demonstrated_level BETWEEN 1 AND 10),
  CONSTRAINT competency_evidence_validity_check
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT competency_evidence_trace_check CHECK (
    task_id IS NOT NULL OR deliverable_id IS NOT NULL
    OR metric_observation_id IS NOT NULL OR review_reference IS NOT NULL
  ),
  CONSTRAINT competency_evidence_task_pair_check CHECK ((task_id IS NULL) = (task_version IS NULL)),
  CONSTRAINT competency_evidence_deliverable_pair_check
    CHECK ((deliverable_id IS NULL) = (deliverable_version IS NULL)),
  CONSTRAINT competency_evidence_metric_pair_check
    CHECK ((metric_observation_id IS NULL) = (metric_observation_version IS NULL)),
  CONSTRAINT competency_evidence_subject_fkey
    FOREIGN KEY (tenant_id, subject_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_level_fkey
    FOREIGN KEY (tenant_id, competency_version_id, demonstrated_level)
    REFERENCES public.competency_levels(tenant_id, competency_version_id, level) ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_version_fkey
    FOREIGN KEY (tenant_id, competency_definition_id, competency_version_id, competency_version)
    REFERENCES public.competency_versions(tenant_id, competency_definition_id, id, version)
    ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_evidence_fkey
    FOREIGN KEY (tenant_id, evidence_id, evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_task_fkey
    FOREIGN KEY (tenant_id, task_id, task_version)
    REFERENCES public.tasks(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_deliverable_fkey
    FOREIGN KEY (tenant_id, deliverable_id, deliverable_version)
    REFERENCES public.deliverables(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_metric_fkey
    FOREIGN KEY (tenant_id, metric_observation_id, metric_observation_version)
    REFERENCES public.metric_observations(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT competency_evidence_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX competency_evidence_subject_idx
  ON public.competency_evidence(tenant_id, subject_user_id, competency_version_id, valid_from DESC);

CREATE TABLE public.competency_assessments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  subject_user_id UUID NOT NULL,
  competency_definition_id UUID NOT NULL,
  competency_version_id UUID NOT NULL,
  competency_version INTEGER NOT NULL,
  proposed_level INTEGER NOT NULL,
  effective_level INTEGER,
  confidence DECIMAL(12,10) NOT NULL,
  status public."CompetencyAssessmentStatus" NOT NULL DEFAULT 'CANDIDATE',
  agent_run_id UUID NOT NULL,
  supersedes_assessment_id UUID,
  supersedes_assessment_revision INTEGER,
  summary TEXT NOT NULL,
  required_confirmation_roles JSONB NOT NULL DEFAULT '["EMPLOYEE","MANAGER","HR"]'::jsonb,
  created_by_user_id UUID NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_assessments_pkey PRIMARY KEY (id),
  CONSTRAINT competency_assessments_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_assessments_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT competency_assessments_level_check
    CHECK (proposed_level BETWEEN 1 AND 10 AND (effective_level IS NULL OR effective_level BETWEEN 1 AND 10)),
  CONSTRAINT competency_assessments_confidence_check CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT competency_assessments_revision_check CHECK (revision > 0),
  CONSTRAINT competency_assessments_effective_pair_check CHECK (
    (status = 'EFFECTIVE' AND effective_level IS NOT NULL)
    OR (status <> 'EFFECTIVE' AND effective_level IS NULL)
  ),
  CONSTRAINT competency_assessments_supersedes_pair_check CHECK (
    (supersedes_assessment_id IS NULL) = (supersedes_assessment_revision IS NULL)
  ),
  CONSTRAINT competency_assessments_subject_fkey
    FOREIGN KEY (tenant_id, subject_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_assessments_version_fkey
    FOREIGN KEY (tenant_id, competency_definition_id, competency_version_id, competency_version)
    REFERENCES public.competency_versions(tenant_id, competency_definition_id, id, version)
    ON DELETE RESTRICT,
  CONSTRAINT competency_assessments_level_fkey
    FOREIGN KEY (tenant_id, competency_version_id, proposed_level)
    REFERENCES public.competency_levels(tenant_id, competency_version_id, level) ON DELETE RESTRICT,
  CONSTRAINT competency_assessments_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_assessments_supersedes_fkey
    FOREIGN KEY (tenant_id, supersedes_assessment_id)
    REFERENCES public.competency_assessments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_assessments_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX competency_assessments_subject_status_idx
  ON public.competency_assessments(tenant_id, subject_user_id, status, updated_at DESC);

CREATE TABLE public.competency_assessment_attributions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  factor public."CompetencyAttributionFactor" NOT NULL,
  contribution DECIMAL(12,10) NOT NULL,
  statement TEXT NOT NULL,
  evidence_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_assessment_attributions_pkey PRIMARY KEY (id),
  CONSTRAINT competency_assessment_attributions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_assessment_attributions_factor_key
    UNIQUE (tenant_id, assessment_id, factor),
  CONSTRAINT competency_assessment_attributions_contribution_check
    CHECK (contribution BETWEEN 0 AND 1),
  CONSTRAINT competency_assessment_attributions_assessment_fkey
    FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES public.competency_assessments(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.competency_assessment_confirmations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  role public."CompetencyConfirmationRole" NOT NULL,
  decision public."CompetencyConfirmationDecision" NOT NULL,
  actor_user_id UUID NOT NULL,
  assessment_revision INTEGER NOT NULL,
  comment VARCHAR(2000) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_assessment_confirmations_pkey PRIMARY KEY (id),
  CONSTRAINT competency_assessment_confirmations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_assessment_confirmations_role_key UNIQUE (tenant_id, assessment_id, role),
  CONSTRAINT competency_assessment_confirmations_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT competency_assessment_confirmations_assessment_fkey
    FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES public.competency_assessments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_assessment_confirmations_actor_fkey
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.competency_appeals (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  subject_user_id UUID NOT NULL,
  status public."CompetencyAppealStatus" NOT NULL DEFAULT 'OPEN',
  reason TEXT NOT NULL,
  resolution TEXT,
  opened_by_user_id UUID NOT NULL,
  resolved_by_user_id UUID,
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_appeals_pkey PRIMARY KEY (id),
  CONSTRAINT competency_appeals_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_appeals_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT competency_appeals_assessment_fkey
    FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES public.competency_assessments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_appeals_subject_fkey
    FOREIGN KEY (tenant_id, subject_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_appeals_opener_fkey
    FOREIGN KEY (tenant_id, opened_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_appeals_resolver_fkey
    FOREIGN KEY (tenant_id, resolved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX competency_appeals_one_open_idx
  ON public.competency_appeals(tenant_id, assessment_id)
  WHERE status IN ('OPEN', 'UNDER_REVIEW');

CREATE TABLE public.competency_appeal_evidence (
  tenant_id UUID NOT NULL,
  appeal_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  evidence_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_appeal_evidence_pkey PRIMARY KEY (tenant_id, appeal_id, evidence_id),
  CONSTRAINT competency_appeal_evidence_appeal_fkey
    FOREIGN KEY (tenant_id, appeal_id)
    REFERENCES public.competency_appeals(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_appeal_evidence_evidence_fkey
    FOREIGN KEY (tenant_id, evidence_id, evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE TABLE public.competency_gaps (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  role_requirement_id UUID NOT NULL,
  required_level INTEGER NOT NULL,
  effective_level INTEGER NOT NULL,
  gap INTEGER GENERATED ALWAYS AS (GREATEST(required_level - effective_level, 0)) STORED,
  attribution_summary TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT competency_gaps_pkey PRIMARY KEY (id),
  CONSTRAINT competency_gaps_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT competency_gaps_assessment_requirement_key
    UNIQUE (tenant_id, assessment_id, role_requirement_id, version),
  CONSTRAINT competency_gaps_level_check
    CHECK (required_level BETWEEN 1 AND 10 AND effective_level BETWEEN 1 AND 10),
  CONSTRAINT competency_gaps_assessment_fkey
    FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES public.competency_assessments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT competency_gaps_requirement_fkey
    FOREIGN KEY (tenant_id, role_requirement_id)
    REFERENCES public.role_competency_requirements(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.development_plans (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  subject_user_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  gap_id UUID NOT NULL,
  status public."DevelopmentPlanStatus" NOT NULL DEFAULT 'DRAFT',
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT development_plans_pkey PRIMARY KEY (id),
  CONSTRAINT development_plans_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT development_plans_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT development_plans_assessment_gap_key UNIQUE (tenant_id, assessment_id, gap_id, version),
  CONSTRAINT development_plans_subject_fkey
    FOREIGN KEY (tenant_id, subject_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT development_plans_assessment_fkey
    FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES public.competency_assessments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT development_plans_gap_fkey
    FOREIGN KEY (tenant_id, gap_id)
    REFERENCES public.competency_gaps(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT development_plans_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.development_actions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  development_plan_id UUID NOT NULL,
  type public."DevelopmentActionType" NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  linked_task_id UUID,
  linked_task_version INTEGER,
  mentor_user_id UUID,
  due_at TIMESTAMPTZ(6) NOT NULL,
  verification_method TEXT NOT NULL,
  verification_evidence_id UUID,
  verification_evidence_version INTEGER,
  status public."DevelopmentActionStatus" NOT NULL DEFAULT 'PLANNED',
  completed_at TIMESTAMPTZ(6),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT development_actions_pkey PRIMARY KEY (id),
  CONSTRAINT development_actions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT development_actions_task_pair_check
    CHECK ((linked_task_id IS NULL) = (linked_task_version IS NULL)),
  CONSTRAINT development_actions_evidence_pair_check
    CHECK ((verification_evidence_id IS NULL) = (verification_evidence_version IS NULL)),
  CONSTRAINT development_actions_completion_check CHECK (
    (status = 'COMPLETED' AND verification_evidence_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)
  ),
  CONSTRAINT development_actions_plan_fkey
    FOREIGN KEY (tenant_id, development_plan_id)
    REFERENCES public.development_plans(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT development_actions_task_fkey
    FOREIGN KEY (tenant_id, linked_task_id, linked_task_version)
    REFERENCES public.tasks(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT development_actions_mentor_fkey
    FOREIGN KEY (tenant_id, mentor_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT development_actions_evidence_fkey
    FOREIGN KEY (tenant_id, verification_evidence_id, verification_evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_teams (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  status public."TriangleTeamStatus" NOT NULL DEFAULT 'DRAFT',
  objective_id UUID NOT NULL,
  objective_version INTEGER NOT NULL,
  arbiter_role_assignment_id UUID NOT NULL,
  current_health_policy_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_teams_pkey PRIMARY KEY (id),
  CONSTRAINT triangle_teams_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT triangle_teams_tenant_code_key UNIQUE (tenant_id, code),
  CONSTRAINT triangle_teams_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT triangle_teams_objective_fkey
    FOREIGN KEY (tenant_id, objective_id, objective_version)
    REFERENCES public.objectives(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT triangle_teams_arbiter_fkey
    FOREIGN KEY (tenant_id, arbiter_role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT triangle_teams_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_team_members (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  responsibility public."TriangleResponsibility" NOT NULL,
  role_assignment_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_team_members_pkey PRIMARY KEY (tenant_id, team_id, responsibility),
  CONSTRAINT triangle_team_members_assignment_key UNIQUE (tenant_id, team_id, role_assignment_id),
  CONSTRAINT triangle_team_members_team_fkey
    FOREIGN KEY (tenant_id, team_id)
    REFERENCES public.triangle_teams(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT triangle_team_members_assignment_fkey
    FOREIGN KEY (tenant_id, role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_team_metrics (
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  metric_definition_id UUID NOT NULL,
  metric_definition_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_team_metrics_pkey
    PRIMARY KEY (tenant_id, team_id, metric_definition_id, metric_definition_version),
  CONSTRAINT triangle_team_metrics_team_fkey
    FOREIGN KEY (tenant_id, team_id)
    REFERENCES public.triangle_teams(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT triangle_team_metrics_metric_fkey
    FOREIGN KEY (tenant_id, metric_definition_id, metric_definition_version)
    REFERENCES public.metric_definitions(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_health_policies (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  version INTEGER NOT NULL,
  thresholds JSONB NOT NULL,
  weights JSONB NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_health_policies_pkey PRIMARY KEY (id),
  CONSTRAINT triangle_health_policies_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT triangle_health_policies_team_version_key UNIQUE (tenant_id, team_id, version),
  CONSTRAINT triangle_health_policies_team_fkey
    FOREIGN KEY (tenant_id, team_id)
    REFERENCES public.triangle_teams(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT triangle_health_policies_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_health_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  team_id UUID NOT NULL,
  team_revision INTEGER NOT NULL,
  policy_id UUID NOT NULL,
  policy_version INTEGER NOT NULL,
  score DECIMAL(12,8) NOT NULL,
  rating public."TriangleHealthRating" NOT NULL,
  period_start TIMESTAMPTZ(6) NOT NULL,
  period_end TIMESTAMPTZ(6) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_health_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT triangle_health_snapshots_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT triangle_health_snapshots_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT triangle_health_snapshots_score_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT triangle_health_snapshots_period_check CHECK (period_end > period_start),
  CONSTRAINT triangle_health_snapshots_team_fkey
    FOREIGN KEY (tenant_id, team_id)
    REFERENCES public.triangle_teams(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT triangle_health_snapshots_policy_fkey
    FOREIGN KEY (tenant_id, team_id, policy_version)
    REFERENCES public.triangle_health_policies(tenant_id, team_id, version) ON DELETE RESTRICT,
  CONSTRAINT triangle_health_snapshots_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_health_components (
  tenant_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  dimension public."TriangleHealthDimension" NOT NULL,
  observed_value DECIMAL(30,10) NOT NULL,
  normalized_score DECIMAL(12,8) NOT NULL,
  weight DECIMAL(12,10) NOT NULL,
  weighted_score DECIMAL(12,8) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_health_components_pkey PRIMARY KEY (tenant_id, snapshot_id, dimension),
  CONSTRAINT triangle_health_components_range_check CHECK (
    normalized_score BETWEEN 0 AND 100 AND weight BETWEEN 0 AND 1
    AND weighted_score BETWEEN 0 AND 100
  ),
  CONSTRAINT triangle_health_components_snapshot_fkey
    FOREIGN KEY (tenant_id, snapshot_id)
    REFERENCES public.triangle_health_snapshots(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.triangle_health_snapshot_evidence (
  tenant_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  evidence_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT triangle_health_snapshot_evidence_pkey
    PRIMARY KEY (tenant_id, snapshot_id, evidence_id),
  CONSTRAINT triangle_health_snapshot_evidence_snapshot_fkey
    FOREIGN KEY (tenant_id, snapshot_id)
    REFERENCES public.triangle_health_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT triangle_health_snapshot_evidence_evidence_fkey
    FOREIGN KEY (tenant_id, evidence_id, evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE TABLE public.organization_change_proposals (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  type public."OrganizationChangeType" NOT NULL,
  subject_id UUID NOT NULL,
  status public."OrganizationChangeStatus" NOT NULL DEFAULT 'PROPOSED',
  effective_at TIMESTAMPTZ(6) NOT NULL,
  reason TEXT NOT NULL,
  proposed_change JSONB NOT NULL,
  proposed_by_user_id UUID NOT NULL,
  confirmed_by_user_id UUID,
  applied_by_user_id UUID,
  confirmed_at TIMESTAMPTZ(6),
  applied_at TIMESTAMPTZ(6),
  decision_comment VARCHAR(2000),
  revision INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_change_proposals_pkey PRIMARY KEY (id),
  CONSTRAINT organization_change_proposals_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT organization_change_proposals_tenant_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT organization_change_proposals_proposer_fkey
    FOREIGN KEY (tenant_id, proposed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT organization_change_proposals_confirmer_fkey
    FOREIGN KEY (tenant_id, confirmed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT organization_change_proposals_applier_fkey
    FOREIGN KEY (tenant_id, applied_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.organization_impact_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  proposal_revision INTEGER NOT NULL,
  analyzed_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_impact_reports_pkey PRIMARY KEY (id),
  CONSTRAINT organization_impact_reports_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT organization_impact_reports_proposal_revision_key
    UNIQUE (tenant_id, proposal_id, proposal_revision),
  CONSTRAINT organization_impact_reports_proposal_fkey
    FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES public.organization_change_proposals(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT organization_impact_reports_analyzer_fkey
    FOREIGN KEY (tenant_id, analyzed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.organization_impact_items (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  report_id UUID NOT NULL,
  area public."OrganizationImpactArea" NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id UUID NOT NULL,
  risk public."OrganizationImpactRisk" NOT NULL,
  current_state JSONB NOT NULL,
  proposed_state JSONB NOT NULL,
  mitigation TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_impact_items_pkey PRIMARY KEY (id),
  CONSTRAINT organization_impact_items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT organization_impact_items_report_resource_key
    UNIQUE (tenant_id, report_id, area, resource_type, resource_id),
  CONSTRAINT organization_impact_items_report_fkey
    FOREIGN KEY (tenant_id, report_id)
    REFERENCES public.organization_impact_reports(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.organization_change_confirmations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  decision VARCHAR(16) NOT NULL,
  actor_user_id UUID NOT NULL,
  proposal_revision INTEGER NOT NULL,
  comment VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_change_confirmations_pkey PRIMARY KEY (id),
  CONSTRAINT organization_change_confirmations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT organization_change_confirmations_decision_check CHECK (decision IN ('CONFIRM','REJECT')),
  CONSTRAINT organization_change_confirmations_proposal_fkey
    FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES public.organization_change_proposals(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT organization_change_confirmations_actor_fkey
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.people_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Governed people and organization history is append-only'
    USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE FUNCTION public.competency_assessment_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Competency Assessment history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.agent_runs r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.agent_run_id AND r.status = 'SUCCEEDED'
    ) THEN
      RAISE EXCEPTION 'Competency Assessment requires a succeeded tenant-bound Agent Run'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_assessment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.competency_assessments prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.id = NEW.supersedes_assessment_id
        AND prior.subject_user_id = NEW.subject_user_id
        AND prior.competency_version_id = NEW.competency_version_id
        AND prior.revision = NEW.supersedes_assessment_revision
        AND prior.status IN ('EFFECTIVE', 'REJECTED', 'DISPUTED')
    ) THEN
      RAISE EXCEPTION 'Reassessment must supersede the current eligible conclusion for the same employee and competency'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.competency_assessment_attributions a
      WHERE FALSE
    ) THEN
      -- Attribution rows are inserted after the candidate in the same transaction.
      NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Competency Assessment revision must advance by one' USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'EFFECTIVE' THEN
    FOR required_role IN SELECT jsonb_array_elements_text(NEW.required_confirmation_roles)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.competency_assessment_confirmations c
        WHERE c.tenant_id = NEW.tenant_id AND c.assessment_id = NEW.id
          AND c.role::text = required_role AND c.decision = 'CONFIRM'
      ) THEN
        RAISE EXCEPTION 'AI candidate cannot become effective without every required human confirmation'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
    NEW.effective_level := NEW.proposed_level;
  ELSE
    NEW.effective_level := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER competency_assessments_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.competency_assessments
  FOR EACH ROW EXECUTE FUNCTION public.competency_assessment_guard();

CREATE OR REPLACE FUNCTION public.competency_assessment_attribution_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Assessment attribution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER competency_assessment_attribution_guard_trigger
  BEFORE UPDATE OR DELETE ON public.competency_assessment_attributions
  FOR EACH ROW EXECUTE FUNCTION public.competency_assessment_attribution_guard();

CREATE OR REPLACE FUNCTION public.competency_assessment_attribution_complete_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.competency_assessment_attributions a
    WHERE a.tenant_id = NEW.tenant_id AND a.assessment_id = NEW.id
      AND a.factor = 'CAPABILITY'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.competency_assessment_attributions a
    WHERE a.tenant_id = NEW.tenant_id AND a.assessment_id = NEW.id
      AND a.factor <> 'CAPABILITY'
  ) THEN
    RAISE EXCEPTION 'Assessment must separate capability attribution from contextual causes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER competency_assessment_attribution_complete_trigger
  AFTER INSERT ON public.competency_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.competency_assessment_attribution_complete_guard();

CREATE OR REPLACE FUNCTION public.competency_confirmation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assessment public.competency_assessments%ROWTYPE;
BEGIN
  SELECT * INTO assessment
  FROM public.competency_assessments a
  WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assessment_id;
  IF NEW.actor_user_id = assessment.created_by_user_id THEN
    RAISE EXCEPTION 'Assessment maker cannot act as a human checker'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.role = 'EMPLOYEE' AND NEW.actor_user_id <> assessment.subject_user_id THEN
    RAISE EXCEPTION 'Employee confirmation must be made by the assessed employee'
      USING ERRCODE = '23514';
  END IF;
  IF NOT assessment.required_confirmation_roles ? NEW.role::text THEN
    RAISE EXCEPTION 'Confirmation role is not required by the assessment policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER competency_confirmation_guard_trigger
  BEFORE INSERT ON public.competency_assessment_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.competency_confirmation_guard();

CREATE OR REPLACE FUNCTION public.triangle_team_activation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_count INTEGER;
  assignment_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Triangle Team history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Triangle Team revision must advance by one' USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' THEN
    SELECT count(*), count(DISTINCT m.role_assignment_id)
      INTO member_count, assignment_count
      FROM public.triangle_team_members m
      JOIN public.role_assignments ra
        ON ra.tenant_id = m.tenant_id AND ra.id = m.role_assignment_id
      WHERE m.tenant_id = NEW.tenant_id AND m.team_id = NEW.id
        AND ra.status = 'ACTIVE'
        AND ra.effective_from <= CURRENT_TIMESTAMP
        AND (ra.effective_to IS NULL OR ra.effective_to > CURRENT_TIMESTAMP);
    IF member_count <> 3 OR assignment_count <> 3 THEN
      RAISE EXCEPTION 'Active Triangle Team requires three distinct effective responsibility assignments'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.role_assignments ra
      WHERE ra.tenant_id = NEW.tenant_id AND ra.id = NEW.arbiter_role_assignment_id
        AND ra.status = 'ACTIVE'
        AND ra.effective_from <= CURRENT_TIMESTAMP
        AND (ra.effective_to IS NULL OR ra.effective_to > CURRENT_TIMESTAMP)
    ) THEN
      RAISE EXCEPTION 'Triangle Team arbiter must be an effective Role Assignment'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.triangle_team_metrics m
      WHERE m.tenant_id = NEW.tenant_id AND m.team_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Active Triangle Team requires shared business metrics'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER triangle_team_activation_guard_trigger
  BEFORE UPDATE OR DELETE ON public.triangle_teams
  FOR EACH ROW EXECUTE FUNCTION public.triangle_team_activation_guard();

CREATE OR REPLACE FUNCTION public.development_action_state_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Development Action history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NOT (
    (OLD.status = 'PLANNED' AND NEW.status IN ('ACTIVE', 'CANCELLED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid Development Action transition or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'COMPLETED'
    AND (NEW.verification_evidence_id IS NULL OR NEW.verification_evidence_version IS NULL)
  THEN
    RAISE EXCEPTION 'Completed Development Action requires governed verification Evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER development_action_state_guard_trigger
  BEFORE UPDATE OR DELETE ON public.development_actions
  FOR EACH ROW EXECUTE FUNCTION public.development_action_state_guard();

CREATE OR REPLACE FUNCTION public.triangle_health_policy_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected TEXT[] := ARRAY[
    'TASK_RESPONSE_LATENCY', 'INPUT_OUTPUT_COMPLETENESS', 'PROCESS_RETURN_RATE',
    'COMMITMENT_FULFILLMENT', 'CUSTOMER_CLOSURE', 'SHARED_OBJECTIVE_RESULT'
  ];
  actual TEXT[];
  weight_total NUMERIC;
BEGIN
  SELECT array_agg(key ORDER BY key) INTO actual FROM jsonb_object_keys(NEW.weights) key;
  IF actual IS DISTINCT FROM (SELECT array_agg(value ORDER BY value) FROM unnest(expected) value)
    OR NEW.thresholds ? 'MESSAGE_COUNT' OR NEW.weights ? 'MESSAGE_COUNT'
  THEN
    RAISE EXCEPTION 'Triangle health policy must use exactly six governed dimensions; message count is forbidden'
      USING ERRCODE = '23514';
  END IF;
  SELECT sum(value::numeric) INTO weight_total FROM jsonb_each_text(NEW.weights);
  IF abs(weight_total - 1) > 0.000001 THEN
    RAISE EXCEPTION 'Triangle health weights must add up to one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER triangle_health_policy_guard_trigger
  BEFORE INSERT OR UPDATE ON public.triangle_health_policies
  FOR EACH ROW EXECUTE FUNCTION public.triangle_health_policy_guard();

CREATE OR REPLACE FUNCTION public.organization_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  report UUID;
  area_count INTEGER;
  critical_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Organization Change history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Organization Change revision must advance by one' USING ERRCODE = '40001';
  END IF;
  IF NEW.status IN ('CONFIRMED', 'APPLIED') THEN
    SELECT r.id INTO report
    FROM public.organization_impact_reports r
    WHERE r.tenant_id = NEW.tenant_id AND r.proposal_id = NEW.id
    ORDER BY r.proposal_revision DESC LIMIT 1;
    SELECT count(DISTINCT i.area), count(*) FILTER (WHERE i.risk = 'CRITICAL')
      INTO area_count, critical_count
      FROM public.organization_impact_items i
      WHERE i.tenant_id = NEW.tenant_id AND i.report_id = report;
    IF area_count <> 5 THEN
      RAISE EXCEPTION 'Organization Change requires a complete five-area impact report'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.confirmed_by_user_id IS NULL OR NEW.confirmed_by_user_id = NEW.proposed_by_user_id THEN
      RAISE EXCEPTION 'Organization Change requires an independent human confirmation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'APPLIED' AND critical_count > 0
      AND NEW.applied_by_user_id = NEW.confirmed_by_user_id
    THEN
      RAISE EXCEPTION 'Critical Organization Change requires an independent applier'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER organization_change_guard_trigger
  BEFORE UPDATE OR DELETE ON public.organization_change_proposals
  FOR EACH ROW EXECUTE FUNCTION public.organization_change_guard();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'competency_levels', 'competency_behavior_anchors', 'role_competency_requirements',
    'competency_evidence', 'competency_assessment_confirmations',
    'competency_appeal_evidence', 'competency_gaps', 'triangle_team_members',
    'triangle_team_metrics', 'triangle_health_policies', 'triangle_health_snapshots',
    'triangle_health_components', 'triangle_health_snapshot_evidence',
    'organization_impact_reports', 'organization_impact_items',
    'organization_change_confirmations'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.people_append_only_guard()',
      table_name,
      table_name
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  table_name TEXT;
  append_only_tables CONSTANT TEXT[] := ARRAY[
    'competency_levels', 'competency_behavior_anchors', 'role_competency_requirements',
    'competency_evidence', 'competency_assessment_attributions',
    'competency_assessment_confirmations', 'competency_appeal_evidence', 'competency_gaps',
    'triangle_team_members', 'triangle_team_metrics', 'triangle_health_policies',
    'triangle_health_snapshots', 'triangle_health_components',
    'triangle_health_snapshot_evidence', 'organization_impact_reports',
    'organization_impact_items', 'organization_change_confirmations'
  ];
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'competency_definitions', 'competency_versions', 'competency_levels',
    'competency_behavior_anchors', 'role_competency_requirements', 'competency_evidence',
    'competency_assessments', 'competency_assessment_attributions',
    'competency_assessment_confirmations', 'competency_appeals',
    'competency_appeal_evidence', 'competency_gaps', 'development_plans',
    'development_actions', 'triangle_teams', 'triangle_team_members',
    'triangle_team_metrics', 'triangle_health_policies', 'triangle_health_snapshots',
    'triangle_health_components', 'triangle_health_snapshot_evidence',
    'organization_change_proposals', 'organization_impact_reports',
    'organization_impact_items', 'organization_change_confirmations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_app_read ON public.%I '
      || 'AS PERMISSIVE FOR SELECT TO enterprise_agent_app USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
      table_name
    );
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO enterprise_agent_app', table_name);
    IF table_name = ANY(append_only_tables) THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO enterprise_agent_admin', table_name);
    ELSE
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO enterprise_agent_admin',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

-- Employee self-service can only add an appeal and supporting evidence. The
-- API still binds subject_user_id to the authenticated user; tenant RLS is a
-- second, independent isolation layer.
CREATE POLICY enterprise_agent_app_appeal_insert
  ON public.competency_appeals AS PERMISSIVE FOR INSERT TO enterprise_agent_app
  WITH CHECK (true);
CREATE POLICY enterprise_agent_app_appeal_evidence_insert
  ON public.competency_appeal_evidence AS PERMISSIVE FOR INSERT TO enterprise_agent_app
  WITH CHECK (true);
GRANT INSERT ON public.competency_appeals, public.competency_appeal_evidence
  TO enterprise_agent_app;

GRANT USAGE ON TYPE
  public."CompetencyCategory", public."CompetencyDefinitionStatus",
  public."CompetencyVersionStatus", public."CompetencyAssessmentStatus",
  public."CompetencyConfirmationRole", public."CompetencyConfirmationDecision",
  public."CompetencyAttributionFactor", public."CompetencyAppealStatus",
  public."DevelopmentPlanStatus", public."DevelopmentActionType",
  public."DevelopmentActionStatus", public."TriangleResponsibility",
  public."TriangleTeamStatus", public."TriangleHealthDimension",
  public."TriangleHealthRating", public."OrganizationChangeType",
  public."OrganizationImpactArea", public."OrganizationImpactRisk",
  public."OrganizationChangeStatus"
  TO enterprise_agent_app, enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.people_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.competency_assessment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.competency_assessment_attribution_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.competency_assessment_attribution_complete_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.competency_confirmation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triangle_team_activation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.development_action_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triangle_health_policy_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.organization_change_guard() FROM PUBLIC;

COMMIT;
