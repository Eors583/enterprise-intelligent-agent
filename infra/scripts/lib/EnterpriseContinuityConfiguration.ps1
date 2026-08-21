function Test-EnterpriseContinuityConfiguration {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Configuration)

  $blockers = @()
  $warnings = @()

  if ($null -eq $Configuration -or $Configuration -is [Array] -or $Configuration -is [ValueType] -or $Configuration -is [string]) {
    return [ordered]@{
      valid = $false
      blockers = @('CONFIGURATION_MUST_BE_AN_OBJECT')
      warnings = @()
    }
  }

  if ([int]$Configuration.contractVersion -ne 1) { $blockers += 'CONTRACT_VERSION_UNSUPPORTED' }
  if ([string]$Configuration.environment -ne 'production') { $blockers += 'ENVIRONMENT_NOT_PRODUCTION' }
  if ([string]$Configuration.database -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$') {
    $blockers += 'DATABASE_IDENTIFIER_INVALID'
  }

  $backup = $Configuration.backup
  if ($null -eq $backup) {
    $blockers += 'BACKUP_CONFIGURATION_MISSING'
  }
  else {
    if ([string]::IsNullOrWhiteSpace([string]$backup.schedule)) {
      $blockers += 'BACKUP_SCHEDULE_MISSING'
    }
    if ([int]$backup.localRetentionDays -lt 2 -or [int]$backup.localRetentionDays -gt 90) {
      $blockers += 'LOCAL_RETENTION_OUT_OF_RANGE'
    }
  }

  $offsite = if ($null -eq $backup) { $null } else { $backup.offsite }
  if ($null -eq $offsite -or $offsite.enabled -isnot [bool] -or -not [bool]$offsite.enabled) {
    $blockers += 'OFFSITE_BACKUP_NOT_ENABLED'
  }
  else {
    if ([string]$offsite.provider -notin @('s3_compatible', 'azure_blob', 'gcs')) {
      $blockers += 'OFFSITE_PROVIDER_UNSUPPORTED'
    }
    if ([string]$offsite.destination -notmatch '^(s3|az|gs)://[A-Za-z0-9][A-Za-z0-9._/-]{2,1023}$') {
      $blockers += 'OFFSITE_DESTINATION_INVALID'
    }
    if ($offsite.separateFailureDomain -isnot [bool] -or -not [bool]$offsite.separateFailureDomain) {
      $blockers += 'OFFSITE_FAILURE_DOMAIN_NOT_SEPARATE'
    }
    if ([string]::IsNullOrWhiteSpace([string]$offsite.region)) {
      $blockers += 'OFFSITE_REGION_MISSING'
    }
    if (-not (Test-EnterpriseSecretReference -Value ([string]$offsite.credentialReference))) {
      $blockers += 'OFFSITE_CREDENTIAL_REFERENCE_INVALID'
    }

    $encryption = $offsite.encryption
    if ($null -eq $encryption -or [string]$encryption.mode -ne 'KMS_ENVELOPE') {
      $blockers += 'OFFSITE_KMS_ENCRYPTION_REQUIRED'
    }
    elseif (-not (Test-EnterpriseSecretReference -Value ([string]$encryption.keyReference))) {
      $blockers += 'OFFSITE_KMS_KEY_REFERENCE_INVALID'
    }

    $immutability = $offsite.immutability
    if ($null -eq $immutability -or [string]$immutability.mode -notin @('OBJECT_LOCK_COMPLIANCE', 'WORM')) {
      $blockers += 'OFFSITE_IMMUTABILITY_REQUIRED'
    }
    elseif ([int]$immutability.retentionDays -lt 14 -or [int]$immutability.retentionDays -gt 3650) {
      $blockers += 'OFFSITE_IMMUTABLE_RETENTION_OUT_OF_RANGE'
    }
  }

  $pitr = $Configuration.pitr
  if ($null -eq $pitr -or $pitr.enabled -isnot [bool] -or -not [bool]$pitr.enabled) {
    $blockers += 'PITR_NOT_ENABLED'
  }
  else {
    if ($pitr.walArchiveEnabled -isnot [bool] -or -not [bool]$pitr.walArchiveEnabled) {
      $blockers += 'PITR_WAL_ARCHIVE_NOT_ENABLED'
    }
    if ($pitr.timelineHistoryEnabled -isnot [bool] -or -not [bool]$pitr.timelineHistoryEnabled) {
      $blockers += 'PITR_TIMELINE_HISTORY_NOT_ENABLED'
    }
    if ($pitr.restoreCommandConfigured -isnot [bool] -or -not [bool]$pitr.restoreCommandConfigured) {
      $blockers += 'PITR_RESTORE_COMMAND_NOT_CONFIGURED'
    }
    if ([int]$pitr.recoveryWindowMinutes -lt 1 -or [int]$pitr.recoveryWindowMinutes -gt 15) {
      $blockers += 'PITR_RECOVERY_WINDOW_EXCEEDS_RPO'
    }
    if ([int]$pitr.retentionHours -lt 24 -or [int]$pitr.retentionHours -gt 8760) {
      $blockers += 'PITR_RETENTION_OUT_OF_RANGE'
    }
    if (-not (Test-EnterpriseSecretReference -Value ([string]$pitr.credentialReference))) {
      $blockers += 'PITR_CREDENTIAL_REFERENCE_INVALID'
    }
  }

  $drill = $Configuration.drill
  if ($null -eq $drill) {
    $blockers += 'DRILL_CONFIGURATION_MISSING'
  }
  else {
    if ([int]$drill.rpoObjectiveMinutes -lt 1 -or [int]$drill.rpoObjectiveMinutes -gt 15) {
      $blockers += 'RPO_OBJECTIVE_EXCEEDS_15_MINUTES'
    }
    if ([int]$drill.rtoObjectiveMinutes -lt 1 -or [int]$drill.rtoObjectiveMinutes -gt 240) {
      $blockers += 'RTO_OBJECTIVE_EXCEEDS_4_HOURS'
    }
    if ([int]$drill.maxReportAgeHours -lt 1 -or [int]$drill.maxReportAgeHours -gt 720) {
      $blockers += 'DRILL_REPORT_MAX_AGE_OUT_OF_RANGE'
    }
    if ($drill.isolatedRestoreRequired -isnot [bool] -or -not [bool]$drill.isolatedRestoreRequired) {
      $blockers += 'ISOLATED_RESTORE_NOT_REQUIRED'
    }
  }

  if (Test-EnterpriseInlineCredential -Value $Configuration) {
    $blockers += 'INLINE_CREDENTIAL_FORBIDDEN'
  }
  if (Test-EnterprisePlaceholderValue -Value $Configuration) {
    $blockers += 'PLACEHOLDER_VALUE_FORBIDDEN'
  }

  if ($blockers.Count -eq 0) {
    $warnings += 'CONFIGURATION_ONLY_REQUIRES_RUNTIME_EVIDENCE'
  }

  return [ordered]@{
    valid = $blockers.Count -eq 0
    blockers = @($blockers | Select-Object -Unique)
    warnings = @($warnings)
  }
}

