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
  "'first_attempted_at'", 'EXCEPT', 'is_grantable'
)) {
  Assert-True ($privileges.Contains($required)) "Privilege gate is missing $required."
  $tests++
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

$tenantRls = Get-EnterpriseTenantRlsIntegritySql
foreach ($required in @(
  "('agent_runs', 'tenant_id', ARRAY['PUBLIC']::text[])",
  "('auth_action_tokens', 'tenant_id', ARRAY['enterprise_agent_admin']::text[])",
  "('outbox_events', 'tenant_id', ARRAY['enterprise_agent_app', 'enterprise_agent_provisioner']::text[])",
  '(SELECT count(*) FROM expected) = 31',
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
  'pg_get_constraintdef'
)) {
  Assert-True ($usage.Contains($required)) "Exact Agent Run usage gate is missing $required."
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

[ordered]@{ status = 'passed'; tests = $tests } | ConvertTo-Json
