$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterprisePrometheusMetrics.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$monitoring = [pscustomobject]@{
  status = 'alerting'
  checkedAtUtc = '2026-07-28T00:00:00Z'
  core = [pscustomobject]@{
    status = 'alerting'
    backupStatus = 'fresh'
    restoreStatus = 'verified'
    disasterRecoveryStatus = 'verified'
    signals = [pscustomobject]@{
      outboxPending = 3
      outboxFailed = 2
      outboxStalePending = 1
      outboxUnknown = 0
      outboxOldestPendingAgeSeconds = 75
      outboxQuarantined = 4
      outboxRoutingIntegrityFailures = 5
      agentRunsQueued = 2
      agentRunsActive = 1
      agentRunsStaleQueued = 1
      agentRunsStaleActive = 0
      agentRunsUnknown = 0
      agentRunUnverifiedHolds = 0
      processRuntimeSchemaAvailable = 1
      processInstancesStale = 0
      processStepsOverdue = 1
      processStepsFailed24h = 0
      toolGatewaySchemaAvailable = 1
      toolInvocationsUnknown = 0
      toolInvocationsStaleExecuting = 0
      toolInvocationsFailed24h = 1
      toolExecutionLatencyP95Ms24h = 321
      ingestionFailures24h = 0
      currentKnowledgeChunks = 10
      currentChunksWithMatchingEmbeddings = 9
      currentChunksMissingEmbeddings = 1
    }
  }
  services = [pscustomobject]@{
    services = [pscustomobject]@{
      aiDependencies = [pscustomobject]@{
        status = 'degraded'
        components = [pscustomobject]@{
          run_store = [pscustomobject]@{ status = 'ready'; externalConnectivityVerified = $false }
          model = [pscustomobject]@{ status = 'ready'; externalConnectivityVerified = $false }
          embedding = [pscustomobject]@{ status = 'degraded'; externalConnectivityVerified = $false }
          reranker = [pscustomobject]@{ status = 'disabled'; externalConnectivityVerified = $false }
        }
      }
    }
  }
  alerts = @('CORE::KNOWLEDGE_EMBEDDING_GAP', 'invalid`"label')
}

$metrics = ConvertTo-EnterprisePrometheusMetrics `
  -MonitoringResult $monitoring `
  -UtcNow ([DateTimeOffset]'2026-07-28T00:01:00Z')
Assert-True ($metrics -match 'enterprise_agent_monitoring_snapshot_age_seconds 60') 'Snapshot age metric missing.'
Assert-True ($metrics -match 'enterprise_agent_outbox_events\{state="stale_pending"\} 1') 'Outbox metric missing.'
Assert-True ($metrics -match 'enterprise_agent_outbox_events\{state="failed"\} 2') 'Outbox failed-delivery metric missing.'
Assert-True ($metrics -match 'enterprise_agent_outbox_events\{state="quarantined"\} 4') 'Outbox quarantine metric missing.'
Assert-True ($metrics -match 'enterprise_agent_outbox_events\{state="routing_integrity_failure"\} 5') 'Outbox routing-integrity metric missing.'
Assert-True ($metrics -match 'enterprise_agent_outbox_oldest_pending_age_seconds 75') 'Outbox freshness SLI missing.'
Assert-True ($metrics -match 'enterprise_agent_process_runtime\{signal="overdue_steps"\} 1') 'Process metric missing.'
Assert-True ($metrics -match 'enterprise_agent_tool_gateway\{signal="execution_latency_p95_ms_24h"\} 321') 'Tool latency metric missing.'
Assert-True ($metrics -match 'enterprise_agent_rag\{signal="missing_embeddings"\} 1') 'RAG metric missing.'
Assert-True ($metrics -match 'component="embedding",external_connectivity_verified="false",status="degraded"') 'Embedding degradation metric missing.'
Assert-True ($metrics -match 'code="CORE::KNOWLEDGE_EMBEDDING_GAP"') 'Normalized alert metric missing.'
Assert-True ($metrics -notmatch 'invalid') 'Unbounded alert labels must be rejected.'
Assert-True ($metrics -notmatch 'tenant') 'Exporter must not create tenant-cardinality labels.'

$rulesPath = Join-Path $PSScriptRoot '..\..\observability\prometheus\enterprise-agent-alerts.yml'
$sloRulesPath = Join-Path $PSScriptRoot '..\..\observability\prometheus\enterprise-agent-slo.yml'
$rules = @(
  Get-Content -LiteralPath $rulesPath -Raw -Encoding utf8
  Get-Content -LiteralPath $sloRulesPath -Raw -Encoding utf8
) -join "`n"
foreach ($metricName in @(
  'enterprise_agent_outbox_events',
  'enterprise_agent_outbox_oldest_pending_age_seconds',
  'enterprise_agent_agent_runs',
  'enterprise_agent_process_runtime',
  'enterprise_agent_tool_gateway',
  'enterprise_agent_rag',
  'enterprise_agent_ai_dependency_status',
  'enterprise_agent_backup_fresh',
  'enterprise_agent_restore_rehearsal_verified'
  'enterprise_agent_disaster_recovery_objectives_verified'
)) {
  Assert-True ($rules.Contains($metricName)) "Alert rules do not cover $metricName."
}
Assert-True (-not $rules.Contains('TODO')) 'Prometheus rules must not contain unresolved TODO markers.'
Assert-True ($rules.Contains('EnterpriseAgentAvailabilityFastBurn')) 'Fast-burn SLO alert is missing.'
Assert-True ($rules.Contains('EnterpriseAgentOrdinaryQaLatencySloBreached')) 'Agent Run latency SLO alert is missing.'
Assert-True ($rules.Contains('EnterpriseAgentStructuredQueryLatencySloBreached')) 'Structured-query latency SLO alert is missing.'
Assert-True ($rules.Contains('EnterpriseAgentBusinessEventFreshnessSloBreached')) 'Business-event freshness SLO alert is missing.'

Write-Output 'Enterprise Prometheus metrics tests passed (27 assertions).'
