[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$Container,

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

function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Invoke-PostgresScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $result = & docker exec $Container psql --username=$DatabaseUser --dbname=$Database --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=$Sql
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to collect backup metadata from PostgreSQL.'
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
  Invoke-Docker exec $Container pg_dump --username=$DatabaseUser --dbname=$Database --format=custom --compress=6 --no-owner --file=$remoteArchive
  Invoke-Docker cp "${Container}:${remoteArchive}" $archivePath
  Set-EnterpriseRestrictedPathPermissions -Path $archivePath -Directory $false

  $serverVersion = Invoke-PostgresScalar 'SELECT current_setting(''server_version'');'
  $migrationCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')
  $latestMigration = Invoke-PostgresScalar 'SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1;'
  $tenantCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."tenants";')
  $agentRunCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."agent_runs";')
  $knowledgeDocumentCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."knowledge_documents";')
  $authActionTokenCount = [int](Invoke-PostgresScalar 'SELECT count(*) FROM public."auth_action_tokens";')
  $forcedRlsTableCount = [int](Invoke-PostgresScalar "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;")

  $file = Get-Item -LiteralPath $archivePath
  $manifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    metadataSnapshot = 'collected_after_dump_for_observation'
    sourceContainer = $Container
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
      knowledgeDocuments = $knowledgeDocumentCount
      authActionTokens = $authActionTokenCount
    }
  }
  Write-EnterpriseProtectedJsonAtomically -Path $manifestPath -Value $manifest -Depth 5
  $backupReady = $true
}
catch {
  $operationError = $_
}

$remoteArchiveRemoved = $false
try {
  & docker exec $Container rm -f $remoteArchive 2>$null | Out-Null
  $remoteArchiveRemoved = $LASTEXITCODE -eq 0
}
catch {
  $remoteArchiveRemoved = $false
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
    ($_.Name -match '\.dump$' -or $_.Name -match '\.manifest\.json$' -or $_.Name -match '\.restore-report\.json$')
  } |
  Remove-Item -Force

[ordered]@{
  status = 'backup-created'
  archivePath = $archivePath
  manifestPath = $manifestPath
  sha256 = $manifest.sha256
  migrationCount = $migrationCount
  remoteArchiveRemoved = $remoteArchiveRemoved
} | ConvertTo-Json -Depth 3
