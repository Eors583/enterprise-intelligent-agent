[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$ManifestPath,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$RestoreReportPath,

  [Parameter(Mandatory = $true)]
  [DateTimeOffset]$IncidentDeclaredAtUtc,

  [ValidateRange(1, 15)]
  [int]$RpoObjectiveMinutes = 15,

  [ValidateRange(1, 240)]
  [int]$RtoObjectiveMinutes = 240,

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$')]
  [string]$OffsiteRestoreEvidenceReference = '',

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$')]
  [string]$PitrReplayEvidenceReference = '',

  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupHealth.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseDisasterRecoveryReport.ps1')

$resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
$resolvedRestoreReport = [System.IO.Path]::GetFullPath($RestoreReportPath)
$manifest = Get-Content -LiteralPath $resolvedManifest -Raw -Encoding utf8 | ConvertFrom-Json
$restoreReport = Get-Content -LiteralPath $resolvedRestoreReport -Raw -Encoding utf8 | ConvertFrom-Json
$manifestValidation = Test-EnterpriseBackupManifestFile `
  -ManifestFile (Get-Item -LiteralPath $resolvedManifest) `
  -Database ([string]$manifest.sourceDatabase) `
  -UtcNow ([DateTime]::UtcNow) `
  -VerifyArchiveHash
if (-not [bool]$manifestValidation.valid) {
  throw 'A disaster recovery report requires a protected manifest with a matching archive SHA-256.'
}

if ([string]$restoreReport.status -ne 'restore-verified') {
  throw 'A disaster recovery report requires a restore-verified source report.'
}
if ([string]$manifest.sourceDatabase -ne [string]$restoreReport.sourceDatabase) {
  throw 'Backup manifest and restore report source databases do not match.'
}
if ([string]$manifest.sha256 -ne [string]$restoreReport.backupSha256) {
  throw 'Backup manifest and restore report hashes do not match.'
}

$report = New-EnterpriseDisasterRecoveryReport `
  -ExerciseId ('dr-' + [Guid]::NewGuid().ToString('N')) `
  -SourceDatabase ([string]$manifest.sourceDatabase) `
  -BackupSha256 ([string]$manifest.sha256) `
  -RecoveryPointUtc ([DateTimeOffset]::Parse([string]$manifest.createdAtUtc)) `
  -IncidentDeclaredAtUtc $IncidentDeclaredAtUtc `
  -RecoveryStartedAtUtc ([DateTimeOffset]::Parse([string]$restoreReport.attemptedAtUtc)) `
  -DatabaseValidatedAtUtc ([DateTimeOffset]::Parse([string]$restoreReport.verifiedAtUtc)) `
  -RpoObjectiveMinutes $RpoObjectiveMinutes `
  -RtoObjectiveMinutes $RtoObjectiveMinutes `
  -RestoreReport $restoreReport `
  -OffsiteRestoreEvidenceReference $OffsiteRestoreEvidenceReference `
  -PitrReplayEvidenceReference $PitrReplayEvidenceReference

$validation = Test-EnterpriseDisasterRecoveryReport -Report $report
if (-not [bool]$validation.valid) {
  throw "Generated disaster recovery report failed its contract: $($validation.blockers -join ', ')."
}

$resolvedOutput = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  [System.IO.Path]::ChangeExtension($resolvedRestoreReport, '.dr-report.json')
}
else {
  [System.IO.Path]::GetFullPath($OutputPath)
}
$outputDirectory = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
  throw 'Disaster recovery report output directory must already exist.'
}
Write-EnterpriseProtectedJsonAtomically -Path $resolvedOutput -Value $report -Depth 8

[ordered]@{
  status = [string]$report.status
  reportPath = $resolvedOutput
  rpoMinutes = [double]$report.measurements.rpoMinutes
  rtoMinutes = [double]$report.measurements.rtoMinutes
  unverifiedBoundaries = @($report.unverifiedBoundaries)
} | ConvertTo-Json -Depth 5

if ([string]$report.status -ne 'database-objectives-met') { exit 2 }
