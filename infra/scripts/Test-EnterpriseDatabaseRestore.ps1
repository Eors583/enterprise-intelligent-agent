[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$Container,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$DatabaseUser,

  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [ValidateLength(1, 63)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*_restore_rehearsal$')]
  [string]$TargetDatabase = 'enterprise_agent_restore_rehearsal',

  [switch]$KeepRestoredDatabase,

  [switch]$AllowSharedCluster,

  [switch]$ReplaceExistingTarget
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseRestoreGateSql.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseRestoreReportStatus.ps1')

$protectedDatabases = @('enterprise_agent', 'enterprise_agent_acceptance', 'postgres', 'template0', 'template1')
if ($protectedDatabases -contains $TargetDatabase) {
  throw "Refusing to restore into protected database '$TargetDatabase'."
}
if (-not $TargetDatabase.EndsWith('_restore_rehearsal', [StringComparison]::Ordinal)) {
  throw 'The restore target must end with _restore_rehearsal.'
}

$resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
if (-not (Test-Path -LiteralPath $resolvedManifest -PathType Leaf)) {
  throw "Backup manifest not found: $resolvedManifest"
}
$manifest = Get-Content -LiteralPath $resolvedManifest -Raw -Encoding utf8 | ConvertFrom-Json
if ([int]$manifest.formatVersion -ne 1) {
  throw 'Unsupported backup manifest formatVersion.'
}
if (-not $AllowSharedCluster -and [string]$manifest.sourceContainer -eq $Container) {
  throw 'Restore rehearsal must use a separate PostgreSQL container unless -AllowSharedCluster is explicitly supplied for an already-isolated acceptance cluster.'
}
$archiveFile = [string]$manifest.archiveFile
if ([System.IO.Path]::GetFileName($archiveFile) -ne $archiveFile) {
  throw 'The backup manifest archiveFile must be a file name without directory components.'
}
$archivePath = Join-Path (Split-Path -Parent $resolvedManifest) $archiveFile
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  throw "Backup archive not found: $archivePath"
}
if ([string]$manifest.sourceDatabase -eq $TargetDatabase) {
  throw 'The restore target must differ from the source database recorded in the manifest.'
}
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne [string]$manifest.sha256) {
  throw 'Backup archive SHA-256 does not match the manifest.'
}

$remoteArchive = "/tmp/$([System.IO.Path]::GetFileName($archivePath))"
$reportPath = [System.IO.Path]::ChangeExtension($resolvedManifest, '.restore-report.json')
$createdTarget = $false
$createdTargetOid = $null
$restoreIdentity = 'enterprise-agent-restore:' + [Guid]::NewGuid().ToString('N')
$restoreLock = Open-EnterpriseRestoreTargetLock -Container $Container -TargetDatabase $TargetDatabase

function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Invoke-AdminSql {
  param([Parameter(Mandatory = $true)][string]$Sql)

  & docker exec $Container psql --username=$DatabaseUser --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --command=$Sql
  if ($LASTEXITCODE -ne 0) {
    throw 'PostgreSQL administrative command failed during restore rehearsal.'
  }
}

function Invoke-TargetExists {
  $result = & docker exec $Container psql --username=$DatabaseUser --dbname=postgres --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$TargetDatabase');"
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not verify whether the restore target already exists.'
  }
  return (($result | Out-String).Trim()) -eq 't'
}

function Invoke-AdminScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $result = & docker exec $Container psql --username=$DatabaseUser --dbname=postgres --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=$Sql
  if ($LASTEXITCODE -ne 0) {
    throw 'PostgreSQL administrative scalar query failed during restore rehearsal.'
  }
  return (($result | Out-String).Trim())
}

function Invoke-TargetScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $result = & docker exec $Container psql --username=$DatabaseUser --dbname=$TargetDatabase --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=$Sql
  if ($LASTEXITCODE -ne 0) {
    throw 'Restore validation query failed.'
  }
  return (($result | Out-String).Trim())
}

