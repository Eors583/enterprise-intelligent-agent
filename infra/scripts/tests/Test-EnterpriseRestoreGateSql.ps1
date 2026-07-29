$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseRestoreGateSql.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$tests = 0
$privileges = Get-EnterpriseCriticalPrivilegesSql
foreach ($required in @(
  'actual_table_acl', 'expected_table_acl', 'actual_column_acl', 'expected_column_acl',
  "'first_attempted_at'", '(SELECT count(*) FROM expected_tables) = 36', 'EXCEPT', 'is_grantable'
)) {
  Assert-True ($privileges.Contains($required)) "Privilege gate is missing $required."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('role_assignments', 'enterprise_agent_app', 'SELECT', false)",
  "('role_assignments', 'enterprise_agent_admin', 'SELECT', false)",
  "('role_assignments', 'enterprise_agent_admin', 'INSERT', false)",
  "('role_assignments', 'enterprise_agent_admin', 'UPDATE', false)",
  "('role_assignments', 'enterprise_agent_admin', 'DELETE', false)",
  "('role_assignments', 'enterprise_agent_process', 'SELECT', false)",
  "('role_assignments', 'enterprise_agent_tool_gateway', 'SELECT', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Role Assignment ACL gate is missing $expectedPrivilege."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('ai_runtime_runs', 'enterprise_agent_runtime', 'SELECT', false)",
  "('ai_runtime_runs', 'enterprise_agent_runtime', 'INSERT', false)",
  "('ai_runtime_runs', 'enterprise_agent_runtime', 'UPDATE', false)",
  "('ai_runtime_runs', 'enterprise_agent_admin', 'SELECT', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "AI Runtime ACL gate is missing $expectedPrivilege."
  $tests++
}
Assert-True ($privileges.Contains("('outbox_events', 'enterprise_agent_evaluation_runner', 'INSERT', false)")) 'AI evaluation runner outbox ACL is missing from the exact privilege gate.'
$tests++
foreach ($expectedPrivilege in @(
  "('auth_recovery_deliveries', 'enterprise_agent_auth', 'SELECT', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_auth', 'INSERT', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_auth', 'UPDATE', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_auth', 'DELETE', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_admin', 'SELECT', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_admin', 'INSERT', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_admin', 'UPDATE', false)",
  "('auth_recovery_deliveries', 'enterprise_agent_admin', 'DELETE', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Recovery delivery ACL gate is missing $expectedPrivilege."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('outbox_event_deliveries', 'enterprise_agent_app', 'SELECT', false)",
  "('outbox_event_deliveries', 'enterprise_agent_admin', 'SELECT', false)",
  "('outbox_event_deliveries', 'enterprise_agent_outbox', 'SELECT', false)",
  "('outbox_event_deliveries', 'acknowledged_at', 'enterprise_agent_outbox', 'UPDATE', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Outbox delivery ACL gate is missing $expectedPrivilege."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('outbox_event_route_prefixes', 'enterprise_agent_app', 'SELECT', false)",
  "('outbox_event_route_prefixes', 'enterprise_agent_admin', 'SELECT', false)",
  "('outbox_event_route_prefixes', 'enterprise_agent_outbox', 'SELECT', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Outbox route-prefix ACL gate is missing $expectedPrivilege."
  $tests++
}
Assert-True (-not $privileges.Contains(
  "('outbox_events', 'published_at', 'enterprise_agent_outbox', 'UPDATE', false)"
)) 'Immutable Outbox facts must not retain the legacy delivery UPDATE expectation.'
$tests++
foreach ($expectedPrivilege in @(
  "('agent_runs', 'enterprise_agent_tool_gateway', 'SELECT', false)",
  "('process_instances', 'enterprise_agent_tool_gateway', 'SELECT', false)",
  "('process_step_instances', 'enterprise_agent_tool_gateway', 'SELECT', false)",
  "('tenants', 'agent_run_monthly_token_limit', 'enterprise_agent_admin', 'UPDATE', false)",
  "('tenants', 'agent_run_concurrency_limit', 'enterprise_agent_admin', 'UPDATE', false)",
  "('tenants', 'agent_run_rate_limit_per_minute', 'enterprise_agent_admin', 'UPDATE', false)",
  "('users', 'email_normalized', 'enterprise_agent_scim', 'UPDATE', false)",
  "('agent_runs', 'cancellation_requested_at', 'enterprise_agent_admin', 'UPDATE', false)",
  "('agent_runs', 'cancellation_reason', 'enterprise_agent_admin', 'UPDATE', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Current Tool Gateway, SCIM boundary, cancellation, or quota ACL gate is missing $expectedPrivilege."
  $tests++
}
Assert-True ($privileges.Contains(') = (SELECT count(*) FROM expected_tables)')) 'Critical table discovery must compare against the synchronized expected set instead of a stale present-table count.'
$tests++
foreach ($expectedPrivilege in @(
  "('directory_sync_previews', 'enterprise_agent_admin', 'SELECT', false)",
  "('directory_sync_previews', 'enterprise_agent_admin', 'INSERT', false)",
  "('directory_sync_previews', 'enterprise_agent_admin', 'UPDATE', false)",
  "('directory_sync_preview_items', 'enterprise_agent_admin', 'SELECT', false)",
  "('directory_sync_runs', 'enterprise_agent_admin', 'SELECT', false)",
  "('directory_sync_runs', 'enterprise_agent_outbox', 'SELECT', false)",
  "('directory_sync_runs', 'lease_expires_at', 'enterprise_agent_outbox', 'UPDATE', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Feishu directory sync ACL gate is missing $expectedPrivilege."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('outbox_events', 'enterprise_agent_tool_gateway', 'SELECT', false)",
  "('tool_reconciliation_attempts', 'enterprise_agent_app', 'SELECT', false)",
  "('tool_reconciliation_attempts', 'enterprise_agent_admin', 'SELECT', false)",
  "('tool_reconciliation_attempts', 'enterprise_agent_tool_gateway', 'SELECT', false)",
  "('tool_reconciliation_attempts', 'enterprise_agent_tool_gateway', 'INSERT', false)",
  "('tool_reconciliation_receipts', 'enterprise_agent_app', 'SELECT', false)",
  "('tool_reconciliation_receipts', 'enterprise_agent_admin', 'SELECT', false)",
  "('tool_reconciliation_receipts', 'enterprise_agent_tool_gateway', 'SELECT', false)",
  "('tool_reconciliation_receipts', 'enterprise_agent_tool_gateway', 'INSERT', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Tool reconciliation ACL gate is missing $expectedPrivilege."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('process_edges', 'enterprise_agent_process', 'SELECT', false)",
  "('process_instances', 'enterprise_agent_process', 'INSERT', false)",
  "('process_instances', 'enterprise_agent_process', 'UPDATE', false)",
  "('process_step_instances', 'enterprise_agent_process', 'INSERT', false)",
  "('process_step_instances', 'enterprise_agent_process', 'UPDATE', false)",
  "('process_commands', 'enterprise_agent_process', 'INSERT', false)",
  "('process_step_commands', 'enterprise_agent_process', 'INSERT', false)",
  "('business_events', 'enterprise_agent_process', 'INSERT', false)",
  "('business_event_deliveries', 'enterprise_agent_process', 'UPDATE', false)",
  "('collaboration_messages', 'enterprise_agent_process', 'INSERT', false)",
  "('collaborations', 'enterprise_agent_process', 'UPDATE', false)",
  "('correction_feedback', 'enterprise_agent_process', 'INSERT', false)",
  "('correction_cases', 'enterprise_agent_process', 'UPDATE', false)",
  "('tasks', 'process_instance_id', 'enterprise_agent_process', 'UPDATE', false)",
  "('outbox_events', 'payload', 'enterprise_agent_process', 'INSERT', false)",
  "('audit_events', 'metadata', 'enterprise_agent_process', 'INSERT', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Process capability ACL gate is missing $expectedPrivilege."
  $tests++
}
foreach ($expectedPrivilege in @(
  "('tenants', 'id', 'enterprise_agent_lifecycle', 'SELECT', false)",
  "('role_assignments', 'status', 'enterprise_agent_lifecycle', 'SELECT', false)",
  "('role_assignments', 'status', 'enterprise_agent_lifecycle', 'UPDATE', false)",
  "('agent_runs', 'external_run_id', 'enterprise_agent_lifecycle', 'SELECT', false)",
  "('agent_runs', 'cancellation_requested_at', 'enterprise_agent_lifecycle', 'SELECT', false)",
  "('agent_runs', 'reserved_tokens', 'enterprise_agent_lifecycle', 'UPDATE', false)",
  "('agent_runs', 'cancellation_requested_at', 'enterprise_agent_lifecycle', 'UPDATE', false)",
  "('agent_runs', 'cancellation_reason', 'enterprise_agent_lifecycle', 'UPDATE', false)",
  "('outbox_events', 'payload', 'enterprise_agent_lifecycle', 'INSERT', false)",
  "('audit_events', 'metadata', 'enterprise_agent_lifecycle', 'INSERT', false)"
)) {
  Assert-True ($privileges.Contains($expectedPrivilege)) "Lifecycle ACL gate is missing $expectedPrivilege."
  $tests++
}
$roleAssignmentMigrationPath = Join-Path $PSScriptRoot '..\..\..\apps\api\prisma\migrations\20260728000100_role_assignment_foundation\migration.sql'
$roleAssignmentMigration = Get-Content -LiteralPath $roleAssignmentMigrationPath -Raw -Encoding utf8
foreach ($required in @(
  'CREATE POLICY enterprise_agent_admin_access',
  'FOR ALL',
  'TO enterprise_agent_admin',
  'CREATE POLICY enterprise_agent_access',
  'FOR SELECT',
  'TO enterprise_agent_app',
  'GRANT SELECT, INSERT, UPDATE, DELETE',
  'GRANT SELECT'
)) {
  Assert-True ($roleAssignmentMigration.Contains($required)) "Role Assignment migration is missing $required."
  $tests++
}
foreach ($forbiddenAppWrite in @('INSERT', 'UPDATE', 'DELETE')) {
  Assert-True (-not $privileges.Contains("('role_assignments', 'enterprise_agent_app', '$forbiddenAppWrite', false)")) "Role Assignment app ACL must not include $forbiddenAppWrite."
  $tests++
}
$roleGovernanceMigrationPath = Join-Path $PSScriptRoot '..\..\..\apps\api\prisma\migrations\20260728000300_role_blueprint_governance\migration.sql'
$roleGovernanceMigration = Get-Content -LiteralPath $roleGovernanceMigrationPath -Raw -Encoding utf8
foreach ($required in @(
  'CREATE ROLE enterprise_agent_lifecycle',
  'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  'REVOKE enterprise_agent_lifecycle',
  'FROM enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin',
  'GRANT SELECT ("id", "status")',
  'GRANT UPDATE (',
  'CREATE POLICY enterprise_agent_lifecycle_tenant_enumeration',
  'CREATE POLICY enterprise_agent_lifecycle_access'
)) {
  Assert-True ($roleGovernanceMigration.Contains($required)) "Role governance migration is missing lifecycle boundary $required."
  $tests++
}
Assert-True (-not $roleGovernanceMigration.Contains('GRANT enterprise_agent_lifecycle TO enterprise_agent_admin')) 'The admin capability must never inherit lifecycle.'
$tests++
foreach ($graphTable in @(
  'knowledge_entities',
  'knowledge_entity_mentions',
  'knowledge_relations',
  'knowledge_relation_evidence'
)) {
  foreach ($expectedPrivilege in @(
    "('$graphTable', 'enterprise_agent_app', 'SELECT', false)",
    "('$graphTable', 'enterprise_agent_admin', 'SELECT', false)",
    "('$graphTable', 'enterprise_agent_admin', 'INSERT', false)",
    "('$graphTable', 'enterprise_agent_admin', 'UPDATE', false)",
    "('$graphTable', 'enterprise_agent_admin', 'DELETE', false)"
  )) {
    Assert-True ($privileges.Contains($expectedPrivilege)) "Graph ACL gate is missing $expectedPrivilege."
    $tests++
  }
}

$graphMigrationPath = Join-Path $PSScriptRoot '..\..\..\apps\api\prisma\migrations\20260727000200_knowledge_graph_foundation\migration.sql'
$graphMigration = Get-Content -LiteralPath $graphMigrationPath -Raw -Encoding utf8
$normalizedGraphMigration = $graphMigration -replace '\s+', ' '
$appGrant = [regex]::Match(
  $normalizedGraphMigration,
  'GRANT SELECT ON TABLE (?<tables>.*?) TO enterprise_agent_app;'
)
$adminGrant = [regex]::Match(
  $normalizedGraphMigration,
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE (?<tables>.*?) TO enterprise_agent_admin;'
)
Assert-True $appGrant.Success 'Graph migration must grant the application role read-only table access.'
Assert-True $adminGrant.Success 'Graph migration must grant the admin role CRUD table access.'
$tests += 2
foreach ($graphTable in @(
  'knowledge_entities',
  'knowledge_entity_mentions',
  'knowledge_relations',
  'knowledge_relation_evidence'
)) {
  Assert-True ($appGrant.Groups['tables'].Value.Contains("public.`"$graphTable`"")) "Graph migration app grant is missing $graphTable."
  Assert-True ($adminGrant.Groups['tables'].Value.Contains("public.`"$graphTable`"")) "Graph migration admin grant is missing $graphTable."
  $tests += 2
}

$acl = Get-EnterpriseAuthActionTokenAclSql
foreach ($required in @('actual_acl', 'expected_acl', 'EXCEPT', 'is_grantable', 'attacl')) {
  Assert-True ($acl.Contains($required)) "Exact token ACL gate is missing $required."
  $tests++
}
Assert-True ($acl.Contains('cardinality(attribute_definition.attacl)')) 'Empty or NULL column ACLs must be handled without aclexplode.'
Assert-True (-not $acl.Contains("aclexplode(COALESCE(attribute_definition.attacl, '{}'::aclitem[]))")) 'A zero-dimensional ACL array must never reach aclexplode.'
$tests += 2

$roles = Get-EnterpriseCapabilityRoleHardeningSql
foreach ($required in @('NOT rolsuper', 'NOT rolinherit', 'NOT rolcanlogin', 'NOT rolbypassrls', 'pg_auth_members', 'login_role.rolcanlogin', 'count(DISTINCT granted_role.oid) > 1')) {
  Assert-True ($roles.Contains($required)) "Role hardening gate is missing $required."
  $tests++
}
Assert-True ($roles.Contains("'enterprise_agent_lifecycle'")) 'Role hardening gate must include the lifecycle capability.'
Assert-True ($roles.Contains("'enterprise_agent_scim'")) 'Role hardening gate must include the SCIM capability.'
Assert-True ($roles.Contains("'enterprise_agent_process'")) 'Role hardening gate must include the process capability.'
Assert-True ($roles.Contains("'enterprise_agent_tool_gateway'")) 'Role hardening gate must include the Tool Gateway capability.'
Assert-True ($roles.Contains("'enterprise_agent_evaluation_runner'")) 'Role hardening gate must include the AI evaluation runner capability.'
Assert-True ($roles.Contains("'enterprise_agent_employee_insights'")) 'Role hardening gate must include the employee-insights capability.'
Assert-True ($roles.Contains("'enterprise_agent_task_executor'")) 'Role hardening gate must include the employee task-executor capability.'
Assert-True ($roles.Contains("'enterprise_agent_finops_projector'")) 'Role hardening gate must include the FinOps projector capability.'
Assert-True ($roles.Contains("'enterprise_agent_feedback_projector'")) 'Role hardening gate must include the inherited feedback projector.'
Assert-True ($roles.Contains('expected_inherited_worker_memberships')) 'Role hardening gate must keep the feedback projector membership exact.'
Assert-True ($roles.Contains('(SELECT count(*) FROM capability_roles) = 14')) 'Role hardening gate must require all fourteen non-inheriting capability roles.'
$tests += 11

$scimCancellation = Get-EnterpriseScimCancellationHardeningSql
foreach ($required in @(
  'expected_columns(',
  "'cancellation_requested_at'",
  "'cancellation_confirmed_at'",
  "'agent_runs_cancellation_requested'",
  "'public.resolve_scim_capability(text,text)'",
  "'public.guard_untrusted_agent_run_cancellation()'",
  "'public.apply_scim_user_deprovisioning()'",
  "ARRAY['row_security=off', 'search_path=pg_catalog, public']::text[]",
  'owner_bypasses_rls',
  'expected_function_acl',
  "'enterprise_agent_scim'",
  'direct_scim_table_acl',
  'direct_scim_column_acl',
  'has_any_column_privilege',
  "'scim_service_tokens'",
  "'scim_connectors'",
  "'identity_deprovisioning_actions'",
  "'agent_runs_pending_cancellation_idx'",
  "'agent_runs_cancellation_evidence_check'",
  "'agent_runs_untrusted_cancellation_guard'",
  "'scim_users_deprovision'",
  'exact_update_columns',
  'unnest(trigger_definition.tgattr::smallint[])',
  "actual.tgenabled = 'O'",
  'actual.trigger_type = expected.trigger_type',
  'actual.tgfoid = to_regprocedure(expected.function_signature)',
  'deactivate_user_on_scim_disable',
  "'cancellation_confirmed_at'",
  'EXCEPT'
)) {
  Assert-True ($scimCancellation.Contains($required)) "SCIM cancellation hardening gate is missing $required."
  $tests++
}

$tenantRls = Get-EnterpriseTenantRlsIntegritySql
foreach ($required in @(
  "('agent_runs', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('ai_runtime_runs', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('auth_action_tokens', 'tenant_id', ARRAY['enterprise_agent_admin']::text[])",
  "('auth_recovery_deliveries', 'tenant_id', ARRAY['enterprise_agent_admin']::text[])",
  "('directory_sync_preview_items', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('directory_sync_previews', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('directory_sync_runs', 'tenant_id', ARRAY['enterprise_agent_admin']::text[])",
  "('knowledge_entities', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('knowledge_entity_mentions', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('knowledge_ingestion_jobs', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app']::text[])",
  "('knowledge_relations', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('knowledge_relation_evidence', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('tasks', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('value_definitions', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('process_versions', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('process_commands', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('process_edges', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('process_instances', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('process_step_commands', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('process_step_instances', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('business_events', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('business_event_deliveries', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('business_event_effects', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('collaborations', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('collaboration_messages', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('correction_cases', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('correction_feedback', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('acceptance_evidence', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('outbox_event_deliveries', 'tenant_id', ARRAY['enterprise_agent_admin', 'enterprise_agent_app', 'enterprise_agent_provisioner']::text[])",
  "('outbox_events', 'tenant_id', ARRAY['enterprise_agent_app', 'enterprise_agent_provisioner']::text[])",
  "('role_assignments', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "special_tenant_tables(table_name)",
  "('auth_login_rate_limits')",
  "('tool_invocations')",
  "('tool_reconciliation_attempts')",
  "('tool_reconciliation_receipts')",
  "('ai_evaluation_datasets')",
  "('ai_evaluation_dataset_versions')",
  "('ai_evaluation_runs')",
  "('ai_evaluation_case_results')",
  "('ai_evaluation_release_checks')",
  'catalog_tenant_tables AS (',
  'catalog_capability_roles AS (',
  'reviewed_cross_tenant_capabilities(table_name, role_name) AS (',
  'actual_cross_tenant_capabilities AS (',
  "('scim_users', 'enterprise_agent_scim')",
  "('users', 'enterprise_agent_tool_gateway')",
  "('directory_sync_runs', 'enterprise_agent_outbox')",
  "('outbox_event_deliveries', 'enterprise_agent_outbox')",
  'SELECT * FROM actual_cross_tenant_capabilities',
  'SELECT * FROM reviewed_cross_tenant_capabilities',
  'EXISTS (SELECT 1 FROM catalog_tenant_tables)',
  'aclexplode(column_definition.attacl)',
  'table_acl.grantee = 0',
  'target_table.relrowsecurity',
  'target_table.relforcerowsecurity',
  "policy_definition.polcmd = '*'",
  'pg_get_expr(policy_definition.polqual',
  'pg_get_expr(policy_definition.polwithcheck',
  'expected_policy.role_names',
  "tenant_attribute.attname = 'tenant_id'",
  "target_table.relkind IN ('r', 'p')"
)) {
  Assert-True ($tenantRls.Contains($required)) "Tenant RLS gate is missing $required."
  $tests++
}
foreach ($removedCapability in @(
  "('auth_sessions', 'enterprise_agent_scim')",
  "('identity_deprovisioning_actions', 'enterprise_agent_scim')",
  "('identity_devices', 'enterprise_agent_scim')",
  "('outbox_events', 'enterprise_agent_scim')",
  "('scim_connectors', 'enterprise_agent_scim')",
  "('scim_service_tokens', 'enterprise_agent_scim')"
)) {
  Assert-True (-not $tenantRls.Contains($removedCapability)) "Tenant RLS review still treats removed SCIM capability as active: $removedCapability."
  $tests++
}
Assert-True (-not $tenantRls.Contains('(SELECT count(*) FROM expected) =')) 'Catalog tenant completeness must not depend on a manually updated table-count constant.'
Assert-True (-not $tenantRls.Contains("policy_definition.polname = 'tenant_isolation'`n  ) = 80")) 'Catalog tenant completeness must not depend on a manually updated policy-count constant.'
$tests += 2

$toolGateway = Get-EnterpriseToolGatewayIntegritySql
foreach ($required in @(
  "('tool_definitions', 'current_version_id')",
  "('tool_versions', 'configuration_hash')",
  "('tool_invocations', 'provider_dispatch_allowed')",
  "('tool_invocation_commands', 'request_hash')",
  "('tool_execution_receipts', 'receipt_hash')",
  "('tool_dns_resolution_proofs', 'pinned_ip_address')",
  "('tool_reconciliation_attempts', 'input_hash')",
  "('tool_reconciliation_receipts', 'receipt_hash')",
  "'enterprise_agent_tool_gateway'",
  "'tool_tenant_isolation'",
  "'tool_admin_access'",
  "'tool_gateway_access'",
  "'tool_invocations_command_coverage_trigger'",
  "'tool_execution_receipts_insert_guard_trigger'",
  "'tool_dns_resolution_proofs_insert_guard_trigger'",
  "'tool_reconciliation_attempts_insert_guard_trigger'",
  "'tool_reconciliation_receipts_insert_guard_trigger'",
  "'tool_reconciliation_attempts_append_only_trigger'",
  "'tool_reconciliation_receipts_append_only_trigger'",
  "'tool_invocations_reconciliation_guard_trigger'",
  "'tool_invocations_reconciliation_command_trigger'",
  "'tool_reconciliation_attempts_requester_read'",
  "'tool_reconciliation_receipts_requester_read'",
  "'tool_gateway_reconciliation_outbox_read'",
  "'tool_gateway_reconciliation_outbox_tenant'",
  'ToolInvocation.ReconciliationRequested',
  'app.user_id',
  'target_table.relrowsecurity',
  'target_table.relforcerowsecurity',
  "'public.audit_events', 'INSERT'",
  "'public.outbox_events', 'INSERT'",
  'SELECT,INSERT,UPDATE',
  'SELECT,INSERT',
  'UPDATE,DELETE'
)) {
  Assert-True ($toolGateway.Contains($required)) "Tool Gateway restore gate is missing $required."
  $tests++
}

$toolCostAttestation = Get-EnterpriseToolCostAttestationIntegritySql
foreach ($required in @(
  'ToolCostAttestation',
  'UNATTESTED',
  'PROVIDER_ATTESTED',
  'GATEWAY_ATTESTED',
  'tool_execution_receipts_cost_attestation_check',
  'FROM pg_constraint constraint_definition',
  'pg_get_constraintdef(constraint_definition.oid, true)',
  '(SELECT count(*) FROM cost_constraint) = 1',
  'cost_micros IS NULL',
  'actual_type_acl',
  'expected_type_acl',
  'EXCEPT',
  'enterprise_agent_app',
  'enterprise_agent_admin',
  'enterprise_agent_tool_gateway',
  'enterprise_agent_finops_projector',
  'relforcerowsecurity'
)) {
  Assert-True ($toolCostAttestation.Contains($required)) "Tool cost attestation restore gate is missing $required."
  $tests++
}
Assert-True (
  $toolCostAttestation.IndexOf('actual_type_acl', [StringComparison]::Ordinal) -lt
    $toolCostAttestation.IndexOf(
      'AND privilege.grantee <> type.typowner',
      [StringComparison]::Ordinal
    )
) 'Tool cost attestation owner ACL filtering must occur inside actual_type_acl.'
$tests++
Assert-True (
  (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\Test-EnterpriseDatabaseRestore.ps1') -Raw -Encoding utf8).Contains('Get-EnterpriseToolCostAttestationIntegritySql')
) 'Restore runner must execute the Tool cost attestation gate.'
$tests++
Assert-True (
  (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\Test-EnterpriseDatabaseRestore.ps1') -Raw -Encoding utf8).Contains('DROP CONSTRAINT tool_execution_receipts_cost_attestation_check')
) 'Restore runner must execute a Tool cost attestation negative control.'
$tests++

$aiEvaluation = Get-EnterpriseAiEvaluationIntegritySql
foreach ($required in @(
  '(SELECT count(*) FROM protected_tables) = 20',
  "'ai_evaluation_datasets'",
  "'ai_evaluation_dataset_versions'",
  "'ai_evaluation_thresholds'",
  "'ai_evaluation_cases'",
  "'ai_evaluation_case_evidence'",
  "'ai_evaluation_annotations'",
  "'ai_evaluation_annotation_evidence'",
  "'ai_evaluation_review_evidence'",
  "'ai_evaluation_answer_feedback_sources'",
  "'ai_evaluation_runner_attestations'",
  "'ai_evaluation_runners'",
  "'ai_evaluation_runs'",
  "'ai_evaluation_case_results'",
  "'ai_evaluation_case_result_evidence'",
  "'ai_evaluation_metric_results'",
  "'ai_evaluation_metric_result_evidence'",
  "'ai_evaluation_verification_evidence'",
  "'ai_evaluation_bad_cases'",
  "'ai_evaluation_bad_case_evidence'",
  "'ai_evaluation_release_checks'",
  "'enterprise_agent_evaluation_runner'",
  "'ai_evaluation_tenant_isolation'",
  "'ai_evaluation_admin_access'",
  "'ai_evaluation_runner_run_access'",
  'app.evaluation_runner_id',
  'result_submitted_by_runner_id',
  "'ai_evaluation_dataset_versions_mutation_guard'",
  "'ai_evaluation_dataset_seal_trigger'",
  "'ai_evaluation_runs_mutation_guard'",
  "'ai_evaluation_runs_results_trigger'",
  "'ai_evaluation_case_results_insert_guard'",
  "'ai_evaluation_metric_results_insert_guard'",
  "'ai_evaluation_runner_attestations_insert_guard'",
  "'ai_evaluation_runner_attestations_append_only'",
  "'ai_evaluation_runner_attestations_side_effects'",
  "'ai_evaluation_feedback_projector_read'",
  "'ai_evaluation_feedback_projector_insert'",
  "'ai_evaluation_answer_feedback_sources_binding_guard'",
  "'ai_evaluation_answer_feedback_sources_append_only'",
  "'ai_evaluation_answer_feedback_pair_required'",
  'expected_feedback_functions',
  "'public.ai_evaluation_sanitize_feedback_input(text)'",
  "'public.ai_evaluation_derive_answer_feedback_source(uuid,uuid,uuid)'",
  "'public.ai_evaluation_answer_feedback_source_guard()'",
  "'public.ai_evaluation_answer_feedback_pair_guard()'",
  "'public.project_not_helpful_answer_feedback_bad_case(uuid)'",
  "'enterprise_agent_feedback_projector'",
  'actual_feedback_function_acl',
  "'ai_evaluation_release_checks_append_only'",
  'actual_acl',
  'expected_acl',
  'actual_policies',
  'expected_policies',
  'target_table.relrowsecurity',
  'target_table.relforcerowsecurity',
  'NOT rolcanlogin',
  'NOT rolinherit',
  'NOT rolbypassrls',
  "'public.audit_events'",
  "'public.outbox_events'",
  'EXCEPT'
)) {
  Assert-True ($aiEvaluation.Contains($required)) "AI evaluation restore gate is missing $required."
  $tests++
}

$auditChain = Get-EnterpriseAuditChainIntegritySql
foreach ($required in @(
  "'chain_sequence'",
  "'previous_hash'",
  "'event_hash'",
  "'audit_events_assign_chain'",
  "'audit_events_append_only'",
  "'audit_events_reject_truncate'",
  "'verify_audit_event_chain'",
  "'audit_events_tenant_chain_sequence_key'",
  "'audit_events_tenant_event_hash_key'",
  "'UPDATE,DELETE,TRUNCATE'",
  'audit_event_chain_payload',
  'NOT EXISTS (SELECT 1 FROM invalid_events)'
)) {
  Assert-True ($auditChain.Contains($required)) "Audit chain restore gate is missing $required."
  $tests++
}
foreach ($expectedPolicy in @(
  "('tenant_isolation', ARRAY['PUBLIC']::text[], '*', false)",
  "('enterprise_agent_admin_access', ARRAY['enterprise_agent_admin']::text[], '*', true)",
  "('enterprise_agent_access', ARRAY['enterprise_agent_app']::text[], 'r', true)",
  "('enterprise_agent_lifecycle_access', ARRAY['enterprise_agent_lifecycle']::text[], '*', true)",
  "('enterprise_agent_process_read', ARRAY['enterprise_agent_process']::text[], 'r', true)",
  "('tool_gateway_parent_read', ARRAY['enterprise_agent_tool_gateway']::text[], 'r', true)",
  "('tool_gateway_parent_tenant', ARRAY['enterprise_agent_tool_gateway']::text[], 'r', false)"
)) {
  Assert-True ($tenantRls.Contains($expectedPolicy)) "Role Assignment policy gate is missing $expectedPolicy."
  $tests++
}
Assert-True (-not $tenantRls.Contains("'identity_scim_assignment_access'")) 'Dormant SCIM Role Assignment policy must not survive the exact policy gate.'
$tests++
foreach ($required in @(
  'expected_role_assignment_policies(policy_name, role_names, command, permissive)',
  'actual_role_assignment_policies',
  'policy_definition.polname::text AS policy_name',
  'policy_definition.polcmd::text AS command',
  'policy_definition.polpermissive AS permissive',
  'SELECT * FROM actual_role_assignment_policies',
  'SELECT * FROM expected_role_assignment_policies',
  'EXCEPT'
)) {
  Assert-True ($tenantRls.Contains($required)) "Exact Role Assignment policy gate is missing $required."
  $tests++
}
foreach ($required in @(
  'expected_lifecycle_policies(',
  'actual_lifecycle_policies',
  "'enterprise_agent_lifecycle_tenant_enumeration'",
  "ARRAY['enterprise_agent_lifecycle']::text[]",
  "role_definition.rolname = 'enterprise_agent_lifecycle'",
  '(SELECT count(*) FROM expected_lifecycle_policies) = 10',
  'SELECT * FROM actual_lifecycle_policies',
  'SELECT * FROM expected_lifecycle_policies',
  'EXCEPT'
)) {
  Assert-True ($tenantRls.Contains($required)) "Exact lifecycle policy gate is missing $required."
  $tests++
}
foreach ($expectedPolicy in @(
  "('tenant_isolation', ARRAY['PUBLIC']::text[], '*', false)",
  "('enterprise_agent_admin_access', ARRAY['enterprise_agent_admin']::text[], 'r', true)",
  "('enterprise_agent_runtime_access', ARRAY['enterprise_agent_runtime']::text[], '*', true)"
)) {
  Assert-True ($tenantRls.Contains($expectedPolicy)) "AI Runtime policy gate is missing $expectedPolicy."
  $tests++
}
foreach ($required in @(
  'expected_ai_runtime_policies(policy_name, role_names, command, permissive)',
  'actual_ai_runtime_policies',
  "target_table.relname = 'ai_runtime_runs'",
  '(SELECT count(*) FROM expected_ai_runtime_policies) = 3',
  'SELECT * FROM actual_ai_runtime_policies',
  'SELECT * FROM expected_ai_runtime_policies',
  'EXCEPT'
)) {
  Assert-True ($tenantRls.Contains($required)) "Exact AI Runtime policy gate is missing $required."
  $tests++
}
$normalizedTenantRls = ($tenantRls -replace '\s+', ' ') -replace '\s+\)', ')'
foreach ($expectedPolicy in @(
  "('enterprise_agent_admin_tenant_isolation', ARRAY['enterprise_agent_admin']::text[], '*', false, '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)', '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)')",
  "('enterprise_agent_admin_access', ARRAY['enterprise_agent_admin']::text[], '*', true, 'true', 'true')"
)) {
  Assert-True ($normalizedTenantRls.Contains($expectedPolicy)) "Outbox admin policy gate is missing $expectedPolicy."
  $tests++
}
foreach ($required in @(
  'expected_outbox_admin_policies(',
  'actual_outbox_admin_policies',
  'policy_name,',
  'role_names,',
  'command,',
  'permissive,',
  'using_expression,',
  'check_expression',
  "ARRAY['enterprise_agent_admin']::text[]",
  "target_table.relname = 'outbox_events'",
  '0::oid = ANY(policy_definition.polroles)',
  "role_definition.rolname = 'enterprise_agent_admin'",
  'pg_get_expr(policy_definition.polqual, policy_definition.polrelid) AS using_expression',
  'pg_get_expr(policy_definition.polwithcheck, policy_definition.polrelid) AS check_expression',
  '(SELECT count(*) FROM expected_outbox_admin_policies) = 2',
  'SELECT * FROM actual_outbox_admin_policies',
  'SELECT * FROM expected_outbox_admin_policies',
  'EXCEPT'
)) {
  Assert-True ($tenantRls.Contains($required)) "Exact outbox admin policy gate is missing $required."
  $tests++
}

$restoreScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\Test-EnterpriseDatabaseRestore.ps1') -Raw -Encoding utf8
foreach ($requiredNegativeControl in @(
  'ALTER TABLE public.agent_runs NO FORCE ROW LEVEL SECURITY',
  'DROP POLICY tenant_isolation ON public.agent_runs',
  'OR true',
  'CREATE TABLE public.enterprise_restore_gate_unregistered_probe',
  'ALTER TABLE public.auth_login_rate_limits NO FORCE ROW LEVEL SECURITY',
  'tenantRlsNegativeControls'
)) {
  Assert-True ($restoreScript.Contains($requiredNegativeControl)) "Restore script lost tenant negative control $requiredNegativeControl."
  $tests++
}
foreach ($required in @(
  'Get-EnterpriseScimCancellationHardeningSql',
  'scimCancellationHardening = $scimCancellationHardening',
  'scimCancellationNegativeControls',
  'GRANT EXECUTE ON FUNCTION public.resolve_scim_capability(text, text) TO PUBLIC',
  'GRANT SELECT ON TABLE public.scim_service_tokens TO enterprise_agent_scim',
  'ALTER FUNCTION public.resolve_scim_capability(text, text) SECURITY INVOKER',
  'DISABLE TRIGGER agent_runs_untrusted_cancellation_guard',
  'DISABLE TRIGGER scim_users_deprovision',
  'DROP INDEX public.agent_runs_pending_cancellation_idx',
  'DROP CONSTRAINT agent_runs_cancellation_evidence_check',
  'GRANT UPDATE (cancellation_confirmed_at)',
  'scimCancellationRestoredAfterControl'
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore script is missing SCIM cancellation negative control: $required."
  $tests++
}
foreach ($required in @(
  'SELECT count(*) FROM public."knowledge_entities"',
  'SELECT count(*) FROM public."knowledge_entity_mentions"',
  'SELECT count(*) FROM public."knowledge_relations"',
  'SELECT count(*) FROM public."knowledge_relation_evidence"',
  'SELECT count(*) FROM public."role_assignments"',
  'SELECT count(*) FROM public."ai_runtime_runs"',
  'SELECT count(*) FROM public."ai_evaluation_datasets"',
  'SELECT count(*) FROM public."ai_evaluation_runners"',
  'SELECT count(*) FROM public."ai_evaluation_runs"',
  'knowledgeGraphTablesReadable',
  'knowledgeEntities = $knowledgeEntityCount',
  'knowledgeEntityMentions = $knowledgeEntityMentionCount',
  'knowledgeRelations = $knowledgeRelationCount',
  'knowledgeRelationEvidence = $knowledgeRelationEvidenceCount',
  'roleAssignments = $roleAssignmentCount'
  'aiRuntimeRuns = $aiRuntimeRunCount',
  'aiEvaluationDatasets = $aiEvaluationDatasetCount',
  'aiEvaluationRunners = $aiEvaluationRunnerCount',
  'aiEvaluationRuns = $aiEvaluationRunCount',
  'Get-EnterpriseAiEvaluationIntegritySql',
  'aiEvaluationIntegrity = $aiEvaluationIntegrity',
  'Get-EnterpriseAuditChainIntegritySql',
  'auditChainIntegrity = $auditChainIntegrity',
  'EnterpriseFinopsCostVerificationGateSql.ps1',
  'Get-EnterpriseFinopsCostVerificationIntegritySql',
  'finopsCostVerificationIntegrity = $finopsCostVerificationIntegrity',
  "'enterprise_agent_vector_acceptance'"
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore core graph check is missing $required."
  $tests++
}

$loginRateLimit = Get-EnterpriseAuthLoginRateLimitBoundarySql
foreach ($required in @('auth_login_rate_limits', 'relrowsecurity', 'relforcerowsecurity', 'enterprise_agent_auth_access', "= 'true'")) {
  Assert-True ($loginRateLimit.Contains($required)) "Login throttle boundary gate is missing $required."
  $tests++
}

$tokenPolicies = Get-EnterpriseAuthActionTokenPolicyIntegritySql
foreach ($required in @('auth_action_tokens_admin_access', 'auth_action_tokens_auth_access', '= 3', "polcmd = '*'", "= 'true'")) {
  Assert-True ($tokenPolicies.Contains($required)) "Action-token policy gate is missing $required."
  $tests++
}

$keys = Get-EnterpriseAuthActionTokenKeyConstraintsSql
foreach ($required in @(
  'auth_action_tokens_pkey',
  'auth_action_tokens_token_hash_key',
  'auth_action_tokens_tenant_id_fkey',
  'auth_action_tokens_tenant_id_user_id_fkey',
  'auth_action_tokens_tenant_id_created_by_id_fkey',
  'constraint_definition.conkey',
  'constraint_definition.confkey',
  "constraint_definition.confdeltype = 'c'"
)) {
  Assert-True ($keys.Contains($required)) "Exact key gate is missing $required."
  $tests++
}

$index = Get-EnterpriseAuthActionTokenActiveIndexSql
foreach ($required in @('indisvalid', 'indisready', 'indislive', "string_to_array(index_definition.indkey::text, ' ')::smallint[]", 'consumed_atisnullandrevoked_atisnull')) {
  Assert-True ($index.Contains($required)) "Exact active-token index gate is missing $required."
  $tests++
}

$checks = Get-EnterpriseAuthActionTokenCheckConstraintsSql
foreach ($required in @(
  'pg_get_constraintdef',
  "'::character varying::text'",
  "'::text[]'",
  "'CHECK (delivery_attempts >= 0)'",
  "'CHECK (expires_at > created_at)'",
  "'CHECK (consumed_at IS NULL OR revoked_at IS NULL)'"
)) {
  Assert-True ($checks.Contains($required)) "Exact action-token CHECK gate is missing $required."
  $tests++
}

$usage = Get-EnterpriseAgentRunUsageConstraintsSql
foreach ($required in @(
  'agent_runs_succeeded_reported_usage_positive_check',
  'agent_runs_total_tokens_consistent_check',
  'agent_runs_unverified_tokens_zero_check',
  'agent_runs_unverified_cost_zero_check',
  'agent_runs_usage_nonnegative_check',
  'agent_runs_grounded_citation_count_check',
  "'CHECK (grounded_citation_count >= 0 AND grounded_citation_count <= 12)'",
  "attribute_definition.attname = 'grounded_citation_count'",
  "format_type(",
  ") = 'integer'",
  'attribute_definition.attnotnull',
  "attribute_definition.attidentity = ''",
  "attribute_definition.attgenerated = ''",
  'pg_get_expr(',
  ") = '0'",
  '(SELECT count(*) FROM expected) = 6',
  'pg_get_constraintdef'
)) {
  Assert-True ($usage.Contains($required)) "Exact Agent Run usage gate is missing $required."
  $tests++
}
foreach ($required in @(
  'Get-EnterpriseAgentRunUsageConstraintsSql',
  'agentRunUsageConstraints = $agentRunUsageConstraints -eq ''t'''
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore script is not enforcing Agent Run usage and grounding integrity: $required."
  $tests++
}

$agentRunStream = Get-EnterpriseAgentRunStreamIntegritySql
foreach ($required in @(
  "ARRAY['DELTA', 'TERMINAL', 'TERMINAL_ONLY', 'TERMINAL_RECONCILED']::text[]",
  "'agent_run_stream_events_sequence_bounds_check'",
  "'checksequence>=1andsequence<=10001'",
  "'checksequencebetween1and10001'",
  "'agent_run_stream_events_shape_check'",
  "'sequence<10000'",
  "''terminal_reconciled''::agentrunstreameventtype",
  "'agent_run_stream_events_one_terminal_idx'",
  "'agent_run_stream_events_one_reconciled_terminal_idx'",
  "ARRAY['tenant_id', 'run_id']::text[]",
  "'type=anyarray[''terminal''::agentrunstreameventtype,''terminal_only''::agentrunstreameventtype]'",
  "'type=''terminal_reconciled''::agentrunstreameventtype'",
  "'agent_run_stream_events_insert_guard'",
  "'agent_run_stream_events_append_only'",
  "'agent_run_stream_events_reject_truncate'",
  "'public.guard_agent_run_stream_event_insert()'",
  "'public.reject_agent_run_stream_event_mutation()'",
  "actual.tgenabled = 'O'",
  'actual.trigger_type = expected.trigger_type',
  'actual.tgfoid = to_regprocedure(expected.function_signature)',
  'actual.has_no_column_filter',
  'function_definition.prosecdef',
  "ARRAY['search_path=pg_catalog, public']::text[]",
  "owner_name = 'postgres'",
  'owner_bypasses_rls',
  'actual_function_acl',
  'function_acl.grantee <> function_definition.proowner',
  'NOT EXISTS (SELECT 1 FROM actual_function_acl)',
  'pg_advisory_xact_lock',
  'compact_definition',
  'existing_event."delta"isnotdistinctfromnew."delta"',
  "digest(convert_to(new.`"delta`",''utf8''),''sha256'')",
  'sequence must be contiguous',
  'terminal stream event must match the durable Agent Run status',
  'reconciled terminal requires a prior UNKNOWN terminal marker',
  'agent_run_stream_events is append-only',
  'EXCEPT'
)) {
  Assert-True ($agentRunStream.Contains($required)) "Agent Run stream integrity gate is missing $required."
  $tests++
}
foreach ($required in @(
  'Get-EnterpriseAgentRunStreamIntegritySql',
  'agentRunStreamIntegrity = $agentRunStreamIntegrity -eq ''t'''
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore script is missing Agent Run stream integrity wiring: $required."
  $tests++
}

$supportingIndexes = Get-EnterpriseAuthActionTokenSupportingIndexesSql
foreach ($required in @(
  'auth_action_tokens_tenant_user_purpose_created_idx',
  'auth_action_tokens_expires_at_idx',
  'index_definition.indoption',
  'ARRAY[0, 0, 0, 3]'
)) {
  Assert-True ($supportingIndexes.Contains($required)) "Action-token supporting-index gate is missing $required."
  $tests++
}

$businessSemantics = Get-EnterpriseBusinessSemanticsIntegritySql
foreach ($required in @(
  '(SELECT count(*) FROM semantic_tables) = 25',
  'enterprise_agent_app',
  'enterprise_agent_admin',
  'enterprise_agent_process',
  'process_reference_tables',
  'enterprise_agent_process_read',
  'enterprise_agent_process_task_link',
  'enterprise_agent_tool_gateway',
  'tool_gateway_parent_read',
  'tool_gateway_parent_tenant',
  'actual_acl',
  'expected_acl',
  'actual_policies',
  'expected_policies',
  'agent_runs_tenant_task_id_fkey',
  'tasks_objective_value_fkey',
  'tasks_process_definition_fkey',
  'tasks_process_version_fkey',
  'tasks_process_node_fkey',
  'tasks_completion_integrity_trigger',
  'deliverable_evidence_task_completion_reverse_trigger',
  'process_definitions_active_current_version_trigger',
  'task_dependencies_cycle_trigger',
  'process_versions_one_published_per_definition_idx',
  'agent_runs_tenant_task_id_idx',
  "attribute_definition.attname = 'task_id'",
  'constraint_definition.convalidated',
  'index_definition.indisvalid',
  'target_table.relforcerowsecurity'
)) {
  Assert-True ($businessSemantics.Contains($required)) "Business semantics integrity gate is missing $required."
  $tests++
}
foreach ($required in @(
  'Get-EnterpriseBusinessSemanticsIntegritySql',
  'businessSemanticsIntegrity = $businessSemanticsIntegrity'
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore script is missing business semantics gate wiring: $required."
  $tests++
}

$processCollaboration = Get-EnterpriseProcessCollaborationIntegritySql
foreach ($required in @(
  '(SELECT count(*) FROM expected_functions) = 10',
  'public.validate_business_ledger_parent_bijection()',
  'public.build_process_step_assignment_snapshot(uuid,uuid,uuid,uuid,uuid,timestamptz)',
  'public.build_trusted_assignment_snapshot(uuid,uuid,jsonb,timestamptz,uuid,text)',
  'public.guard_process_step_attempt_integrity()',
  'public.guard_process_step_transition()',
  'public.guard_correction_feedback_insert()',
  'public.guard_correction_case_update()',
  'public.validate_correction_trace()',
  'public.guard_correction_case_reviewer_liveness()',
  'public.guard_event_delivery_replay_attribution_v2()',
  "actual.owner_name = 'postgres'",
  'actual.security_definer = expected.security_definer',
  'expected_function_acl',
  'actual_function_acl',
  'enterprise_agent_process',
  'business_event_evidence_parent_bijection_trigger',
  'correction_case_evidence_parent_bijection_trigger',
  'correction_feedback_evidence_parent_bijection_trigger',
  'process_step_instances_attempt_integrity_trigger',
  'correction_cases_trace_completeness_trigger',
  'correction_cases_reviewer_liveness_trigger',
  'business_event_deliveries_replay_attribution_v2_trigger',
  'collaboration_participants_active_user_key',
  'collaboration_participants_active_agent_key',
  "actual.predicate = 'active'",
  "actual.predicate = 'active AND agent_id IS NOT NULL'",
  'pg_get_triggerdef',
  'parent_count <> join_count',
  'p_task_id IS NULL',
  'p_required_action IS NULL',
  'organizationIds',
  'orgUnitIds',
  'NEW."attempt" <> OLD."attempt" + 1',
  'AND NOT is_retry',
  'actor_is_reviewer',
  'legacy_independent_reviewer',
  'actor_user IS DISTINCT FROM subject_user_id',
  'correction_cases_reviewer_liveness_check',
  "current_setting(''app.tenant_id'', true)",
  "current_setting(''app.user_id'', true)",
  'NEW."replayed_by_user_id" IS DISTINCT FROM session_user_id',
  "current_record.`"severity`" = ''LOW''",
  "replay_status = ''OPEN''"
)) {
  Assert-True ($processCollaboration.Contains($required)) "Process collaboration integrity gate is missing $required."
  $tests++
}
foreach ($required in @(
  'Get-EnterpriseProcessCollaborationIntegritySql',
  'processCollaborationIntegrity = $processCollaborationIntegrity',
  'processCollaborationNegativeControl',
  'DROP TRIGGER business_event_evidence_parent_bijection_trigger',
  'processCollaborationIndexNegativeControl',
  'DROP INDEX public.collaboration_participants_active_user_key',
  'processCollaborationRestoredAfterControl'
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore script is missing process collaboration gate wiring: $required."
  $tests++
}

$v2TenantTables = Get-EnterpriseV2TenantTableIntegritySql
foreach ($required in @(
  '(SELECT count(*) FROM expected_tables) = 31',
  '(SELECT count(*) FROM expected_acl) = 52',
  '(SELECT count(*) FROM expected_foreign_keys) = 104',
  "'agent_run_stream_events'",
  "'ai_evaluation_answer_feedback_sources'",
  "'ai_evaluation_runner_attestations'",
  "'ai_governance_commands'",
  "'ai_model_attempt_receipts'",
  "'ai_model_catalog_versions'",
  "'ai_model_circuit_states'",
  "'ai_model_route_candidates'",
  "'ai_model_route_policy_versions'",
  "'ai_safety_decisions'",
  "'employee_task_acceptance_requests'",
  "'employee_task_commands'",
  "'experience_candidates'",
  "'experience_commands'",
  "'experience_knowledge_projections'",
  "'experience_publication_org_targets'",
  "'experience_publication_role_targets'",
  "'experience_publications'",
  "'experience_review_evidence'",
  "'experience_source_deliverables'",
  "'experience_source_evidence'",
  "'experience_validations'",
  "'finops_cost_verification_reviews'",
  "'finops_projection_diagnostics'",
  "'finops_projection_jobs'",
  "'identity_break_glass_events'",
  "'identity_break_glass_requests'",
  "'identity_governance_commands'",
  "'memory_commands'",
  "'memory_records'",
  "'memory_source_evidence'",
  "'enterprise_agent_feedback_projector'",
  "'enterprise_agent_task_executor'",
  "'enterprise_agent_finops_projector'",
  "'enterprise_agent_employee_insights'",
  'actual_acl',
  'expected_acl',
  'actual_foreign_keys',
  'expected_foreign_keys',
  'actual_policy_roles',
  'pg_get_constraintdef',
  'definition_hash',
  "'finops_cost_verification_reviews', 'enterprise_agent_admin',",
  "ARRAY['INSERT', 'SELECT']::text[]",
  "'finops_cost_verification_reviews_cost_fkey', '670e3be6db5680dede3f212c70e7f5c9'",
  "'finops_cost_verification_reviews_evidence_fkey', '75f64cd32b102f56788fc1163cd3bca5'",
  "'finops_cost_verification_reviews_reviewer_fkey', '69a814a040e63237f35e2540befed6be'",
  "'finops_cost_verification_reviews_tenant_fkey', '2bfa187e4818280b1bac2b5a55d17129'",
  'constraint_definition.convalidated',
  'target_table.relforcerowsecurity',
  'EXCEPT'
)) {
  Assert-True ($v2TenantTables.Contains($required)) "V2 tenant-table integrity gate is missing $required."
  $tests++
}

$v2TenantRowCounts = Get-EnterpriseV2TenantTableRowCountsSql
Assert-True ($v2TenantRowCounts.Contains('jsonb_build_object')) 'V2 row-count query must return one JSON object.'
$tests++
foreach ($tableName in @(
  'agent_run_stream_events',
  'ai_evaluation_answer_feedback_sources',
  'ai_evaluation_runner_attestations',
  'ai_governance_commands',
  'ai_model_attempt_receipts',
  'ai_model_catalog_versions',
  'ai_model_circuit_states',
  'ai_model_route_candidates',
  'ai_model_route_policy_versions',
  'ai_safety_decisions',
  'employee_task_acceptance_requests',
  'employee_task_commands',
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
  'finops_cost_verification_reviews',
  'finops_projection_diagnostics',
  'finops_projection_jobs',
  'identity_break_glass_events',
  'identity_break_glass_requests',
  'identity_governance_commands',
  'memory_commands',
  'memory_records',
  'memory_source_evidence'
)) {
  Assert-True ($v2TenantRowCounts.Contains("'$tableName'")) "V2 row-count query is missing $tableName."
  $tests++
}
$v2RowCountEntryCount = [regex]::Matches(
  $v2TenantRowCounts,
  "'[^']+',\s+\(SELECT count\(\*\)"
).Count
Assert-True ($v2RowCountEntryCount -eq 31) "V2 row-count SQL has $v2RowCountEntryCount keys instead of 31."
Assert-True ($restoreScript.Contains('@($v2TenantTableRowCounts.PSObject.Properties).Count -eq 31')) 'Restore script V2 readable-count assertion is not synchronized to 31 keys.'
$tests += 2

foreach ($required in @(
  'Get-EnterpriseV2TenantTableIntegritySql',
  'v2TenantTableIntegrity = $v2TenantTableIntegrity',
  'v2TenantTableNegativeControls',
  'REVOKE SELECT ON TABLE public.memory_records',
  'DROP CONSTRAINT agent_run_stream_events_tenant_id_run_id_fkey',
  'ALTER TABLE public.memory_records NO FORCE ROW LEVEL SECURITY',
  'Get-EnterpriseV2TenantTableRowCountsSql',
  'v2TenantTablesReadable',
  'restoredV2TenantTableRowCounts',
  'sourceV2TenantTableRowCountsAfterSnapshot',
  'schemaMetadataMatchesManifest',
  '$migrationCount -eq [int]$manifest.migrationCount',
  '$forcedRlsTableCount -eq [int]$manifest.forcedRlsTableCount'
)) {
  Assert-True ($restoreScript.Contains($required)) "Restore script is missing V2 gate wiring: $required."
  $tests++
}

$backupScript = Get-Content -LiteralPath (
  Join-Path $PSScriptRoot '..\Backup-EnterpriseDatabase.ps1'
) -Raw -Encoding utf8
Assert-True (-not $backupScript.Contains('--no-owner')) 'Backups must preserve database object ownership.'
Assert-True (-not $restoreScript.Contains('--no-owner')) 'Restores must preserve SECURITY DEFINER ownership.'
$tests += 2
foreach ($required in @(
  'EnterpriseRestoreGateSql.ps1',
  'Get-EnterpriseV2TenantTableRowCountsSql',
  'v2TenantTableRowCounts = $v2TenantTableRowCounts'
)) {
  Assert-True ($backupScript.Contains($required)) "Backup manifest is missing V2 row-count wiring: $required."
  $tests++
}

foreach ($required in @(
  'pg_has_role(',
  "'USAGE'",
  "('outbox_events', 'enterprise_agent_employee_insights')",
  "('outbox_events', 'enterprise_agent_finops_projector')",
  "('outbox_events', 'enterprise_agent_task_executor')",
  "('users', 'enterprise_agent_process')",
  "WHERE table_name <> 'auth_login_rate_limits'",
  'SELECT table_name FROM special_tenant_tables'
)) {
  Assert-True ($tenantRls.Contains($required)) "Tenant RLS classification gate is missing $required."
  $tests++
}

[ordered]@{ status = 'passed'; tests = $tests } | ConvertTo-Json
