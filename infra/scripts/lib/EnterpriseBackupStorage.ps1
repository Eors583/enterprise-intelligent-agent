function Resolve-EnterpriseBackupStoragePath {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($resolved)
  $trimmed = $resolved.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $trimmedRoot = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed -eq $trimmedRoot) {
    throw 'The backup directory must not be a filesystem root.'
  }

  $cursor = $resolved
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The backup directory and its existing ancestors must not be reparse points or symbolic links.'
      }
    }
    $parent = [System.IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
  }
  return $resolved
}

function Get-EnterpriseBackupStorageMarkerPath {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Directory)
  return Join-Path $Directory '.enterprise-agent-backup-root'
}

function Set-EnterpriseRestrictedPathPermissions {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][bool]$Directory
  )

  $isWindowsPlatform = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
  if ($isWindowsPlatform) {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grants = if ($Directory) {
      @("*$currentSid`:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
    }
    else {
      @("*$currentSid`:F", '*S-1-5-18:F', '*S-1-5-32-544:F')
    }
    & icacls $Path /inheritance:r /grant:r $grants | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw 'Failed to apply the restricted Windows ACL to backup storage.'
    }
    return
  }

  $chmod = Get-Command chmod -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $chmod) {
    throw 'chmod is required to protect backup storage on non-Windows hosts.'
  }
  $mode = if ($Directory) { '700' } else { '600' }
  & $chmod.Source $mode $Path
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to apply the restricted POSIX mode to backup storage.'
  }
}

function Initialize-EnterpriseBackupStorage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$AllowInitialize
  )

  $resolved = Resolve-EnterpriseBackupStoragePath -Path $Path
  if (-not (Test-Path -LiteralPath $resolved)) {
    if (-not $AllowInitialize) {
      throw 'Backup storage is not initialized. Run Initialize-EnterpriseBackupDirectory.ps1 first.'
    }
    [System.IO.Directory]::CreateDirectory($resolved) | Out-Null
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw 'Backup storage must be a directory.'
  }

  $markerPath = Get-EnterpriseBackupStorageMarkerPath -Directory $resolved
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    if (-not $AllowInitialize) {
      throw 'Backup storage marker is missing. Refusing to change permissions on an unclaimed directory.'
    }
    [System.IO.File]::WriteAllText(
      $markerPath,
      "enterprise-agent-backup-root-v1`n",
      [System.Text.UTF8Encoding]::new($false)
    )
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding utf8
  if ($marker.Trim() -ne 'enterprise-agent-backup-root-v1') {
    throw 'Backup storage marker is invalid.'
  }

  Set-EnterpriseRestrictedPathPermissions -Path $resolved -Directory $true
  Set-EnterpriseRestrictedPathPermissions -Path $markerPath -Directory $false
  return $resolved
}

function Open-EnterpriseBackupLock {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Database
  )

  $lockPath = Join-Path $Directory ".enterprise-agent-$Database.backup.lock"
  try {
    $handle = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  }
  catch {
    throw 'Another backup operation already owns the database backup lock.'
  }
  try {
    Set-EnterpriseRestrictedPathPermissions -Path $lockPath -Directory $false
  }
  catch {
    $handle.Dispose()
    throw
  }
  return $handle
}

function Open-EnterpriseRestoreTargetLock {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Container,
    [Parameter(Mandatory = $true)][string]$TargetDatabase
  )

  $identityBytes = [System.Text.Encoding]::UTF8.GetBytes("$Container`n$TargetDatabase")
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $identityHash = ([System.BitConverter]::ToString($sha256.ComputeHash($identityBytes))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
  }
  $lockPath = Join-Path ([System.IO.Path]::GetTempPath()) "enterprise-agent-restore-$identityHash.lock"
  try {
    $handle = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  }
  catch {
    throw 'Another restore operation already owns the target database lock.'
  }
  try {
    Set-EnterpriseRestrictedPathPermissions -Path $lockPath -Directory $false
  }
  catch {
    $handle.Dispose()
    throw
  }
  return $handle
}

function New-EnterpriseBackupBaseName {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Database,
    [DateTime]$UtcNow = [DateTime]::UtcNow
  )

  $normalizedUtc = $UtcNow.ToUniversalTime()
  return '{0}-{1}-{2}' -f $Database, $normalizedUtc.ToString('yyyyMMddTHHmmssZ'), [Guid]::NewGuid().ToString('N')
}

function Write-EnterpriseProtectedJsonAtomically {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value,
    [ValidateRange(2, 100)][int]$Depth = 10
  )

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $directory = Split-Path -Parent $resolved
  $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($resolved) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $replacementBackup = $null
  try {
    [System.IO.File]::WriteAllText(
      $temporary,
      ($Value | ConvertTo-Json -Depth $Depth),
      [System.Text.UTF8Encoding]::new($false)
    )
    Set-EnterpriseRestrictedPathPermissions -Path $temporary -Directory $false
    if (Test-Path -LiteralPath $resolved) {
      $existing = Get-Item -LiteralPath $resolved -Force
      if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing to replace a protected JSON path that is a reparse point or symbolic link.'
      }
      # .NET Framework's three-argument File.Replace requires a concrete
      # backup path. The replace itself remains atomic; the protected previous
      # version is removed immediately afterwards.
      $replacementBackup = $temporary + '.previous'
      [System.IO.File]::Replace($temporary, $resolved, $replacementBackup)
      Remove-Item -LiteralPath $replacementBackup -Force
      $replacementBackup = $null
    }
    else {
      [System.IO.File]::Move($temporary, $resolved)
    }
    Set-EnterpriseRestrictedPathPermissions -Path $resolved -Directory $false
  }
  finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrWhiteSpace($replacementBackup)) {
      Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue
    }
  }
}
