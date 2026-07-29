$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('enterprise-agent-dr-publisher-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
try {
  $archivePath = Join-Path $tempRoot 'acceptance_db-20260728T000000Z-test.dump'
  [System.IO.File]::WriteAllText($archivePath, 'verified archive payload', [System.Text.UTF8Encoding]::new($false))
  $archive = Get-Item -LiteralPath $archivePath
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifestPath = Join-Path $tempRoot 'acceptance_db-20260728T000000Z-test.manifest.json'
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ([ordered]@{
      formatVersion = 1
      createdAtUtc = '2026-07-28T00:00:00Z'
      sourceDatabase = 'acceptance_db'
      archiveFile = $archive.Name
      archiveBytes = $archive.Length
      sha256 = $hash
    } | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false)
  )
  $restoreReportPath = [System.IO.Path]::ChangeExtension($manifestPath, '.restore-report.json')
  [System.IO.File]::WriteAllText(
    $restoreReportPath,
    ([ordered]@{
      status = 'restore-verified'
      attemptedAtUtc = '2026-07-28T00:06:00Z'
      verifiedAtUtc = '2026-07-28T00:20:00Z'
      sourceDatabase = 'acceptance_db'
      backupSha256 = $hash
      cleanupVerified = $true
    } | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false)
  )

  $output = @(
    & (Join-Path $PSScriptRoot '..\Publish-EnterpriseDisasterRecoveryReport.ps1') `
      -ManifestPath $manifestPath `
      -RestoreReportPath $restoreReportPath `
      -IncidentDeclaredAtUtc ([DateTimeOffset]'2026-07-28T00:05:00Z') `
      -RpoObjectiveMinutes 15 `
      -RtoObjectiveMinutes 240
  )
  if ($LASTEXITCODE -notin @(0, $null)) { throw 'Publisher returned a non-zero exit code.' }
  $result = ($output | Out-String).Trim() | ConvertFrom-Json
  Assert-True ([string]$result.status -eq 'database-objectives-met') 'Publisher must calculate objectives-met.'
  Assert-True ([double]$result.rpoMinutes -eq 5) 'Publisher RPO measurement is incorrect.'
  Assert-True ([double]$result.rtoMinutes -eq 15) 'Publisher RTO measurement is incorrect.'
  Assert-True (Test-Path -LiteralPath ([string]$result.reportPath) -PathType Leaf) 'Publisher did not write its report.'

  $report = Get-Content -LiteralPath ([string]$result.reportPath) -Raw -Encoding utf8 | ConvertFrom-Json
  Assert-True (-not [bool]$report.evidence.productionTrafficFailoverVerified) 'Isolated report overclaimed production failover.'
  Assert-True (-not [bool]$report.evidence.offsiteRestoreVerified) 'Isolated report overclaimed offsite restore.'
  Assert-True (-not [bool]$report.evidence.pitrReplayVerified) 'Isolated report overclaimed PITR replay.'
  Assert-True ($report.unverifiedBoundaries -contains 'PRODUCTION_TRAFFIC_FAILOVER_NOT_TESTED') 'Production boundary missing.'

  [System.IO.File]::WriteAllText($archivePath, 'tampered archive payload', [System.Text.UTF8Encoding]::new($false))
  $failedClosed = $false
  try {
    & (Join-Path $PSScriptRoot '..\Publish-EnterpriseDisasterRecoveryReport.ps1') `
      -ManifestPath $manifestPath `
      -RestoreReportPath $restoreReportPath `
      -IncidentDeclaredAtUtc ([DateTimeOffset]'2026-07-28T00:05:00Z') | Out-Null
  }
  catch {
    $failedClosed = $_.Exception.Message -match 'matching archive SHA-256'
  }
  Assert-True $failedClosed 'Publisher must reject a same-path archive whose content no longer matches.'

  Write-Output 'Enterprise disaster recovery publisher tests passed (9 assertions).'
}
finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  $resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $resolvedTemp.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a test directory outside the system temp root.'
  }
  Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
}
