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

  [string]$BackupDirectory = '',

  [ValidateRange(1, 1440)]
  [int]$QueueAgeMinutes = 5,

  [ValidateRange(1, 1440)]
  [int]$RunAgeMinutes = 10,

  [ValidateRange(1, 168)]
  [int]$BackupMaxAgeHours = 25,

  [ValidateRange(1, 720)]
  [int]$RestoreReportMaxAgeHours = 168,

  [ValidateRange(1, 99)]
  [int]$QuotaWarningPercent = 85,

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')]
  [string]$ExpectedEmbeddingModel = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  $BackupDirectory = Join-Path $PSScriptRoot '..\..\.data\backups'
}

. (Join-Path $PSScriptRoot 'lib\EnterpriseCoreAlertStatus.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupHealth.ps1')

function Invoke-Scalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $result = & docker exec $Container psql --username=$DatabaseUser --dbname=$Database --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=$Sql
  if ($LASTEXITCODE -ne 0) {
    throw 'Core alert probe could not query PostgreSQL.'
  }
  return (($result | Out-String).Trim())
}

$outboxStaleSql = @"
SELECT count(*) FROM public."outbox_events"
WHERE status = 'PENDING'
  AND available_at < now() - interval '$QueueAgeMinutes minutes';
"@
$agentQueuedSql = @"
SELECT count(*) FROM public."agent_runs"
WHERE status = 'QUEUED'
  AND created_at < now() - interval '$QueueAgeMinutes minutes';
"@
$agentActiveSql = @"
SELECT count(*) FROM public."agent_runs"
WHERE status IN ('DISPATCHING', 'RUNNING')
  AND updated_at < now() - interval '$RunAgeMinutes minutes';
"@
$currentChunkCount = 0
$missingEmbeddings = -1
$matchingEmbeddings = -1
$semanticSchemaAvailable = $true
try {
  $embeddingPredicate = if ([string]::IsNullOrWhiteSpace($ExpectedEmbeddingModel)) {
    ''
  }
  else {
    $escapedEmbeddingModel = $ExpectedEmbeddingModel.Replace("'", "''")
    " AND e.`"embedding_model`" = '$escapedEmbeddingModel' AND vector_dims(e.`"embedding`"::vector) = 1536"
  }
  $coverage = Invoke-Scalar @"
