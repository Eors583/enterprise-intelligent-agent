$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseBackupStorage.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$tests = 0
$rootRejected = $false
try { $null = Resolve-EnterpriseBackupStoragePath -Path ([System.IO.Path]::GetPathRoot($PSScriptRoot)) }
catch { $rootRejected = $true }
Assert-True $rootRejected 'A filesystem root must be rejected.'
$tests++

$first = New-EnterpriseBackupBaseName -Database 'acceptance_db' -UtcNow ([DateTime]'2026-07-22T00:00:00Z')
$second = New-EnterpriseBackupBaseName -Database 'acceptance_db' -UtcNow ([DateTime]'2026-07-22T00:00:00Z')
Assert-True ($first -ne $second) 'Backup names created in the same second must remain unique.'
Assert-True ($first -match '^acceptance_db-20260722T000000Z-[0-9a-f]{32}$') 'Backup name format must be stable and unique.'
$tests += 2

$unclaimed = Join-Path ([System.IO.Path]::GetTempPath()) ('enterprise-agent-storage-test-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($unclaimed) | Out-Null
try {
  $unclaimedRejected = $false
  try { $null = Initialize-EnterpriseBackupStorage -Path $unclaimed }
  catch { $unclaimedRejected = $true }
  Assert-True $unclaimedRejected 'An existing unclaimed directory must be rejected without explicit initialization.'
  $tests++
}
finally {
  Remove-Item -LiteralPath $unclaimed -Force -ErrorAction SilentlyContinue
}

$claimed = Join-Path ([System.IO.Path]::GetTempPath()) ('enterprise-agent-storage-test-' + [Guid]::NewGuid().ToString('N'))
$lock = $null
$restoreLock = $null
$restoreLockPath = $null
try {
  $resolvedClaimed = Initialize-EnterpriseBackupStorage -Path $claimed -AllowInitialize
  Assert-True (Test-Path -LiteralPath (Get-EnterpriseBackupStorageMarkerPath -Directory $resolvedClaimed) -PathType Leaf) 'Explicit initialization must create the ownership marker.'
  $tests++

  $lock = Open-EnterpriseBackupLock -Directory $resolvedClaimed -Database 'acceptance_db'
  $secondLockRejected = $false
  try { $null = Open-EnterpriseBackupLock -Directory $resolvedClaimed -Database 'acceptance_db' }
  catch { $secondLockRejected = $true }
  Assert-True $secondLockRejected 'A concurrent backup must be rejected by the exclusive lock.'
  $tests++

  $restoreLock = Open-EnterpriseRestoreTargetLock `
    -Container ('acceptance-container-' + [Guid]::NewGuid().ToString('N')) `
    -TargetDatabase 'acceptance_restore_rehearsal'
  $restoreLockPath = $restoreLock.Name
  $secondRestoreLockRejected = $false
  try {
    $null = [System.IO.File]::Open(
      $restoreLockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  }
  catch { $secondRestoreLockRejected = $true }
  Assert-True $secondRestoreLockRejected 'A concurrent restore target must be rejected by its cross-process lock.'
  $tests++

  $jsonPath = Join-Path $resolvedClaimed 'atomic.json'
  Write-EnterpriseProtectedJsonAtomically -Path $jsonPath -Value ([ordered]@{ version = 1 })
  Write-EnterpriseProtectedJsonAtomically -Path $jsonPath -Value ([ordered]@{ version = 2 })
  $json = Get-Content -LiteralPath $jsonPath -Raw -Encoding utf8 | ConvertFrom-Json
  Assert-True ([int]$json.version -eq 2) 'Atomic protected JSON replacement must publish the complete new value.'
  $tests++
}
finally {
  if ($null -ne $lock) { $lock.Dispose() }
  if ($null -ne $restoreLock) { $restoreLock.Dispose() }
  if (-not [string]::IsNullOrWhiteSpace($restoreLockPath)) {
    Remove-Item -LiteralPath $restoreLockPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $claimed -PathType Container) {
    Get-ChildItem -LiteralPath $claimed -File -Force | Remove-Item -Force
    Remove-Item -LiteralPath $claimed -Force
  }
}

[ordered]@{ status = 'passed'; tests = $tests } | ConvertTo-Json
