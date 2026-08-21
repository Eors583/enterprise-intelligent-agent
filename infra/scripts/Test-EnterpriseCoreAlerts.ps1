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

  [string]$BackupDirectory = '',

  [ValidateRange(1, 1440)]
  [int]$QueueAgeMinutes = 5,

  [ValidateRange(1, 1440)]
  [int]$RunAgeMinutes = 10,

  [ValidateRange(1, 1440)]
  [int]$ProcessAgeMinutes = 15,

  [ValidateRange(1, 1440)]
  [int]$ToolAgeMinutes = 10,

  [ValidateRange(1, 168)]
  [int]$BackupMaxAgeHours = 25,

  [ValidateRange(1, 720)]
  [int]$RestoreReportMaxAgeHours = 168,

  [ValidateRange(1, 720)]
  [int]$DisasterRecoveryReportMaxAgeHours = 168,

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
. (Join-Path $PSScriptRoot 'lib\EnterpriseCoreAlertOutboxSql.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupHealth.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterprisePostgresClient.ps1')

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

function Invoke-Scalar {
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
    if ($invocation.ExitCode -ne 0) {
      throw 'Core alert probe could not query PostgreSQL.'
    }
    $result = $invocation.Output
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
    try {
      $result = Invoke-EnterprisePostgresClient `
        -Client $directClient `
        -Tool psql `
        -Arguments $arguments `
        -StandardInput $Sql
    }
    catch {
      throw 'Core alert probe could not query PostgreSQL.'
    }
  }
  if ($null -eq $result) {
    throw 'Core alert probe could not query PostgreSQL.'
  }
  return (($result | Out-String).Trim())
}

function Test-EnterpriseTableExists {
  param([Parameter(Mandatory = $true)][ValidatePattern('^[a-z_][a-z0-9_]*$')][string]$Table)
  return (Invoke-Scalar "SELECT to_regclass('public.$Table') IS NOT NULL;") -eq 't'
}

function Invoke-OptionalScalar {
  param(
    [Parameter(Mandatory = $true)][bool]$Available,
    [Parameter(Mandatory = $true)][string]$Sql,
    [int]$UnavailableValue = -1
  )
  if (-not $Available) { return $UnavailableValue }
  return [int](Invoke-Scalar $Sql)
}

$outboxSignals = (
  Invoke-Scalar (
    Get-EnterpriseCoreAlertOutboxSignalsSql -QueueAgeMinutes $QueueAgeMinutes
  )
) | ConvertFrom-Json
$agentQueuedSignalSql = @"
WITH stale_queued_runs AS (
  SELECT
    ar."tenant_id",
    ar."id"
  FROM public."agent_runs" AS ar
  WHERE ar."status" = 'QUEUED'
    AND ar."created_at" < now() - interval '$QueueAgeMinutes minutes'
), queued_with_active_delivery AS (
  SELECT
    stale_run."tenant_id",
    stale_run."id"
  FROM stale_queued_runs AS stale_run
  JOIN public."outbox_events" AS event
    ON event."tenant_id" = stale_run."tenant_id"
   AND event."aggregate_id" = stale_run."id"
   AND event."event_type" = 'agent.run_requested.v1'
  JOIN public."outbox_event_deliveries" AS delivery
    ON delivery."tenant_id" = event."tenant_id"
   AND delivery."event_id" = event."id"
   AND delivery."consumer_key" = 'agent-run-worker'
   AND delivery."lane" = 'agent.run.execute'
   AND delivery."status" = 'PENDING'::public."OutboxEventStatus"
   AND delivery."available_at" <= now()
)
SELECT json_build_object(
  'agentRunsStaleQueued', count(*) FILTER (WHERE active."id" IS NOT NULL),
  'agentRunsStaleQueuedOrphaned', count(*) FILTER (WHERE active."id" IS NULL),
  'agentRunsStaleQueuedTotal', count(*)
)::text
FROM stale_queued_runs AS stale_run
LEFT JOIN queued_with_active_delivery AS active
  ON active."tenant_id" = stale_run."tenant_id"
  AND active."id" = stale_run."id";
"@

$agentQueuedSignal = (Invoke-Scalar $agentQueuedSignalSql) | ConvertFrom-Json

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