$report = $null
$operationError = $null
$failedChecks = @()
try {
  Invoke-Docker cp $archivePath "${Container}:${remoteArchive}"
  $targetExists = Invoke-TargetExists
  if ($targetExists -and -not $ReplaceExistingTarget) {
    throw "Restore target '$TargetDatabase' already exists. Refusing to terminate or replace it without -ReplaceExistingTarget."
  }
  if ($targetExists) {
    Invoke-AdminSql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TargetDatabase' AND pid <> pg_backend_pid();"
    Invoke-AdminSql "DROP DATABASE `"$TargetDatabase`";"
  }
  Invoke-AdminSql "CREATE DATABASE `"$TargetDatabase`";"
  $createdTarget = $true
  $createdTargetOid = [long](Invoke-AdminScalar "SELECT oid FROM pg_database WHERE datname = '$TargetDatabase';")
  Invoke-AdminSql "COMMENT ON DATABASE `"$TargetDatabase`" IS '$restoreIdentity';"

  Invoke-Docker exec $Container pg_restore --username=$DatabaseUser --dbname=$TargetDatabase --exit-on-error --no-owner $remoteArchive
  $targetOidAfterRestore = [long](Invoke-AdminScalar "SELECT oid FROM pg_database WHERE datname = '$TargetDatabase';")
  if ($targetOidAfterRestore -ne $createdTargetOid) {
    throw 'The restore target identity changed while pg_restore was running.'
  }
  Invoke-AdminSql "COMMENT ON DATABASE `"$TargetDatabase`" IS '$restoreIdentity';"

  $migrationCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')
  $latestMigration = Invoke-TargetScalar 'SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1;'
  $tenantCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."tenants";')
  $agentRunCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."agent_runs";')
  $knowledgeDocumentCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."knowledge_documents";')
  $authActionTokenCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."auth_action_tokens";')
  $forcedRlsTableCount = [int](Invoke-TargetScalar "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;")
  $invalidForeignKeys = [int](Invoke-TargetScalar "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;")
  $criticalPrivileges = Invoke-TargetScalar (Get-EnterpriseCriticalPrivilegesSql)
  $authActionTokenAcl = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenAclSql)
  $capabilityRoleHardening = Invoke-TargetScalar (Get-EnterpriseCapabilityRoleHardeningSql)
  $tenantRlsSql = Get-EnterpriseTenantRlsIntegritySql
  $tenantRlsIntegrity = Invoke-TargetScalar $tenantRlsSql
  $tenantRlsForceNegativeControl = 'f'
  $tenantRlsExpressionNegativeControl = 'f'
  $tenantRlsUnregisteredTableNegativeControl = 'f'
  $tenantRlsRestoredAfterControl = 'f'
  if ($tenantRlsIntegrity -eq 't') {
    $embeddedTenantRlsSql = $tenantRlsSql.Trim().TrimEnd(';')
    $tenantRlsForceNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.agent_runs NO FORCE ROW LEVEL SECURITY;
SELECT NOT ($embeddedTenantRlsSql);
ROLLBACK;
"@
    $tenantRlsExpressionNegativeControl = Invoke-TargetScalar @"
BEGIN;
DROP POLICY tenant_isolation ON public.agent_runs;
CREATE POLICY tenant_isolation ON public.agent_runs AS RESTRICTIVE FOR ALL TO PUBLIC
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR true)
WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
SELECT NOT ($embeddedTenantRlsSql);
ROLLBACK;
"@
    $tenantRlsUnregisteredTableNegativeControl = Invoke-TargetScalar @"
BEGIN;
CREATE TABLE public.enterprise_restore_gate_unregistered_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);
SELECT NOT ($embeddedTenantRlsSql);
ROLLBACK;
"@
    $tenantRlsRestoredAfterControl = Invoke-TargetScalar $tenantRlsSql
  }
  $authLoginRateLimitSql = Get-EnterpriseAuthLoginRateLimitBoundarySql
  $authLoginRateLimitBoundary = Invoke-TargetScalar $authLoginRateLimitSql
  $authLoginRateLimitNegativeControl = 'f'
  $authLoginRateLimitRestoredAfterControl = 'f'
  if ($authLoginRateLimitBoundary -eq 't') {
    $embeddedAuthLoginRateLimitSql = $authLoginRateLimitSql.Trim().TrimEnd(';')
    $authLoginRateLimitNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.auth_login_rate_limits NO FORCE ROW LEVEL SECURITY;
SELECT NOT ($embeddedAuthLoginRateLimitSql);
ROLLBACK;
"@
    $authLoginRateLimitRestoredAfterControl = Invoke-TargetScalar $authLoginRateLimitSql
  }
  $authActionTokenRolePolicies = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenPolicyIntegritySql)
  $agentRunUsageConstraints = Invoke-TargetScalar (Get-EnterpriseAgentRunUsageConstraintsSql)
  $authActionTokenKeys = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenKeyConstraintsSql)
  $authActionTokenCheckConstraints = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenCheckConstraintsSql)
  $authActionTokenActiveIndex = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenActiveIndexSql)
  $authActionTokenSupportingIndexes = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenSupportingIndexesSql)

  $checks = [ordered]@{
    archiveHash = $actualHash -eq [string]$manifest.sha256
    migrationHistoryReadable = $migrationCount -gt 0 -and -not [string]::IsNullOrWhiteSpace($latestMigration)
    tenantRlsExactSet = $tenantRlsIntegrity -eq 't'
    tenantRlsNegativeControls = `
      $tenantRlsForceNegativeControl -eq 't' -and `
      $tenantRlsExpressionNegativeControl -eq 't' -and `
      $tenantRlsUnregisteredTableNegativeControl -eq 't' -and `
      $tenantRlsRestoredAfterControl -eq 't'
    authLoginRateLimitBoundary = $authLoginRateLimitBoundary -eq 't'
    authLoginRateLimitNegativeControl = `
      $authLoginRateLimitNegativeControl -eq 't' -and `
      $authLoginRateLimitRestoredAfterControl -eq 't'
    keyTablesReadable = $tenantCount -ge 0 -and $agentRunCount -ge 0 -and $knowledgeDocumentCount -ge 0 -and $authActionTokenCount -ge 0
    foreignKeysValidated = $invalidForeignKeys -eq 0
    criticalRolePrivileges = $criticalPrivileges -eq 't'
    authActionTokenExactAcl = $authActionTokenAcl -eq 't'
    capabilityRolesHardened = $capabilityRoleHardening -eq 't'
    agentRunUsageConstraints = $agentRunUsageConstraints -eq 't'
    authActionTokenRolePolicies = $authActionTokenRolePolicies -eq 't'
    authActionTokenKeys = $authActionTokenKeys -eq 't'
    authActionTokenCheckConstraints = $authActionTokenCheckConstraints -eq 't'
    authActionTokenActiveIndex = $authActionTokenActiveIndex -eq 't'
    authActionTokenSupportingIndexes = $authActionTokenSupportingIndexes -eq 't'
  }
  $failedChecks = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)
  $report = [ordered]@{
    status = if ($failedChecks.Count -eq 0) { 'restore-pending-cleanup' } else { 'restore-verification-failed' }
    attemptedAtUtc = [DateTime]::UtcNow.ToString('o')
    verifiedAtUtc = $null
    sourceDatabase = [string]$manifest.sourceDatabase
    targetDatabase = $TargetDatabase
    backupSha256 = $actualHash
    checks = $checks
    observations = [ordered]@{
      sourceMetadataAfterSnapshot = [ordered]@{
        migrationCount = [int]$manifest.migrationCount
        latestMigration = [string]$manifest.latestMigration
        forcedRlsTableCount = [int]$manifest.forcedRlsTableCount
      }
      restoredMetadata = [ordered]@{
        migrationCount = $migrationCount
        latestMigration = $latestMigration
        forcedRlsTableCount = $forcedRlsTableCount
      }
      sourceRowCountsAfterSnapshot = $manifest.rowCounts
      restoredRowCounts = [ordered]@{
        tenants = $tenantCount
        agentRuns = $agentRunCount
        knowledgeDocuments = $knowledgeDocumentCount
        authActionTokens = $authActionTokenCount
      }
    }
    failedChecks = $failedChecks
  }
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

