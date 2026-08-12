import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvironmentVariables } from '../config/environment.js';

export const REQUIRED_APPLICATION_SCHEMA_COLUMNS = [
  { tableName: 'tenants', columnName: 'agent_run_monthly_token_limit' },
  { tableName: 'users', columnName: 'id' },
  { tableName: 'conversations', columnName: 'id' },
  { tableName: 'messages', columnName: 'id' },
  { tableName: 'outbox_events', columnName: 'provider_receipt' },
  { tableName: 'outbox_events', columnName: 'routing_purpose' },
  { tableName: 'outbox_event_routes', columnName: 'purpose' },
  { tableName: 'outbox_event_route_prefixes', columnName: 'purpose' },
  { tableName: 'outbox_event_deliveries', columnName: 'consumer_key' },
  { tableName: 'password_credentials', columnName: 'password_hash' },
  { tableName: 'auth_sessions', columnName: 'refresh_token_hash' },
  { tableName: 'org_units', columnName: 'status' },
  { tableName: 'knowledge_bases', columnName: 'id' },
  { tableName: 'knowledge_bases', columnName: 'active_embedding_index_version_id' },
  { tableName: 'knowledge_embedding_index_versions', columnName: 'dimensions' },
  { tableName: 'knowledge_base_org_units', columnName: 'include_children' },
  { tableName: 'knowledge_documents', columnName: 'current_version_id' },
  { tableName: 'knowledge_document_versions', columnName: 'status' },
  { tableName: 'knowledge_parent_chunks', columnName: 'parent_index' },
  { tableName: 'knowledge_chunks', columnName: 'content_hash' },
  { tableName: 'knowledge_chunks', columnName: 'parent_chunk_id' },
  { tableName: 'knowledge_chunks', columnName: 'previous_chunk_id' },
  { tableName: 'knowledge_chunks', columnName: 'next_chunk_id' },
  { tableName: 'knowledge_ingestion_jobs', columnName: 'status' },
  { tableName: 'knowledge_chunk_embeddings', columnName: 'embedding_model' },
  { tableName: 'knowledge_chunk_embeddings', columnName: 'embedding_index_version_id' },
  { tableName: 'agent_versions', columnName: 'knowledge_scope' },
  { tableName: 'agent_runs', columnName: 'cost_recorded_at' },
  { tableName: 'agent_runs', columnName: 'grounded_citation_count' },
  { tableName: 'agent_runs', columnName: 'task_id' },
  { tableName: 'agent_runs', columnName: 'memory_context_snapshot' },
  { tableName: 'ai_model_connectivity_probes', columnName: 'target_catalog_version_id' },
  { tableName: 'auth_login_rate_limits', columnName: 'blocked_until' },
  { tableName: 'auth_action_tokens', columnName: 'delivery_status' },
  { tableName: 'auth_recovery_deliveries', columnName: 'payload_ciphertext' },
  { tableName: 'value_definitions', columnName: 'current_version_id' },
  { tableName: 'value_versions', columnName: 'value_definition_id' },
  { tableName: 'value_metrics', columnName: 'metric_definition_id' },
  { tableName: 'value_constraints', columnName: 'value_version_id' },
  { tableName: 'strategies', columnName: 'status' },
  { tableName: 'strategy_value_versions', columnName: 'strategy_version' },
  { tableName: 'objectives', columnName: 'strategy_id' },
  { tableName: 'objective_value_versions', columnName: 'objective_version' },
  { tableName: 'objective_role_assignments', columnName: 'role_assignment_id' },
  { tableName: 'objective_relations', columnName: 'source_objective_id' },
  { tableName: 'metric_definitions', columnName: 'status' },
  {
    tableName: 'objective_metric_definitions',
    columnName: 'metric_definition_id',
  },
  { tableName: 'process_definitions', columnName: 'current_version_id' },
  { tableName: 'process_versions', columnName: 'process_definition_id' },
  { tableName: 'process_nodes', columnName: 'process_version_id' },
  { tableName: 'tasks', columnName: 'process_node_id' },
  { tableName: 'task_dependencies', columnName: 'predecessor_task_id' },
  { tableName: 'deliverables', columnName: 'task_id' },
  { tableName: 'acceptances', columnName: 'deliverable_id' },
  { tableName: 'evidence', columnName: 'content_hash' },
  { tableName: 'metric_observations', columnName: 'metric_definition_id' },
  { tableName: 'evidence_links', columnName: 'evidence_id' },
  {
    tableName: 'metric_observation_evidence',
    columnName: 'metric_observation_id',
  },
  { tableName: 'deliverable_evidence', columnName: 'deliverable_id' },
  { tableName: 'acceptance_evidence', columnName: 'acceptance_id' },
  { tableName: 'marketing_observations', columnName: 'assertion_type' },
  { tableName: 'marketing_insights', columnName: 'reviewed_by_user_id' },
  { tableName: 'marketing_targets', columnName: 'responsible_role_assignment_id' },
  { tableName: 'marketing_action_items', columnName: 'linked_task_id' },
] as const;

export const REQUIRED_TOOL_GATEWAY_TABLES = [
  'tool_definitions',
  'tool_versions',
  'tool_invocations',
  'tool_invocation_commands',
  'tool_execution_receipts',
  'tool_dns_resolution_proofs',
] as const;

