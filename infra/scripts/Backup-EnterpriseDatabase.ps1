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

  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\.data\backups'),

  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 14,

  [switch]$InitializeBackupDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterprisePostgresClient.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseRestoreGateSql.ps1')

$directClient = if ($PSCmdlet.ParameterSetName -eq 'DirectClient') {
  Resolve-EnterprisePostgresClient `
    -PgBinDirectory $PgBinDirectory `
    -DatabaseHost $DatabaseHost `
    -Port $Port
}
else {
  $null
}
$transportMode = if ($null -eq $directClient) { 'docker' } else { 'direct-client' }

function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Invoke-PostgresScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  if ($null -eq $directClient) {
    $invocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
      -FilePath 'docker' `
      -Arguments @(
        'exec',
        '-i',
        $Container,
        'psql',
        "--username=$DatabaseUser",
        "--dbname=$Database",
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        '--file=-'
      ) `
      -StandardInput $Sql
    $result = $invocation.Output
    if ($invocation.ExitCode -ne 0) {
      throw 'Failed to collect backup metadata from PostgreSQL.'
    }
  }
  else {
    $arguments = @(
      New-EnterprisePostgresConnectionArguments `
        -Client $directClient `
        -DatabaseUser $DatabaseUser `
        -Database $Database
    ) + @(
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '--file=-'
    )
    $result = Invoke-EnterprisePostgresClient `
      -Client $directClient `
      -Tool psql `
      -Arguments $arguments `
      -StandardInput $Sql
  }
  return (($result | Out-String).Trim())
}

$resolvedOutput = Initialize-EnterpriseBackupStorage `
  -Path $OutputDirectory `
  -AllowInitialize:$InitializeBackupDirectory
$backupLock = Open-EnterpriseBackupLock -Directory $resolvedOutput -Database $Database

$baseName = New-EnterpriseBackupBaseName -Database $Database
$archivePath = Join-Path $resolvedOutput "$baseName.dump"
$manifestPath = Join-Path $resolvedOutput "$baseName.manifest.json"
$remoteArchive = "/tmp/$baseName.dump"
$backupReady = $false
$operationError = $null

