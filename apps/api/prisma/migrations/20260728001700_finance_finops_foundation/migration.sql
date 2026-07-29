BEGIN;

CREATE TYPE public."FinopsResourceKind" AS ENUM (
  'MODEL', 'EMBEDDING', 'RERANK', 'TOOL', 'API', 'STORAGE', 'HUMAN_REVIEW'
);
CREATE TYPE public."FinopsBillingUnit" AS ENUM (
  'INPUT_TOKEN', 'OUTPUT_TOKEN', 'TOKEN', 'REQUEST', 'CALL', 'SECOND',
  'MINUTE', 'HOUR', 'BYTE_MONTH', 'GB_MONTH', 'DOCUMENT'
);
CREATE TYPE public."FinopsApprovalStatus" AS ENUM (
  'DRAFT', 'APPROVED', 'REJECTED', 'RETIRED'
);
CREATE TYPE public."FinopsCostSubjectType" AS ENUM (
  'AGENT_RUN', 'TOOL_INVOCATION', 'KNOWLEDGE_OPERATION',
  'HUMAN_TIME', 'API', 'STORAGE'
);
CREATE TYPE public."FinopsVerificationStatus" AS ENUM (
  'PENDING', 'VERIFIED', 'DISPUTED', 'REJECTED'
);
CREATE TYPE public."FinopsSourceAuthority" AS ENUM (
  'RUNTIME_ATTESTED', 'PROVIDER_BILL', 'TRUSTED_SYSTEM', 'HUMAN_ATTESTED'
);
CREATE TYPE public."FinopsAllocationMethod" AS ENUM (
  'DIRECT', 'PROPORTIONAL_USAGE', 'PROPORTIONAL_TIME', 'WEIGHTED'
);
CREATE TYPE public."FinopsDimensionType" AS ENUM ('CUSTOMER', 'PROJECT');
CREATE TYPE public."FinopsProposalOrigin" AS ENUM ('HUMAN', 'AI', 'TRUSTED_SYSTEM');
CREATE TYPE public."FinopsReviewStatus" AS ENUM (
  'CANDIDATE', 'PENDING_REVIEW', 'CONFIRMED', 'REJECTED'
);
CREATE TYPE public."FinopsBenefitOrigin" AS ENUM ('HUMAN', 'AI', 'TRUSTED_SYSTEM');
CREATE TYPE public."FinopsConfirmationAuthority" AS ENUM ('HUMAN', 'TRUSTED_SYSTEM');
CREATE TYPE public."FinopsRoiCalculationStatus" AS ENUM (
  'COMPUTED', 'INVALID_ZERO_COST'
);
CREATE TYPE public."FinopsBudgetStatus" AS ENUM (
  'DRAFT', 'ACTIVE', 'REJECTED', 'CLOSED'
);
CREATE TYPE public."FinopsBudgetScopeType" AS ENUM (
  'TENANT', 'EMPLOYEE', 'ROLE_ASSIGNMENT', 'TASK', 'PROCESS',
  'CUSTOMER', 'PROJECT', 'DEPARTMENT'
);
CREATE TYPE public."FinopsBudgetEventType" AS ENUM (
  'RESERVATION', 'SETTLEMENT', 'RELEASE', 'ADJUSTMENT'
);
CREATE TYPE public."FinopsBudgetAlertType" AS ENUM (
  'THRESHOLD_REACHED', 'HARD_LIMIT_EXCEEDED',
  'SETTLEMENT_MISMATCH', 'UNVERIFIED_COST'
);
CREATE TYPE public."FinopsAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE public."FinopsRoutingSuggestionStatus" AS ENUM (
  'PROPOSED', 'ACCEPTED_FOR_REVIEW', 'REJECTED'
);

