function ConvertTo-EnterpriseWslPath {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = [System.IO.Path]::GetFullPath($Path)
  if ($resolved -notmatch '^(?<drive>[a-zA-Z]):[\\/](?<remainder>.*)$') {
    throw 'WSL PostgreSQL clients require a path on a local Windows drive.'
  }
  $drive = $Matches['drive'].ToLowerInvariant()
  $remainder = $Matches['remainder'].Replace('\', '/')
  return "/mnt/$drive/$remainder"
}

function Test-EnterpriseElfExecutable {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    if ($stream.Length -lt 4) { return $false }
    $header = [byte[]]::new(4)
    if ($stream.Read($header, 0, $header.Length) -ne $header.Length) { return $false }
    return (
      $header[0] -eq 0x7f -and
      $header[1] -eq 0x45 -and
      $header[2] -eq 0x4c -and
      $header[3] -eq 0x46
    )
  }
  finally {
    $stream.Dispose()
  }
}

function Resolve-EnterprisePostgresClient {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$PgBinDirectory,
    [Parameter(Mandatory = $true)][string]$DatabaseHost,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port
  )

  $resolvedDirectory = [System.IO.Path]::GetFullPath($PgBinDirectory)
  if (-not (Test-Path -LiteralPath $resolvedDirectory -PathType Container)) {
    throw "PostgreSQL client directory not found: $resolvedDirectory"
  }
  $directoryItem = Get-Item -LiteralPath $resolvedDirectory -Force
  if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The PostgreSQL client directory must not be a reparse point or symbolic link.'
  }

  $isWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
  $tools = [ordered]@{}
  $formats = @()
  foreach ($tool in @('psql', 'pg_dump', 'pg_restore')) {
    $nativePath = Join-Path $resolvedDirectory $(if ($isWindows) { "$tool.exe" } else { $tool })
    $portablePath = Join-Path $resolvedDirectory $tool
    if (Test-Path -LiteralPath $nativePath -PathType Leaf) {
      $selectedPath = $nativePath
      $format = 'native'
    }
    elseif ($isWindows -and (Test-Path -LiteralPath $portablePath -PathType Leaf) -and
      (Test-EnterpriseElfExecutable -Path $portablePath)) {
      $selectedPath = $portablePath
      $format = 'wsl-elf'
    }
    else {
      throw "Required PostgreSQL client '$tool' was not found in $resolvedDirectory."
    }
    $toolItem = Get-Item -LiteralPath $selectedPath -Force
    if (($toolItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "PostgreSQL client '$tool' must not be a reparse point or symbolic link."
    }
    $tools[$tool] = $toolItem.FullName
    $formats += $format
  }

  $uniqueFormats = @($formats | Select-Object -Unique)
  if ($uniqueFormats.Count -ne 1) {
    throw 'All PostgreSQL clients must use the same native or WSL executable format.'
  }
  $usesWsl = $uniqueFormats[0] -eq 'wsl-elf'
  $wslTools = [ordered]@{}
  $wslLibraryPath = $null
  if ($usesWsl) {
    if ($null -eq (Get-Command wsl.exe -CommandType Application -ErrorAction SilentlyContinue)) {
      throw 'WSL is required to run the selected Linux PostgreSQL clients on Windows.'
    }
    foreach ($tool in $tools.Keys) {
      $wslTools[$tool] = ConvertTo-EnterpriseWslPath -Path $tools[$tool]
    }

    $versionDirectory = Split-Path -Parent $resolvedDirectory
    $postgresLibraryDirectory = Join-Path $versionDirectory 'lib'
    $postgresqlDirectory = Split-Path -Parent $versionDirectory
    $usrLibraryDirectory = Split-Path -Parent $postgresqlDirectory
    $libraryDirectories = @()
    if (Test-Path -LiteralPath $postgresLibraryDirectory -PathType Container) {
      $libraryDirectories += ConvertTo-EnterpriseWslPath -Path $postgresLibraryDirectory
    }
    if (Test-Path -LiteralPath $usrLibraryDirectory -PathType Container) {
      $libraryDirectories += @(
        Get-ChildItem -LiteralPath $usrLibraryDirectory -Directory -Filter '*-linux-gnu' |
          ForEach-Object { ConvertTo-EnterpriseWslPath -Path $_.FullName }
      )
    }
    $wslLibraryPath = ($libraryDirectories | Select-Object -Unique) -join ':'
  }

  $normalizedHost = $DatabaseHost.Trim()
  if ([string]::IsNullOrWhiteSpace($normalizedHost)) {
    throw 'DatabaseHost must not be empty.'
  }
  return [pscustomobject]@{
    Mode = 'DirectClient'
    DatabaseHost = $normalizedHost
    Port = $Port
    PgBinDirectory = $resolvedDirectory
    Tools = $tools
    UsesWsl = $usesWsl
    WslTools = $wslTools
    WslLibraryPath = $wslLibraryPath
    LockIdentity = "postgresql-client|$($normalizedHost.ToLowerInvariant())|$Port"
  }
}

