$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseBackupHealth.ps1')

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', received '$Actual'." }
}

function Write-TestBackup {
  param([string]$Directory, [string]$BaseName, [DateTime]$CreatedAt)
  $archivePath = Join-Path $Directory "$BaseName.dump"
  [System.IO.File]::WriteAllText($archivePath, "archive-$BaseName", [System.Text.UTF8Encoding]::new($false))
  $archive = Get-Item -LiteralPath $archivePath
  $manifestPath = Join-Path $Directory "$BaseName.manifest.json"
  $manifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = $CreatedAt.ToString('o')
    sourceDatabase = 'acceptance_db'
    archiveFile = $archive.Name
    archiveBytes = $archive.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  }
  [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  return [ordered]@{ manifestPath = $manifestPath; manifest = $manifest }
}

$testNow = [DateTime]'2026-07-22T12:00:00Z'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('enterprise-agent-backup-health-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
try {
  $weekly = Write-TestBackup -Directory $tempRoot -BaseName 'acceptance_db-20260720T030000Z-weekly' -CreatedAt ([DateTime]'2026-07-20T03:00:00Z')
  (Get-Item -LiteralPath $weekly.manifestPath).LastWriteTimeUtc = [DateTime]'2026-07-20T03:00:00Z'
  $reportPath = [System.IO.Path]::ChangeExtension($weekly.manifestPath, '.restore-report.json')
  $report = [ordered]@{
    status = 'restore-verified'
    verifiedAtUtc = '2026-07-20T03:10:00.0000000Z'
    sourceDatabase = 'acceptance_db'
    backupSha256 = $weekly.manifest.sha256
    cleanupVerified = $true
  }
  [System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  (Get-Item -LiteralPath $reportPath).LastWriteTimeUtc = [DateTime]'2026-07-20T03:10:00Z'

  $daily = Write-TestBackup -Directory $tempRoot -BaseName 'acceptance_db-20260722T020000Z-daily' -CreatedAt ([DateTime]'2026-07-22T02:00:00Z')
  (Get-Item -LiteralPath $daily.manifestPath).LastWriteTimeUtc = [DateTime]'2026-07-22T02:00:00Z'

  $status = Get-EnterpriseBackupContinuityStatus `
    -BackupDirectory $tempRoot `
    -Database 'acceptance_db' `
    -BackupMaxAgeHours 25 `
    -RestoreReportMaxAgeHours 168 `
    -UtcNow $testNow
  Assert-Equal $status.backupStatus 'fresh' 'The newest daily backup must be evaluated independently.'
  Assert-Equal $status.restoreStatus 'verified' 'A recent weekly restore report must survive newer daily backups.'

  $dailyManifestFile = Get-Item -LiteralPath $daily.manifestPath
  $fullIntegrity = Test-EnterpriseBackupManifestFile `
    -ManifestFile $dailyManifestFile `
    -Database 'acceptance_db' `
    -UtcNow $testNow `
    -VerifyArchiveHash
  Assert-Equal $fullIntegrity.valid $true 'A backup-created hash must pass an explicit low-frequency integrity check.'
  $dailyArchivePath = Join-Path $tempRoot ([string]$daily.manifest.archiveFile)
  $archiveText = Get-Content -LiteralPath $dailyArchivePath -Raw -Encoding utf8
  [System.IO.File]::WriteAllText(
    $dailyArchivePath,
    ('X' + $archiveText.Substring(1)),
    [System.Text.UTF8Encoding]::new($false)
  )
  $metadataOnly = Test-EnterpriseBackupManifestFile -ManifestFile $dailyManifestFile -Database 'acceptance_db' -UtcNow $testNow
  Assert-Equal $metadataOnly.valid $true 'The high-frequency probe must use protected metadata and size without rereading a full archive.'
  $tamperedFullIntegrity = Test-EnterpriseBackupManifestFile `
    -ManifestFile $dailyManifestFile `
    -Database 'acceptance_db' `
    -UtcNow $testNow `
    -VerifyArchiveHash
  Assert-Equal $tamperedFullIntegrity.valid $false 'The restore/low-frequency integrity path must reject same-size archive tampering.'

  $report.cleanupVerified = $false
  [System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  (Get-Item -LiteralPath $reportPath).LastWriteTimeUtc = [DateTime]'2026-07-22T03:00:00Z'
  $cleanupFailed = Get-EnterpriseBackupContinuityStatus -BackupDirectory $tempRoot -Database 'acceptance_db' -UtcNow $testNow
  Assert-Equal $cleanupFailed.restoreStatus 'stale-or-invalid' 'Cleanup must be verified before a restore report is accepted.'

  [ordered]@{ status = 'passed'; tests = 6 } | ConvertTo-Json
}
finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  $resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $resolvedTemp.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a test directory outside the system temp root.'
  }
  Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
}
