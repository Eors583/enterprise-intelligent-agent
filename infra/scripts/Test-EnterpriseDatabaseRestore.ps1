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
$restoreStartedAtUtc = [DateTime]::UtcNow

. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterprisePostgresClient.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseRestoreGateSql.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseFinopsCostVerificationGateSql.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseRestoreReportStatus.ps1')

$protectedDatabases = @(
  'enterprise_agent',
  'enterprise_agent_acceptance',
  'enterprise_agent_vector_acceptance',
  'postgres',
  'template0',
  'template1'
)
if ($protectedDatabases -contains $TargetDatabase) {
  throw "Refusing to restore into protected database '$TargetDatabase'."
}
if (-not $TargetDatabase.EndsWith('_restore_rehearsal', [StringComparison]::Ordinal)) {
  throw 'The restore target must end with _restore_rehearsal.'
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
$transportMode = if ($null -eq $directClient) { 'docker' } else { 'direct-client' }
$transportIdentity = if ($null -eq $directClient) {
  $Container
}
else {
  $null
}

$resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
if (-not (Test-Path -LiteralPath $resolvedManifest -PathType Leaf)) {
  throw "Backup manifest not found: $resolvedManifest"
}
$manifest = Get-Content -LiteralPath $resolvedManifest -Raw -Encoding utf8 | ConvertFrom-Json
if ([int]$manifest.formatVersion -ne 1) {
  throw 'Unsupported backup manifest formatVersion.'
}
$sourceV2TenantTableRowCounts = if (
  $null -ne $manifest.PSObject.Properties['v2TenantTableRowCounts']
) {
  $manifest.v2TenantTableRowCounts
}
else {
  $null
}
$sourceTransport = if ($null -ne $manifest.PSObject.Properties['sourceTransport']) {
  [string]$manifest.sourceTransport
}
elseif (-not [string]::IsNullOrWhiteSpace([string]$manifest.sourceContainer)) {
  'docker'
}
else {
  'unknown'
}
$sourceClusterSystemIdentifier = if (
  $null -ne $manifest.PSObject.Properties['sourceClusterSystemIdentifier']
) {
  ([string]$manifest.sourceClusterSystemIdentifier).Trim()
}
else {
  ''
}
if (
  $sourceTransport -eq 'direct-client'
) {
  try {
    $sourceClusterSystemIdentifier = ConvertTo-EnterprisePostgresSystemIdentifier `
      -Value $sourceClusterSystemIdentifier
  }
  catch {
    throw 'Direct-client backup manifests must contain a valid PostgreSQL cluster system identifier.'
  }
}
if (-not $AllowSharedCluster) {
  if ($null -eq $directClient) {
    if ($sourceTransport -eq 'direct-client') {
      throw 'The source and restore cluster separation cannot be proven across transport modes. Supply -AllowSharedCluster only for an already-isolated acceptance cluster.'
    }
    if ([string]$manifest.sourceContainer -eq $Container) {
      throw 'Restore rehearsal must use a separate PostgreSQL container unless -AllowSharedCluster is explicitly supplied for an already-isolated acceptance cluster.'
    }
  }
  elseif ($sourceTransport -ne 'direct-client') {
    throw 'The source and restore cluster separation cannot be proven for this manifest. Supply -AllowSharedCluster only for an already-isolated acceptance cluster.'
  }
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
$restoreClusterSystemIdentifier = $null
$restoreLock = $null

function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Invoke-Psql {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseName,
    [Parameter(Mandatory = $true)][string]$Sql,
    [switch]$QuietScalar,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $psqlArguments = @(
    "--username=$DatabaseUser",
    "--dbname=$DatabaseName",
    '--no-psqlrc'
  )
  if ($QuietScalar) {
    $psqlArguments += @('--quiet', '--tuples-only', '--no-align')
  }
  $psqlArguments += @('--set=ON_ERROR_STOP=1', '--file=-')

  if ($null -eq $directClient) {
    $invocation = Invoke-EnterpriseProcessWithUtf8StandardInput `
      -FilePath 'docker' `
      -Arguments (@('exec', '-i', $Container, 'psql') + $psqlArguments) `
      -StandardInput $Sql
    if ($invocation.ExitCode -ne 0) {
      throw $FailureMessage
    }
    return $invocation.Output
  }

  $connectionArguments = @(
    New-EnterprisePostgresConnectionArguments `
      -Client $directClient `
      -DatabaseUser $DatabaseUser `
      -Database $DatabaseName
  )
  # The direct connection helper supplies the username/database once and adds
  # host, port and --no-password. Keep only psql behavior flags here.
  $directArguments = $connectionArguments + @(
    $psqlArguments | Where-Object {
      $_ -notlike '--username=*' -and $_ -notlike '--dbname=*'
    }
  )
  try {
    return Invoke-EnterprisePostgresClient `
      -Client $directClient `
      -Tool psql `
      -Arguments $directArguments `
      -StandardInput $Sql
  }
  catch {
    throw $FailureMessage
  }
}

function Invoke-AdminSql {
  param([Parameter(Mandatory = $true)][string]$Sql)

  Invoke-Psql `
    -DatabaseName postgres `
    -Sql $Sql `
    -FailureMessage 'PostgreSQL administrative command failed during restore rehearsal.'
}

function Invoke-TargetExists {
  return (
    (
      Invoke-Psql `
        -DatabaseName postgres `
        -Sql "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$TargetDatabase');" `
        -QuietScalar `
        -FailureMessage 'Could not verify whether the restore target already exists.'
    ) | Out-String
  ).Trim() -eq 't'
}

function Invoke-AdminScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $result = Invoke-Psql `
    -DatabaseName postgres `
    -Sql $Sql `
    -QuietScalar `
    -FailureMessage 'PostgreSQL administrative scalar query failed during restore rehearsal.'
  return (($result | Out-String).Trim())
}

function Invoke-TargetScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $result = Invoke-Psql `
    -DatabaseName $TargetDatabase `
    -Sql $Sql `
    -QuietScalar `
    -FailureMessage 'Restore validation query failed.'
  return (($result | Out-String).Trim())
}

