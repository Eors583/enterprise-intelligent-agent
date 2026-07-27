function Test-EnterpriseBackupManifestFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$ManifestFile,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][DateTime]$UtcNow,
    [switch]$VerifyArchiveHash
  )

  try {
    $manifest = Get-Content -LiteralPath $ManifestFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    if ([int]$manifest.formatVersion -ne 1) { throw 'unsupported manifest version' }
    if ([string]$manifest.sourceDatabase -ne $Database) { throw 'source mismatch' }
    $archiveFile = [string]$manifest.archiveFile
    if ([string]::IsNullOrWhiteSpace($archiveFile) -or [System.IO.Path]::GetFileName($archiveFile) -ne $archiveFile) {
      throw 'invalid archive name'
    }
    $archivePath = Join-Path $ManifestFile.DirectoryName $archiveFile
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'archive missing' }
    $archive = Get-Item -LiteralPath $archivePath
    if ($archive.Length -ne [long]$manifest.archiveBytes) { throw 'size mismatch' }
    $expectedHash = [string]$manifest.sha256
    if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw 'invalid hash' }
    if ($VerifyArchiveHash) {
      $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) { throw 'hash mismatch' }
    }
    $createdAt = [DateTimeOffset]::Parse([string]$manifest.createdAtUtc).UtcDateTime
    if ($createdAt -gt $UtcNow.AddMinutes(5)) { throw 'future timestamp' }
    return [ordered]@{
      valid = $true
      manifestPath = $ManifestFile.FullName
      archivePath = $archivePath
      sha256 = $expectedHash
      hashVerified = [bool]$VerifyArchiveHash
      createdAtUtc = $createdAt
      manifest = $manifest
    }
  }
  catch {
    return [ordered]@{ valid = $false; manifestPath = $ManifestFile.FullName }
  }
}

function Get-EnterpriseBackupContinuityStatus {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [Parameter(Mandatory = $true)][string]$Database,
    [ValidateRange(1, 168)][int]$BackupMaxAgeHours = 25,
    [ValidateRange(1, 720)][int]$RestoreReportMaxAgeHours = 168,
    [DateTime]$UtcNow = [DateTime]::UtcNow
  )

  $resolved = [System.IO.Path]::GetFullPath($BackupDirectory)
  $manifestFiles = @(
    Get-ChildItem -LiteralPath $resolved -Filter "$Database-*.manifest.json" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending
  )
  $backupStatus = 'missing'
  if ($manifestFiles.Count -gt 0) {
    $latestBackup = Test-EnterpriseBackupManifestFile -ManifestFile $manifestFiles[0] -Database $Database -UtcNow $UtcNow
    if (-not [bool]$latestBackup.valid) {
      $backupStatus = 'invalid'
    }
    else {
      $backupAge = $UtcNow - [DateTime]$latestBackup.createdAtUtc
      $backupStatus = if ($backupAge.TotalHours -le $BackupMaxAgeHours) { 'fresh' } else { 'stale' }
    }
  }

  # Restore freshness is intentionally independent from the newest daily
  # backup. A weekly verified rehearsal remains valid until its own SLA expires.
  $reportFiles = @(
    Get-ChildItem -LiteralPath $resolved -Filter "$Database-*.manifest.restore-report.json" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending
  )
  $restoreStatus = 'missing'
  if ($reportFiles.Count -gt 0) {
    $restoreStatus = 'stale-or-invalid'
    try {
      $latestReportFile = $reportFiles[0]
      $suffix = '.manifest.restore-report.json'
      if (-not $latestReportFile.Name.EndsWith($suffix, [StringComparison]::Ordinal)) {
        throw 'invalid report name'
      }
      $prefix = $latestReportFile.Name.Substring(0, $latestReportFile.Name.Length - $suffix.Length)
      $pairedManifestPath = Join-Path $resolved ($prefix + '.manifest.json')
      if (-not (Test-Path -LiteralPath $pairedManifestPath -PathType Leaf)) { throw 'paired manifest missing' }
      $pairedManifestFile = Get-Item -LiteralPath $pairedManifestPath
      $pairedManifest = Test-EnterpriseBackupManifestFile -ManifestFile $pairedManifestFile -Database $Database -UtcNow $UtcNow
      if (-not [bool]$pairedManifest.valid) { throw 'paired backup invalid' }

      $report = Get-Content -LiteralPath $latestReportFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
      if ([string]$report.status -ne 'restore-verified') { throw 'restore not verified' }
      if ([string]$report.sourceDatabase -ne $Database) { throw 'source mismatch' }
      if ([string]$report.backupSha256 -ne [string]$pairedManifest.sha256) { throw 'hash mismatch' }
      if ($report.cleanupVerified -isnot [bool] -or -not [bool]$report.cleanupVerified) { throw 'cleanup not verified' }
      $verifiedAt = [DateTimeOffset]::Parse([string]$report.verifiedAtUtc).UtcDateTime
      if ($verifiedAt -gt $UtcNow.AddMinutes(5)) { throw 'future timestamp' }
      if ($verifiedAt -lt [DateTime]$pairedManifest.createdAtUtc) { throw 'report predates backup' }
      $reportAge = $UtcNow - $verifiedAt
      $restoreStatus = if ($reportAge.TotalHours -le $RestoreReportMaxAgeHours) { 'verified' } else { 'stale-or-invalid' }
    }
    catch {
      $restoreStatus = 'stale-or-invalid'
    }
  }

  return [ordered]@{
    backupStatus = $backupStatus
    restoreStatus = $restoreStatus
    integrityMode = 'protected-metadata-and-size'
    manifestCount = $manifestFiles.Count
    restoreReportCount = $reportFiles.Count
  }
}
