[CmdletBinding(DefaultParameterSetName = 'Container')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Container')]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$Container,

  [Parameter(Mandatory = $true, ParameterSetName = 'DirectClient')]
  [ValidateNotNullOrEmpty()]
  [string]$PgBinDirectory,

  [Parameter(ParameterSetName = 'DirectClient')]
  [Alias('Host')]
  [ValidateNotNullOrEmpty()]
  [string]$DatabaseHost = '127.0.0.1',

  [Parameter(ParameterSetName = 'DirectClient')]
  [ValidateRange(1, 65535)]
  [int]$Port = 5432,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$Database,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$DatabaseUser,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
  [string]$TenantId,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$BackupManifestPath,

  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterprisePostgresClient.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseDataGovernanceDryRunSql.ps1')

$protectedDatabases = @(
  'enterprise_agent_acceptance',
  'enterprise_agent_vector_acceptance'
)
if ($protectedDatabases -contains $Database.ToLowerInvariant()) {
  throw 'The protected acceptance databases must never be used for governance rehearsal.'
}
if ($Database -notmatch '^enterprise_agent_(?:governance|repair|restore|rehearsal)_[a-zA-Z0-9_]+$') {
  throw 'Governance dry-run requires an explicitly named isolated restore/rehearsal database.'
}

$resolvedManifestPath = [System.IO.Path]::GetFullPath($BackupManifestPath)
if (-not (Test-Path -LiteralPath $resolvedManifestPath -PathType Leaf)) {
  throw "Backup manifest not found: $resolvedManifestPath"
}
$manifestFile = Get-Item -LiteralPath $resolvedManifestPath -Force
if (($manifestFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Backup manifest must not be a reparse point or symbolic link.'
}
$manifest = Get-Content -Raw -Encoding utf8 -LiteralPath $resolvedManifestPath | ConvertFrom-Json
if (
  $null -eq $manifest.PSObject.Properties['sha256'] -or
  [string]$manifest.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
  $null -eq $manifest.PSObject.Properties['archiveFile'] -or
  [string]::IsNullOrWhiteSpace([string]$manifest.archiveFile) -or
  $null -eq $manifest.PSObject.Properties['sourceDatabase'] -or
  [string]::IsNullOrWhiteSpace([string]$manifest.sourceDatabase)
) {
  throw 'Backup manifest is missing the source database, archive file, or SHA-256 evidence.'
}
if ([System.IO.Path]::GetFileName([string]$manifest.archiveFile) -ne [string]$manifest.archiveFile) {
  throw 'Backup manifest archiveFile must be a file name in the manifest directory.'
}
if ($protectedDatabases -contains ([string]$manifest.sourceDatabase).ToLowerInvariant()) {
  throw 'A protected acceptance database must not be used as the governance rehearsal source.'
}
if ([string]$manifest.sourceDatabase -eq $Database) {
  throw 'Governance rehearsal must run against a restored database, never the backup source.'
}

$archivePath = Join-Path (Split-Path -Parent $resolvedManifestPath) ([string]$manifest.archiveFile)
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  throw "Backup archive referenced by the manifest was not found: $archivePath"
}
$archiveFile = Get-Item -LiteralPath $archivePath -Force
if (($archiveFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Backup archive must not be a reparse point or symbolic link.'
}
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne ([string]$manifest.sha256).ToLowerInvariant()) {
  throw 'Backup archive SHA-256 does not match the manifest.'
}

$directClient = if ($PSCmdlet.ParameterSetName -eq 'DirectClient') {
  Resolve-EnterprisePostgresClient `
    -PgBinDirectory $PgBinDirectory `
    -DatabaseHost $DatabaseHost `
    -Port $Port
}
else {
  $null
}
$sql = Get-EnterpriseDataGovernanceDryRunSql
$arguments = @(
  "--username=$DatabaseUser",
  "--dbname=$Database",
  '--no-psqlrc',
  '--quiet',
  '--tuples-only',
  '--no-align',
  '--set=ON_ERROR_STOP=1',
  "--variable=tenant_id=$TenantId",
  '--file=-'
)

if ($null -eq $directClient) {
  $invocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
    -FilePath 'docker' `
    -Arguments (@('exec', '-i', $Container, 'psql') + $arguments) `
    -StandardInput $sql
  if ($invocation.ExitCode -ne 0) {
    throw 'Governance dry-run failed closed while reading the isolated restore database.'
  }
  $raw = ($invocation.Output | Out-String).Trim()
}
else {
  $connection = New-EnterprisePostgresConnectionArguments `
    -Client $directClient `
    -DatabaseUser $DatabaseUser `
    -Database $Database
  $raw = (
    Invoke-EnterprisePostgresClient `
      -Client $directClient `
      -Tool psql `
      -Arguments ($connection + $arguments[2..($arguments.Count - 1)]) `
      -StandardInput $sql |
      Out-String
  ).Trim()
}

$databaseReport = $raw | ConvertFrom-Json
$report = [ordered]@{
  formatVersion = 1
  generatedAtUtc = [DateTime]::UtcNow.ToString('o')
  status = 'read-only-dry-run-complete'
  sourceDatabase = [string]$manifest.sourceDatabase
  rehearsalDatabase = $Database
  tenantId = $TenantId
  backupSha256 = ([string]$manifest.sha256).ToLowerInvariant()
  databaseAssessment = $databaseReport
}
$json = $report | ConvertTo-Json -Depth 10
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
  $parent = Split-Path -Parent $resolvedOutputPath
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Governance report directory not found: $parent"
  }
  [System.IO.File]::WriteAllText(
    $resolvedOutputPath,
    $json,
    [System.Text.UTF8Encoding]::new($false)
  )
}
$json
