$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseDisasterRecoveryReport.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$hash = 'a' * 64
$restoreReport = [pscustomobject]@{
  status = 'restore-verified'
  cleanupVerified = $true
  sourceDatabase = 'enterprise_agent'
  backupSha256 = $hash
}

$report = New-EnterpriseDisasterRecoveryReport `
  -ExerciseId 'dr-test-001' `
  -SourceDatabase 'enterprise_agent' `
  -BackupSha256 $hash `
  -RecoveryPointUtc ([DateTimeOffset]'2026-07-28T00:00:00Z') `
  -IncidentDeclaredAtUtc ([DateTimeOffset]'2026-07-28T00:10:00Z') `
  -RecoveryStartedAtUtc ([DateTimeOffset]'2026-07-28T00:12:00Z') `
  -DatabaseValidatedAtUtc ([DateTimeOffset]'2026-07-28T01:10:00Z') `
  -RpoObjectiveMinutes 15 `
  -RtoObjectiveMinutes 240 `
  -RestoreReport $restoreReport `
  -OffsiteRestoreEvidenceReference 'evidence://offsite/object-42' `
  -PitrReplayEvidenceReference 'evidence://pitr/replay-42'

Assert-True ($report.status -eq 'database-objectives-met') 'Verified restore within objectives must pass.'
Assert-True ($report.measurements.rpoMinutes -eq 10) 'RPO measurement is incorrect.'
Assert-True ($report.measurements.rtoMinutes -eq 60) 'RTO measurement is incorrect.'
Assert-True ($report.unverifiedBoundaries -contains 'PRODUCTION_TRAFFIC_FAILOVER_NOT_TESTED') 'Production boundary must be explicit.'
Assert-True ($report.unverifiedBoundaries -contains 'OFFSITE_RESTORE_NOT_TESTED') 'Offsite boundary must be explicit.'
Assert-True ($report.unverifiedBoundaries -contains 'PITR_REPLAY_NOT_TESTED') 'PITR boundary must be explicit.'
Assert-True $report.evidence.offsiteRestoreEvidenceRecorded 'Offsite evidence reference must be recorded.'
Assert-True (-not $report.evidence.offsiteRestoreVerified) 'A reference alone must not verify offsite restore.'
Assert-True $report.evidence.pitrReplayEvidenceRecorded 'PITR evidence reference must be recorded.'
Assert-True (-not $report.evidence.pitrReplayVerified) 'A reference alone must not verify PITR replay.'

$validation = Test-EnterpriseDisasterRecoveryReport -Report ([pscustomobject]$report)
Assert-True $validation.valid 'Generated report must satisfy its contract.'

$tampered = $report | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$tampered.measurements.rtoMinutes = 1
$tamperedValidation = Test-EnterpriseDisasterRecoveryReport -Report $tampered
Assert-True (-not $tamperedValidation.valid) 'Tampered measurements must be rejected.'
Assert-True ($tamperedValidation.blockers -contains 'RTO_MEASUREMENT_MISMATCH') 'RTO mismatch blocker missing.'

$missingBoundary = $report | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$missingBoundary.unverifiedBoundaries = @('OFFSITE_RESTORE_NOT_TESTED', 'PITR_REPLAY_NOT_TESTED')
$missingBoundaryValidation = Test-EnterpriseDisasterRecoveryReport -Report $missingBoundary
Assert-True (-not $missingBoundaryValidation.valid) 'A report must not hide the production failover boundary.'
Assert-True ($missingBoundaryValidation.blockers -contains 'PRODUCTION_FAILOVER_BOUNDARY_MISSING') 'Production boundary blocker missing.'

$breached = New-EnterpriseDisasterRecoveryReport `
  -ExerciseId 'dr-test-002' `
  -SourceDatabase 'enterprise_agent' `
  -BackupSha256 $hash `
  -RecoveryPointUtc ([DateTimeOffset]'2026-07-28T00:00:00Z') `
  -IncidentDeclaredAtUtc ([DateTimeOffset]'2026-07-28T00:15:00Z') `
  -RecoveryStartedAtUtc ([DateTimeOffset]'2026-07-28T00:20:00Z') `
  -DatabaseValidatedAtUtc ([DateTimeOffset]'2026-07-28T05:00:00Z') `
  -RpoObjectiveMinutes 15 `
  -RtoObjectiveMinutes 240 `
  -RestoreReport $restoreReport
Assert-True ($breached.status -eq 'database-objectives-breached') 'An RTO breach must not pass.'
Assert-True (-not $breached.objectiveResults.rtoMet) 'RTO result must be false.'

$invalidEvidence = New-EnterpriseDisasterRecoveryReport `
  -ExerciseId 'dr-test-003' `
  -SourceDatabase 'enterprise_agent' `
  -BackupSha256 $hash `
  -RecoveryPointUtc ([DateTimeOffset]'2026-07-28T00:00:00Z') `
  -IncidentDeclaredAtUtc ([DateTimeOffset]'2026-07-28T00:10:00Z') `
  -RecoveryStartedAtUtc ([DateTimeOffset]'2026-07-28T00:12:00Z') `
  -DatabaseValidatedAtUtc ([DateTimeOffset]'2026-07-28T00:30:00Z') `
  -RpoObjectiveMinutes 15 `
  -RtoObjectiveMinutes 240 `
  -RestoreReport ([pscustomobject]@{
    status = 'restore-verification-failed'
    cleanupVerified = $true
    sourceDatabase = 'enterprise_agent'
    backupSha256 = $hash
  })
Assert-True ($invalidEvidence.status -eq 'invalid-evidence') 'Unverified restore evidence must fail closed.'

Write-Output 'Enterprise disaster recovery report tests passed (18 assertions).'