try {
  if ($null -eq $directClient) {
    Invoke-Docker exec $Container pg_dump --username=$DatabaseUser --dbname=$Database --format=custom --compress=6 --file=$remoteArchive
    Invoke-Docker cp "${Container}:${remoteArchive}" $archivePath
  }
  else {
    $clientArchivePath = ConvertTo-EnterprisePostgresClientPath `
      -Client $directClient `
      -Path $archivePath
    $dumpArguments = @(
      New-EnterprisePostgresConnectionArguments `
        -Client $directClient `
        -DatabaseUser $DatabaseUser `
        -Database $Database
    ) + @(
      '--format=custom',
      '--compress=6',
      "--file=$clientArchivePath"
    )
    Invoke-EnterprisePostgresClient `
      -Client $directClient `
      -Tool pg_dump `
      -Arguments $dumpArguments | Out-Null
  }
  Set-EnterpriseRestrictedPathPermissions -Path $archivePath -Directory $false

  $serverVersion = Invoke-PostgresScalar 'SELECT current_setting(''server_version'');'
  $sourceClusterSystemIdentifier = if ($null -eq $directClient) {
    # Preserve the original Docker role boundary: the documented container
    # backup role need not have pg_monitor just to create an archive.
    $null
  }
  else {
    ConvertTo-EnterprisePostgresSystemIdentifier -Value (
      Invoke-PostgresScalar 'SELECT system_identifier::text FROM pg_control_system();'
    )
  }
  $migrationCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')
  $latestMigration = Invoke-PostgresScalar 'SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1;'
  $tenantCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."tenants";')
  $agentRunCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."agent_runs";')
  $aiRuntimeRunCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."ai_runtime_runs";')
  $knowledgeDocumentCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."knowledge_documents";')
  $roleAssignmentCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."role_assignments";')
  $authActionTokenCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."auth_action_tokens";')
  $aiEvaluationDatasetCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."ai_evaluation_datasets";')
  $aiEvaluationRunnerCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."ai_evaluation_runners";')
  $aiEvaluationRunCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."ai_evaluation_runs";')
  $v2TenantTableRowCounts = (
    Invoke-PostgresScalar (Get-EnterpriseV2TenantTableRowCountsSql)
  ) | ConvertFrom-Json
  $forcedRlsTableCount = [int](Invoke-PostgresScalar "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;")

  $file = Get-Item -LiteralPath $archivePath
  $manifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    metadataSnapshot = 'collected_after_dump_for_observation'
    sourceTransport = $transportMode
    sourceContainer = if ($null -eq $directClient) { $Container } else { $null }
    sourceHost = if ($null -eq $directClient) { $null } else { $directClient.DatabaseHost }
    sourcePort = if ($null -eq $directClient) { $null } else { $directClient.Port }
    sourceClusterSystemIdentifier = $sourceClusterSystemIdentifier
    sourceDatabase = $Database
    postgresVersion = $serverVersion
    archiveFile = $file.Name
    archiveBytes = $file.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    migrationCount = $migrationCount
    latestMigration = $latestMigration
    forcedRlsTableCount = $forcedRlsTableCount
    # These counts are operational observations collected after pg_dump. They
    # are intentionally not a restore equality gate because an active source
    # database can change after the dump's MVCC snapshot closes.
    rowCounts = [ordered]@{
      tenants = $tenantCount
      agentRuns = $agentRunCount
      aiRuntimeRuns = $aiRuntimeRunCount
      knowledgeDocuments = $knowledgeDocumentCount
      roleAssignments = $roleAssignmentCount
      authActionTokens = $authActionTokenCount
      aiEvaluationDatasets = $aiEvaluationDatasetCount
      aiEvaluationRunners = $aiEvaluationRunnerCount
      aiEvaluationRuns = $aiEvaluationRunCount
    }
    v2TenantTableRowCounts = $v2TenantTableRowCounts
  }
  Write-EnterpriseProtectedJsonAtomically -Path $manifestPath -Value $manifest -Depth 5
  $backupReady = $true
}
catch {
  $operationError = $_
}

$remoteArchiveRemoved = $null -ne $directClient
if ($null -eq $directClient) {
  try {
    & docker exec $Container rm -f $remoteArchive 2>$null | Out-Null
    $remoteArchiveRemoved = $LASTEXITCODE -eq 0
  }
  catch {
    $remoteArchiveRemoved = $false
  }
}
if ($null -ne $backupLock) {
  $backupLock.Dispose()
  $backupLock = $null
}

if (-not $backupReady -or -not $remoteArchiveRemoved) {
  Remove-Item -LiteralPath $archivePath, $manifestPath -Force -ErrorAction SilentlyContinue
}
if (-not $remoteArchiveRemoved) {
  throw 'Backup failed closed because the temporary archive could not be removed from the database container.'
}
if ($null -ne $operationError) {
  throw $operationError
}

$cutoff = [DateTime]::UtcNow.AddDays(-$RetentionDays)
Get-ChildItem -LiteralPath $resolvedOutput -File |
  Where-Object {
    $_.LastWriteTimeUtc -lt $cutoff -and
    $_.Name.StartsWith("$Database-", [StringComparison]::Ordinal) -and
    (
      $_.Name -match '\.dump$' -or
      $_.Name -match '\.manifest\.json$' -or
      $_.Name -match '\.restore-report\.json$' -or
      $_.Name -match '\.dr-report\.json$'
    )
  } |
  Remove-Item -Force

[ordered]@{
  status = 'backup-created'
  transport = $transportMode
  archivePath = $archivePath
  manifestPath = $manifestPath
  sha256 = $manifest.sha256
  migrationCount = $migrationCount
  remoteArchiveRemoved = $remoteArchiveRemoved
} | ConvertTo-Json -Depth 3
