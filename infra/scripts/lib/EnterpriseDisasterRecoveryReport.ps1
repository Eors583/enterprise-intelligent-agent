function New-EnterpriseDisasterRecoveryReport {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$')][string]$ExerciseId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,62}$')][string]$SourceDatabase,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$BackupSha256,
    [Parameter(Mandatory = $true)][DateTimeOffset]$RecoveryPointUtc,
    [Parameter(Mandatory = $true)][DateTimeOffset]$IncidentDeclaredAtUtc,
    [Parameter(Mandatory = $true)][DateTimeOffset]$RecoveryStartedAtUtc,
    [Parameter(Mandatory = $true)][DateTimeOffset]$DatabaseValidatedAtUtc,
    [Parameter(Mandatory = $true)][ValidateRange(1, 15)][int]$RpoObjectiveMinutes,
    [Parameter(Mandatory = $true)][ValidateRange(1, 240)][int]$RtoObjectiveMinutes,
    [Parameter(Mandatory = $true)]$RestoreReport,
    [string]$OffsiteRestoreEvidenceReference = '',
    [string]$PitrReplayEvidenceReference = ''
  )

  $orderingValid = (
    $RecoveryPointUtc -le $IncidentDeclaredAtUtc -and
    $IncidentDeclaredAtUtc -le $RecoveryStartedAtUtc -and
    $RecoveryStartedAtUtc -le $DatabaseValidatedAtUtc
  )
  $restoreEvidenceValid = (
    $null -ne $RestoreReport -and
    [string]$RestoreReport.status -eq 'restore-verified' -and
    $RestoreReport.cleanupVerified -is [bool] -and
    [bool]$RestoreReport.cleanupVerified -and
    [string]$RestoreReport.sourceDatabase -eq $SourceDatabase -and
    [string]$RestoreReport.backupSha256 -eq $BackupSha256
  )

  $measuredRpoMinutes = [Math]::Round(
    ($IncidentDeclaredAtUtc - $RecoveryPointUtc).TotalMinutes,
    3
  )
  $measuredRtoMinutes = [Math]::Round(
    ($DatabaseValidatedAtUtc - $IncidentDeclaredAtUtc).TotalMinutes,
    3
  )
  $rpoMet = $orderingValid -and $measuredRpoMinutes -le $RpoObjectiveMinutes
  $rtoMet = $orderingValid -and $measuredRtoMinutes -le $RtoObjectiveMinutes
  $databaseObjectivesMet = $restoreEvidenceValid -and $rpoMet -and $rtoMet

  $boundaries = @('PRODUCTION_TRAFFIC_FAILOVER_NOT_TESTED')
  $boundaries += 'OFFSITE_RESTORE_NOT_TESTED'
  $boundaries += 'PITR_REPLAY_NOT_TESTED'
  if (-not $orderingValid) { $boundaries += 'TIMELINE_EVIDENCE_INVALID' }
  if (-not $restoreEvidenceValid) { $boundaries += 'RESTORE_REPORT_NOT_VERIFIED' }

  $status = if (-not $orderingValid -or -not $restoreEvidenceValid) {
    'invalid-evidence'
  }
  elseif ($databaseObjectivesMet) {
    'database-objectives-met'
  }
  else {
    'database-objectives-breached'
  }

  return [ordered]@{
    contractVersion = 1
    scope = 'DATABASE_ISOLATED_REHEARSAL'
    status = $status
    exerciseId = $ExerciseId
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceDatabase = $SourceDatabase
    backupSha256 = $BackupSha256
    timeline = [ordered]@{
      recoveryPointUtc = $RecoveryPointUtc.ToUniversalTime().ToString('o')
      incidentDeclaredAtUtc = $IncidentDeclaredAtUtc.ToUniversalTime().ToString('o')
      recoveryStartedAtUtc = $RecoveryStartedAtUtc.ToUniversalTime().ToString('o')
      databaseValidatedAtUtc = $DatabaseValidatedAtUtc.ToUniversalTime().ToString('o')
    }
    objectives = [ordered]@{
      rpoMinutes = $RpoObjectiveMinutes
      rtoMinutes = $RtoObjectiveMinutes
    }
    measurements = [ordered]@{
      rpoMinutes = $measuredRpoMinutes
      rtoMinutes = $measuredRtoMinutes
    }
    objectiveResults = [ordered]@{
      rpoMet = $rpoMet
      rtoMet = $rtoMet
      databaseRestoreMet = $databaseObjectivesMet
    }
    evidence = [ordered]@{
      restoreReportVerified = $restoreEvidenceValid
      cleanupVerified = if ($null -eq $RestoreReport) { $false } else { [bool]$RestoreReport.cleanupVerified }
      offsiteRestoreVerified = $false
      offsiteRestoreEvidenceRecorded = -not [string]::IsNullOrWhiteSpace($OffsiteRestoreEvidenceReference)
      offsiteRestoreEvidenceReference = if ([string]::IsNullOrWhiteSpace($OffsiteRestoreEvidenceReference)) { $null } else { $OffsiteRestoreEvidenceReference }
      pitrReplayVerified = $false
      pitrReplayEvidenceRecorded = -not [string]::IsNullOrWhiteSpace($PitrReplayEvidenceReference)
      pitrReplayEvidenceReference = if ([string]::IsNullOrWhiteSpace($PitrReplayEvidenceReference)) { $null } else { $PitrReplayEvidenceReference }
      productionTrafficFailoverVerified = $false
    }
    unverifiedBoundaries = $boundaries
  }
}