function ConvertTo-EnterprisePostgresSystemIdentifier {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  $normalized = $Value.Trim()
  if ($normalized -notmatch '^[1-9][0-9]*$') {
    throw 'PostgreSQL cluster system identifiers must be canonical positive decimal values.'
  }
  return $normalized
}

function Assert-EnterprisePostgresClusterSeparation {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$SourceSystemIdentifier,
    [Parameter(Mandatory = $true)][string]$RestoreSystemIdentifier,
    [switch]$AllowSharedCluster
  )

  $source = ConvertTo-EnterprisePostgresSystemIdentifier -Value $SourceSystemIdentifier
  $restore = ConvertTo-EnterprisePostgresSystemIdentifier -Value $RestoreSystemIdentifier
  if (-not $AllowSharedCluster -and $source -eq $restore) {
    throw 'Restore rehearsal must use a separate PostgreSQL cluster unless -AllowSharedCluster is explicitly supplied for an already-isolated acceptance cluster.'
  }
}

function New-EnterprisePostgresConnectionArguments {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Client,
    [Parameter(Mandatory = $true)][string]$DatabaseUser,
    [Parameter(Mandatory = $true)][string]$Database
  )

  return @(
    "--host=$($Client.DatabaseHost)",
    "--port=$($Client.Port)",
    "--username=$DatabaseUser",
    "--dbname=$Database",
    '--no-password'
  )
}

function ConvertTo-EnterprisePostgresClientPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Client,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $resolved = [System.IO.Path]::GetFullPath($Path)
  if ($Client.UsesWsl) {
    return ConvertTo-EnterpriseWslPath -Path $resolved
  }
  return $resolved
}

function Assert-EnterprisePostgresArgumentsContainNoCredentials {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  foreach ($argument in $Arguments) {
    if (
      $argument -match '(?i)^--(?:password|passfile)=' -or
      $argument -match '(?i)^postgres(?:ql)?://[^/\s:@]+:[^/\s@]+@'
    ) {
      throw 'PostgreSQL credentials must be supplied through the process environment.'
    }
  }
}

function Get-EnterpriseWslEnvironmentForwarding {
  [CmdletBinding()]
  param()

  $forwarding = @()
  foreach ($entry in @(
      @{ Name = 'PGPASSWORD'; Suffix = '' },
      @{ Name = 'PGPASSFILE'; Suffix = '/p' },
      @{ Name = 'PGSERVICE'; Suffix = '' },
      @{ Name = 'PGSERVICEFILE'; Suffix = '/p' },
      @{ Name = 'PGSSLMODE'; Suffix = '' },
      @{ Name = 'PGREQUIRESSL'; Suffix = '' },
      @{ Name = 'PGSSLNEGOTIATION'; Suffix = '' },
      @{ Name = 'PGSSLCOMPRESSION'; Suffix = '' },
      @{ Name = 'PGSSLCERT'; Suffix = '/p' },
      @{ Name = 'PGSSLKEY'; Suffix = '/p' },
      @{ Name = 'PGSSLCERTMODE'; Suffix = '' },
      @{ Name = 'PGSSLROOTCERT'; Suffix = '/p' },
      @{ Name = 'PGSSLCRL'; Suffix = '/p' },
      @{ Name = 'PGSSLCRLDIR'; Suffix = '/p' },
      @{ Name = 'PGSSLSNI'; Suffix = '' },
      @{ Name = 'PGSSLMINPROTOCOLVERSION'; Suffix = '' },
      @{ Name = 'PGSSLMAXPROTOCOLVERSION'; Suffix = '' },
      @{ Name = 'PGCHANNELBINDING'; Suffix = '' },
      @{ Name = 'PGGSSENCMODE'; Suffix = '' },
      @{ Name = 'PGREQUIREAUTH'; Suffix = '' },
      @{ Name = 'PGREQUIREPEER'; Suffix = '' },
      @{ Name = 'PGTARGETSESSIONATTRS'; Suffix = '' },
      @{ Name = 'PGLOADBALANCEHOSTS'; Suffix = '' },
      @{ Name = 'PGKRBSRVNAME'; Suffix = '' },
      @{ Name = 'PGGSSLIB'; Suffix = '' }
    )) {
    $value = [System.Environment]::GetEnvironmentVariable($entry.Name, 'Process')
    if (-not [string]::IsNullOrEmpty($value)) {
      $forwarding += "$($entry.Name)$($entry.Suffix)"
    }
  }
  return $forwarding
}

function Merge-EnterpriseWslEnvironmentForwarding {
  [CmdletBinding()]
  param(
    [AllowEmptyString()][string]$Existing,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Required
  )

  $managedNames = @(
    $Required |
      ForEach-Object { ($_ -split '/', 2)[0] } |
      Select-Object -Unique
  )
  $preserved = @(
    $Existing -split ':' |
      Where-Object {
        if ([string]::IsNullOrWhiteSpace($_)) { return $false }
        $name = ($_ -split '/', 2)[0]
        return $managedNames -notcontains $name
      }
  )
  return (@($preserved + $Required | Select-Object -Unique) -join ':')
}