export const REQUIRED_TOOL_GATEWAY_COLUMNS = [
  { tableName: 'tool_definitions', columnName: 'current_version_id' },
  { tableName: 'tool_versions', columnName: 'configuration_hash' },
  { tableName: 'tool_invocations', columnName: 'provider_dispatch_allowed' },
  { tableName: 'tool_invocation_commands', columnName: 'request_hash' },
  { tableName: 'tool_execution_receipts', columnName: 'receipt_hash' },
  { tableName: 'tool_dns_resolution_proofs', columnName: 'pinned_ip_address' },
] as const;

export const REQUIRED_AI_EVALUATION_TABLES = [
  'ai_evaluation_datasets',
  'ai_evaluation_dataset_versions',
  'ai_evaluation_thresholds',
  'ai_evaluation_cases',
  'ai_evaluation_case_evidence',
  'ai_evaluation_annotations',
  'ai_evaluation_annotation_evidence',
  'ai_evaluation_review_evidence',
  'ai_evaluation_runners',
  'ai_evaluation_runs',
  'ai_evaluation_case_results',
  'ai_evaluation_case_result_evidence',
  'ai_evaluation_metric_results',
  'ai_evaluation_metric_result_evidence',
  'ai_evaluation_verification_evidence',
  'ai_evaluation_bad_cases',
  'ai_evaluation_bad_case_evidence',
  'ai_evaluation_answer_feedback_sources',
  'ai_evaluation_release_checks',
] as const;

export const REQUIRED_AI_EVALUATION_COLUMNS = [
  { tableName: 'ai_evaluation_dataset_versions', columnName: 'content_hash' },
  { tableName: 'ai_evaluation_runners', columnName: 'attestation_key_fingerprint' },
  { tableName: 'ai_evaluation_runs', columnName: 'runner_id' },
  { tableName: 'ai_evaluation_runs', columnName: 'result_submitted_by_runner_id' },
  { tableName: 'ai_evaluation_case_results', columnName: 'run_id' },
  { tableName: 'ai_evaluation_metric_results', columnName: 'run_id' },
  {
    tableName: 'ai_evaluation_answer_feedback_sources',
    columnName: 'source_snapshot_hash',
  },
] as const;

export const REQUIRED_AI_EVALUATION_TRIGGERS = [
  'ai_evaluation_dataset_versions_mutation_guard',
  'ai_evaluation_dataset_seal_trigger',
  'ai_evaluation_runs_mutation_guard',
  'ai_evaluation_runs_results_trigger',
  'ai_evaluation_case_results_insert_guard',
  'ai_evaluation_metric_results_insert_guard',
  'ai_evaluation_release_checks_append_only',
  'ai_evaluation_answer_feedback_sources_append_only',
  'ai_evaluation_answer_feedback_pair_required',
] as const;

export const REQUIRED_AI_EVALUATION_RUNNER_POLICIES = [
  'ai_evaluation_runner_registry_read',
  'ai_evaluation_runner_dataset_read',
  'ai_evaluation_runner_threshold_read',
  'ai_evaluation_runner_case_read',
  'ai_evaluation_runner_run_access',
  'ai_evaluation_runner_case_result_access',
  'ai_evaluation_runner_metric_result_access',
  'ai_evaluation_runner_case_result_evidence_access',
  'ai_evaluation_runner_metric_evidence_access',
] as const;

export const REQUIRED_BUSINESS_SEMANTIC_TABLES = [
  'value_definitions',
  'value_versions',
  'value_metrics',
  'value_constraints',
  'strategies',
  'strategy_value_versions',
  'objectives',
  'objective_value_versions',
  'objective_role_assignments',
  'objective_relations',
  'metric_definitions',
  'objective_metric_definitions',
  'process_definitions',
  'process_versions',
  'process_nodes',
  'tasks',
  'task_dependencies',
  'deliverables',
  'acceptances',
  'evidence',
  'metric_observations',
  'evidence_links',
  'metric_observation_evidence',
  'deliverable_evidence',
  'acceptance_evidence',
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
  'marketing_action_item_dependencies',
] as const;

export const REQUIRED_BUSINESS_SEMANTIC_CONSTRAINTS = [
  'tasks_objective_value_fkey',
  'tasks_process_definition_fkey',
  'tasks_process_version_fkey',
  'tasks_process_node_fkey',
  'agent_runs_tenant_task_id_fkey',
  'marketing_targets_objective_value_fkey',
  'marketing_targets_objective_role_fkey',
  'marketing_targets_objective_metric_fkey',
  'marketing_action_items_task_fkey',
] as const;

export const REQUIRED_BUSINESS_SEMANTIC_TRIGGERS = [
  'tasks_reference_eligibility_trigger',
  'tasks_completion_integrity_trigger',
  'deliverables_task_completion_reverse_trigger',
  'deliverable_evidence_task_completion_reverse_trigger',
  'acceptances_task_completion_reverse_trigger',
  'acceptance_evidence_task_completion_reverse_trigger',
  'process_definitions_active_current_version_trigger',
  'process_versions_active_definition_reverse_trigger',
  'objectives_parent_cycle_trigger',
  'task_dependencies_cycle_trigger',
  'agent_runs_task_id_immutability_trigger',
  'marketing_observation_evidence_snapshot_trigger',
  'marketing_insights_state_trigger',
  'marketing_products_governance_trigger',
  'marketing_regions_governance_trigger',
  'marketing_customer_segments_governance_trigger',
  'marketing_targets_activation_trigger',
  'marketing_targets_state_trigger',
  'marketing_action_plans_state_trigger',
  'marketing_action_items_state_trigger',
  'marketing_action_dependencies_cycle_trigger',
] as const;