$temporaryDatabaseRemoved = $true
$restoredDatabaseRetained = $createdTarget -and [bool]$KeepRestoredDatabase
if ($createdTarget -and -not $KeepRestoredDatabase) {
  $temporaryDatabaseRemoved = $false
  try {
    $stillOwned = Invoke-AdminScalar @"
SELECT EXISTS (
  SELECT 1 FROM pg_database
  WHERE datname = '$TargetDatabase'
    AND oid = $createdTargetOid
    AND shobj_description(oid, 'pg_database') = '$restoreIdentity'
);
"@
    if ($stillOwned -eq 't') {
      & docker exec $Container psql --username=$DatabaseUser --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TargetDatabase' AND pid <> pg_backend_pid();" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        & docker exec $Container psql --username=$DatabaseUser --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --command="DROP DATABASE `"$TargetDatabase`";" 2>$null | Out-Null
        $temporaryDatabaseRemoved = $LASTEXITCODE -eq 0
      }
    }
  }
  catch {
    $temporaryDatabaseRemoved = $false
  }
}

$cleanupVerified = $remoteArchiveRemoved -and $temporaryDatabaseRemoved
if ($null -ne $restoreLock) {
  $restoreLock.Dispose()
  $restoreLock = $null
}
if ($null -eq $report) {
  $report = [ordered]@{
    status = 'restore-operation-failed'
    attemptedAtUtc = [DateTime]::UtcNow.ToString('o')
    verifiedAtUtc = $null
    sourceDatabase = [string]$manifest.sourceDatabase
    targetDatabase = $TargetDatabase
    backupSha256 = $actualHash
    checks = [ordered]@{}
    observations = [ordered]@{}
    failedChecks = @('restoreOperation')
  }
}

$report['cleanupVerified'] = $cleanupVerified
$report['cleanup'] = [ordered]@{
  remoteArchiveRemoved = $remoteArchiveRemoved
  temporaryDatabaseRemoved = if ($restoredDatabaseRetained) { $null } else { $temporaryDatabaseRemoved }
  restoredDatabaseRetained = $restoredDatabaseRetained
}
$report['status'] = Resolve-EnterpriseRestoreReportStatus `
  -CleanupVerified $cleanupVerified `
  -OperationFailed ($null -ne $operationError) `
  -FailedCheckCount $failedChecks.Count
if ($report.status -eq 'restore-verified') {
  $report['verifiedAtUtc'] = [DateTime]::UtcNow.ToString('o')
}

# A success report is published only after cleanup has completed. The atomic
# replace prevents the monitor from observing a partially written JSON report.
Write-EnterpriseProtectedJsonAtomically -Path $reportPath -Value $report -Depth 6

if (-not $cleanupVerified) {
  throw 'Restore rehearsal cleanup failed; a temporary archive or database may remain.'
}
if ($null -ne $operationError) { throw $operationError }
if ($failedChecks.Count -gt 0) {
  throw "Restore verification failed: $($failedChecks -join ', ')."
}
$report | ConvertTo-Json -Depth 6