function ConvertTo-EnterpriseNativeProcessArgument {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Argument)

  if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
    return $Argument
  }

  # Start-Process joins ArgumentList into a Windows command line. Apply the
  # CommandLineToArgvW escaping rules explicitly so paths and values containing
  # spaces, quotes, or trailing backslashes remain one argument.
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append('\' * (($backslashes * 2) + 1))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append('\' * $backslashes)
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append('\' * ($backslashes * 2))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-EnterpriseProcessWithUtf8StandardInput {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$FilePath,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$StandardInput
  )

  $temporaryRoot = Join-Path (
    [System.IO.Path]::GetTempPath()
  ) ('enterprise-native-stdin-' + [Guid]::NewGuid().ToString('N'))
  $inputPath = Join-Path $temporaryRoot 'stdin.utf8'
  $outputPath = Join-Path $temporaryRoot 'stdout.utf8'
  $errorPath = Join-Path $temporaryRoot 'stderr.utf8'
  [System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
  try {
    # Windows PowerShell 5.1 adds an UTF-8 BOM even when $OutputEncoding uses a
    # no-BOM encoder. Redirect a private no-BOM file as stdin so SQL remains out
    # of process arguments while preserving Unicode exactly.
    [System.IO.File]::WriteAllText(
      $inputPath,
      $StandardInput,
      [System.Text.UTF8Encoding]::new($false)
    )
    $argumentLine = @(
      $Arguments |
        ForEach-Object {
          ConvertTo-EnterpriseNativeProcessArgument -Argument $_
        }
    ) -join ' '
    $startParameters = @{
      FilePath = $FilePath
      NoNewWindow = $true
      PassThru = $true
      RedirectStandardInput = $inputPath
      RedirectStandardOutput = $outputPath
      RedirectStandardError = $errorPath
      Wait = $true
    }
    if ($argumentLine.Length -gt 0) {
      $startParameters.ArgumentList = $argumentLine
    }
    $process = Start-Process @startParameters
    $exitCode = $process.ExitCode
    $result = [System.IO.File]::ReadAllText(
      $outputPath,
      [System.Text.UTF8Encoding]::new($false, $true)
    )
  }
  finally {
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $resolvedSystemTemp = [System.IO.Path]::GetFullPath(
      [System.IO.Path]::GetTempPath()
    )
    if (
      $resolvedTemporaryRoot.StartsWith(
        $resolvedSystemTemp,
        [System.StringComparison]::OrdinalIgnoreCase
      ) -and
      [System.IO.Path]::GetFileName($resolvedTemporaryRoot).StartsWith(
        'enterprise-native-stdin-',
        [System.StringComparison]::Ordinal
      )
    ) {
      [System.IO.Directory]::Delete($resolvedTemporaryRoot, $true)
    }
  }
  return [pscustomobject]@{
    Output = @($result)
    ExitCode = $exitCode
  }
}

function Invoke-EnterprisePostgresClient {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Client,
    [Parameter(Mandatory = $true)]
    [ValidateSet('psql', 'pg_dump', 'pg_restore')]
    [string]$Tool,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments,
    [AllowEmptyString()][string]$StandardInput
  )

  Assert-EnterprisePostgresArgumentsContainNoCredentials -Arguments $Arguments
  $hasStandardInput = $PSBoundParameters.ContainsKey('StandardInput')
  if (-not $Client.UsesWsl) {
    if ($hasStandardInput) {
      $invocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
        -FilePath $Client.Tools[$Tool] `
        -Arguments $Arguments `
        -StandardInput $StandardInput
      $result = $invocation.Output
      $exitCode = $invocation.ExitCode
    }
    else {
      $result = & $Client.Tools[$Tool] @Arguments
      $exitCode = $LASTEXITCODE
    }
  }
  else {
    $previousWslEnv = [System.Environment]::GetEnvironmentVariable('WSLENV', 'Process')
    try {
      $forwarding = @(Get-EnterpriseWslEnvironmentForwarding)
      $combined = Merge-EnterpriseWslEnvironmentForwarding `
        -Existing $previousWslEnv `
        -Required $forwarding
      [System.Environment]::SetEnvironmentVariable('WSLENV', $combined, 'Process')

      $wslArguments = @('--exec')
      if (-not [string]::IsNullOrWhiteSpace([string]$Client.WslLibraryPath)) {
        $wslArguments += @('env', "LD_LIBRARY_PATH=$($Client.WslLibraryPath)")
      }
      $wslArguments += [string]$Client.WslTools[$Tool]
      $wslArguments += $Arguments
      if ($hasStandardInput) {
        $invocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
          -FilePath 'wsl.exe' `
          -Arguments $wslArguments `
          -StandardInput $StandardInput
        $result = $invocation.Output
        $exitCode = $invocation.ExitCode
      }
      else {
        $result = & wsl.exe @wslArguments
        $exitCode = $LASTEXITCODE
      }
    }
    finally {
      [System.Environment]::SetEnvironmentVariable('WSLENV', $previousWslEnv, 'Process')
    }
  }

  if ($exitCode -ne 0) {
    throw "PostgreSQL client '$Tool' failed with exit code $exitCode."
  }
  return $result
}
