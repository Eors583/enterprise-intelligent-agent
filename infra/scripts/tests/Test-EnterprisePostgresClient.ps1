$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterprisePostgresClient.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

function Get-ParameterSet {
  param($Command, [string]$Name)
  return @($Command.ParameterSets | Where-Object Name -eq $Name)[0]
}

$tests = 0
$temporaryRoot = Join-Path (
  [System.IO.Path]::GetTempPath()
) ('enterprise-postgres-client-test-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
try {
  $isWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
  foreach ($tool in @('psql', 'pg_dump', 'pg_restore')) {
    $name = if ($isWindows) { "$tool.exe" } else { $tool }
    [System.IO.File]::WriteAllBytes((Join-Path $temporaryRoot $name), [byte[]](0x00))
  }
  $client = Resolve-EnterprisePostgresClient `
    -PgBinDirectory $temporaryRoot `
    -DatabaseHost 'db.internal.example' `
    -Port 55435
  Assert-True ($client.Mode -eq 'DirectClient') 'The direct client descriptor must identify its transport.'
  Assert-True (-not $client.UsesWsl) 'Native client files must not be routed through WSL.'
  Assert-True ($client.LockIdentity -eq 'postgresql-client|db.internal.example|55435') 'The direct restore lock identity must bind host and port.'
  $tests += 3

  $connectionArguments = @(
    New-EnterprisePostgresConnectionArguments `
      -Client $client `
      -DatabaseUser 'backup_operator' `
      -Database 'enterprise_agent'
  )
  Assert-True ($connectionArguments -contains '--host=db.internal.example') 'Direct clients must receive an explicit host.'
  Assert-True ($connectionArguments -contains '--port=55435') 'Direct clients must receive an explicit port.'
  Assert-True ($connectionArguments -contains '--username=backup_operator') 'Direct clients must receive the validated database role.'
  Assert-True ($connectionArguments -contains '--dbname=enterprise_agent') 'Direct clients must receive the validated database name.'
  Assert-True ($connectionArguments -contains '--no-password') 'Direct clients must fail closed instead of prompting for credentials.'
  Assert-True (($connectionArguments -join "`n") -notmatch '(?i)password=') 'Connection arguments must not contain a password value.'
  $tests += 6

  $stdinProbePath = Join-Path $temporaryRoot 'stdin-probe.ps1'
  [System.IO.File]::WriteAllText(
    $stdinProbePath,
    @'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputText = [Console]::In.ReadToEnd()
$normalized = $inputText.TrimEnd([char[]](13, 10))
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($normalized))
'@,
    [System.Text.UTF8Encoding]::new($false)
  )
  $sqlProbe = @'
SELECT lower(replace(definition, '"', ''));
SELECT '单引号 '' 内容', E'backslash\\n', '"quoted"';
-- 多行 Unicode 🧪
'@
  $normalizedSqlProbe = $sqlProbe.TrimEnd([char[]](13, 10))
  $expectedProbe = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($normalizedSqlProbe)
  )
  $powershellExecutable = (Get-Process -Id $PID).Path
  $probeArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-File',
    $stdinProbePath
  )
  $nativeInvocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
    -FilePath $powershellExecutable `
    -Arguments $probeArguments `
    -StandardInput $sqlProbe
  Assert-True ($nativeInvocation.ExitCode -eq 0) 'The native UTF-8 stdin probe must exit successfully.'
  Assert-True (
    (($nativeInvocation.Output | Out-String).Trim()) -eq $expectedProbe
  ) 'Native stdin must preserve multiline SQL with single quotes, double quotes and Unicode.'
  $nativeProbeClient = [pscustomobject]@{
    UsesWsl = $false
    Tools = @{ psql = $powershellExecutable }
  }
  $nativeClientOutput = Invoke-EnterprisePostgresClient `
    -Client $nativeProbeClient `
    -Tool psql `
    -Arguments $probeArguments `
    -StandardInput $sqlProbe
  Assert-True (
    (($nativeClientOutput | Out-String).Trim()) -eq $expectedProbe
  ) 'The native PostgreSQL-client wrapper must carry SQL only through UTF-8 stdin.'
  $tests += 3

  $argumentProbePath = Join-Path $temporaryRoot 'argument-probe.ps1'
  [System.IO.File]::WriteAllText(
    $argumentProbePath,
    @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Values)
