BEGIN;

CREATE TYPE public."KnowledgeOntologyVersionStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED'
);
CREATE TYPE public."KnowledgeGraphCorrectionStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'APPLIED'
);
CREATE TYPE public."KnowledgeGraphCorrectionAction" AS ENUM (
  'MERGE_ENTITY', 'ADD_ALIAS', 'UPSERT_RELATION_VALIDITY', 'RESOLVE_CONFLICT'
);
CREATE TYPE public."KnowledgeGraphConflictStatus" AS ENUM (
  'OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED'
);
CREATE TYPE public."KnowledgeGraphConflictTargetType" AS ENUM ('ENTITY', 'RELATION');

CREATE TABLE public.knowledge_ontologies (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  code VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_ontologies_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_ontologies_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_ontologies_code_key
    UNIQUE (tenant_id, knowledge_base_id, code),
  CONSTRAINT knowledge_ontologies_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT knowledge_ontologies_positive_check CHECK (revision > 0),
  CONSTRAINT knowledge_ontologies_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_ontologies_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontologies_knowledge_base_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_ontologies_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.knowledge_ontology_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  ontology_id UUID NOT NULL,
  version_number INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status public."KnowledgeOntologyVersionStatus" NOT NULL DEFAULT 'DRAFT',
  change_summary VARCHAR(500) NOT NULL,
  schema_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  submitted_by_user_id UUID,
  reviewed_by_user_id UUID,
  review_comment VARCHAR(1000),
  submitted_at TIMESTAMPTZ(6),
  reviewed_at TIMESTAMPTZ(6),
  published_at TIMESTAMPTZ(6),
  retired_at TIMESTAMPTZ(6),
  system_bootstrap BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_ontology_versions_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_ontology_versions_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_ontology_versions_ontology_identity_key
    UNIQUE (tenant_id, knowledge_base_id, ontology_id, id),
  CONSTRAINT knowledge_ontology_versions_number_key
    UNIQUE (tenant_id, knowledge_base_id, ontology_id, version_number),
  CONSTRAINT knowledge_ontology_versions_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT knowledge_ontology_versions_positive_check
    CHECK (version_number > 0 AND revision > 0),
  CONSTRAINT knowledge_ontology_versions_hash_check
    CHECK (schema_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_ontology_versions_state_check CHECK (
    (status = 'DRAFT'
      AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'IN_REVIEW'
      AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
      AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'PUBLISHED'
      AND published_at IS NOT NULL AND retired_at IS NULL
      AND (
        system_bootstrap
        OR (
          reviewed_by_user_id IS NOT NULL
          AND reviewed_by_user_id <> created_by_user_id
          AND reviewed_at IS NOT NULL
        )
      ))
    OR (status = 'RETIRED'
      AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  ),
  CONSTRAINT knowledge_ontology_versions_ontology_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, ontology_id)
    REFERENCES public.knowledge_ontologies(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontology_versions_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontology_versions_submitter_fkey
    FOREIGN KEY (tenant_id, submitted_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontology_versions_reviewer_fkey
    FOREIGN KEY (tenant_id, reviewed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX knowledge_ontology_versions_one_published_idx
  ON public.knowledge_ontology_versions(tenant_id, knowledge_base_id, ontology_id)
  WHERE status = 'PUBLISHED';

CREATE TABLE public.knowledge_ontology_entity_types (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  ontology_version_id UUID NOT NULL,
  key VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  attributes_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_ontology_entity_types_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_ontology_entity_types_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_ontology_entity_types_key
    UNIQUE (tenant_id, knowledge_base_id, ontology_version_id, key),
  CONSTRAINT knowledge_ontology_entity_types_schema_check
    CHECK (jsonb_typeof(attributes_schema) = 'object'),
  CONSTRAINT knowledge_ontology_entity_types_version_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, ontology_version_id)
    REFERENCES public.knowledge_ontology_versions(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE public.knowledge_ontology_predicates (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  ontology_version_id UUID NOT NULL,
  key VARCHAR(120) NOT NULL,
  predicate VARCHAR(200) NOT NULL,
  label VARCHAR(200) NOT NULL,
  domain_type_key VARCHAR(120) NOT NULL,
  range_type_key VARCHAR(120) NOT NULL,
  inverse_predicate_key VARCHAR(120),
  "symmetric" BOOLEAN NOT NULL DEFAULT FALSE,
  functional BOOLEAN NOT NULL DEFAULT FALSE,
  allow_self_loop BOOLEAN NOT NULL DEFAULT FALSE,
  temporal BOOLEAN NOT NULL DEFAULT FALSE,
  attributes_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_ontology_predicates_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_ontology_predicates_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_ontology_predicates_key
    UNIQUE (tenant_id, knowledge_base_id, ontology_version_id, key),
  CONSTRAINT knowledge_ontology_predicates_schema_check
    CHECK (jsonb_typeof(attributes_schema) = 'object'),
  CONSTRAINT knowledge_ontology_predicates_symmetry_check
    CHECK (NOT "symmetric" OR inverse_predicate_key IS NULL),
  CONSTRAINT knowledge_ontology_predicates_version_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, ontology_version_id)
    REFERENCES public.knowledge_ontology_versions(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontology_predicates_domain_fkey
    FOREIGN KEY (
      tenant_id, knowledge_base_id, ontology_version_id, domain_type_key
    ) REFERENCES public.knowledge_ontology_entity_types(
      tenant_id, knowledge_base_id, ontology_version_id, key
    ) ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontology_predicates_range_fkey
    FOREIGN KEY (
      tenant_id, knowledge_base_id, ontology_version_id, range_type_key
    ) REFERENCES public.knowledge_ontology_entity_types(
      tenant_id, knowledge_base_id, ontology_version_id, key
    ) ON DELETE RESTRICT,
  CONSTRAINT knowledge_ontology_predicates_inverse_fkey
    FOREIGN KEY (
      tenant_id, knowledge_base_id, ontology_version_id, inverse_predicate_key
    ) REFERENCES public.knowledge_ontology_predicates(
      tenant_id, knowledge_base_id, ontology_version_id, key
    ) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX knowledge_ontology_predicates_lookup_idx
  ON public.knowledge_ontology_predicates(
    tenant_id, knowledge_base_id, ontology_version_id, predicate
  );

CREATE TABLE public.knowledge_graph_corrections (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  action public."KnowledgeGraphCorrectionAction" NOT NULL,
  patch JSONB NOT NULL,
  evidence JSONB NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  status public."KnowledgeGraphCorrectionStatus" NOT NULL DEFAULT 'DRAFT',
  revision INTEGER NOT NULL DEFAULT 1,
  proposed_by_user_id UUID NOT NULL,
  reviewed_by_user_id UUID,
  review_comment VARCHAR(1000),
  reviewed_at TIMESTAMPTZ(6),
  applied_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_graph_corrections_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_graph_corrections_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_graph_corrections_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT knowledge_graph_corrections_positive_check CHECK (revision > 0),
  CONSTRAINT knowledge_graph_corrections_json_check
    CHECK (jsonb_typeof(patch) = 'object' AND jsonb_typeof(evidence) = 'array'
      AND jsonb_array_length(evidence) > 0),
  CONSTRAINT knowledge_graph_corrections_hash_check
    CHECK (
      evidence_hash ~ '^[a-f0-9]{64}$'
      AND request_hash ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT knowledge_graph_corrections_state_check CHECK (
    (status IN ('DRAFT', 'IN_REVIEW')
      AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED')
      AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id <> proposed_by_user_id
      AND review_comment IS NOT NULL AND reviewed_at IS NOT NULL
      AND applied_at IS NULL)
    OR (status = 'APPLIED'
      AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id <> proposed_by_user_id
      AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
  ),
  CONSTRAINT knowledge_graph_corrections_knowledge_base_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_graph_corrections_proposer_fkey
    FOREIGN KEY (tenant_id, proposed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_graph_corrections_reviewer_fkey
    FOREIGN KEY (tenant_id, reviewed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.knowledge_graph_conflicts (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  target_type public."KnowledgeGraphConflictTargetType" NOT NULL,
  target_id UUID NOT NULL,
  conflict_key VARCHAR(200) NOT NULL,
  conflict_type VARCHAR(120) NOT NULL,
  details JSONB NOT NULL,
  evidence JSONB NOT NULL,
  status public."KnowledgeGraphConflictStatus" NOT NULL DEFAULT 'OPEN',
  revision INTEGER NOT NULL DEFAULT 1,
  detected_by_user_id UUID NOT NULL,
  reviewed_by_user_id UUID,
  resolution_correction_id UUID,
  review_comment VARCHAR(1000),
  resolved_at TIMESTAMPTZ(6),
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_graph_conflicts_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_graph_conflicts_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_graph_conflicts_key
    UNIQUE (tenant_id, knowledge_base_id, conflict_key),
  CONSTRAINT knowledge_graph_conflicts_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT knowledge_graph_conflicts_positive_check CHECK (revision > 0),
  CONSTRAINT knowledge_graph_conflicts_json_check
    CHECK (
      jsonb_typeof(details) = 'object'
      AND jsonb_typeof(evidence) = 'array'
      AND jsonb_array_length(evidence) > 0
    ),
  CONSTRAINT knowledge_graph_conflicts_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_graph_conflicts_resolution_check CHECK (
    (status IN ('OPEN', 'IN_REVIEW')
      AND resolution_correction_id IS NULL AND resolved_at IS NULL)
    OR (status IN ('RESOLVED', 'REJECTED')
      AND reviewed_by_user_id IS NOT NULL
      AND review_comment IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT knowledge_graph_conflicts_knowledge_base_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_graph_conflicts_detector_fkey
    FOREIGN KEY (tenant_id, detected_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_graph_conflicts_reviewer_fkey
    FOREIGN KEY (tenant_id, reviewed_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_graph_conflicts_correction_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, resolution_correction_id)
    REFERENCES public.knowledge_graph_corrections(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX knowledge_graph_conflicts_target_idx
  ON public.knowledge_graph_conflicts(
    tenant_id, knowledge_base_id, target_type, target_id, status
  );

CREATE TABLE public.knowledge_entity_merges (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  source_entity_id UUID NOT NULL,
  target_entity_id UUID NOT NULL,
  correction_id UUID NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  approved_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_entity_merges_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_entity_merges_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_entity_merges_source_key
    UNIQUE (tenant_id, knowledge_base_id, source_entity_id),
  CONSTRAINT knowledge_entity_merges_not_self_check
    CHECK (source_entity_id <> target_entity_id),
  CONSTRAINT knowledge_entity_merges_hash_check
    CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_entity_merges_source_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, source_entity_id)
    REFERENCES public.knowledge_entities(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_entity_merges_target_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, target_entity_id)
    REFERENCES public.knowledge_entities(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_entity_merges_correction_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, correction_id)
    REFERENCES public.knowledge_graph_corrections(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_entity_merges_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.knowledge_entity_aliases (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  alias VARCHAR(500) NOT NULL,
  normalized_alias VARCHAR(500) NOT NULL,
  source_evidence JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  correction_id UUID,
  created_by_user_id UUID NOT NULL,
  retired_by_user_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TIMESTAMPTZ(6),
  CONSTRAINT knowledge_entity_aliases_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_entity_aliases_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_entity_aliases_state_check
    CHECK (
      (active AND retired_by_user_id IS NULL AND retired_at IS NULL)
      OR (NOT active AND retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL)
    ),
  CONSTRAINT knowledge_entity_aliases_evidence_check
    CHECK (jsonb_typeof(source_evidence) = 'object'),
  CONSTRAINT knowledge_entity_aliases_entity_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, entity_id)
    REFERENCES public.knowledge_entities(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_entity_aliases_correction_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, correction_id)
    REFERENCES public.knowledge_graph_corrections(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_entity_aliases_creator_fkey
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_entity_aliases_retirer_fkey
    FOREIGN KEY (tenant_id, retired_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX knowledge_entity_aliases_active_key
  ON public.knowledge_entity_aliases(
    tenant_id, knowledge_base_id, normalized_alias
  ) WHERE active;

CREATE TABLE public.knowledge_entity_source_identities (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  source_system VARCHAR(120) NOT NULL,
  source_record_id VARCHAR(500) NOT NULL,
  source_record_version VARCHAR(200) NOT NULL,
  source_content_hash CHAR(64) NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_entity_source_identities_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_entity_source_identities_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_entity_source_identities_source_key
    UNIQUE (
      tenant_id, knowledge_base_id, source_system,
      source_record_id, source_record_version
    ),
  CONSTRAINT knowledge_entity_source_identities_hash_check
    CHECK (source_content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_entity_source_identities_evidence_check
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT knowledge_entity_source_identities_entity_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, entity_id)
    REFERENCES public.knowledge_entities(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX knowledge_entity_source_identities_entity_idx
  ON public.knowledge_entity_source_identities(
    tenant_id, knowledge_base_id, entity_id
  );

CREATE TABLE public.knowledge_relation_governance (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  relation_id UUID NOT NULL,
  ontology_version_id UUID NOT NULL,
  predicate_definition_id UUID NOT NULL,
  valid_from TIMESTAMPTZ(6) NOT NULL,
  valid_to TIMESTAMPTZ(6),
  correction_id UUID,
  approved_by_user_id UUID,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_relation_governance_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_relation_governance_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_relation_governance_relation_key
    UNIQUE (tenant_id, knowledge_base_id, relation_id),
  CONSTRAINT knowledge_relation_governance_positive_check CHECK (revision > 0),
  CONSTRAINT knowledge_relation_governance_period_check
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT knowledge_relation_governance_relation_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, relation_id)
    REFERENCES public.knowledge_relations(tenant_id, knowledge_base_id, id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_relation_governance_version_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, ontology_version_id)
    REFERENCES public.knowledge_ontology_versions(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_relation_governance_predicate_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, predicate_definition_id)
    REFERENCES public.knowledge_ontology_predicates(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_relation_governance_correction_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id, correction_id)
    REFERENCES public.knowledge_graph_corrections(tenant_id, knowledge_base_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT knowledge_relation_governance_approver_fkey
    FOREIGN KEY (tenant_id, approved_by_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX knowledge_relation_governance_effective_idx
  ON public.knowledge_relation_governance(
    tenant_id, knowledge_base_id, valid_from, valid_to
  );

CREATE TABLE public.knowledge_graph_commands (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  command_type VARCHAR(120) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  resource_type VARCHAR(120) NOT NULL,
  resource_id UUID NOT NULL,
  result_revision INTEGER NOT NULL,
  actor_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT knowledge_graph_commands_pkey PRIMARY KEY (id),
  CONSTRAINT knowledge_graph_commands_scope_identity_key
    UNIQUE (tenant_id, knowledge_base_id, id),
  CONSTRAINT knowledge_graph_commands_idempotency_key
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT knowledge_graph_commands_positive_check CHECK (result_revision > 0),
  CONSTRAINT knowledge_graph_commands_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_graph_commands_knowledge_base_fkey
    FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_graph_commands_actor_fkey
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);

-- Existing extracted graph records are migrated into an explicitly versioned,
-- published bootstrap ontology. New versions cannot use this exception.
INSERT INTO public.knowledge_ontologies (
  tenant_id, knowledge_base_id, code, name, description,
  created_by_user_id, idempotency_key, request_hash
)
SELECT
  kb.tenant_id,
  kb.id,
  'SYSTEM-GRAPH',
  'System bootstrap ontology',
  'Migration receipt for graph records extracted before ontology governance.',
  kb.created_by_id,
  'kg-bootstrap-ontology:' || kb.id::text,
  encode(digest('kg-bootstrap-ontology:' || kb.id::text, 'sha256'), 'hex')
FROM public.knowledge_bases kb
ON CONFLICT (tenant_id, knowledge_base_id, code) DO NOTHING;

INSERT INTO public.knowledge_ontology_versions (
  tenant_id, knowledge_base_id, ontology_id, version_number, status,
  change_summary, schema_hash, created_by_user_id, reviewed_by_user_id,
  review_comment, reviewed_at, published_at, system_bootstrap,
  idempotency_key, request_hash
)
SELECT
  ontology.tenant_id,
  ontology.knowledge_base_id,
  ontology.id,
  1,
  'PUBLISHED',
  'Bootstrap existing extracted graph with an auditable migration receipt.',
  encode(digest('kg-bootstrap-schema:' || ontology.id::text, 'sha256'), 'hex'),
  ontology.created_by_user_id,
  ontology.created_by_user_id,
  'System migration receipt; subsequent versions require maker-checker.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  TRUE,
  'kg-bootstrap-version:' || ontology.id::text,
  encode(digest('kg-bootstrap-version:' || ontology.id::text, 'sha256'), 'hex')
FROM public.knowledge_ontologies ontology
WHERE ontology.code = 'SYSTEM-GRAPH'
ON CONFLICT (tenant_id, knowledge_base_id, ontology_id, version_number) DO NOTHING;

INSERT INTO public.knowledge_ontology_entity_types (
  tenant_id, knowledge_base_id, ontology_version_id, key, name, description
)
SELECT DISTINCT
  entity.tenant_id,
  entity.knowledge_base_id,
  version.id,
  CASE
    WHEN regexp_replace(upper(entity.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
      THEN 'TYPE_' || substr(md5(entity.entity_type), 1, 8)
    ELSE left(regexp_replace(upper(entity.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
  END,
  entity.entity_type,
  'System bootstrap entity type.'
FROM public.knowledge_entities entity
JOIN public.knowledge_ontologies ontology
  ON ontology.tenant_id = entity.tenant_id
 AND ontology.knowledge_base_id = entity.knowledge_base_id
 AND ontology.code = 'SYSTEM-GRAPH'
JOIN public.knowledge_ontology_versions version
  ON version.tenant_id = ontology.tenant_id
 AND version.knowledge_base_id = ontology.knowledge_base_id
 AND version.ontology_id = ontology.id
 AND version.version_number = 1
ON CONFLICT (
  tenant_id, knowledge_base_id, ontology_version_id, key
) DO NOTHING;

INSERT INTO public.knowledge_ontology_predicates (
  tenant_id, knowledge_base_id, ontology_version_id, key, predicate, label,
  domain_type_key, range_type_key
)
SELECT DISTINCT
  relation.tenant_id,
  relation.knowledge_base_id,
  version.id,
  left(
    CASE
      WHEN regexp_replace(upper(relation.normalized_predicate), '[^A-Z0-9]+', '_', 'g') = ''
        THEN 'PREDICATE'
      ELSE regexp_replace(upper(relation.normalized_predicate), '[^A-Z0-9]+', '_', 'g')
    END,
    100
  ) || ':' || substr(md5(subject.entity_type || E'\\x1f' || object.entity_type), 1, 8),
  relation.normalized_predicate,
  relation.predicate,
  CASE
    WHEN regexp_replace(upper(subject.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
      THEN 'TYPE_' || substr(md5(subject.entity_type), 1, 8)
    ELSE left(regexp_replace(upper(subject.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
  END,
  CASE
    WHEN regexp_replace(upper(object.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
      THEN 'TYPE_' || substr(md5(object.entity_type), 1, 8)
    ELSE left(regexp_replace(upper(object.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
  END
FROM public.knowledge_relations relation
JOIN public.knowledge_entities subject
  ON subject.tenant_id = relation.tenant_id
 AND subject.knowledge_base_id = relation.knowledge_base_id
 AND subject.id = relation.subject_entity_id
JOIN public.knowledge_entities object
  ON object.tenant_id = relation.tenant_id
 AND object.knowledge_base_id = relation.knowledge_base_id
 AND object.id = relation.object_entity_id
JOIN public.knowledge_ontologies ontology
  ON ontology.tenant_id = relation.tenant_id
 AND ontology.knowledge_base_id = relation.knowledge_base_id
 AND ontology.code = 'SYSTEM-GRAPH'
JOIN public.knowledge_ontology_versions version
  ON version.tenant_id = ontology.tenant_id
 AND version.knowledge_base_id = ontology.knowledge_base_id
 AND version.ontology_id = ontology.id
 AND version.version_number = 1
ON CONFLICT (
  tenant_id, knowledge_base_id, ontology_version_id, key
) DO NOTHING;

INSERT INTO public.knowledge_relation_governance (
  tenant_id, knowledge_base_id, relation_id, ontology_version_id,
  predicate_definition_id, valid_from, approved_by_user_id
)
SELECT
  relation.tenant_id,
  relation.knowledge_base_id,
  relation.id,
  version.id,
  predicate.id,
  relation.created_at,
  ontology.created_by_user_id
FROM public.knowledge_relations relation
JOIN public.knowledge_entities subject
  ON subject.tenant_id = relation.tenant_id
 AND subject.knowledge_base_id = relation.knowledge_base_id
 AND subject.id = relation.subject_entity_id
JOIN public.knowledge_entities object
  ON object.tenant_id = relation.tenant_id
 AND object.knowledge_base_id = relation.knowledge_base_id
 AND object.id = relation.object_entity_id
JOIN public.knowledge_ontologies ontology
  ON ontology.tenant_id = relation.tenant_id
 AND ontology.knowledge_base_id = relation.knowledge_base_id
 AND ontology.code = 'SYSTEM-GRAPH'
JOIN public.knowledge_ontology_versions version
  ON version.tenant_id = ontology.tenant_id
 AND version.knowledge_base_id = ontology.knowledge_base_id
 AND version.ontology_id = ontology.id
 AND version.version_number = 1
JOIN public.knowledge_ontology_predicates predicate
  ON predicate.tenant_id = version.tenant_id
 AND predicate.knowledge_base_id = version.knowledge_base_id
 AND predicate.ontology_version_id = version.id
 AND predicate.predicate = relation.normalized_predicate
 AND predicate.domain_type_key = CASE
    WHEN regexp_replace(upper(subject.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
      THEN 'TYPE_' || substr(md5(subject.entity_type), 1, 8)
    ELSE left(regexp_replace(upper(subject.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
  END
 AND predicate.range_type_key = CASE
    WHEN regexp_replace(upper(object.entity_type), '[^A-Z0-9]+', '_', 'g') = ''
      THEN 'TYPE_' || substr(md5(object.entity_type), 1, 8)
    ELSE left(regexp_replace(upper(object.entity_type), '[^A-Z0-9]+', '_', 'g'), 120)
  END
ON CONFLICT (tenant_id, knowledge_base_id, relation_id) DO NOTHING;

INSERT INTO public.knowledge_entity_source_identities (
  tenant_id, knowledge_base_id, entity_id, source_system, source_record_id,
  source_record_version, source_content_hash, evidence
)
SELECT
  entity.tenant_id,
  entity.knowledge_base_id,
  entity.id,
  'LEGACY_EXTERNAL_KEY',
  entity.external_key,
  '1',
  encode(digest(entity.external_key, 'sha256'), 'hex'),
  jsonb_build_object('migration', '20260728002000', 'externalKey', entity.external_key)
FROM public.knowledge_entities entity
WHERE entity.external_key IS NOT NULL
ON CONFLICT (
  tenant_id, knowledge_base_id, source_system, source_record_id, source_record_version
) DO NOTHING;

INSERT INTO public.knowledge_entity_aliases (
  tenant_id, knowledge_base_id, entity_id, alias, normalized_alias,
  source_evidence, created_by_user_id
)
SELECT
  entity.tenant_id,
  entity.knowledge_base_id,
  entity.id,
  alias,
  lower(regexp_replace(trim(alias), '\s+', ' ', 'g')),
  jsonb_build_object('migration', '20260728002000', 'source', 'knowledge_entities.aliases'),
  kb.created_by_id
FROM public.knowledge_entities entity
JOIN public.knowledge_bases kb
  ON kb.tenant_id = entity.tenant_id AND kb.id = entity.knowledge_base_id
CROSS JOIN LATERAL unnest(entity.aliases) alias
WHERE trim(alias) <> ''
ON CONFLICT (tenant_id, knowledge_base_id, normalized_alias)
  WHERE active
DO NOTHING;

CREATE OR REPLACE FUNCTION public.knowledge_graph_version_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Ontology Version history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.system_bootstrap IS DISTINCT FROM OLD.system_bootstrap
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.knowledge_base_id <> OLD.knowledge_base_id
    OR NEW.ontology_id <> OLD.ontology_id
    OR NEW.version_number <> OLD.version_number
    OR NEW.change_summary <> OLD.change_summary
    OR NEW.schema_hash <> OLD.schema_hash
    OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash
    OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Ontology Version definition is immutable or revision is stale'
      USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW' THEN
    IF NEW.submitted_by_user_id IS NULL OR NEW.submitted_at IS NULL THEN
      RAISE EXCEPTION 'Submitting an Ontology Version requires submission evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'IN_REVIEW' AND NEW.status IN ('PUBLISHED', 'DRAFT') THEN
    IF NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id = OLD.created_by_user_id
      OR NEW.reviewed_at IS NULL
      OR NEW.review_comment IS NULL
    THEN
      RAISE EXCEPTION 'Ontology Version review requires an independent checker'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED' THEN
    IF NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id = OLD.created_by_user_id
      OR NEW.retired_at IS NULL
    THEN
      RAISE EXCEPTION 'Ontology retirement requires an independent checker'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid Ontology Version lifecycle transition'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_graph_version_transition_guard_trigger
  BEFORE UPDATE OR DELETE ON public.knowledge_ontology_versions
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_version_transition_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_draft_definition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_status public."KnowledgeOntologyVersionStatus";
BEGIN
  SELECT status INTO version_status
  FROM public.knowledge_ontology_versions version
  WHERE version.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
    AND version.knowledge_base_id = COALESCE(NEW.knowledge_base_id, OLD.knowledge_base_id)
    AND version.id = COALESCE(NEW.ontology_version_id, OLD.ontology_version_id);
  IF version_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Ontology definitions are mutable only while their version is DRAFT'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_ontology_entity_types_draft_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_ontology_entity_types
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_draft_definition_guard();
CREATE TRIGGER knowledge_ontology_predicates_draft_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_ontology_predicates
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_draft_definition_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_predicate_consistency_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  inverse_record public.knowledge_ontology_predicates%ROWTYPE;
BEGIN
  IF NEW.inverse_predicate_key IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO inverse_record
  FROM public.knowledge_ontology_predicates inverse_predicate
  WHERE inverse_predicate.tenant_id = NEW.tenant_id
    AND inverse_predicate.knowledge_base_id = NEW.knowledge_base_id
    AND inverse_predicate.ontology_version_id = NEW.ontology_version_id
    AND inverse_predicate.key = NEW.inverse_predicate_key;
  IF NOT FOUND
    OR inverse_record.inverse_predicate_key IS DISTINCT FROM NEW.key
    OR inverse_record.domain_type_key <> NEW.range_type_key
    OR inverse_record.range_type_key <> NEW.domain_type_key
  THEN
    RAISE EXCEPTION 'Inverse predicates must be reciprocal and swap domain/range'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER knowledge_graph_predicate_consistency_trigger
  AFTER INSERT OR UPDATE ON public.knowledge_ontology_predicates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_predicate_consistency_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_correction_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Graph Correction history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.knowledge_base_id <> OLD.knowledge_base_id
    OR NEW.action <> OLD.action
    OR NEW.patch <> OLD.patch
    OR NEW.evidence <> OLD.evidence
    OR NEW.evidence_hash <> OLD.evidence_hash
    OR NEW.proposed_by_user_id <> OLD.proposed_by_user_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash
    OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Graph Correction proposal is immutable or revision is stale'
      USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW' THEN
    NULL;
  ELSIF OLD.status = 'IN_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED') THEN
    IF NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id = OLD.proposed_by_user_id
      OR NEW.reviewed_at IS NULL
      OR NEW.review_comment IS NULL
    THEN
      RAISE EXCEPTION 'Graph Correction review requires an independent checker'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'APPROVED' AND NEW.status = 'APPLIED' THEN
    IF NEW.applied_at IS NULL THEN
      RAISE EXCEPTION 'Applied Graph Correction requires application evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid Graph Correction lifecycle transition'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_graph_correction_transition_guard_trigger
  BEFORE UPDATE OR DELETE ON public.knowledge_graph_corrections
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_correction_transition_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_merge_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  correction public.knowledge_graph_corrections%ROWTYPE;
  cycle_found BOOLEAN;
BEGIN
  SELECT * INTO correction
  FROM public.knowledge_graph_corrections candidate
  WHERE candidate.tenant_id = NEW.tenant_id
    AND candidate.knowledge_base_id = NEW.knowledge_base_id
    AND candidate.id = NEW.correction_id;
  IF correction.status <> 'APPLIED'
    OR correction.action <> 'MERGE_ENTITY'
    OR (correction.patch->>'sourceEntityId')::uuid <> NEW.source_entity_id
    OR (correction.patch->>'targetEntityId')::uuid <> NEW.target_entity_id
    OR correction.reviewed_by_user_id <> NEW.approved_by_user_id
  THEN
    RAISE EXCEPTION 'Entity merge requires a matching applied, independently approved correction'
      USING ERRCODE = '23514';
  END IF;
  WITH RECURSIVE lineage(entity_id, visited) AS (
    SELECT NEW.target_entity_id, ARRAY[NEW.target_entity_id]::uuid[]
    UNION ALL
    SELECT merge_record.target_entity_id, lineage.visited || merge_record.target_entity_id
    FROM lineage
    JOIN public.knowledge_entity_merges merge_record
      ON merge_record.tenant_id = NEW.tenant_id
     AND merge_record.knowledge_base_id = NEW.knowledge_base_id
     AND merge_record.source_entity_id = lineage.entity_id
    WHERE NOT merge_record.target_entity_id = ANY(lineage.visited)
  )
  SELECT EXISTS(
    SELECT 1 FROM lineage WHERE entity_id = NEW.source_entity_id
  ) INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'Entity merge would create an alias-lineage cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_graph_merge_guard_trigger
  BEFORE INSERT ON public.knowledge_entity_merges
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_merge_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER knowledge_entity_merges_append_only_trigger
  BEFORE UPDATE OR DELETE ON public.knowledge_entity_merges
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_append_only_guard();
CREATE TRIGGER knowledge_entity_source_identities_append_only_trigger
  BEFORE UPDATE OR DELETE ON public.knowledge_entity_source_identities
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_append_only_guard();
CREATE TRIGGER knowledge_graph_commands_append_only_trigger
  BEFORE UPDATE OR DELETE ON public.knowledge_graph_commands
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_append_only_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_alias_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  correction public.knowledge_graph_corrections%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.correction_id IS NOT NULL THEN
    SELECT * INTO correction
    FROM public.knowledge_graph_corrections candidate
    WHERE candidate.tenant_id = NEW.tenant_id
      AND candidate.knowledge_base_id = NEW.knowledge_base_id
      AND candidate.id = NEW.correction_id;
    IF correction.status <> 'APPLIED'
      OR correction.action <> 'ADD_ALIAS'
      OR (correction.patch->>'entityId')::uuid <> NEW.entity_id
      OR lower(regexp_replace(trim(correction.patch->>'alias'), '\s+', ' ', 'g'))
        <> NEW.normalized_alias
    THEN
      RAISE EXCEPTION 'Entity alias requires a matching applied correction'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.tenant_id, NEW.knowledge_base_id, NEW.entity_id, NEW.alias,
      NEW.normalized_alias, NEW.source_evidence, NEW.correction_id,
      NEW.created_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.tenant_id, OLD.knowledge_base_id, OLD.entity_id, OLD.alias,
      OLD.normalized_alias, OLD.source_evidence, OLD.correction_id,
      OLD.created_by_user_id, OLD.created_at
    ) OR NOT OLD.active OR NEW.active
      OR NEW.retired_by_user_id IS NULL OR NEW.retired_at IS NULL
    THEN
      RAISE EXCEPTION 'Invalid Entity Alias retirement'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Entity Alias history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_graph_alias_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_entity_aliases
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_alias_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_relation_governance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  version_status public."KnowledgeOntologyVersionStatus";
  predicate_record public.knowledge_ontology_predicates%ROWTYPE;
  relation_record public.knowledge_relations%ROWTYPE;
  subject_type TEXT;
  object_type TEXT;
  subject_key TEXT;
  object_key TEXT;
  correction public.knowledge_graph_corrections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Relation Governance history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id <> OLD.tenant_id
    OR NEW.knowledge_base_id <> OLD.knowledge_base_id
    OR NEW.relation_id <> OLD.relation_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'Relation Governance identity is immutable or revision is stale'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.correction_id IS NULL THEN
    RAISE EXCEPTION 'Governed relation changes require an applied correction'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO correction
  FROM public.knowledge_graph_corrections candidate
  WHERE candidate.tenant_id = NEW.tenant_id
    AND candidate.knowledge_base_id = NEW.knowledge_base_id
    AND candidate.id = NEW.correction_id;
  IF correction.status <> 'APPLIED'
    OR correction.action <> 'UPSERT_RELATION_VALIDITY'
    OR (correction.patch->>'relationId')::uuid <> NEW.relation_id
    OR (correction.patch->>'ontologyVersionId')::uuid <> NEW.ontology_version_id
    OR (correction.patch->>'predicateDefinitionId')::uuid
      <> NEW.predicate_definition_id
  THEN
    RAISE EXCEPTION 'Relation Governance requires a matching applied correction'
      USING ERRCODE = '23514';
  END IF;
  SELECT status INTO version_status
  FROM public.knowledge_ontology_versions version
  WHERE version.tenant_id = NEW.tenant_id
    AND version.knowledge_base_id = NEW.knowledge_base_id
    AND version.id = NEW.ontology_version_id;
  IF version_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'Governed relations require a published Ontology Version'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO predicate_record
  FROM public.knowledge_ontology_predicates predicate
  WHERE predicate.tenant_id = NEW.tenant_id
    AND predicate.knowledge_base_id = NEW.knowledge_base_id
    AND predicate.ontology_version_id = NEW.ontology_version_id
    AND predicate.id = NEW.predicate_definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Predicate definition does not belong to the selected Ontology Version'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO relation_record
  FROM public.knowledge_relations relation
  WHERE relation.tenant_id = NEW.tenant_id
    AND relation.knowledge_base_id = NEW.knowledge_base_id
    AND relation.id = NEW.relation_id
    AND relation.status = 'ACTIVE';
  IF NOT FOUND OR relation_record.normalized_predicate <> predicate_record.predicate THEN
    RAISE EXCEPTION 'Relation predicate does not match its governed Predicate Definition'
      USING ERRCODE = '23514';
  END IF;
  SELECT subject.entity_type, object.entity_type
    INTO subject_type, object_type
  FROM public.knowledge_entities subject
  JOIN public.knowledge_entities object
    ON object.tenant_id = subject.tenant_id
   AND object.knowledge_base_id = subject.knowledge_base_id
   AND object.id = relation_record.object_entity_id
  WHERE subject.tenant_id = NEW.tenant_id
    AND subject.knowledge_base_id = NEW.knowledge_base_id
    AND subject.id = relation_record.subject_entity_id;
  subject_key := left(regexp_replace(upper(subject_type), '[^A-Z0-9]+', '_', 'g'), 120);
  object_key := left(regexp_replace(upper(object_type), '[^A-Z0-9]+', '_', 'g'), 120);
  IF subject_key <> predicate_record.domain_type_key
    OR object_key <> predicate_record.range_type_key
  THEN
    RAISE EXCEPTION 'Relation endpoints violate Predicate domain/range constraints'
      USING ERRCODE = '23514';
  END IF;
  IF relation_record.subject_entity_id = relation_record.object_entity_id
    AND NOT predicate_record.allow_self_loop
  THEN
    RAISE EXCEPTION 'Predicate does not allow self-loop relations'
      USING ERRCODE = '23514';
  END IF;
  IF NOT predicate_record.temporal AND NEW.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'A non-temporal Predicate cannot declare valid_to'
      USING ERRCODE = '23514';
  END IF;
  IF predicate_record.functional AND EXISTS (
    SELECT 1
    FROM public.knowledge_relation_governance existing_governance
    JOIN public.knowledge_relations existing_relation
      ON existing_relation.tenant_id = existing_governance.tenant_id
     AND existing_relation.knowledge_base_id = existing_governance.knowledge_base_id
     AND existing_relation.id = existing_governance.relation_id
    WHERE existing_governance.tenant_id = NEW.tenant_id
      AND existing_governance.knowledge_base_id = NEW.knowledge_base_id
      AND existing_governance.predicate_definition_id = NEW.predicate_definition_id
      AND existing_relation.subject_entity_id = relation_record.subject_entity_id
      AND existing_governance.relation_id <> NEW.relation_id
      AND tstzrange(
        existing_governance.valid_from,
        existing_governance.valid_to,
        '[)'
      ) && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
  ) THEN
    RAISE EXCEPTION 'Functional Predicate has overlapping values for the same subject'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_graph_relation_governance_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_relation_governance
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_relation_governance_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_relation_pair_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  predicate_record public.knowledge_ontology_predicates%ROWTYPE;
  relation_record public.knowledge_relations%ROWTYPE;
  counterpart_key TEXT;
BEGIN
  SELECT * INTO predicate_record
  FROM public.knowledge_ontology_predicates predicate
  WHERE predicate.tenant_id = NEW.tenant_id
    AND predicate.knowledge_base_id = NEW.knowledge_base_id
    AND predicate.id = NEW.predicate_definition_id;
  IF NOT predicate_record."symmetric" AND predicate_record.inverse_predicate_key IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO relation_record
  FROM public.knowledge_relations relation
  WHERE relation.tenant_id = NEW.tenant_id
    AND relation.knowledge_base_id = NEW.knowledge_base_id
    AND relation.id = NEW.relation_id;
  counterpart_key := COALESCE(
    predicate_record.inverse_predicate_key,
    predicate_record.key
  );
  IF NOT EXISTS (
    SELECT 1
    FROM public.knowledge_relation_governance paired_governance
    JOIN public.knowledge_relations paired_relation
      ON paired_relation.tenant_id = paired_governance.tenant_id
     AND paired_relation.knowledge_base_id = paired_governance.knowledge_base_id
     AND paired_relation.id = paired_governance.relation_id
    JOIN public.knowledge_ontology_predicates paired_predicate
      ON paired_predicate.tenant_id = paired_governance.tenant_id
     AND paired_predicate.knowledge_base_id = paired_governance.knowledge_base_id
     AND paired_predicate.id = paired_governance.predicate_definition_id
    WHERE paired_governance.tenant_id = NEW.tenant_id
      AND paired_governance.knowledge_base_id = NEW.knowledge_base_id
      AND paired_governance.ontology_version_id = NEW.ontology_version_id
      AND paired_predicate.key = counterpart_key
      AND paired_relation.subject_entity_id = relation_record.object_entity_id
      AND paired_relation.object_entity_id = relation_record.subject_entity_id
      AND paired_governance.valid_from = NEW.valid_from
      AND paired_governance.valid_to IS NOT DISTINCT FROM NEW.valid_to
  ) THEN
    RAISE EXCEPTION 'Symmetric/inverse Predicate requires a matching reverse assertion'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER knowledge_graph_relation_pair_guard_trigger
  AFTER INSERT OR UPDATE ON public.knowledge_relation_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_relation_pair_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_conflict_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_exists BOOLEAN;
  correction public.knowledge_graph_corrections%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.target_type = 'ENTITY' THEN
      SELECT EXISTS(
        SELECT 1 FROM public.knowledge_entities entity
        WHERE entity.tenant_id = NEW.tenant_id
          AND entity.knowledge_base_id = NEW.knowledge_base_id
          AND entity.id = NEW.target_id
      ) INTO target_exists;
    ELSE
      SELECT EXISTS(
        SELECT 1 FROM public.knowledge_relations relation
        WHERE relation.tenant_id = NEW.tenant_id
          AND relation.knowledge_base_id = NEW.knowledge_base_id
          AND relation.id = NEW.target_id
      ) INTO target_exists;
    END IF;
    IF NOT target_exists THEN
      RAISE EXCEPTION 'Graph Conflict target does not exist in the same tenant and knowledge base'
        USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Graph Conflict history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.knowledge_base_id, NEW.target_type, NEW.target_id,
    NEW.conflict_key, NEW.conflict_type, NEW.details, NEW.evidence,
    NEW.detected_by_user_id, NEW.idempotency_key, NEW.request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.knowledge_base_id, OLD.target_type, OLD.target_id,
    OLD.conflict_key, OLD.conflict_type, OLD.details, OLD.evidence,
    OLD.detected_by_user_id, OLD.idempotency_key, OLD.request_hash, OLD.created_at
  ) OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION 'Graph Conflict evidence is immutable or revision is stale'
      USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'OPEN' AND NEW.status = 'IN_REVIEW' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('OPEN', 'IN_REVIEW') AND NEW.status IN ('RESOLVED', 'REJECTED') THEN
    IF NEW.reviewed_by_user_id IS NULL OR NEW.review_comment IS NULL
      OR NEW.resolved_at IS NULL
    THEN
      RAISE EXCEPTION 'Conflict resolution requires human review evidence'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'RESOLVED' THEN
      SELECT * INTO correction
      FROM public.knowledge_graph_corrections candidate
      WHERE candidate.tenant_id = NEW.tenant_id
        AND candidate.knowledge_base_id = NEW.knowledge_base_id
        AND candidate.id = NEW.resolution_correction_id;
      IF correction.status <> 'APPLIED'
        OR correction.action <> 'RESOLVE_CONFLICT'
        OR (correction.patch->>'conflictId')::uuid <> NEW.id
      THEN
        RAISE EXCEPTION 'Resolved conflict requires a matching applied correction'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid Graph Conflict lifecycle transition'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER knowledge_graph_conflict_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_graph_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_graph_conflict_guard();

CREATE OR REPLACE FUNCTION public.knowledge_graph_resolve_canonical_entity(
  requested_tenant_id UUID,
  requested_knowledge_base_id UUID,
  requested_entity_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_tenant_id UUID;
  current_entity_id UUID := requested_entity_id;
  next_entity_id UUID;
  visited UUID[] := ARRAY[requested_entity_id]::uuid[];
BEGIN
  active_tenant_id :=
    NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  IF active_tenant_id IS NULL OR active_tenant_id <> requested_tenant_id THEN
    RAISE EXCEPTION 'Canonical entity traversal is outside the active tenant'
      USING ERRCODE = '42501';
  END IF;
  LOOP
    SELECT merge_record.target_entity_id INTO next_entity_id
    FROM public.knowledge_entity_merges merge_record
    WHERE merge_record.tenant_id = requested_tenant_id
      AND merge_record.knowledge_base_id = requested_knowledge_base_id
      AND merge_record.source_entity_id = current_entity_id;
    IF next_entity_id IS NULL THEN
      RETURN current_entity_id;
    END IF;
    IF next_entity_id = ANY(visited) THEN
      RAISE EXCEPTION 'Entity merge lineage contains a cycle'
        USING ERRCODE = '23514';
    END IF;
    visited := visited || next_entity_id;
    current_entity_id := next_entity_id;
  END LOOP;
END
$$;

CREATE VIEW public.knowledge_graph_retrieval_relations
WITH (security_barrier = true)
AS
SELECT
  relation.id,
  relation.tenant_id,
  relation.knowledge_base_id,
  public.knowledge_graph_resolve_canonical_entity(
    relation.tenant_id,
    relation.knowledge_base_id,
    relation.subject_entity_id
  ) AS subject_entity_id,
  public.knowledge_graph_resolve_canonical_entity(
    relation.tenant_id,
    relation.knowledge_base_id,
    relation.object_entity_id
  ) AS object_entity_id,
  relation.predicate,
  relation.normalized_predicate,
  relation.attributes,
  relation.confidence,
  relation.status,
  governance.valid_from,
  governance.valid_to,
  governance.ontology_version_id,
  governance.predicate_definition_id
FROM public.knowledge_relations relation
JOIN public.knowledge_relation_governance governance
  ON governance.tenant_id = relation.tenant_id
 AND governance.knowledge_base_id = relation.knowledge_base_id
 AND governance.relation_id = relation.id
JOIN public.knowledge_ontology_versions version
  ON version.tenant_id = governance.tenant_id
 AND version.knowledge_base_id = governance.knowledge_base_id
 AND version.id = governance.ontology_version_id
 AND version.status = 'PUBLISHED'
JOIN public.knowledge_ontology_predicates predicate
  ON predicate.tenant_id = governance.tenant_id
 AND predicate.knowledge_base_id = governance.knowledge_base_id
 AND predicate.id = governance.predicate_definition_id
JOIN public.knowledge_entities subject
  ON subject.tenant_id = relation.tenant_id
 AND subject.knowledge_base_id = relation.knowledge_base_id
 AND subject.id = public.knowledge_graph_resolve_canonical_entity(
    relation.tenant_id,
    relation.knowledge_base_id,
    relation.subject_entity_id
 )
 AND subject.status = 'ACTIVE'
JOIN public.knowledge_entities object
  ON object.tenant_id = relation.tenant_id
 AND object.knowledge_base_id = relation.knowledge_base_id
 AND object.id = public.knowledge_graph_resolve_canonical_entity(
    relation.tenant_id,
    relation.knowledge_base_id,
    relation.object_entity_id
 )
 AND object.status = 'ACTIVE'
WHERE relation.tenant_id =
    NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND relation.status = 'ACTIVE'
  AND governance.valid_from <= CURRENT_TIMESTAMP
  AND (governance.valid_to IS NULL OR governance.valid_to > CURRENT_TIMESTAMP)
  AND (
    predicate.allow_self_loop
    OR public.knowledge_graph_resolve_canonical_entity(
      relation.tenant_id, relation.knowledge_base_id, relation.subject_entity_id
    ) <> public.knowledge_graph_resolve_canonical_entity(
      relation.tenant_id, relation.knowledge_base_id, relation.object_entity_id
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.knowledge_graph_conflicts conflict
    WHERE conflict.tenant_id = relation.tenant_id
      AND conflict.knowledge_base_id = relation.knowledge_base_id
      AND conflict.status IN ('OPEN', 'IN_REVIEW')
      AND (
        (conflict.target_type = 'RELATION' AND conflict.target_id = relation.id)
        OR (
          conflict.target_type = 'ENTITY'
          AND conflict.target_id IN (
            relation.subject_entity_id,
            relation.object_entity_id,
            public.knowledge_graph_resolve_canonical_entity(
              relation.tenant_id,
              relation.knowledge_base_id,
              relation.subject_entity_id
            ),
            public.knowledge_graph_resolve_canonical_entity(
              relation.tenant_id,
              relation.knowledge_base_id,
              relation.object_entity_id
            )
          )
        )
      )
  );

DO $$
DECLARE
  table_name TEXT;
  append_only_tables CONSTANT TEXT[] := ARRAY[
    'knowledge_entity_merges',
    'knowledge_entity_source_identities',
    'knowledge_graph_commands'
  ];
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_ontologies',
    'knowledge_ontology_versions',
    'knowledge_ontology_entity_types',
    'knowledge_ontology_predicates',
    'knowledge_graph_corrections',
    'knowledge_graph_conflicts',
    'knowledge_entity_merges',
    'knowledge_entity_aliases',
    'knowledge_entity_source_identities',
    'knowledge_relation_governance',
    'knowledge_graph_commands'
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
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
      table_name
    );
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

REVOKE ALL ON TABLE public.knowledge_graph_retrieval_relations FROM PUBLIC;
GRANT SELECT ON TABLE public.knowledge_graph_retrieval_relations
  TO enterprise_agent_app, enterprise_agent_admin;

GRANT USAGE ON TYPE
  public."KnowledgeOntologyVersionStatus",
  public."KnowledgeGraphCorrectionStatus",
  public."KnowledgeGraphCorrectionAction",
  public."KnowledgeGraphConflictStatus",
  public."KnowledgeGraphConflictTargetType"
TO enterprise_agent_admin;

REVOKE ALL ON FUNCTION public.knowledge_graph_version_transition_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_draft_definition_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_predicate_consistency_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_correction_transition_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_merge_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_alias_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_relation_governance_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_relation_pair_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_conflict_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.knowledge_graph_resolve_canonical_entity(UUID, UUID, UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.knowledge_graph_resolve_canonical_entity(UUID, UUID, UUID)
TO enterprise_agent_app, enterprise_agent_admin;

COMMIT;