CREATE TABLE public.finops_price_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  resource_kind public."FinopsResourceKind" NOT NULL,
  provider VARCHAR(100) NOT NULL,
  sku VARCHAR(200) NOT NULL,
  currency CHAR(3) NOT NULL,
  billing_unit public."FinopsBillingUnit" NOT NULL,
  unit_size NUMERIC(30,12) NOT NULL,
  unit_price NUMERIC(30,12) NOT NULL,
  effective_from TIMESTAMPTZ(6) NOT NULL,
  effective_to TIMESTAMPTZ(6),
  status public."FinopsApprovalStatus" NOT NULL DEFAULT 'DRAFT',
  source_authority public."FinopsSourceAuthority" NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  source_record_id VARCHAR(500) NOT NULL,
  source_record_version VARCHAR(200) NOT NULL,
  source_content_hash CHAR(64) NOT NULL,
  source_evidence_id UUID,
  source_evidence_version INTEGER,
  created_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approval_comment VARCHAR(500),
  approved_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_price_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT finops_price_snapshots_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_price_snapshots_tenant_id_version_key
    UNIQUE (tenant_id, id, version),
  CONSTRAINT finops_price_snapshots_code_version_key
    UNIQUE (tenant_id, code, version),
  CONSTRAINT finops_price_snapshots_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_price_snapshots_positive_check
    CHECK (version > 0 AND revision > 0 AND unit_size > 0 AND unit_price >= 0),
  CONSTRAINT finops_price_snapshots_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_price_snapshots_period_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT finops_price_snapshots_hash_check
    CHECK (source_content_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_price_snapshots_evidence_pair_check
    CHECK ((source_evidence_id IS NULL) = (source_evidence_version IS NULL)),
  CONSTRAINT finops_price_snapshots_approval_check CHECK (
    (status = 'APPROVED' AND approved_by_user_id IS NOT NULL
      AND approved_by_user_id <> created_by_user_id AND approved_at IS NOT NULL)
    OR (status <> 'APPROVED')
  ),
  CONSTRAINT finops_price_snapshots_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT finops_price_snapshots_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_price_snapshots_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_price_snapshots_source_evidence_fkey
    FOREIGN KEY (tenant_id, source_evidence_id, source_evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT
);

CREATE INDEX finops_price_snapshots_lookup_idx
  ON public.finops_price_snapshots(
    tenant_id, resource_kind, provider, sku, status, effective_from DESC
  );
CREATE UNIQUE INDEX finops_price_snapshots_one_approved_version_idx
  ON public.finops_price_snapshots(tenant_id, resource_kind, provider, sku, version)
  WHERE status = 'APPROVED';

CREATE TABLE public.finops_cost_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  subject_type public."FinopsCostSubjectType" NOT NULL,
  subject_id VARCHAR(500) NOT NULL,
  agent_run_id UUID,
  tool_invocation_id UUID,
  knowledge_document_version_id UUID,
  human_user_id UUID,
  price_snapshot_id UUID NOT NULL,
  price_snapshot_version INTEGER NOT NULL,
  resource_kind public."FinopsResourceKind" NOT NULL,
  quantity NUMERIC(30,12) NOT NULL,
  raw_usage JSONB NOT NULL,
  formula_code VARCHAR(100) NOT NULL,
  formula_version INTEGER NOT NULL,
  formula_expression VARCHAR(500) NOT NULL,
  currency CHAR(3) NOT NULL,
  calculated_amount NUMERIC(30,12) NOT NULL,
  verification_status public."FinopsVerificationStatus" NOT NULL DEFAULT 'PENDING',
  source_authority public."FinopsSourceAuthority" NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  source_record_id VARCHAR(500) NOT NULL,
  source_record_version VARCHAR(200) NOT NULL,
  source_content_hash CHAR(64) NOT NULL,
  source_evidence_id UUID,
  source_evidence_version INTEGER,
  incurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_cost_entries_pkey PRIMARY KEY (id),
  CONSTRAINT finops_cost_entries_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_cost_entries_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_cost_entries_source_identity_key
    UNIQUE (
      tenant_id, source_system, source_record_id, source_record_version,
      resource_kind, subject_type, subject_id
    ),
  CONSTRAINT finops_cost_entries_quantity_check
    CHECK (quantity > 0 AND formula_version > 0 AND calculated_amount >= 0),
  CONSTRAINT finops_cost_entries_formula_check
    CHECK (formula_expression = '(quantity / unitSize) * unitPrice'),
  CONSTRAINT finops_cost_entries_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_cost_entries_hash_check
    CHECK (source_content_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_cost_entries_evidence_pair_check
    CHECK ((source_evidence_id IS NULL) = (source_evidence_version IS NULL)),
  CONSTRAINT finops_cost_entries_verification_authority_check CHECK (
    verification_status <> 'VERIFIED'
    OR source_authority IN ('RUNTIME_ATTESTED', 'PROVIDER_BILL', 'TRUSTED_SYSTEM')
  ),
  CONSTRAINT finops_cost_entries_subject_check CHECK (
    (subject_type = 'AGENT_RUN' AND agent_run_id IS NOT NULL
      AND subject_id = agent_run_id::text
      AND tool_invocation_id IS NULL AND knowledge_document_version_id IS NULL
      AND human_user_id IS NULL)
    OR (subject_type = 'TOOL_INVOCATION' AND tool_invocation_id IS NOT NULL
      AND subject_id = tool_invocation_id::text
      AND agent_run_id IS NULL AND knowledge_document_version_id IS NULL
      AND human_user_id IS NULL)
    OR (subject_type = 'KNOWLEDGE_OPERATION' AND knowledge_document_version_id IS NOT NULL
      AND subject_id = knowledge_document_version_id::text
      AND agent_run_id IS NULL AND tool_invocation_id IS NULL AND human_user_id IS NULL)
    OR (subject_type = 'HUMAN_TIME' AND human_user_id IS NOT NULL
      AND subject_id = human_user_id::text
      AND agent_run_id IS NULL AND tool_invocation_id IS NULL
      AND knowledge_document_version_id IS NULL)
    OR (subject_type IN ('API', 'STORAGE') AND agent_run_id IS NULL
      AND tool_invocation_id IS NULL AND knowledge_document_version_id IS NULL
      AND human_user_id IS NULL)
  ),
  CONSTRAINT finops_cost_entries_price_fkey
    FOREIGN KEY (tenant_id, price_snapshot_id, price_snapshot_version)
    REFERENCES public.finops_price_snapshots(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_entries_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_entries_tool_invocation_fkey
    FOREIGN KEY (tenant_id, tool_invocation_id)
    REFERENCES public.tool_invocations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_entries_knowledge_version_fkey
    FOREIGN KEY (tenant_id, knowledge_document_version_id)
    REFERENCES public.knowledge_document_versions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_entries_human_user_fkey
    FOREIGN KEY (tenant_id, human_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_entries_source_evidence_fkey
    FOREIGN KEY (tenant_id, source_evidence_id, source_evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_entries_recorder_fkey
    FOREIGN KEY (tenant_id, recorded_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_cost_entries_period_idx
  ON public.finops_cost_entries(
    tenant_id, currency, verification_status, incurred_at DESC
  );
CREATE INDEX finops_cost_entries_subject_idx
  ON public.finops_cost_entries(tenant_id, subject_type, subject_id, incurred_at DESC);

CREATE TABLE public.finops_allocation_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  method public."FinopsAllocationMethod" NOT NULL,
  dimensions JSONB NOT NULL,
  rule_definition JSONB NOT NULL,
  definition_hash CHAR(64) NOT NULL,
  status public."FinopsApprovalStatus" NOT NULL DEFAULT 'DRAFT',
  created_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approval_comment VARCHAR(500),
  approved_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_allocation_rules_pkey PRIMARY KEY (id),
  CONSTRAINT finops_allocation_rules_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_allocation_rules_tenant_id_version_key UNIQUE (tenant_id, id, version),
  CONSTRAINT finops_allocation_rules_code_version_key UNIQUE (tenant_id, code, version),
  CONSTRAINT finops_allocation_rules_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_allocation_rules_positive_check
    CHECK (version > 0 AND revision > 0),
  CONSTRAINT finops_allocation_rules_dimensions_check CHECK (
    jsonb_typeof(dimensions) = 'array' AND jsonb_array_length(dimensions) > 0
  ),
  CONSTRAINT finops_allocation_rules_hash_check
    CHECK (definition_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_allocation_rules_approval_check CHECK (
    (status = 'APPROVED' AND approved_by_user_id IS NOT NULL
      AND approved_by_user_id <> created_by_user_id AND approved_at IS NOT NULL)
    OR status <> 'APPROVED'
  ),
  CONSTRAINT finops_allocation_rules_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT finops_allocation_rules_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_allocation_rules_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.finops_dimension_members (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  dimension public."FinopsDimensionType" NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  source_record_id VARCHAR(500) NOT NULL,
  source_record_version VARCHAR(200) NOT NULL,
  source_content_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_dimension_members_pkey PRIMARY KEY (id),
  CONSTRAINT finops_dimension_members_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_dimension_members_code_key UNIQUE (tenant_id, dimension, code),
  CONSTRAINT finops_dimension_members_source_key
    UNIQUE (tenant_id, dimension, source_system, source_record_id, source_record_version),
  CONSTRAINT finops_dimension_members_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_dimension_members_hash_check
    CHECK (source_content_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_dimension_members_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT finops_dimension_members_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.finops_allocation_sets (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  cost_entry_id UUID NOT NULL,
  rule_id UUID NOT NULL,
  rule_version INTEGER NOT NULL,
  origin public."FinopsProposalOrigin" NOT NULL,
  status public."FinopsReviewStatus" NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  proposed_by_user_id UUID NOT NULL,
  proposed_by_agent_run_id UUID,
  confirmed_by_user_id UUID,
  review_comment VARCHAR(500),
  confirmed_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_allocation_sets_pkey PRIMARY KEY (id),
  CONSTRAINT finops_allocation_sets_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_allocation_sets_cost_revision_key
    UNIQUE (tenant_id, cost_entry_id, id),
  CONSTRAINT finops_allocation_sets_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_allocation_sets_positive_check CHECK (revision > 0),
  CONSTRAINT finops_allocation_sets_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_allocation_sets_origin_check CHECK (
    (origin = 'AI' AND proposed_by_agent_run_id IS NOT NULL AND status = 'CANDIDATE')
    OR (origin <> 'AI' AND proposed_by_agent_run_id IS NULL
      AND status = 'PENDING_REVIEW')
    OR status IN ('CONFIRMED', 'REJECTED')
  ),
  CONSTRAINT finops_allocation_sets_confirmation_check CHECK (
    (status = 'CONFIRMED' AND confirmed_by_user_id IS NOT NULL
      AND confirmed_by_user_id <> proposed_by_user_id AND confirmed_at IS NOT NULL)
    OR status <> 'CONFIRMED'
  ),
  CONSTRAINT finops_allocation_sets_cost_fkey
    FOREIGN KEY (tenant_id, cost_entry_id)
    REFERENCES public.finops_cost_entries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_allocation_sets_rule_fkey
    FOREIGN KEY (tenant_id, rule_id, rule_version)
    REFERENCES public.finops_allocation_rules(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_allocation_sets_proposer_fkey
    FOREIGN KEY (tenant_id, proposed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_allocation_sets_agent_run_fkey
    FOREIGN KEY (tenant_id, proposed_by_agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_allocation_sets_confirmer_fkey
    FOREIGN KEY (tenant_id, confirmed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX finops_allocation_sets_one_confirmed_per_cost_idx
  ON public.finops_allocation_sets(tenant_id, cost_entry_id)
  WHERE status = 'CONFIRMED';

CREATE TABLE public.finops_cost_allocations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  allocation_set_id UUID NOT NULL,
  employee_user_id UUID,
  role_assignment_id UUID,
  task_id UUID,
  task_version INTEGER,
  process_definition_id UUID,
  process_version_id UUID,
  process_version INTEGER,
  customer_id UUID,
  project_id UUID,
  department_org_unit_id UUID,
  weight NUMERIC(18,12) NOT NULL,
  allocated_amount NUMERIC(30,12) NOT NULL,
  rationale VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_cost_allocations_pkey PRIMARY KEY (id),
  CONSTRAINT finops_cost_allocations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_cost_allocations_weight_check CHECK (
    weight > 0 AND weight <= 1 AND allocated_amount >= 0
  ),
  CONSTRAINT finops_cost_allocations_task_pair_check
    CHECK ((task_id IS NULL) = (task_version IS NULL)),
  CONSTRAINT finops_cost_allocations_process_pair_check CHECK (
    (process_definition_id IS NULL AND process_version_id IS NULL AND process_version IS NULL)
    OR (process_definition_id IS NOT NULL AND process_version_id IS NOT NULL
      AND process_version IS NOT NULL)
  ),
  CONSTRAINT finops_cost_allocations_dimension_check CHECK (
    employee_user_id IS NOT NULL OR role_assignment_id IS NOT NULL
    OR task_id IS NOT NULL OR process_definition_id IS NOT NULL
    OR customer_id IS NOT NULL OR project_id IS NOT NULL
    OR department_org_unit_id IS NOT NULL
  ),
  CONSTRAINT finops_cost_allocations_set_fkey
    FOREIGN KEY (tenant_id, allocation_set_id)
    REFERENCES public.finops_allocation_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_employee_fkey
    FOREIGN KEY (tenant_id, employee_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_role_fkey
    FOREIGN KEY (tenant_id, role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_task_fkey
    FOREIGN KEY (tenant_id, task_id, task_version)
    REFERENCES public.tasks(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_process_definition_fkey
    FOREIGN KEY (tenant_id, process_definition_id)
    REFERENCES public.process_definitions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_process_version_fkey
    FOREIGN KEY (tenant_id, process_definition_id, process_version_id, process_version)
    REFERENCES public.process_versions(tenant_id, process_definition_id, id, version)
    ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_customer_fkey
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.finops_dimension_members(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_project_fkey
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.finops_dimension_members(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_cost_allocations_department_fkey
    FOREIGN KEY (tenant_id, department_org_unit_id)
    REFERENCES public.org_units(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_cost_allocations_dimensions_idx
  ON public.finops_cost_allocations(
    tenant_id, employee_user_id, role_assignment_id, task_id,
    process_definition_id, customer_id, project_id, department_org_unit_id
  );

CREATE TABLE public.finops_benefit_claims (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  origin public."FinopsBenefitOrigin" NOT NULL,
  status public."FinopsReviewStatus" NOT NULL,
  currency CHAR(3) NOT NULL,
  amount NUMERIC(30,12) NOT NULL,
  period_start TIMESTAMPTZ(6) NOT NULL,
  period_end TIMESTAMPTZ(6) NOT NULL,
  deliverable_id UUID NOT NULL,
  deliverable_version INTEGER NOT NULL,
  acceptance_id UUID NOT NULL,
  acceptance_version INTEGER NOT NULL,
  evidence_id UUID NOT NULL,
  evidence_version INTEGER NOT NULL,
  value_definition_id UUID NOT NULL,
  value_version_id UUID NOT NULL,
  value_version INTEGER NOT NULL,
  objective_id UUID NOT NULL,
  objective_version INTEGER NOT NULL,
  source_authority public."FinopsSourceAuthority" NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  source_record_id VARCHAR(500) NOT NULL,
  source_record_version VARCHAR(200) NOT NULL,
  source_content_hash CHAR(64) NOT NULL,
  agent_run_id UUID,
  created_by_user_id UUID NOT NULL,
  confirmation_authority public."FinopsConfirmationAuthority",
  confirmed_by_user_id UUID,
  trusted_import_receipt JSONB,
  review_comment VARCHAR(500),
  confirmed_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_benefit_claims_pkey PRIMARY KEY (id),
  CONSTRAINT finops_benefit_claims_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_benefit_claims_tenant_id_version_key UNIQUE (tenant_id, id, version),
  CONSTRAINT finops_benefit_claims_code_version_key UNIQUE (tenant_id, code, version),
  CONSTRAINT finops_benefit_claims_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_benefit_claims_positive_check CHECK (
    version > 0 AND revision > 0 AND amount > 0
    AND deliverable_version > 0 AND acceptance_version > 0
    AND evidence_version > 0 AND value_version > 0 AND objective_version > 0
  ),
  CONSTRAINT finops_benefit_claims_period_check CHECK (period_end > period_start),
  CONSTRAINT finops_benefit_claims_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_benefit_claims_hash_check CHECK (
    source_content_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT finops_benefit_claims_origin_check CHECK (
    (origin = 'AI' AND agent_run_id IS NOT NULL)
    OR (origin <> 'AI' AND agent_run_id IS NULL)
  ),
  CONSTRAINT finops_benefit_claims_confirmation_check CHECK (
    (status = 'CONFIRMED' AND confirmation_authority IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND (
        (confirmation_authority = 'HUMAN' AND confirmed_by_user_id IS NOT NULL
          AND confirmed_by_user_id <> created_by_user_id
          AND trusted_import_receipt IS NULL)
        OR
        (confirmation_authority = 'TRUSTED_SYSTEM' AND origin = 'TRUSTED_SYSTEM'
          AND trusted_import_receipt IS NOT NULL)
      ))
    OR (status <> 'CONFIRMED' AND confirmation_authority IS NULL
      AND confirmed_by_user_id IS NULL AND trusted_import_receipt IS NULL)
  ),
  CONSTRAINT finops_benefit_claims_deliverable_fkey
    FOREIGN KEY (tenant_id, deliverable_id, deliverable_version)
    REFERENCES public.deliverables(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_acceptance_fkey
    FOREIGN KEY (tenant_id, acceptance_id, acceptance_version)
    REFERENCES public.acceptances(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_evidence_fkey
    FOREIGN KEY (tenant_id, evidence_id, evidence_version)
    REFERENCES public.evidence(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_value_version_fkey
    FOREIGN KEY (tenant_id, value_definition_id, value_version_id, value_version)
    REFERENCES public.value_versions(tenant_id, value_definition_id, id, version)
    ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_objective_fkey
    FOREIGN KEY (tenant_id, objective_id, objective_version)
    REFERENCES public.objectives(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_benefit_claims_confirmer_fkey
    FOREIGN KEY (tenant_id, confirmed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_benefit_claims_period_idx
  ON public.finops_benefit_claims(tenant_id, currency, status, period_start, period_end);

CREATE TABLE public.finops_roi_formula_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  expression VARCHAR(500) NOT NULL,
  expression_hash CHAR(64) NOT NULL,
  status public."FinopsApprovalStatus" NOT NULL DEFAULT 'DRAFT',
  created_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approval_comment VARCHAR(500),
  approved_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_roi_formula_versions_pkey PRIMARY KEY (id),
  CONSTRAINT finops_roi_formula_versions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_roi_formula_versions_tenant_id_version_key UNIQUE (tenant_id, id, version),
  CONSTRAINT finops_roi_formula_versions_code_version_key UNIQUE (tenant_id, code, version),
  CONSTRAINT finops_roi_formula_versions_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_roi_formula_versions_positive_check CHECK (version > 0 AND revision > 0),
  CONSTRAINT finops_roi_formula_versions_expression_check
    CHECK (expression = '(confirmedBenefit - verifiedCost) / verifiedCost'),
  CONSTRAINT finops_roi_formula_versions_hash_check
    CHECK (expression_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_roi_formula_versions_approval_check CHECK (
    (status = 'APPROVED' AND approved_by_user_id IS NOT NULL
      AND approved_by_user_id <> created_by_user_id AND approved_at IS NOT NULL)
    OR status <> 'APPROVED'
  ),
  CONSTRAINT finops_roi_formula_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT finops_roi_formula_versions_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_roi_formula_versions_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.finops_roi_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  formula_id UUID NOT NULL,
  formula_version INTEGER NOT NULL,
  currency CHAR(3) NOT NULL,
  period_start TIMESTAMPTZ(6) NOT NULL,
  period_end TIMESTAMPTZ(6) NOT NULL,
  verified_cost NUMERIC(30,12) NOT NULL,
  confirmed_benefit NUMERIC(30,12) NOT NULL,
  net_benefit NUMERIC(30,12) NOT NULL,
  roi_ratio NUMERIC(30,12),
  status public."FinopsRoiCalculationStatus" NOT NULL,
  cost_inputs_hash CHAR(64) NOT NULL,
  benefit_inputs_hash CHAR(64) NOT NULL,
  inputs_hash CHAR(64) NOT NULL,
  recalculation_of_id UUID,
  calculated_by_user_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_roi_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT finops_roi_snapshots_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_roi_snapshots_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_roi_snapshots_amount_check CHECK (
    verified_cost >= 0 AND confirmed_benefit >= 0
    AND net_benefit = confirmed_benefit - verified_cost
  ),
  CONSTRAINT finops_roi_snapshots_period_check CHECK (period_end > period_start),
  CONSTRAINT finops_roi_snapshots_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_roi_snapshots_hash_check CHECK (
    cost_inputs_hash ~ '^[a-f0-9]{64}$'
    AND benefit_inputs_hash ~ '^[a-f0-9]{64}$'
    AND inputs_hash ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT finops_roi_snapshots_zero_division_check CHECK (
    (verified_cost = 0 AND roi_ratio IS NULL AND status = 'INVALID_ZERO_COST')
    OR (verified_cost > 0 AND roi_ratio IS NOT NULL AND status = 'COMPUTED')
  ),
  CONSTRAINT finops_roi_snapshots_formula_fkey
    FOREIGN KEY (tenant_id, formula_id, formula_version)
    REFERENCES public.finops_roi_formula_versions(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_roi_snapshots_recalculation_fkey
    FOREIGN KEY (tenant_id, recalculation_of_id)
    REFERENCES public.finops_roi_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_roi_snapshots_calculator_fkey
    FOREIGN KEY (tenant_id, calculated_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_roi_snapshots_period_idx
  ON public.finops_roi_snapshots(tenant_id, currency, period_start, period_end, created_at DESC);

CREATE TABLE public.finops_budgets (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  scope_type public."FinopsBudgetScopeType" NOT NULL,
  scope_id VARCHAR(500) NOT NULL,
  employee_user_id UUID,
  role_assignment_id UUID,
  task_id UUID,
  task_version INTEGER,
  process_definition_id UUID,
  customer_id UUID,
  project_id UUID,
  department_org_unit_id UUID,
  currency CHAR(3) NOT NULL,
  limit_amount NUMERIC(30,12) NOT NULL,
  alert_threshold_ratio NUMERIC(12,10) NOT NULL,
  period_start TIMESTAMPTZ(6) NOT NULL,
  period_end TIMESTAMPTZ(6) NOT NULL,
  status public."FinopsBudgetStatus" NOT NULL DEFAULT 'DRAFT',
  created_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approval_comment VARCHAR(500),
  approved_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_budgets_pkey PRIMARY KEY (id),
  CONSTRAINT finops_budgets_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_budgets_tenant_id_version_key UNIQUE (tenant_id, id, version),
  CONSTRAINT finops_budgets_code_version_key UNIQUE (tenant_id, code, version),
  CONSTRAINT finops_budgets_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_budgets_positive_check CHECK (
    version > 0 AND revision > 0 AND limit_amount > 0
    AND alert_threshold_ratio > 0 AND alert_threshold_ratio <= 1
  ),
  CONSTRAINT finops_budgets_period_check CHECK (period_end > period_start),
  CONSTRAINT finops_budgets_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_budgets_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_budgets_task_pair_check
    CHECK ((task_id IS NULL) = (task_version IS NULL)),
  CONSTRAINT finops_budgets_scope_check CHECK (
    (scope_type = 'TENANT'
      AND scope_id = tenant_id::text
      AND num_nonnulls(
        employee_user_id, role_assignment_id, task_id, process_definition_id,
        customer_id, project_id, department_org_unit_id
      ) = 0)
    OR (scope_type = 'EMPLOYEE' AND scope_id = employee_user_id::text)
    OR (scope_type = 'ROLE_ASSIGNMENT' AND scope_id = role_assignment_id::text)
    OR (scope_type = 'TASK' AND scope_id = task_id::text)
    OR (scope_type = 'PROCESS' AND scope_id = process_definition_id::text)
    OR (scope_type = 'CUSTOMER' AND scope_id = customer_id::text)
    OR (scope_type = 'PROJECT' AND scope_id = project_id::text)
    OR (scope_type = 'DEPARTMENT' AND scope_id = department_org_unit_id::text)
  ),
  CONSTRAINT finops_budgets_exact_scope_reference_check CHECK (
    scope_type = 'TENANT'
    OR num_nonnulls(
      employee_user_id, role_assignment_id, task_id, process_definition_id,
      customer_id, project_id, department_org_unit_id
    ) = 1
  ),
  CONSTRAINT finops_budgets_approval_check CHECK (
    (status = 'ACTIVE' AND approved_by_user_id IS NOT NULL
      AND approved_by_user_id <> created_by_user_id AND approved_at IS NOT NULL)
    OR status <> 'ACTIVE'
  ),
  CONSTRAINT finops_budgets_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_employee_fkey
    FOREIGN KEY (tenant_id, employee_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_role_fkey
    FOREIGN KEY (tenant_id, role_assignment_id)
    REFERENCES public.role_assignments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_task_fkey
    FOREIGN KEY (tenant_id, task_id, task_version)
    REFERENCES public.tasks(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_process_fkey
    FOREIGN KEY (tenant_id, process_definition_id)
    REFERENCES public.process_definitions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_customer_fkey
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.finops_dimension_members(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_project_fkey
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.finops_dimension_members(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_department_fkey
    FOREIGN KEY (tenant_id, department_org_unit_id)
    REFERENCES public.org_units(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budgets_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_budgets_scope_idx
  ON public.finops_budgets(
    tenant_id, scope_type, scope_id, currency, period_start, period_end, status
  );

CREATE TABLE public.finops_budget_events (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  budget_id UUID NOT NULL,
  budget_version INTEGER NOT NULL,
  type public."FinopsBudgetEventType" NOT NULL,
  currency CHAR(3) NOT NULL,
  amount NUMERIC(30,12) NOT NULL,
  reservation_event_id UUID,
  cost_entry_id UUID,
  reason VARCHAR(500) NOT NULL,
  created_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_budget_events_pkey PRIMARY KEY (id),
  CONSTRAINT finops_budget_events_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_budget_events_tenant_budget_id_key
    UNIQUE (tenant_id, budget_id, id),
  CONSTRAINT finops_budget_events_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_budget_events_amount_check CHECK (amount > 0),
  CONSTRAINT finops_budget_events_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_budget_events_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_budget_events_reference_check CHECK (
    (type = 'RESERVATION' AND reservation_event_id IS NULL AND cost_entry_id IS NULL)
    OR (type = 'SETTLEMENT' AND reservation_event_id IS NOT NULL
      AND cost_entry_id IS NOT NULL)
    OR (type = 'RELEASE' AND reservation_event_id IS NOT NULL
      AND cost_entry_id IS NULL)
    OR (type = 'ADJUSTMENT' AND reservation_event_id IS NULL
      AND approved_by_user_id IS NOT NULL
      AND approved_by_user_id <> created_by_user_id)
  ),
  CONSTRAINT finops_budget_events_budget_fkey
    FOREIGN KEY (tenant_id, budget_id, budget_version)
    REFERENCES public.finops_budgets(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_budget_events_reservation_fkey
    FOREIGN KEY (tenant_id, budget_id, reservation_event_id)
    REFERENCES public.finops_budget_events(tenant_id, budget_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budget_events_cost_fkey
    FOREIGN KEY (tenant_id, cost_entry_id)
    REFERENCES public.finops_cost_entries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budget_events_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budget_events_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_budget_events_balance_idx
  ON public.finops_budget_events(tenant_id, budget_id, created_at, id);
CREATE UNIQUE INDEX finops_budget_events_one_settlement_per_cost_idx
  ON public.finops_budget_events(tenant_id, budget_id, cost_entry_id)
  WHERE type = 'SETTLEMENT';

CREATE TABLE public.finops_budget_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  budget_id UUID NOT NULL,
  budget_version INTEGER NOT NULL,
  budget_event_id UUID,
  type public."FinopsBudgetAlertType" NOT NULL,
  status public."FinopsAlertStatus" NOT NULL DEFAULT 'OPEN',
  observed_amount NUMERIC(30,12) NOT NULL,
  threshold_amount NUMERIC(30,12) NOT NULL,
  message TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  acknowledged_by_user_id UUID,
  acknowledgement_comment VARCHAR(500),
  acknowledged_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_budget_alerts_pkey PRIMARY KEY (id),
  CONSTRAINT finops_budget_alerts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_budget_alerts_event_type_key
    UNIQUE (tenant_id, budget_event_id, type),
  CONSTRAINT finops_budget_alerts_amount_check CHECK (
    observed_amount >= 0 AND threshold_amount >= 0 AND revision > 0
  ),
  CONSTRAINT finops_budget_alerts_acknowledgement_check CHECK (
    (status IN ('ACKNOWLEDGED', 'RESOLVED') AND acknowledged_by_user_id IS NOT NULL
      AND acknowledged_at IS NOT NULL)
    OR status = 'OPEN'
  ),
  CONSTRAINT finops_budget_alerts_budget_fkey
    FOREIGN KEY (tenant_id, budget_id, budget_version)
    REFERENCES public.finops_budgets(tenant_id, id, version) ON DELETE RESTRICT,
  CONSTRAINT finops_budget_alerts_event_fkey
    FOREIGN KEY (tenant_id, budget_event_id)
    REFERENCES public.finops_budget_events(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_budget_alerts_acknowledger_fkey
    FOREIGN KEY (tenant_id, acknowledged_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_budget_alerts_open_idx
  ON public.finops_budget_alerts(tenant_id, status, created_at DESC);

CREATE TABLE public.finops_model_routing_suggestions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_run_id UUID,
  current_route VARCHAR(300) NOT NULL,
  suggested_route VARCHAR(300) NOT NULL,
  currency CHAR(3) NOT NULL,
  estimated_savings NUMERIC(30,12) NOT NULL,
  quality_floor NUMERIC(12,10) NOT NULL,
  policy_boundary JSONB NOT NULL,
  rationale TEXT NOT NULL,
  status public."FinopsRoutingSuggestionStatus" NOT NULL DEFAULT 'PROPOSED',
  auto_applied BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  decided_by_user_id UUID,
  decision_comment VARCHAR(500),
  decided_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_model_routing_suggestions_pkey PRIMARY KEY (id),
  CONSTRAINT finops_model_routing_suggestions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_model_routing_suggestions_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_model_routing_suggestions_values_check CHECK (
    current_route <> suggested_route AND estimated_savings >= 0
    AND quality_floor >= 0 AND quality_floor <= 1 AND revision > 0
    AND auto_applied = FALSE
  ),
  CONSTRAINT finops_model_routing_suggestions_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finops_model_routing_suggestions_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT finops_model_routing_suggestions_decision_check CHECK (
    (status = 'PROPOSED' AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR (status <> 'PROPOSED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT finops_model_routing_suggestions_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_model_routing_suggestions_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT finops_model_routing_suggestions_decider_fkey
    FOREIGN KEY (tenant_id, decided_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_model_routing_suggestions_status_idx
  ON public.finops_model_routing_suggestions(tenant_id, status, created_at DESC);

CREATE TABLE public.finops_commands (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  command_type VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id UUID NOT NULL,
  result_revision INTEGER NOT NULL,
  actor_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT finops_commands_pkey PRIMARY KEY (id),
  CONSTRAINT finops_commands_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT finops_commands_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT finops_commands_hash_revision_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$' AND result_revision > 0),
  CONSTRAINT finops_commands_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT finops_commands_actor_fkey
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX finops_commands_resource_idx
  ON public.finops_commands(tenant_id, resource_type, resource_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.finops_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable FinOps history', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION public.finops_price_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Price snapshots cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.code, NEW.version, NEW.resource_kind, NEW.provider, NEW.sku,
    NEW.currency, NEW.billing_unit, NEW.unit_size, NEW.unit_price,
    NEW.effective_from, NEW.effective_to, NEW.source_authority,
    NEW.source_system, NEW.source_record_id, NEW.source_record_version,
    NEW.source_content_hash, NEW.source_evidence_id, NEW.source_evidence_version,
    NEW.created_by_user_id, NEW.idempotency_key, NEW.request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.code, OLD.version, OLD.resource_kind, OLD.provider, OLD.sku,
    OLD.currency, OLD.billing_unit, OLD.unit_size, OLD.unit_price,
    OLD.effective_from, OLD.effective_to, OLD.source_authority,
    OLD.source_system, OLD.source_record_id, OLD.source_record_version,
    OLD.source_content_hash, OLD.source_evidence_id, OLD.source_evidence_version,
    OLD.created_by_user_id, OLD.idempotency_key, OLD.request_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Price snapshot content is immutable; create a new version'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'DRAFT' OR NEW.status NOT IN ('APPROVED', 'REJECTED')
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Invalid Price Snapshot approval transition or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'APPROVED'
    AND (NEW.approved_by_user_id IS NULL
      OR NEW.approved_by_user_id = NEW.created_by_user_id)
  THEN
    RAISE EXCEPTION 'Price snapshot requires an independent human checker'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_price_snapshot_guard_trigger
  BEFORE UPDATE OR DELETE ON public.finops_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.finops_price_snapshot_guard();

CREATE OR REPLACE FUNCTION public.finops_prepare_cost_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  price public.finops_price_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO price
  FROM public.finops_price_snapshots p
  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.price_snapshot_id
  FOR SHARE;
  IF NOT FOUND OR price.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Cost entry requires an approved immutable Price Snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.incurred_at < price.effective_from
    OR (price.effective_to IS NOT NULL AND NEW.incurred_at >= price.effective_to)
  THEN
    RAISE EXCEPTION 'Price Snapshot is not effective at the cost occurrence time'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.formula_expression <> '(quantity / unitSize) * unitPrice' THEN
    RAISE EXCEPTION 'Unsupported or unversioned FinOps cost formula'
      USING ERRCODE = '23514';
  END IF;
  NEW.price_snapshot_version := price.version;
  NEW.resource_kind := price.resource_kind;
  NEW.currency := price.currency;
  NEW.calculated_amount := round((NEW.quantity / price.unit_size) * price.unit_price, 12);
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_prepare_cost_entry_trigger
  BEFORE INSERT ON public.finops_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.finops_prepare_cost_entry();
CREATE TRIGGER finops_cost_entries_append_only
  BEFORE UPDATE OR DELETE ON public.finops_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();

CREATE OR REPLACE FUNCTION public.finops_version_approval_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% versions cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'finops_allocation_rules' THEN
    IF ROW(
      NEW.tenant_id, NEW.code, NEW.version, NEW.method, NEW.dimensions,
      NEW.rule_definition, NEW.definition_hash, NEW.created_by_user_id,
      NEW.idempotency_key, NEW.request_hash, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.tenant_id, OLD.code, OLD.version, OLD.method, OLD.dimensions,
      OLD.rule_definition, OLD.definition_hash, OLD.created_by_user_id,
      OLD.idempotency_key, OLD.request_hash, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Allocation Rule content is immutable; create a new version'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF ROW(
      NEW.tenant_id, NEW.code, NEW.version, NEW.expression, NEW.expression_hash,
      NEW.created_by_user_id, NEW.idempotency_key, NEW.request_hash, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.tenant_id, OLD.code, OLD.version, OLD.expression, OLD.expression_hash,
      OLD.created_by_user_id, OLD.idempotency_key, OLD.request_hash, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'ROI Formula content is immutable; create a new version'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD.status <> 'DRAFT' OR NEW.status NOT IN ('APPROVED', 'REJECTED')
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Invalid version approval transition or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'APPROVED'
    AND (NEW.approved_by_user_id IS NULL
      OR NEW.approved_by_user_id = NEW.created_by_user_id)
  THEN
    RAISE EXCEPTION 'Version approval requires an independent human checker'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_allocation_rules_approval_guard
  BEFORE UPDATE OR DELETE ON public.finops_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION public.finops_version_approval_guard();
CREATE TRIGGER finops_roi_formula_versions_approval_guard
  BEFORE UPDATE OR DELETE ON public.finops_roi_formula_versions
  FOR EACH ROW EXECUTE FUNCTION public.finops_version_approval_guard();

CREATE TRIGGER finops_dimension_members_append_only
  BEFORE UPDATE OR DELETE ON public.finops_dimension_members
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();
CREATE TRIGGER finops_cost_allocations_append_only
  BEFORE UPDATE OR DELETE ON public.finops_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();
CREATE TRIGGER finops_roi_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.finops_roi_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();
CREATE TRIGGER finops_budget_events_append_only
  BEFORE UPDATE OR DELETE ON public.finops_budget_events
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();
CREATE TRIGGER finops_commands_append_only
  BEFORE UPDATE OR DELETE ON public.finops_commands
  FOR EACH ROW EXECUTE FUNCTION public.finops_append_only_guard();

CREATE OR REPLACE FUNCTION public.finops_allocation_line_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocation_status public."FinopsReviewStatus";
  member_dimension public."FinopsDimensionType";
BEGIN
  SELECT status INTO allocation_status
  FROM public.finops_allocation_sets s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.allocation_set_id;
  IF allocation_status IN ('CONFIRMED', 'REJECTED') THEN
    RAISE EXCEPTION 'Confirmed or rejected allocation history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.customer_id IS NOT NULL THEN
    SELECT dimension INTO member_dimension
    FROM public.finops_dimension_members d
    WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.customer_id;
    IF member_dimension <> 'CUSTOMER' THEN
      RAISE EXCEPTION 'customer_id must reference a CUSTOMER FinOps dimension'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    SELECT dimension INTO member_dimension
    FROM public.finops_dimension_members d
    WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.project_id;
    IF member_dimension <> 'PROJECT' THEN
      RAISE EXCEPTION 'project_id must reference a PROJECT FinOps dimension'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_allocation_line_guard_trigger
  BEFORE INSERT ON public.finops_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION public.finops_allocation_line_guard();

CREATE OR REPLACE FUNCTION public.finops_allocation_set_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_amount NUMERIC(30,12);
  allocated_total NUMERIC(30,12);
  weight_total NUMERIC(18,12);
  rule_status public."FinopsApprovalStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Allocation Set history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.cost_entry_id, NEW.rule_id, NEW.rule_version,
    NEW.origin, NEW.proposed_by_user_id, NEW.proposed_by_agent_run_id,
    NEW.idempotency_key, NEW.request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.cost_entry_id, OLD.rule_id, OLD.rule_version,
    OLD.origin, OLD.proposed_by_user_id, OLD.proposed_by_agent_run_id,
    OLD.idempotency_key, OLD.request_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Allocation Set identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('CONFIRMED', 'REJECTED')
    OR NEW.status NOT IN ('CONFIRMED', 'REJECTED')
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Invalid Allocation Set review transition or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'CONFIRMED' THEN
    IF NEW.confirmed_by_user_id IS NULL
      OR NEW.confirmed_by_user_id = NEW.proposed_by_user_id
    THEN
      RAISE EXCEPTION 'Cost allocation requires independent human confirmation'
        USING ERRCODE = '23514';
    END IF;
    SELECT r.status INTO rule_status
    FROM public.finops_allocation_rules r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.rule_id
      AND r.version = NEW.rule_version;
    IF rule_status <> 'APPROVED' THEN
      RAISE EXCEPTION 'Confirmed allocation requires an approved immutable Allocation Rule'
        USING ERRCODE = '23514';
    END IF;
    SELECT c.calculated_amount INTO expected_amount
    FROM public.finops_cost_entries c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.cost_entry_id;
    SELECT coalesce(sum(a.allocated_amount), 0), coalesce(sum(a.weight), 0)
      INTO allocated_total, weight_total
    FROM public.finops_cost_allocations a
    WHERE a.tenant_id = NEW.tenant_id AND a.allocation_set_id = NEW.id;
    IF abs(weight_total - 1) > 0.000000000001
      OR abs(allocated_total - expected_amount) > 0.000000000001
    THEN
      RAISE EXCEPTION 'Confirmed allocation weights and amounts must exactly close the Cost Entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_allocation_set_guard_trigger
  BEFORE UPDATE OR DELETE ON public.finops_allocation_sets
  FOR EACH ROW EXECUTE FUNCTION public.finops_allocation_set_guard();

CREATE OR REPLACE FUNCTION public.finops_benefit_claim_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  acceptance_record public.acceptances%ROWTYPE;
  evidence_record public.evidence%ROWTYPE;
BEGIN
  IF NEW.origin = 'AI' AND NEW.status <> 'CANDIDATE' THEN
    RAISE EXCEPTION 'AI can only create a Benefit candidate'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.origin <> 'AI' AND NEW.status <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'Human and trusted-system Benefits require review before confirmation'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO acceptance_record
  FROM public.acceptances a
  WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.acceptance_id
    AND a.version = NEW.acceptance_version;
  IF acceptance_record.decision <> 'ACCEPTED' OR acceptance_record.status <> 'ACTIVE'
    OR acceptance_record.deliverable_id <> NEW.deliverable_id
    OR acceptance_record.deliverable_version <> NEW.deliverable_version
  THEN
    RAISE EXCEPTION 'Benefit requires an active accepted Deliverable acceptance'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO evidence_record
  FROM public.evidence e
  WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.evidence_id
    AND e.version = NEW.evidence_version;
  IF evidence_record.status <> 'ACTIVE'
    OR evidence_record.trust_level NOT IN ('VERIFIED', 'HIGH')
  THEN
    RAISE EXCEPTION 'Benefit requires active trusted governed Evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_benefit_claim_insert_guard_trigger
  BEFORE INSERT ON public.finops_benefit_claims
  FOR EACH ROW EXECUTE FUNCTION public.finops_benefit_claim_insert_guard();

CREATE OR REPLACE FUNCTION public.finops_benefit_claim_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Benefit Claim history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.code, NEW.version, NEW.origin, NEW.currency, NEW.amount,
    NEW.period_start, NEW.period_end, NEW.deliverable_id, NEW.deliverable_version,
    NEW.acceptance_id, NEW.acceptance_version, NEW.evidence_id, NEW.evidence_version,
    NEW.value_definition_id, NEW.value_version_id, NEW.value_version,
    NEW.objective_id, NEW.objective_version, NEW.source_authority,
    NEW.source_system, NEW.source_record_id, NEW.source_record_version,
    NEW.source_content_hash, NEW.agent_run_id, NEW.created_by_user_id,
    NEW.idempotency_key, NEW.request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.code, OLD.version, OLD.origin, OLD.currency, OLD.amount,
    OLD.period_start, OLD.period_end, OLD.deliverable_id, OLD.deliverable_version,
    OLD.acceptance_id, OLD.acceptance_version, OLD.evidence_id, OLD.evidence_version,
    OLD.value_definition_id, OLD.value_version_id, OLD.value_version,
    OLD.objective_id, OLD.objective_version, OLD.source_authority,
    OLD.source_system, OLD.source_record_id, OLD.source_record_version,
    OLD.source_content_hash, OLD.agent_run_id, OLD.created_by_user_id,
    OLD.idempotency_key, OLD.request_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Benefit amount and business/evidence attribution are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('CONFIRMED', 'REJECTED')
    OR NEW.status NOT IN ('CONFIRMED', 'REJECTED')
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Invalid Benefit review transition or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'CONFIRMED' THEN
    IF NEW.confirmation_authority = 'HUMAN'
      AND (NEW.confirmed_by_user_id IS NULL
        OR NEW.confirmed_by_user_id = NEW.created_by_user_id)
    THEN
      RAISE EXCEPTION 'Benefit requires an independent human checker'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.confirmation_authority = 'TRUSTED_SYSTEM'
      AND (NEW.origin <> 'TRUSTED_SYSTEM' OR NEW.trusted_import_receipt IS NULL)
    THEN
      RAISE EXCEPTION 'Trusted-system Benefit requires an immutable import receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_benefit_claim_review_guard_trigger
  BEFORE UPDATE OR DELETE ON public.finops_benefit_claims
  FOR EACH ROW EXECUTE FUNCTION public.finops_benefit_claim_review_guard();

CREATE OR REPLACE FUNCTION public.finops_roi_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  formula_status public."FinopsApprovalStatus";
  actual_cost NUMERIC(30,12);
  actual_benefit NUMERIC(30,12);
BEGIN
  SELECT status INTO formula_status
  FROM public.finops_roi_formula_versions f
  WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.formula_id
    AND f.version = NEW.formula_version;
  IF formula_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'ROI recomputation requires an approved immutable Formula Version'
      USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(c.calculated_amount), 0) INTO actual_cost
  FROM public.finops_cost_entries c
  WHERE c.tenant_id = NEW.tenant_id AND c.currency = NEW.currency
    AND c.verification_status = 'VERIFIED'
    AND c.incurred_at >= NEW.period_start AND c.incurred_at < NEW.period_end;
  SELECT coalesce(sum(b.amount), 0) INTO actual_benefit
  FROM public.finops_benefit_claims b
  WHERE b.tenant_id = NEW.tenant_id AND b.currency = NEW.currency
    AND b.status = 'CONFIRMED'
    AND b.period_start < NEW.period_end AND b.period_end > NEW.period_start;
  IF NEW.verified_cost <> actual_cost OR NEW.confirmed_benefit <> actual_benefit THEN
    RAISE EXCEPTION 'ROI inputs must be recomputed from verified Costs and confirmed Benefits'
      USING ERRCODE = '23514';
  END IF;
  IF actual_cost = 0 THEN
    NEW.status := 'INVALID_ZERO_COST';
    NEW.roi_ratio := NULL;
  ELSE
    NEW.status := 'COMPUTED';
    NEW.roi_ratio := round((actual_benefit - actual_cost) / actual_cost, 12);
  END IF;
  NEW.net_benefit := actual_benefit - actual_cost;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_roi_snapshot_guard_trigger
  BEFORE INSERT ON public.finops_roi_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.finops_roi_snapshot_guard();

CREATE OR REPLACE FUNCTION public.finops_budget_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Budget history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.code, NEW.version, NEW.scope_type, NEW.scope_id,
    NEW.employee_user_id, NEW.role_assignment_id, NEW.task_id, NEW.task_version,
    NEW.process_definition_id, NEW.customer_id, NEW.project_id,
    NEW.department_org_unit_id, NEW.currency, NEW.limit_amount,
    NEW.alert_threshold_ratio, NEW.period_start, NEW.period_end,
    NEW.created_by_user_id, NEW.idempotency_key, NEW.request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.code, OLD.version, OLD.scope_type, OLD.scope_id,
    OLD.employee_user_id, OLD.role_assignment_id, OLD.task_id, OLD.task_version,
    OLD.process_definition_id, OLD.customer_id, OLD.project_id,
    OLD.department_org_unit_id, OLD.currency, OLD.limit_amount,
    OLD.alert_threshold_ratio, OLD.period_start, OLD.period_end,
    OLD.created_by_user_id, OLD.idempotency_key, OLD.request_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Budget policy and amount are immutable; create a new version'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'REJECTED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'Invalid Budget transition or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status = 'ACTIVE'
    AND (NEW.approved_by_user_id IS NULL
      OR NEW.approved_by_user_id = NEW.created_by_user_id)
  THEN
    RAISE EXCEPTION 'Budget activation requires an independent human checker'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_budget_guard_trigger
  BEFORE UPDATE OR DELETE ON public.finops_budgets
  FOR EACH ROW EXECUTE FUNCTION public.finops_budget_guard();

CREATE OR REPLACE FUNCTION public.finops_budget_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  budget public.finops_budgets%ROWTYPE;
  reservation public.finops_budget_events%ROWTYPE;
  committed NUMERIC(30,12);
  observed NUMERIC(30,12);
  settled_amount NUMERIC(30,12);
BEGIN
  SELECT * INTO budget
  FROM public.finops_budgets b
  WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.budget_id
    AND b.version = NEW.budget_version
  FOR UPDATE;
  IF budget.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Budget events require an active approved Budget Version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.currency <> budget.currency THEN
    RAISE EXCEPTION 'Budget event currency must match its Budget Version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at < budget.period_start OR NEW.created_at >= budget.period_end THEN
    RAISE EXCEPTION 'Budget event falls outside its immutable budget period'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.type IN ('SETTLEMENT', 'RELEASE') THEN
    SELECT * INTO reservation
    FROM public.finops_budget_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.budget_id = NEW.budget_id
      AND e.id = NEW.reservation_event_id AND e.type = 'RESERVATION';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Settlement or release must reference a same-budget reservation'
        USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(e.amount), 0) INTO settled_amount
    FROM public.finops_budget_events e
    WHERE e.tenant_id = NEW.tenant_id
      AND e.budget_id = NEW.budget_id
      AND e.reservation_event_id = NEW.reservation_event_id
      AND e.type IN ('SETTLEMENT', 'RELEASE');
    IF settled_amount + NEW.amount > reservation.amount THEN
      RAISE EXCEPTION 'Settlement and release total cannot exceed the reservation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.type = 'SETTLEMENT' THEN
    SELECT calculated_amount INTO settled_amount
    FROM public.finops_cost_entries c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.cost_entry_id;
    IF settled_amount <> NEW.amount THEN
      RAISE EXCEPTION 'Settlement amount must equal the immutable Cost Entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT coalesce(sum(
    CASE
      WHEN type = 'RESERVATION' THEN amount
      WHEN type IN ('SETTLEMENT', 'RELEASE') THEN -amount
      ELSE 0
    END
  ), 0) INTO committed
  FROM public.finops_budget_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.budget_id = NEW.budget_id;
  SELECT coalesce(sum(
    CASE WHEN type IN ('SETTLEMENT', 'ADJUSTMENT') THEN amount ELSE 0 END
  ), 0) INTO observed
  FROM public.finops_budget_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.budget_id = NEW.budget_id;
  IF NEW.type = 'RESERVATION'
    AND observed + greatest(committed, 0) + NEW.amount > budget.limit_amount
  THEN
    RAISE EXCEPTION 'Budget reservation would exceed the active hard limit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_budget_event_guard_trigger
  BEFORE INSERT ON public.finops_budget_events
  FOR EACH ROW EXECUTE FUNCTION public.finops_budget_event_guard();

CREATE OR REPLACE FUNCTION public.finops_budget_alert_projector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  budget public.finops_budgets%ROWTYPE;
  observed NUMERIC(30,12);
  settled NUMERIC(30,12);
  outstanding NUMERIC(30,12);
  threshold NUMERIC(30,12);
BEGIN
  SELECT * INTO budget
  FROM public.finops_budgets b
  WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.budget_id
    AND b.version = NEW.budget_version;
  SELECT
    coalesce(sum(
      CASE WHEN type IN ('SETTLEMENT', 'ADJUSTMENT') THEN amount ELSE 0 END
    ), 0),
    coalesce(sum(
      CASE
        WHEN type = 'RESERVATION' THEN amount
        WHEN type IN ('SETTLEMENT', 'RELEASE') THEN -amount
        ELSE 0
      END
    ), 0)
    INTO settled, outstanding
  FROM public.finops_budget_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.budget_id = NEW.budget_id;
  observed := settled + greatest(outstanding, 0);
  threshold := round(budget.limit_amount * budget.alert_threshold_ratio, 12);
  IF observed >= threshold THEN
    INSERT INTO public.finops_budget_alerts(
      tenant_id, budget_id, budget_version, budget_event_id, type,
      observed_amount, threshold_amount, message
    ) VALUES (
      NEW.tenant_id, NEW.budget_id, NEW.budget_version, NEW.id,
      CASE WHEN observed > budget.limit_amount
        THEN 'HARD_LIMIT_EXCEEDED'::public."FinopsBudgetAlertType"
        ELSE 'THRESHOLD_REACHED'::public."FinopsBudgetAlertType"
      END,
      observed,
      CASE WHEN observed > budget.limit_amount THEN budget.limit_amount ELSE threshold END,
      CASE WHEN observed > budget.limit_amount
        THEN 'Actual settlement exceeds the active budget hard limit; policy remains unchanged.'
        ELSE 'Budget alert threshold reached.'
      END
    ) ON CONFLICT (tenant_id, budget_event_id, type) DO NOTHING;
  END IF;
  IF NEW.type = 'SETTLEMENT' AND NEW.amount <> (
    SELECT amount FROM public.finops_budget_events
    WHERE tenant_id = NEW.tenant_id AND id = NEW.reservation_event_id
  ) THEN
    INSERT INTO public.finops_budget_alerts(
      tenant_id, budget_id, budget_version, budget_event_id, type,
      observed_amount, threshold_amount, message
    ) VALUES (
      NEW.tenant_id, NEW.budget_id, NEW.budget_version, NEW.id,
      'SETTLEMENT_MISMATCH', NEW.amount,
      (SELECT amount FROM public.finops_budget_events
        WHERE tenant_id = NEW.tenant_id AND id = NEW.reservation_event_id),
      'Settlement differs from its immutable reservation.'
    ) ON CONFLICT (tenant_id, budget_event_id, type) DO NOTHING;
  END IF;
  IF NEW.type = 'SETTLEMENT' AND (
    SELECT verification_status
    FROM public.finops_cost_entries
    WHERE tenant_id = NEW.tenant_id AND id = NEW.cost_entry_id
  ) <> 'VERIFIED' THEN
    INSERT INTO public.finops_budget_alerts(
      tenant_id, budget_id, budget_version, budget_event_id, type,
      observed_amount, threshold_amount, message
    ) VALUES (
      NEW.tenant_id, NEW.budget_id, NEW.budget_version, NEW.id,
      'UNVERIFIED_COST', NEW.amount, 0,
      'Settlement references a cost that is not verified ledger truth.'
    ) ON CONFLICT (tenant_id, budget_event_id, type) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER finops_budget_alert_projector_trigger
  AFTER INSERT ON public.finops_budget_events
  FOR EACH ROW EXECUTE FUNCTION public.finops_budget_alert_projector();

CREATE OR REPLACE FUNCTION public.finops_budget_alert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Budget Alert history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.budget_id, NEW.budget_version, NEW.budget_event_id,
    NEW.type, NEW.observed_amount, NEW.threshold_amount, NEW.message, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.budget_id, OLD.budget_version, OLD.budget_event_id,
    OLD.type, OLD.observed_amount, OLD.threshold_amount, OLD.message, OLD.created_at
  ) OR NEW.revision <> OLD.revision + 1
    OR OLD.status <> 'OPEN' OR NEW.status <> 'ACKNOWLEDGED'
  THEN
    RAISE EXCEPTION 'Invalid Budget Alert acknowledgement or stale revision'
      USING ERRCODE = '40001';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_budget_alert_guard_trigger
  BEFORE UPDATE OR DELETE ON public.finops_budget_alerts
  FOR EACH ROW EXECUTE FUNCTION public.finops_budget_alert_guard();

CREATE OR REPLACE FUNCTION public.finops_routing_suggestion_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Routing Suggestion history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.agent_run_id, NEW.current_route, NEW.suggested_route,
    NEW.currency, NEW.estimated_savings, NEW.quality_floor, NEW.policy_boundary,
    NEW.rationale, NEW.auto_applied, NEW.created_by_user_id,
    NEW.idempotency_key, NEW.request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.agent_run_id, OLD.current_route, OLD.suggested_route,
    OLD.currency, OLD.estimated_savings, OLD.quality_floor, OLD.policy_boundary,
    OLD.rationale, OLD.auto_applied, OLD.created_by_user_id,
    OLD.idempotency_key, OLD.request_hash, OLD.created_at
  ) OR OLD.status <> 'PROPOSED'
    OR NEW.status NOT IN ('ACCEPTED_FOR_REVIEW', 'REJECTED')
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Invalid Routing Suggestion decision or stale revision'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.auto_applied THEN
    RAISE EXCEPTION 'FinOps model routing is advisory and can never auto-apply'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER finops_routing_suggestion_guard_trigger
  BEFORE UPDATE OR DELETE ON public.finops_model_routing_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.finops_routing_suggestion_guard();

DO $$
DECLARE
  table_name TEXT;
  immutable_tables CONSTANT TEXT[] := ARRAY[
    'finops_cost_entries', 'finops_dimension_members', 'finops_cost_allocations',
    'finops_roi_snapshots', 'finops_budget_events', 'finops_commands'
  ];
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finops_price_snapshots', 'finops_cost_entries', 'finops_allocation_rules',
    'finops_dimension_members', 'finops_allocation_sets', 'finops_cost_allocations',
    'finops_benefit_claims', 'finops_roi_formula_versions', 'finops_roi_snapshots',
    'finops_budgets', 'finops_budget_events', 'finops_budget_alerts',
    'finops_model_routing_suggestions', 'finops_commands'
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
      'CREATE POLICY enterprise_agent_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
      table_name
    );
    IF table_name = ANY(immutable_tables) THEN
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
  public."FinopsResourceKind", public."FinopsBillingUnit",
  public."FinopsApprovalStatus", public."FinopsCostSubjectType",
  public."FinopsVerificationStatus", public."FinopsSourceAuthority",
  public."FinopsAllocationMethod", public."FinopsDimensionType",
  public."FinopsProposalOrigin", public."FinopsReviewStatus",
  public."FinopsBenefitOrigin", public."FinopsConfirmationAuthority",
  public."FinopsRoiCalculationStatus", public."FinopsBudgetStatus",
  public."FinopsBudgetScopeType", public."FinopsBudgetEventType",
  public."FinopsBudgetAlertType", public."FinopsAlertStatus",
  public."FinopsRoutingSuggestionStatus"
  TO enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.finops_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_price_snapshot_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_prepare_cost_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_version_approval_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_allocation_line_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_allocation_set_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_benefit_claim_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_benefit_claim_review_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_roi_snapshot_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_budget_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_budget_event_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_budget_alert_projector() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_budget_alert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finops_routing_suggestion_guard() FROM PUBLIC;

COMMIT;