function Test-EnterpriseDisasterRecoveryReport {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Report)

  $blockers = @()
  if ([int]$Report.contractVersion -ne 1) { $blockers += 'CONTRACT_VERSION_UNSUPPORTED' }
  if ([string]$Report.scope -ne 'DATABASE_ISOLATED_REHEARSAL') { $blockers += 'SCOPE_INVALID' }
  if ([string]$Report.status -notin @('database-objectives-met', 'database-objectives-breached', 'invalid-evidence')) {
    $blockers += 'STATUS_INVALID'
  }
  if ([string]$Report.backupSha256 -notmatch '^[0-9a-f]{64}$') { $blockers += 'BACKUP_HASH_INVALID' }
  if ([int]$Report.objectives.rpoMinutes -lt 1 -or [int]$Report.objectives.rpoMinutes -gt 15) {
    $blockers += 'RPO_OBJECTIVE_INVALID'
  }
  if ([int]$Report.objectives.rtoMinutes -lt 1 -or [int]$Report.objectives.rtoMinutes -gt 240) {
    $blockers += 'RTO_OBJECTIVE_INVALID'
  }
  if ($Report.evidence.productionTrafficFailoverVerified -isnot [bool] -or [bool]$Report.evidence.productionTrafficFailoverVerified) {
    $blockers += 'ISOLATED_REPORT_CANNOT_VERIFY_PRODUCTION_FAILOVER'
  }

  $timelineValid = $false
  try {
    $recoveryPoint = [DateTimeOffset]::Parse([string]$Report.timeline.recoveryPointUtc)
    $incident = [DateTimeOffset]::Parse([string]$Report.timeline.incidentDeclaredAtUtc)
    $started = [DateTimeOffset]::Parse([string]$Report.timeline.recoveryStartedAtUtc)
    $validated = [DateTimeOffset]::Parse([string]$Report.timeline.databaseValidatedAtUtc)
    if (-not ($recoveryPoint -le $incident -and $incident -le $started -and $started -le $validated)) {
      $blockers += 'TIMELINE_INVALID'
    }
    else {
      $timelineValid = $true
    }
    $calculatedRpo = [Math]::Round(($incident - $recoveryPoint).TotalMinutes, 3)
    $calculatedRto = [Math]::Round(($validated - $incident).TotalMinutes, 3)
    if ([Math]::Abs($calculatedRpo - [double]$Report.measurements.rpoMinutes) -gt 0.001) {
      $blockers += 'RPO_MEASUREMENT_MISMATCH'
    }
    if ([Math]::Abs($calculatedRto - [double]$Report.measurements.rtoMinutes) -gt 0.001) {
      $blockers += 'RTO_MEASUREMENT_MISMATCH'
    }
  }
  catch {
    $blockers += 'TIMELINE_INVALID'
  }

  $rpoMet = $timelineValid -and [double]$Report.measurements.rpoMinutes -le [double]$Report.objectives.rpoMinutes
  $rtoMet = $timelineValid -and [double]$Report.measurements.rtoMinutes -le [double]$Report.objectives.rtoMinutes
  if ($Report.objectiveResults.rpoMet -isnot [bool] -or [bool]$Report.objectiveResults.rpoMet -ne $rpoMet) {
    $blockers += 'RPO_RESULT_MISMATCH'
  }
  if ($Report.objectiveResults.rtoMet -isnot [bool] -or [bool]$Report.objectiveResults.rtoMet -ne $rtoMet) {
    $blockers += 'RTO_RESULT_MISMATCH'
  }
  $restoreEvidenceValid = (
    $Report.evidence.restoreReportVerified -is [bool] -and
    [bool]$Report.evidence.restoreReportVerified -and
    $Report.evidence.cleanupVerified -is [bool] -and
    [bool]$Report.evidence.cleanupVerified
  )
  $expectedMet = (
    $restoreEvidenceValid -and
    $rpoMet -and
    $rtoMet
  )
  if ($Report.objectiveResults.databaseRestoreMet -isnot [bool] -or [bool]$Report.objectiveResults.databaseRestoreMet -ne $expectedMet) {
    $blockers += 'DATABASE_RESULT_MISMATCH'
  }
  $expectedStatus = if (-not $timelineValid -or -not $restoreEvidenceValid) {
    'invalid-evidence'
  }
  elseif ($expectedMet) {
    'database-objectives-met'
  }
  else {
    'database-objectives-breached'
  }
  if ([string]$Report.status -ne $expectedStatus) {
    $blockers += 'STATUS_RESULT_MISMATCH'
  }

  [object[]]$boundaries = @($Report.unverifiedBoundaries)
  if ($boundaries -notcontains 'PRODUCTION_TRAFFIC_FAILOVER_NOT_TESTED') {
    $blockers += 'PRODUCTION_FAILOVER_BOUNDARY_MISSING'
  }
  foreach ($evidenceName in @('offsiteRestore', 'pitrReplay')) {
    $verifiedName = $evidenceName + 'Verified'
    $recordedName = $evidenceName + 'EvidenceRecorded'
    $referenceName = $evidenceName + 'EvidenceReference'
    $verified = $Report.evidence.$verifiedName
    $recorded = $Report.evidence.$recordedName
    $reference = $Report.evidence.$referenceName
    if ($verified -isnot [bool] -or [bool]$verified) {
      $blockers += ($evidenceName.ToUpperInvariant() + '_VERIFICATION_OVERCLAIMED')
    }
    if ($recorded -isnot [bool] -or ([bool]$recorded -ne (-not [string]::IsNullOrWhiteSpace([string]$reference)))) {
      $blockers += ($evidenceName.ToUpperInvariant() + '_EVIDENCE_MISMATCH')
    }
  }

  return [ordered]@{
    valid = $blockers.Count -eq 0
    blockers = @($blockers | Select-Object -Unique)
  }
}