WITH current_chunks AS (
  SELECT c."tenant_id", c."id"
  FROM public."knowledge_chunks" c
  JOIN public."knowledge_documents" d
    ON d."tenant_id" = c."tenant_id"
   AND d."current_version_id" = c."document_version_id"
), coverage AS (
  SELECT EXISTS (
    SELECT 1
    FROM public."knowledge_chunk_embeddings" e
    WHERE e."tenant_id" = c."tenant_id" AND e."chunk_id" = c."id"$embeddingPredicate
  ) AS matched
  FROM current_chunks c
)
SELECT json_build_object(
  'currentChunkCount', count(*),
  'matchingEmbeddingCount', count(*) FILTER (WHERE matched),
  'missingEmbeddingCount', count(*) FILTER (WHERE NOT matched)
)::text
FROM coverage;
"@
  $coverageCounts = $coverage | ConvertFrom-Json
  $currentChunkCount = [int]$coverageCounts.currentChunkCount
  $matchingEmbeddings = [int]$coverageCounts.matchingEmbeddingCount
  $missingEmbeddings = [int]$coverageCounts.missingEmbeddingCount
}
catch {
  if ((Invoke-Scalar "SELECT to_regclass('public.knowledge_chunk_embeddings') IS NULL;") -ne 't') {
    throw
  }
  $semanticSchemaAvailable = $false
  $currentChunkCount = [int](Invoke-Scalar @'
SELECT count(*)
FROM public."knowledge_chunks" c
JOIN public."knowledge_documents" d
  ON d."tenant_id" = c."tenant_id"
 AND d."current_version_id" = c."document_version_id";
'@)
}

$semanticReadiness = Resolve-EnterpriseSemanticReadiness `
  -ExpectedEmbeddingModel $ExpectedEmbeddingModel `
  -CurrentChunkCount $currentChunkCount `
  -MatchingEmbeddingCount $matchingEmbeddings `
  -SchemaAvailable $semanticSchemaAvailable

$signals = [ordered]@{
  outboxUnknown = [int](Invoke-Scalar @'
SELECT count(*)
FROM public."outbox_events" event
WHERE event.status = 'UNKNOWN'
  AND (
    event.aggregate_type <> 'agent_run'
    OR EXISTS (
      SELECT 1 FROM public."agent_runs" run
      WHERE run.id = event.aggregate_id AND run.tenant_id = event.tenant_id
        AND run.status = 'UNKNOWN'
    )
  );
'@)
  outboxStalePending = [int](Invoke-Scalar $outboxStaleSql)
  agentRunsStaleQueued = [int](Invoke-Scalar $agentQueuedSql)
  agentRunsStaleActive = [int](Invoke-Scalar $agentActiveSql)
  agentRunsUnknown = [int](Invoke-Scalar 'SELECT count(*) FROM public."agent_runs" WHERE status = ''UNKNOWN'';')
  agentRunUnverifiedHolds = [int](Invoke-Scalar 'SELECT count(*) FROM public."agent_runs" WHERE reserved_tokens > 0 AND status IN (''SUCCEEDED'', ''FAILED'', ''UNKNOWN'', ''CANCELLED'');')
  tenantQuotasNearLimit = [int](Invoke-Scalar @"
WITH ledger AS (
  SELECT
    tenant_id,
    COALESCE(SUM(total_tokens) FILTER (
      WHERE finished_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND usage_recorded_at IS NOT NULL
    ), 0)::numeric AS used_tokens,
    COALESCE(SUM(reserved_tokens) FILTER (WHERE reserved_tokens > 0), 0)::numeric AS held_tokens
  FROM public."agent_runs"
  GROUP BY tenant_id
)
SELECT count(*)
FROM public."tenants" tenant
LEFT JOIN ledger ON ledger.tenant_id = tenant.id
WHERE (COALESCE(ledger.used_tokens, 0) + COALESCE(ledger.held_tokens, 0)) * 100
  >= tenant.agent_run_monthly_token_limit::numeric * $QuotaWarningPercent;
"@)
  blockedLoginBuckets = [int](Invoke-Scalar 'SELECT count(*) FROM public."auth_login_rate_limits" WHERE blocked_until > now();')
  ingestionFailures24h = [int](Invoke-Scalar 'SELECT count(*) FROM public."knowledge_ingestion_jobs" WHERE status = ''FAILED'' AND finished_at >= now() - interval ''24 hours'';')
  currentKnowledgeChunks = $currentChunkCount
  currentChunksWithMatchingEmbeddings = $matchingEmbeddings
  currentChunksMissingEmbeddings = $missingEmbeddings
}

$resolvedBackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
$backupContinuity = Get-EnterpriseBackupContinuityStatus `
  -BackupDirectory $resolvedBackupDirectory `
  -Database $Database `
  -BackupMaxAgeHours $BackupMaxAgeHours `
  -RestoreReportMaxAgeHours $RestoreReportMaxAgeHours
$backupStatus = [string]$backupContinuity.backupStatus
$restoreStatus = [string]$backupContinuity.restoreStatus

$alerts = @()
if ($signals.outboxUnknown -gt 0) { $alerts += 'OUTBOX_UNKNOWN' }
if ($signals.outboxStalePending -gt 0) { $alerts += 'OUTBOX_STALE' }
if ($signals.agentRunsUnknown -gt 0) { $alerts += 'AGENT_RUN_UNKNOWN' }
if ($signals.agentRunUnverifiedHolds -gt 0) { $alerts += 'AGENT_RUN_USAGE_UNVERIFIED' }
if ($signals.tenantQuotasNearLimit -gt 0) { $alerts += 'TENANT_AGENT_QUOTA_NEAR_LIMIT' }
if ($signals.blockedLoginBuckets -gt 0) { $alerts += 'AUTH_LOGIN_BUCKET_BLOCKED' }
if ($signals.agentRunsStaleQueued -gt 0) { $alerts += 'AGENT_RUN_QUEUE_STALE' }
if ($signals.agentRunsStaleActive -gt 0) { $alerts += 'AGENT_RUN_ACTIVE_STALE' }
if ($signals.ingestionFailures24h -gt 0) { $alerts += 'KNOWLEDGE_INGESTION_FAILED' }
if ($signals.currentChunksMissingEmbeddings -gt 0) { $alerts += 'KNOWLEDGE_EMBEDDING_GAP' }
if ($signals.currentChunksMissingEmbeddings -eq -1) { $alerts += 'SEMANTIC_SCHEMA_MISSING' }
if ($backupStatus -ne 'fresh') { $alerts += 'BACKUP_NOT_FRESH' }
if ($restoreStatus -ne 'verified') { $alerts += 'RESTORE_REHEARSAL_NOT_VERIFIED' }

$healthStatus = if ($alerts.Count -eq 0) { 'healthy' } else { 'alerting' }
$readinessBlockers = @()
if ([bool]$semanticReadiness.required -and -not [bool]$semanticReadiness.evidenceVerified) {
  $readinessBlockers += [string]$semanticReadiness.reason
}
$status = Resolve-EnterpriseCoreProbeStatus `
  -AlertCount $alerts.Count `
  -SemanticReadiness $semanticReadiness

$result = [ordered]@{
  status = $status
  healthStatus = $healthStatus
  checkedAtUtc = [DateTime]::UtcNow.ToString('o')
  database = $Database
  expectedEmbeddingModel = if ([string]::IsNullOrWhiteSpace($ExpectedEmbeddingModel)) { $null } else { $ExpectedEmbeddingModel }
  semanticReadiness = $semanticReadiness
  signals = $signals
  backupStatus = $backupStatus
  restoreStatus = $restoreStatus
  readinessBlockers = $readinessBlockers
  alerts = $alerts
}
$result | ConvertTo-Json -Depth 5
if ($status -ne 'healthy') { exit 2 }