function Test-EnterprisePlaceholderValue {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Value)

  if ($null -eq $Value) { return $false }
  if ($Value -is [string]) {
    return $Value -match '(?i)(replace[-_ ]with|change[-_ ]?me|placeholder)'
  }
  if ($Value -is [Array]) {
    foreach ($item in $Value) {
      if (Test-EnterprisePlaceholderValue -Value $item) { return $true }
    }
    return $false
  }
  if ($Value -is [ValueType]) { return $false }
  foreach ($property in $Value.PSObject.Properties) {
    if (Test-EnterprisePlaceholderValue -Value $property.Value) { return $true }
  }
  return $false
}

function Test-EnterpriseSecretReference {
  [CmdletBinding()]
  param([AllowEmptyString()][string]$Value)

  return $Value -match '^(secret|vault|kms)://[A-Za-z0-9][A-Za-z0-9._:/-]{2,511}$'
}

function Test-EnterpriseInlineCredential {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Value)

  if ($null -eq $Value) { return $false }
  if ($Value -is [Array]) {
    foreach ($item in $Value) {
      if (Test-EnterpriseInlineCredential -Value $item) { return $true }
    }
    return $false
  }
  if ($Value -is [string] -or $Value -is [ValueType]) { return $false }

  foreach ($property in $Value.PSObject.Properties) {
    $name = [string]$property.Name
    if ($name -match '(?i)(password|accessKey|secretKey|bearerToken|apiKey)$') {
      if (-not [string]::IsNullOrWhiteSpace([string]$property.Value)) { return $true }
    }
    if (Test-EnterpriseInlineCredential -Value $property.Value) { return $true }
  }
  return $false
}