export const REQUIRED_BUSINESS_SEMANTIC_INDEXES = [
  'process_versions_one_published_per_definition_idx',
  'tasks_process_idx',
  'agent_runs_tenant_task_id_idx',
  'marketing_targets_matrix_idx',
  'marketing_action_items_plan_idx',
  'marketing_action_item_dependencies_successor_idx',
] as const;

export const REQUIRED_PROCESS_RUNTIME_TABLES = [
  'process_edges',
  'process_instances',
  'process_step_instances',
  'process_commands',
  'process_step_commands',
] as const;

export const REQUIRED_PROCESS_RUNTIME_COLUMNS = [
  { tableName: 'process_edges', columnName: 'condition' },
  { tableName: 'process_instances', columnName: 'task_id' },
  { tableName: 'process_step_instances', columnName: 'assignment_snapshot' },
  { tableName: 'process_commands', columnName: 'actor_role_assignment_id' },
  { tableName: 'process_step_commands', columnName: 'result_revision' },
] as const;

export const REQUIRED_PROCESS_RUNTIME_TRIGGERS = [
  'tasks_immutability_trigger',
  'process_instances_task_link_trigger',
  'tasks_process_runtime_terminal_trigger',
  'process_edges_parent_guard_trigger',
  'process_versions_graph_publication_trigger',
  'process_instances_insert_trigger',
  'process_instances_transition_trigger',
  'process_step_instances_insert_trigger',
  'process_step_instances_transition_trigger',
  'process_commands_actor_trigger',
  'process_step_commands_actor_trigger',
  'process_commands_append_only_trigger',
  'process_step_commands_append_only_trigger',
  'process_commands_revision_trigger',
  'process_step_commands_revision_trigger',
  'process_instances_command_coverage_trigger',
  'process_step_instances_command_coverage_trigger',
  'process_step_task_lifecycle_insert_trigger',
  'process_step_task_lifecycle_transition_trigger',
] as const;

export const REQUIRED_OUTBOX_DELIVERY_TABLES = [
  'outbox_event_routes',
  'outbox_event_route_prefixes',
  'outbox_event_deliveries',
] as const;