$processRuntimeSchemaAvailable = (
  (Test-EnterpriseTableExists -Table 'process_instances') -and
  (Test-EnterpriseTableExists -Table 'process_step_instances')
)
$toolGatewaySchemaAvailable = (
  (Test-EnterpriseTableExists -Table 'tool_invocations') -and
  (Test-EnterpriseTableExists -Table 'tool_execution_receipts')
)

$signals = [ordered]@{
  outboxPending = [int]$outboxSignals.pending
  outboxFailed = [int]$outboxSignals.failed
  outboxUnknown = [int]$outboxSignals.unknown
  outboxStalePending = [int]$outboxSignals.stalePending
  outboxOldestPendingAgeSeconds = [int]$outboxSignals.oldestPendingAgeSeconds
  outboxQuarantined = [int]$outboxSignals.quarantined
  outboxRoutingIntegrityFailures = [int]$outboxSignals.routingIntegrityFailures
  agentRunsStaleQueued = [int]$agentQueuedSignal.agentRunsStaleQueued
  agentRunsStaleQueuedOrphaned = [int]$agentQueuedSignal.agentRunsStaleQueuedOrphaned
  agentRunsStaleQueuedTotal = [int]$agentQueuedSignal.agentRunsStaleQueuedTotal
  agentRunsStaleActive = [int](Invoke-Scalar $agentActiveSql)
  agentRunsQueued = [int](Invoke-Scalar 'SELECT count(*) FROM public."agent_runs" WHERE status = ''QUEUED'';')
  agentRunsActive = [int](Invoke-Scalar 'SELECT count(*) FROM public."agent_runs" WHERE status IN (''DISPATCHING'', ''RUNNING'');')
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
  processRuntimeSchemaAvailable = if ($processRuntimeSchemaAvailable) { 1 } else { 0 }
  processInstancesStale = Invoke-OptionalScalar `
    -Available $processRuntimeSchemaAvailable `
    -Sql "SELECT count(*) FROM public.`"process_instances`" WHERE status IN ('RUNNING', 'COMPENSATING') AND updated_at < now() - interval '$ProcessAgeMinutes minutes';"
  processStepsOverdue = Invoke-OptionalScalar `
    -Available $processRuntimeSchemaAvailable `
    -Sql "SELECT count(*) FROM public.`"process_step_instances`" WHERE status IN ('READY', 'RUNNING') AND due_at IS NOT NULL AND due_at < now();"
  processStepsFailed24h = Invoke-OptionalScalar `
    -Available $processRuntimeSchemaAvailable `
    -Sql "SELECT count(*) FROM public.`"process_step_instances`" WHERE status IN ('FAILED', 'TIMED_OUT', 'COMPENSATION_FAILED') AND updated_at >= now() - interval '24 hours';"
  toolGatewaySchemaAvailable = if ($toolGatewaySchemaAvailable) { 1 } else { 0 }
  toolInvocationsUnknown = Invoke-OptionalScalar `
    -Available $toolGatewaySchemaAvailable `
    -Sql 'SELECT count(*) FROM public."tool_invocations" WHERE status = ''UNKNOWN'';'
  toolInvocationsStaleExecuting = Invoke-OptionalScalar `
    -Available $toolGatewaySchemaAvailable `
    -Sql "SELECT count(*) FROM public.`"tool_invocations`" WHERE status IN ('EXECUTING', 'COMPENSATING') AND updated_at < now() - interval '$ToolAgeMinutes minutes';"
  toolInvocationsFailed24h = Invoke-OptionalScalar `
    -Available $toolGatewaySchemaAvailable `
    -Sql 'SELECT count(*) FROM public."tool_invocations" WHERE status IN (''FAILED'', ''COMPENSATION_FAILED'') AND completed_at >= now() - interval ''24 hours'';'
  toolExecutionLatencyP95Ms24h = Invoke-OptionalScalar `
    -Available $toolGatewaySchemaAvailable `
    -Sql 'SELECT COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::integer FROM public."tool_execution_receipts" WHERE created_at >= now() - interval ''24 hours'';'
}

$resolvedBackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
$backupContinuity = Get-EnterpriseBackupContinuityStatus `
  -BackupDirectory $resolvedBackupDirectory `
  -Database $Database `
  -BackupMaxAgeHours $BackupMaxAgeHours `
  -RestoreReportMaxAgeHours $RestoreReportMaxAgeHours `
  -DisasterRecoveryReportMaxAgeHours $DisasterRecoveryReportMaxAgeHours
$backupStatus = [string]$backupContinuity.backupStatus
$restoreStatus = [string]$backupContinuity.restoreStatus
$disasterRecoveryStatus = [string]$backupContinuity.disasterRecoveryStatus

$alerts = @()
if ($signals.outboxFailed -gt 0) { $alerts += 'OUTBOX_FAILED' }
if ($signals.outboxUnknown -gt 0) { $alerts += 'OUTBOX_UNKNOWN' }
if ($signals.outboxStalePending -gt 0) { $alerts += 'OUTBOX_STALE' }
if ($signals.outboxQuarantined -gt 0) { $alerts += 'OUTBOX_EVENT_QUARANTINED' }
if ($signals.outboxRoutingIntegrityFailures -gt 0) { $alerts += 'OUTBOX_ROUTING_INTEGRITY' }
if ($signals.agentRunsUnknown -gt 0) { $alerts += 'AGENT_RUN_UNKNOWN' }
if ($signals.agentRunUnverifiedHolds -gt 0) { $alerts += 'AGENT_RUN_USAGE_UNVERIFIED' }
if ($signals.tenantQuotasNearLimit -gt 0) { $alerts += 'TENANT_AGENT_QUOTA_NEAR_LIMIT' }
if ($signals.blockedLoginBuckets -gt 0) { $alerts += 'AUTH_LOGIN_BUCKET_BLOCKED' }
if ($signals.agentRunsStaleQueued -gt 0) { $alerts += 'AGENT_RUN_QUEUE_STALE' }
if ($signals.agentRunsStaleQueuedOrphaned -gt 0) { $alerts += 'AGENT_RUN_QUEUE_ORPHANED' }
if ($signals.agentRunsStaleActive -gt 0) { $alerts += 'AGENT_RUN_ACTIVE_STALE' }
if ($signals.ingestionFailures24h -gt 0) { $alerts += 'KNOWLEDGE_INGESTION_FAILED' }
if ($signals.currentChunksMissingEmbeddings -gt 0) { $alerts += 'KNOWLEDGE_EMBEDDING_GAP' }
if ($signals.currentChunksMissingEmbeddings -eq -1) { $alerts += 'SEMANTIC_SCHEMA_MISSING' }
if ($signals.processRuntimeSchemaAvailable -eq 0) { $alerts += 'PROCESS_RUNTIME_SCHEMA_MISSING' }
if ($signals.processInstancesStale -gt 0) { $alerts += 'PROCESS_INSTANCE_STALE' }
if ($signals.processStepsOverdue -gt 0) { $alerts += 'PROCESS_STEP_OVERDUE' }
if ($signals.processStepsFailed24h -gt 0) { $alerts += 'PROCESS_STEP_FAILED' }
if ($signals.toolGatewaySchemaAvailable -eq 0) { $alerts += 'TOOL_GATEWAY_SCHEMA_MISSING' }
if ($signals.toolInvocationsUnknown -gt 0) { $alerts += 'TOOL_INVOCATION_UNKNOWN' }
if ($signals.toolInvocationsStaleExecuting -gt 0) { $alerts += 'TOOL_INVOCATION_STALE' }
if ($signals.toolInvocationsFailed24h -gt 0) { $alerts += 'TOOL_INVOCATION_FAILED' }
if ($backupStatus -ne 'fresh') { $alerts += 'BACKUP_NOT_FRESH' }
if ($restoreStatus -ne 'verified') { $alerts += 'RESTORE_REHEARSAL_NOT_VERIFIED' }
if ($disasterRecoveryStatus -ne 'verified') { $alerts += 'DISASTER_RECOVERY_OBJECTIVES_NOT_VERIFIED' }

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
  transport = $transportMode
  database = $Database
  expectedEmbeddingModel = if ([string]::IsNullOrWhiteSpace($ExpectedEmbeddingModel)) { $null } else { $ExpectedEmbeddingModel }
  semanticReadiness = $semanticReadiness
  signals = $signals
  backupStatus = $backupStatus
  restoreStatus = $restoreStatus
  disasterRecoveryStatus = $disasterRecoveryStatus
  readinessBlockers = $readinessBlockers
  alerts = $alerts
}
$result | ConvertTo-Json -Depth 5
if ($status -ne 'healthy') { exit 2 }
