$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseDataGovernanceDryRunSql.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$sql = Get-EnterpriseDataGovernanceDryRunSql
$tests = 0
foreach ($required in @(
  'BEGIN TRANSACTION READ ONLY',
  'outbox_event_routes',
  'outbox_event_deliveries',
  'terminalUpperBoundCandidates',
  'unknownRunsPreservingHolds',
  'ONTOLOGY.MAPPING.MISSING',
  'aggregateSchemaGaps',
  'nonCurrentVersionsWithGraphEvidence',
  'BLOCKED_SCHEMA_CAPABILITY_NOT_INSTALLED',
  'auditEventsRequiredForApply',
  'mutationsPerformed',
  'historyDeleted'
)) {
  Assert-True ($sql.Contains($required)) "Governance dry-run SQL is missing $required."
  $tests++
}

foreach ($forbidden in @(
  'DELETE FROM',
  'TRUNCATE ',
  'UPDATE public.',
  'INSERT INTO public.',
  'COMMIT;'
)) {
  Assert-True (-not $sql.Contains($forbidden)) "Governance dry-run must not contain $forbidden."
  $tests++
}
Assert-True ($sql.Contains('ROLLBACK;')) 'Governance dry-run must end with ROLLBACK.'
$tests++

$entrypoint = Get-Content -Raw -Encoding utf8 (Join-Path $PSScriptRoot '..\Invoke-EnterpriseDataGovernanceDryRun.ps1')
foreach ($required in @(
  'enterprise_agent_acceptance',
  'enterprise_agent_vector_acceptance',
  'isolated restore/rehearsal database',
  'Get-FileHash -Algorithm SHA256',
  'read-only-dry-run-complete'
)) {
  Assert-True ($entrypoint.Contains($required)) "Governance entrypoint is missing $required."
  $tests++
}
Assert-True (-not $entrypoint.Contains('Invoke-Expression')) 'Governance entrypoint must not evaluate generated shell commands.'
$tests++
Assert-True (-not $entrypoint.Contains('[switch]$Apply')) 'Governance entrypoint must not expose an apply mode.'
$tests++

Write-Output "Enterprise data-governance dry-run tests passed: $tests"
