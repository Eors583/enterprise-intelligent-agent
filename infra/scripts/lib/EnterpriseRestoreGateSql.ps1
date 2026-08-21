function Get-EnterpriseCriticalPrivilegesSql {
  @'
WITH expected_tables(table_name) AS (
  VALUES
    ('agent_runs'),
    ('ai_runtime_runs'),
    ('auth_action_tokens'),
    ('auth_recovery_deliveries'),
    ('auth_login_rate_limits'),
    ('business_event_deliveries'),
    ('business_event_effects'),
    ('business_event_evidence'),
    ('business_events'),
    ('collaboration_message_evidence'),
    ('collaboration_message_recipients'),
    ('collaboration_messages'),
    ('collaboration_participants'),
    ('collaborations'),
    ('correction_case_evidence'),
    ('correction_cases'),
    ('correction_feedback'),
    ('correction_feedback_evidence'),
    ('directory_sync_preview_items'),
    ('directory_sync_previews'),
    ('directory_sync_runs'),
    ('knowledge_entities'),
    ('knowledge_entity_mentions'),
    ('knowledge_relations'),
    ('knowledge_relation_evidence'),
    ('outbox_event_deliveries'),
    ('outbox_event_route_prefixes'),
    ('outbox_events'),
    ('process_commands'),
    ('process_edges'),
    ('process_instances'),
    ('process_step_commands'),
    ('process_step_instances'),
    ('role_assignments'),
    ('tool_reconciliation_attempts'),
    ('tool_reconciliation_receipts')
), actual_table_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    table_acl.privilege_type::text AS privilege_type,
    table_acl.is_grantable
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
  CROSS JOIN LATERAL aclexplode(
    COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
  ) table_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND table_acl.grantee <> target_table.relowner
), expected_table_acl(table_name, grantee, privilege_type, is_grantable) AS (
  VALUES
    ('agent_runs', 'enterprise_agent_app', 'SELECT', false),
    ('agent_runs', 'enterprise_agent_app', 'INSERT', false),
    ('agent_runs', 'enterprise_agent_app', 'UPDATE', false),
    ('agent_runs', 'enterprise_agent_admin', 'SELECT', false),
    ('agent_runs', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('agent_runs', 'enterprise_agent_employee_insights', 'SELECT', false),
    ('agent_runs', 'enterprise_agent_finops_projector', 'SELECT', false),
    ('ai_runtime_runs', 'enterprise_agent_runtime', 'SELECT', false),
    ('ai_runtime_runs', 'enterprise_agent_runtime', 'INSERT', false),
    ('ai_runtime_runs', 'enterprise_agent_runtime', 'UPDATE', false),
    ('ai_runtime_runs', 'enterprise_agent_admin', 'SELECT', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'SELECT', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'INSERT', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'UPDATE', false),
    ('auth_action_tokens', 'enterprise_agent_auth', 'DELETE', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'SELECT', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'INSERT', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'UPDATE', false),
    ('auth_action_tokens', 'enterprise_agent_admin', 'DELETE', false),
    ('auth_recovery_deliveries', 'enterprise_agent_auth', 'SELECT', false),
    ('auth_recovery_deliveries', 'enterprise_agent_auth', 'INSERT', false),
    ('auth_recovery_deliveries', 'enterprise_agent_auth', 'UPDATE', false),
    ('auth_recovery_deliveries', 'enterprise_agent_auth', 'DELETE', false),
    ('auth_recovery_deliveries', 'enterprise_agent_admin', 'SELECT', false),
    ('auth_recovery_deliveries', 'enterprise_agent_admin', 'INSERT', false),
    ('auth_recovery_deliveries', 'enterprise_agent_admin', 'UPDATE', false),
    ('auth_recovery_deliveries', 'enterprise_agent_admin', 'DELETE', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'SELECT', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'INSERT', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'UPDATE', false),
    ('auth_login_rate_limits', 'enterprise_agent_auth', 'DELETE', false),
    ('business_event_deliveries', 'enterprise_agent_app', 'SELECT', false),
    ('business_event_deliveries', 'enterprise_agent_admin', 'SELECT', false),
    ('business_event_deliveries', 'enterprise_agent_process', 'SELECT', false),
    ('business_event_deliveries', 'enterprise_agent_process', 'INSERT', false),
    ('business_event_deliveries', 'enterprise_agent_process', 'UPDATE', false),
    ('business_event_effects', 'enterprise_agent_app', 'SELECT', false),
    ('business_event_effects', 'enterprise_agent_admin', 'SELECT', false),
    ('business_event_effects', 'enterprise_agent_process', 'SELECT', false),
    ('business_event_effects', 'enterprise_agent_process', 'INSERT', false),
    ('business_event_effects', 'enterprise_agent_process', 'UPDATE', false),
    ('business_event_evidence', 'enterprise_agent_app', 'SELECT', false),
    ('business_event_evidence', 'enterprise_agent_admin', 'SELECT', false),
    ('business_event_evidence', 'enterprise_agent_process', 'SELECT', false),
    ('business_event_evidence', 'enterprise_agent_process', 'INSERT', false),
    ('business_events', 'enterprise_agent_app', 'SELECT', false),
    ('business_events', 'enterprise_agent_admin', 'SELECT', false),
    ('business_events', 'enterprise_agent_process', 'SELECT', false),
    ('business_events', 'enterprise_agent_process', 'INSERT', false),
    ('collaboration_message_evidence', 'enterprise_agent_app', 'SELECT', false),
    ('collaboration_message_evidence', 'enterprise_agent_admin', 'SELECT', false),
    ('collaboration_message_evidence', 'enterprise_agent_process', 'SELECT', false),
    ('collaboration_message_evidence', 'enterprise_agent_process', 'INSERT', false),
    ('collaboration_message_recipients', 'enterprise_agent_app', 'SELECT', false),
    ('collaboration_message_recipients', 'enterprise_agent_admin', 'SELECT', false),
    ('collaboration_message_recipients', 'enterprise_agent_process', 'SELECT', false),
    ('collaboration_message_recipients', 'enterprise_agent_process', 'INSERT', false),
    ('collaboration_messages', 'enterprise_agent_app', 'SELECT', false),
    ('collaboration_messages', 'enterprise_agent_admin', 'SELECT', false),
    ('collaboration_messages', 'enterprise_agent_process', 'SELECT', false),
    ('collaboration_messages', 'enterprise_agent_process', 'INSERT', false),
    ('collaboration_participants', 'enterprise_agent_app', 'SELECT', false),
    ('collaboration_participants', 'enterprise_agent_admin', 'SELECT', false),
    ('collaboration_participants', 'enterprise_agent_process', 'SELECT', false),
    ('collaboration_participants', 'enterprise_agent_process', 'INSERT', false),
    ('collaborations', 'enterprise_agent_app', 'SELECT', false),
    ('collaborations', 'enterprise_agent_admin', 'SELECT', false),
    ('collaborations', 'enterprise_agent_process', 'SELECT', false),
    ('collaborations', 'enterprise_agent_process', 'INSERT', false),
    ('collaborations', 'enterprise_agent_process', 'UPDATE', false),
    ('correction_case_evidence', 'enterprise_agent_app', 'SELECT', false),
    ('correction_case_evidence', 'enterprise_agent_admin', 'SELECT', false),
    ('correction_case_evidence', 'enterprise_agent_process', 'SELECT', false),
    ('correction_case_evidence', 'enterprise_agent_process', 'INSERT', false),
    ('correction_cases', 'enterprise_agent_app', 'SELECT', false),
    ('correction_cases', 'enterprise_agent_admin', 'SELECT', false),
    ('correction_cases', 'enterprise_agent_process', 'SELECT', false),
    ('correction_cases', 'enterprise_agent_process', 'INSERT', false),
    ('correction_cases', 'enterprise_agent_process', 'UPDATE', false),
    ('correction_feedback', 'enterprise_agent_app', 'SELECT', false),
    ('correction_feedback', 'enterprise_agent_admin', 'SELECT', false),
    ('correction_feedback', 'enterprise_agent_process', 'SELECT', false),
    ('correction_feedback', 'enterprise_agent_process', 'INSERT', false),
    ('correction_feedback_evidence', 'enterprise_agent_app', 'SELECT', false),
    ('correction_feedback_evidence', 'enterprise_agent_admin', 'SELECT', false),
    ('correction_feedback_evidence', 'enterprise_agent_process', 'SELECT', false),
    ('correction_feedback_evidence', 'enterprise_agent_process', 'INSERT', false),
    ('directory_sync_preview_items', 'enterprise_agent_admin', 'SELECT', false),
    ('directory_sync_preview_items', 'enterprise_agent_admin', 'INSERT', false),
    ('directory_sync_preview_items', 'enterprise_agent_admin', 'UPDATE', false),
    ('directory_sync_previews', 'enterprise_agent_admin', 'SELECT', false),
    ('directory_sync_previews', 'enterprise_agent_admin', 'INSERT', false),
    ('directory_sync_previews', 'enterprise_agent_admin', 'UPDATE', false),
    ('directory_sync_runs', 'enterprise_agent_admin', 'SELECT', false),
    ('directory_sync_runs', 'enterprise_agent_admin', 'INSERT', false),
    ('directory_sync_runs', 'enterprise_agent_admin', 'UPDATE', false),
    ('directory_sync_runs', 'enterprise_agent_outbox', 'SELECT', false),
    ('knowledge_entities', 'enterprise_agent_app', 'SELECT', false),
    ('knowledge_entities', 'enterprise_agent_admin', 'SELECT', false),
    ('knowledge_entities', 'enterprise_agent_admin', 'INSERT', false),
    ('knowledge_entities', 'enterprise_agent_admin', 'UPDATE', false),
    ('knowledge_entities', 'enterprise_agent_admin', 'DELETE', false),
    ('knowledge_entity_mentions', 'enterprise_agent_app', 'SELECT', false),
    ('knowledge_entity_mentions', 'enterprise_agent_admin', 'SELECT', false),
    ('knowledge_entity_mentions', 'enterprise_agent_admin', 'INSERT', false),
    ('knowledge_entity_mentions', 'enterprise_agent_admin', 'UPDATE', false),
    ('knowledge_entity_mentions', 'enterprise_agent_admin', 'DELETE', false),
    ('knowledge_relations', 'enterprise_agent_app', 'SELECT', false),
    ('knowledge_relations', 'enterprise_agent_admin', 'SELECT', false),
    ('knowledge_relations', 'enterprise_agent_admin', 'INSERT', false),
    ('knowledge_relations', 'enterprise_agent_admin', 'UPDATE', false),
    ('knowledge_relations', 'enterprise_agent_admin', 'DELETE', false),
    ('knowledge_relation_evidence', 'enterprise_agent_app', 'SELECT', false),
    ('knowledge_relation_evidence', 'enterprise_agent_admin', 'SELECT', false),
    ('knowledge_relation_evidence', 'enterprise_agent_admin', 'INSERT', false),
    ('knowledge_relation_evidence', 'enterprise_agent_admin', 'UPDATE', false),
    ('knowledge_relation_evidence', 'enterprise_agent_admin', 'DELETE', false),
    ('outbox_event_deliveries', 'enterprise_agent_app', 'SELECT', false),
    ('outbox_event_deliveries', 'enterprise_agent_admin', 'SELECT', false),
    ('outbox_event_deliveries', 'enterprise_agent_outbox', 'SELECT', false),
    ('outbox_event_route_prefixes', 'enterprise_agent_app', 'SELECT', false),
    ('outbox_event_route_prefixes', 'enterprise_agent_admin', 'SELECT', false),
    ('outbox_event_route_prefixes', 'enterprise_agent_outbox', 'SELECT', false),
    ('outbox_events', 'enterprise_agent_app', 'SELECT', false),
    ('outbox_events', 'enterprise_agent_app', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_admin', 'SELECT', false),
    ('outbox_events', 'enterprise_agent_admin', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_evaluation_runner', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_employee_insights', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_task_executor', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_finops_projector', 'INSERT', false),
    ('outbox_events', 'enterprise_agent_outbox', 'SELECT', false),
    ('outbox_events', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('outbox_events', 'enterprise_agent_tool_gateway', 'INSERT', false),
    ('process_commands', 'enterprise_agent_app', 'SELECT', false),
    ('process_commands', 'enterprise_agent_admin', 'SELECT', false),
    ('process_commands', 'enterprise_agent_process', 'SELECT', false),
    ('process_commands', 'enterprise_agent_process', 'INSERT', false),
    ('process_edges', 'enterprise_agent_app', 'SELECT', false),
    ('process_edges', 'enterprise_agent_admin', 'SELECT', false),
    ('process_edges', 'enterprise_agent_admin', 'INSERT', false),
    ('process_edges', 'enterprise_agent_admin', 'UPDATE', false),
    ('process_edges', 'enterprise_agent_admin', 'DELETE', false),
    ('process_edges', 'enterprise_agent_process', 'SELECT', false),
    ('process_instances', 'enterprise_agent_app', 'SELECT', false),
    ('process_instances', 'enterprise_agent_admin', 'SELECT', false),
    ('process_instances', 'enterprise_agent_process', 'SELECT', false),
    ('process_instances', 'enterprise_agent_process', 'INSERT', false),
    ('process_instances', 'enterprise_agent_process', 'UPDATE', false),
    ('process_instances', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('process_step_commands', 'enterprise_agent_app', 'SELECT', false),
    ('process_step_commands', 'enterprise_agent_admin', 'SELECT', false),
    ('process_step_commands', 'enterprise_agent_process', 'SELECT', false),
    ('process_step_commands', 'enterprise_agent_process', 'INSERT', false),
    ('process_step_instances', 'enterprise_agent_app', 'SELECT', false),
    ('process_step_instances', 'enterprise_agent_admin', 'SELECT', false),
    ('process_step_instances', 'enterprise_agent_process', 'SELECT', false),
    ('process_step_instances', 'enterprise_agent_process', 'INSERT', false),
    ('process_step_instances', 'enterprise_agent_process', 'UPDATE', false),
    ('process_step_instances', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('role_assignments', 'enterprise_agent_app', 'SELECT', false),
    ('role_assignments', 'enterprise_agent_admin', 'SELECT', false),
    ('role_assignments', 'enterprise_agent_admin', 'INSERT', false),
    ('role_assignments', 'enterprise_agent_admin', 'UPDATE', false),
    ('role_assignments', 'enterprise_agent_admin', 'DELETE', false),
    ('role_assignments', 'enterprise_agent_process', 'SELECT', false),
    ('role_assignments', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('role_assignments', 'enterprise_agent_employee_insights', 'SELECT', false),
    ('tool_reconciliation_attempts', 'enterprise_agent_app', 'SELECT', false),
    ('tool_reconciliation_attempts', 'enterprise_agent_admin', 'SELECT', false),
    ('tool_reconciliation_attempts', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('tool_reconciliation_attempts', 'enterprise_agent_tool_gateway', 'INSERT', false),
    ('tool_reconciliation_receipts', 'enterprise_agent_app', 'SELECT', false),
    ('tool_reconciliation_receipts', 'enterprise_agent_admin', 'SELECT', false),
    ('tool_reconciliation_receipts', 'enterprise_agent_tool_gateway', 'SELECT', false),
    ('tool_reconciliation_receipts', 'enterprise_agent_tool_gateway', 'INSERT', false)
), actual_column_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    attribute_definition.attname::text AS column_name,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    column_acl.privilege_type::text AS privilege_type,
    column_acl.is_grantable
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN pg_attribute attribute_definition ON attribute_definition.attrelid = target_table.oid
  CROSS JOIN LATERAL aclexplode(attribute_definition.attacl) column_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = column_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND target_table.relname IN (
      'agent_instances',
      'agent_runs',
      'agent_templates',
      'agent_versions',
      'audit_events',
      'auth_action_tokens',
      'auth_login_rate_limits',
      'employments',
      'knowledge_entities',
      'knowledge_entity_mentions',
      'knowledge_relations',
      'knowledge_relation_evidence',
      'directory_sync_runs',
      'outbox_event_deliveries',
      'outbox_events',
      'role_assignments',
      'tasks',
      'tenants',
      'users'
    )
    AND attribute_definition.attnum > 0
    AND NOT attribute_definition.attisdropped
), expected_column_acl(table_name, column_name, grantee, privilege_type, is_grantable) AS (
  VALUES
    ('agent_runs', 'status', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'error_code', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'error_message', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'finished_at', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'reserved_tokens', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'version', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'updated_at', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'cancellation_requested_at', 'enterprise_agent_admin', 'UPDATE', false),
    ('agent_runs', 'cancellation_reason', 'enterprise_agent_admin', 'UPDATE', false),
    ('employments', 'status', 'enterprise_agent_auth', 'UPDATE', false),
    ('employments', 'updated_at', 'enterprise_agent_auth', 'UPDATE', false),
    ('outbox_event_deliveries', 'status', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'attempts', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'available_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'locked_by', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'locked_until', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'last_error', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'provider_name', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'provider_receipt', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'first_attempted_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'acknowledged_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('outbox_event_deliveries', 'updated_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'status', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'attempts', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'lease_owner', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'lease_expires_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'started_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'finished_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('directory_sync_runs', 'updated_at', 'enterprise_agent_outbox', 'UPDATE', false),
    ('tenants', 'agent_run_monthly_token_limit', 'enterprise_agent_admin', 'UPDATE', false),
    ('tenants', 'agent_run_concurrency_limit', 'enterprise_agent_admin', 'UPDATE', false),
    ('tenants', 'agent_run_rate_limit_per_minute', 'enterprise_agent_admin', 'UPDATE', false),
    ('tenants', 'updated_at', 'enterprise_agent_admin', 'UPDATE', false),
    ('users', 'tenant_id', 'enterprise_agent_scim', 'SELECT', false),
    ('users', 'id', 'enterprise_agent_scim', 'SELECT', false),
    ('users', 'status', 'enterprise_agent_scim', 'SELECT', false),
    ('users', 'tenant_id', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'id', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'email', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'email_normalized', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'display_name', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'role', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'status', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'created_at', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'updated_at', 'enterprise_agent_scim', 'INSERT', false),
    ('users', 'email', 'enterprise_agent_scim', 'UPDATE', false),
    ('users', 'email_normalized', 'enterprise_agent_scim', 'UPDATE', false),
    ('users', 'display_name', 'enterprise_agent_scim', 'UPDATE', false),
    ('users', 'updated_at', 'enterprise_agent_scim', 'UPDATE', false),
    ('tenants', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('tenants', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('users', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('users', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('users', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('employments', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('employments', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('employments', 'user_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('employments', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_templates', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_templates', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_templates', 'mission', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'template_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'review_status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'created_by_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'review_requested_by_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'reviewed_by_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'approved_by_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'role_definition_snapshot', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_versions', 'blueprint_revision', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'user_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'employment_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'role_template_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'role_version_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'agent_instance_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'source', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'effective_from', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'effective_to', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'delegated_from_assignment_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'organization_scope', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'permission_scope', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'memory_policy', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'created_by_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'version', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'updated_at', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('role_assignments', 'status', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('role_assignments', 'revoked_at', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('role_assignments', 'revoked_by_id', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('role_assignments', 'revoke_reason', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('role_assignments', 'version', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('role_assignments', 'updated_at', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_instances', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_instances', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_instances', 'version_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_instances', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_instances', 'status', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_instances', 'updated_at', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'tenant_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'agent_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'requester_user_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'status', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'external_run_id', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'cancellation_requested_at', 'enterprise_agent_lifecycle', 'SELECT', false),
    ('agent_runs', 'status', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'version', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'error_code', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'error_message', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'finished_at', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'updated_at', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'reserved_tokens', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'cancellation_requested_at', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('agent_runs', 'cancellation_reason', 'enterprise_agent_lifecycle', 'UPDATE', false),
    ('outbox_events', 'tenant_id', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('outbox_events', 'aggregate_type', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('outbox_events', 'aggregate_id', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('outbox_events', 'event_type', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('outbox_events', 'payload', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'tenant_id', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'id', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'actor_type', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'actor_id', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'action', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'resource_type', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'resource_id', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'metadata', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('audit_events', 'occurred_at', 'enterprise_agent_lifecycle', 'INSERT', false),
    ('tasks', 'process_instance_id', 'enterprise_agent_process', 'UPDATE', false),
    ('users', 'tenant_id', 'enterprise_agent_process', 'SELECT', false),
    ('users', 'id', 'enterprise_agent_process', 'SELECT', false),
    ('users', 'display_name', 'enterprise_agent_process', 'SELECT', false),
    ('users', 'role', 'enterprise_agent_process', 'SELECT', false),
    ('users', 'status', 'enterprise_agent_process', 'SELECT', false),
    ('tasks', 'status', 'enterprise_agent_task_executor', 'UPDATE', false),
    ('tasks', 'ready_at', 'enterprise_agent_task_executor', 'UPDATE', false),
    ('tasks', 'started_at', 'enterprise_agent_task_executor', 'UPDATE', false),
    ('tasks', 'delivered_at', 'enterprise_agent_task_executor', 'UPDATE', false),
    ('tasks', 'revision', 'enterprise_agent_task_executor', 'UPDATE', false),
    ('tasks', 'updated_at', 'enterprise_agent_task_executor', 'UPDATE', false),
    ('outbox_events', 'tenant_id', 'enterprise_agent_process', 'INSERT', false),
    ('outbox_events', 'aggregate_type', 'enterprise_agent_process', 'INSERT', false),
    ('outbox_events', 'aggregate_id', 'enterprise_agent_process', 'INSERT', false),
    ('outbox_events', 'event_type', 'enterprise_agent_process', 'INSERT', false),
    ('outbox_events', 'payload', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'tenant_id', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'actor_type', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'actor_id', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'action', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'resource_type', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'resource_id', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'metadata', 'enterprise_agent_process', 'INSERT', false),
    ('audit_events', 'occurred_at', 'enterprise_agent_process', 'INSERT', false)
)
SELECT
  (SELECT count(*) FROM expected_tables) = 36
  AND (
    SELECT count(*)
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
    WHERE target_schema.nspname = 'public' AND target_table.relkind = 'r'
  ) = (SELECT count(*) FROM expected_tables)
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN (
    'enterprise_agent_app', 'enterprise_agent_auth', 'enterprise_agent_admin',
    'enterprise_agent_outbox', 'enterprise_agent_runtime', 'enterprise_agent_lifecycle',
    'enterprise_agent_process'
  )) = 7
  AND NOT EXISTS (
    SELECT * FROM actual_table_acl
    EXCEPT
    SELECT * FROM expected_table_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_table_acl
    EXCEPT
    SELECT * FROM actual_table_acl
  )
  AND NOT EXISTS (
    SELECT * FROM actual_column_acl
    EXCEPT
    SELECT * FROM expected_column_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_column_acl
    EXCEPT
    SELECT * FROM actual_column_acl
  );
'@
}

function Get-EnterpriseAuthActionTokenAclSql {
  @'
WITH target AS (
  SELECT target_table.oid, target_table.relowner, target_table.relacl
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public' AND target_table.relname = 'auth_action_tokens'
), actual_acl AS (
  SELECT acl.grantee, acl.privilege_type::text AS privilege_type, acl.is_grantable
  FROM target
  CROSS JOIN LATERAL aclexplode(COALESCE(target.relacl, acldefault('r', target.relowner))) acl
  WHERE acl.grantee <> target.relowner
), expected_acl AS (
  SELECT role_definition.oid AS grantee, expected_privilege.privilege_type, false AS is_grantable
  FROM pg_roles role_definition
  CROSS JOIN (VALUES ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text))
    expected_privilege(privilege_type)
  WHERE role_definition.rolname IN ('enterprise_agent_auth', 'enterprise_agent_admin')
)
SELECT
  (SELECT count(*) FROM target) = 1
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('enterprise_agent_auth', 'enterprise_agent_admin')) = 2
  AND NOT EXISTS (
    SELECT grantee, privilege_type, is_grantable FROM actual_acl
    EXCEPT
    SELECT grantee, privilege_type, is_grantable FROM expected_acl
  )
  AND NOT EXISTS (
    SELECT grantee, privilege_type, is_grantable FROM expected_acl
    EXCEPT
    SELECT grantee, privilege_type, is_grantable FROM actual_acl
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute_definition
    WHERE attribute_definition.attrelid = 'public.auth_action_tokens'::regclass
      AND attribute_definition.attnum > 0
      AND NOT attribute_definition.attisdropped
      AND COALESCE(cardinality(attribute_definition.attacl), 0) > 0
  );
'@
}

function Get-EnterpriseCapabilityRoleHardeningSql {
  @'
WITH capability_roles AS (
  SELECT * FROM pg_roles
  WHERE rolname IN (
    'enterprise_agent_app',
    'enterprise_agent_auth',
    'enterprise_agent_admin',
    'enterprise_agent_outbox',
    'enterprise_agent_runtime',
    'enterprise_agent_lifecycle',
    'enterprise_agent_scim',
    'enterprise_agent_process',
    'enterprise_agent_tool_gateway',
    'enterprise_agent_evaluation_runner',
    'enterprise_agent_provisioner',
    'enterprise_agent_employee_insights',
    'enterprise_agent_task_executor',
    'enterprise_agent_finops_projector'
  )
), inherited_worker_roles AS (
  SELECT * FROM pg_roles
  WHERE rolname = 'enterprise_agent_feedback_projector'
), actual_inherited_worker_memberships AS (
  SELECT
    granted_role.rolname::text AS granted_role,
    member_role.rolname::text AS member_role
  FROM pg_auth_members role_membership
  JOIN pg_roles granted_role ON granted_role.oid = role_membership.roleid
  JOIN pg_roles member_role ON member_role.oid = role_membership.member
  WHERE member_role.rolname = 'enterprise_agent_feedback_projector'
), expected_inherited_worker_memberships(granted_role, member_role) AS (
  VALUES
    ('enterprise_agent_app', 'enterprise_agent_feedback_projector')
)
SELECT
  (SELECT count(*) FROM capability_roles) = 14
  AND (SELECT bool_and(
    NOT rolsuper
    AND NOT rolinherit
    AND NOT rolcreaterole
    AND NOT rolcreatedb
    AND NOT rolcanlogin
    AND NOT rolreplication
    AND NOT rolbypassrls
  ) FROM capability_roles)
  AND (SELECT count(*) FROM inherited_worker_roles) = 1
  AND (SELECT bool_and(
    NOT rolsuper
    AND rolinherit
    AND NOT rolcreaterole
    AND NOT rolcreatedb
    AND NOT rolcanlogin
    AND NOT rolreplication
    AND NOT rolbypassrls
  ) FROM inherited_worker_roles)
  AND NOT EXISTS (
    SELECT * FROM actual_inherited_worker_memberships
    EXCEPT
    SELECT * FROM expected_inherited_worker_memberships
  )
  AND NOT EXISTS (
    SELECT * FROM expected_inherited_worker_memberships
    EXCEPT
    SELECT * FROM actual_inherited_worker_memberships
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members role_membership
    JOIN inherited_worker_roles granted_role
      ON granted_role.oid = role_membership.roleid
    JOIN pg_roles member_role ON member_role.oid = role_membership.member
    WHERE member_role.rolcanlogin
      AND member_role.rolname <> current_user
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members role_membership
    JOIN capability_roles granted_role ON granted_role.oid = role_membership.roleid
    JOIN capability_roles member_role ON member_role.oid = role_membership.member
  )
  AND NOT EXISTS (
    SELECT login_role.oid
    FROM pg_auth_members role_membership
    JOIN capability_roles granted_role ON granted_role.oid = role_membership.roleid
    JOIN pg_roles login_role ON login_role.oid = role_membership.member
    WHERE login_role.rolcanlogin
      AND login_role.rolname <> current_user
    GROUP BY login_role.oid
    HAVING count(DISTINCT granted_role.oid) > 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members role_membership
    JOIN capability_roles granted_role ON granted_role.oid = role_membership.roleid
    JOIN pg_roles login_role ON login_role.oid = role_membership.member
    WHERE login_role.rolcanlogin
      AND login_role.rolname <> current_user
      AND (login_role.rolsuper OR login_role.rolbypassrls)
  );
'@
}

function Get-EnterpriseScimCancellationHardeningSql {
  @'
WITH expected_columns(
  table_name,
  column_name,
  formatted_type,
  not_null,
  has_default
) AS (
  VALUES
    (
      'agent_runs',
      'cancellation_requested_at',
      'timestamp(6) with time zone',
      false,
      false
    ),
    (
      'agent_runs',
      'cancellation_reason',
      'character varying(120)',
      false,
      false
    ),
    (
      'agent_runs',
      'cancellation_confirmed_at',
      'timestamp(6) with time zone',
      false,
      false
    ),
    (
      'identity_deprovisioning_actions',
      'agent_runs_cancellation_requested',
      'integer',
      true,
      false
    )
), actual_columns AS (
  SELECT
    expected.table_name,
    expected.column_name,
    format_type(attribute_definition.atttypid, attribute_definition.atttypmod) AS formatted_type,
    attribute_definition.attnotnull AS not_null,
    attribute_definition.atthasdef AS has_default
  FROM expected_columns expected
  LEFT JOIN pg_class target_table
    ON target_table.relname = expected.table_name
   AND target_table.relnamespace = 'public'::regnamespace
  LEFT JOIN pg_attribute attribute_definition
    ON attribute_definition.attrelid = target_table.oid
   AND attribute_definition.attname = expected.column_name
   AND attribute_definition.attnum > 0
   AND NOT attribute_definition.attisdropped
), expected_functions(
  signature,
  security_definer,
  expected_config,
  result_type
) AS (
  VALUES
    (
      'public.resolve_scim_capability(text,text)',
      true,
      ARRAY['row_security=off', 'search_path=pg_catalog, public']::text[],
      'TABLE(service_token_id uuid, tenant_id uuid, connector_id uuid, connector_key text, scopes text[], allow_user_create boolean, allow_group_create boolean, deactivate_user_on_scim_disable boolean)'
    ),
    (
      'public.guard_untrusted_agent_run_cancellation()',
      false,
      ARRAY['search_path=pg_catalog, public']::text[],
      'trigger'
    ),
    (
      'public.apply_scim_user_deprovisioning()',
      true,
      ARRAY['row_security=off', 'search_path=pg_catalog, public']::text[],
      'trigger'
    )
), actual_functions AS (
  SELECT
    expected.signature,
    function_definition.oid,
    function_definition.proowner,
    function_owner.rolsuper OR function_owner.rolbypassrls AS owner_bypasses_rls,
    function_definition.prosecdef AS security_definer,
    ARRAY(
      SELECT setting
      FROM unnest(COALESCE(function_definition.proconfig, ARRAY[]::text[])) setting
      ORDER BY setting
    ) AS expected_config,
    pg_get_function_result(function_definition.oid) AS result_type,
    pg_get_functiondef(function_definition.oid) AS definition
  FROM expected_functions expected
  LEFT JOIN pg_proc function_definition
    ON function_definition.oid = to_regprocedure(expected.signature)
  LEFT JOIN pg_roles function_owner
    ON function_owner.oid = function_definition.proowner
), actual_function_acl AS (
  SELECT
    actual.signature,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    function_acl.privilege_type::text AS privilege_type,
    function_acl.is_grantable
  FROM actual_functions actual
  CROSS JOIN LATERAL aclexplode(
    COALESCE(
      (SELECT procedure_definition.proacl FROM pg_proc procedure_definition
       WHERE procedure_definition.oid = actual.oid),
      acldefault('f', actual.proowner)
    )
  ) function_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
  WHERE function_acl.grantee <> actual.proowner
), expected_function_acl(signature, grantee, privilege_type, is_grantable) AS (
  VALUES
    (
      'public.resolve_scim_capability(text,text)',
      'enterprise_agent_scim',
      'EXECUTE',
      false
    )
), denied_scim_tables(table_name) AS (
  VALUES
    ('agent_runs'),
    ('audit_events'),
    ('auth_sessions'),
    ('identity_deprovisioning_actions'),
    ('identity_devices'),
    ('outbox_events'),
    ('role_assignments'),
    ('scim_connectors'),
    ('scim_service_tokens')
), resolved_denied_scim_tables AS (
  SELECT denied.table_name, target_table.oid
  FROM denied_scim_tables denied
  LEFT JOIN pg_class target_table
    ON target_table.relname = denied.table_name
   AND target_table.relnamespace = 'public'::regnamespace
), direct_scim_table_acl AS (
  SELECT target.table_name, table_acl.privilege_type
  FROM resolved_denied_scim_tables target
  JOIN pg_class target_table ON target_table.oid = target.oid
  CROSS JOIN LATERAL aclexplode(
    COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
  ) table_acl
  JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE grantee_role.rolname = 'enterprise_agent_scim'
), direct_scim_column_acl AS (
  SELECT target.table_name, attribute_definition.attname, column_acl.privilege_type
  FROM resolved_denied_scim_tables target
  JOIN pg_attribute attribute_definition
    ON attribute_definition.attrelid = target.oid
   AND attribute_definition.attnum > 0
   AND NOT attribute_definition.attisdropped
  CROSS JOIN LATERAL aclexplode(attribute_definition.attacl) column_acl
  JOIN pg_roles grantee_role ON grantee_role.oid = column_acl.grantee
  WHERE grantee_role.rolname = 'enterprise_agent_scim'
), cancellation_constraints AS (
  SELECT
    constraint_definition.conname,
    constraint_definition.convalidated,
    pg_get_constraintdef(constraint_definition.oid, true) AS definition
  FROM pg_constraint constraint_definition
  WHERE constraint_definition.conrelid IN (
      'public.agent_runs'::regclass,
      'public.identity_deprovisioning_actions'::regclass
    )
    AND constraint_definition.conname IN (
      'agent_runs_cancellation_evidence_check',
      'identity_deprovisioning_actions_cancellation_requested_check'
    )
), pending_cancellation_index AS (
  SELECT
    index_definition.indisvalid,
    index_definition.indisready,
    index_definition.indislive,
    index_definition.indisunique,
    index_definition.indnkeyatts,
    pg_get_indexdef(index_definition.indexrelid) AS definition,
    pg_get_expr(index_definition.indpred, index_definition.indrelid) AS predicate
  FROM pg_index index_definition
  JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
  JOIN pg_namespace index_schema ON index_schema.oid = index_relation.relnamespace
  WHERE index_schema.nspname = 'public'
    AND index_relation.relname = 'agent_runs_pending_cancellation_idx'
), expected_triggers(
  table_name,
  trigger_name,
  function_signature,
  trigger_type,
  update_column
) AS (
  VALUES
    (
      'agent_runs',
      'agent_runs_untrusted_cancellation_guard',
      'public.guard_untrusted_agent_run_cancellation()',
      19,
      NULL::text
    ),
    (
      'scim_users',
      'scim_users_deprovision',
      'public.apply_scim_user_deprovisioning()',
      17,
      'active'
    )
), actual_triggers AS (
  SELECT
    expected.table_name,
    expected.trigger_name,
    trigger_definition.tgenabled,
    trigger_definition.tgtype::integer AS trigger_type,
    trigger_definition.tgfoid,
    CASE
      WHEN expected.update_column IS NULL
        THEN cardinality(trigger_definition.tgattr::smallint[]) = 0
      ELSE ARRAY(
        SELECT update_attribute
        FROM unnest(trigger_definition.tgattr::smallint[]) update_attribute
      ) = ARRAY[
          (
            SELECT attribute_definition.attnum::smallint
            FROM pg_attribute attribute_definition
            WHERE attribute_definition.attrelid = target_table.oid
              AND attribute_definition.attname = expected.update_column
              AND attribute_definition.attnum > 0
              AND NOT attribute_definition.attisdropped
          )
        ]::smallint[]
    END AS exact_update_columns
  FROM expected_triggers expected
  LEFT JOIN pg_class target_table
    ON target_table.relname = expected.table_name
   AND target_table.relnamespace = 'public'::regnamespace
  LEFT JOIN pg_trigger trigger_definition
    ON trigger_definition.tgrelid = target_table.oid
   AND trigger_definition.tgname = expected.trigger_name
   AND NOT trigger_definition.tgisinternal
)
SELECT
  (SELECT count(*) FROM expected_columns) = 4
  AND NOT EXISTS (
    SELECT * FROM actual_columns
    EXCEPT
    SELECT * FROM expected_columns
  )
  AND NOT EXISTS (
    SELECT * FROM expected_columns
    EXCEPT
    SELECT * FROM actual_columns
  )
  AND (SELECT count(*) FROM cancellation_constraints) = 2
  AND (SELECT bool_and(convalidated) FROM cancellation_constraints)
  AND EXISTS (
    SELECT 1
    FROM cancellation_constraints
    WHERE conname = 'agent_runs_cancellation_evidence_check'
      AND position('cancellation_requested_at' IN definition) > 0
      AND position('cancellation_reason' IN definition) > 0
      AND position('cancellation_confirmed_at' IN definition) > 0
  )
  AND EXISTS (
    SELECT 1
    FROM cancellation_constraints
    WHERE conname = 'identity_deprovisioning_actions_cancellation_requested_check'
      AND position('agent_runs_cancellation_requested' IN definition) > 0
      AND position('>= 0' IN definition) > 0
  )
  AND (
    SELECT count(*) = 1
      AND bool_and(
        indisvalid
        AND indisready
        AND indislive
        AND NOT indisunique
        AND indnkeyatts = 3
        AND position('tenant_id' IN definition) > 0
        AND position('cancellation_requested_at' IN definition) > 0
        AND position('cancellation_confirmed_at IS NULL' IN predicate) > 0
        AND position('cancellation_requested_at IS NOT NULL' IN predicate) > 0
      )
    FROM pending_cancellation_index
  )
  AND (SELECT count(*) FROM actual_functions WHERE oid IS NOT NULL) = 3
  AND NOT EXISTS (
    SELECT
      signature,
      security_definer,
      expected_config,
      result_type
    FROM actual_functions
    EXCEPT
    SELECT * FROM expected_functions
  )
  AND NOT EXISTS (
    SELECT * FROM expected_functions
    EXCEPT
    SELECT
      signature,
      security_definer,
      expected_config,
      result_type
    FROM actual_functions
  )
  AND NOT EXISTS (
    SELECT * FROM actual_function_acl
    EXCEPT
    SELECT * FROM expected_function_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_function_acl
    EXCEPT
    SELECT * FROM actual_function_acl
  )
  AND (
    SELECT bool_and(owner_bypasses_rls)
    FROM actual_functions
    WHERE signature IN (
      'public.resolve_scim_capability(text,text)',
      'public.apply_scim_user_deprovisioning()'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.resolve_scim_capability(text,text)'
      AND position(
        'update public.scim_service_tokens as token'
        IN lower(replace(definition, '"', ''))
      ) > 0
      AND position(
        'from public.scim_connectors as connector'
        IN lower(replace(definition, '"', ''))
      ) > 0
      AND position('for update of token' IN lower(replace(definition, '"', ''))) = 0
      AND position(
        'token.token_hash = p_token_hash'
        IN lower(replace(definition, '"', ''))
      ) > 0
      AND position(
        'connector.key = p_connector_key'
        IN lower(replace(definition, '"', ''))
      ) > 0
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_untrusted_agent_run_cancellation()'
      AND position('Only the Agent Runtime worker may confirm provider cancellation.' IN definition) > 0
      AND position('A settled Agent Run cannot acquire new cancellation intent.' IN definition) > 0
      AND position('This capability cannot rewrite a provider-backed Agent Run.' IN definition) > 0
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.apply_scim_user_deprovisioning()'
      AND position(
        'connector.deactivate_user_on_scim_disable'
        IN lower(replace(definition, '"', ''))
      ) > 0
      AND position(
        'run.requester_user_id = new.user_id'
        IN lower(replace(definition, '"', ''))
      ) > 0
      AND position(':agent-run-quota' IN definition) > 0
      AND position('agent.run_cancel_requested.v1' IN definition) > 0
  )
  AND (
    SELECT count(*) = 2
      AND bool_and(
        actual.tgenabled IS NOT NULL
        AND actual.tgenabled = 'O'
        AND actual.trigger_type = expected.trigger_type
        AND actual.tgfoid = to_regprocedure(expected.function_signature)
        AND actual.exact_update_columns
      )
    FROM actual_triggers actual
    JOIN expected_triggers expected
      ON expected.table_name = actual.table_name
     AND expected.trigger_name = actual.trigger_name
  )
  AND (SELECT count(*) FROM resolved_denied_scim_tables WHERE oid IS NOT NULL) = 9
  AND NOT EXISTS (SELECT 1 FROM direct_scim_table_acl)
  AND NOT EXISTS (SELECT 1 FROM direct_scim_column_acl)
  AND NOT EXISTS (
    SELECT 1
    FROM resolved_denied_scim_tables target
    WHERE has_table_privilege('enterprise_agent_scim', target.oid, 'SELECT')
      OR has_table_privilege('enterprise_agent_scim', target.oid, 'INSERT')
      OR has_table_privilege('enterprise_agent_scim', target.oid, 'UPDATE')
      OR has_table_privilege('enterprise_agent_scim', target.oid, 'DELETE')
      OR has_table_privilege('enterprise_agent_scim', target.oid, 'TRUNCATE')
      OR has_table_privilege('enterprise_agent_scim', target.oid, 'REFERENCES')
      OR has_table_privilege('enterprise_agent_scim', target.oid, 'TRIGGER')
      OR has_any_column_privilege('enterprise_agent_scim', target.oid, 'SELECT')
      OR has_any_column_privilege('enterprise_agent_scim', target.oid, 'INSERT')
      OR has_any_column_privilege('enterprise_agent_scim', target.oid, 'UPDATE')
      OR has_any_column_privilege('enterprise_agent_scim', target.oid, 'REFERENCES')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_policy policy_definition
    JOIN resolved_denied_scim_tables target
      ON target.oid = policy_definition.polrelid
    JOIN pg_roles scim_role ON scim_role.rolname = 'enterprise_agent_scim'
    WHERE policy_definition.polpermissive
      AND (
        0::oid = ANY(policy_definition.polroles)
        OR scim_role.oid = ANY(policy_definition.polroles)
      )
  )
  AND NOT has_column_privilege(
    'enterprise_agent_scim',
    'public.users',
    'status',
    'UPDATE'
  )
  AND has_column_privilege(
    'enterprise_agent_admin',
    'public.agent_runs',
    'cancellation_requested_at',
    'UPDATE'
  )
  AND has_column_privilege(
    'enterprise_agent_admin',
    'public.agent_runs',
    'cancellation_reason',
    'UPDATE'
  )
  AND has_column_privilege(
    'enterprise_agent_lifecycle',
    'public.agent_runs',
    'cancellation_requested_at',
    'SELECT'
  )
  AND has_column_privilege(
    'enterprise_agent_lifecycle',
    'public.agent_runs',
    'cancellation_requested_at',
    'UPDATE'
  )
  AND has_column_privilege(
    'enterprise_agent_lifecycle',
    'public.agent_runs',
    'cancellation_reason',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'enterprise_agent_admin',
    'public.agent_runs',
    'cancellation_confirmed_at',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'enterprise_agent_lifecycle',
    'public.agent_runs',
    'cancellation_confirmed_at',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'enterprise_agent_scim',
    'public.agent_runs',
    'cancellation_confirmed_at',
    'UPDATE'
  );
'@
}

function Get-EnterpriseTenantRlsIntegritySql {
  @'
WITH expected(table_name, tenant_column, role_names) AS (
  VALUES
    ('agent_instances', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('agent_runs', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('ai_runtime_runs', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('agent_templates', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('agent_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('answer_feedbacks', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('audit_events', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('auth_action_tokens', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('auth_recovery_deliveries', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('auth_sessions', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('business_event_deliveries', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('business_event_effects', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('business_event_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('business_events', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('collaboration_message_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('collaboration_message_recipients', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('collaboration_messages', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('collaboration_participants', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('collaborations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('conversation_participants', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('conversations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('correction_case_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('correction_cases', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('correction_feedback', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('correction_feedback_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('directory_employment_bindings', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_integrations', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_org_unit_bindings', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_sync_preview_items', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('directory_sync_previews', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('directory_sync_runs', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('directory_user_bindings', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('acceptance_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('acceptances', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('deliverable_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('deliverables', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('employments', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('evidence_links', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_base_org_units', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('knowledge_bases', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('knowledge_chunk_embeddings', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_chunks', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_document_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_documents', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('knowledge_entities', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_entity_mentions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_ingestion_jobs', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('outbox_event_deliveries', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner']::text[]),
    ('knowledge_relation_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('knowledge_relations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('manager_relations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('messages', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('metric_definitions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('metric_observation_evidence', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('metric_observations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('objective_metric_definitions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('objective_relations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('objective_role_assignments', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('objective_value_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('objectives', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('org_units', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('organizations', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('outbox_events', 'tenant_id', ARRAY['enterprise_agent_app', 'enterprise_agent_provisioner']::text[]),
    ('password_credentials', 'tenant_id', ARRAY['enterprise_agent_admin']::text[]),
    ('positions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_definitions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_commands', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_edges', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_instances', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_nodes', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_step_commands', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_step_instances', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('process_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('role_assignments', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('strategies', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('strategy_value_versions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('task_dependencies', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('tasks', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('tenants', 'id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner']::text[]),
    ('users', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner']::text[]),
    ('value_constraints', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('value_definitions', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('value_metrics', 'tenant_id', ARRAY['PUBLIC']::text[]),
    ('value_versions', 'tenant_id', ARRAY['PUBLIC']::text[])
), special_tenant_tables(table_name) AS (
  -- Pre-authentication login throttling intentionally uses a dedicated
  -- enterprise_agent_auth policy instead of app.tenant_id tenant_isolation.
  -- Tool Gateway ledgers use a restrictive policy shared by three explicit
  -- capability roles. AI evaluation governance uses its own restrictive
  -- policy shared by the app, admin and external-runner capabilities. Exact
  -- policies and grants are verified by their dedicated boundaries below.
  VALUES
    ('auth_login_rate_limits'),
    ('tool_definitions'),
    ('tool_versions'),
    ('tool_invocations'),
    ('tool_invocation_commands'),
    ('tool_execution_receipts'),
    ('tool_dns_resolution_proofs'),
    ('tool_reconciliation_attempts'),
    ('tool_reconciliation_receipts'),
    ('tool_compensation_bindings'),
    ('ai_evaluation_datasets'),
    ('ai_evaluation_dataset_versions'),
    ('ai_evaluation_thresholds'),
    ('ai_evaluation_cases'),
    ('ai_evaluation_case_evidence'),
    ('ai_evaluation_annotations'),
    ('ai_evaluation_annotation_evidence'),
    ('ai_evaluation_review_evidence'),
    ('ai_evaluation_answer_feedback_sources'),
    ('ai_evaluation_runner_attestations'),
    ('ai_evaluation_runners'),
    ('ai_evaluation_runs'),
    ('ai_evaluation_case_results'),
    ('ai_evaluation_case_result_evidence'),
    ('ai_evaluation_metric_results'),
    ('ai_evaluation_metric_result_evidence'),
    ('ai_evaluation_verification_evidence'),
    ('ai_evaluation_bad_cases'),
    ('ai_evaluation_bad_case_evidence'),
    ('ai_evaluation_release_checks'),
    ('ai_governance_commands'),
    ('ai_model_attempt_receipts'),
    ('ai_model_catalog_versions'),
    ('ai_model_circuit_states'),
    ('ai_model_route_candidates'),
    ('ai_model_route_policy_versions'),
    ('ai_safety_decisions'),
    ('experience_knowledge_projections'),
    ('identity_break_glass_events'),
    ('identity_break_glass_requests'),
    ('identity_governance_commands')
), catalog_tenant_tables AS (
  -- This catalog-derived set is the primary completeness boundary. A future
  -- migration cannot add a public tenant_id table without automatically
  -- entering the restore gate.
  SELECT
    target_table.oid,
    target_table.relname::text AS table_name,
    target_table.relowner,
    target_table.relacl,
    target_table.relrowsecurity,
    target_table.relforcerowsecurity
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relkind IN ('r', 'p')
    AND EXISTS (
      SELECT 1
      FROM pg_attribute tenant_attribute
      WHERE tenant_attribute.attrelid = target_table.oid
        AND tenant_attribute.attname = 'tenant_id'
        AND tenant_attribute.attnum > 0
        AND NOT tenant_attribute.attisdropped
    )
), catalog_capability_roles AS (
  -- Table and column ACLs both create effective capability access. Compare
  -- every such role with the restrictive tenant policy that applies to it.
  SELECT DISTINCT
    tenant_table.oid AS table_oid,
    tenant_table.table_name,
    grantee_role.oid AS role_oid,
    grantee_role.rolname::text AS role_name
  FROM catalog_tenant_tables tenant_table
  CROSS JOIN LATERAL aclexplode(
    COALESCE(tenant_table.relacl, acldefault('r', tenant_table.relowner))
  ) table_acl
  JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE table_acl.grantee <> tenant_table.relowner
    AND table_acl.privilege_type IN (
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    )
  UNION
  SELECT DISTINCT
    tenant_table.oid AS table_oid,
    tenant_table.table_name,
    grantee_role.oid AS role_oid,
    grantee_role.rolname::text AS role_name
  FROM catalog_tenant_tables tenant_table
  JOIN pg_attribute column_definition
    ON column_definition.attrelid = tenant_table.oid
   AND column_definition.attnum > 0
   AND NOT column_definition.attisdropped
  CROSS JOIN LATERAL aclexplode(column_definition.attacl) column_acl
  JOIN pg_roles grantee_role ON grantee_role.oid = column_acl.grantee
  WHERE column_acl.grantee <> tenant_table.relowner
    AND column_acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
), reviewed_cross_tenant_capabilities(table_name, role_name) AS (
  -- These narrowly named capability pairs deliberately operate before tenant
  -- context is available or claim work across tenants. The set is exact:
  -- adding/removing either an ACL or a restrictive policy requires review.
  VALUES
    ('auth_action_tokens', 'enterprise_agent_auth'),
    ('auth_recovery_deliveries', 'enterprise_agent_auth'),
    ('auth_mfa_challenges', 'enterprise_agent_auth'),
    ('auth_refresh_token_history', 'enterprise_agent_auth'),
    ('auth_sessions', 'enterprise_agent_auth'),
    ('directory_sync_runs', 'enterprise_agent_outbox'),
    ('outbox_event_deliveries', 'enterprise_agent_outbox'),
    ('outbox_events', 'enterprise_agent_employee_insights'),
    ('enterprise_identity_policies', 'enterprise_agent_auth'),
    ('enterprise_identity_providers', 'enterprise_agent_auth'),
    ('identity_devices', 'enterprise_agent_auth'),
    ('identity_provider_secrets', 'enterprise_agent_auth'),
    ('knowledge_ingestion_jobs', 'enterprise_agent_outbox'),
    ('mfa_recovery_codes', 'enterprise_agent_auth'),
    ('oidc_account_bindings', 'enterprise_agent_auth'),
    ('oidc_auth_transactions', 'enterprise_agent_auth'),
    ('oidc_provider_configs', 'enterprise_agent_auth'),
    ('oidc_token_validation_receipts', 'enterprise_agent_auth'),
    ('outbox_events', 'enterprise_agent_evaluation_runner'),
    ('outbox_events', 'enterprise_agent_finops_projector'),
    ('outbox_events', 'enterprise_agent_lifecycle'),
    ('outbox_events', 'enterprise_agent_outbox'),
    ('outbox_events', 'enterprise_agent_task_executor'),
    ('outbox_events', 'enterprise_agent_tool_gateway'),
    ('password_credentials', 'enterprise_agent_auth'),
    ('saml_assertion_receipts', 'enterprise_agent_auth'),
    ('saml_authn_requests', 'enterprise_agent_auth'),
    ('saml_provider_configs', 'enterprise_agent_auth'),
    ('scim_group_memberships', 'enterprise_agent_scim'),
    ('scim_groups', 'enterprise_agent_scim'),
    ('scim_provisioning_requests', 'enterprise_agent_scim'),
    ('scim_users', 'enterprise_agent_scim'),
    ('user_mfa_factors', 'enterprise_agent_auth'),
    ('tool_execution_receipts', 'enterprise_agent_finops_projector'),
    ('tool_invocations', 'enterprise_agent_finops_projector'),
    ('tool_versions', 'enterprise_agent_finops_projector'),
    ('users', 'enterprise_agent_auth'),
    ('users', 'enterprise_agent_lifecycle'),
    ('users', 'enterprise_agent_scim'),
    ('users', 'enterprise_agent_process'),
    ('users', 'enterprise_agent_tool_gateway')
), actual_cross_tenant_capabilities AS (
  SELECT capability.table_name, capability.role_name
  FROM catalog_capability_roles capability
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policy tenant_policy
    WHERE tenant_policy.polrelid = capability.table_oid
      AND NOT tenant_policy.polpermissive
      AND tenant_policy.polcmd = '*'
      AND (
        0::oid = ANY(tenant_policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM unnest(tenant_policy.polroles) assigned_policy_role(role_oid)
          WHERE assigned_policy_role.role_oid <> 0
            AND pg_has_role(
              capability.role_oid,
              assigned_policy_role.role_oid,
              'USAGE'
            )
        )
      )
      AND pg_get_expr(tenant_policy.polqual, tenant_policy.polrelid) =
        '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
      AND pg_get_expr(tenant_policy.polwithcheck, tenant_policy.polrelid) =
        '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
  )
), expected_role_assignment_policies(policy_name, role_names, command, permissive) AS (
  VALUES
    ('tenant_isolation', ARRAY['PUBLIC']::text[], '*', false),
    ('enterprise_agent_admin_access', ARRAY['enterprise_agent_admin']::text[], '*', true),
    ('enterprise_agent_access', ARRAY['enterprise_agent_app']::text[], 'r', true),
    ('enterprise_agent_lifecycle_access', ARRAY['enterprise_agent_lifecycle']::text[], '*', true),
    ('enterprise_agent_process_read', ARRAY['enterprise_agent_process']::text[], 'r', true),
    ('employee_insights_assignment_select',
      ARRAY['enterprise_agent_employee_insights']::text[], 'r', true),
    ('tool_gateway_parent_read', ARRAY['enterprise_agent_tool_gateway']::text[], 'r', true),
    ('tool_gateway_parent_tenant', ARRAY['enterprise_agent_tool_gateway']::text[], 'r', false)
), actual_role_assignment_policies AS (
  SELECT
    policy_definition.polname::text AS policy_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS role_names,
    policy_definition.polcmd::text AS command,
    policy_definition.polpermissive AS permissive
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'role_assignments'
), expected_ai_runtime_policies(policy_name, role_names, command, permissive) AS (
  VALUES
    ('tenant_isolation', ARRAY['PUBLIC']::text[], '*', false),
    ('enterprise_agent_admin_access', ARRAY['enterprise_agent_admin']::text[], 'r', true),
    ('enterprise_agent_runtime_access', ARRAY['enterprise_agent_runtime']::text[], '*', true)
), actual_ai_runtime_policies AS (
  SELECT
    policy_definition.polname::text AS policy_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS role_names,
    policy_definition.polcmd::text AS command,
    policy_definition.polpermissive AS permissive
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'ai_runtime_runs'
), expected_lifecycle_policies(
  table_name,
  policy_name,
  role_names,
  command,
  permissive,
  using_expression,
  check_expression
) AS (
  VALUES
    ('tenants',
      'enterprise_agent_lifecycle_tenant_enumeration',
      ARRAY['enterprise_agent_lifecycle']::text[],
      'r',
      true,
      'true',
      NULL::text
    ),
    ('users',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('employments',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('agent_templates',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('agent_versions',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('role_assignments',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('agent_instances',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('agent_runs',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('outbox_events',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('audit_events',
      'enterprise_agent_lifecycle_access',
      ARRAY['enterprise_agent_lifecycle']::text[],
      '*',
      true,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    )
), actual_lifecycle_policies AS (
  SELECT
    target_table.relname::text AS table_name,
    policy_definition.polname::text AS policy_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS role_names,
    policy_definition.polcmd::text AS command,
    policy_definition.polpermissive AS permissive,
    pg_get_expr(policy_definition.polqual, policy_definition.polrelid) AS using_expression,
    pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) AS check_expression
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND EXISTS (
      SELECT 1
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      WHERE role_definition.rolname = 'enterprise_agent_lifecycle'
    )
), expected_outbox_admin_policies(
  policy_name,
  role_names,
  command,
  permissive,
  using_expression,
  check_expression
) AS (
  VALUES
    ('enterprise_agent_admin_tenant_isolation',
      ARRAY['enterprise_agent_admin']::text[],
      '*',
      false,
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    ),
    ('enterprise_agent_admin_access',
      ARRAY['enterprise_agent_admin']::text[],
      '*',
      true,
      'true',
      'true'
    )
), actual_outbox_admin_policies AS (
  SELECT
    policy_definition.polname::text AS policy_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS role_names,
    policy_definition.polcmd::text AS command,
    policy_definition.polpermissive AS permissive,
    pg_get_expr(policy_definition.polqual, policy_definition.polrelid) AS using_expression,
    pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) AS check_expression
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'outbox_events'
    AND (
      0::oid = ANY(policy_definition.polroles)
      OR EXISTS (
        SELECT 1
        FROM unnest(policy_definition.polroles) assigned_role(role_oid)
        JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
        WHERE role_definition.rolname = 'enterprise_agent_admin'
      )
    )
)
SELECT
  -- Keep exact contracts for the historically high-risk core tables.
  NOT EXISTS (
    SELECT 1
    FROM expected expected_policy
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relkind = 'r'
        AND target_table.relname = expected_policy.table_name
        AND target_table.relrowsecurity
        AND target_table.relforcerowsecurity
        AND policy_definition.polname = 'tenant_isolation'
        AND NOT policy_definition.polpermissive
        AND policy_definition.polcmd = '*'
        AND ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy_definition.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        ) = expected_policy.role_names
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = format(
          '(%I = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
          expected_policy.tenant_column
        )
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = format(
          '(%I = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)',
          expected_policy.tenant_column
        )
    )
  )
  -- The catalog rule is the completeness gate. Every present and future
  -- tenant_id table must be forced through the canonical tenant predicate;
  -- an unregistered table therefore fails without any count update.
  AND NOT EXISTS (
    SELECT 1
    FROM catalog_tenant_tables tenant_table
    WHERE NOT tenant_table.relrowsecurity
      OR NOT tenant_table.relforcerowsecurity
      OR EXISTS (
        SELECT 1
        FROM aclexplode(
          COALESCE(tenant_table.relacl, acldefault('r', tenant_table.relowner))
        ) table_acl
        WHERE table_acl.grantee = 0
          AND table_acl.privilege_type IN (
            'SELECT', 'INSERT', 'UPDATE', 'DELETE',
            'TRUNCATE', 'REFERENCES', 'TRIGGER'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM pg_attribute column_definition
        CROSS JOIN LATERAL aclexplode(column_definition.attacl) column_acl
        WHERE column_definition.attrelid = tenant_table.oid
          AND column_definition.attnum > 0
          AND NOT column_definition.attisdropped
          AND column_acl.grantee = 0
          AND column_acl.privilege_type IN (
            'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM pg_policy tenant_policy
        WHERE tenant_policy.polrelid = tenant_table.oid
          AND NOT tenant_policy.polpermissive
          AND tenant_policy.polcmd = '*'
          AND pg_get_expr(tenant_policy.polqual, tenant_policy.polrelid) =
            '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
          AND pg_get_expr(tenant_policy.polwithcheck, tenant_policy.polrelid) =
            '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
      )
  )
  AND EXISTS (SELECT 1 FROM catalog_tenant_tables)
  -- Every explicitly specialized table must exist in the catalog-derived
  -- tenant boundary and must not also be registered as a shared baseline.
  AND NOT EXISTS (
    SELECT table_name FROM special_tenant_tables
    WHERE table_name <> 'auth_login_rate_limits'
    EXCEPT
    SELECT table_name FROM catalog_tenant_tables
  )
  AND NOT EXISTS (
    SELECT special_table.table_name
    FROM special_tenant_tables special_table
    JOIN expected baseline ON baseline.table_name = special_table.table_name
  )
  -- A capability can bypass the tenant predicate only when the exact
  -- table/role pair is present in the reviewed cross-tenant classification.
  AND NOT EXISTS (
    SELECT * FROM actual_cross_tenant_capabilities
    EXCEPT
    SELECT * FROM reviewed_cross_tenant_capabilities
  )
  AND NOT EXISTS (
    SELECT * FROM reviewed_cross_tenant_capabilities
    EXCEPT
    SELECT * FROM actual_cross_tenant_capabilities
  )
  AND NOT EXISTS (
    SELECT 1
    FROM reviewed_cross_tenant_capabilities reviewed_capability
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_class target_table
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      JOIN pg_roles capability_role
        ON capability_role.rolname = reviewed_capability.role_name
      JOIN pg_policy capability_policy
        ON capability_policy.polrelid = target_table.oid
       AND capability_policy.polpermissive
       AND (
         0::oid = ANY(capability_policy.polroles)
         OR capability_role.oid = ANY(capability_policy.polroles)
       )
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = reviewed_capability.table_name
    )
  )
  AND NOT EXISTS (
    SELECT * FROM actual_role_assignment_policies
    EXCEPT
    SELECT * FROM expected_role_assignment_policies
  )
  AND NOT EXISTS (
    SELECT * FROM expected_role_assignment_policies
    EXCEPT
    SELECT * FROM actual_role_assignment_policies
  )
  AND (SELECT count(*) FROM expected_ai_runtime_policies) = 3
  AND NOT EXISTS (
    SELECT * FROM actual_ai_runtime_policies
    EXCEPT
    SELECT * FROM expected_ai_runtime_policies
  )
  AND NOT EXISTS (
    SELECT * FROM expected_ai_runtime_policies
    EXCEPT
    SELECT * FROM actual_ai_runtime_policies
  )
  AND (SELECT count(*) FROM expected_lifecycle_policies) = 10
  AND NOT EXISTS (
    SELECT * FROM actual_lifecycle_policies
    EXCEPT
    SELECT * FROM expected_lifecycle_policies
  )
  AND NOT EXISTS (
    SELECT * FROM expected_lifecycle_policies
    EXCEPT
    SELECT * FROM actual_lifecycle_policies
  )
  AND (SELECT count(*) FROM expected_outbox_admin_policies) = 2
  AND NOT EXISTS (
    SELECT * FROM actual_outbox_admin_policies
    EXCEPT
    SELECT * FROM expected_outbox_admin_policies
  )
  AND NOT EXISTS (
    SELECT * FROM expected_outbox_admin_policies
    EXCEPT
    SELECT * FROM actual_outbox_admin_policies
  );
'@
}

function Get-EnterpriseAuthLoginRateLimitBoundarySql {
  @'
SELECT EXISTS (
  SELECT 1
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'auth_login_rate_limits'
    AND target_table.relkind = 'r'
    AND target_table.relrowsecurity
    AND target_table.relforcerowsecurity
    AND (
      SELECT count(*) FROM pg_policy policy_definition
      WHERE policy_definition.polrelid = target_table.oid
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      WHERE policy_definition.polrelid = target_table.oid
        AND policy_definition.polname = 'enterprise_agent_auth_access'
        AND policy_definition.polpermissive
        AND policy_definition.polcmd = '*'
        AND ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy_definition.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        ) = ARRAY['enterprise_agent_auth']::text[]
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = 'true'
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = 'true'
    )
);
'@
}

function Get-EnterpriseAuthActionTokenPolicyIntegritySql {
  @'
WITH expected(policy_name, role_names) AS (
  VALUES
    ('auth_action_tokens_admin_access', ARRAY['enterprise_agent_admin']::text[]),
    ('auth_action_tokens_auth_access', ARRAY['enterprise_agent_auth']::text[])
)
SELECT
  (SELECT count(*) FROM pg_policy policy_definition
   WHERE policy_definition.polrelid = 'public.auth_action_tokens'::regclass) = 3
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_policy
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      WHERE policy_definition.polrelid = 'public.auth_action_tokens'::regclass
        AND policy_definition.polname = expected_policy.policy_name
        AND policy_definition.polpermissive
        AND policy_definition.polcmd = '*'
        AND ARRAY(
          SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
          FROM unnest(policy_definition.polroles) assigned_role(role_oid)
          LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
          ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
        ) = expected_policy.role_names
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = 'true'
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = 'true'
    )
  );
'@
}

function Get-EnterpriseAuthActionTokenKeyConstraintsSql {
  @'
SELECT
  EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_pkey'
      AND constraint_definition.contype = 'p'
      AND constraint_definition.convalidated
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'id')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_token_hash_key'
      AND constraint_definition.contype = 'u'
      AND constraint_definition.convalidated
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'token_hash')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_tenant_id_fkey'
      AND constraint_definition.contype = 'f'
      AND constraint_definition.convalidated
      AND NOT constraint_definition.condeferrable
      AND constraint_definition.confrelid = 'public.tenants'::regclass
      AND constraint_definition.confdeltype = 'r'
      AND constraint_definition.confupdtype = 'a'
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'tenant_id')
      ]::smallint[]
      AND constraint_definition.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.tenants'::regclass AND attname = 'id')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_tenant_id_user_id_fkey'
      AND constraint_definition.contype = 'f'
      AND constraint_definition.convalidated
      AND NOT constraint_definition.condeferrable
      AND constraint_definition.confrelid = 'public.users'::regclass
      AND constraint_definition.confdeltype = 'c'
      AND constraint_definition.confupdtype = 'a'
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'user_id')
      ]::smallint[]
      AND constraint_definition.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'id')
      ]::smallint[]
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.conname = 'auth_action_tokens_tenant_id_created_by_id_fkey'
      AND constraint_definition.contype = 'f'
      AND constraint_definition.convalidated
      AND NOT constraint_definition.condeferrable
      AND constraint_definition.confrelid = 'public.users'::regclass
      AND constraint_definition.confdeltype = 'r'
      AND constraint_definition.confupdtype = 'a'
      AND constraint_definition.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.auth_action_tokens'::regclass AND attname = 'created_by_id')
      ]::smallint[]
      AND constraint_definition.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'id')
      ]::smallint[]
  );
'@
}

function Get-EnterpriseAuthActionTokenCheckConstraintsSql {
  @'
WITH expected(constraint_name, constraint_definition) AS (
  VALUES
    ('auth_action_tokens_purpose_check',
      'CHECK (purpose::text = ANY (ARRAY[''PASSWORD_RESET''::character varying, ''MEMBER_INVITATION''::character varying]))'),
    ('auth_action_tokens_delivery_status_check',
      'CHECK (delivery_status::text = ANY (ARRAY[''NOT_CONFIGURED''::character varying, ''PENDING''::character varying, ''SENT''::character varying, ''FAILED''::character varying]))'),
    ('auth_action_tokens_delivery_attempts_check', 'CHECK (delivery_attempts >= 0)'),
    ('auth_action_tokens_expiry_check', 'CHECK (expires_at > created_at)'),
    ('auth_action_tokens_terminal_check', 'CHECK (consumed_at IS NULL OR revoked_at IS NULL)'),
    ('auth_action_tokens_consumed_at_check', 'CHECK (consumed_at IS NULL OR consumed_at >= created_at)'),
    ('auth_action_tokens_revoked_at_check', 'CHECK (revoked_at IS NULL OR revoked_at >= created_at)'),
    ('auth_action_tokens_delivery_target_evidence_check',
      'CHECK (delivery_target_evidence::text = ANY (ARRAY[''ISSUED''::character varying, ''LEGACY_INFERRED''::character varying]))')
)
SELECT
  (SELECT count(*) FROM expected) = 8
  AND (
    SELECT count(*)
    FROM pg_constraint constraint_definition
    WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
      AND constraint_definition.contype = 'c'
  ) = 8
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_constraint
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_definition
      WHERE constraint_definition.conrelid = 'public.auth_action_tokens'::regclass
        AND constraint_definition.conname = expected_constraint.constraint_name
        AND constraint_definition.contype = 'c'
        AND constraint_definition.convalidated
        AND replace(
          replace(
            pg_get_constraintdef(constraint_definition.oid, true),
            '::character varying::text',
            '::character varying'
          ),
          '::text[]',
          ''
        ) = expected_constraint.constraint_definition
    )
  );
'@
}

function Get-EnterpriseAuthActionTokenDeliveryTargetIntegritySql {
  @'
WITH function_definition AS (
  SELECT
    procedure_definition.oid,
    procedure_definition.proowner,
    procedure_definition.proacl,
    procedure_definition.prosecdef,
    procedure_definition.proleakproof,
    procedure_definition.provolatile,
    procedure_definition.proparallel,
    ARRAY(
      SELECT setting
      FROM unnest(COALESCE(procedure_definition.proconfig, ARRAY[]::text[])) setting
      ORDER BY setting
    ) AS configuration,
    pg_get_function_result(procedure_definition.oid) AS result_type,
    procedure_language.lanname::text AS language_name,
    pg_get_functiondef(procedure_definition.oid) AS definition,
    lower(
      regexp_replace(
        pg_get_functiondef(procedure_definition.oid),
        '[[:space:]\"]',
        '',
        'g'
      )
    ) AS compact_definition
  FROM pg_proc procedure_definition
  JOIN pg_namespace procedure_schema
    ON procedure_schema.oid = procedure_definition.pronamespace
  JOIN pg_language procedure_language
    ON procedure_language.oid = procedure_definition.prolang
  WHERE procedure_schema.nspname = 'public'
    AND procedure_definition.proname = 'enforce_auth_action_token_delivery_target_immutable'
    AND procedure_definition.prokind = 'f'
    AND procedure_definition.pronargs = 0
), non_owner_function_acl AS (
  SELECT
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    function_acl.privilege_type::text AS privilege_type,
    function_acl.is_grantable
  FROM function_definition definition
  CROSS JOIN LATERAL aclexplode(
    COALESCE(definition.proacl, acldefault('f', definition.proowner))
  ) function_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
  WHERE function_acl.grantee <> definition.proowner
), trigger_definition AS (
  SELECT
    trigger_catalog.tgenabled,
    trigger_catalog.tgtype::integer AS trigger_type,
    trigger_catalog.tgfoid,
    trigger_catalog.tgattr::smallint[] AS update_columns,
    pg_get_triggerdef(trigger_catalog.oid, true) AS definition
  FROM pg_trigger trigger_catalog
  WHERE trigger_catalog.tgrelid = 'public.auth_action_tokens'::regclass
    AND trigger_catalog.tgname = 'auth_action_tokens_delivery_target_immutable'
    AND NOT trigger_catalog.tgisinternal
)
SELECT
  (SELECT count(*) FROM function_definition) = 1
  AND EXISTS (
    SELECT 1
    FROM function_definition definition
    WHERE NOT definition.prosecdef
      AND NOT definition.proleakproof
      AND definition.provolatile = 'v'
      AND definition.proparallel = 'u'
      AND definition.configuration = ARRAY['search_path=pg_catalog, public']::text[]
      AND definition.result_type = 'trigger'
      AND definition.language_name = 'plpgsql'
      AND definition.proacl IS NOT NULL
      AND position(
        'new.delivery_target_emailisdistinctfromold.delivery_target_email'
        IN definition.compact_definition
      ) > 0
      AND position(
        'new.delivery_target_evidenceisdistinctfromold.delivery_target_evidence'
        IN definition.compact_definition
      ) > 0
      AND position(
        'raiseexception''authactiontokendeliverytargetisimmutable'''
        IN definition.compact_definition
      ) > 0
      AND position('errcode=''23514''' IN definition.compact_definition) > 0
      AND position('returnnew' IN definition.compact_definition) > 0
      AND regexp_count(definition.definition, '\mRAISE\s+EXCEPTION\M', 1, 'i') = 1
      AND position('execute' IN definition.compact_definition) = 0
  )
  AND NOT EXISTS (SELECT 1 FROM non_owner_function_acl)
  AND (
    SELECT count(*)
    FROM pg_trigger trigger_catalog
    WHERE trigger_catalog.tgrelid = 'public.auth_action_tokens'::regclass
      AND NOT trigger_catalog.tgisinternal
  ) = 1
  AND EXISTS (
    SELECT 1
    FROM trigger_definition actual
    WHERE actual.tgenabled = 'O'
      AND actual.trigger_type = 19
      AND actual.tgfoid =
        'public.enforce_auth_action_token_delivery_target_immutable()'::regprocedure
      AND actual.update_columns = ARRAY[
        (
          SELECT attribute_definition.attnum
          FROM pg_attribute attribute_definition
          WHERE attribute_definition.attrelid = 'public.auth_action_tokens'::regclass
            AND attribute_definition.attname = 'delivery_target_email'
            AND attribute_definition.attnum > 0
            AND NOT attribute_definition.attisdropped
        ),
        (
          SELECT attribute_definition.attnum
          FROM pg_attribute attribute_definition
          WHERE attribute_definition.attrelid = 'public.auth_action_tokens'::regclass
            AND attribute_definition.attname = 'delivery_target_evidence'
            AND attribute_definition.attnum > 0
            AND NOT attribute_definition.attisdropped
        )
      ]::smallint[]
      AND actual.definition =
        'CREATE TRIGGER auth_action_tokens_delivery_target_immutable BEFORE UPDATE OF delivery_target_email, delivery_target_evidence ON auth_action_tokens FOR EACH ROW EXECUTE FUNCTION enforce_auth_action_token_delivery_target_immutable()'
  );
'@
}

function Get-EnterpriseAgentRunUsageConstraintsSql {
  @'
WITH expected(constraint_name, constraint_definition) AS (
  VALUES
    ('agent_runs_succeeded_reported_usage_positive_check',
      'CHECK (status <> ''SUCCEEDED''::' || quote_ident('AgentRunStatus') || ' OR usage_recorded_at IS NULL OR total_tokens > 0 AND (input_tokens + output_tokens) > 0)'),
    ('agent_runs_total_tokens_consistent_check',
      'CHECK (total_tokens >= (input_tokens + output_tokens))'),
    ('agent_runs_unverified_tokens_zero_check',
      'CHECK (usage_recorded_at IS NOT NULL OR input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0)'),
    ('agent_runs_unverified_cost_zero_check',
      'CHECK (cost_recorded_at IS NOT NULL OR cost_micros = 0)'),
    ('agent_runs_usage_nonnegative_check',
      'CHECK (input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0 AND tool_calls >= 0 AND cost_micros >= 0 AND reserved_tokens >= 0 AND (latency_ms IS NULL OR latency_ms >= 0))'),
    ('agent_runs_grounded_citation_count_check',
      'CHECK (grounded_citation_count >= 0 AND grounded_citation_count <= 12)')
)
SELECT
  (SELECT count(*) FROM expected) = 6
  AND EXISTS (
    SELECT 1
    FROM pg_attribute attribute_definition
    LEFT JOIN pg_attrdef default_definition
      ON default_definition.adrelid = attribute_definition.attrelid
     AND default_definition.adnum = attribute_definition.attnum
    WHERE attribute_definition.attrelid = 'public.agent_runs'::regclass
      AND attribute_definition.attname = 'grounded_citation_count'
      AND attribute_definition.attnum > 0
      AND NOT attribute_definition.attisdropped
      AND format_type(
        attribute_definition.atttypid,
        attribute_definition.atttypmod
      ) = 'integer'
      AND attribute_definition.attnotnull
      AND attribute_definition.attidentity = ''
      AND attribute_definition.attgenerated = ''
      AND pg_get_expr(
        default_definition.adbin,
        default_definition.adrelid,
        true
      ) = '0'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected expected_constraint
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_definition
      WHERE constraint_definition.conrelid = 'public.agent_runs'::regclass
        AND constraint_definition.conname = expected_constraint.constraint_name
        AND constraint_definition.contype = 'c'
        AND constraint_definition.convalidated
        AND pg_get_constraintdef(constraint_definition.oid, true) = expected_constraint.constraint_definition
    )
  );
'@
}

function Get-EnterpriseAuthActionTokenActiveIndexSql {
  @'
SELECT EXISTS (
  SELECT 1
  FROM pg_index index_definition
  JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
  JOIN pg_class target_table ON target_table.oid = index_definition.indrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'auth_action_tokens'
    AND index_relation.relname = 'auth_action_tokens_active_user_purpose_key'
    AND index_definition.indisunique
    AND index_definition.indisvalid
    AND index_definition.indisready
    AND index_definition.indislive
    AND NOT index_definition.indisprimary
    AND index_definition.indexprs IS NULL
    AND index_definition.indnkeyatts = 3
    AND index_definition.indnatts = 3
    AND string_to_array(index_definition.indkey::text, ' ')::smallint[] = ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = target_table.oid AND attname = 'tenant_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = target_table.oid AND attname = 'user_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = target_table.oid AND attname = 'purpose')
    ]::smallint[]
    AND regexp_replace(
      lower(pg_get_expr(index_definition.indpred, index_definition.indrelid)),
      '[^a-z_]+',
      '',
      'g'
    ) = 'consumed_atisnullandrevoked_atisnull'
);
'@
}

function Get-EnterpriseAuthActionTokenSupportingIndexesSql {
  @'
SELECT
  EXISTS (
    SELECT 1
    FROM pg_index index_definition
    JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
    WHERE index_definition.indrelid = 'public.auth_action_tokens'::regclass
      AND index_relation.relname = 'auth_action_tokens_tenant_user_purpose_created_idx'
      AND NOT index_definition.indisunique
      AND index_definition.indisvalid
      AND index_definition.indisready
      AND index_definition.indislive
      AND NOT index_definition.indisprimary
      AND index_definition.indexprs IS NULL
      AND index_definition.indpred IS NULL
      AND index_definition.indnkeyatts = 4
      AND index_definition.indnatts = 4
      AND string_to_array(index_definition.indkey::text, ' ')::smallint[] = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'tenant_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'user_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'purpose'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'created_at')
      ]::smallint[]
      AND string_to_array(index_definition.indoption::text, ' ')::smallint[] = ARRAY[0, 0, 0, 3]::smallint[]
  )
  AND EXISTS (
    SELECT 1
    FROM pg_index index_definition
    JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
    WHERE index_definition.indrelid = 'public.auth_action_tokens'::regclass
      AND index_relation.relname = 'auth_action_tokens_expires_at_idx'
      AND NOT index_definition.indisunique
      AND index_definition.indisvalid
      AND index_definition.indisready
      AND index_definition.indislive
      AND NOT index_definition.indisprimary
      AND index_definition.indexprs IS NULL
      AND index_definition.indpred IS NULL
      AND index_definition.indnkeyatts = 1
      AND index_definition.indnatts = 1
      AND string_to_array(index_definition.indkey::text, ' ')::smallint[] = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = index_definition.indrelid AND attname = 'expires_at')
      ]::smallint[]
      AND string_to_array(index_definition.indoption::text, ' ')::smallint[] = ARRAY[0]::smallint[]
  );
'@
}

function Get-EnterpriseBusinessSemanticsIntegritySql {
  @'
WITH semantic_tables(table_name) AS (
  VALUES
    ('value_definitions'),
    ('value_versions'),
    ('value_metrics'),
    ('value_constraints'),
    ('strategies'),
    ('strategy_value_versions'),
    ('objectives'),
    ('objective_value_versions'),
    ('objective_role_assignments'),
    ('objective_relations'),
    ('metric_definitions'),
    ('objective_metric_definitions'),
    ('process_definitions'),
    ('process_versions'),
    ('process_nodes'),
    ('tasks'),
    ('task_dependencies'),
    ('deliverables'),
    ('acceptances'),
    ('evidence'),
    ('metric_observations'),
    ('evidence_links'),
    ('metric_observation_evidence'),
    ('deliverable_evidence'),
    ('acceptance_evidence')
), process_reference_tables(table_name) AS (
  VALUES
    ('objectives'),
    ('process_definitions'),
    ('process_versions'),
    ('process_nodes'),
    ('tasks'),
    ('deliverables'),
    ('acceptances'),
    ('evidence'),
    ('deliverable_evidence'),
    ('acceptance_evidence')
), expected_acl(table_name, grantee, privilege_type, is_grantable) AS (
  SELECT
    semantic_table.table_name,
    expected_privilege.grantee,
    expected_privilege.privilege_type,
    false
  FROM semantic_tables semantic_table
  CROSS JOIN (
    VALUES
      ('enterprise_agent_app'::text, 'SELECT'::text),
      ('enterprise_agent_admin'::text, 'SELECT'::text),
      ('enterprise_agent_admin'::text, 'INSERT'::text),
      ('enterprise_agent_admin'::text, 'UPDATE'::text),
      ('enterprise_agent_admin'::text, 'DELETE'::text)
  ) expected_privilege(grantee, privilege_type)
  UNION ALL
  SELECT
    process_reference_table.table_name,
    'enterprise_agent_process'::text,
    'SELECT'::text,
    false
  FROM process_reference_tables process_reference_table
  UNION ALL
  SELECT
    'tasks'::text,
    'enterprise_agent_tool_gateway'::text,
    'SELECT'::text,
    false
  UNION ALL
  SELECT *
  FROM (
    VALUES
      ('tasks'::text, 'enterprise_agent_employee_insights'::text, 'SELECT'::text, false),
      ('deliverables'::text, 'enterprise_agent_employee_insights'::text, 'SELECT'::text, false),
      ('evidence'::text, 'enterprise_agent_employee_insights'::text, 'SELECT'::text, false),
      ('tasks'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false),
      ('deliverables'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false),
      ('acceptances'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false),
      ('evidence'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false),
      ('evidence_links'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false),
      ('deliverable_evidence'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false),
      ('deliverable_evidence'::text, 'enterprise_agent_task_executor'::text, 'INSERT'::text, false),
      ('acceptance_evidence'::text, 'enterprise_agent_task_executor'::text, 'SELECT'::text, false)
  ) capability_acl(table_name, grantee, privilege_type, is_grantable)
), actual_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    table_acl.privilege_type::text AS privilege_type,
    table_acl.is_grantable
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN semantic_tables semantic_table ON semantic_table.table_name = target_table.relname
  CROSS JOIN LATERAL aclexplode(
    COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
  ) table_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND table_acl.grantee <> target_table.relowner
), expected_policies(table_name, policy_name, role_names, command, permissive) AS (
  SELECT
    semantic_table.table_name,
    expected_policy.policy_name,
    expected_policy.role_names,
    expected_policy.command,
    expected_policy.permissive
  FROM semantic_tables semantic_table
  CROSS JOIN (
    VALUES
      ('tenant_isolation'::text, ARRAY['PUBLIC']::text[], '*'::text, false),
      (
        'enterprise_agent_access'::text,
        ARRAY['enterprise_agent_app']::text[],
        'r'::text,
        true
      ),
      (
        'enterprise_agent_admin_access'::text,
        ARRAY['enterprise_agent_admin']::text[],
        '*'::text,
        true
      )
  ) expected_policy(policy_name, role_names, command, permissive)
  UNION ALL
  SELECT
    process_reference_table.table_name,
    'enterprise_agent_process_read'::text,
    ARRAY['enterprise_agent_process']::text[],
    'r'::text,
    true
  FROM process_reference_tables process_reference_table
  UNION ALL
  SELECT
    'tasks'::text,
    'enterprise_agent_process_task_link'::text,
    ARRAY['enterprise_agent_process']::text[],
    'w'::text,
    true
  UNION ALL
  SELECT
    'tasks'::text,
    tool_policy.policy_name,
    ARRAY['enterprise_agent_tool_gateway']::text[],
    'r'::text,
    tool_policy.permissive
  FROM (
    VALUES
      ('tool_gateway_parent_read'::text, true),
      ('tool_gateway_parent_tenant'::text, false)
  ) tool_policy(policy_name, permissive)
  UNION ALL
  SELECT *
  FROM (
    VALUES
      ('objective_role_assignments'::text, 'enterprise_agent_process_read'::text,
        ARRAY['enterprise_agent_process']::text[], 'r'::text, true),
      ('tasks'::text, 'employee_insights_task_select'::text,
        ARRAY['enterprise_agent_employee_insights']::text[], 'r'::text, true),
      ('deliverables'::text, 'employee_insights_deliverable_select'::text,
        ARRAY['enterprise_agent_employee_insights']::text[], 'r'::text, true),
      ('evidence'::text, 'employee_insights_evidence_select'::text,
        ARRAY['enterprise_agent_employee_insights']::text[], 'r'::text, true),
      ('tasks'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true),
      ('tasks'::text, 'employee_task_executor_update'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'w'::text, true),
      ('deliverables'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true),
      ('deliverables'::text, 'employee_task_executor_update'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'w'::text, true),
      ('acceptances'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true),
      ('evidence'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true),
      ('evidence_links'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true),
      ('deliverable_evidence'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true),
      ('deliverable_evidence'::text, 'employee_task_executor_insert'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'a'::text, true),
      ('acceptance_evidence'::text, 'employee_task_executor_select'::text,
        ARRAY['enterprise_agent_task_executor']::text[], 'r'::text, true)
  ) capability_policy(table_name, policy_name, role_names, command, permissive)
), actual_policies AS (
  SELECT
    target_table.relname::text AS table_name,
    policy_definition.polname::text AS policy_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS role_names,
    policy_definition.polcmd::text AS command,
    policy_definition.polpermissive AS permissive
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN semantic_tables semantic_table ON semantic_table.table_name = target_table.relname
  WHERE target_schema.nspname = 'public'
), expected_constraints(table_name, constraint_name, key_arity) AS (
  VALUES
    ('tasks', 'tasks_objective_value_fkey', 8),
    ('tasks', 'tasks_process_definition_fkey', 3),
    ('tasks', 'tasks_process_version_fkey', 4),
    ('tasks', 'tasks_process_node_fkey', 6),
    ('agent_runs', 'agent_runs_tenant_task_id_fkey', 2)
), expected_triggers(table_name, trigger_name) AS (
  VALUES
    ('tasks', 'tasks_reference_eligibility_trigger'),
    ('tasks', 'tasks_completion_integrity_trigger'),
    ('deliverables', 'deliverables_task_completion_reverse_trigger'),
    ('deliverable_evidence', 'deliverable_evidence_task_completion_reverse_trigger'),
    ('acceptances', 'acceptances_task_completion_reverse_trigger'),
    ('acceptance_evidence', 'acceptance_evidence_task_completion_reverse_trigger'),
    ('process_definitions', 'process_definitions_active_current_version_trigger'),
    ('process_versions', 'process_versions_active_definition_reverse_trigger'),
    ('objectives', 'objectives_parent_cycle_trigger'),
    ('task_dependencies', 'task_dependencies_cycle_trigger'),
    ('agent_runs', 'agent_runs_task_id_immutability_trigger')
), expected_indexes(table_name, index_name, is_unique) AS (
  VALUES
    ('process_versions', 'process_versions_one_published_per_definition_idx', true),
    ('objectives', 'objectives_one_current_per_code_idx', true),
    ('tasks', 'tasks_one_current_per_code_idx', true),
    ('tasks', 'tasks_process_idx', false),
    ('agent_runs', 'agent_runs_tenant_task_id_idx', false)
)
SELECT
  (SELECT count(*) FROM semantic_tables) = 25
  AND (
    SELECT count(*)
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN semantic_tables semantic_table ON semantic_table.table_name = target_table.relname
    WHERE target_schema.nspname = 'public'
      AND target_table.relkind IN ('r', 'p')
      AND target_table.relrowsecurity
      AND target_table.relforcerowsecurity
  ) = 25
  AND EXISTS (
    SELECT 1
    FROM pg_attribute attribute_definition
    WHERE attribute_definition.attrelid = 'public.agent_runs'::regclass
      AND attribute_definition.attname = 'task_id'
      AND attribute_definition.atttypid = 'uuid'::regtype
      AND attribute_definition.attnum > 0
      AND NOT attribute_definition.attisdropped
  )
  AND NOT EXISTS (
    SELECT * FROM actual_acl
    EXCEPT
    SELECT * FROM expected_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_acl
    EXCEPT
    SELECT * FROM actual_acl
  )
  AND NOT EXISTS (
    SELECT * FROM actual_policies
    EXCEPT
    SELECT * FROM expected_policies
  )
  AND NOT EXISTS (
    SELECT * FROM expected_policies
    EXCEPT
    SELECT * FROM actual_policies
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected_constraints expected_constraint
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_definition
      JOIN pg_class target_table ON target_table.oid = constraint_definition.conrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = expected_constraint.table_name
        AND constraint_definition.conname = expected_constraint.constraint_name
        AND constraint_definition.contype = 'f'
        AND constraint_definition.convalidated
        AND cardinality(constraint_definition.conkey) = expected_constraint.key_arity
        AND cardinality(constraint_definition.confkey) = expected_constraint.key_arity
        AND constraint_definition.confdeltype = 'r'
        AND constraint_definition.confupdtype = 'c'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected_triggers expected_trigger
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_definition
      JOIN pg_class target_table ON target_table.oid = trigger_definition.tgrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = expected_trigger.table_name
        AND trigger_definition.tgname = expected_trigger.trigger_name
        AND NOT trigger_definition.tgisinternal
        AND trigger_definition.tgenabled <> 'D'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected_indexes expected_index
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_index index_definition
      JOIN pg_class target_table ON target_table.oid = index_definition.indrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = expected_index.table_name
        AND index_relation.relname = expected_index.index_name
        AND index_definition.indisunique = expected_index.is_unique
        AND index_definition.indisvalid
        AND index_definition.indisready
        AND index_definition.indislive
    )
  );
'@
}

function Get-EnterpriseToolGatewayIntegritySql {
  @'
WITH expected_tables(table_name, critical_column) AS (
  VALUES
    ('tool_definitions', 'current_version_id'),
    ('tool_versions', 'configuration_hash'),
    ('tool_invocations', 'provider_dispatch_allowed'),
    ('tool_invocation_commands', 'request_hash'),
    ('tool_execution_receipts', 'receipt_hash'),
    ('tool_dns_resolution_proofs', 'pinned_ip_address'),
    ('tool_reconciliation_attempts', 'input_hash'),
    ('tool_reconciliation_receipts', 'receipt_hash'),
    ('tool_compensation_bindings', 'request_hash')
), expected_triggers(trigger_name) AS (
  VALUES
    ('tool_invocations_insert_guard_trigger'),
    ('tool_invocations_transition_guard_trigger'),
    ('tool_invocations_command_coverage_trigger'),
    ('tool_invocation_commands_insert_guard_trigger'),
    ('tool_invocation_commands_transition_trigger'),
    ('tool_execution_receipts_insert_guard_trigger'),
    ('tool_dns_resolution_proofs_insert_guard_trigger'),
    ('tool_reconciliation_attempts_insert_guard_trigger'),
    ('tool_reconciliation_receipts_insert_guard_trigger'),
    ('tool_reconciliation_attempts_append_only_trigger'),
    ('tool_reconciliation_receipts_append_only_trigger'),
    ('tool_invocations_reconciliation_guard_trigger'),
    ('tool_invocations_reconciliation_command_trigger'),
    ('tool_invocations_compensation_insert_guard_trigger'),
    ('tool_compensation_bindings_insert_guard_trigger'),
    ('tool_invocation_commands_compensation_binding_trigger'),
    ('tool_compensation_bindings_append_only_trigger'),
    ('tool_versions_compensation_publication_guard_trigger'),
    ('tool_invocations_compensation_reconciliation_trigger')
)
SELECT
  (SELECT count(*) FROM expected_tables) = 9
  AND NOT EXISTS (
    SELECT 1
    FROM expected_tables expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_class target_table
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      JOIN pg_attribute target_column ON target_column.attrelid = target_table.oid
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = expected.table_name
        AND target_table.relkind = 'r'
        AND target_table.relrowsecurity
        AND target_table.relforcerowsecurity
        AND target_column.attname = expected.critical_column
        AND target_column.attnum > 0
        AND NOT target_column.attisdropped
    )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'enterprise_agent_tool_gateway'
      AND NOT rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolinherit
      AND NOT rolbypassrls
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected_tables expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected.table_name
        AND policy.policyname = 'tool_tenant_isolation'
        AND policy.permissive = 'RESTRICTIVE'
        AND policy.cmd = 'ALL'
        AND policy.roles @> ARRAY[
          'enterprise_agent_app',
          'enterprise_agent_admin',
          'enterprise_agent_tool_gateway'
        ]::name[]
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected.table_name
        AND policy.policyname = 'tool_admin_access'
        AND policy.permissive = 'PERMISSIVE'
        AND policy.cmd = 'ALL'
        AND policy.roles = ARRAY['enterprise_agent_admin']::name[]
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected.table_name
        AND policy.policyname = 'tool_gateway_access'
        AND policy.permissive = 'PERMISSIVE'
        AND policy.cmd = 'ALL'
      AND policy.roles = ARRAY['enterprise_agent_tool_gateway']::name[]
    )
  )
  AND (
    SELECT count(*)
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename IN (
        'tool_reconciliation_attempts',
        'tool_reconciliation_receipts'
      )
      AND policy.policyname IN (
        'tool_reconciliation_attempts_requester_read',
        'tool_reconciliation_receipts_requester_read'
      )
      AND policy.permissive = 'PERMISSIVE'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['enterprise_agent_app']::name[]
      AND policy.qual LIKE '%requester_user_id%'
      AND policy.qual LIKE '%app.user_id%'
  ) = 2
  AND EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'outbox_events'
      AND policy.policyname = 'tool_gateway_reconciliation_outbox_read'
      AND policy.permissive = 'PERMISSIVE'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['enterprise_agent_tool_gateway']::name[]
      AND policy.qual LIKE '%ToolInvocation.ReconciliationRequested%'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'outbox_events'
      AND policy.policyname = 'tool_gateway_reconciliation_outbox_tenant'
      AND policy.permissive = 'RESTRICTIVE'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['enterprise_agent_tool_gateway']::name[]
      AND policy.qual LIKE '%app.tenant_id%'
  )
  AND has_table_privilege(
    'enterprise_agent_admin', 'public.tool_definitions', 'SELECT,INSERT,UPDATE'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_admin', 'public.tool_definitions', 'DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_admin', 'public.tool_versions', 'SELECT,INSERT,UPDATE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_invocations', 'SELECT,INSERT,UPDATE'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_invocations', 'DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_invocation_commands', 'SELECT,INSERT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_invocation_commands', 'UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_execution_receipts', 'SELECT,INSERT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_execution_receipts', 'UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway',
    'public.tool_compensation_bindings',
    'SELECT,INSERT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway',
    'public.tool_compensation_bindings',
    'UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_app', 'public.tool_compensation_bindings', 'SELECT'
  )
  AND has_table_privilege(
    'enterprise_agent_admin', 'public.tool_compensation_bindings', 'SELECT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_admin',
    'public.tool_compensation_bindings',
    'INSERT,UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.tool_dns_resolution_proofs', 'SELECT,INSERT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_app', 'public.tool_dns_resolution_proofs', 'SELECT'
  )
  AND has_table_privilege(
    'enterprise_agent_app', 'public.tool_reconciliation_attempts', 'SELECT'
  )
  AND has_table_privilege(
    'enterprise_agent_app', 'public.tool_reconciliation_receipts', 'SELECT'
  )
  AND has_table_privilege(
    'enterprise_agent_admin', 'public.tool_reconciliation_attempts', 'SELECT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_admin',
    'public.tool_reconciliation_attempts',
    'INSERT,UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_admin', 'public.tool_reconciliation_receipts', 'SELECT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_admin',
    'public.tool_reconciliation_receipts',
    'INSERT,UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway',
    'public.tool_reconciliation_attempts',
    'SELECT,INSERT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway',
    'public.tool_reconciliation_attempts',
    'UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway',
    'public.tool_reconciliation_receipts',
    'SELECT,INSERT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway',
    'public.tool_reconciliation_receipts',
    'UPDATE,DELETE'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.audit_events', 'INSERT'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.outbox_events', 'INSERT'
  )
  AND has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.outbox_events', 'SELECT'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_tool_gateway', 'public.outbox_events', 'UPDATE,DELETE'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected_triggers expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_definition
      JOIN pg_class target_table ON target_table.oid = trigger_definition.tgrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND trigger_definition.tgname = expected.trigger_name
        AND NOT trigger_definition.tgisinternal
        AND trigger_definition.tgenabled <> 'D'
    )
  );
'@
}

function Get-EnterpriseAiEvaluationIntegritySql {
  @'
WITH protected_tables(table_name) AS (
  VALUES
    ('ai_evaluation_datasets'),
    ('ai_evaluation_dataset_versions'),
    ('ai_evaluation_thresholds'),
    ('ai_evaluation_cases'),
    ('ai_evaluation_case_evidence'),
    ('ai_evaluation_annotations'),
    ('ai_evaluation_annotation_evidence'),
    ('ai_evaluation_review_evidence'),
    ('ai_evaluation_answer_feedback_sources'),
    ('ai_evaluation_runner_attestations'),
    ('ai_evaluation_runners'),
    ('ai_evaluation_runs'),
    ('ai_evaluation_case_results'),
    ('ai_evaluation_case_result_evidence'),
    ('ai_evaluation_metric_results'),
    ('ai_evaluation_metric_result_evidence'),
    ('ai_evaluation_verification_evidence'),
    ('ai_evaluation_bad_cases'),
    ('ai_evaluation_bad_case_evidence'),
    ('ai_evaluation_release_checks')
), runner_select_tables(table_name) AS (
  VALUES
    ('ai_evaluation_runner_attestations'),
    ('ai_evaluation_runners'),
    ('ai_evaluation_dataset_versions'),
    ('ai_evaluation_thresholds'),
    ('ai_evaluation_cases')
), runner_result_tables(table_name) AS (
  VALUES
    ('ai_evaluation_case_results'),
    ('ai_evaluation_metric_results'),
    ('ai_evaluation_case_result_evidence'),
    ('ai_evaluation_metric_result_evidence')
), expected_acl(table_name, grantee, privilege_type, is_grantable) AS (
  SELECT
    protected_table.table_name,
    'enterprise_agent_admin'::text,
    privilege.privilege_type,
    false
  FROM protected_tables protected_table
  CROSS JOIN (
    VALUES ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text)
  ) privilege(privilege_type)
  WHERE (
    protected_table.table_name = 'ai_evaluation_answer_feedback_sources'
    AND privilege.privilege_type = 'SELECT'
  )
  OR (
    protected_table.table_name = 'ai_evaluation_runner_attestations'
    AND privilege.privilege_type IN ('SELECT', 'INSERT')
  )
  OR protected_table.table_name NOT IN (
    'ai_evaluation_answer_feedback_sources',
    'ai_evaluation_runner_attestations'
  )
  UNION ALL
  SELECT
    runner_select_table.table_name,
    'enterprise_agent_evaluation_runner'::text,
    'SELECT'::text,
    false
  FROM runner_select_tables runner_select_table
  UNION ALL
  SELECT
    'ai_evaluation_runs'::text,
    'enterprise_agent_evaluation_runner'::text,
    privilege.privilege_type,
    false
  FROM (VALUES ('SELECT'::text), ('UPDATE'::text)) privilege(privilege_type)
  UNION ALL
  SELECT
    runner_result_table.table_name,
    'enterprise_agent_evaluation_runner'::text,
    privilege.privilege_type,
    false
  FROM runner_result_tables runner_result_table
  CROSS JOIN (
    VALUES ('SELECT'::text), ('INSERT'::text)
  ) privilege(privilege_type)
  UNION ALL
  SELECT
    'ai_evaluation_answer_feedback_sources'::text,
    'enterprise_agent_feedback_projector'::text,
    privilege.privilege_type,
    false
  FROM (VALUES ('SELECT'::text), ('INSERT'::text)) privilege(privilege_type)
  UNION ALL
  SELECT
    'ai_evaluation_bad_cases'::text,
    'enterprise_agent_feedback_projector'::text,
    privilege.privilege_type,
    false
  FROM (VALUES ('SELECT'::text), ('INSERT'::text)) privilege(privilege_type)
), actual_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    table_acl.privilege_type::text AS privilege_type,
    table_acl.is_grantable
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN protected_tables protected_table ON protected_table.table_name = target_table.relname
  CROSS JOIN LATERAL aclexplode(
    COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
  ) table_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND table_acl.grantee <> target_table.relowner
), expected_policies(
  table_name,
  policy_name,
  role_names,
  command,
  permissive
) AS (
  SELECT
    protected_table.table_name,
    'ai_evaluation_tenant_isolation'::text,
    CASE
      WHEN protected_table.table_name = 'ai_evaluation_runner_attestations'
        THEN ARRAY[
          'enterprise_agent_admin',
          'enterprise_agent_evaluation_runner'
        ]::text[]
      WHEN protected_table.table_name = 'ai_evaluation_answer_feedback_sources'
        THEN ARRAY[
          'enterprise_agent_admin',
          'enterprise_agent_app',
          'enterprise_agent_evaluation_runner',
          'enterprise_agent_feedback_projector'
        ]::text[]
      ELSE ARRAY[
        'enterprise_agent_admin',
        'enterprise_agent_app',
        'enterprise_agent_evaluation_runner'
      ]::text[]
    END,
    '*'::text,
    false
  FROM protected_tables protected_table
  UNION ALL
  SELECT
    protected_table.table_name,
    'ai_evaluation_admin_access'::text,
    ARRAY['enterprise_agent_admin']::text[],
    '*'::text,
    true
  FROM protected_tables protected_table
  UNION ALL
  SELECT * FROM (
    VALUES
      ('ai_evaluation_runners',
        'ai_evaluation_runner_registry_read',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        'r'::text,
        true),
      ('ai_evaluation_runner_attestations',
        'ai_evaluation_runner_attestation_read',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        'r'::text,
        true),
      ('ai_evaluation_dataset_versions',
        'ai_evaluation_runner_dataset_read',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        'r'::text,
        true),
      ('ai_evaluation_thresholds',
        'ai_evaluation_runner_threshold_read',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        'r'::text,
        true),
      ('ai_evaluation_cases',
        'ai_evaluation_runner_case_read',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        'r'::text,
        true),
      ('ai_evaluation_runs',
        'ai_evaluation_runner_run_access',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        '*'::text,
        true),
      ('ai_evaluation_case_results',
        'ai_evaluation_runner_case_result_access',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        '*'::text,
        true),
      ('ai_evaluation_metric_results',
        'ai_evaluation_runner_metric_result_access',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        '*'::text,
        true),
      ('ai_evaluation_case_result_evidence',
        'ai_evaluation_runner_case_result_evidence_access',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        '*'::text,
        true),
      ('ai_evaluation_metric_result_evidence',
        'ai_evaluation_runner_metric_evidence_access',
        ARRAY['enterprise_agent_evaluation_runner']::text[],
        '*'::text,
        true),
      ('ai_evaluation_answer_feedback_sources',
        'ai_evaluation_feedback_projector_read',
        ARRAY['enterprise_agent_feedback_projector']::text[],
        'r'::text,
        true),
      ('ai_evaluation_answer_feedback_sources',
        'ai_evaluation_feedback_projector_insert',
        ARRAY['enterprise_agent_feedback_projector']::text[],
        'a'::text,
        true),
      ('ai_evaluation_bad_cases',
        'ai_evaluation_feedback_projector_access',
        ARRAY['enterprise_agent_feedback_projector']::text[],
        'r'::text,
        true),
      ('ai_evaluation_bad_cases',
        'ai_evaluation_feedback_projector_insert',
        ARRAY['enterprise_agent_feedback_projector']::text[],
        'a'::text,
        true)
  ) runner_policy(table_name, policy_name, role_names, command, permissive)
), actual_policies AS (
  SELECT
    target_table.relname::text AS table_name,
    policy_definition.polname::text AS policy_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS role_names,
    policy_definition.polcmd::text AS command,
    policy_definition.polpermissive AS permissive
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN protected_tables protected_table ON protected_table.table_name = target_table.relname
  WHERE target_schema.nspname = 'public'
), expected_triggers(table_name, trigger_name) AS (
  VALUES
    ('ai_evaluation_dataset_versions',
      'ai_evaluation_dataset_versions_mutation_guard'),
    ('ai_evaluation_dataset_versions',
      'ai_evaluation_dataset_seal_trigger'),
    ('ai_evaluation_runs',
      'ai_evaluation_runs_mutation_guard'),
    ('ai_evaluation_runs',
      'ai_evaluation_runs_results_trigger'),
    ('ai_evaluation_case_results',
      'ai_evaluation_case_results_insert_guard'),
    ('ai_evaluation_metric_results',
      'ai_evaluation_metric_results_insert_guard'),
    ('ai_evaluation_runner_attestations',
      'ai_evaluation_runner_attestations_insert_guard'),
    ('ai_evaluation_runner_attestations',
      'ai_evaluation_runner_attestations_append_only'),
    ('ai_evaluation_runner_attestations',
      'ai_evaluation_runner_attestations_side_effects'),
    ('ai_evaluation_answer_feedback_sources',
      'ai_evaluation_answer_feedback_sources_binding_guard'),
    ('ai_evaluation_answer_feedback_sources',
      'ai_evaluation_answer_feedback_sources_append_only'),
    ('ai_evaluation_bad_cases',
      'ai_evaluation_answer_feedback_pair_required'),
    ('ai_evaluation_release_checks',
      'ai_evaluation_release_checks_append_only')
), runner_bound_policies(policy_name) AS (
  VALUES
    ('ai_evaluation_runner_attestation_read'),
    ('ai_evaluation_runner_run_access'),
    ('ai_evaluation_runner_case_result_access'),
    ('ai_evaluation_runner_metric_result_access'),
    ('ai_evaluation_runner_case_result_evidence_access'),
    ('ai_evaluation_runner_metric_evidence_access')
), expected_feedback_functions(signature, security_definer) AS (
  VALUES
    ('public.ai_evaluation_sanitize_feedback_input(text)', false),
    ('public.ai_evaluation_derive_answer_feedback_source(uuid,uuid,uuid)', true),
    ('public.ai_evaluation_answer_feedback_source_guard()', true),
    ('public.ai_evaluation_answer_feedback_pair_guard()', true),
    ('public.project_not_helpful_answer_feedback_bad_case(uuid)', true)
), actual_feedback_functions AS (
  SELECT
    expected.signature,
    function_definition.oid,
    pg_get_userbyid(function_definition.proowner)::text AS owner_name,
    function_definition.prosecdef AS security_definer
  FROM expected_feedback_functions expected
  LEFT JOIN pg_proc function_definition
    ON function_definition.oid = to_regprocedure(expected.signature)
), expected_feedback_function_acl(signature, grantee, privilege_type) AS (
  VALUES
    ('public.project_not_helpful_answer_feedback_bad_case(uuid)',
      'enterprise_agent_app', 'EXECUTE'),
    ('public.project_not_helpful_answer_feedback_bad_case(uuid)',
      'enterprise_agent_admin', 'EXECUTE')
), actual_feedback_function_acl(signature, grantee, privilege_type) AS (
  SELECT
    actual.signature,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text,
    function_acl.privilege_type::text
  FROM actual_feedback_functions actual
  JOIN pg_proc function_definition ON function_definition.oid = actual.oid
  CROSS JOIN LATERAL aclexplode(
    COALESCE(
      function_definition.proacl,
      acldefault('f', function_definition.proowner)
    )
  ) function_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
  WHERE function_acl.grantee <> function_definition.proowner
)
SELECT
  (SELECT count(*) FROM protected_tables) = 20
  AND (
    SELECT count(*)
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN protected_tables protected_table ON protected_table.table_name = target_table.relname
    WHERE target_schema.nspname = 'public'
      AND target_table.relkind IN ('r', 'p')
      AND target_table.relrowsecurity
      AND target_table.relforcerowsecurity
  ) = 20
  AND EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'enterprise_agent_evaluation_runner'
      AND NOT rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolinherit
      AND NOT rolreplication
      AND NOT rolbypassrls
  )
  AND (
    SELECT count(*)
    FROM actual_feedback_functions
    WHERE oid IS NOT NULL
      AND owner_name = 'enterprise_agent_feedback_projector'
      AND security_definer = (
        SELECT expected.security_definer
        FROM expected_feedback_functions expected
        WHERE expected.signature = actual_feedback_functions.signature
      )
  ) = 5
  AND NOT EXISTS (
    SELECT * FROM actual_feedback_function_acl
    EXCEPT
    SELECT * FROM expected_feedback_function_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_feedback_function_acl
    EXCEPT
    SELECT * FROM actual_feedback_function_acl
  )
  AND NOT EXISTS (
    SELECT * FROM actual_acl
    EXCEPT
    SELECT * FROM expected_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_acl
    EXCEPT
    SELECT * FROM actual_acl
  )
  AND NOT EXISTS (
    SELECT * FROM actual_policies
    EXCEPT
    SELECT * FROM expected_policies
  )
  AND NOT EXISTS (
    SELECT * FROM expected_policies
    EXCEPT
    SELECT * FROM actual_policies
  )
  AND NOT EXISTS (
    SELECT 1
    FROM protected_tables protected_table
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = protected_table.table_name
        AND policy_definition.polname = 'ai_evaluation_tenant_isolation'
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid)
          = '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid)
          = '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_policy policy_definition
      JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = protected_table.table_name
        AND policy_definition.polname = 'ai_evaluation_admin_access'
        AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) = 'true'
        AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) = 'true'
    )
  )
  AND (
    SELECT count(*)
    FROM pg_policy policy_definition
    JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN runner_bound_policies expected
      ON expected.policy_name = policy_definition.polname
    WHERE target_schema.nspname = 'public'
      AND (
        COALESCE(pg_get_expr(policy_definition.polqual, policy_definition.polrelid), '')
        || COALESCE(
          pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid),
          ''
        )
      ) LIKE '%app.evaluation_runner_id%'
  ) = 6
  AND EXISTS (
    SELECT 1
    FROM pg_policy policy_definition
    JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    WHERE target_schema.nspname = 'public'
      AND target_table.relname = 'ai_evaluation_runs'
      AND policy_definition.polname = 'ai_evaluation_runner_run_access'
      AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid)
        LIKE '%result_submitted_by_runner_id%runner_id%'
      AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid)
        LIKE '%verified_by_user_id%IS NULL%'
      AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid)
        LIKE '%NOT runner_evidence_verified%'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expected_triggers expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_definition
      JOIN pg_class target_table ON target_table.oid = trigger_definition.tgrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = expected.table_name
        AND trigger_definition.tgname = expected.trigger_name
        AND NOT trigger_definition.tgisinternal
        AND trigger_definition.tgenabled <> 'D'
    )
  )
  AND (
    SELECT count(*)
    FROM (
      SELECT
        target_table.relname::text AS table_name,
        table_acl.privilege_type::text AS privilege_type,
        table_acl.is_grantable
      FROM pg_class target_table
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
      ) table_acl
      JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
      WHERE target_schema.nspname = 'public'
        AND target_table.relname IN ('audit_events', 'outbox_events')
        AND grantee_role.rolname = 'enterprise_agent_evaluation_runner'
        AND table_acl.privilege_type = 'INSERT'
        AND NOT table_acl.is_grantable
    ) side_effect_acl
  ) = 2
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
  AND NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute_definition
    JOIN pg_class target_table ON target_table.oid = attribute_definition.attrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    CROSS JOIN LATERAL aclexplode(
      CASE
        WHEN COALESCE(cardinality(attribute_definition.attacl), 0) > 0
          THEN attribute_definition.attacl
        ELSE acldefault('c', target_table.relowner)
      END
    ) column_acl
    JOIN pg_roles grantee_role ON grantee_role.oid = column_acl.grantee
    WHERE target_schema.nspname = 'public'
      AND grantee_role.rolname = 'enterprise_agent_evaluation_runner'
      AND attribute_definition.attnum > 0
      AND NOT attribute_definition.attisdropped
  );
'@
}

function Get-EnterpriseAuditChainIntegritySql {
  @'
WITH required_columns(column_name) AS (
  VALUES
    ('chain_sequence'),
    ('previous_hash'),
    ('event_hash')
), required_triggers(trigger_name) AS (
  VALUES
    ('audit_events_assign_chain'),
    ('audit_events_append_only'),
    ('audit_events_reject_truncate')
), ordered_events AS (
  SELECT
    audit.*,
    row_number() OVER (
      PARTITION BY audit."tenant_id"
      ORDER BY audit."chain_sequence"
    )::bigint AS expected_sequence,
    lag(audit."event_hash") OVER (
      PARTITION BY audit."tenant_id"
      ORDER BY audit."chain_sequence"
    ) AS expected_previous_hash
  FROM public."audit_events" audit
), invalid_events AS (
  SELECT ordered."id"
  FROM ordered_events ordered
  WHERE ordered."chain_sequence" <> ordered.expected_sequence
    OR ordered."previous_hash" IS DISTINCT FROM ordered.expected_previous_hash
    OR ordered."event_hash" <> encode(
      digest(
        convert_to(
          public.audit_event_chain_payload(
            ordered."id",
            ordered."tenant_id",
            ordered."actor_type",
            ordered."actor_id",
            ordered."action",
            ordered."resource_type",
            ordered."resource_id",
            ordered."metadata",
            ordered."occurred_at",
            ordered."chain_sequence",
            ordered."previous_hash"
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM required_columns required
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_attribute attribute_definition
      JOIN pg_class target_table ON target_table.oid = attribute_definition.attrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = 'audit_events'
        AND attribute_definition.attname = required.column_name
        AND attribute_definition.attnum > 0
        AND NOT attribute_definition.attisdropped
        AND attribute_definition.attnotnull = (required.column_name <> 'previous_hash')
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM required_triggers required
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_definition
      JOIN pg_class target_table ON target_table.oid = trigger_definition.tgrelid
      JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
      WHERE target_schema.nspname = 'public'
        AND target_table.relname = 'audit_events'
        AND trigger_definition.tgname = required.trigger_name
        AND trigger_definition.tgenabled <> 'D'
        AND NOT trigger_definition.tgisinternal
    )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc function_definition
    JOIN pg_namespace function_schema ON function_schema.oid = function_definition.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_definition.proname = 'verify_audit_event_chain'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    JOIN pg_class target_table ON target_table.oid = constraint_definition.conrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    WHERE target_schema.nspname = 'public'
      AND target_table.relname = 'audit_events'
      AND constraint_definition.conname = 'audit_events_tenant_chain_sequence_key'
      AND constraint_definition.contype = 'u'
      AND constraint_definition.convalidated
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    JOIN pg_class target_table ON target_table.oid = constraint_definition.conrelid
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    WHERE target_schema.nspname = 'public'
      AND target_table.relname = 'audit_events'
      AND constraint_definition.conname = 'audit_events_tenant_event_hash_key'
      AND constraint_definition.contype = 'u'
      AND constraint_definition.convalidated
  )
  AND NOT has_table_privilege(
    'enterprise_agent_app',
    'public.audit_events',
    'UPDATE,DELETE,TRUNCATE'
  )
  AND NOT has_table_privilege(
    'enterprise_agent_admin',
    'public.audit_events',
    'UPDATE,DELETE,TRUNCATE'
  )
  AND NOT EXISTS (SELECT 1 FROM invalid_events);
'@
}

function Get-EnterpriseAgentRunStreamIntegritySql {
  @'
WITH enum_values AS (
  SELECT array_agg(enum_definition.enumlabel::text ORDER BY enum_definition.enumsortorder) AS values
  FROM pg_type type_definition
  JOIN pg_namespace type_schema ON type_schema.oid = type_definition.typnamespace
  JOIN pg_enum enum_definition ON enum_definition.enumtypid = type_definition.oid
  WHERE type_schema.nspname = 'public'
    AND type_definition.typname = 'AgentRunStreamEventType'
), actual_constraints AS (
  SELECT
    constraint_definition.conname::text AS constraint_name,
    constraint_definition.convalidated,
    lower(
      regexp_replace(
        replace(
          replace(
            pg_get_constraintdef(constraint_definition.oid, true),
            '"',
            ''
          ),
          'public.',
          ''
        ),
        '[[:space:]()]',
        '',
        'g'
      )
    ) AS compact_definition,
    pg_get_constraintdef(constraint_definition.oid, true) AS definition
  FROM pg_constraint constraint_definition
  WHERE constraint_definition.conrelid = 'public.agent_run_stream_events'::regclass
    AND constraint_definition.contype = 'c'
    AND constraint_definition.conname IN (
      'agent_run_stream_events_sequence_bounds_check',
      'agent_run_stream_events_shape_check'
    )
), expected_indexes(index_name, expected_columns, expected_predicate) AS (
  VALUES
    (
      'agent_run_stream_events_one_terminal_idx',
      ARRAY['tenant_id', 'run_id']::text[],
      'type=anyarray[''terminal''::agentrunstreameventtype,''terminal_only''::agentrunstreameventtype]'
    ),
    (
      'agent_run_stream_events_one_reconciled_terminal_idx',
      ARRAY['tenant_id', 'run_id']::text[],
      'type=''terminal_reconciled''::agentrunstreameventtype'
    )
), actual_indexes AS (
  SELECT
    index_relation.relname::text AS index_name,
    index_definition.indisunique,
    index_definition.indisvalid,
    index_definition.indisready,
    index_definition.indislive,
    index_definition.indnkeyatts,
    index_definition.indnatts,
    ARRAY(
      SELECT attribute_definition.attname::text
      FROM unnest(index_definition.indkey::smallint[])
        WITH ORDINALITY AS indexed_attribute(attnum, position)
      JOIN pg_attribute attribute_definition
        ON attribute_definition.attrelid = target_table.oid
       AND attribute_definition.attnum = indexed_attribute.attnum
      WHERE indexed_attribute.position <= index_definition.indnkeyatts
      ORDER BY indexed_attribute.position
    ) AS indexed_columns,
    lower(
      regexp_replace(
        replace(
          replace(
            pg_get_expr(index_definition.indpred, index_definition.indrelid, true),
            '"',
            ''
          ),
          'public.',
          ''
        ),
        '[[:space:]()]',
        '',
        'g'
      )
    ) AS predicate
  FROM pg_index index_definition
  JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
  JOIN pg_class target_table ON target_table.oid = index_definition.indrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN expected_indexes expected ON expected.index_name = index_relation.relname
  WHERE target_schema.nspname = 'public'
    AND target_table.relname = 'agent_run_stream_events'
), expected_triggers(
  trigger_name,
  function_signature,
  trigger_type
) AS (
  VALUES
    (
      'agent_run_stream_events_insert_guard',
      'public.guard_agent_run_stream_event_insert()',
      7
    ),
    (
      'agent_run_stream_events_append_only',
      'public.reject_agent_run_stream_event_mutation()',
      27
    ),
    (
      'agent_run_stream_events_reject_truncate',
      'public.reject_agent_run_stream_event_mutation()',
      34
    )
), actual_triggers AS (
  SELECT
    trigger_definition.tgname::text AS trigger_name,
    trigger_definition.tgenabled,
    trigger_definition.tgtype::integer AS trigger_type,
    trigger_definition.tgfoid,
    cardinality(trigger_definition.tgattr::smallint[]) = 0 AS has_no_column_filter
  FROM pg_trigger trigger_definition
  WHERE trigger_definition.tgrelid = 'public.agent_run_stream_events'::regclass
    AND NOT trigger_definition.tgisinternal
), expected_functions(
  signature,
  security_definer,
  expected_config,
  result_type,
  language_name
) AS (
  VALUES
    (
      'public.guard_agent_run_stream_event_insert()',
      true,
      ARRAY['search_path=pg_catalog, public']::text[],
      'trigger',
      'plpgsql'
    ),
    (
      'public.reject_agent_run_stream_event_mutation()',
      true,
      ARRAY['search_path=pg_catalog, public']::text[],
      'trigger',
      'plpgsql'
    )
), actual_functions AS (
  SELECT
    expected.signature,
    function_definition.oid,
    function_definition.proowner,
    function_owner.rolname::text AS owner_name,
    function_owner.rolsuper OR function_owner.rolbypassrls AS owner_bypasses_rls,
    function_definition.prosecdef AS security_definer,
    ARRAY(
      SELECT setting
      FROM unnest(COALESCE(function_definition.proconfig, ARRAY[]::text[])) setting
      ORDER BY setting
    ) AS expected_config,
    pg_get_function_result(function_definition.oid) AS result_type,
    function_language.lanname::text AS language_name,
    pg_get_functiondef(function_definition.oid) AS definition,
    lower(
      regexp_replace(
        pg_get_functiondef(function_definition.oid),
        '[[:space:]]',
        '',
        'g'
      )
    ) AS compact_definition
  FROM expected_functions expected
  LEFT JOIN pg_proc function_definition
    ON function_definition.oid = to_regprocedure(expected.signature)
  LEFT JOIN pg_roles function_owner ON function_owner.oid = function_definition.proowner
  LEFT JOIN pg_language function_language ON function_language.oid = function_definition.prolang
), actual_function_acl AS (
  SELECT
    actual.signature,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    function_acl.privilege_type::text AS privilege_type,
    function_acl.is_grantable
  FROM actual_functions actual
  JOIN pg_proc function_definition ON function_definition.oid = actual.oid
  CROSS JOIN LATERAL aclexplode(
    COALESCE(
      function_definition.proacl,
      acldefault('f', function_definition.proowner)
    )
  ) function_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
  WHERE function_acl.grantee <> function_definition.proowner
)
SELECT
  (SELECT values FROM enum_values) =
    ARRAY['DELTA', 'TERMINAL', 'TERMINAL_ONLY', 'TERMINAL_RECONCILED']::text[]
  AND (
    SELECT count(*) = 1
      AND bool_and(
        convalidated
        AND compact_definition IN (
          'checksequence>=1andsequence<=10001',
          'checksequencebetween1and10001'
        )
      )
    FROM actual_constraints
    WHERE constraint_name = 'agent_run_stream_events_sequence_bounds_check'
  )
  AND (
    SELECT count(*) = 1
      AND bool_and(
        convalidated
        AND position(
          'type=''delta''::agentrunstreameventtype'
          IN compact_definition
        ) > 0
        AND position('sequence<10000' IN compact_definition) > 0
        AND position('deltaisnotnull' IN compact_definition) > 0
        AND position('octet_lengthdelta>=1' IN compact_definition) > 0
        AND position('octet_lengthdelta<=16384' IN compact_definition) > 0
        AND position('delta_hash~''^[a-f0-9]{64}$''' IN compact_definition) > 0
        AND position('terminal_statusisnull' IN compact_definition) > 0
        AND position(
          'type=anyarray[''terminal''::agentrunstreameventtype,''terminal_only''::agentrunstreameventtype,''terminal_reconciled''::agentrunstreameventtype]'
          IN compact_definition
        ) > 0
        AND position('deltaisnull' IN compact_definition) > 0
        AND position('delta_hashisnull' IN compact_definition) > 0
        AND position(
          'terminal_status=anyarray[''succeeded''::agentrunstatus,''failed''::agentrunstatus,''unknown''::agentrunstatus,''cancelled''::agentrunstatus]'
          IN compact_definition
        ) > 0
        AND regexp_count(definition, '\mOR\M', 1, 'i') = 1
        AND regexp_count(definition, 'TERMINAL_RECONCILED', 1, 'i') = 1
        AND position('true' IN lower(definition)) = 0
      )
    FROM actual_constraints
    WHERE constraint_name = 'agent_run_stream_events_shape_check'
  )
  AND (
    SELECT count(*) = 2
      AND bool_and(
        actual.indisunique
        AND actual.indisvalid
        AND actual.indisready
        AND actual.indislive
        AND actual.indnkeyatts = 2
        AND actual.indnatts = 2
        AND actual.indexed_columns = expected.expected_columns
        AND actual.predicate = expected.expected_predicate
      )
    FROM actual_indexes actual
    JOIN expected_indexes expected ON expected.index_name = actual.index_name
  )
  AND (SELECT count(*) FROM actual_triggers) = 3
  AND (
    SELECT count(*) = 3
      AND bool_and(
        actual.tgenabled = 'O'
        AND actual.trigger_type = expected.trigger_type
        AND actual.tgfoid = to_regprocedure(expected.function_signature)
        AND actual.has_no_column_filter
      )
    FROM actual_triggers actual
    JOIN expected_triggers expected ON expected.trigger_name = actual.trigger_name
  )
  AND (SELECT count(*) FROM actual_functions WHERE oid IS NOT NULL) = 2
  AND NOT EXISTS (
    SELECT
      signature,
      security_definer,
      expected_config,
      result_type,
      language_name
    FROM actual_functions
    EXCEPT
    SELECT * FROM expected_functions
  )
  AND NOT EXISTS (
    SELECT * FROM expected_functions
    EXCEPT
    SELECT
      signature,
      security_definer,
      expected_config,
      result_type,
      language_name
    FROM actual_functions
  )
  AND (
    SELECT bool_and(owner_name = 'postgres' AND owner_bypasses_rls)
    FROM actual_functions
  )
  AND NOT EXISTS (SELECT 1 FROM actual_function_acl)
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_agent_run_stream_event_insert()'
      AND position('pg_advisory_xact_lock' IN compact_definition) > 0
      AND position(
        'existing_event."delta"isnotdistinctfromnew."delta"'
        IN compact_definition
      ) > 0
      AND position('sequence must be contiguous' IN definition) > 0
      AND position(
        'digest(convert_to(new."delta",''utf8''),''sha256'')'
        IN compact_definition
      ) > 0
      AND position('output exceeds one million bytes' IN definition) > 0
      AND position(
        'terminal stream event must match the durable Agent Run status'
        IN definition
      ) > 0
      AND position(
        'new."type"=''terminal_reconciled''::public."agentrunstreameventtype"'
        IN compact_definition
      ) > 0
      AND position(
        'new."terminal_status"=''unknown''::public."agentrunstatus"'
        IN compact_definition
      ) > 0
      AND position(
        'reconciled terminal requires a prior UNKNOWN terminal marker'
        IN definition
      ) > 0
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.reject_agent_run_stream_event_mutation()'
      AND position('agent_run_stream_events is append-only' IN definition) > 0
      AND position('55000' IN definition) > 0
  );
'@
}

function Get-EnterpriseV2TenantTableIntegritySql {
  @'
WITH expected_tables(table_name, policy_roles) AS (
  VALUES
    ('agent_run_stream_events', ARRAY['PUBLIC']::text[]),
    ('ai_evaluation_answer_feedback_sources',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app',
            'enterprise_agent_evaluation_runner',
            'enterprise_agent_feedback_projector']::text[]),
    ('ai_evaluation_runner_attestations',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_evaluation_runner']::text[]),
    ('ai_governance_commands',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('ai_model_attempt_receipts',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('ai_model_catalog_versions',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('ai_model_circuit_states',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('ai_model_route_candidates',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('ai_model_route_policy_versions',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('ai_safety_decisions',
      ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[]),
    ('employee_task_acceptance_requests', ARRAY['PUBLIC']::text[]),
    ('employee_task_commands', ARRAY['PUBLIC']::text[]),
    ('experience_candidates', ARRAY['PUBLIC']::text[]),
    ('experience_commands', ARRAY['PUBLIC']::text[]),
    ('experience_knowledge_projections', ARRAY['PUBLIC']::text[]),
    ('experience_publication_org_targets', ARRAY['PUBLIC']::text[]),
    ('experience_publication_role_targets', ARRAY['PUBLIC']::text[]),
    ('experience_publications', ARRAY['PUBLIC']::text[]),
    ('experience_review_evidence', ARRAY['PUBLIC']::text[]),
    ('experience_source_deliverables', ARRAY['PUBLIC']::text[]),
    ('experience_source_evidence', ARRAY['PUBLIC']::text[]),
    ('experience_validations', ARRAY['PUBLIC']::text[]),
    ('finops_cost_verification_reviews', ARRAY['PUBLIC']::text[]),
    ('finops_projection_diagnostics', ARRAY['PUBLIC']::text[]),
    ('finops_projection_jobs', ARRAY['PUBLIC']::text[]),
    ('identity_break_glass_events', ARRAY['enterprise_agent_admin']::text[]),
    ('identity_break_glass_requests', ARRAY['enterprise_agent_admin']::text[]),
    ('identity_governance_commands', ARRAY['enterprise_agent_admin']::text[]),
    ('memory_commands', ARRAY['PUBLIC']::text[]),
    ('memory_records', ARRAY['PUBLIC']::text[]),
    ('memory_source_evidence', ARRAY['PUBLIC']::text[])
), expected_acl(table_name, grantee, privileges) AS (
  VALUES
    ('agent_run_stream_events', 'enterprise_agent_admin', ARRAY['SELECT']::text[]),
    ('agent_run_stream_events', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_evaluation_answer_feedback_sources', 'enterprise_agent_admin',
      ARRAY['SELECT']::text[]),
    ('ai_evaluation_answer_feedback_sources', 'enterprise_agent_feedback_projector',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_evaluation_runner_attestations', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_evaluation_runner_attestations', 'enterprise_agent_evaluation_runner',
      ARRAY['SELECT']::text[]),
    ('ai_governance_commands', 'enterprise_agent_admin', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_governance_commands', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_model_attempt_receipts', 'enterprise_agent_admin', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_model_attempt_receipts', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_model_catalog_versions', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('ai_model_catalog_versions', 'enterprise_agent_app',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('ai_model_circuit_states', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('ai_model_circuit_states', 'enterprise_agent_app',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('ai_model_route_candidates', 'enterprise_agent_admin', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_model_route_candidates', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_model_route_policy_versions', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('ai_model_route_policy_versions', 'enterprise_agent_app',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('ai_safety_decisions', 'enterprise_agent_admin', ARRAY['INSERT', 'SELECT']::text[]),
    ('ai_safety_decisions', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('employee_task_acceptance_requests', 'enterprise_agent_admin', ARRAY['SELECT']::text[]),
    ('employee_task_acceptance_requests', 'enterprise_agent_app', ARRAY['SELECT']::text[]),
    ('employee_task_acceptance_requests', 'enterprise_agent_task_executor',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('employee_task_commands', 'enterprise_agent_admin', ARRAY['SELECT']::text[]),
    ('employee_task_commands', 'enterprise_agent_task_executor',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('experience_candidates', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_candidates', 'enterprise_agent_employee_insights',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('experience_commands', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_knowledge_projections', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_publication_org_targets', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_publication_role_targets', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_publications', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_review_evidence', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_source_deliverables', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_source_deliverables', 'enterprise_agent_employee_insights',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('experience_source_evidence', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('experience_source_evidence', 'enterprise_agent_employee_insights',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('experience_validations', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('finops_cost_verification_reviews', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('finops_projection_diagnostics', 'enterprise_agent_admin', ARRAY['SELECT']::text[]),
    ('finops_projection_diagnostics', 'enterprise_agent_finops_projector',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('finops_projection_jobs', 'enterprise_agent_admin', ARRAY['SELECT']::text[]),
    ('finops_projection_jobs', 'enterprise_agent_finops_projector',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('identity_break_glass_events', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT']::text[]),
    ('identity_break_glass_requests', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('identity_governance_commands', 'enterprise_agent_admin',
      ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
    ('memory_commands', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('memory_commands', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('memory_records', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('memory_records', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
    ('memory_source_evidence', 'enterprise_agent_admin',
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]),
    ('memory_source_evidence', 'enterprise_agent_app', ARRAY['INSERT', 'SELECT']::text[])
), actual_acl AS (
  SELECT
    target_table.relname::text AS table_name,
    grantee_role.rolname::text AS grantee,
    array_agg(table_acl.privilege_type::text ORDER BY table_acl.privilege_type::text)
      AS privileges
  FROM pg_class target_table
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
  CROSS JOIN LATERAL aclexplode(
    COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
  ) table_acl
  JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE target_schema.nspname = 'public'
    AND table_acl.grantee <> target_table.relowner
  GROUP BY target_table.relname, grantee_role.rolname
), expected_foreign_keys(table_name, constraint_name, definition_hash) AS (
  -- PostgreSQL 16 canonical pg_get_constraintdef(..., true) hashes freeze
  -- parent columns and ON UPDATE/DELETE actions without a 100-line duplicate
  -- of the migration DDL. A server-major upgrade must explicitly re-baseline.
  VALUES
    ('agent_run_stream_events', 'agent_run_stream_events_tenant_id_run_id_fkey', 'd027729e6a2ff467085343232b393a97'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_agent_fkey', '35cce21b0f703bacec94a72069fb72b8'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_agent_version_fkey', 'cd6a6bbe3445f0385ca80b6f6f993609'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_bad_case_fkey', '6b4605fa74b88d898bbb5c5341910fde'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_conversation_fkey', 'ba4686507e5d2350979bdfdb9328f012'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_feedback_fkey', 'ab99ca4884be219aae23beeca3044d37'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_input_message_fkey', 'bb3e74688379ee9863d0f10382ada238'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_message_fkey', 'c9987549c9451c4f6307761e3f15739f'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_reporter_fkey', '92dc047418cadb11c209d4cd30ba1d6b'),
    ('ai_evaluation_answer_feedback_sources', 'ai_evaluation_answer_feedback_sources_run_fkey', '2f870c0c309522588f96db73a6b6cb63'),
    ('ai_evaluation_runner_attestations', 'ai_evaluation_runner_attestations_run_fkey', '9beadadadbedf700c12c537a080802ed'),
    ('ai_evaluation_runner_attestations', 'ai_evaluation_runner_attestations_runner_fkey', 'cd9633e3cb3632b77f814bdbc8cd3749'),
    ('ai_evaluation_runner_attestations', 'ai_evaluation_runner_attestations_tenant_fkey', '2bfa187e4818280b1bac2b5a55d17129'),
    ('ai_governance_commands', 'ai_governance_commands_actor_fkey', '3d406ad611a31078c1c78b3aca466039'),
    ('ai_governance_commands', 'ai_governance_commands_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('ai_model_attempt_receipts', 'ai_model_attempt_receipts_catalog_fkey', '2ccfb1abb6f0253c98f72d8ca7f490ad'),
    ('ai_model_attempt_receipts', 'ai_model_attempt_receipts_run_fkey', '6588d6688d162542b65df1ddf8e5fe84'),
    ('ai_model_catalog_versions', 'ai_model_catalog_versions_created_by_fkey', 'fb61570bd318620cfe4181900d750926'),
    ('ai_model_catalog_versions', 'ai_model_catalog_versions_published_by_fkey', 'bb63a887066297ece92c9562219e31ed'),
    ('ai_model_catalog_versions', 'ai_model_catalog_versions_reviewed_by_fkey', '1f231dbc60c00a21c14b833f15d7346d'),
    ('ai_model_catalog_versions', 'ai_model_catalog_versions_submitted_by_fkey', 'd919cd222260c7823d592b7dda567f11'),
    ('ai_model_catalog_versions', 'ai_model_catalog_versions_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('ai_model_circuit_states', 'ai_model_circuit_states_catalog_fkey', '2ccfb1abb6f0253c98f72d8ca7f490ad'),
    ('ai_model_route_candidates', 'ai_model_route_candidates_catalog_fkey', '2ccfb1abb6f0253c98f72d8ca7f490ad'),
    ('ai_model_route_candidates', 'ai_model_route_candidates_policy_fkey', 'd45aca3b7dc0963ca3c55c6e16856b73'),
    ('ai_model_route_policy_versions', 'ai_model_route_policy_versions_created_by_fkey', 'fb61570bd318620cfe4181900d750926'),
    ('ai_model_route_policy_versions', 'ai_model_route_policy_versions_published_by_fkey', 'bb63a887066297ece92c9562219e31ed'),
    ('ai_model_route_policy_versions', 'ai_model_route_policy_versions_reviewed_by_fkey', '1f231dbc60c00a21c14b833f15d7346d'),
    ('ai_model_route_policy_versions', 'ai_model_route_policy_versions_submitted_by_fkey', 'd919cd222260c7823d592b7dda567f11'),
    ('ai_model_route_policy_versions', 'ai_model_route_policy_versions_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('ai_safety_decisions', 'ai_safety_decisions_run_fkey', '6588d6688d162542b65df1ddf8e5fe84'),
    ('employee_task_acceptance_requests', 'employee_task_acceptance_requests_assignment_fkey', '0a0791bead753fc93e40479b2ba519f3'),
    ('employee_task_acceptance_requests', 'employee_task_acceptance_requests_deliverable_fkey', '761ede118f11df65203f838aa7fce3a3'),
    ('employee_task_acceptance_requests', 'employee_task_acceptance_requests_task_fkey', 'a335ee0e10bc6680de7432201669cce3'),
    ('employee_task_acceptance_requests', 'employee_task_acceptance_requests_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('employee_task_acceptance_requests', 'employee_task_acceptance_requests_user_fkey', '11eb3d5594a6d6e07a2868cbf1c8f07e'),
    ('employee_task_commands', 'employee_task_commands_actor_assignment_fkey', '15b398feba44df58e4f5a85b4ebfe48b'),
    ('employee_task_commands', 'employee_task_commands_actor_user_fkey', '3d406ad611a31078c1c78b3aca466039'),
    ('employee_task_commands', 'employee_task_commands_task_fkey', 'fe606491d06670fdc0f22fb073cb241d'),
    ('employee_task_commands', 'employee_task_commands_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('experience_candidates', 'experience_candidates_contributor_assignment_fkey', 'aa1433a58b1512f60485e6fe6f62ec68'),
    ('experience_candidates', 'experience_candidates_contributor_user_fkey', 'be9e083358c1fb642cdd6c8fc6eda098'),
    ('experience_candidates', 'experience_candidates_source_task_fkey', 'f480f2411be584096d633eedb5c98745'),
    ('experience_candidates', 'experience_candidates_tenant_id_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('experience_commands', 'experience_commands_actor_assignment_fkey', '15b398feba44df58e4f5a85b4ebfe48b'),
    ('experience_commands', 'experience_commands_actor_user_fkey', '3d406ad611a31078c1c78b3aca466039'),
    ('experience_commands', 'experience_commands_candidate_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_knowledge_projections', 'experience_knowledge_projections_creator_fkey', 'fb61570bd318620cfe4181900d750926'),
    ('experience_knowledge_projections', 'experience_knowledge_projections_document_fkey', 'f7b3f847e71f3e9482cf8db3a83c8a24'),
    ('experience_knowledge_projections', 'experience_knowledge_projections_document_version_fkey', '5c77fe887396df5626166d87fbb8badb'),
    ('experience_knowledge_projections', 'experience_knowledge_projections_experience_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_knowledge_projections', 'experience_knowledge_projections_knowledge_base_fkey', 'a760b0d4a7f8d4db9afb648c214982e9'),
    ('experience_knowledge_projections', 'experience_knowledge_projections_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('experience_publication_org_targets', 'experience_publication_org_targets_org_unit_fkey', '248e627c5e730bd76b298c282a69ca9a'),
    ('experience_publication_org_targets', 'experience_publication_org_targets_publication_fkey', 'deb4497c367be33ccd8d8e1a283ae378'),
    ('experience_publication_role_targets', 'experience_publication_role_targets_publication_fkey', 'deb4497c367be33ccd8d8e1a283ae378'),
    ('experience_publication_role_targets', 'experience_publication_role_targets_role_fkey', 'cc21ee0fa91bc00a0a2f2e1239176120'),
    ('experience_publications', 'experience_publications_candidate_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_publications', 'experience_publications_document_fkey', 'f7b3f847e71f3e9482cf8db3a83c8a24'),
    ('experience_publications', 'experience_publications_document_version_fkey', '5c77fe887396df5626166d87fbb8badb'),
    ('experience_publications', 'experience_publications_knowledge_base_fkey', 'a760b0d4a7f8d4db9afb648c214982e9'),
    ('experience_publications', 'experience_publications_publisher_assignment_fkey', '1341f3ab60c3cc3329e4446d8e4147a6'),
    ('experience_publications', 'experience_publications_publisher_user_fkey', 'bb63a887066297ece92c9562219e31ed'),
    ('experience_review_evidence', 'experience_review_evidence_candidate_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_review_evidence', 'experience_review_evidence_evidence_fkey', '988af0799304eee7c22d38c35d9bfe35'),
    ('experience_source_deliverables', 'experience_source_deliverables_candidate_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_source_deliverables', 'experience_source_deliverables_deliverable_fkey', '761ede118f11df65203f838aa7fce3a3'),
    ('experience_source_evidence', 'experience_source_evidence_candidate_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_source_evidence', 'experience_source_evidence_evidence_fkey', '988af0799304eee7c22d38c35d9bfe35'),
    ('experience_validations', 'experience_validations_candidate_fkey', 'e98e137c46d2489d5d9649667dfb7db1'),
    ('experience_validations', 'experience_validations_dataset_version_fkey', 'cc1d8ede0e865c1fe9f3d56b2c909fec'),
    ('experience_validations', 'experience_validations_run_fkey', '51b0ab71e780b13d31b14396f921931b'),
    ('experience_validations', 'experience_validations_validator_assignment_fkey', '8673c006b80991627b44653c9ae1ec88'),
    ('experience_validations', 'experience_validations_validator_user_fkey', '8e11115317a4500ccd8b1aa9995b9caa'),
    ('finops_cost_verification_reviews', 'finops_cost_verification_reviews_cost_fkey', '670e3be6db5680dede3f212c70e7f5c9'),
    ('finops_cost_verification_reviews', 'finops_cost_verification_reviews_evidence_fkey', '75f64cd32b102f56788fc1163cd3bca5'),
    ('finops_cost_verification_reviews', 'finops_cost_verification_reviews_reviewer_fkey', '69a814a040e63237f35e2540befed6be'),
    ('finops_cost_verification_reviews', 'finops_cost_verification_reviews_tenant_fkey', '2bfa187e4818280b1bac2b5a55d17129'),
    ('finops_projection_diagnostics', 'finops_projection_diagnostics_job_fkey', '692daae63e8fff3583fc8ab9cbc5d71a'),
    ('finops_projection_jobs', 'finops_projection_jobs_tenant_fkey', '2bfa187e4818280b1bac2b5a55d17129'),
    ('identity_break_glass_events', 'identity_break_glass_events_actor_fkey', '3d406ad611a31078c1c78b3aca466039'),
    ('identity_break_glass_events', 'identity_break_glass_events_actor_session_fkey', '0acae9cca5ba1379da33d0da1ea0afd9'),
    ('identity_break_glass_events', 'identity_break_glass_events_request_fkey', '88532695930a35b852f1d3ef3976a45f'),
    ('identity_break_glass_requests', 'identity_break_glass_requests_approver_fkey', 'c13a7c9b8a53e58972d6eb1c76ae9f86'),
    ('identity_break_glass_requests', 'identity_break_glass_requests_rejector_fkey', '10aba979aafc5a5ced166f6ec4e43bf0'),
    ('identity_break_glass_requests', 'identity_break_glass_requests_requester_fkey', '0dbd32b5e7f3740aa80786e254f8cf0f'),
    ('identity_break_glass_requests', 'identity_break_glass_requests_reviewer_fkey', '1f231dbc60c00a21c14b833f15d7346d'),
    ('identity_break_glass_requests', 'identity_break_glass_requests_revoker_fkey', '037b3627ea20aac8e4553ec868ee247d'),
    ('identity_break_glass_requests', 'identity_break_glass_requests_tenant_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('identity_governance_commands', 'identity_governance_commands_checker_fkey', '8329e9f801353db394a7d150f26b96cc'),
    ('identity_governance_commands', 'identity_governance_commands_maker_fkey', 'dffc37c884527f198f22938f9f54283e'),
    ('identity_governance_commands', 'identity_governance_commands_session_fkey', '373017eee3fc8455df644561c45d41c5'),
    ('memory_commands', 'memory_commands_actor_user_fkey', '3d406ad611a31078c1c78b3aca466039'),
    ('memory_commands', 'memory_commands_memory_fkey', 'c91e17dc312aee8cb669547ae8805c83'),
    ('memory_records', 'memory_records_conversation_fkey', '3309ad409789709b251c6cecdb9be84a'),
    ('memory_records', 'memory_records_creator_user_fkey', 'fb61570bd318620cfe4181900d750926'),
    ('memory_records', 'memory_records_owner_user_fkey', 'bf44310ddaeaf8453bc548461b60dba8'),
    ('memory_records', 'memory_records_role_assignment_fkey', '45d19001c4b584b58fe9463c606a47a7'),
    ('memory_records', 'memory_records_role_template_fkey', 'cc21ee0fa91bc00a0a2f2e1239176120'),
    ('memory_records', 'memory_records_role_version_fkey', '984044d3a781edf657efc96af24780a5'),
    ('memory_records', 'memory_records_task_fkey', 'fe606491d06670fdc0f22fb073cb241d'),
    ('memory_records', 'memory_records_tenant_id_fkey', '34d878fb8da6f583a1a38670f6efc51a'),
    ('memory_source_evidence', 'memory_source_evidence_evidence_fkey', '988af0799304eee7c22d38c35d9bfe35'),
    ('memory_source_evidence', 'memory_source_evidence_memory_fkey', 'c91e17dc312aee8cb669547ae8805c83')
), actual_foreign_keys AS (
  SELECT
    source_table.relname::text AS table_name,
    constraint_definition.conname::text AS constraint_name,
    md5(pg_get_constraintdef(constraint_definition.oid, true)) AS definition_hash,
    constraint_definition.convalidated
  FROM pg_constraint constraint_definition
  JOIN pg_class source_table ON source_table.oid = constraint_definition.conrelid
  JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
  JOIN expected_tables expected_table ON expected_table.table_name = source_table.relname
  WHERE source_schema.nspname = 'public'
    AND constraint_definition.contype = 'f'
), actual_policy_roles AS (
  SELECT
    target_table.relname::text AS table_name,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'PUBLIC')::text
      FROM unnest(policy_definition.polroles) assigned_role(role_oid)
      LEFT JOIN pg_roles role_definition ON role_definition.oid = assigned_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'PUBLIC')
    ) AS policy_roles
  FROM pg_policy policy_definition
  JOIN pg_class target_table ON target_table.oid = policy_definition.polrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
  WHERE target_schema.nspname = 'public'
    AND NOT policy_definition.polpermissive
    AND policy_definition.polcmd = '*'
    AND pg_get_expr(policy_definition.polqual, policy_definition.polrelid) =
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
    AND pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) =
      '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
)
SELECT
  (SELECT count(*) FROM expected_tables) = 31
  AND (SELECT count(*) FROM expected_acl) = 52
  AND (SELECT count(*) FROM expected_foreign_keys) = 104
  AND (
    SELECT count(*)
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
    WHERE target_schema.nspname = 'public'
      AND target_table.relkind IN ('r', 'p')
      AND target_table.relrowsecurity
      AND target_table.relforcerowsecurity
  ) = 31
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
    CROSS JOIN LATERAL aclexplode(
      COALESCE(target_table.relacl, acldefault('r', target_table.relowner))
    ) table_acl
    WHERE target_schema.nspname = 'public'
      AND table_acl.grantee = 0
      AND table_acl.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class target_table
    JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
    JOIN expected_tables expected_table ON expected_table.table_name = target_table.relname
    JOIN pg_attribute column_definition
      ON column_definition.attrelid = target_table.oid
     AND column_definition.attnum > 0
     AND NOT column_definition.attisdropped
    CROSS JOIN LATERAL aclexplode(column_definition.attacl) column_acl
    WHERE target_schema.nspname = 'public'
      AND column_acl.grantee = 0
      AND column_acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
  )
  AND NOT EXISTS (
    SELECT * FROM actual_acl
    EXCEPT
    SELECT * FROM expected_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_acl
    EXCEPT
    SELECT * FROM actual_acl
  )
  AND NOT EXISTS (
    SELECT table_name, policy_roles FROM actual_policy_roles
    EXCEPT
    SELECT table_name, policy_roles FROM expected_tables
  )
  AND NOT EXISTS (
    SELECT table_name, policy_roles FROM expected_tables
    EXCEPT
    SELECT table_name, policy_roles FROM actual_policy_roles
  )
  AND NOT EXISTS (
    SELECT table_name, constraint_name, definition_hash
    FROM actual_foreign_keys
    EXCEPT
    SELECT * FROM expected_foreign_keys
  )
  AND NOT EXISTS (
    SELECT * FROM expected_foreign_keys
    EXCEPT
    SELECT table_name, constraint_name, definition_hash
    FROM actual_foreign_keys
  )
  AND NOT EXISTS (
    SELECT 1 FROM actual_foreign_keys WHERE NOT convalidated
  );
'@
}

function Get-EnterpriseV2TenantTableRowCountsSql {
  @'
SELECT jsonb_build_object(
  'agent_run_stream_events', (SELECT count(*) FROM public."agent_run_stream_events"),
  'ai_evaluation_answer_feedback_sources', (SELECT count(*) FROM public."ai_evaluation_answer_feedback_sources"),
  'ai_evaluation_runner_attestations', (SELECT count(*) FROM public."ai_evaluation_runner_attestations"),
  'ai_governance_commands', (SELECT count(*) FROM public."ai_governance_commands"),
  'ai_model_attempt_receipts', (SELECT count(*) FROM public."ai_model_attempt_receipts"),
  'ai_model_catalog_versions', (SELECT count(*) FROM public."ai_model_catalog_versions"),
  'ai_model_circuit_states', (SELECT count(*) FROM public."ai_model_circuit_states"),
  'ai_model_route_candidates', (SELECT count(*) FROM public."ai_model_route_candidates"),
  'ai_model_route_policy_versions', (SELECT count(*) FROM public."ai_model_route_policy_versions"),
  'ai_safety_decisions', (SELECT count(*) FROM public."ai_safety_decisions"),
  'employee_task_acceptance_requests', (SELECT count(*) FROM public."employee_task_acceptance_requests"),
  'employee_task_commands', (SELECT count(*) FROM public."employee_task_commands"),
  'experience_candidates', (SELECT count(*) FROM public."experience_candidates"),
  'experience_commands', (SELECT count(*) FROM public."experience_commands"),
  'experience_knowledge_projections', (SELECT count(*) FROM public."experience_knowledge_projections"),
  'experience_publication_org_targets', (SELECT count(*) FROM public."experience_publication_org_targets"),
  'experience_publication_role_targets', (SELECT count(*) FROM public."experience_publication_role_targets"),
  'experience_publications', (SELECT count(*) FROM public."experience_publications"),
  'experience_review_evidence', (SELECT count(*) FROM public."experience_review_evidence"),
  'experience_source_deliverables', (SELECT count(*) FROM public."experience_source_deliverables"),
  'experience_source_evidence', (SELECT count(*) FROM public."experience_source_evidence"),
  'experience_validations', (SELECT count(*) FROM public."experience_validations"),
  'finops_cost_verification_reviews', (SELECT count(*) FROM public."finops_cost_verification_reviews"),
  'finops_projection_diagnostics', (SELECT count(*) FROM public."finops_projection_diagnostics"),
  'finops_projection_jobs', (SELECT count(*) FROM public."finops_projection_jobs"),
  'identity_break_glass_events', (SELECT count(*) FROM public."identity_break_glass_events"),
  'identity_break_glass_requests', (SELECT count(*) FROM public."identity_break_glass_requests"),
  'identity_governance_commands', (SELECT count(*) FROM public."identity_governance_commands"),
  'memory_commands', (SELECT count(*) FROM public."memory_commands"),
  'memory_records', (SELECT count(*) FROM public."memory_records"),
  'memory_source_evidence', (SELECT count(*) FROM public."memory_source_evidence")
)::text;
'@
}

function Get-EnterpriseProcessCollaborationIntegritySql {
  @'
WITH expected_functions(signature, security_definer) AS (
  VALUES
    ('public.validate_business_ledger_parent_bijection()', false),
    ('public.build_process_step_assignment_snapshot(uuid,uuid,uuid,uuid,uuid,timestamptz)', false),
    ('public.build_trusted_assignment_snapshot(uuid,uuid,jsonb,timestamptz,uuid,text)', true),
    ('public.guard_process_step_attempt_integrity()', false),
    ('public.guard_process_step_transition()', false),
    ('public.guard_correction_feedback_insert()', false),
    ('public.guard_correction_case_update()', false),
    ('public.validate_correction_trace()', false),
    ('public.guard_correction_case_reviewer_liveness()', false),
    ('public.guard_event_delivery_replay_attribution_v2()', false)
), actual_functions AS (
  SELECT
    expected.signature,
    function_definition.oid,
    pg_get_userbyid(function_definition.proowner)::text AS owner_name,
    function_definition.prosecdef AS security_definer,
    pg_get_functiondef(function_definition.oid) AS definition
  FROM expected_functions expected
  LEFT JOIN pg_proc function_definition
    ON function_definition.oid = to_regprocedure(expected.signature)
), acl_scoped_functions(signature) AS (
  VALUES
    ('public.validate_business_ledger_parent_bijection()'),
    ('public.build_process_step_assignment_snapshot(uuid,uuid,uuid,uuid,uuid,timestamptz)'),
    ('public.build_trusted_assignment_snapshot(uuid,uuid,jsonb,timestamptz,uuid,text)'),
    ('public.guard_process_step_attempt_integrity()'),
    ('public.guard_correction_feedback_insert()'),
    ('public.guard_correction_case_reviewer_liveness()'),
    ('public.guard_event_delivery_replay_attribution_v2()')
), expected_function_acl(signature, grantee, privilege_type) AS (
  VALUES
    (
      'public.build_process_step_assignment_snapshot(uuid,uuid,uuid,uuid,uuid,timestamptz)',
      'enterprise_agent_process',
      'EXECUTE'
    ),
    (
      'public.build_trusted_assignment_snapshot(uuid,uuid,jsonb,timestamptz,uuid,text)',
      'enterprise_agent_process',
      'EXECUTE'
    )
), actual_function_acl AS (
  SELECT
    actual.signature,
    COALESCE(grantee_role.rolname, 'PUBLIC')::text AS grantee,
    function_acl.privilege_type::text AS privilege_type
  FROM actual_functions actual
  JOIN acl_scoped_functions scoped ON scoped.signature = actual.signature
  JOIN pg_proc function_definition ON function_definition.oid = actual.oid
  CROSS JOIN LATERAL aclexplode(
    COALESCE(
      function_definition.proacl,
      acldefault('f', function_definition.proowner)
    )
  ) function_acl
  LEFT JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
  WHERE function_acl.grantee <> function_definition.proowner
), expected_triggers(table_name, trigger_name, function_name, definition) AS (
  VALUES
    (
      'business_event_evidence',
      'business_event_evidence_parent_bijection_trigger',
      'validate_business_ledger_parent_bijection',
      'CREATE CONSTRAINT TRIGGER business_event_evidence_parent_bijection_trigger AFTER INSERT ON business_event_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_business_ledger_parent_bijection()'
    ),
    (
      'correction_case_evidence',
      'correction_case_evidence_parent_bijection_trigger',
      'validate_business_ledger_parent_bijection',
      'CREATE CONSTRAINT TRIGGER correction_case_evidence_parent_bijection_trigger AFTER INSERT ON correction_case_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_business_ledger_parent_bijection()'
    ),
    (
      'correction_feedback_evidence',
      'correction_feedback_evidence_parent_bijection_trigger',
      'validate_business_ledger_parent_bijection',
      'CREATE CONSTRAINT TRIGGER correction_feedback_evidence_parent_bijection_trigger AFTER INSERT ON correction_feedback_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_business_ledger_parent_bijection()'
    ),
    (
      'process_step_instances',
      'process_step_instances_attempt_integrity_trigger',
      'guard_process_step_attempt_integrity',
      'CREATE TRIGGER process_step_instances_attempt_integrity_trigger BEFORE INSERT OR UPDATE ON process_step_instances FOR EACH ROW EXECUTE FUNCTION guard_process_step_attempt_integrity()'
    ),
    (
      'correction_cases',
      'correction_cases_trace_completeness_trigger',
      'validate_correction_trace',
      'CREATE CONSTRAINT TRIGGER correction_cases_trace_completeness_trigger AFTER INSERT OR UPDATE ON correction_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_correction_trace()'
    ),
    (
      'correction_cases',
      'correction_cases_reviewer_liveness_trigger',
      'guard_correction_case_reviewer_liveness',
      'CREATE TRIGGER correction_cases_reviewer_liveness_trigger BEFORE INSERT ON correction_cases FOR EACH ROW EXECUTE FUNCTION guard_correction_case_reviewer_liveness()'
    ),
    (
      'business_event_deliveries',
      'business_event_deliveries_replay_attribution_v2_trigger',
      'guard_event_delivery_replay_attribution_v2',
      'CREATE TRIGGER business_event_deliveries_replay_attribution_v2_trigger BEFORE UPDATE ON business_event_deliveries FOR EACH ROW EXECUTE FUNCTION guard_event_delivery_replay_attribution_v2()'
    )
), actual_triggers AS (
  SELECT
    target_table.relname::text AS table_name,
    trigger_definition.tgname::text AS trigger_name,
    trigger_function.proname::text AS function_name,
    pg_get_triggerdef(trigger_definition.oid, true) AS definition,
    trigger_definition.tgenabled,
    trigger_definition.tgisinternal
  FROM pg_trigger trigger_definition
  JOIN pg_class target_table ON target_table.oid = trigger_definition.tgrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN pg_proc trigger_function ON trigger_function.oid = trigger_definition.tgfoid
  JOIN expected_triggers expected
    ON expected.trigger_name = trigger_definition.tgname
  WHERE target_schema.nspname = 'public'
), expected_indexes(
  table_name,
  index_name,
  expected_columns,
  predicate_kind
) AS (
  VALUES
    (
      'collaboration_participants',
      'collaboration_participants_active_user_key',
      ARRAY['tenant_id', 'collaboration_id', 'user_id']::text[],
      'ACTIVE_USER'
    ),
    (
      'collaboration_participants',
      'collaboration_participants_active_agent_key',
      ARRAY['tenant_id', 'collaboration_id', 'agent_id']::text[],
      'ACTIVE_AGENT'
    )
), actual_indexes AS (
  SELECT
    target_table.relname::text AS table_name,
    index_relation.relname::text AS index_name,
    index_definition.indisunique,
    index_definition.indisvalid,
    ARRAY(
      SELECT attribute_definition.attname::text
      FROM unnest(index_definition.indkey::smallint[])
        WITH ORDINALITY AS indexed_attribute(attnum, position)
      JOIN pg_attribute attribute_definition
        ON attribute_definition.attrelid = target_table.oid
       AND attribute_definition.attnum = indexed_attribute.attnum
      WHERE indexed_attribute.position <= index_definition.indnkeyatts
      ORDER BY indexed_attribute.position
    ) AS indexed_columns,
    pg_get_expr(
      index_definition.indpred,
      index_definition.indrelid,
      true
    ) AS predicate
  FROM pg_index index_definition
  JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
  JOIN pg_class target_table ON target_table.oid = index_definition.indrelid
  JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN expected_indexes expected
    ON expected.table_name = target_table.relname
   AND expected.index_name = index_relation.relname
  WHERE target_schema.nspname = 'public'
)
SELECT
  (SELECT count(*) FROM expected_functions) = 10
  AND (
    SELECT count(*)
    FROM actual_functions actual
    JOIN expected_functions expected ON expected.signature = actual.signature
    WHERE actual.oid IS NOT NULL
      AND actual.owner_name = 'postgres'
      AND actual.security_definer = expected.security_definer
  ) = 10
  AND NOT EXISTS (
    SELECT * FROM actual_function_acl
    EXCEPT
    SELECT * FROM expected_function_acl
  )
  AND NOT EXISTS (
    SELECT * FROM expected_function_acl
    EXCEPT
    SELECT * FROM actual_function_acl
  )
  AND (
    SELECT count(*)
    FROM actual_triggers actual
    JOIN expected_triggers expected
      ON expected.table_name = actual.table_name
     AND expected.trigger_name = actual.trigger_name
     AND expected.function_name = actual.function_name
     AND expected.definition = actual.definition
    WHERE actual.tgenabled = 'O'
      AND NOT actual.tgisinternal
  ) = 7
  AND (
    SELECT count(*)
    FROM actual_indexes actual
    JOIN expected_indexes expected
      ON expected.table_name = actual.table_name
     AND expected.index_name = actual.index_name
     AND expected.expected_columns = actual.indexed_columns
    WHERE actual.indisunique
      AND actual.indisvalid
      AND (
        (
          expected.predicate_kind = 'ACTIVE_USER'
          AND actual.predicate = 'active'
        )
        OR (
          expected.predicate_kind = 'ACTIVE_AGENT'
          AND actual.predicate = 'active AND agent_id IS NOT NULL'
        )
      )
  ) = 2
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.validate_business_ledger_parent_bijection()'
      AND definition LIKE '%parent_count <> join_count%'
      AND definition LIKE '%mismatch_count <> 0%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature =
      'public.build_process_step_assignment_snapshot(uuid,uuid,uuid,uuid,uuid,timestamptz)'
      AND definition LIKE '%taskIds%'
      AND definition LIKE '%actions%'
      AND definition LIKE '%organizationIds%'
      AND definition LIKE '%orgUnitIds%'
      AND definition LIKE '%required_action IS NULL%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature =
      'public.build_trusted_assignment_snapshot(uuid,uuid,jsonb,timestamptz,uuid,text)'
      AND definition LIKE '%p_task_id IS NULL%'
      AND definition LIKE '%p_required_action IS NULL%'
      AND definition LIKE '%taskIds%'
      AND definition LIKE '%actions%'
      AND definition LIKE '%organizationIds%'
      AND definition LIKE '%orgUnitIds%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_process_step_attempt_integrity()'
      AND definition LIKE '%NEW."attempt" <> 1%'
      AND definition LIKE '%NEW."attempt" <> OLD."attempt" + 1%'
      AND definition LIKE '%NEW."output" IS NOT NULL%'
      AND definition LIKE '%NEW."failure_code" IS NOT NULL%'
      AND definition LIKE '%NEW."failure_detail" IS NOT NULL%'
      AND definition LIKE '%NEW."claimed_at" IS NOT NULL%'
      AND definition LIKE '%NEW."started_at" IS NOT NULL%'
      AND definition LIKE '%NEW."completed_at" IS NOT NULL%'
      AND definition LIKE '%NEW."timed_out_at" IS NOT NULL%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_process_step_transition()'
      AND definition LIKE '%is_retry boolean%'
      AND definition LIKE '%AND NOT is_retry%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_correction_feedback_insert()'
      AND definition LIKE '%correction_record."severity" = ''LOW''%'
      AND definition LIKE '%correction_record."status" = ''OPEN''%'
      AND definition LIKE '%actor_is_reviewer%'
      AND definition LIKE '%legacy_independent_reviewer%'
      AND definition LIKE '%actor_user IS DISTINCT FROM subject_user_id%'
      AND definition LIKE '%OR legacy_independent_reviewer%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_correction_case_update()'
      AND definition LIKE '%OLD."severity" = ''LOW''%'
      AND definition LIKE '%OLD."status" = ''OPEN''%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.validate_correction_trace()'
      AND definition LIKE '%current_record."severity" = ''LOW''%'
      AND definition LIKE '%replay_status = ''OPEN''%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_correction_case_reviewer_liveness()'
      AND definition LIKE '%jsonb_array_length(NEW."required_role_assignment_ids") = 0%'
      AND definition LIKE '%correction_cases_reviewer_liveness_check%'
  )
  AND EXISTS (
    SELECT 1
    FROM actual_functions
    WHERE signature = 'public.guard_event_delivery_replay_attribution_v2()'
      AND definition LIKE '%current_setting(''app.tenant_id'', true)%'
      AND definition LIKE '%current_setting(''app.user_id'', true)%'
      AND definition LIKE '%NEW."replayed_by_user_id" IS DISTINCT FROM session_user_id%'
      AND definition LIKE '%replay_actor."status" = ''ACTIVE''%'
      AND definition LIKE '%replay_actor."role" IN (''OWNER'', ''ADMIN'')%'
      AND definition LIKE '%NEW."available_at" IS DISTINCT FROM NEW."replayed_at"%'
  );
'@
}

function Get-EnterpriseToolCostAttestationIntegritySql {
  @'
WITH enum_values AS (
  SELECT array_agg(enum.enumlabel ORDER BY enum.enumsortorder) AS values
  FROM pg_type type
  JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
  JOIN pg_enum enum ON enum.enumtypid = type.oid
  WHERE namespace.nspname = 'public'
    AND type.typname = 'ToolCostAttestation'
),
column_shape AS (
  SELECT
    NOT attribute.attnotnull AS nullable,
    pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
  FROM pg_attribute attribute
  JOIN pg_class relation ON relation.oid = attribute.attrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_attrdef default_value
    ON default_value.adrelid = relation.oid
   AND default_value.adnum = attribute.attnum
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'tool_execution_receipts'
    AND attribute.attname = 'cost_micros'
    AND NOT attribute.attisdropped
),
attestation_column AS (
  SELECT
    attribute.attnotnull AS required,
    pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
  FROM pg_attribute attribute
  JOIN pg_class relation ON relation.oid = attribute.attrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_attrdef default_value
    ON default_value.adrelid = relation.oid
   AND default_value.adnum = attribute.attnum
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'tool_execution_receipts'
    AND attribute.attname = 'cost_attestation'
    AND NOT attribute.attisdropped
),
cost_constraint AS (
  SELECT pg_get_constraintdef(constraint_definition.oid, true) AS definition
  FROM pg_constraint constraint_definition
  JOIN pg_class relation ON relation.oid = constraint_definition.conrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'tool_execution_receipts'
    AND constraint_definition.conname = 'tool_execution_receipts_cost_attestation_check'
),
actual_type_acl AS (
  SELECT
    grantee.rolname AS grantee,
    privilege.privilege_type,
    privilege.is_grantable
  FROM pg_type type
  JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(type.typacl, acldefault('T', type.typowner))
  ) privilege
  JOIN pg_roles grantee ON grantee.oid = privilege.grantee
  WHERE namespace.nspname = 'public'
    AND type.typname = 'ToolCostAttestation'
    AND privilege.grantee <> type.typowner
),
expected_type_acl(grantee, privilege_type, is_grantable) AS (
  VALUES
    ('enterprise_agent_app', 'USAGE', false),
    ('enterprise_agent_admin', 'USAGE', false),
    ('enterprise_agent_tool_gateway', 'USAGE', false),
    ('enterprise_agent_finops_projector', 'USAGE', false)
)
SELECT
  (SELECT values FROM enum_values) =
    ARRAY['UNATTESTED', 'PROVIDER_ATTESTED', 'GATEWAY_ATTESTED']::name[]
  AND (SELECT nullable FROM column_shape)
  AND (SELECT default_expression FROM column_shape) IS NULL
  AND (SELECT required FROM attestation_column)
  AND (SELECT default_expression FROM attestation_column) LIKE '%GATEWAY_ATTESTED%'
  AND (SELECT count(*) FROM cost_constraint) = 1
  AND (SELECT definition FROM cost_constraint) LIKE '%cost_micros IS NULL%'
  AND (SELECT definition FROM cost_constraint) LIKE '%PROVIDER_ATTESTED%'
  AND (SELECT definition FROM cost_constraint) LIKE '%GATEWAY_ATTESTED%'
  AND NOT EXISTS (
    SELECT grantee, privilege_type, is_grantable FROM actual_type_acl
    EXCEPT
    SELECT grantee, privilege_type, is_grantable FROM expected_type_acl
  )
  AND NOT EXISTS (
    SELECT grantee, privilege_type, is_grantable FROM expected_type_acl
    EXCEPT
    SELECT grantee, privilege_type, is_grantable FROM actual_type_acl
  )
  AND (
    SELECT relation.relrowsecurity AND relation.relforcerowsecurity
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'tool_execution_receipts'
  );
'@
}