function Invoke-PostgresRestore {
  param([Parameter(Mandatory = $true)][string]$ArchivePath)

  if ($null -eq $directClient) {
    Invoke-Docker exec $Container pg_restore --username=$DatabaseUser --dbname=$TargetDatabase --exit-on-error $ArchivePath
    return
  }
  $arguments = @(
    New-EnterprisePostgresConnectionArguments `
      -Client $directClient `
      -DatabaseUser $DatabaseUser `
      -Database $TargetDatabase
  ) + @(
    '--exit-on-error',
    (ConvertTo-EnterprisePostgresClientPath -Client $directClient -Path $ArchivePath)
  )
  Invoke-EnterprisePostgresClient `
    -Client $directClient `
    -Tool pg_restore `
    -Arguments $arguments | Out-Null
}

if ($null -ne $directClient) {
  $restoreClusterSystemIdentifier = ConvertTo-EnterprisePostgresSystemIdentifier -Value (
    Invoke-AdminScalar 'SELECT system_identifier::text FROM pg_control_system();'
  )
  if ($sourceTransport -eq 'direct-client') {
    Assert-EnterprisePostgresClusterSeparation `
      -SourceSystemIdentifier $sourceClusterSystemIdentifier `
      -RestoreSystemIdentifier $restoreClusterSystemIdentifier `
      -AllowSharedCluster:$AllowSharedCluster
  }
  # Bind the local concurrency lock to PostgreSQL's durable cluster identity so
  # DNS aliases or alternate loopback spellings cannot create independent locks.
  $transportIdentity = "postgresql-cluster|$restoreClusterSystemIdentifier"
}
$restoreLock = Open-EnterpriseRestoreTargetLock `
  -Container $transportIdentity `
  -TargetDatabase $TargetDatabase

$report = $null
$operationError = $null
$failedChecks = @()
try {
  $restoreArchive = $archivePath
  if ($null -eq $directClient) {
    Invoke-Docker cp $archivePath "${Container}:${remoteArchive}"
    $restoreArchive = $remoteArchive
  }
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

  Invoke-PostgresRestore -ArchivePath $restoreArchive
  $targetOidAfterRestore = [long](Invoke-AdminScalar "SELECT oid FROM pg_database WHERE datname = '$TargetDatabase';")
  if ($targetOidAfterRestore -ne $createdTargetOid) {
    throw 'The restore target identity changed while pg_restore was running.'
  }
  Invoke-AdminSql "COMMENT ON DATABASE `"$TargetDatabase`" IS '$restoreIdentity';"

  $migrationCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')
  $latestMigration = Invoke-TargetScalar 'SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1;'
  $tenantCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."tenants";')
  $agentRunCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."agent_runs";')
  $aiRuntimeRunCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."ai_runtime_runs";')
  $knowledgeDocumentCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."knowledge_documents";')
  $roleAssignmentCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."role_assignments";')
  $knowledgeEntityCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."knowledge_entities";')
  $knowledgeEntityMentionCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."knowledge_entity_mentions";')
  $knowledgeRelationCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."knowledge_relations";')
  $knowledgeRelationEvidenceCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."knowledge_relation_evidence";')
  $authActionTokenCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."auth_action_tokens";')
  $aiEvaluationDatasetCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."ai_evaluation_datasets";')
  $aiEvaluationRunnerCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."ai_evaluation_runners";')
  $aiEvaluationRunCount = [int](Invoke-TargetScalar 'SELECT count(*) FROM public."ai_evaluation_runs";')
  $v2TenantTableRowCounts = (
    Invoke-TargetScalar (Get-EnterpriseV2TenantTableRowCountsSql)
  ) | ConvertFrom-Json
  $forcedRlsTableCount = [int](Invoke-TargetScalar "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;")
  $invalidForeignKeys = [int](Invoke-TargetScalar "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;")
  $criticalPrivileges = Invoke-TargetScalar (Get-EnterpriseCriticalPrivilegesSql)
  $authActionTokenAcl = Invoke-TargetScalar (Get-EnterpriseAuthActionTokenAclSql)
  $capabilityRoleHardening = Invoke-TargetScalar (Get-EnterpriseCapabilityRoleHardeningSql)
  $scimCancellationSql = Get-EnterpriseScimCancellationHardeningSql
  $scimCancellationHardening = Invoke-TargetScalar $scimCancellationSql
  $scimCancellationPublicExecuteNegativeControl = 'f'
  $scimCancellationDirectTokenReadNegativeControl = 'f'
  $scimCancellationResolverInvokerNegativeControl = 'f'
  $scimCancellationGuardTriggerNegativeControl = 'f'
  $scimCancellationDeprovisionTriggerNegativeControl = 'f'
  $scimCancellationIndexNegativeControl = 'f'
  $scimCancellationConstraintNegativeControl = 'f'
  $scimCancellationConfirmedWriteNegativeControl = 'f'
  $scimCancellationRestoredAfterControl = 'f'
  if ($scimCancellationHardening -eq 't') {
    $embeddedScimCancellationSql = $scimCancellationSql.Trim().TrimEnd(';')
    $scimCancellationPublicExecuteNegativeControl = Invoke-TargetScalar @"
BEGIN;
GRANT EXECUTE ON FUNCTION public.resolve_scim_capability(text, text) TO PUBLIC;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationDirectTokenReadNegativeControl = Invoke-TargetScalar @"
BEGIN;
GRANT SELECT ON TABLE public.scim_service_tokens TO enterprise_agent_scim;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationResolverInvokerNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER FUNCTION public.resolve_scim_capability(text, text) SECURITY INVOKER;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationGuardTriggerNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.agent_runs
  DISABLE TRIGGER agent_runs_untrusted_cancellation_guard;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationDeprovisionTriggerNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.scim_users DISABLE TRIGGER scim_users_deprovision;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationIndexNegativeControl = Invoke-TargetScalar @"
BEGIN;
DROP INDEX public.agent_runs_pending_cancellation_idx;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationConstraintNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.agent_runs
  DROP CONSTRAINT agent_runs_cancellation_evidence_check;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationConfirmedWriteNegativeControl = Invoke-TargetScalar @"
BEGIN;
GRANT UPDATE (cancellation_confirmed_at)
  ON TABLE public.agent_runs TO enterprise_agent_scim;
SELECT NOT ($embeddedScimCancellationSql);
ROLLBACK;
"@
    $scimCancellationRestoredAfterControl = Invoke-TargetScalar $scimCancellationSql
  }
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
  $agentRunStreamIntegrity = Invoke-TargetScalar (Get-EnterpriseAgentRunStreamIntegritySql)
  $businessSemanticsIntegrity = Invoke-TargetScalar (Get-EnterpriseBusinessSemanticsIntegritySql)
  $toolGatewayIntegrity = Invoke-TargetScalar (Get-EnterpriseToolGatewayIntegritySql)
  $toolCostAttestationSql = Get-EnterpriseToolCostAttestationIntegritySql
  $toolCostAttestationIntegrity = Invoke-TargetScalar $toolCostAttestationSql
  $toolCostAttestationNegativeControl = 'f'
  $toolCostAttestationRestoredAfterControl = 'f'
  if ($toolCostAttestationIntegrity -eq 't') {
    $embeddedToolCostAttestationSql = $toolCostAttestationSql.Trim().TrimEnd(';')
    $toolCostAttestationNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.tool_execution_receipts
  DROP CONSTRAINT tool_execution_receipts_cost_attestation_check;
SELECT NOT ($embeddedToolCostAttestationSql);
ROLLBACK;
"@
    $toolCostAttestationRestoredAfterControl =
      Invoke-TargetScalar $toolCostAttestationSql
  }
  $aiEvaluationIntegrity = Invoke-TargetScalar (Get-EnterpriseAiEvaluationIntegritySql)
  $auditChainIntegrity = Invoke-TargetScalar (Get-EnterpriseAuditChainIntegritySql)
  $finopsCostVerificationIntegrity = Invoke-TargetScalar (
    Get-EnterpriseFinopsCostVerificationIntegritySql
  )
  $processCollaborationSql = Get-EnterpriseProcessCollaborationIntegritySql
  $processCollaborationIntegrity = Invoke-TargetScalar $processCollaborationSql
  $processCollaborationTriggerNegativeControl = 'f'
  $processCollaborationIndexNegativeControl = 'f'
  $processCollaborationRestoredAfterControl = 'f'
  if ($processCollaborationIntegrity -eq 't') {
    $embeddedProcessCollaborationSql = $processCollaborationSql.Trim().TrimEnd(';')
    $processCollaborationTriggerNegativeControl = Invoke-TargetScalar @"
BEGIN;
DROP TRIGGER business_event_evidence_parent_bijection_trigger
  ON public.business_event_evidence;
SELECT NOT ($embeddedProcessCollaborationSql);
ROLLBACK;
"@
    $processCollaborationIndexNegativeControl = Invoke-TargetScalar @"
BEGIN;
DROP INDEX public.collaboration_participants_active_user_key;
SELECT NOT ($embeddedProcessCollaborationSql);
ROLLBACK;
"@
    $processCollaborationRestoredAfterControl = Invoke-TargetScalar $processCollaborationSql
  }
  $v2TenantTableSql = Get-EnterpriseV2TenantTableIntegritySql
  $v2TenantTableIntegrity = Invoke-TargetScalar $v2TenantTableSql
  $v2TenantTableAclNegativeControl = 'f'
  $v2TenantTableForeignKeyNegativeControl = 'f'
  $v2TenantTableRlsNegativeControl = 'f'
  $v2TenantTableRestoredAfterControl = 'f'
  if ($v2TenantTableIntegrity -eq 't') {
    $embeddedV2TenantTableSql = $v2TenantTableSql.Trim().TrimEnd(';')
    $v2TenantTableAclNegativeControl = Invoke-TargetScalar @"
BEGIN;
REVOKE SELECT ON TABLE public.memory_records FROM enterprise_agent_app;
SELECT NOT ($embeddedV2TenantTableSql);
ROLLBACK;
"@
    $v2TenantTableForeignKeyNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.agent_run_stream_events
  DROP CONSTRAINT agent_run_stream_events_tenant_id_run_id_fkey;
SELECT NOT ($embeddedV2TenantTableSql);
ROLLBACK;
"@
    $v2TenantTableRlsNegativeControl = Invoke-TargetScalar @"
BEGIN;
ALTER TABLE public.memory_records NO FORCE ROW LEVEL SECURITY;
SELECT NOT ($embeddedV2TenantTableSql);
ROLLBACK;
"@
    $v2TenantTableRestoredAfterControl = Invoke-TargetScalar $v2TenantTableSql
  }

  $checks = [ordered]@{
    archiveHash = $actualHash -eq [string]$manifest.sha256
    migrationHistoryReadable = $migrationCount -gt 0 -and -not [string]::IsNullOrWhiteSpace($latestMigration)
    schemaMetadataMatchesManifest = `
      $migrationCount -eq [int]$manifest.migrationCount -and `
      $latestMigration -eq [string]$manifest.latestMigration -and `
      $forcedRlsTableCount -eq [int]$manifest.forcedRlsTableCount
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
    keyTablesReadable = `
      $tenantCount -ge 0 -and `
      $agentRunCount -ge 0 -and `
      $aiRuntimeRunCount -ge 0 -and `
      $knowledgeDocumentCount -ge 0 -and `
      $authActionTokenCount -ge 0 -and `
      $aiEvaluationDatasetCount -ge 0 -and `
      $aiEvaluationRunnerCount -ge 0 -and `
      $aiEvaluationRunCount -ge 0
    knowledgeGraphTablesReadable = `
      $knowledgeEntityCount -ge 0 -and `
      $knowledgeEntityMentionCount -ge 0 -and `
      $knowledgeRelationCount -ge 0 -and `
      $knowledgeRelationEvidenceCount -ge 0
    v2TenantTablesReadable = `
      @($v2TenantTableRowCounts.PSObject.Properties).Count -eq 31 -and `
      @(
        $v2TenantTableRowCounts.PSObject.Properties |
          Where-Object { [long]$_.Value -lt 0 }
      ).Count -eq 0
    foreignKeysValidated = $invalidForeignKeys -eq 0
    criticalRolePrivileges = $criticalPrivileges -eq 't'
    authActionTokenExactAcl = $authActionTokenAcl -eq 't'
    capabilityRolesHardened = $capabilityRoleHardening -eq 't'
    scimCancellationHardening = $scimCancellationHardening -eq 't'
    scimCancellationNegativeControls = `
      $scimCancellationPublicExecuteNegativeControl -eq 't' -and `
      $scimCancellationDirectTokenReadNegativeControl -eq 't' -and `
      $scimCancellationResolverInvokerNegativeControl -eq 't' -and `
      $scimCancellationGuardTriggerNegativeControl -eq 't' -and `
      $scimCancellationDeprovisionTriggerNegativeControl -eq 't' -and `
      $scimCancellationIndexNegativeControl -eq 't' -and `
      $scimCancellationConstraintNegativeControl -eq 't' -and `
      $scimCancellationConfirmedWriteNegativeControl -eq 't' -and `
      $scimCancellationRestoredAfterControl -eq 't'
    agentRunUsageConstraints = $agentRunUsageConstraints -eq 't'
    authActionTokenRolePolicies = $authActionTokenRolePolicies -eq 't'
    authActionTokenKeys = $authActionTokenKeys -eq 't'
    authActionTokenCheckConstraints = $authActionTokenCheckConstraints -eq 't'
    authActionTokenActiveIndex = $authActionTokenActiveIndex -eq 't'
    authActionTokenSupportingIndexes = $authActionTokenSupportingIndexes -eq 't'
    agentRunStreamIntegrity = $agentRunStreamIntegrity -eq 't'
    businessSemanticsIntegrity = $businessSemanticsIntegrity -eq 't'
    toolGatewayIntegrity = $toolGatewayIntegrity -eq 't'
    toolCostAttestationIntegrity = $toolCostAttestationIntegrity -eq 't'
    toolCostAttestationNegativeControl = `
      $toolCostAttestationNegativeControl -eq 't' -and `
      $toolCostAttestationRestoredAfterControl -eq 't'
    aiEvaluationIntegrity = $aiEvaluationIntegrity -eq 't'
    auditChainIntegrity = $auditChainIntegrity -eq 't'
    finopsCostVerificationIntegrity = $finopsCostVerificationIntegrity -eq 't'
    processCollaborationIntegrity = $processCollaborationIntegrity -eq 't'
    processCollaborationNegativeControl = `
      $processCollaborationTriggerNegativeControl -eq 't' -and `
      $processCollaborationIndexNegativeControl -eq 't' -and `
      $processCollaborationRestoredAfterControl -eq 't'
    v2TenantTableIntegrity = $v2TenantTableIntegrity -eq 't'
    v2TenantTableNegativeControls = `
      $v2TenantTableAclNegativeControl -eq 't' -and `
      $v2TenantTableForeignKeyNegativeControl -eq 't' -and `
      $v2TenantTableRlsNegativeControl -eq 't' -and `
      $v2TenantTableRestoredAfterControl -eq 't'
  }
  $failedChecks = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)
  $report = [ordered]@{
    status = if ($failedChecks.Count -eq 0) { 'restore-pending-cleanup' } else { 'restore-verification-failed' }
    attemptedAtUtc = $restoreStartedAtUtc.ToString('o')
    verifiedAtUtc = $null
    transport = $transportMode
    sourceDatabase = [string]$manifest.sourceDatabase
    targetDatabase = $TargetDatabase
    sourceClusterSystemIdentifier = if ([string]::IsNullOrWhiteSpace($sourceClusterSystemIdentifier)) { $null } else { $sourceClusterSystemIdentifier }
    restoreClusterSystemIdentifier = $restoreClusterSystemIdentifier
    backupSha256 = $actualHash
    checks = $checks
    observations = [ordered]@{
      sourceMetadataAfterSnapshot = [ordered]@{
        clusterSystemIdentifier = if ([string]::IsNullOrWhiteSpace($sourceClusterSystemIdentifier)) { $null } else { $sourceClusterSystemIdentifier }
        migrationCount = [int]$manifest.migrationCount
        latestMigration = [string]$manifest.latestMigration
        forcedRlsTableCount = [int]$manifest.forcedRlsTableCount
      }
      restoredMetadata = [ordered]@{
        clusterSystemIdentifier = $restoreClusterSystemIdentifier
        migrationCount = $migrationCount
        latestMigration = $latestMigration
        forcedRlsTableCount = $forcedRlsTableCount
      }
      sourceRowCountsAfterSnapshot = $manifest.rowCounts
      sourceV2TenantTableRowCountsAfterSnapshot = $sourceV2TenantTableRowCounts
      restoredRowCounts = [ordered]@{
        tenants = $tenantCount
        agentRuns = $agentRunCount
        aiRuntimeRuns = $aiRuntimeRunCount
        knowledgeDocuments = $knowledgeDocumentCount
        roleAssignments = $roleAssignmentCount
        knowledgeEntities = $knowledgeEntityCount
        knowledgeEntityMentions = $knowledgeEntityMentionCount
        knowledgeRelations = $knowledgeRelationCount
        knowledgeRelationEvidence = $knowledgeRelationEvidenceCount
        authActionTokens = $authActionTokenCount
        aiEvaluationDatasets = $aiEvaluationDatasetCount
        aiEvaluationRunners = $aiEvaluationRunnerCount
        aiEvaluationRuns = $aiEvaluationRunCount
      }
      restoredV2TenantTableRowCounts = $v2TenantTableRowCounts
    }
    failedChecks = $failedChecks
  }
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
      Invoke-AdminSql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TargetDatabase' AND pid <> pg_backend_pid();" | Out-Null
      Invoke-AdminSql "DROP DATABASE `"$TargetDatabase`";" | Out-Null
      $temporaryDatabaseRemoved = $true
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
    attemptedAtUtc = $restoreStartedAtUtc.ToString('o')
    verifiedAtUtc = $null
    transport = $transportMode
    sourceDatabase = [string]$manifest.sourceDatabase
    targetDatabase = $TargetDatabase
    sourceClusterSystemIdentifier = if ([string]::IsNullOrWhiteSpace($sourceClusterSystemIdentifier)) { $null } else { $sourceClusterSystemIdentifier }
    restoreClusterSystemIdentifier = $restoreClusterSystemIdentifier
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