$Values | ConvertTo-Json -Compress
'@,
    [System.Text.UTF8Encoding]::new($false)
  )
  $argumentProbeValues = @(
    'plain',
    'value with space',
    'quote"value',
    'trailing\'
  )
  $argumentInvocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
    -FilePath $powershellExecutable `
    -Arguments (
      @(
        '-NoProfile',
        '-NonInteractive',
        '-File',
        $argumentProbePath
      ) + $argumentProbeValues
    ) `
    -StandardInput ''
  $argumentRoundTrip = @(
    (($argumentInvocation.Output | Out-String).Trim() | ConvertFrom-Json)
  )
  Assert-True ($argumentInvocation.ExitCode -eq 0) 'The native argument probe must exit successfully.'
  Assert-True (
    ($argumentRoundTrip -join "`0") -eq ($argumentProbeValues -join "`0")
  ) 'Native process arguments must preserve spaces, quotes, and trailing backslashes.'
  $tests += 2

  if ($isWindows -and $null -ne (Get-Command wsl.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    & wsl.exe --exec /usr/bin/test -x /usr/bin/base64
    if ($LASTEXITCODE -eq 0) {
      $wslProbeClient = [pscustomobject]@{
        UsesWsl = $true
        WslLibraryPath = $null
        WslTools = @{ psql = '/usr/bin/base64' }
      }
      $wslClientOutput = Invoke-EnterprisePostgresClient `
        -Client $wslProbeClient `
        -Tool psql `
        -Arguments @('-w', '0') `
        -StandardInput $sqlProbe
      $wslRoundTrip = [System.Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String((($wslClientOutput | Out-String).Trim()))
      ).TrimEnd([char[]](13, 10))
      Assert-True (
        $wslRoundTrip -eq $normalizedSqlProbe
      ) 'WSL stdin must preserve multiline SQL with single quotes, double quotes and Unicode.'
      $tests++
    }
  }

  $credentialArgumentRejected = $false
  try {
    Assert-EnterprisePostgresArgumentsContainNoCredentials -Arguments @(
      'postgresql://backup_operator:secret@db.internal.example/enterprise_agent'
    )
  }
  catch {
    $credentialArgumentRejected = $true
  }
  Assert-True $credentialArgumentRejected 'A credential-bearing PostgreSQL URI must be rejected before process launch.'
  $tests++

  $securityEnvironment = [ordered]@{
    PGPASSWORD = 'offline-test-secret-must-not-be-rendered'
    PGSSLMODE = 'verify-full'
    PGCHANNELBINDING = 'require'
    PGGSSENCMODE = 'require'
    PGREQUIREAUTH = 'scram-sha-256'
    PGTARGETSESSIONATTRS = 'read-write'
    PGSSLKEY = (Join-Path $temporaryRoot 'client.key')
  }
  $previousSecurityEnvironment = @{}
  try {
    foreach ($name in $securityEnvironment.Keys) {
      $previousSecurityEnvironment[$name] = [System.Environment]::GetEnvironmentVariable(
        $name,
        'Process'
      )
      [System.Environment]::SetEnvironmentVariable(
        $name,
        $securityEnvironment[$name],
        'Process'
      )
    }
    $forwarding = @(Get-EnterpriseWslEnvironmentForwarding)
    foreach ($name in @(
        'PGPASSWORD',
        'PGSSLMODE',
        'PGCHANNELBINDING',
        'PGGSSENCMODE',
        'PGREQUIREAUTH',
        'PGTARGETSESSIONATTRS'
      )) {
      Assert-True ($forwarding -contains $name) "WSL must forward the $name security setting by name."
      $tests++
    }
    Assert-True ($forwarding -contains 'PGSSLKEY/p') 'WSL must translate the TLS private-key path.'
    Assert-True (($forwarding -join ':') -notmatch 'offline-test-secret') 'WSL forwarding metadata must never include credential values.'
    $tests += 2

    $mergedForwarding = Merge-EnterpriseWslEnvironmentForwarding `
      -Existing 'PGSSLMODE/p:PGPASSWORD/p:UNRELATED_SETTING/u' `
      -Required $forwarding
    $mergedEntries = @($mergedForwarding -split ':')
    Assert-True ($mergedEntries -contains 'PGSSLMODE') 'A hostile or stale WSLENV suffix must be replaced with the canonical TLS forwarding rule.'
    Assert-True ($mergedEntries -notcontains 'PGSSLMODE/p') 'Duplicate TLS forwarding rules must not retain path conversion.'
    Assert-True ($mergedEntries -contains 'PGPASSWORD') 'Credential forwarding must use its canonical non-path rule.'
    Assert-True ($mergedEntries -notcontains 'PGPASSWORD/p') 'Duplicate credential forwarding rules must not retain path conversion.'
    Assert-True ($mergedEntries -contains 'UNRELATED_SETTING/u') 'Unrelated caller WSLENV rules must be preserved.'
    Assert-True (
      (Merge-EnterpriseWslEnvironmentForwarding -Existing 'UNRELATED_SETTING/u' -Required @()) -eq
        'UNRELATED_SETTING/u'
    ) 'An empty managed forwarding set must preserve unrelated WSLENV rules.'
    $tests += 6
  }
  finally {
    foreach ($name in $securityEnvironment.Keys) {
      [System.Environment]::SetEnvironmentVariable(
        $name,
        $previousSecurityEnvironment[$name],
        'Process'
      )
    }
  }

  Assert-True (
    (ConvertTo-EnterprisePostgresSystemIdentifier -Value '7259138357442231099') -eq
      '7259138357442231099'
  ) 'Canonical PostgreSQL cluster identifiers must be preserved exactly.'
  $tests++
  foreach ($invalidIdentifier in @('', '0', '01', '-1', '1.0', 'system-1')) {
    $identifierRejected = $false
    try {
      ConvertTo-EnterprisePostgresSystemIdentifier -Value $invalidIdentifier | Out-Null
    }
    catch {
      $identifierRejected = $true
    }
    Assert-True $identifierRejected "Invalid cluster identifier '$invalidIdentifier' must be rejected."
    $tests++
  }

  $sameClusterRejected = $false
  try {
    Assert-EnterprisePostgresClusterSeparation `
      -SourceSystemIdentifier '7259138357442231099' `
      -RestoreSystemIdentifier '7259138357442231099'
  }
  catch {
    $sameClusterRejected = $true
  }
  Assert-True $sameClusterRejected 'Host aliases must not bypass same-cluster restore rejection.'
  Assert-EnterprisePostgresClusterSeparation `
    -SourceSystemIdentifier '7259138357442231099' `
    -RestoreSystemIdentifier '7259138357442231100'
  Assert-EnterprisePostgresClusterSeparation `
    -SourceSystemIdentifier '7259138357442231099' `
    -RestoreSystemIdentifier '7259138357442231099' `
    -AllowSharedCluster
  $tests += 3

  if ($isWindows) {
    $archivePath = Join-Path $temporaryRoot 'archive.dump'
    $wslPath = ConvertTo-EnterpriseWslPath -Path $archivePath
    Assert-True ($wslPath -match '^/mnt/[a-z]/') 'Windows project paths must be converted to WSL mount paths without a shell.'
    $wslClientPath = ConvertTo-EnterprisePostgresClientPath `
      -Client ([pscustomobject]@{ UsesWsl = $true }) `
      -Path $archivePath
    Assert-True ($wslClientPath -eq $wslPath) 'WSL pg_dump and pg_restore archive paths must use /mnt paths.'
    $tests += 2
  }
}
finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$backupPath = Join-Path $PSScriptRoot '..\Backup-EnterpriseDatabase.ps1'
$restorePath = Join-Path $PSScriptRoot '..\Test-EnterpriseDatabaseRestore.ps1'
$coreAlertsPath = Join-Path $PSScriptRoot '..\Test-EnterpriseCoreAlerts.ps1'
$backupCommand = Get-Command $backupPath
$restoreCommand = Get-Command $restorePath
$coreAlertsCommand = Get-Command $coreAlertsPath
foreach ($command in @($backupCommand, $restoreCommand, $coreAlertsCommand)) {
  $containerSet = Get-ParameterSet -Command $command -Name 'Container'
  $directSet = Get-ParameterSet -Command $command -Name 'DirectClient'
  Assert-True ($null -ne $containerSet) "$($command.Name) must preserve the Docker parameter set."
  Assert-True ($null -ne $directSet) "$($command.Name) must expose the direct client parameter set."
  Assert-True ($containerSet.Parameters.Name -contains 'Container') "$($command.Name) Docker mode must require Container."
  Assert-True ($containerSet.Parameters.Name -notcontains 'PgBinDirectory') "$($command.Name) Docker mode must reject direct client parameters."
  Assert-True ($directSet.Parameters.Name -contains 'PgBinDirectory') "$($command.Name) direct mode must require PgBinDirectory."
  Assert-True ($directSet.Parameters.Name -notcontains 'Container') "$($command.Name) direct mode must reject Container."
  Assert-True (
    @(
      (Get-ParameterSet -Command $command -Name 'Container').Parameters |
        Where-Object { $_.Name -eq 'Container' -and $_.IsMandatory }
    ).Count -eq 1
  ) "$($command.Name) Container must remain mandatory in Docker mode."
  Assert-True (
    @(
      (Get-ParameterSet -Command $command -Name 'DirectClient').Parameters |
        Where-Object { $_.Name -eq 'PgBinDirectory' -and $_.IsMandatory }
    ).Count -eq 1
  ) "$($command.Name) PgBinDirectory must select and bind direct mode."
  $tests += 8
}

$backupSource = Get-Content -LiteralPath $backupPath -Raw -Encoding utf8
$restoreSource = Get-Content -LiteralPath $restorePath -Raw -Encoding utf8
$coreAlertsSource = Get-Content -LiteralPath $coreAlertsPath -Raw -Encoding utf8
Assert-True ($backupSource -match "DefaultParameterSetName = 'Container'") 'Backup must default to the Docker safety boundary.'
Assert-True ($restoreSource -match "DefaultParameterSetName = 'Container'") 'Restore must default to the Docker safety boundary.'
Assert-True ($backupSource -match 'sourceTransport = \$transportMode') 'Backup manifests must record their transport without credentials.'
Assert-True ($restoreSource -match 'enterprise_agent_vector_acceptance') 'Restore must preserve the protected vector acceptance database boundary.'
Assert-True ($restoreSource -match '\$createdTargetOid') 'Restore must preserve OID-bound cleanup.'
Assert-True ($restoreSource -match '\$restoreIdentity') 'Restore must preserve GUID comment ownership cleanup.'
Assert-True ($backupSource -match 'sourceClusterSystemIdentifier = \$sourceClusterSystemIdentifier') 'Backup manifests must persist PostgreSQL cluster identity.'
Assert-True ($backupSource -match 'SELECT system_identifier::text FROM pg_control_system\(\);') 'Backup must read PostgreSQL cluster identity from the server.'
Assert-True ($restoreSource -match 'Direct-client backup manifests must contain a valid PostgreSQL cluster system identifier') 'Legacy direct manifests without cluster identity must fail closed.'
Assert-True ($restoreSource -match 'Assert-EnterprisePostgresClusterSeparation') 'Direct restore must compare durable PostgreSQL cluster identities.'
Assert-True ($restoreSource -match 'postgresql-cluster\|\$restoreClusterSystemIdentifier') 'Direct restore locks must bind the durable cluster identity.'
Assert-True (-not $restoreSource.Contains('sourceHost.Equals')) 'Host strings must not substitute for durable PostgreSQL cluster identity.'
Assert-True ($restoreSource -match 'Backup archive SHA-256 does not match the manifest') 'Restore must preserve its archive hash gate.'
Assert-True ($backupSource -match 'ConvertTo-EnterprisePostgresClientPath') 'Backup must convert its direct-client archive output path.'
Assert-True ($restoreSource -match 'ConvertTo-EnterprisePostgresClientPath') 'Restore must convert its direct-client archive input path.'
Assert-True ($backupSource -notmatch '(?i)--password=') 'Backup source must not put a password on a command line.'
Assert-True ($restoreSource -notmatch '(?i)--password=') 'Restore source must not put a password on a command line.'
foreach ($source in @($backupSource, $restoreSource)) {
  Assert-True ($source -notmatch '--command=\$Sql') 'SQL must never be serialized into a psql process argument.'
  Assert-True ($source -match "'--file=-'") 'psql must consume SQL from its standard-input file stream.'
  Assert-True ($source -match '-StandardInput \$Sql') 'The complete SQL text must be supplied through the UTF-8 stdin helper.'
  $tests += 3
}
Assert-True (
  $backupSource -match "'exec',\s*'-i'"
) 'Docker backup metadata queries must keep stdin attached with docker exec -i.'
Assert-True (
  $restoreSource -match '@\(''exec'', ''-i'', \$Container, ''psql''\)'
) 'Docker restore queries must keep stdin attached with docker exec -i.'
$tests += 19

Assert-True ($coreAlertsSource -match "DefaultParameterSetName = 'Container'") 'Core alerts must default to the Docker safety boundary.'
Assert-True ($coreAlertsSource -match 'Resolve-EnterprisePostgresClient') 'Core alerts direct mode must resolve the selected PostgreSQL clients.'
Assert-True ($coreAlertsSource -match 'Invoke-EnterprisePostgresClient') 'Core alerts direct mode must use the shared client wrapper.'
Assert-True ($coreAlertsSource -notmatch '--command=\$Sql') 'Core alert SQL must never be serialized into a psql process argument.'
Assert-True ($coreAlertsSource -match "'--file=-'") 'Core alerts psql must consume SQL from standard input.'
Assert-True ($coreAlertsSource -match '-StandardInput \$Sql') 'Core alert SQL must use the UTF-8 stdin helper.'
Assert-True ($coreAlertsSource -match "'exec',\s*'-i'") 'Docker core alerts must keep stdin attached with docker exec -i.'
Assert-True ($coreAlertsSource -notmatch '(?i)--password=') 'Core alerts must not put a password on a command line.'
Assert-True ($coreAlertsSource -match 'transport = \$transportMode') 'Core alert output must identify its database transport.'
$tests += 9

[ordered]@{ status = 'passed'; tests = $tests } | ConvertTo-Json