export const REQUIRED_OUTBOX_DELIVERY_TRIGGERS = [
  'outbox_events_delivery_routing_trigger',
] as const;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.enabled = config.get('REPOSITORY_DRIVER', { infer: true }) === 'prisma';
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.$disconnect();
  }

  async withTenant<T>(
    tenantId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) {
      throw new Error('Prisma repository access is disabled for the current adapter.');
    }

    return this.$transaction(async (transaction) => {
      // A superuser/migration login can bypass RLS. Every application query is
      // deliberately demoted to the fixed NOLOGIN/NOBYPASSRLS role first.
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return operation(transaction);
    });
  }

  async ping(): Promise<void> {
    if (!this.enabled) return;

    await this.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE enterprise_agent_app');
      const requiredSchemaColumns = Prisma.join(
        REQUIRED_APPLICATION_SCHEMA_COLUMNS.map(
          ({ tableName, columnName }) => Prisma.sql`(${tableName}, ${columnName})`,
        ),
      );
      const requiredSemanticTables = Prisma.join(
        REQUIRED_BUSINESS_SEMANTIC_TABLES.map((tableName) => Prisma.sql`(${tableName})`),
      );
      const requiredSemanticConstraints = Prisma.join(
        REQUIRED_BUSINESS_SEMANTIC_CONSTRAINTS.map(
          (constraintName) => Prisma.sql`(${constraintName})`,
        ),
      );
      const requiredSemanticTriggers = Prisma.join(
        REQUIRED_BUSINESS_SEMANTIC_TRIGGERS.map((triggerName) => Prisma.sql`(${triggerName})`),
      );
      const requiredSemanticIndexes = Prisma.join(
        REQUIRED_BUSINESS_SEMANTIC_INDEXES.map((indexName) => Prisma.sql`(${indexName})`),
      );
      const requiredProcessRuntimeTables = Prisma.join(
        REQUIRED_PROCESS_RUNTIME_TABLES.map((tableName) => Prisma.sql`(${tableName})`),
      );
      const requiredProcessRuntimeColumns = Prisma.join(
        REQUIRED_PROCESS_RUNTIME_COLUMNS.map(
          ({ tableName, columnName }) => Prisma.sql`(${tableName}, ${columnName})`,
        ),
      );
      const requiredProcessRuntimeTriggers = Prisma.join(
        REQUIRED_PROCESS_RUNTIME_TRIGGERS.map((triggerName) => Prisma.sql`(${triggerName})`),
      );
      const requiredOutboxDeliveryTables = Prisma.join(
        REQUIRED_OUTBOX_DELIVERY_TABLES.map((tableName) => Prisma.sql`(${tableName})`),
      );
      const requiredOutboxDeliveryTriggers = Prisma.join(
        REQUIRED_OUTBOX_DELIVERY_TRIGGERS.map((triggerName) => Prisma.sql`(${triggerName})`),
      );
      const requiredToolGatewayTables = Prisma.join(
        REQUIRED_TOOL_GATEWAY_TABLES.map((tableName) => Prisma.sql`(${tableName})`),
      );
      const requiredToolGatewayColumns = Prisma.join(
        REQUIRED_TOOL_GATEWAY_COLUMNS.map(
          ({ tableName, columnName }) => Prisma.sql`(${tableName}, ${columnName})`,
        ),
      );
      const requiredAiEvaluationTables = Prisma.join(
        REQUIRED_AI_EVALUATION_TABLES.map((tableName) => Prisma.sql`(${tableName})`),
      );
      const requiredAiEvaluationColumns = Prisma.join(
        REQUIRED_AI_EVALUATION_COLUMNS.map(
          ({ tableName, columnName }) => Prisma.sql`(${tableName}, ${columnName})`,
        ),
      );
      const requiredAiEvaluationTriggers = Prisma.join(
        REQUIRED_AI_EVALUATION_TRIGGERS.map((triggerName) => Prisma.sql`(${triggerName})`),
      );
      const requiredAiEvaluationRunnerPolicies = Prisma.join(
        REQUIRED_AI_EVALUATION_RUNNER_POLICIES.map((policyName) => Prisma.sql`(${policyName})`),
      );
      const [state] = await transaction.$queryRaw<
        Array<{
          role: string;
          table_count: number;
          forced_rls_count: number;
          policy_count: number;
          missing_schema_columns: string[];
          semantic_table_count: number;
          semantic_forced_rls_count: number;
          semantic_policy_count: number;
          semantic_acl_count: number;
          missing_semantic_constraints: string[];
          missing_semantic_triggers: string[];
          missing_semantic_indexes: string[];
          process_runtime_table_count: number;
          process_runtime_forced_rls_count: number;
          process_runtime_policy_count: number;
          process_runtime_role_count: number;
          process_runtime_acl_ready: boolean;
          process_assignment_helper_ready: boolean;
          missing_process_runtime_columns: string[];
          missing_process_runtime_triggers: string[];
          outbox_delivery_table_count: number;
          outbox_delivery_forced_rls_count: number;
          outbox_delivery_policy_count: number;
          outbox_delivery_acl_ready: boolean;
          outbox_event_immutable_acl_ready: boolean;
          missing_outbox_delivery_triggers: string[];
          tool_gateway_table_count: number;
          tool_gateway_forced_rls_count: number;
          tool_gateway_policy_count: number;
          tool_gateway_role_count: number;
          missing_tool_gateway_columns: string[];
          ai_evaluation_table_count: number;
          ai_evaluation_forced_rls_count: number;
          ai_evaluation_base_policy_count: number;
          ai_evaluation_runner_policy_count: number;
          ai_evaluation_runner_boundary_count: number;
          ai_evaluation_role_count: number;
          ai_evaluation_acl_ready: boolean;
          missing_ai_evaluation_columns: string[];
          missing_ai_evaluation_triggers: string[];
        }>
      >`
        SELECT
          current_user::text AS role,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('users', 'conversations', 'messages')
          ) AS table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('users', 'conversations', 'messages')
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename IN ('users', 'conversations', 'messages')
              AND policyname = 'tenant_isolation'
          ) AS policy_count,
          ARRAY(
            SELECT required.table_name || '.' || required.column_name
            FROM (
              VALUES ${requiredSchemaColumns}
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid
              WHERE n.nspname = 'public'
                AND c.relname = required.table_name
                AND c.relkind IN ('r', 'p')
                AND a.attname = required.column_name
                AND a.attnum > 0
                AND NOT a.attisdropped
            )
            ORDER BY required.table_name, required.column_name
          ) AS missing_schema_columns,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN (
              VALUES ${requiredSemanticTables}
            ) AS required(table_name) ON required.table_name = c.relname
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
          ) AS semantic_table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN (
              VALUES ${requiredSemanticTables}
            ) AS required(table_name) ON required.table_name = c.relname
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS semantic_forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies p
            JOIN (
              VALUES ${requiredSemanticTables}
            ) AS required(table_name) ON required.table_name = p.tablename
            WHERE p.schemaname = 'public'
              AND (
                (
                  p.policyname = 'tenant_isolation'
                  AND p.permissive = 'RESTRICTIVE'
                  AND p.cmd = 'ALL'
                  AND p.roles = ARRAY['public']::name[]
                )
                OR (
                  p.policyname = 'enterprise_agent_access'
                  AND p.permissive = 'PERMISSIVE'
                  AND p.cmd = 'SELECT'
                  AND p.roles = ARRAY['enterprise_agent_app']::name[]
                )
                OR (
                  p.policyname = 'enterprise_agent_admin_access'
                  AND p.permissive = 'PERMISSIVE'
                  AND p.cmd = 'ALL'
                  AND p.roles = ARRAY['enterprise_agent_admin']::name[]
                )
              )
          ) AS semantic_policy_count,
          (
            SELECT count(*)::int
            FROM (
              VALUES ${requiredSemanticTables}
            ) AS required(table_name)
            WHERE has_table_privilege(
              'enterprise_agent_app',
              format('public.%I', required.table_name),
              'SELECT'
            )
              AND NOT has_table_privilege(
                'enterprise_agent_app',
                format('public.%I', required.table_name),
                'INSERT'
              )
              AND NOT has_table_privilege(
                'enterprise_agent_app',
                format('public.%I', required.table_name),
                'UPDATE'
              )
              AND NOT has_table_privilege(
                'enterprise_agent_app',
                format('public.%I', required.table_name),
                'DELETE'
              )
              AND has_table_privilege(
                'enterprise_agent_admin',
                format('public.%I', required.table_name),
                'SELECT'
              )
              AND has_table_privilege(
                'enterprise_agent_admin',
                format('public.%I', required.table_name),
                'INSERT'
              )
              AND (
                (
                  left(required.table_name, 10) = 'marketing_'
                  AND NOT has_table_privilege(
                    'enterprise_agent_admin',
                    format('public.%I', required.table_name),
                    'DELETE'
                  )
                  AND (
                    (
                      required.table_name IN (
                        'marketing_observations',
                        'marketing_observation_evidence',
                        'marketing_insight_observations',
                        'marketing_action_item_contributors',
                        'marketing_action_item_dependencies'
                      )
                      AND NOT has_table_privilege(
                        'enterprise_agent_admin',
                        format('public.%I', required.table_name),
                        'UPDATE'
                      )
                    )
                    OR (
                      required.table_name NOT IN (
                        'marketing_observations',
                        'marketing_observation_evidence',
                        'marketing_insight_observations',
                        'marketing_action_item_contributors',
                        'marketing_action_item_dependencies'
                      )
                      AND has_table_privilege(
                        'enterprise_agent_admin',
                        format('public.%I', required.table_name),
                        'UPDATE'
                      )
                    )
                  )
                )
                OR (
                  left(required.table_name, 10) <> 'marketing_'
                  AND has_table_privilege(
                    'enterprise_agent_admin',
                    format('public.%I', required.table_name),
                    'UPDATE'
                  )
                  AND has_table_privilege(
                    'enterprise_agent_admin',
                    format('public.%I', required.table_name),
                    'DELETE'
                  )
                )
              )
          ) AS semantic_acl_count,
          ARRAY(
            SELECT required.constraint_name
            FROM (
              VALUES ${requiredSemanticConstraints}
            ) AS required(constraint_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_namespace n ON n.oid = c.connamespace
              WHERE n.nspname = 'public'
                AND c.conname = required.constraint_name
                AND c.contype = 'f'
                AND c.convalidated
            )
            ORDER BY required.constraint_name
          ) AS missing_semantic_constraints,
          ARRAY(
            SELECT required.trigger_name
            FROM (
              VALUES ${requiredSemanticTriggers}
            ) AS required(trigger_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND t.tgname = required.trigger_name
                AND NOT t.tgisinternal
                AND t.tgenabled <> 'D'
            )
            ORDER BY required.trigger_name
          ) AS missing_semantic_triggers,
          ARRAY(
            SELECT required.index_name
            FROM (
              VALUES ${requiredSemanticIndexes}
            ) AS required(index_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = required.index_name
                AND c.relkind = 'i'
            )
            ORDER BY required.index_name
          ) AS missing_semantic_indexes,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relname IN (${Prisma.join(REQUIRED_PROCESS_RUNTIME_TABLES)})
          ) AS process_runtime_table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relname IN (${Prisma.join(REQUIRED_PROCESS_RUNTIME_TABLES)})
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS process_runtime_forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename IN (${Prisma.join(REQUIRED_PROCESS_RUNTIME_TABLES)})
              AND policyname IN (
                'tenant_isolation',
                'enterprise_agent_access',
                'enterprise_agent_admin_access',
                'enterprise_agent_process_access'
              )
          ) AS process_runtime_policy_count,
          (
            SELECT count(*)::int
            FROM pg_roles
            WHERE rolname = 'enterprise_agent_process'
              AND NOT rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolinherit
              AND NOT rolreplication
              AND NOT rolbypassrls
          ) AS process_runtime_role_count,
          (
            (
              SELECT count(*)
              FROM (
                VALUES ${requiredProcessRuntimeTables}
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_app',
                format('public.%I', required.table_name),
                'SELECT'
              )
                AND NOT has_table_privilege(
                  'enterprise_agent_app',
                  format('public.%I', required.table_name),
                  'INSERT,UPDATE,DELETE'
                )
                AND has_table_privilege(
                  'enterprise_agent_process',
                  format('public.%I', required.table_name),
                  'SELECT'
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_process',
                  format('public.%I', required.table_name),
                  'DELETE'
                )
            ) = ${REQUIRED_PROCESS_RUNTIME_TABLES.length}
            AND (
              SELECT count(*)
              FROM (
                VALUES
                  ('process_instances'),
                  ('process_step_instances'),
                  ('process_commands'),
                  ('process_step_commands')
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_admin',
                format('public.%I', required.table_name),
                'SELECT'
              )
                AND NOT has_table_privilege(
                  'enterprise_agent_admin',
                  format('public.%I', required.table_name),
                  'INSERT,UPDATE,DELETE'
                )
            ) = 4
            AND has_table_privilege(
              'enterprise_agent_admin',
              'public.process_edges',
              'SELECT,INSERT,UPDATE,DELETE'
            )
            AND NOT has_table_privilege(
              'enterprise_agent_process',
              'public.process_edges',
              'INSERT,UPDATE'
            )
            AND (
              SELECT count(*)
              FROM (
                VALUES
                  ('process_instances'),
                  ('process_step_instances')
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_process',
                format('public.%I', required.table_name),
                'INSERT,UPDATE'
              )
            ) = 2
            AND (
              SELECT count(*)
              FROM (
                VALUES
                  ('process_commands'),
                  ('process_step_commands')
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_process',
                format('public.%I', required.table_name),
                'INSERT'
              )
                AND NOT has_table_privilege(
                  'enterprise_agent_process',
                  format('public.%I', required.table_name),
                  'UPDATE'
                )
            ) = 2
          ) AS process_runtime_acl_ready,
          (
            SELECT count(*) = 1
            FROM pg_proc procedure
            JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proname = 'build_process_step_assignment_snapshot'
              AND pg_get_function_identity_arguments(procedure.oid) =
                'p_tenant_id uuid, p_process_instance_id uuid, p_process_node_id uuid, p_role_assignment_id uuid, p_agent_id uuid, p_evaluated_at timestamp with time zone'
              AND NOT procedure.prosecdef
              AND NOT has_function_privilege(
                'public',
                procedure.oid,
                'EXECUTE'
              )
              AND has_function_privilege(
                'enterprise_agent_process',
                procedure.oid,
                'EXECUTE'
              )
          ) AS process_assignment_helper_ready,
          ARRAY(
            SELECT required.table_name || '.' || required.column_name
            FROM (
              VALUES ${requiredProcessRuntimeColumns}
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid
              WHERE n.nspname = 'public'
                AND c.relname = required.table_name
                AND c.relkind IN ('r', 'p')
                AND a.attname = required.column_name
                AND a.attnum > 0
                AND NOT a.attisdropped
            )
            ORDER BY required.table_name, required.column_name
          ) AS missing_process_runtime_columns,
          ARRAY(
            SELECT required.trigger_name
            FROM (
              VALUES ${requiredProcessRuntimeTriggers}
            ) AS required(trigger_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger trigger
              JOIN pg_class target ON target.oid = trigger.tgrelid
              JOIN pg_namespace namespace ON namespace.oid = target.relnamespace
              JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
              WHERE namespace.nspname = 'public'
                AND trigger.tgname = required.trigger_name
                AND NOT trigger.tgisinternal
                AND trigger.tgenabled <> 'D'
                AND procedure.prorettype = 'pg_catalog.trigger'::regtype
                AND pg_get_function_identity_arguments(procedure.oid) = ''
            )
            ORDER BY required.trigger_name
          ) AS missing_process_runtime_triggers,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relname IN (${Prisma.join(REQUIRED_OUTBOX_DELIVERY_TABLES)})
          ) AS outbox_delivery_table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'outbox_event_deliveries'
              AND c.relkind IN ('r', 'p')
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS outbox_delivery_forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'outbox_event_deliveries'
              AND policyname IN (
                'tenant_isolation',
                'enterprise_agent_access',
                'enterprise_agent_admin_access',
                'enterprise_agent_outbox_access'
              )
          ) AS outbox_delivery_policy_count,
          (
            SELECT count(*) = ${REQUIRED_OUTBOX_DELIVERY_TABLES.length}
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relname IN (${Prisma.join(REQUIRED_OUTBOX_DELIVERY_TABLES)})
              AND has_table_privilege('enterprise_agent_app', c.oid, 'SELECT')
              AND NOT has_table_privilege(
                'enterprise_agent_app',
                c.oid,
                'INSERT,UPDATE,DELETE'
              )
              AND has_table_privilege('enterprise_agent_admin', c.oid, 'SELECT')
              AND NOT has_table_privilege(
                'enterprise_agent_admin',
                c.oid,
                'INSERT,UPDATE,DELETE'
              )
              AND has_table_privilege('enterprise_agent_outbox', c.oid, 'SELECT')
              AND NOT has_table_privilege(
                'enterprise_agent_outbox',
                c.oid,
                'INSERT,DELETE'
              )
              AND (
                c.relname = 'outbox_event_deliveries'
                OR NOT has_any_column_privilege(
                  'enterprise_agent_outbox',
                  c.oid,
                  'UPDATE'
                )
              )
              AND (
                c.relname <> 'outbox_event_deliveries'
                OR has_any_column_privilege(
                  'enterprise_agent_outbox',
                  c.oid,
                  'UPDATE'
                )
              )
          ) AS outbox_delivery_acl_ready,
          (
            SELECT NOT has_any_column_privilege(
              'enterprise_agent_outbox',
              c.oid,
              'UPDATE'
            )
              AND NOT has_any_column_privilege(
                'enterprise_agent_admin',
                c.oid,
                'UPDATE'
              )
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'outbox_events'
              AND c.relkind IN ('r', 'p')
          ) AS outbox_event_immutable_acl_ready,
          ARRAY(
            SELECT required.trigger_name
            FROM (
              VALUES ${requiredOutboxDeliveryTriggers}
            ) AS required(trigger_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger trigger
              JOIN pg_class target ON target.oid = trigger.tgrelid
              JOIN pg_namespace namespace ON namespace.oid = target.relnamespace
              JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
              WHERE namespace.nspname = 'public'
                AND target.relname = 'outbox_events'
                AND trigger.tgname = required.trigger_name
                AND NOT trigger.tgisinternal
                AND trigger.tgenabled <> 'D'
                AND procedure.prorettype = 'pg_catalog.trigger'::regtype
                AND pg_get_function_identity_arguments(procedure.oid) = ''
            )
            ORDER BY required.trigger_name
          ) AS missing_outbox_delivery_triggers,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN (
              VALUES ${requiredToolGatewayTables}
            ) AS required(table_name) ON required.table_name = c.relname
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
          ) AS tool_gateway_table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN (
              VALUES ${requiredToolGatewayTables}
            ) AS required(table_name) ON required.table_name = c.relname
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS tool_gateway_forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies p
            JOIN (
              VALUES ${requiredToolGatewayTables}
            ) AS required(table_name) ON required.table_name = p.tablename
            WHERE p.schemaname = 'public'
              AND p.policyname IN (
                'tool_tenant_isolation',
                'tool_admin_access',
                'tool_gateway_access'
              )
          ) AS tool_gateway_policy_count,
          (
            SELECT count(*)::int
            FROM pg_roles
            WHERE rolname = 'enterprise_agent_tool_gateway'
              AND NOT rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolinherit
              AND NOT rolbypassrls
          ) AS tool_gateway_role_count,
          ARRAY(
            SELECT required.table_name || '.' || required.column_name
            FROM (
              VALUES ${requiredToolGatewayColumns}
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid
              WHERE n.nspname = 'public'
                AND c.relname = required.table_name
                AND c.relkind IN ('r', 'p')
                AND a.attname = required.column_name
                AND a.attnum > 0
                AND NOT a.attisdropped
            )
            ORDER BY required.table_name, required.column_name
          ) AS missing_tool_gateway_columns,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN (
              VALUES ${requiredAiEvaluationTables}
            ) AS required(table_name) ON required.table_name = c.relname
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
          ) AS ai_evaluation_table_count,
          (
            SELECT count(*)::int
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN (
              VALUES ${requiredAiEvaluationTables}
            ) AS required(table_name) ON required.table_name = c.relname
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relrowsecurity
              AND c.relforcerowsecurity
          ) AS ai_evaluation_forced_rls_count,
          (
            SELECT count(*)::int
            FROM pg_policies p
            JOIN (
              VALUES ${requiredAiEvaluationTables}
            ) AS required(table_name) ON required.table_name = p.tablename
            WHERE p.schemaname = 'public'
              AND p.policyname IN (
                'ai_evaluation_tenant_isolation',
                'ai_evaluation_admin_access'
              )
          ) AS ai_evaluation_base_policy_count,
          (
            SELECT count(*)::int
            FROM pg_policies p
            JOIN (
              VALUES ${requiredAiEvaluationRunnerPolicies}
            ) AS required(policy_name) ON required.policy_name = p.policyname
            WHERE p.schemaname = 'public'
              AND p.roles = ARRAY['enterprise_agent_evaluation_runner']::name[]
          ) AS ai_evaluation_runner_policy_count,
          (
            SELECT count(*)::int
            FROM pg_policy p
            JOIN pg_class c ON c.oid = p.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND p.polname IN (
                'ai_evaluation_runner_run_access',
                'ai_evaluation_runner_case_result_access',
                'ai_evaluation_runner_metric_result_access',
                'ai_evaluation_runner_case_result_evidence_access',
                'ai_evaluation_runner_metric_evidence_access'
              )
              AND (
                COALESCE(pg_get_expr(p.polqual, p.polrelid), '')
                || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '')
              ) LIKE '%app.evaluation_runner_id%'
              AND (
                p.polname <> 'ai_evaluation_runner_run_access'
                OR pg_get_expr(p.polwithcheck, p.polrelid)
                  LIKE '%result_submitted_by_runner_id%runner_id%'
              )
          ) AS ai_evaluation_runner_boundary_count,
          (
            SELECT count(*)::int
            FROM pg_roles
            WHERE rolname = 'enterprise_agent_evaluation_runner'
              AND NOT rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolinherit
              AND NOT rolreplication
              AND NOT rolbypassrls
          ) AS ai_evaluation_role_count,
          (
            (
              SELECT count(*)
              FROM (
                VALUES ${requiredAiEvaluationTables}
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_admin',
                format('public.%I', required.table_name),
                'SELECT'
              )
                AND (
                  (
                    required.table_name = 'ai_evaluation_answer_feedback_sources'
                    AND NOT has_table_privilege(
                      'enterprise_agent_admin',
                      format('public.%I', required.table_name),
                      'INSERT'
                    )
                    AND NOT has_table_privilege(
                      'enterprise_agent_admin',
                      format('public.%I', required.table_name),
                      'UPDATE'
                    )
                  )
                  OR (
                    required.table_name <> 'ai_evaluation_answer_feedback_sources'
                    AND has_table_privilege(
                      'enterprise_agent_admin',
                      format('public.%I', required.table_name),
                      'INSERT'
                    )
                    AND has_table_privilege(
                      'enterprise_agent_admin',
                      format('public.%I', required.table_name),
                      'UPDATE'
                    )
                  )
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_admin',
                  format('public.%I', required.table_name),
                  'DELETE'
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_app',
                  format('public.%I', required.table_name),
                  'SELECT'
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_app',
                  format('public.%I', required.table_name),
                  'INSERT'
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_app',
                  format('public.%I', required.table_name),
                  'UPDATE'
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_app',
                  format('public.%I', required.table_name),
                  'DELETE'
                )
            ) = ${REQUIRED_AI_EVALUATION_TABLES.length}
            AND (
              SELECT count(*)
              FROM (
                VALUES
                  ('ai_evaluation_runners'),
                  ('ai_evaluation_dataset_versions'),
                  ('ai_evaluation_thresholds'),
                  ('ai_evaluation_cases')
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_evaluation_runner',
                format('public.%I', required.table_name),
                'SELECT'
              )
                AND NOT has_table_privilege(
                  'enterprise_agent_evaluation_runner',
                  format('public.%I', required.table_name),
                  'INSERT,UPDATE,DELETE'
                )
            ) = 4
            AND has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.ai_evaluation_runs',
              'SELECT'
            )
            AND has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.ai_evaluation_runs',
              'UPDATE'
            )
            AND NOT has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.ai_evaluation_runs',
              'INSERT,DELETE'
            )
            AND (
              SELECT count(*)
              FROM (
                VALUES
                  ('ai_evaluation_case_results'),
                  ('ai_evaluation_metric_results'),
                  ('ai_evaluation_case_result_evidence'),
                  ('ai_evaluation_metric_result_evidence')
              ) AS required(table_name)
              WHERE has_table_privilege(
                'enterprise_agent_evaluation_runner',
                format('public.%I', required.table_name),
                'SELECT'
              )
                AND has_table_privilege(
                  'enterprise_agent_evaluation_runner',
                  format('public.%I', required.table_name),
                  'INSERT'
                )
                AND NOT has_table_privilege(
                  'enterprise_agent_evaluation_runner',
                  format('public.%I', required.table_name),
                  'UPDATE,DELETE'
                )
            ) = 4
            AND has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.audit_events',
              'INSERT'
            )
            AND has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.outbox_events',
              'INSERT'
            )
            AND NOT has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.audit_events',
              'SELECT,UPDATE,DELETE'
            )
            AND NOT has_table_privilege(
              'enterprise_agent_evaluation_runner',
              'public.outbox_events',
              'SELECT,UPDATE,DELETE'
            )
          ) AS ai_evaluation_acl_ready,
          ARRAY(
            SELECT required.table_name || '.' || required.column_name
            FROM (
              VALUES ${requiredAiEvaluationColumns}
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid
              WHERE n.nspname = 'public'
                AND c.relname = required.table_name
                AND c.relkind IN ('r', 'p')
                AND a.attname = required.column_name
                AND a.attnum > 0
                AND NOT a.attisdropped
            )
            ORDER BY required.table_name, required.column_name
          ) AS missing_ai_evaluation_columns,
          ARRAY(
            SELECT required.trigger_name
            FROM (
              VALUES ${requiredAiEvaluationTriggers}
            ) AS required(trigger_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND t.tgname = required.trigger_name
                AND NOT t.tgisinternal
                AND t.tgenabled <> 'D'
            )
            ORDER BY required.trigger_name
          ) AS missing_ai_evaluation_triggers
      `;

      if (
        state?.role !== 'enterprise_agent_app' ||
        state.table_count !== 3 ||
        state.forced_rls_count !== 3 ||
        state.policy_count !== 3 ||
        state.missing_schema_columns.length !== 0 ||
        state.semantic_table_count !== REQUIRED_BUSINESS_SEMANTIC_TABLES.length ||
        state.semantic_forced_rls_count !== REQUIRED_BUSINESS_SEMANTIC_TABLES.length ||
        state.semantic_policy_count !== REQUIRED_BUSINESS_SEMANTIC_TABLES.length * 3 ||
        state.semantic_acl_count !== REQUIRED_BUSINESS_SEMANTIC_TABLES.length ||
        state.missing_semantic_constraints.length !== 0 ||
        state.missing_semantic_triggers.length !== 0 ||
        state.missing_semantic_indexes.length !== 0 ||
        state.process_runtime_table_count !== REQUIRED_PROCESS_RUNTIME_TABLES.length ||
        state.process_runtime_forced_rls_count !== REQUIRED_PROCESS_RUNTIME_TABLES.length ||
        state.process_runtime_policy_count !== REQUIRED_PROCESS_RUNTIME_TABLES.length * 4 ||
        state.process_runtime_role_count !== 1 ||
        !state.process_runtime_acl_ready ||
        !state.process_assignment_helper_ready ||
        state.missing_process_runtime_columns.length !== 0 ||
        state.missing_process_runtime_triggers.length !== 0 ||
        state.outbox_delivery_table_count !== REQUIRED_OUTBOX_DELIVERY_TABLES.length ||
        state.outbox_delivery_forced_rls_count !== 1 ||
        state.outbox_delivery_policy_count !== 4 ||
        !state.outbox_delivery_acl_ready ||
        !state.outbox_event_immutable_acl_ready ||
        state.missing_outbox_delivery_triggers.length !== 0 ||
        state.tool_gateway_table_count !== REQUIRED_TOOL_GATEWAY_TABLES.length ||
        state.tool_gateway_forced_rls_count !== REQUIRED_TOOL_GATEWAY_TABLES.length ||
        state.tool_gateway_policy_count !== REQUIRED_TOOL_GATEWAY_TABLES.length * 3 ||
        state.tool_gateway_role_count !== 1 ||
        state.missing_tool_gateway_columns.length !== 0 ||
        state.ai_evaluation_table_count !== REQUIRED_AI_EVALUATION_TABLES.length ||
        state.ai_evaluation_forced_rls_count !== REQUIRED_AI_EVALUATION_TABLES.length ||
        state.ai_evaluation_base_policy_count !== REQUIRED_AI_EVALUATION_TABLES.length * 2 ||
        state.ai_evaluation_runner_policy_count !== REQUIRED_AI_EVALUATION_RUNNER_POLICIES.length ||
        state.ai_evaluation_runner_boundary_count !== 5 ||
        state.ai_evaluation_role_count !== 1 ||
        !state.ai_evaluation_acl_ready ||
        state.missing_ai_evaluation_columns.length !== 0 ||
        state.missing_ai_evaluation_triggers.length !== 0
      ) {
        throw new Error(
          'Database security or application schema baseline is incomplete. ' +
            'The migration set may be partially installed; stop this new API instance, ' +
            'restore the database from the latest verified backup or complete the pending ' +
            'forward migrations with `pnpm db:migrate`, then run the isolated database gate.',
        );
      }

      // No app.tenant_id is set in readiness. A protected query must therefore
      // succeed at the SQL level while returning no tenant rows.
      if ((await transaction.user.count()) !== 0) {
        throw new Error('Database tenant policy is not default-deny.');
      }
    });
  }
}
