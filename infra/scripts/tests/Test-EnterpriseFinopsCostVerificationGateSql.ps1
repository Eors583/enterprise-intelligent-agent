$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseFinopsCostVerificationGateSql.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$sql = Get-EnterpriseFinopsCostVerificationIntegritySql
$tests = 0
foreach ($required in @(
  'finops_cost_verification_reviews',
  'finops_effective_cost_verifications',
  'finops_effective_cost_verification_status',
  'finops_prepare_cost_verification_review',
  'finops_cost_review_budget_alert_projector',
  'relrowsecurity',
  'relforcerowsecurity',
  'expected_acl',
  'actual_acl',
  'expected_foreign_keys',
  'actual_foreign_keys',
  'expected_triggers',
  'actual_triggers',
  'security_invoker',
  'EXCEPT'
)) {
  Assert-True ($sql.Contains($required)) "FinOps verification restore gate is missing $required."
  $tests++
}
foreach ($forbiddenPrivilege in @('UPDATE', 'DELETE', 'TRUNCATE')) {
  Assert-True (
    -not $sql.Contains(
      "('enterprise_agent_admin'::text, '$forbiddenPrivilege'::text, false)"
    )
  ) "FinOps verification restore gate must not grant $forbiddenPrivilege."
  $tests++
}

Write-Output "FinOps cost verification restore SQL gate tests passed: $tests"
