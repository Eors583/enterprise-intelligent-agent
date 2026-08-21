[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$SourceContainer,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$SourceDatabase,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$SourceDatabaseUser,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$RestoreContainer,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$RestoreDatabaseUser,

  [ValidateLength(1, 63)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*_restore_rehearsal$')]
  [string]$RestoreDatabase = 'enterprise_agent_automated_restore_rehearsal',

  [string]$BackupDirectory = '',

  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 14,

  [switch]$InitializeBackupDirectory,

  [ValidateRange(1, 15)]
  [int]$RpoObjectiveMinutes = 15,

  [ValidateRange(1, 240)]
  [int]$RtoObjectiveMinutes = 240,

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$')]
  [string]$OffsiteRestoreEvidenceReference = '',

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$')]
  [string]$PitrReplayEvidenceReference = '',

  [switch]$AllowSharedCluster
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  $BackupDirectory = Join-Path $PSScriptRoot '..\..\.data\backups'
}

function ConvertFrom-TrailingJson {
  param([Parameter(Mandatory = $true)][object[]]$Output)

  $text = ($Output | Out-String).Trim()
  try {
    return $text | ConvertFrom-Json
  }
  catch {
    $start = $text.LastIndexOf("`n{")
    if ($start -ge 0) { $start += 1 } else { $start = $text.IndexOf('{') }
    if ($start -lt 0) { throw 'A child operation did not return JSON.' }
    try {
      return $text.Substring($start) | ConvertFrom-Json
    }
    catch {
      throw 'A child operation returned invalid JSON.'
    }
  }
}

$backupArguments = @{
  Container = $SourceContainer
  Database = $SourceDatabase
  DatabaseUser = $SourceDatabaseUser
  OutputDirectory = $BackupDirectory
  RetentionDays = $RetentionDays
}
if ($InitializeBackupDirectory) { $backupArguments.InitializeBackupDirectory = $true }
$backupOutput = @(& (Join-Path $PSScriptRoot 'Backup-EnterpriseDatabase.ps1') @backupArguments)
$backup = ConvertFrom-TrailingJson -Output $backupOutput
if ([string]$backup.status -ne 'backup-created') {
  throw 'The backup operation did not report success.'
}
$incidentDeclaredAtUtc = [DateTimeOffset]::UtcNow

$restoreArguments = @{
  Container = $RestoreContainer
  DatabaseUser = $RestoreDatabaseUser
  ManifestPath = [string]$backup.manifestPath
  TargetDatabase = $RestoreDatabase
}
if ($AllowSharedCluster) { $restoreArguments.AllowSharedCluster = $true }
$restoreOutput = @(& (Join-Path $PSScriptRoot 'Test-EnterpriseDatabaseRestore.ps1') @restoreArguments)
$restore = ConvertFrom-TrailingJson -Output $restoreOutput
if ([string]$restore.status -ne 'restore-verified' -or $restore.cleanupVerified -isnot [bool] -or -not [bool]$restore.cleanupVerified) {
  throw 'The restore rehearsal did not report a verified restore.'
}

$disasterRecoveryArguments = @{
  ManifestPath = [string]$backup.manifestPath
  RestoreReportPath = [System.IO.Path]::ChangeExtension([string]$backup.manifestPath, '.restore-report.json')
  IncidentDeclaredAtUtc = $incidentDeclaredAtUtc
  RpoObjectiveMinutes = $RpoObjectiveMinutes
  RtoObjectiveMinutes = $RtoObjectiveMinutes
}
if (-not [string]::IsNullOrWhiteSpace($OffsiteRestoreEvidenceReference)) {
  $disasterRecoveryArguments.OffsiteRestoreEvidenceReference = $OffsiteRestoreEvidenceReference
}
if (-not [string]::IsNullOrWhiteSpace($PitrReplayEvidenceReference)) {
  $disasterRecoveryArguments.PitrReplayEvidenceReference = $PitrReplayEvidenceReference
}
$disasterRecoveryOutput = @(
  & (Join-Path $PSScriptRoot 'Publish-EnterpriseDisasterRecoveryReport.ps1') @disasterRecoveryArguments
)
$disasterRecovery = ConvertFrom-TrailingJson -Output $disasterRecoveryOutput
if ([string]$disasterRecovery.status -ne 'database-objectives-met') {
  throw 'The database restore rehearsal did not meet the configured RPO/RTO objectives.'
}

[ordered]@{
  status = 'backup-and-restore-verified'
  completedAtUtc = [DateTime]::UtcNow.ToString('o')
  sourceDatabase = $SourceDatabase
  restoreDatabase = $RestoreDatabase
  archivePath = [string]$backup.archivePath
  manifestPath = [string]$backup.manifestPath
  sha256 = [string]$backup.sha256
  migrationCount = [int]$backup.migrationCount
  restoreReportStatus = [string]$restore.status
  restoreCleanupVerified = [bool]$restore.cleanupVerified
  restoreChecks = $restore.checks
  disasterRecoveryReportStatus = [string]$disasterRecovery.status
  disasterRecoveryReportPath = [string]$disasterRecovery.reportPath
  measuredRpoMinutes = [double]$disasterRecovery.rpoMinutes
  measuredRtoMinutes = [double]$disasterRecovery.rtoMinutes
  disasterRecoveryUnverifiedBoundaries = @($disasterRecovery.unverifiedBoundaries)
} | ConvertTo-Json -Depth 7
