import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(databaseTestsEnabled)('PostgreSQL tenant RLS', () => {
  const prisma = new PrismaClient();
  const tenantId = '00000000-0000-7000-8000-000000000001';
  const otherTenantId = '00000000-0000-7000-8000-000000000009';
  const otherTenantUserId = '00000000-0000-7000-8000-000000000109';
  const aiEvaluationTables = [
    'ai_evaluation_annotation_evidence',
    'ai_evaluation_annotations',
    'ai_evaluation_answer_feedback_sources',
    'ai_evaluation_bad_case_evidence',
    'ai_evaluation_bad_cases',
    'ai_evaluation_case_evidence',
    'ai_evaluation_case_result_evidence',
    'ai_evaluation_case_results',
    'ai_evaluation_cases',
    'ai_evaluation_dataset_versions',
    'ai_evaluation_datasets',
    'ai_evaluation_metric_result_evidence',
    'ai_evaluation_metric_results',
    'ai_evaluation_release_checks',
    'ai_evaluation_review_evidence',
    'ai_evaluation_runner_attestations',
    'ai_evaluation_runners',
    'ai_evaluation_runs',
    'ai_evaluation_thresholds',
    'ai_evaluation_verification_evidence',
  ] as const;
  const tenantRlsTableNames = [
    'acceptance_evidence',
    'acceptances',
    'agent_instances',
    'agent_run_stream_events',
    'agent_runs',
    'agent_templates',
    'agent_versions',
    'ai_model_connectivity_probes',
    'ai_runtime_runs',
    'answer_feedbacks',
    'audit_events',
    'auth_action_tokens',
    'auth_recovery_deliveries',
    'auth_sessions',
    'business_event_deliveries',
    'business_event_effects',
    'business_event_evidence',
    'business_events',
    'collaboration_message_evidence',
    'collaboration_message_recipients',
    'collaboration_messages',
    'collaboration_participants',
    'collaborations',
    'competency_appeal_evidence',
    'competency_appeals',
    'competency_assessment_attributions',
    'competency_assessment_confirmations',
    'competency_assessments',
    'competency_behavior_anchors',
    'competency_definitions',
    'competency_evidence',
    'competency_gaps',
    'competency_levels',
    'competency_versions',
    'conversation_participants',
    'conversations',
    'correction_case_evidence',
    'correction_cases',
    'correction_feedback',
    'correction_feedback_evidence',
    'deliverable_evidence',
    'deliverables',
    'development_actions',
    'development_plans',
    'directory_employment_bindings',
    'directory_integrations',
    'directory_org_unit_bindings',
    'directory_sync_preview_items',
    'directory_sync_previews',
    'directory_sync_runs',
    'directory_user_bindings',
    'employee_task_acceptance_requests',
    'employee_task_commands',
    'employments',
    'evidence',
    'evidence_links',
    'experience_candidates',
    'experience_commands',
    'experience_knowledge_projections',
    'experience_publication_org_targets',
    'experience_publication_role_targets',
    'experience_publications',
    'experience_review_evidence',
    'experience_source_deliverables',
    'experience_source_evidence',
    'experience_validations',
    'finops_allocation_rules',
    'finops_allocation_sets',
    'finops_benefit_claims',
    'finops_budget_alerts',
    'finops_budget_events',
    'finops_budgets',
    'finops_commands',
    'finops_cost_allocations',
    'finops_cost_entries',
    'finops_cost_verification_reviews',
    'finops_dimension_members',
    'finops_model_routing_suggestions',
    'finops_price_snapshots',
    'finops_projection_diagnostics',
    'finops_projection_jobs',
    'finops_roi_formula_versions',
    'finops_roi_snapshots',
    'knowledge_base_org_units',
    'knowledge_bases',
    'knowledge_chunk_embeddings',
    'knowledge_chunks',
    'knowledge_document_versions',
    'knowledge_documents',
    'knowledge_entities',
    'knowledge_entity_aliases',
    'knowledge_entity_mentions',
    'knowledge_entity_merges',
    'knowledge_entity_source_identities',
    'knowledge_graph_commands',
    'knowledge_graph_conflicts',
    'knowledge_graph_corrections',
    'knowledge_graph_projections',
    'knowledge_ingestion_jobs',
    'knowledge_ontologies',
    'knowledge_ontology_entity_types',
    'knowledge_ontology_predicates',
    'knowledge_ontology_versions',
    'knowledge_relation_evidence',
    'knowledge_relation_governance',
    'knowledge_relations',
    'manager_relations',
    'marketing_action_item_contributors',
    'marketing_action_item_dependencies',
    'marketing_action_items',
    'marketing_action_plans',
    'marketing_customer_segments',
    'marketing_insight_observations',
    'marketing_insights',
    'marketing_observation_evidence',
    'marketing_observations',
    'marketing_products',
    'marketing_regions',
    'marketing_targets',
    'memory_commands',
    'memory_records',
    'memory_source_evidence',
    'messages',
    'metric_definitions',
    'metric_observation_evidence',
    'metric_observations',
    'objective_metric_definitions',
    'objective_relations',
    'objective_role_assignments',
    'objective_value_versions',
    'objectives',
    'org_units',
    'organization_change_confirmations',
    'organization_change_proposals',
    'organization_impact_items',
    'organization_impact_reports',
    'organizations',
    'outbox_event_deliveries',
    'outbox_events',
    'password_credentials',
    'positions',
    'process_commands',
    'process_definitions',
    'process_edges',
    'process_instances',
    'process_nodes',
    'process_step_commands',
    'process_step_instances',
    'process_versions',
    'role_assignments',
    'role_competency_requirements',
    'strategies',
    'strategy_value_versions',
    'task_dependencies',
    'tasks',
    'tenants',
    'triangle_health_components',
    'triangle_health_policies',
    'triangle_health_snapshot_evidence',
    'triangle_health_snapshots',
    'triangle_team_members',
    'triangle_team_metrics',
    'triangle_teams',
    'users',
    'value_constraints',
    'value_definitions',
    'value_metrics',
    'value_versions',
  ] as const;

  const tenantRlsRoleOverrides: Partial<
    Record<(typeof tenantRlsTableNames)[number], readonly string[]>
  > = {
    auth_action_tokens: ['enterprise_agent_admin'],
    auth_recovery_deliveries: ['enterprise_agent_admin'],
    auth_sessions: ['enterprise_agent_admin'],
    directory_employment_bindings: ['enterprise_agent_admin'],
    directory_integrations: ['enterprise_agent_admin'],
    directory_org_unit_bindings: ['enterprise_agent_admin'],
    directory_sync_runs: ['enterprise_agent_admin'],
    directory_user_bindings: ['enterprise_agent_admin'],
    knowledge_base_org_units: ['enterprise_agent_admin', 'enterprise_agent_app'],
    knowledge_bases: ['enterprise_agent_admin', 'enterprise_agent_app'],
    knowledge_documents: ['enterprise_agent_admin', 'enterprise_agent_app'],
    knowledge_ingestion_jobs: ['enterprise_agent_admin', 'enterprise_agent_app'],
    outbox_event_deliveries: [
      'enterprise_agent_admin',
      'enterprise_agent_app',
      'enterprise_agent_provisioner',
    ],
    outbox_events: ['enterprise_agent_app', 'enterprise_agent_provisioner'],
    password_credentials: ['enterprise_agent_admin'],
    tenants: ['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner'],
    users: ['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner'],
  };

  const tenantRlsBaseline = tenantRlsTableNames.map((tableName) => ({
    tableName,
    tenantColumn: tableName === 'tenants' ? 'id' : 'tenant_id',
    roles: tenantRlsRoleOverrides[tableName] ?? ['PUBLIC'],
  }));

  // These tenant-owned tables use deliberately specialized restrictive
  // policies instead of the shared `tenant_isolation` policy. Keep their
  // schema inventory explicit so a newly introduced tenant table cannot evade
  // either the generic or a domain-specific RLS regression gate.
  const specializedTenantPolicyTables = [
    'ai_governance_commands',
    'ai_model_attempt_receipts',
    'ai_model_catalog_versions',
    'ai_model_circuit_states',
    'ai_model_route_candidates',
    'ai_model_route_policy_versions',
    'ai_safety_decisions',
    'auth_mfa_challenges',
    'auth_refresh_token_history',
    'enterprise_identity_policies',
    'enterprise_identity_providers',
    'identity_break_glass_events',
    'identity_break_glass_requests',
    'identity_deprovisioning_actions',
    'identity_devices',
    'identity_governance_commands',
    'identity_provider_secrets',
    'mfa_recovery_codes',
    'oidc_account_bindings',
    'oidc_auth_transactions',
    'oidc_provider_configs',
    'oidc_token_validation_receipts',
    'saml_assertion_receipts',
    'saml_authn_requests',
    'saml_provider_configs',
    'scim_connectors',
    'scim_group_memberships',
    'scim_groups',
    'scim_provisioning_requests',
    'scim_service_tokens',
    'scim_users',
    'tool_compensation_bindings',
    'tool_reconciliation_attempts',
    'tool_reconciliation_receipts',
    'user_mfa_factors',
  ] as const;

  const tenantScopedForeignKeys = [
    'ai_model_connectivity_probes_catalog_fkey',
    'ai_model_connectivity_probes_conversation_fkey',
    'ai_model_connectivity_probes_requester_fkey',
    'ai_model_connectivity_probes_run_fkey',
    'ai_runtime_runs_tenant_id_fkey',
    'agent_instances_tenant_id_created_by_id_fkey',
    'agent_instances_tenant_id_owner_user_id_fkey',
    'agent_instances_tenant_id_version_id_fkey',
    'agent_versions_tenant_id_template_id_fkey',
    'agent_versions_tenant_created_by_id_fkey',
    'agent_versions_tenant_review_requested_by_id_fkey',
    'agent_versions_tenant_reviewed_by_id_fkey',
    'agent_versions_tenant_approved_by_id_fkey',
    'agent_versions_tenant_published_by_id_fkey',
    'agent_versions_tenant_retired_by_id_fkey',
    'agent_versions_tenant_rollback_of_version_id_fkey',
    'conversation_participants_tenant_id_agent_id_fkey',
    'conversation_participants_tenant_id_conversation_id_fkey',
    'conversation_participants_tenant_id_user_id_fkey',
    'conversations_tenant_id_created_by_id_fkey',
    'conversations_tenant_id_relay_agent_a_id_fkey',
    'conversations_tenant_id_relay_agent_b_id_fkey',
    'agent_runs_tenant_id_agent_id_fkey',
    'agent_runs_tenant_id_agent_version_id_fkey',
    'agent_runs_tenant_id_conversation_id_fkey',
    'agent_runs_tenant_id_input_message_id_fkey',
    'agent_runs_tenant_id_output_message_id_fkey',
    'agent_runs_tenant_id_parent_run_id_fkey',
    'agent_runs_tenant_id_requester_user_id_fkey',
    'agent_runs_tenant_task_id_fkey',
    'auth_sessions_tenant_id_user_id_fkey',
    'auth_action_tokens_tenant_id_user_id_fkey',
    'auth_action_tokens_tenant_id_created_by_id_fkey',
    'auth_recovery_deliveries_tenant_id_fkey',
    'auth_recovery_deliveries_action_token_fkey',
    'business_events_tenant_fkey',
    'business_events_causation_fkey',
    'business_event_evidence_event_fkey',
    'business_event_evidence_evidence_fkey',
    'business_event_deliveries_tenant_fkey',
    'business_event_deliveries_event_fkey',
    'business_event_deliveries_replayer_fkey',
    'business_event_effects_tenant_fkey',
    'business_event_effects_event_fkey',
    'business_event_effects_delivery_fkey',
    'collaborations_tenant_fkey',
    'collaborations_objective_fkey',
    'collaborations_task_fkey',
    'collaborations_requester_fkey',
    'collaborations_latest_message_fkey',
    'collaboration_participants_collaboration_fkey',
    'collaboration_participants_assignment_fkey',
    'collaboration_participants_user_fkey',
    'collaboration_participants_agent_fkey',
    'collaboration_messages_tenant_fkey',
    'collaboration_messages_collaboration_fkey',
    'collaboration_messages_causation_fkey',
    'collaboration_messages_sender_user_fkey',
    'collaboration_messages_sender_agent_fkey',
    'collaboration_messages_sender_assignment_fkey',
    'collaboration_messages_objective_fkey',
    'collaboration_messages_task_fkey',
    'collaboration_message_recipients_message_fkey',
    'collaboration_message_recipients_assignment_fkey',
    'collaboration_message_evidence_message_fkey',
    'collaboration_message_evidence_evidence_fkey',
    'correction_cases_tenant_fkey',
    'correction_cases_assignment_fkey',
    'correction_cases_objective_fkey',
    'correction_cases_task_fkey',
    'correction_cases_process_instance_fkey',
    'correction_case_evidence_case_fkey',
    'correction_case_evidence_evidence_fkey',
    'correction_feedback_case_fkey',
    'correction_feedback_actor_user_fkey',
    'correction_feedback_actor_assignment_fkey',
    'correction_feedback_evidence_feedback_fkey',
    'correction_feedback_evidence_evidence_fkey',
    'experience_knowledge_projections_tenant_fkey',
    'experience_knowledge_projections_experience_fkey',
    'experience_knowledge_projections_knowledge_base_fkey',
    'experience_knowledge_projections_document_fkey',
    'experience_knowledge_projections_document_version_fkey',
    'experience_knowledge_projections_creator_fkey',
    'employments_tenant_id_organization_id_org_unit_id_fkey',
    'employments_tenant_id_organization_id_fkey',
    'employments_tenant_id_organization_id_position_id_fkey',
    'employments_tenant_id_user_id_fkey',
    'manager_relations_tenant_id_employment_id_fkey',
    'manager_relations_tenant_id_manager_employment_id_fkey',
    'role_assignments_tenant_id_user_id_fkey',
    'role_assignments_tenant_id_employment_id_fkey',
    'role_assignments_tenant_role_template_id_fkey',
    'role_assignments_tenant_role_version_id_fkey',
    'role_assignments_tenant_agent_instance_version_id_fkey',
    'role_assignments_tenant_id_delegated_from_assignment_id_fkey',
    'role_assignments_tenant_id_created_by_id_fkey',
    'role_assignments_tenant_id_revoked_by_id_fkey',
    'tasks_objective_value_fkey',
    'tasks_process_definition_fkey',
    'tasks_process_node_fkey',
    'tasks_process_version_fkey',
    'messages_tenant_id_conversation_id_fkey',
    'messages_tenant_id_sender_agent_id_fkey',
    'messages_tenant_id_sender_user_id_fkey',
    'answer_feedbacks_tenant_id_message_id_fkey',
    'answer_feedbacks_tenant_id_user_id_fkey',
    'knowledge_bases_tenant_id_created_by_id_fkey',
    'knowledge_base_org_units_tenant_id_knowledge_base_id_fkey',
    'knowledge_base_org_units_tenant_id_org_unit_id_fkey',
    'knowledge_documents_tenant_id_created_by_id_fkey',
    'knowledge_documents_tenant_id_knowledge_base_id_fkey',
    'knowledge_documents_current_version_fkey',
    'knowledge_document_versions_knowledge_base_fkey',
    'knowledge_document_versions_document_fkey',
    'knowledge_document_versions_created_by_fkey',
    'knowledge_document_versions_evaluation_run_fkey',
    'knowledge_document_versions_evaluation_dataset_version_fkey',
    'knowledge_chunks_knowledge_base_fkey',
    'knowledge_chunks_document_fkey',
    'knowledge_chunks_document_version_fkey',
    'knowledge_chunk_embeddings_chunk_fkey',
    'knowledge_entities_knowledge_base_fkey',
    'knowledge_entity_mentions_knowledge_base_fkey',
    'knowledge_entity_mentions_entity_fkey',
    'knowledge_entity_mentions_document_fkey',
    'knowledge_entity_mentions_document_version_fkey',
    'knowledge_entity_mentions_chunk_fkey',
    'knowledge_relations_knowledge_base_fkey',
    'knowledge_relations_subject_entity_fkey',
    'knowledge_relations_object_entity_fkey',
    'knowledge_relation_evidence_knowledge_base_fkey',
    'knowledge_relation_evidence_relation_fkey',
    'knowledge_relation_evidence_document_fkey',
    'knowledge_relation_evidence_document_version_fkey',
    'knowledge_relation_evidence_chunk_fkey',
    'knowledge_ingestion_jobs_document_version_fkey',
    'outbox_event_deliveries_event_fkey',
    'outbox_event_deliveries_tenant_id_fkey',
    'org_units_tenant_id_organization_id_fkey',
    'org_units_tenant_id_organization_id_parent_id_fkey',
    'password_credentials_tenant_id_user_id_fkey',
    'positions_tenant_id_organization_id_org_unit_id_fkey',
    'positions_tenant_id_organization_id_fkey',
    'process_edges_tenant_fkey',
    'process_edges_version_fkey',
    'process_edges_from_node_fkey',
    'process_edges_to_node_fkey',
    'process_instances_tenant_fkey',
    'process_instances_version_fkey',
    'process_instances_objective_fkey',
    'process_instances_task_fkey',
    'process_step_instances_tenant_fkey',
    'process_step_instances_instance_fkey',
    'process_step_instances_node_fkey',
    'process_step_instances_assignment_fkey',
    'process_step_instances_agent_fkey',
    'process_step_instances_compensation_fkey',
    'process_commands_tenant_fkey',
    'process_commands_instance_fkey',
    'process_commands_actor_fkey',
    'process_commands_actor_agent_fkey',
    'process_commands_actor_assignment_fkey',
    'process_step_commands_tenant_fkey',
    'process_step_commands_step_fkey',
    'process_step_commands_actor_fkey',
    'process_step_commands_actor_agent_fkey',
    'process_step_commands_actor_assignment_fkey',
    'tasks_process_instance_fkey',
    'directory_integrations_tenant_id_organization_id_fkey',
    'directory_user_bindings_tenant_id_integration_id_fkey',
    'directory_user_bindings_tenant_id_user_id_fkey',
    'directory_org_unit_bindings_integration_organization_fkey',
    'directory_org_unit_bindings_tenant_org_unit_fkey',
    'directory_employment_bindings_integration_organization_fkey',
    'directory_employment_bindings_user_binding_fkey',
    'directory_employment_bindings_org_unit_binding_fkey',
    'directory_employment_bindings_employment_identity_fkey',
    'ai_evaluation_datasets_tenant_fkey',
    'ai_evaluation_datasets_creator_fkey',
    'ai_evaluation_dataset_versions_dataset_fkey',
    'ai_evaluation_dataset_versions_submitter_fkey',
    'ai_evaluation_dataset_versions_reviewer_fkey',
    'ai_evaluation_dataset_versions_publisher_fkey',
    'ai_evaluation_dataset_versions_creator_fkey',
    'ai_evaluation_datasets_published_version_fkey',
    'ai_evaluation_thresholds_version_fkey',
    'ai_evaluation_cases_version_fkey',
    'ai_evaluation_cases_creator_fkey',
    'ai_evaluation_case_evidence_case_fkey',
    'ai_evaluation_case_evidence_evidence_fkey',
    'ai_evaluation_annotations_version_fkey',
    'ai_evaluation_annotations_case_fkey',
    'ai_evaluation_annotations_actor_fkey',
    'ai_evaluation_annotation_evidence_annotation_fkey',
    'ai_evaluation_annotation_evidence_evidence_fkey',
    'ai_evaluation_review_evidence_version_fkey',
    'ai_evaluation_review_evidence_evidence_fkey',
    'ai_evaluation_runner_attestations_tenant_fkey',
    'ai_evaluation_runner_attestations_run_fkey',
    'ai_evaluation_runner_attestations_runner_fkey',
    'ai_evaluation_runners_creator_fkey',
    'ai_evaluation_runs_version_fkey',
    'ai_evaluation_runs_runner_fkey',
    'ai_evaluation_runs_result_runner_fkey',
    'ai_evaluation_runs_submitter_fkey',
    'ai_evaluation_runs_verifier_fkey',
    'ai_evaluation_runs_creator_fkey',
    'ai_evaluation_case_results_run_fkey',
    'ai_evaluation_case_results_case_fkey',
    'ai_evaluation_case_result_evidence_result_fkey',
    'ai_evaluation_case_result_evidence_evidence_fkey',
    'ai_evaluation_metric_results_run_fkey',
    'ai_evaluation_metric_result_evidence_metric_fkey',
    'ai_evaluation_metric_result_evidence_evidence_fkey',
    'ai_evaluation_verification_evidence_run_fkey',
    'ai_evaluation_verification_evidence_evidence_fkey',
    'ai_evaluation_bad_cases_reporter_fkey',
    'ai_evaluation_bad_cases_triager_fkey',
    'ai_evaluation_bad_cases_mapped_version_fkey',
    'ai_evaluation_bad_cases_mapped_case_fkey',
    'ai_evaluation_cases_source_bad_case_fkey',
    'ai_evaluation_bad_case_evidence_bad_case_fkey',
    'ai_evaluation_bad_case_evidence_evidence_fkey',
    'ai_evaluation_answer_feedback_sources_bad_case_fkey',
    'ai_evaluation_answer_feedback_sources_feedback_fkey',
    'ai_evaluation_answer_feedback_sources_conversation_fkey',
    'ai_evaluation_answer_feedback_sources_message_fkey',
    'ai_evaluation_answer_feedback_sources_input_message_fkey',
    'ai_evaluation_answer_feedback_sources_run_fkey',
    'ai_evaluation_answer_feedback_sources_agent_fkey',
    'ai_evaluation_answer_feedback_sources_agent_version_fkey',
    'ai_evaluation_answer_feedback_sources_reporter_fkey',
    'ai_evaluation_release_checks_dataset_fkey',
    'ai_evaluation_release_checks_run_fkey',
    'ai_evaluation_release_checks_actor_fkey',
    'agent_versions_evaluation_run_fkey',
    'agent_versions_evaluation_dataset_version_fkey',
  ] as const;

  const tenantRootForeignKeys = new Set([
    'ai_runtime_runs_tenant_id_fkey',
    'business_events_tenant_fkey',
    'business_event_deliveries_tenant_fkey',
    'business_event_effects_tenant_fkey',
    'collaborations_tenant_fkey',
    'collaboration_messages_tenant_fkey',
    'correction_cases_tenant_fkey',
    'experience_knowledge_projections_tenant_fkey',
    'outbox_event_deliveries_tenant_id_fkey',
    'process_edges_tenant_fkey',
    'process_instances_tenant_fkey',
    'process_step_instances_tenant_fkey',
    'process_commands_tenant_fkey',
    'process_step_commands_tenant_fkey',
    'ai_evaluation_datasets_tenant_fkey',
    'ai_evaluation_runner_attestations_tenant_fkey',
  ]);

  const processTableAclBaseline = {
    acceptance_evidence: ['SELECT'],
    acceptances: ['SELECT'],
    agent_instances: ['SELECT'],
    agent_templates: ['SELECT'],
    agent_versions: ['SELECT'],
    business_event_deliveries: ['INSERT', 'SELECT', 'UPDATE'],
    business_event_effects: ['INSERT', 'SELECT', 'UPDATE'],
    business_event_evidence: ['INSERT', 'SELECT'],
    business_events: ['INSERT', 'SELECT'],
    collaboration_message_evidence: ['INSERT', 'SELECT'],
    collaboration_message_recipients: ['INSERT', 'SELECT'],
    collaboration_messages: ['INSERT', 'SELECT'],
    collaboration_participants: ['INSERT', 'SELECT'],
    collaborations: ['INSERT', 'SELECT', 'UPDATE'],
    correction_case_evidence: ['INSERT', 'SELECT'],
    correction_cases: ['INSERT', 'SELECT', 'UPDATE'],
    correction_feedback: ['INSERT', 'SELECT'],
    correction_feedback_evidence: ['INSERT', 'SELECT'],
    deliverable_evidence: ['SELECT'],
    deliverables: ['SELECT'],
    employments: ['SELECT'],
    evidence: ['SELECT'],
    objectives: ['SELECT'],
    org_units: ['SELECT'],
    process_commands: ['INSERT', 'SELECT'],
    process_definitions: ['SELECT'],
    process_edges: ['SELECT'],
    process_instances: ['INSERT', 'SELECT', 'UPDATE'],
    process_nodes: ['SELECT'],
    process_step_commands: ['INSERT', 'SELECT'],
    process_step_instances: ['INSERT', 'SELECT', 'UPDATE'],
    process_versions: ['SELECT'],
    role_assignments: ['SELECT'],
    tasks: ['SELECT'],
  } as const;

  const processColumnAclBaseline = {
    audit_events: {
      INSERT: [
        'action',
        'actor_id',
        'actor_type',
        'metadata',
        'occurred_at',
        'resource_id',
        'resource_type',
        'tenant_id',
      ],
    },
    outbox_events: {
      INSERT: ['aggregate_id', 'aggregate_type', 'event_type', 'payload', 'tenant_id'],
    },
    objective_role_assignments: {
      SELECT: ['objective_id', 'objective_version', 'role_assignment_id', 'tenant_id'],
    },
    tasks: {
      UPDATE: ['process_instance_id'],
    },
    users: {
      SELECT: ['display_name', 'id', 'role', 'status', 'tenant_id'],
    },
  } as const;

  const lifecycleColumnAclBaseline = {
    agent_instances: {
      SELECT: ['id', 'status', 'tenant_id', 'version_id'],
      UPDATE: ['status', 'updated_at'],
    },
    agent_runs: {
      SELECT: [
        'agent_id',
        'cancellation_requested_at',
        'external_run_id',
        'id',
        'requester_user_id',
        'status',
        'tenant_id',
      ],
      UPDATE: [
        'cancellation_reason',
        'cancellation_requested_at',
        'error_code',
        'error_message',
        'finished_at',
        'reserved_tokens',
        'status',
        'updated_at',
        'version',
      ],
    },
    agent_templates: {
      SELECT: ['id', 'mission', 'tenant_id'],
    },
    agent_versions: {
      SELECT: [
        'approved_by_id',
        'blueprint_revision',
        'created_by_id',
        'id',
        'review_requested_by_id',
        'review_status',
        'reviewed_by_id',
        'role_definition_snapshot',
        'status',
        'template_id',
        'tenant_id',
      ],
    },
    audit_events: {
      INSERT: [
        'action',
        'actor_id',
        'actor_type',
        'id',
        'metadata',
        'occurred_at',
        'resource_id',
        'resource_type',
        'tenant_id',
      ],
    },
    employments: {
      SELECT: ['id', 'status', 'tenant_id', 'user_id'],
    },
    outbox_events: {
      INSERT: ['aggregate_id', 'aggregate_type', 'event_type', 'payload', 'tenant_id'],
    },
    role_assignments: {
      SELECT: [
        'agent_instance_id',
        'created_by_id',
        'delegated_from_assignment_id',
        'effective_from',
        'effective_to',
        'employment_id',
        'id',
        'memory_policy',
        'organization_scope',
        'permission_scope',
        'role_template_id',
        'role_version_id',
        'source',
        'status',
        'tenant_id',
        'updated_at',
        'user_id',
        'version',
      ],
      UPDATE: ['revoke_reason', 'revoked_at', 'revoked_by_id', 'status', 'updated_at', 'version'],
    },
    tenants: {
      SELECT: ['id', 'status'],
    },
    users: {
      SELECT: ['id', 'status', 'tenant_id'],
    },
  } as const;

  const knowledgeIdentityForeignKeys = {
    knowledge_documents_current_version_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'id', 'current_version_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'id'],
    },
    knowledge_document_versions_document_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_chunks_document_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_chunks_document_version_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'id'],
    },
    knowledge_chunk_embeddings_chunk_fkey: {
      local: ['tenant_id', 'chunk_id'],
      referenced: ['tenant_id', 'id'],
    },
    knowledge_entity_mentions_entity_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'entity_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_entity_mentions_document_version_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'id'],
    },
    knowledge_entity_mentions_chunk_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id', 'chunk_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id', 'id'],
    },
    knowledge_relations_subject_entity_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'subject_entity_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_relations_object_entity_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'object_entity_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_relation_evidence_relation_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'relation_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'id'],
    },
    knowledge_relation_evidence_document_version_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'id'],
    },
    knowledge_relation_evidence_chunk_fkey: {
      local: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id', 'chunk_id'],
      referenced: ['tenant_id', 'knowledge_base_id', 'document_id', 'document_version_id', 'id'],
    },
    role_assignments_tenant_id_employment_id_fkey: {
      local: ['tenant_id', 'employment_id', 'user_id'],
      referenced: ['tenant_id', 'id', 'user_id'],
    },
    role_assignments_tenant_role_version_id_fkey: {
      local: ['tenant_id', 'role_template_id', 'role_version_id'],
      referenced: ['tenant_id', 'template_id', 'id'],
    },
    role_assignments_tenant_agent_instance_version_id_fkey: {
      local: ['tenant_id', 'agent_instance_id', 'role_version_id'],
      referenced: ['tenant_id', 'id', 'version_id'],
    },
  } as const;

  afterAll(async () => prisma.$disconnect());

  it('default-denies rows when app.tenant_id is absent', async () => {
    const count = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      return transaction.user.count();
    });
    expect(count).toBe(0);
  });

  it('does not expose rows for a different tenant context', async () => {
    const count = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
      return transaction.user.count();
    });
    expect(count).toBe(0);
  });

  it('exposes only rows for the selected tenant context', async () => {
    const expectedUserCount = await prisma.user.count({ where: { tenantId } });
    const result = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return {
        tenants: await transaction.tenant.count(),
        users: await transaction.user.count(),
      };
    });
    expect(result).toEqual({ tenants: 1, users: expectedUserCount });
  });

  it('keeps every tenant policy restrictive and forced at the table boundary', async () => {
    const baseline = await prisma.$queryRaw<
      Array<{
        tableName: string;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        permissive: boolean;
        command: string;
        roles: string[];
        usingExpression: string;
        checkExpression: string;
      }>
    >`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity",
        policy.polpermissive AS permissive,
        policy.polcmd::text AS command,
        ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        )::text[] AS roles,
        pg_get_expr(policy.polqual, policy.polrelid) AS "usingExpression",
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS "checkExpression"
      FROM pg_policy AS policy
      JOIN pg_class AS relation ON relation.oid = policy.polrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND policy.polname = 'tenant_isolation'
      ORDER BY relation.relname
    `;

    expect(baseline).toEqual(
      tenantRlsBaseline.map(({ tableName, tenantColumn, roles }) => {
        const expression = `(${tenantColumn} = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`;
        return {
          tableName,
          rowSecurity: true,
          forceRowSecurity: true,
          permissive: false,
          command: '*',
          roles: [...roles],
          usingExpression: expression,
          checkExpression: expression,
        };
      }),
    );

    const tenantColumnTables = await prisma.$queryRaw<Array<{ tableName: string }>>`
      SELECT DISTINCT relation.relname AS "tableName"
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND attribute.attname = 'tenant_id'
        AND relation.relname NOT IN (
          'tool_definitions',
          'tool_versions',
          'tool_invocations',
          'tool_invocation_commands',
          'tool_execution_receipts',
          'tool_dns_resolution_proofs',
          'ai_evaluation_annotation_evidence',
          'ai_evaluation_annotations',
          'ai_evaluation_bad_case_evidence',
          'ai_evaluation_bad_cases',
          'ai_evaluation_answer_feedback_sources',
          'ai_evaluation_case_evidence',
          'ai_evaluation_case_result_evidence',
          'ai_evaluation_case_results',
          'ai_evaluation_cases',
          'ai_evaluation_dataset_versions',
          'ai_evaluation_datasets',
          'ai_evaluation_metric_result_evidence',
          'ai_evaluation_metric_results',
          'ai_evaluation_release_checks',
          'ai_evaluation_review_evidence',
          'ai_evaluation_runner_attestations',
          'ai_evaluation_runners',
          'ai_evaluation_runs',
          'ai_evaluation_thresholds',
          'ai_evaluation_verification_evidence'
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname
    `;
    expect(tenantColumnTables.map(({ tableName }) => tableName)).toEqual(
      [
        ...tenantRlsBaseline
          .filter(({ tenantColumn }) => tenantColumn === 'tenant_id')
          .map(({ tableName }) => tableName),
        ...specializedTenantPolicyTables,
      ].sort(),
    );
  });

  it('exposes immutable model-connectivity probe provenance as read-only and registers it only through the app capability', async () => {
    const tableAcl = await prisma.$queryRaw<Array<{ grantee: string; privileges: string[] }>>`
      SELECT
        COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
        array_agg(table_acl.privilege_type::text ORDER BY table_acl.privilege_type::text)
          AS privileges
      FROM pg_class target_table
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
      ) table_acl
      LEFT JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = 'ai_model_connectivity_probes'
        AND table_acl.grantee <> target_table.relowner
      GROUP BY COALESCE(grantee_role.rolname, 'PUBLIC')
      ORDER BY grantee
    `;
    expect(tableAcl).toEqual([
      { grantee: 'enterprise_agent_admin', privileges: ['SELECT'] },
      { grantee: 'enterprise_agent_app', privileges: ['SELECT'] },
    ]);

    const functionAcl = await prisma.$queryRaw<Array<{ grantee: string; privileges: string[] }>>`
      SELECT
        COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
        array_agg(function_acl.privilege_type::text ORDER BY function_acl.privilege_type::text)
          AS privileges
      FROM pg_proc target_function
      CROSS JOIN LATERAL aclexplode(
        COALESCE(target_function.proacl, acldefault('f', target_function.proowner))
      ) function_acl
      LEFT JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
      WHERE target_function.oid =
        'public.register_ai_model_connectivity_probe(uuid,uuid,uuid,uuid)'::regprocedure
        AND function_acl.grantee <> target_function.proowner
      GROUP BY COALESCE(grantee_role.rolname, 'PUBLIC')
      ORDER BY grantee
    `;
    expect(functionAcl).toEqual([{ grantee: 'enterprise_agent_app', privileges: ['EXECUTE'] }]);

    const appendOnlyTriggers = await prisma.$queryRaw<
      Array<{ triggerName: string; enabled: string; definition: string }>
    >`
      SELECT
        trigger.tgname AS "triggerName",
        trigger.tgenabled::text AS enabled,
        pg_get_triggerdef(trigger.oid, true) AS definition
      FROM pg_trigger trigger
      WHERE trigger.tgrelid = 'public.ai_model_connectivity_probes'::regclass
        AND NOT trigger.tgisinternal
      ORDER BY trigger.tgname
    `;
    expect(appendOnlyTriggers).toEqual([
      {
        triggerName: 'ai_model_connectivity_probes_append_only',
        enabled: 'O',
        definition: expect.stringMatching(/BEFORE (?:DELETE OR UPDATE|UPDATE OR DELETE)/),
      },
      {
        triggerName: 'ai_model_connectivity_probes_reject_truncate',
        enabled: 'O',
        definition: expect.stringMatching(/BEFORE TRUNCATE/),
      },
    ]);

    const directInsert = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."ai_model_connectivity_probes" (
            "tenant_id",
            "run_id",
            "target_catalog_version_id",
            "requester_user_id",
            "conversation_id"
          ) VALUES (
            ${tenantId}::uuid,
            '00000000-0000-7000-8000-000000000731'::uuid,
            '00000000-0000-7000-8000-000000000732'::uuid,
            '00000000-0000-7000-8000-000000000733'::uuid,
            '00000000-0000-7000-8000-000000000734'::uuid
          )
        `;
      }),
    );
    const directUpdate = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          UPDATE public."ai_model_connectivity_probes"
          SET "created_at" = "created_at"
          WHERE "tenant_id" = ${tenantId}::uuid
        `;
      }),
    );
    const directDelete = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          DELETE FROM public."ai_model_connectivity_probes"
          WHERE "tenant_id" = ${tenantId}::uuid
        `;
      }),
    );
    expect([directInsert, directUpdate, directDelete]).toEqual([
      expect.objectContaining({ prismaCode: 'P2010', sqlState: '42501' }),
      expect.objectContaining({ prismaCode: 'P2010', sqlState: '42501' }),
      expect.objectContaining({ prismaCode: 'P2010', sqlState: '42501' }),
    ]);
  });

  it('keeps Agent Run execution identity immutable after insertion', async () => {
    const fixture = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      templateId: randomUUID(),
      versionId: randomUUID(),
      agentId: randomUUID(),
      conversationId: randomUUID(),
      participantId: randomUUID(),
      messageId: randomUUID(),
      runId: randomUUID(),
    };
    const suffix = fixture.runId.slice(0, 8);
    const idempotencyKey = `execution-identity-test:${fixture.runId}`;
    const policySnapshot = { integrationTest: 'agent-run-execution-identity' };

    await prisma.$transaction(async (transaction) => {
      await transaction.tenant.create({
        data: {
          id: fixture.tenantId,
          slug: `agent-run-identity-${suffix}`,
          name: 'Agent Run execution identity fixture',
        },
      });
      await transaction.user.create({
        data: {
          id: fixture.userId,
          tenantId: fixture.tenantId,
          email: `agent-run-identity-${suffix}@rls.test`,
          emailNormalized: `agent-run-identity-${suffix}@rls.test`,
          displayName: 'Agent Run identity user',
        },
      });
      await transaction.agentTemplate.create({
        data: {
          id: fixture.templateId,
          tenantId: fixture.tenantId,
          key: `agent-run-identity-${suffix}`,
          name: 'Agent Run identity template',
        },
      });
      await transaction.agentVersion.create({
        data: {
          id: fixture.versionId,
          tenantId: fixture.tenantId,
          templateId: fixture.templateId,
          version: 1,
          systemPrompt: 'Agent Run execution identity integration fixture',
          modelPolicy: {},
          toolPolicy: {},
          knowledgeScope: {},
          createdById: fixture.userId,
        },
      });
      await transaction.agentInstance.create({
        data: {
          id: fixture.agentId,
          tenantId: fixture.tenantId,
          key: `agent-run-identity-${suffix}`,
          versionId: fixture.versionId,
          createdById: fixture.userId,
          name: 'Agent Run identity agent',
        },
      });
      await transaction.conversation.create({
        data: {
          id: fixture.conversationId,
          tenantId: fixture.tenantId,
          directKey: `agent-run-identity-${suffix}`,
          createdById: fixture.userId,
        },
      });
      await transaction.conversationParticipant.create({
        data: {
          id: fixture.participantId,
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          type: 'USER',
          participantKey: `user:${fixture.userId}`,
          userId: fixture.userId,
          displayName: 'Agent Run identity user',
        },
      });
      await transaction.message.create({
        data: {
          id: fixture.messageId,
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          senderType: 'USER',
          senderUserId: fixture.userId,
          senderKey: `user:${fixture.userId}`,
          senderName: 'Agent Run identity user',
          clientMessageId: `agent-run-identity-${fixture.runId}`,
          content: { type: 'text', text: 'Agent Run execution identity test' },
        },
      });
      await transaction.agentRun.create({
        data: {
          id: fixture.runId,
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          inputMessageId: fixture.messageId,
          requesterUserId: fixture.userId,
          agentId: fixture.agentId,
          agentVersionId: fixture.versionId,
          status: 'FAILED',
          idempotencyKey,
          policySnapshot,
        },
      });
    });

    try {
      const policyMutation = await captureDatabaseError(() =>
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`;
          await transaction.$executeRaw`
            UPDATE public."agent_runs"
            SET "policy_snapshot" = "policy_snapshot" ||
              jsonb_build_object('__execution_identity_test', clock_timestamp()::text)
            WHERE "tenant_id" = ${fixture.tenantId}::uuid
              AND "id" = ${fixture.runId}::uuid
          `;
        }),
      );
      const idempotencyMutation = await captureDatabaseError(() =>
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`;
          await transaction.$executeRaw`
            UPDATE public."agent_runs"
            SET "idempotency_key" = ${`execution-identity-test:tampered:${fixture.runId}`}
            WHERE "tenant_id" = ${fixture.tenantId}::uuid
              AND "id" = ${fixture.runId}::uuid
          `;
        }),
      );

      for (const rejected of [policyMutation, idempotencyMutation]) {
        expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23514' });
        expect(rejected.databaseMessage).toContain('Agent Run execution identity is immutable');
      }
      await expect(
        prisma.agentRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { idempotencyKey: true, policySnapshot: true },
        }),
      ).resolves.toEqual({ idempotencyKey, policySnapshot });
    } finally {
      await prisma.$transaction(async (transaction) => {
        await transaction.agentRun.deleteMany({ where: { id: fixture.runId } });
        await transaction.message.deleteMany({ where: { id: fixture.messageId } });
        await transaction.conversationParticipant.deleteMany({
          where: { id: fixture.participantId },
        });
        await transaction.conversation.deleteMany({ where: { id: fixture.conversationId } });
        await transaction.agentInstance.deleteMany({ where: { id: fixture.agentId } });
        await transaction.agentVersion.deleteMany({ where: { id: fixture.versionId } });
        await transaction.agentTemplate.deleteMany({ where: { id: fixture.templateId } });
        await transaction.user.deleteMany({ where: { id: fixture.userId } });
        await transaction.tenant.deleteMany({ where: { id: fixture.tenantId } });
      });
    }
  });

  it('keeps the six Tool Gateway tables behind the dedicated restrictive tenant boundary', async () => {
    const tables = [
      'tool_definitions',
      'tool_versions',
      'tool_invocations',
      'tool_invocation_commands',
      'tool_execution_receipts',
      'tool_dns_resolution_proofs',
    ];
    const rows = await prisma.$queryRaw<
      Array<{
        tableName: string;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        policyName: string;
        permissive: string;
        command: string;
        roles: string[];
      }>
    >`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity",
        policy.policyname AS "policyName",
        policy.permissive,
        policy.cmd AS command,
        policy.roles::text[] AS roles
      FROM pg_policies policy
      JOIN pg_class relation ON relation.relname = policy.tablename
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND policy.schemaname = 'public'
        AND policy.tablename IN (
          'tool_definitions',
          'tool_versions',
          'tool_invocations',
          'tool_invocation_commands',
          'tool_execution_receipts',
          'tool_dns_resolution_proofs'
        )
        AND policy.policyname = 'tool_tenant_isolation'
      ORDER BY relation.relname
    `;
    expect(rows.map((row) => row.tableName)).toEqual([...tables].sort());
    expect(
      rows.every(
        (row) =>
          row.rowSecurity &&
          row.forceRowSecurity &&
          row.policyName === 'tool_tenant_isolation' &&
          row.permissive === 'RESTRICTIVE' &&
          row.command === 'ALL' &&
          row.roles.includes('enterprise_agent_tool_gateway'),
      ),
    ).toBe(true);

    const [role] = await prisma.$queryRaw<
      Array<{
        canLogin: boolean;
        superuser: boolean;
        bypassRls: boolean;
        inherit: boolean;
      }>
    >`
      SELECT rolcanlogin AS "canLogin", rolsuper AS superuser,
             rolbypassrls AS "bypassRls", rolinherit AS inherit
      FROM pg_roles
      WHERE rolname = 'enterprise_agent_tool_gateway'
    `;
    expect(role).toEqual({
      canLogin: false,
      superuser: false,
      bypassRls: false,
      inherit: false,
    });
  });

  it('forces tenant isolation and an exact least-privilege ACL for AI evaluation runners', async () => {
    const tenantPolicies = await prisma.$queryRaw<
      Array<{
        tableName: string;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        permissive: boolean;
        command: string;
        roles: string[];
        usingExpression: string;
        checkExpression: string;
      }>
    >(Prisma.sql`
      SELECT
        relation.relname AS "tableName",
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity",
        policy.polpermissive AS permissive,
        policy.polcmd::text AS command,
        ARRAY(
          SELECT role_definition.rolname::text
          FROM unnest(policy.polroles) assigned_role(role_oid)
          JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY role_definition.rolname
        )::text[] AS roles,
        pg_get_expr(policy.polqual, policy.polrelid) AS "usingExpression",
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS "checkExpression"
      FROM pg_policy AS policy
      JOIN pg_class AS relation ON relation.oid = policy.polrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname IN (${Prisma.join(aiEvaluationTables)})
        AND policy.polname = 'ai_evaluation_tenant_isolation'
      ORDER BY relation.relname
    `);
    const tenantExpression =
      "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";
    expect(tenantPolicies).toEqual(
      aiEvaluationTables.map((tableName) => ({
        tableName,
        rowSecurity: true,
        forceRowSecurity: true,
        permissive: false,
        command: '*',
        roles:
          tableName === 'ai_evaluation_runner_attestations'
            ? ['enterprise_agent_admin', 'enterprise_agent_evaluation_runner']
            : tableName === 'ai_evaluation_answer_feedback_sources'
              ? [
                  'enterprise_agent_admin',
                  'enterprise_agent_app',
                  'enterprise_agent_evaluation_runner',
                  'enterprise_agent_feedback_projector',
                ]
              : [
                  'enterprise_agent_admin',
                  'enterprise_agent_app',
                  'enterprise_agent_evaluation_runner',
                ],
        usingExpression: tenantExpression,
        checkExpression: tenantExpression,
      })),
    );

    const [roleBoundary] = await prisma.$queryRaw<
      Array<{
        canLogin: boolean;
        bypassesRls: boolean;
        isSuperuser: boolean;
        canCreateDatabase: boolean;
        canCreateRole: boolean;
        inheritsPrivileges: boolean;
        canReplicate: boolean;
      }>
    >`
      SELECT
        rolcanlogin AS "canLogin",
        rolbypassrls AS "bypassesRls",
        rolsuper AS "isSuperuser",
        rolcreatedb AS "canCreateDatabase",
        rolcreaterole AS "canCreateRole",
        rolinherit AS "inheritsPrivileges",
        rolreplication AS "canReplicate"
      FROM pg_roles
      WHERE rolname = 'enterprise_agent_evaluation_runner'
    `;
    expect(roleBoundary).toEqual({
      canLogin: false,
      bypassesRls: false,
      isSuperuser: false,
      canCreateDatabase: false,
      canCreateRole: false,
      inheritsPrivileges: false,
      canReplicate: false,
    });

    const tablePrivileges = await prisma.$queryRaw<
      Array<{ tableName: string; privileges: string[] }>
    >`
      SELECT
        table_name AS "tableName",
        array_agg(privilege_type ORDER BY privilege_type)::text[] AS privileges
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee = 'enterprise_agent_evaluation_runner'
      GROUP BY table_name
      ORDER BY table_name
    `;
    expect(tablePrivileges).toEqual([
      { tableName: 'ai_evaluation_case_result_evidence', privileges: ['INSERT', 'SELECT'] },
      { tableName: 'ai_evaluation_case_results', privileges: ['INSERT', 'SELECT'] },
      { tableName: 'ai_evaluation_cases', privileges: ['SELECT'] },
      { tableName: 'ai_evaluation_dataset_versions', privileges: ['SELECT'] },
      { tableName: 'ai_evaluation_metric_result_evidence', privileges: ['INSERT', 'SELECT'] },
      { tableName: 'ai_evaluation_metric_results', privileges: ['INSERT', 'SELECT'] },
      { tableName: 'ai_evaluation_runner_attestations', privileges: ['SELECT'] },
      { tableName: 'ai_evaluation_runners', privileges: ['SELECT'] },
      { tableName: 'ai_evaluation_runs', privileges: ['SELECT', 'UPDATE'] },
      { tableName: 'ai_evaluation_thresholds', privileges: ['SELECT'] },
      { tableName: 'audit_events', privileges: ['INSERT'] },
      { tableName: 'outbox_events', privileges: ['INSERT'] },
    ]);

    const roleCapabilities = await prisma.$queryRaw<
      Array<{
        tableName: string;
        adminCanReadAppend: boolean;
        adminCanUpdate: boolean;
        adminCanDelete: boolean;
        appHasAnyPrivilege: boolean;
      }>
    >(Prisma.sql`
      SELECT
        table_name AS "tableName",
        (
          has_table_privilege(
            'enterprise_agent_admin',
            format('public.%I', table_name),
            'SELECT'
          )
          AND has_table_privilege(
            'enterprise_agent_admin',
            format('public.%I', table_name),
            'INSERT'
          )
        ) AS "adminCanReadAppend",
        has_table_privilege(
          'enterprise_agent_admin',
          format('public.%I', table_name),
          'UPDATE'
        ) AS "adminCanUpdate",
        has_table_privilege(
          'enterprise_agent_admin',
          format('public.%I', table_name),
          'DELETE'
        ) AS "adminCanDelete",
        (
          has_table_privilege(
            'enterprise_agent_app',
            format('public.%I', table_name),
            'SELECT'
          )
          OR has_table_privilege(
            'enterprise_agent_app',
            format('public.%I', table_name),
            'INSERT'
          )
          OR has_table_privilege(
            'enterprise_agent_app',
            format('public.%I', table_name),
            'UPDATE'
          )
          OR has_table_privilege(
            'enterprise_agent_app',
            format('public.%I', table_name),
            'DELETE'
          )
        ) AS "appHasAnyPrivilege"
      FROM unnest(ARRAY[${Prisma.join(aiEvaluationTables)}]::text[]) AS protected(table_name)
      ORDER BY table_name
    `);
    expect(roleCapabilities).toEqual(
      aiEvaluationTables.map((tableName) => ({
        tableName,
        adminCanReadAppend: tableName !== 'ai_evaluation_answer_feedback_sources',
        adminCanUpdate: ![
          'ai_evaluation_answer_feedback_sources',
          'ai_evaluation_runner_attestations',
        ].includes(tableName),
        adminCanDelete: false,
        appHasAnyPrivilege: false,
      })),
    );

    const runnerPolicies = await prisma.$queryRaw<
      Array<{ policyName: string; tableName: string; command: string; roles: string[] }>
    >(Prisma.sql`
      SELECT
        policyname AS "policyName",
        tablename AS "tableName",
        cmd AS command,
        roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN (${Prisma.join(aiEvaluationTables)})
        AND roles = ARRAY['enterprise_agent_evaluation_runner']::name[]
        AND policyname <> 'ai_evaluation_tenant_isolation'
      ORDER BY policyname
    `);
    expect(runnerPolicies).toEqual([
      {
        policyName: 'ai_evaluation_runner_attestation_read',
        tableName: 'ai_evaluation_runner_attestations',
        command: 'SELECT',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_case_read',
        tableName: 'ai_evaluation_cases',
        command: 'SELECT',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_case_result_access',
        tableName: 'ai_evaluation_case_results',
        command: 'ALL',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_case_result_evidence_access',
        tableName: 'ai_evaluation_case_result_evidence',
        command: 'ALL',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_dataset_read',
        tableName: 'ai_evaluation_dataset_versions',
        command: 'SELECT',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_metric_evidence_access',
        tableName: 'ai_evaluation_metric_result_evidence',
        command: 'ALL',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_metric_result_access',
        tableName: 'ai_evaluation_metric_results',
        command: 'ALL',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_registry_read',
        tableName: 'ai_evaluation_runners',
        command: 'SELECT',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_run_access',
        tableName: 'ai_evaluation_runs',
        command: 'ALL',
        roles: ['enterprise_agent_evaluation_runner'],
      },
      {
        policyName: 'ai_evaluation_runner_threshold_read',
        tableName: 'ai_evaluation_thresholds',
        command: 'SELECT',
        roles: ['enterprise_agent_evaluation_runner'],
      },
    ]);
  });

  it('limits the cross-tenant knowledge worker to queue identifiers and transitions', async () => {
    const policies = await prisma.$queryRaw<
      Array<{
        policyName: string;
        permissive: string;
        command: string;
        roles: string[];
      }>
    >`
      SELECT
        policyname AS "policyName",
        permissive,
        cmd AS command,
        roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'knowledge_ingestion_jobs'
        AND policyname IN ('tenant_isolation', 'enterprise_agent_outbox_access')
      ORDER BY policyname
    `;
    expect(policies).toEqual([
      {
        policyName: 'enterprise_agent_outbox_access',
        permissive: 'PERMISSIVE',
        command: 'ALL',
        roles: ['enterprise_agent_outbox'],
      },
      {
        policyName: 'tenant_isolation',
        permissive: 'RESTRICTIVE',
        command: 'ALL',
        roles: ['enterprise_agent_admin', 'enterprise_agent_app'],
      },
    ]);

    const columnPrivileges = await prisma.$queryRaw<
      Array<{ columnName: string; privilegeType: string }>
    >`
      SELECT
        column_name AS "columnName",
        privilege_type AS "privilegeType"
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = 'knowledge_ingestion_jobs'
        AND grantee = 'enterprise_agent_outbox'
      ORDER BY privilege_type, column_name
    `;
    expect(columnPrivileges).toEqual([
      ...[
        'attempts',
        'available_at',
        'claimed_by',
        'created_at',
        'document_version_id',
        'id',
        'lease_expires_at',
        'started_at',
        'status',
        'tenant_id',
      ].map((columnName) => ({ columnName, privilegeType: 'SELECT' })),
      ...[
        'attempts',
        'available_at',
        'claimed_by',
        'error_code',
        'error_message',
        'finished_at',
        'lease_expires_at',
        'progress',
        'stage',
        'started_at',
        'status',
        'updated_at',
      ].map((columnName) => ({ columnName, privilegeType: 'UPDATE' })),
    ]);

    const [boundary] = await prisma.$queryRaw<
      Array<{
        canInsert: boolean;
        canDelete: boolean;
        canReadVersions: boolean;
        canReadChunks: boolean;
        canReadQueueContent: boolean;
      }>
    >`
      SELECT
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_ingestion_jobs',
          'INSERT'
        ) AS "canInsert",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_ingestion_jobs',
          'DELETE'
        ) AS "canDelete",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_document_versions',
          'SELECT'
        ) AS "canReadVersions",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_chunks',
          'SELECT'
        ) AS "canReadChunks",
        has_column_privilege(
          'enterprise_agent_outbox',
          'public.knowledge_ingestion_jobs',
          'error_message',
          'SELECT'
        ) AS "canReadQueueContent"
    `;
    expect(boundary).toEqual({
      canInsert: false,
      canDelete: false,
      canReadVersions: false,
      canReadChunks: false,
      canReadQueueContent: false,
    });
  });

  it('keeps pre-auth login throttle buckets opaque and exclusive to the auth role', async () => {
    const [boundary] = await prisma.$queryRaw<
      Array<{
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        authPolicyCount: number;
        authCanSelect: boolean;
        authCanWrite: boolean;
        appCanSelect: boolean;
        adminCanSelect: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity",
        (
          SELECT count(*)::int
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'auth_login_rate_limits'
            AND policyname = 'enterprise_agent_auth_access'
            AND roles = ARRAY['enterprise_agent_auth']::name[]
        ) AS "authPolicyCount",
        has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'SELECT') AS "authCanSelect",
        (
          has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'INSERT')
          AND has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'UPDATE')
          AND has_table_privilege('enterprise_agent_auth', 'public.auth_login_rate_limits', 'DELETE')
        ) AS "authCanWrite",
        has_table_privilege('enterprise_agent_app', 'public.auth_login_rate_limits', 'SELECT') AS "appCanSelect",
        has_table_privilege('enterprise_agent_admin', 'public.auth_login_rate_limits', 'SELECT') AS "adminCanSelect"
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'auth_login_rate_limits'
    `;

    expect(boundary).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      authPolicyCount: 1,
      authCanSelect: true,
      authCanWrite: true,
      appCanSelect: false,
      adminCanSelect: false,
    });
  });

  it('forces tenant isolation for admin invitation access while keeping opaque lookup in the auth role', async () => {
    const tokenId = '00000000-0000-7000-8000-0000000008a1';
    const tokenHash = 'a'.repeat(64);
    await prisma.authActionToken.create({
      data: {
        id: tokenId,
        tenantId,
        userId: '00000000-0000-7000-8000-000000000101',
        purpose: 'PASSWORD_RESET',
        tokenHash,
        deliveryTargetEmail: 'owner@example.test',
        deliveryTargetEvidence: 'ISSUED',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    try {
      const [boundary] = await prisma.$queryRaw<
        Array<{
          rowSecurity: boolean;
          forceRowSecurity: boolean;
          authCanWrite: boolean;
          adminCanWrite: boolean;
          appCanSelect: boolean;
        }>
      >`
        SELECT
          relation.relrowsecurity AS "rowSecurity",
          relation.relforcerowsecurity AS "forceRowSecurity",
          (
            has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'SELECT')
            AND has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'INSERT')
            AND has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'UPDATE')
            AND has_table_privilege('enterprise_agent_auth', 'public.auth_action_tokens', 'DELETE')
          ) AS "authCanWrite",
          (
            has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'SELECT')
            AND has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'INSERT')
            AND has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'UPDATE')
            AND has_table_privilege('enterprise_agent_admin', 'public.auth_action_tokens', 'DELETE')
          ) AS "adminCanWrite",
          has_table_privilege('enterprise_agent_app', 'public.auth_action_tokens', 'SELECT') AS "appCanSelect"
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'auth_action_tokens'
      `;
      expect(boundary).toEqual({
        rowSecurity: true,
        forceRowSecurity: true,
        authCanWrite: true,
        adminCanWrite: true,
        appCanSelect: false,
      });
      const [deliveryBoundary] = await prisma.$queryRaw<
        Array<{
          rowSecurity: boolean;
          forceRowSecurity: boolean;
          authCanWrite: boolean;
          adminCanWrite: boolean;
          appCanSelect: boolean;
        }>
      >`
        SELECT
          relation.relrowsecurity AS "rowSecurity",
          relation.relforcerowsecurity AS "forceRowSecurity",
          (
            has_table_privilege(
              'enterprise_agent_auth',
              'public.auth_recovery_deliveries',
              'SELECT,INSERT,UPDATE,DELETE'
            )
          ) AS "authCanWrite",
          (
            has_table_privilege(
              'enterprise_agent_admin',
              'public.auth_recovery_deliveries',
              'SELECT,INSERT,UPDATE,DELETE'
            )
          ) AS "adminCanWrite",
          has_table_privilege(
            'enterprise_agent_app',
            'public.auth_recovery_deliveries',
            'SELECT'
          ) AS "appCanSelect"
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'auth_recovery_deliveries'
      `;
      expect(deliveryBoundary).toEqual({
        rowSecurity: true,
        forceRowSecurity: true,
        authCanWrite: true,
        adminCanWrite: true,
        appCanSelect: false,
      });

      const withoutContext = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        return transaction.authActionToken.count();
      });
      const wrongTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return transaction.authActionToken.count();
      });
      const ownTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return transaction.authActionToken.count({ where: { id: tokenId } });
      });
      expect({ withoutContext, wrongTenant, ownTenant }).toEqual({
        withoutContext: 0,
        wrongTenant: 0,
        ownTenant: 1,
      });
    } finally {
      await prisma.authActionToken.deleteMany({ where: { id: tokenId } });
    }
  });

  it('tenant-isolates Feishu integration state for the admin database role', async () => {
    const organization = await prisma.organization.findFirstOrThrow({
      where: { tenantId },
      select: { id: true },
    });
    const integrationId = '00000000-0000-7000-8000-0000000008f1';
    await prisma.directoryIntegration.upsert({
      where: { tenantId_provider: { tenantId, provider: 'FEISHU' } },
      create: {
        id: integrationId,
        tenantId,
        organizationId: organization.id,
        provider: 'FEISHU',
      },
      update: {},
    });
    try {
      const withoutContext = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        return transaction.directoryIntegration.count();
      });
      const wrongTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return transaction.directoryIntegration.count();
      });
      const ownTenant = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return transaction.directoryIntegration.count();
      });
      expect({ withoutContext, wrongTenant, ownTenant }).toEqual({
        withoutContext: 0,
        wrongTenant: 0,
        ownTenant: 1,
      });
    } finally {
      await prisma.directoryIntegration.deleteMany({ where: { id: integrationId, tenantId } });
    }
  });

  it('denies the API role migration metadata and catalog writes', async () => {
    const migrationMetadata = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations');
      }),
    );
    const catalogWrite = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ${tenantId}::uuid
        `;
      }),
    );

    expect(migrationMetadata).toMatchObject({ prismaCode: 'P2010', sqlState: '42501' });
    expect(catalogWrite).toMatchObject({ prismaCode: 'P2010', sqlState: '42501' });
  });

  it('limits the provisioner to tenant catalog data', async () => {
    const visibleTenantCount = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_provisioner');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return transaction.tenant.count();
    });
    const conversationRead = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_provisioner');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$queryRawUnsafe('SELECT count(*) FROM conversations');
      }),
    );

    expect(visibleTenantCount).toBe(1);
    expect(conversationRead).toMatchObject({ prismaCode: 'P2010', sqlState: '42501' });
  });

  it('rejects a message whose sender is not an active participant', async () => {
    const rejectedMessage = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO conversations (
            id, tenant_id, direct_key, created_by_id, updated_at
          ) VALUES (
            '00000000-0000-7000-8000-000000000899'::uuid,
            ${tenantId}::uuid,
            'inactive-sender-negative-test',
            '00000000-0000-7000-8000-000000000101'::uuid,
            CURRENT_TIMESTAMP
          )
        `;
        await transaction.$executeRaw`
          INSERT INTO conversation_participants (
            id, tenant_id, conversation_id, type, participant_key, user_id, display_name
          ) VALUES (
            '00000000-0000-7000-8000-000000000898'::uuid,
            ${tenantId}::uuid,
            '00000000-0000-7000-8000-000000000899'::uuid,
            'USER',
            'user:00000000-0000-7000-8000-000000000101',
            '00000000-0000-7000-8000-000000000101'::uuid,
            'Active participant'
          )
        `;
        await transaction.$executeRaw`
          INSERT INTO messages (
            id,
            tenant_id,
            conversation_id,
            sender_type,
            sender_user_id,
            sender_key,
            sender_name,
            client_message_id,
            content
          ) VALUES (
            '00000000-0000-7000-8000-000000000897'::uuid,
            ${tenantId}::uuid,
            '00000000-0000-7000-8000-000000000899'::uuid,
            'USER',
            '00000000-0000-7000-8000-000000000102'::uuid,
            'user:00000000-0000-7000-8000-000000000102',
            'Not a participant',
            'inactive-sender-negative-test',
            '{"type":"text","text":"must be rejected"}'::jsonb
          )
        `;
      }),
    );

    expect(rejectedMessage).toMatchObject({
      prismaCode: 'P2010',
      sqlState: '23514',
    });
    expect(rejectedMessage.databaseMessage).toContain(
      'message sender is not an active conversation participant',
    );
  });

  it('uses tenant_id in every business foreign key, including message senders', async () => {
    const constraints = await prisma.$queryRaw<
      Array<{ constraintName: string; definition: string }>
    >(Prisma.sql`
      SELECT
        constraint_name.conname AS "constraintName",
        pg_get_constraintdef(constraint_name.oid) AS definition
      FROM pg_constraint AS constraint_name
      WHERE constraint_name.contype = 'f'
        AND constraint_name.conname IN (${Prisma.join(tenantScopedForeignKeys)})
      ORDER BY constraint_name.conname
    `);

    expect(constraints.map(({ constraintName }) => constraintName)).toEqual(
      [...tenantScopedForeignKeys].sort(),
    );
    for (const { constraintName, definition } of constraints) {
      const normalized = definition.replaceAll('"', '');
      const columns = normalized.match(
        /^FOREIGN KEY\s+\(([^)]+)\)\s+REFERENCES\s+[^(]+\(([^)]+)\)/,
      );
      expect(columns).not.toBeNull();

      const localColumns = columns?.[1]?.split(', ').map((column) => column.trim()) ?? [];
      const referencedColumns = columns?.[2]?.split(', ').map((column) => column.trim()) ?? [];
      expect(localColumns[0]).toBe('tenant_id');
      expect(referencedColumns[0]).toBe(
        tenantRootForeignKeys.has(constraintName) ? 'id' : 'tenant_id',
      );
      expect(localColumns).toHaveLength(referencedColumns.length);
    }
  });

  it('keeps durable AI Runtime state exclusive to the runtime role with read-only admin access', async () => {
    const [boundary] = await prisma.$queryRaw<
      Array<{
        runtimeCanSelect: boolean;
        runtimeCanInsert: boolean;
        runtimeCanUpdate: boolean;
        runtimeCanDelete: boolean;
        adminCanSelect: boolean;
        adminCanWrite: boolean;
        appCanSelect: boolean;
        authCanSelect: boolean;
        outboxCanSelect: boolean;
        provisionerCanSelect: boolean;
        runtimeCanLogin: boolean;
        runtimeBypassesRls: boolean;
        runtimePolicyCount: number;
      }>
    >`
      SELECT
        has_table_privilege(
          'enterprise_agent_runtime',
          'public.ai_runtime_runs',
          'SELECT'
        ) AS "runtimeCanSelect",
        has_table_privilege(
          'enterprise_agent_runtime',
          'public.ai_runtime_runs',
          'INSERT'
        ) AS "runtimeCanInsert",
        has_table_privilege(
          'enterprise_agent_runtime',
          'public.ai_runtime_runs',
          'UPDATE'
        ) AS "runtimeCanUpdate",
        has_table_privilege(
          'enterprise_agent_runtime',
          'public.ai_runtime_runs',
          'DELETE'
        ) AS "runtimeCanDelete",
        has_table_privilege(
          'enterprise_agent_admin',
          'public.ai_runtime_runs',
          'SELECT'
        ) AS "adminCanSelect",
        (
          has_table_privilege('enterprise_agent_admin', 'public.ai_runtime_runs', 'INSERT')
          OR has_table_privilege('enterprise_agent_admin', 'public.ai_runtime_runs', 'UPDATE')
          OR has_table_privilege('enterprise_agent_admin', 'public.ai_runtime_runs', 'DELETE')
        ) AS "adminCanWrite",
        has_table_privilege(
          'enterprise_agent_app',
          'public.ai_runtime_runs',
          'SELECT'
        ) AS "appCanSelect",
        has_table_privilege(
          'enterprise_agent_auth',
          'public.ai_runtime_runs',
          'SELECT'
        ) AS "authCanSelect",
        has_table_privilege(
          'enterprise_agent_outbox',
          'public.ai_runtime_runs',
          'SELECT'
        ) AS "outboxCanSelect",
        has_table_privilege(
          'enterprise_agent_provisioner',
          'public.ai_runtime_runs',
          'SELECT'
        ) AS "provisionerCanSelect",
        role_definition.rolcanlogin AS "runtimeCanLogin",
        role_definition.rolbypassrls AS "runtimeBypassesRls",
        (
          SELECT count(*)::int
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'ai_runtime_runs'
            AND policyname = 'enterprise_agent_runtime_access'
            AND permissive = 'PERMISSIVE'
            AND cmd = 'ALL'
            AND roles = ARRAY['enterprise_agent_runtime']::name[]
        ) AS "runtimePolicyCount"
      FROM pg_roles AS role_definition
      WHERE role_definition.rolname = 'enterprise_agent_runtime'
    `;

    expect(boundary).toEqual({
      runtimeCanSelect: true,
      runtimeCanInsert: true,
      runtimeCanUpdate: true,
      runtimeCanDelete: false,
      adminCanSelect: true,
      adminCanWrite: false,
      appCanSelect: false,
      authCanSelect: false,
      outboxCanSelect: false,
      provisionerCanSelect: false,
      runtimeCanLogin: false,
      runtimeBypassesRls: false,
      runtimePolicyCount: 1,
    });
  });

  it('hardens the process capability role and grants only its declared runtime privileges', async () => {
    const [roleBoundary] = await prisma.$queryRaw<
      Array<{
        canLogin: boolean;
        bypassesRls: boolean;
        isSuperuser: boolean;
        canCreateDatabase: boolean;
        canCreateRole: boolean;
        inheritsPrivileges: boolean;
        canReplicate: boolean;
      }>
    >`
      SELECT
        role_definition.rolcanlogin AS "canLogin",
        role_definition.rolbypassrls AS "bypassesRls",
        role_definition.rolsuper AS "isSuperuser",
        role_definition.rolcreatedb AS "canCreateDatabase",
        role_definition.rolcreaterole AS "canCreateRole",
        role_definition.rolinherit AS "inheritsPrivileges",
        role_definition.rolreplication AS "canReplicate"
      FROM pg_roles AS role_definition
      WHERE role_definition.rolname = 'enterprise_agent_process'
    `;
    expect(roleBoundary).toEqual({
      canLogin: false,
      bypassesRls: false,
      isSuperuser: false,
      canCreateDatabase: false,
      canCreateRole: false,
      inheritsPrivileges: false,
      canReplicate: false,
    });

    const tablePrivileges = await prisma.$queryRaw<
      Array<{ tableName: string; privileges: string[] }>
    >`
      SELECT
        table_name AS "tableName",
        array_agg(privilege_type ORDER BY privilege_type)::text[] AS privileges
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee = 'enterprise_agent_process'
      GROUP BY table_name
      ORDER BY table_name
    `;
    expect(tablePrivileges).toEqual(
      Object.entries(processTableAclBaseline).map(([tableName, privileges]) => ({
        tableName,
        privileges: [...privileges],
      })),
    );

    const columnPrivileges = await prisma.$queryRaw<
      Array<{ tableName: string; columnName: string; privilegeType: string }>
    >`
      SELECT
        table_name AS "tableName",
        column_name AS "columnName",
        privilege_type AS "privilegeType"
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND grantee = 'enterprise_agent_process'
        AND (
          (table_name = 'audit_events' AND privilege_type = 'INSERT')
          OR (table_name = 'outbox_events' AND privilege_type = 'INSERT')
          OR (table_name = 'objective_role_assignments' AND privilege_type = 'SELECT')
          OR (table_name = 'tasks' AND privilege_type = 'UPDATE')
          OR (table_name = 'users' AND privilege_type = 'SELECT')
        )
      ORDER BY table_name, privilege_type, column_name
    `;
    const expectedColumnPrivileges = Object.entries(processColumnAclBaseline)
      .flatMap(([tableName, privilegesByType]) =>
        Object.entries(privilegesByType).flatMap(([privilegeType, columns]) =>
          (columns as readonly string[]).map((columnName) => ({
            tableName,
            columnName,
            privilegeType,
          })),
        ),
      )
      .sort((left, right) =>
        [left.tableName, left.privilegeType, left.columnName]
          .join(':')
          .localeCompare([right.tableName, right.privilegeType, right.columnName].join(':')),
      );
    expect(columnPrivileges).toEqual(expectedColumnPrivileges);

    const accessPolicies = await prisma.$queryRaw<
      Array<{
        tableName: string;
        permissive: string;
        command: string;
        roles: string[];
      }>
    >`
      SELECT
        tablename AS "tableName",
        permissive,
        cmd AS command,
        roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname = 'enterprise_agent_process_access'
      ORDER BY tablename
    `;
    const processOwnedTables = [
      'business_event_deliveries',
      'business_event_effects',
      'business_event_evidence',
      'business_events',
      'collaboration_message_evidence',
      'collaboration_message_recipients',
      'collaboration_messages',
      'collaboration_participants',
      'collaborations',
      'correction_case_evidence',
      'correction_cases',
      'correction_feedback',
      'correction_feedback_evidence',
      'process_commands',
      'process_edges',
      'process_instances',
      'process_step_commands',
      'process_step_instances',
    ];
    expect(accessPolicies).toEqual(
      processOwnedTables.map((tableName) => ({
        tableName,
        permissive: 'PERMISSIVE',
        command: 'ALL',
        roles: ['enterprise_agent_process'],
      })),
    );

    const referencePolicies = await prisma.$queryRaw<
      Array<{
        tableName: string;
        permissive: string;
        command: string;
        roles: string[];
        usingExpression: string;
      }>
    >`
      SELECT
        tablename AS "tableName",
        permissive,
        cmd AS command,
        roles::text[] AS roles,
        qual AS "usingExpression"
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname = 'enterprise_agent_process_read'
      ORDER BY tablename
    `;
    const processReferenceTables = [
      'acceptance_evidence',
      'acceptances',
      'agent_instances',
      'agent_templates',
      'agent_versions',
      'deliverable_evidence',
      'deliverables',
      'employments',
      'evidence',
      'objective_role_assignments',
      'objectives',
      'org_units',
      'process_definitions',
      'process_nodes',
      'process_versions',
      'role_assignments',
      'tasks',
      'users',
    ];
    expect(referencePolicies).toEqual(
      processReferenceTables.map((tableName) => ({
        tableName,
        permissive: 'PERMISSIVE',
        command: 'SELECT',
        roles: ['enterprise_agent_process'],
        usingExpression: 'true',
      })),
    );
  });

  it('limits lifecycle tenant discovery to active tenant identifiers', async () => {
    const [roleBoundary] = await prisma.$queryRaw<
      Array<{
        canLogin: boolean;
        bypassesRls: boolean;
        isSuperuser: boolean;
        adminIsMember: boolean;
        appIsMember: boolean;
        authIsMember: boolean;
        outboxIsMember: boolean;
        provisionerIsMember: boolean;
      }>
    >`
      SELECT
        lifecycle.rolcanlogin AS "canLogin",
        lifecycle.rolbypassrls AS "bypassesRls",
        lifecycle.rolsuper AS "isSuperuser",
        pg_has_role(
          'enterprise_agent_admin',
          'enterprise_agent_lifecycle',
          'MEMBER'
        ) AS "adminIsMember",
        pg_has_role(
          'enterprise_agent_app',
          'enterprise_agent_lifecycle',
          'MEMBER'
        ) AS "appIsMember",
        pg_has_role(
          'enterprise_agent_auth',
          'enterprise_agent_lifecycle',
          'MEMBER'
        ) AS "authIsMember",
        pg_has_role(
          'enterprise_agent_outbox',
          'enterprise_agent_lifecycle',
          'MEMBER'
        ) AS "outboxIsMember",
        pg_has_role(
          'enterprise_agent_provisioner',
          'enterprise_agent_lifecycle',
          'MEMBER'
        ) AS "provisionerIsMember"
      FROM pg_roles AS lifecycle
      WHERE lifecycle.rolname = 'enterprise_agent_lifecycle'
    `;
    expect(roleBoundary).toEqual({
      canLogin: false,
      bypassesRls: false,
      isSuperuser: false,
      adminIsMember: false,
      appIsMember: false,
      authIsMember: false,
      outboxIsMember: false,
      provisionerIsMember: false,
    });

    const nestedCapabilityMemberships = await prisma.$queryRaw<
      Array<{ memberRole: string; grantedRole: string }>
    >`
      SELECT
        member_role.rolname AS "memberRole",
        granted_role.rolname AS "grantedRole"
      FROM pg_auth_members AS membership
      JOIN pg_roles AS member_role ON member_role.oid = membership.member
      JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = ANY (ARRAY[
          'enterprise_agent_app',
          'enterprise_agent_auth',
          'enterprise_agent_admin',
          'enterprise_agent_outbox',
          'enterprise_agent_provisioner',
          'enterprise_agent_lifecycle',
          'enterprise_agent_process',
          'enterprise_agent_runtime'
        ])
        AND granted_role.rolname = ANY (ARRAY[
          'enterprise_agent_app',
          'enterprise_agent_auth',
          'enterprise_agent_admin',
          'enterprise_agent_outbox',
          'enterprise_agent_provisioner',
          'enterprise_agent_lifecycle',
          'enterprise_agent_process',
          'enterprise_agent_runtime'
        ])
      ORDER BY member_role.rolname, granted_role.rolname
    `;
    expect(nestedCapabilityMemberships).toEqual([]);

    const [policy] = await prisma.$queryRaw<
      Array<{
        policyName: string;
        permissive: string;
        command: string;
        roles: string[];
        usingExpression: string;
      }>
    >`
      SELECT
        policyname AS "policyName",
        permissive,
        cmd AS command,
        roles::text[] AS roles,
        qual AS "usingExpression"
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'tenants'
        AND policyname = 'enterprise_agent_lifecycle_tenant_enumeration'
    `;
    expect(policy).toEqual({
      policyName: 'enterprise_agent_lifecycle_tenant_enumeration',
      permissive: 'PERMISSIVE',
      command: 'SELECT',
      roles: ['enterprise_agent_lifecycle'],
      usingExpression: 'true',
    });

    const privileges = await prisma.$queryRaw<
      Array<{ tableName: string; columnName: string; privilegeType: string }>
    >`
      SELECT
        table_name AS "tableName",
        column_name AS "columnName",
        privilege_type AS "privilegeType"
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND grantee = 'enterprise_agent_lifecycle'
      ORDER BY table_name, privilege_type, column_name
    `;
    const expectedPrivileges = Object.entries(lifecycleColumnAclBaseline)
      .flatMap(([tableName, privilegesByType]) =>
        Object.entries(privilegesByType).flatMap(([privilegeType, columns]) =>
          (columns as readonly string[]).map((columnName) => ({
            tableName,
            columnName,
            privilegeType,
          })),
        ),
      )
      .sort((left, right) =>
        [left.tableName, left.privilegeType, left.columnName]
          .join(':')
          .localeCompare([right.tableName, right.privilegeType, right.columnName].join(':')),
      );
    expect(privileges).toEqual(expectedPrivileges);

    const tablePrivileges = await prisma.$queryRaw<
      Array<{ tableName: string; privilegeType: string }>
    >`
      SELECT
        table_name AS "tableName",
        privilege_type AS "privilegeType"
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee = 'enterprise_agent_lifecycle'
      ORDER BY table_name, privilege_type
    `;
    expect(tablePrivileges).toEqual([]);

    await prisma.tenant.upsert({
      where: { id: otherTenantId },
      create: {
        id: otherTenantId,
        slug: 'lifecycle-tenant-discovery-test',
        name: 'Lifecycle tenant discovery test',
      },
      update: { status: 'ACTIVE' },
    });
    try {
      const visible = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_lifecycle');
        return transaction.tenant.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
      });
      expect(visible.map(({ id }) => id)).toEqual(
        expect.arrayContaining([tenantId, otherTenantId]),
      );
    } finally {
      await prisma.tenant.deleteMany({ where: { id: otherTenantId } });
    }
  });

  it('uses the full knowledge-base document identity in every version and chunk foreign key', async () => {
    const constraints = await prisma.$queryRaw<
      Array<{ constraintName: string; definition: string }>
    >(Prisma.sql`
      SELECT
        constraint_name.conname AS "constraintName",
        pg_get_constraintdef(constraint_name.oid) AS definition
      FROM pg_constraint AS constraint_name
      WHERE constraint_name.contype = 'f'
        AND constraint_name.conname IN (${Prisma.join(Object.keys(knowledgeIdentityForeignKeys))})
      ORDER BY constraint_name.conname
    `);

    expect(constraints).toHaveLength(Object.keys(knowledgeIdentityForeignKeys).length);
    for (const { constraintName, definition } of constraints) {
      const expected =
        knowledgeIdentityForeignKeys[constraintName as keyof typeof knowledgeIdentityForeignKeys];
      expect(expected).toBeDefined();
      const columns = definition
        .replaceAll('"', '')
        .match(/^FOREIGN KEY\s+\(([^)]+)\)\s+REFERENCES\s+[^(]+\(([^)]+)\)/);
      expect(columns).not.toBeNull();
      expect(splitConstraintColumns(columns?.[1])).toEqual(expected.local);
      expect(splitConstraintColumns(columns?.[2])).toEqual(expected.referenced);
    }
  });

  it('rejects a version that labels a document with another knowledge base in the same tenant', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO knowledge_document_versions (
            id, tenant_id, knowledge_base_id, document_id, version_number,
            source_type, content_text, created_by_id
          ) VALUES (
            '00000000-0000-7000-8000-00000000d901'::uuid,
            ${tenantId}::uuid,
            ${fixture.knowledgeBaseBId}::uuid,
            ${fixture.documentAId}::uuid,
            2,
            'TEXT',
            'must be rejected',
            ${fixture.userId}::uuid
          )
        `;
        throw new Error('Expected the cross-knowledge-base version insert to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_document_versions_document_fkey');
  });

  it('rejects a current version that belongs to another knowledge-base document', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          UPDATE knowledge_documents
          SET current_version_id = ${fixture.versionBId}::uuid
          WHERE tenant_id = ${tenantId}::uuid
            AND id = ${fixture.documentAId}::uuid
        `;
        throw new Error('Expected the cross-document current version update to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_documents_current_version_fkey');
  });

  it('rejects a chunk whose knowledge base disagrees with its document and version', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO knowledge_chunks (
            id, tenant_id, knowledge_base_id, document_id, document_version_id,
            chunk_index, content, token_count, content_hash
          ) VALUES (
            '00000000-0000-7000-8000-00000000d902'::uuid,
            ${tenantId}::uuid,
            ${fixture.knowledgeBaseBId}::uuid,
            ${fixture.documentAId}::uuid,
            ${fixture.versionAId}::uuid,
            0,
            'must be rejected',
            3,
            ${'c'.repeat(64)}
          )
        `;
        throw new Error('Expected the cross-knowledge-base chunk insert to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_chunks_document_fkey');
  });

  it('rejects relationship evidence that relabels a chunk from another knowledge base', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.knowledgeChunk.createMany({
          data: [
            {
              id: '00000000-0000-7000-8000-00000000d911',
              tenantId,
              knowledgeBaseId: fixture.knowledgeBaseAId,
              documentId: fixture.documentAId,
              documentVersionId: fixture.versionAId,
              chunkIndex: 0,
              content: 'Knowledge graph evidence A',
              tokenCount: 4,
              contentHash: 'd'.repeat(64),
            },
            {
              id: '00000000-0000-7000-8000-00000000d912',
              tenantId,
              knowledgeBaseId: fixture.knowledgeBaseBId,
              documentId: fixture.documentBId,
              documentVersionId: fixture.versionBId,
              chunkIndex: 0,
              content: 'Knowledge graph evidence B',
              tokenCount: 4,
              contentHash: 'e'.repeat(64),
            },
          ],
        });
        await transaction.knowledgeEntity.createMany({
          data: [
            {
              id: '00000000-0000-7000-8000-00000000d921',
              tenantId,
              knowledgeBaseId: fixture.knowledgeBaseAId,
              entityType: 'DOCUMENT',
              canonicalName: 'Document A',
              normalizedName: 'document a',
              externalKey: `document:${fixture.documentAId}`,
            },
            {
              id: '00000000-0000-7000-8000-00000000d922',
              tenantId,
              knowledgeBaseId: fixture.knowledgeBaseAId,
              entityType: 'PERSON',
              canonicalName: 'Owner A',
              normalizedName: 'owner a',
            },
          ],
        });
        await transaction.knowledgeRelation.create({
          data: {
            id: '00000000-0000-7000-8000-00000000d931',
            tenantId,
            knowledgeBaseId: fixture.knowledgeBaseAId,
            subjectEntityId: '00000000-0000-7000-8000-00000000d921',
            predicate: 'OWNED_BY',
            normalizedPredicate: 'OWNED_BY',
            objectEntityId: '00000000-0000-7000-8000-00000000d922',
          },
        });

        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_relation_evidence" (
            tenant_id, knowledge_base_id, projection_id, relation_id, document_id,
            document_version_id, chunk_id, excerpt, extractor
          ) VALUES (
            ${tenantId}::uuid,
            ${fixture.knowledgeBaseAId}::uuid,
            ${fixture.projectionBId}::uuid,
            '00000000-0000-7000-8000-00000000d931'::uuid,
            ${fixture.documentBId}::uuid,
            ${fixture.versionBId}::uuid,
            '00000000-0000-7000-8000-00000000d912'::uuid,
            'must be rejected',
            'database_negative_test'
          )
        `;
        throw new Error('Expected cross-knowledge-base relationship evidence to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_relation_evidence_document_fkey');
  });

  it('allows only one active ingestion job per version', async () => {
    const [index] = await prisma.$queryRaw<Array<{ unique: boolean; predicate: string | null }>>`
      SELECT
        definition.indisunique AS unique,
        pg_get_expr(definition.indpred, definition.indrelid) AS predicate
      FROM pg_index AS definition
      JOIN pg_class AS index_relation ON index_relation.oid = definition.indexrelid
      JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND index_relation.relname = 'knowledge_ingestion_jobs_active_version_key'
    `;
    expect(index?.unique).toBe(true);
    expect(index?.predicate).toContain("'PENDING'");
    expect(index?.predicate).toContain("'RUNNING'");

    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_ingestion_jobs" (
            "id", "tenant_id", "document_version_id", "status"
          ) VALUES (
            '00000000-0000-7000-8000-00000000d601'::uuid,
            ${tenantId}::uuid,
            ${fixture.versionAId}::uuid,
            'PENDING'::"KnowledgeIngestionStatus"
          )
        `;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_ingestion_jobs" (
            "id", "tenant_id", "document_version_id", "status"
          ) VALUES (
            '00000000-0000-7000-8000-00000000d602'::uuid,
            ${tenantId}::uuid,
            ${fixture.versionAId}::uuid,
            'PENDING'::"KnowledgeIngestionStatus"
          )
        `;
        throw new Error('Expected the duplicate active ingestion job to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23505' });
  });

  it('rejects a running ingestion job without an owned lease', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createKnowledgeIdentityFixture(transaction, tenantId);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_ingestion_jobs" (
            "id", "tenant_id", "document_version_id", "status"
          ) VALUES (
            '00000000-0000-7000-8000-00000000d603'::uuid,
            ${tenantId}::uuid,
            ${fixture.versionAId}::uuid,
            'RUNNING'::"KnowledgeIngestionStatus"
          )
        `;
        throw new Error('Expected the unleased running ingestion job to fail.');
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23514' });
    expect(rejected.databaseMessage).toContain('knowledge_ingestion_jobs_claim_state_check');
  });

  it('tenant-isolates knowledge versions, chunks, and ingestion jobs across two real tenants', async () => {
    let observation:
      | {
          totalVersions: number;
          totalChunks: number;
          totalJobs: number;
          appVersionTenantIds: string[];
          appChunkTenantIds: string[];
          adminJobTenantIds: string[];
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_KNOWLEDGE_RLS_FIXTURE');

    await expect(
      prisma.$transaction(
        async (transaction) => {
          const fixture = await createTwoTenantKnowledgeFixture(transaction);
          const totals = {
            totalVersions: await transaction.knowledgeDocumentVersion.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalChunks: await transaction.knowledgeChunk.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalJobs: await transaction.knowledgeIngestionJob.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
          };

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const appVersions = await transaction.knowledgeDocumentVersion.findMany({
            select: { tenantId: true },
          });
          const appChunks = await transaction.knowledgeChunk.findMany({
            select: { tenantId: true },
          });

          await transaction.$executeRawUnsafe('RESET ROLE');
          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const adminJobs = await transaction.knowledgeIngestionJob.findMany({
            select: { tenantId: true },
          });
          observation = {
            ...totals,
            appVersionTenantIds: appVersions.map((row) => row.tenantId),
            appChunkTenantIds: appChunks.map((row) => row.tenantId),
            adminJobTenantIds: adminJobs.map((row) => row.tenantId),
          };
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      totalVersions: 2,
      totalChunks: 2,
      totalJobs: 2,
      appVersionTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      appChunkTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      adminJobTenantIds: ['00000000-0000-7000-8000-00000000c001'],
    });
  });

  it('tenant-isolates evidence-backed knowledge entities and relations across two real tenants', async () => {
    let observation:
      | {
          totalEntities: number;
          totalMentions: number;
          totalRelations: number;
          totalEvidence: number;
          visibleEntityTenantIds: string[];
          visibleMentionTenantIds: string[];
          visibleRelationTenantIds: string[];
          visibleEvidenceTenantIds: string[];
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_KNOWLEDGE_GRAPH_RLS_FIXTURE');

    await expect(
      prisma.$transaction(
        async (transaction) => {
          const fixture = await createTwoTenantKnowledgeFixture(transaction);
          const documentEntityIds = [
            '00000000-0000-7000-8000-00000000c701',
            '00000000-0000-7000-8000-00000000c702',
          ];
          const ownerEntityIds = [
            '00000000-0000-7000-8000-00000000c711',
            '00000000-0000-7000-8000-00000000c712',
          ];
          const mentionIds = [
            '00000000-0000-7000-8000-00000000c721',
            '00000000-0000-7000-8000-00000000c722',
          ];
          const relationIds = [
            '00000000-0000-7000-8000-00000000c731',
            '00000000-0000-7000-8000-00000000c732',
          ];
          const evidenceIds = [
            '00000000-0000-7000-8000-00000000c741',
            '00000000-0000-7000-8000-00000000c742',
          ];
          for (const [index, tenantId] of fixture.tenantIds.entries()) {
            await transaction.knowledgeEntity.createMany({
              data: [
                {
                  id: documentEntityIds[index]!,
                  tenantId,
                  knowledgeBaseId: fixture.knowledgeBaseIds[index]!,
                  entityType: 'DOCUMENT',
                  canonicalName: `Knowledge RLS document ${index + 1}`,
                  normalizedName: `knowledge rls document ${index + 1}`,
                  externalKey: `document:${fixture.documentIds[index]!}`,
                  confidence: 1,
                },
                {
                  id: ownerEntityIds[index]!,
                  tenantId,
                  knowledgeBaseId: fixture.knowledgeBaseIds[index]!,
                  entityType: 'PERSON',
                  canonicalName: `Owner ${index + 1}`,
                  normalizedName: `owner ${index + 1}`,
                  confidence: 0.95,
                },
              ],
            });
            await transaction.$executeRaw`
              INSERT INTO public."knowledge_entity_mentions"(
                "id", "tenant_id", "knowledge_base_id", "projection_id",
                "entity_id", "document_id", "document_version_id", "chunk_id",
                "surface_form", "start_offset", "end_offset", "confidence", "extractor"
              ) VALUES (
                ${mentionIds[index]!}::uuid,
                ${tenantId}::uuid,
                ${fixture.knowledgeBaseIds[index]!}::uuid,
                ${fixture.projectionIds[index]!}::uuid,
                ${ownerEntityIds[index]!}::uuid,
                ${fixture.documentIds[index]!}::uuid,
                ${fixture.versionIds[index]!}::uuid,
                ${fixture.chunkIds[index]!}::uuid,
                ${`Owner ${index + 1}`},
                0,
                7,
                0.95,
                'database_rls_test'
              )
            `;
            await transaction.knowledgeRelation.create({
              data: {
                id: relationIds[index]!,
                tenantId,
                knowledgeBaseId: fixture.knowledgeBaseIds[index]!,
                subjectEntityId: documentEntityIds[index]!,
                predicate: 'OWNED_BY',
                normalizedPredicate: 'OWNED_BY',
                objectEntityId: ownerEntityIds[index]!,
                confidence: 0.95,
              },
            });
            await transaction.$executeRaw`
              INSERT INTO public."knowledge_relation_evidence"(
                "id", "tenant_id", "knowledge_base_id", "projection_id",
                "relation_id", "document_id", "document_version_id", "chunk_id",
                "excerpt", "start_offset", "end_offset", "confidence", "extractor"
              ) VALUES (
                ${evidenceIds[index]!}::uuid,
                ${tenantId}::uuid,
                ${fixture.knowledgeBaseIds[index]!}::uuid,
                ${fixture.projectionIds[index]!}::uuid,
                ${relationIds[index]!}::uuid,
                ${fixture.documentIds[index]!}::uuid,
                ${fixture.versionIds[index]!}::uuid,
                ${fixture.chunkIds[index]!}::uuid,
                ${`Owner ${index + 1}`},
                0,
                7,
                0.95,
                'database_rls_test'
              )
            `;
          }
          const totals = {
            totalEntities: await transaction.knowledgeEntity.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalMentions: await transaction.knowledgeEntityMention.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalRelations: await transaction.knowledgeRelation.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
            totalEvidence: await transaction.knowledgeRelationEvidence.count({
              where: { tenantId: { in: fixture.tenantIds } },
            }),
          };

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const [entities, mentions, relations, evidence] = await Promise.all([
            transaction.knowledgeEntity.findMany({ select: { tenantId: true } }),
            transaction.knowledgeEntityMention.findMany({ select: { tenantId: true } }),
            transaction.knowledgeRelation.findMany({ select: { tenantId: true } }),
            transaction.knowledgeRelationEvidence.findMany({ select: { tenantId: true } }),
          ]);
          observation = {
            ...totals,
            visibleEntityTenantIds: [...new Set(entities.map((row) => row.tenantId))],
            visibleMentionTenantIds: [...new Set(mentions.map((row) => row.tenantId))],
            visibleRelationTenantIds: [...new Set(relations.map((row) => row.tenantId))],
            visibleEvidenceTenantIds: [...new Set(evidence.map((row) => row.tenantId))],
          };
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      totalEntities: 4,
      totalMentions: 2,
      totalRelations: 2,
      totalEvidence: 2,
      visibleEntityTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      visibleMentionTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      visibleRelationTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      visibleEvidenceTenantIds: ['00000000-0000-7000-8000-00000000c001'],
    });
  });

  it('keeps graph writes admin-only and denies auth and outbox graph reads', async () => {
    const privileges = await prisma.$queryRaw<
      Array<{
        tableName: string;
        appCanSelect: boolean;
        appCanInsert: boolean;
        adminCanWrite: boolean;
        authCanSelect: boolean;
        outboxCanSelect: boolean;
      }>
    >`
      SELECT
        graph_table.table_name AS "tableName",
        has_table_privilege(
          'enterprise_agent_app',
          format('public.%I', graph_table.table_name),
          'SELECT'
        ) AS "appCanSelect",
        has_table_privilege(
          'enterprise_agent_app',
          format('public.%I', graph_table.table_name),
          'INSERT'
        ) AS "appCanInsert",
        (
          has_table_privilege(
            'enterprise_agent_admin',
            format('public.%I', graph_table.table_name),
            'INSERT'
          )
          AND has_table_privilege(
            'enterprise_agent_admin',
            format('public.%I', graph_table.table_name),
            'UPDATE'
          )
          AND has_table_privilege(
            'enterprise_agent_admin',
            format('public.%I', graph_table.table_name),
            'DELETE'
          )
        ) AS "adminCanWrite",
        has_table_privilege(
          'enterprise_agent_auth',
          format('public.%I', graph_table.table_name),
          'SELECT'
        ) AS "authCanSelect",
        has_table_privilege(
          'enterprise_agent_outbox',
          format('public.%I', graph_table.table_name),
          'SELECT'
        ) AS "outboxCanSelect"
      FROM unnest(ARRAY[
        'knowledge_entities',
        'knowledge_entity_mentions',
        'knowledge_relations',
        'knowledge_relation_evidence'
      ]::text[]) AS graph_table(table_name)
      ORDER BY graph_table.table_name
    `;

    expect(privileges).toEqual(
      [
        'knowledge_entities',
        'knowledge_entity_mentions',
        'knowledge_relation_evidence',
        'knowledge_relations',
      ].map((tableName) => ({
        tableName,
        appCanSelect: true,
        appCanInsert: false,
        adminCanWrite: true,
        authCanSelect: false,
        outboxCanSelect: false,
      })),
    );
  });

  it('tenant-isolates semantic embeddings across two real tenants', async () => {
    let observation:
      | {
          total: number;
          visibleTenantIds: string[];
          visibleChunkIds: string[];
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_KNOWLEDGE_EMBEDDING_RLS_FIXTURE');

    await expect(
      prisma.$transaction(
        async (transaction) => {
          const fixture = await createTwoTenantKnowledgeFixture(transaction);
          for (const [index, tenantId] of fixture.tenantIds.entries()) {
            await transaction.$executeRaw`
              INSERT INTO public."knowledge_chunk_embeddings" (
                "tenant_id", "chunk_id", "embedding_model", "embedding_dimension",
                "content_hash", "embedding"
              ) VALUES (
                ${tenantId}::uuid,
                ${fixture.chunkIds[index]}::uuid,
                'rls-test-embedding-model',
                1536,
                ${String(index === 0 ? 'a' : 'b').repeat(64)},
                ${unitVectorLiteral(index)}::vector
              )
            `;
          }
          const [totalRow] = await transaction.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count
            FROM public."knowledge_chunk_embeddings"
            WHERE "tenant_id" IN (${fixture.tenantAId}::uuid, ${fixture.tenantBId}::uuid)
          `;

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
          const visible = await transaction.$queryRaw<Array<{ tenantId: string; chunkId: string }>>`
            SELECT "tenant_id"::text AS "tenantId", "chunk_id"::text AS "chunkId"
            FROM public."knowledge_chunk_embeddings"
            ORDER BY "chunk_id"
          `;
          observation = {
            total: totalRow?.count ?? 0,
            visibleTenantIds: visible.map((row) => row.tenantId),
            visibleChunkIds: visible.map((row) => row.chunkId),
          };
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      total: 2,
      visibleTenantIds: ['00000000-0000-7000-8000-00000000c001'],
      visibleChunkIds: ['00000000-0000-7000-8000-00000000c501'],
    });
  });

  it('rejects a semantic embedding whose chunk belongs to another tenant', async () => {
    const rejected = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantKnowledgeFixture(transaction);
        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_admin');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
        await transaction.$executeRaw`
          INSERT INTO public."knowledge_chunk_embeddings" (
            "tenant_id", "chunk_id", "embedding_model", "embedding_dimension",
            "content_hash", "embedding"
          ) VALUES (
            ${fixture.tenantAId}::uuid,
            ${fixture.chunkIds[1]}::uuid,
            'cross-tenant-negative-test',
            1536,
            ${'c'.repeat(64)},
            ${unitVectorLiteral(0)}::vector
          )
        `;
      }),
    );

    expect(rejected).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(rejected.databaseMessage).toContain('knowledge_chunk_embeddings_chunk_fkey');
  });

  it('tenant-isolates answer-feedback reads and updates across two real tenants', async () => {
    let observation:
      | {
          total: number;
          visibleTenantIds: string[];
          crossTenantUpdates: number;
          ownTenantUpdates: number;
          ownRating: string | undefined;
        }
      | undefined;
    const rollback = new Error('ROLLBACK_TWO_TENANT_ANSWER_FEEDBACK_RLS_FIXTURE');

    await expect(
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantAnswerFeedbackFixture(transaction);
        const total = await transaction.answerFeedback.count({
          where: { tenantId: { in: [fixture.tenantAId, fixture.tenantBId] } },
        });

        await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${fixture.tenantAId}, true)`;
        const visible = await transaction.answerFeedback.findMany({
          select: { tenantId: true },
          orderBy: { tenantId: 'asc' },
        });
        const crossTenant = await transaction.answerFeedback.updateMany({
          where: { tenantId: fixture.tenantBId },
          data: { rating: 'HELPFUL', reason: null },
        });
        const ownTenant = await transaction.answerFeedback.updateMany({
          where: { tenantId: fixture.tenantAId },
          data: { rating: 'NOT_HELPFUL', reason: 'OTHER', comment: 'tenant A update' },
        });
        const own = await transaction.answerFeedback.findFirst({
          where: { tenantId: fixture.tenantAId },
          select: { rating: true },
        });
        observation = {
          total,
          visibleTenantIds: visible.map((row) => row.tenantId),
          crossTenantUpdates: crossTenant.count,
          ownTenantUpdates: ownTenant.count,
          ownRating: own?.rating,
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(observation).toEqual({
      total: 2,
      visibleTenantIds: ['00000000-0000-7000-8000-00000000e001'],
      crossTenantUpdates: 0,
      ownTenantUpdates: 1,
      ownRating: 'NOT_HELPFUL',
    });
  });

  it('enforces one answer feedback per tenant/message/user and tenant-scoped parents', async () => {
    const duplicate = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantAnswerFeedbackFixture(transaction);
        const existing = await transaction.answerFeedback.findFirstOrThrow({
          where: { tenantId: fixture.tenantAId },
        });
        await transaction.answerFeedback.create({
          data: {
            tenantId: existing.tenantId,
            messageId: existing.messageId,
            userId: existing.userId,
            rating: 'HELPFUL',
          },
        });
      }),
    );
    expect(duplicate).toMatchObject({ prismaCode: 'P2002' });

    const crossTenantParent = await captureDatabaseError(() =>
      prisma.$transaction(async (transaction) => {
        const fixture = await createTwoTenantAnswerFeedbackFixture(transaction);
        const tenantAFeedback = await transaction.answerFeedback.findFirstOrThrow({
          where: { tenantId: fixture.tenantAId },
        });
        const tenantBFeedback = await transaction.answerFeedback.findFirstOrThrow({
          where: { tenantId: fixture.tenantBId },
        });
        await transaction.$executeRaw`
          INSERT INTO answer_feedbacks (
            tenant_id, message_id, user_id, rating
          ) VALUES (
            ${fixture.tenantAId}::uuid,
            ${tenantBFeedback.messageId}::uuid,
            ${tenantAFeedback.userId}::uuid,
            'HELPFUL'
          )
        `;
      }),
    );
    expect(crossTenantParent).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(crossTenantParent.databaseMessage).toContain(
      'answer_feedbacks_tenant_id_message_id_fkey',
    );
  });

  it('makes a cross-tenant parent indistinguishable from a missing parent', async () => {
    const attemptInsert = async (createOtherTenantParent: boolean) => {
      try {
        await prisma.$transaction(async (transaction) => {
          if (createOtherTenantParent) {
            // This setup runs as the local migration login. The failing insert
            // below runs only after demotion to the restricted application role.
            // The rejected transaction rolls all setup back automatically.
            await transaction.tenant.create({
              data: {
                id: otherTenantId,
                slug: 'foreign-key-negative-test',
                name: 'Foreign key negative test',
              },
            });
            await transaction.user.create({
              data: {
                id: otherTenantUserId,
                tenantId: otherTenantId,
                email: 'foreign-key-negative@example.test',
                emailNormalized: 'foreign-key-negative@example.test',
                displayName: 'Foreign tenant user',
              },
            });
          }

          await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
          await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await transaction.$executeRaw`
            INSERT INTO conversations (
              id,
              tenant_id,
              direct_key,
              created_by_id,
              updated_at
            ) VALUES (
              '00000000-0000-7000-8000-000000000809'::uuid,
              ${tenantId}::uuid,
              'foreign-key-negative-test',
              ${otherTenantUserId}::uuid,
              CURRENT_TIMESTAMP
            )
          `;
        });
      } catch (error: unknown) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
        const metadata = error.meta as { code?: unknown; message?: unknown } | undefined;
        return {
          prismaCode: error.code,
          sqlState: String(metadata?.code),
          databaseMessage: String(metadata?.message),
        };
      }
      throw new Error('Expected the tenant-scoped foreign key to reject the insert.');
    };

    const crossTenant = await attemptInsert(true);
    const missing = await attemptInsert(false);

    expect(crossTenant).toEqual(missing);
    expect(crossTenant).toMatchObject({ prismaCode: 'P2010', sqlState: '23503' });
    expect(crossTenant.databaseMessage).toContain('conversations_tenant_id_created_by_id_fkey');
    await expect(prisma.tenant.count({ where: { id: otherTenantId } })).resolves.toBe(0);
  });

  async function captureDatabaseError(
    operation: () => Promise<unknown>,
  ): Promise<{ prismaCode: string; sqlState: string; databaseMessage: string }> {
    try {
      await operation();
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      const metadata = error.meta as { code?: unknown; message?: unknown } | undefined;
      return {
        prismaCode: error.code,
        sqlState: String(metadata?.code),
        databaseMessage: String(metadata?.message),
      };
    }
    throw new Error('Expected the database operation to be denied.');
  }
});

function splitConstraintColumns(value: string | undefined): string[] {
  return value?.split(',').map((column) => column.trim()) ?? [];
}

async function createKnowledgeIdentityFixture(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<{
  userId: string;
  knowledgeBaseAId: string;
  knowledgeBaseBId: string;
  documentAId: string;
  documentBId: string;
  versionAId: string;
  versionBId: string;
  projectionAId: string;
  projectionBId: string;
}> {
  const userId = '00000000-0000-7000-8000-000000000101';
  const knowledgeBaseAId = '00000000-0000-7000-8000-00000000d101';
  const knowledgeBaseBId = '00000000-0000-7000-8000-00000000d102';
  const documentAId = '00000000-0000-7000-8000-00000000d201';
  const documentBId = '00000000-0000-7000-8000-00000000d202';
  const versionAId = '00000000-0000-7000-8000-00000000d301';
  const versionBId = '00000000-0000-7000-8000-00000000d302';
  const projectionAId = '00000000-0000-7000-8000-00000000d401';
  const projectionBId = '00000000-0000-7000-8000-00000000d402';

  await transaction.knowledgeBase.createMany({
    data: [
      {
        id: knowledgeBaseAId,
        tenantId,
        key: 'knowledge-identity-negative-a',
        name: 'Knowledge identity negative A',
        status: 'ACTIVE',
        createdById: userId,
      },
      {
        id: knowledgeBaseBId,
        tenantId,
        key: 'knowledge-identity-negative-b',
        name: 'Knowledge identity negative B',
        status: 'ACTIVE',
        createdById: userId,
      },
    ],
  });
  await transaction.knowledgeDocument.createMany({
    data: [
      {
        id: documentAId,
        tenantId,
        knowledgeBaseId: knowledgeBaseAId,
        title: 'Knowledge identity document A',
        sourceType: 'TEXT',
        status: 'READY',
        createdById: userId,
      },
      {
        id: documentBId,
        tenantId,
        knowledgeBaseId: knowledgeBaseBId,
        title: 'Knowledge identity document B',
        sourceType: 'TEXT',
        status: 'READY',
        createdById: userId,
      },
    ],
  });
  await transaction.knowledgeDocumentVersion.createMany({
    data: [
      {
        id: versionAId,
        tenantId,
        knowledgeBaseId: knowledgeBaseAId,
        documentId: documentAId,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'Knowledge identity content A',
        status: 'READY',
        createdById: userId,
      },
      {
        id: versionBId,
        tenantId,
        knowledgeBaseId: knowledgeBaseBId,
        documentId: documentBId,
        versionNumber: 1,
        sourceType: 'TEXT',
        contentText: 'Knowledge identity content B',
        status: 'READY',
        createdById: userId,
      },
    ],
  });
  await transaction.$executeRaw`
    INSERT INTO public."knowledge_graph_projections"(
      "id", "tenant_id", "knowledge_base_id", "document_id",
      "document_version_id", "graph_hash", "created_by_user_id"
    ) VALUES
      (
        ${projectionAId}::uuid, ${tenantId}::uuid, ${knowledgeBaseAId}::uuid,
        ${documentAId}::uuid, ${versionAId}::uuid, ${'a'.repeat(64)}, ${userId}::uuid
      ),
      (
        ${projectionBId}::uuid, ${tenantId}::uuid, ${knowledgeBaseBId}::uuid,
        ${documentBId}::uuid, ${versionBId}::uuid, ${'b'.repeat(64)}, ${userId}::uuid
      )
  `;

  return {
    userId,
    knowledgeBaseAId,
    knowledgeBaseBId,
    documentAId,
    documentBId,
    versionAId,
    versionBId,
    projectionAId,
    projectionBId,
  };
}

async function createTwoTenantKnowledgeFixture(transaction: Prisma.TransactionClient): Promise<{
  tenantAId: string;
  tenantBId: string;
  tenantIds: string[];
  knowledgeBaseIds: string[];
  documentIds: string[];
  versionIds: string[];
  chunkIds: string[];
  projectionIds: string[];
}> {
  const tenantAId = '00000000-0000-7000-8000-00000000c001';
  const tenantBId = '00000000-0000-7000-8000-00000000c002';
  const tenantIds = [tenantAId, tenantBId];
  const userIds = ['00000000-0000-7000-8000-00000000c101', '00000000-0000-7000-8000-00000000c102'];
  const knowledgeBaseIds = [
    '00000000-0000-7000-8000-00000000c201',
    '00000000-0000-7000-8000-00000000c202',
  ];
  const documentIds = [
    '00000000-0000-7000-8000-00000000c301',
    '00000000-0000-7000-8000-00000000c302',
  ];
  const versionIds = [
    '00000000-0000-7000-8000-00000000c401',
    '00000000-0000-7000-8000-00000000c402',
  ];
  const chunkIds = ['00000000-0000-7000-8000-00000000c501', '00000000-0000-7000-8000-00000000c502'];
  const projectionIds = [
    '00000000-0000-7000-8000-00000000c551',
    '00000000-0000-7000-8000-00000000c552',
  ];
  const jobIds = ['00000000-0000-7000-8000-00000000c601', '00000000-0000-7000-8000-00000000c602'];

  await transaction.tenant.createMany({
    data: tenantIds.map((id, index) => ({
      id,
      slug: `knowledge-rls-fixture-${index + 1}`,
      name: `Knowledge RLS fixture ${index + 1}`,
    })),
  });
  await transaction.user.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: userIds[index]!,
      tenantId,
      email: `owner-${index + 1}@knowledge-rls.test`,
      emailNormalized: `owner-${index + 1}@knowledge-rls.test`,
      displayName: `Knowledge RLS owner ${index + 1}`,
      role: 'OWNER' as const,
    })),
  });
  await transaction.knowledgeBase.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: knowledgeBaseIds[index]!,
      tenantId,
      key: 'knowledge-rls-fixture',
      name: `Knowledge RLS base ${index + 1}`,
      status: 'ACTIVE' as const,
      createdById: userIds[index]!,
    })),
  });
  await transaction.knowledgeDocument.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: documentIds[index]!,
      tenantId,
      knowledgeBaseId: knowledgeBaseIds[index]!,
      title: `Knowledge RLS document ${index + 1}`,
      sourceType: 'TEXT' as const,
      contentText: `tenant ${index + 1}`,
      status: 'READY' as const,
      documentVersion: 1,
      createdById: userIds[index]!,
    })),
  });
  await transaction.knowledgeDocumentVersion.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: versionIds[index]!,
      tenantId,
      knowledgeBaseId: knowledgeBaseIds[index]!,
      documentId: documentIds[index]!,
      versionNumber: 1,
      sourceType: 'TEXT' as const,
      contentText: `tenant ${index + 1}`,
      status: 'READY' as const,
      createdById: userIds[index]!,
    })),
  });
  for (const [index, tenantId] of tenantIds.entries()) {
    await transaction.knowledgeDocument.update({
      where: { id: documentIds[index]! },
      data: { currentVersionId: versionIds[index]! },
    });
    await transaction.knowledgeChunk.create({
      data: {
        id: chunkIds[index]!,
        tenantId,
        knowledgeBaseId: knowledgeBaseIds[index]!,
        documentId: documentIds[index]!,
        documentVersionId: versionIds[index]!,
        chunkIndex: 0,
        content: `tenant ${index + 1}`,
        tokenCount: 2,
        contentHash: (index === 0 ? 'a' : 'b').repeat(64),
      },
    });
    await transaction.knowledgeIngestionJob.create({
      data: {
        id: jobIds[index]!,
        tenantId,
        documentVersionId: versionIds[index]!,
        stage: 'READY',
        status: 'SUCCEEDED',
        progress: 100,
        attempts: 1,
      },
    });
    await transaction.$executeRaw`
      INSERT INTO public."knowledge_graph_projections"(
        "id", "tenant_id", "knowledge_base_id", "document_id",
        "document_version_id", "graph_hash", "created_by_user_id"
      ) VALUES (
        ${projectionIds[index]!}::uuid,
        ${tenantId}::uuid,
        ${knowledgeBaseIds[index]!}::uuid,
        ${documentIds[index]!}::uuid,
        ${versionIds[index]!}::uuid,
        ${(index === 0 ? 'c' : 'd').repeat(64)},
        ${userIds[index]!}::uuid
      )
    `;
    await transaction.$executeRaw`
      UPDATE public."knowledge_graph_projections"
      SET "status" = 'ACTIVE', "activated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${projectionIds[index]!}::uuid
    `;
  }

  return {
    tenantAId,
    tenantBId,
    tenantIds,
    knowledgeBaseIds,
    documentIds,
    versionIds,
    chunkIds,
    projectionIds,
  };
}

function unitVectorLiteral(nonZeroIndex: number): string {
  return `[${Array.from({ length: 1_536 }, (_, index) => (index === nonZeroIndex ? '1' : '0')).join(',')}]`;
}

async function createTwoTenantAnswerFeedbackFixture(
  transaction: Prisma.TransactionClient,
): Promise<{ tenantAId: string; tenantBId: string }> {
  const tenantIds = [
    '00000000-0000-7000-8000-00000000e001',
    '00000000-0000-7000-8000-00000000e002',
  ];
  const userIds = ['00000000-0000-7000-8000-00000000e101', '00000000-0000-7000-8000-00000000e102'];
  const conversationIds = [
    '00000000-0000-7000-8000-00000000e201',
    '00000000-0000-7000-8000-00000000e202',
  ];
  const participantIds = [
    '00000000-0000-7000-8000-00000000e301',
    '00000000-0000-7000-8000-00000000e302',
  ];
  const messageIds = [
    '00000000-0000-7000-8000-00000000e401',
    '00000000-0000-7000-8000-00000000e402',
  ];

  await transaction.tenant.createMany({
    data: tenantIds.map((id, index) => ({
      id,
      slug: `answer-feedback-rls-${index + 1}`,
      name: `Answer feedback RLS ${index + 1}`,
    })),
  });
  await transaction.user.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: userIds[index]!,
      tenantId,
      email: `answer-feedback-${index + 1}@rls.test`,
      emailNormalized: `answer-feedback-${index + 1}@rls.test`,
      displayName: `Feedback user ${index + 1}`,
    })),
  });
  await transaction.conversation.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: conversationIds[index]!,
      tenantId,
      directKey: `answer-feedback-rls-${index + 1}`,
      createdById: userIds[index]!,
    })),
  });
  await transaction.conversationParticipant.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: participantIds[index]!,
      tenantId,
      conversationId: conversationIds[index]!,
      type: 'USER' as const,
      participantKey: `user:${userIds[index]!}`,
      userId: userIds[index]!,
      displayName: `Feedback user ${index + 1}`,
    })),
  });
  await transaction.message.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: messageIds[index]!,
      tenantId,
      conversationId: conversationIds[index]!,
      senderType: 'USER' as const,
      senderUserId: userIds[index]!,
      senderKey: `user:${userIds[index]!}`,
      senderName: `Feedback user ${index + 1}`,
      clientMessageId: `answer-feedback-rls-${index + 1}`,
      content: { type: 'text', text: `feedback fixture ${index + 1}` },
    })),
  });
  await transaction.answerFeedback.createMany({
    data: tenantIds.map((tenantId, index) => ({
      tenantId,
      messageId: messageIds[index]!,
      userId: userIds[index]!,
      rating: 'HELPFUL' as const,
    })),
  });

  return { tenantAId: tenantIds[0]!, tenantBId: tenantIds[1]! };
}
