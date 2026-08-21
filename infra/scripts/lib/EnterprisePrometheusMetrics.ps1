function ConvertTo-EnterprisePrometheusMetrics {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$MonitoringResult,
    [DateTimeOffset]$UtcNow = [DateTimeOffset]::UtcNow
  )

  if ($null -eq $MonitoringResult.core -or $null -eq $MonitoringResult.services) {
    throw 'Monitoring result must contain core and services probe results.'
  }
  $signals = $MonitoringResult.core.signals
  if ($null -eq $signals) { throw 'Monitoring result is missing core signals.' }

  $lines = [System.Collections.Generic.List[string]]::new()
  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_monitoring_snapshot_timestamp_seconds' -Help 'Unix timestamp of the monitoring snapshot.' -Type 'gauge'
  $checkedAt = [DateTimeOffset]::Parse([string]$MonitoringResult.checkedAtUtc)
  $lines.Add("enterprise_agent_monitoring_snapshot_timestamp_seconds $($checkedAt.ToUnixTimeSeconds())")
  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_monitoring_snapshot_age_seconds' -Help 'Age of the monitoring snapshot when exported.' -Type 'gauge'
  $snapshotAge = [Math]::Max(0, [Math]::Round(($UtcNow - $checkedAt).TotalSeconds))
  $lines.Add("enterprise_agent_monitoring_snapshot_age_seconds $snapshotAge")
  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_core_probe_healthy' -Help 'Whether the database and continuity core probe is healthy.' -Type 'gauge'
  $lines.Add("enterprise_agent_core_probe_healthy $(ConvertTo-EnterpriseBooleanMetric ([string]$MonitoringResult.core.status -eq 'healthy'))")

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_outbox_events' -Help 'Outbox operational state counters.' -Type 'gauge'
  Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_outbox_events' -Labels @{ state = 'pending' } -Value (Get-EnterpriseNumericSignal $signals 'outboxPending')
  Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_outbox_events' -Labels @{ state = 'failed' } -Value (Get-EnterpriseNumericSignal $signals 'outboxFailed')
  Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_outbox_events' -Labels @{ state = 'stale_pending' } -Value (Get-EnterpriseNumericSignal $signals 'outboxStalePending')
  Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_outbox_events' -Labels @{ state = 'unknown' } -Value (Get-EnterpriseNumericSignal $signals 'outboxUnknown')
  Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_outbox_events' -Labels @{ state = 'quarantined' } -Value (Get-EnterpriseNumericSignal $signals 'outboxQuarantined')
  Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_outbox_events' -Labels @{ state = 'routing_integrity_failure' } -Value (Get-EnterpriseNumericSignal $signals 'outboxRoutingIntegrityFailures')
  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_outbox_oldest_pending_age_seconds' -Help 'Age in seconds of the oldest pending business event; zero when the outbox is empty.' -Type 'gauge'
  $lines.Add("enterprise_agent_outbox_oldest_pending_age_seconds $(Get-EnterpriseNumericSignal $signals 'outboxOldestPendingAgeSeconds')")

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_agent_runs' -Help 'Agent Run operational state counters.' -Type 'gauge'
  $agentRunSignals = [ordered]@{
    queued = 'agentRunsQueued'
    active = 'agentRunsActive'
    stale_queued = 'agentRunsStaleQueued'
    stale_active = 'agentRunsStaleActive'
    unknown = 'agentRunsUnknown'
    unverified_usage = 'agentRunUnverifiedHolds'
  }
  foreach ($entry in $agentRunSignals.GetEnumerator()) {
    Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_agent_runs' -Labels @{ state = $entry.Key } -Value (Get-EnterpriseNumericSignal $signals $entry.Value)
  }

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_process_runtime' -Help 'Process runtime schema and exception signals.' -Type 'gauge'
  $processSignals = [ordered]@{
    schema_available = 'processRuntimeSchemaAvailable'
    stale_instances = 'processInstancesStale'
    overdue_steps = 'processStepsOverdue'
    failed_steps_24h = 'processStepsFailed24h'
  }
  foreach ($entry in $processSignals.GetEnumerator()) {
    Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_process_runtime' -Labels @{ signal = $entry.Key } -Value (Get-EnterpriseNumericSignal $signals $entry.Value)
  }

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_tool_gateway' -Help 'Tool Gateway schema, state, and failure signals.' -Type 'gauge'
  $toolSignals = [ordered]@{
    schema_available = 'toolGatewaySchemaAvailable'
    unknown = 'toolInvocationsUnknown'
    stale_executing = 'toolInvocationsStaleExecuting'
    failed_24h = 'toolInvocationsFailed24h'
    execution_latency_p95_ms_24h = 'toolExecutionLatencyP95Ms24h'
  }
  foreach ($entry in $toolSignals.GetEnumerator()) {
    Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_tool_gateway' -Labels @{ signal = $entry.Key } -Value (Get-EnterpriseNumericSignal $signals $entry.Value)
  }

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_rag' -Help 'RAG ingestion and semantic index readiness signals.' -Type 'gauge'
  $ragSignals = [ordered]@{
    ingestion_failures_24h = 'ingestionFailures24h'
    current_chunks = 'currentKnowledgeChunks'
    matching_embeddings = 'currentChunksWithMatchingEmbeddings'
    missing_embeddings = 'currentChunksMissingEmbeddings'
  }
  foreach ($entry in $ragSignals.GetEnumerator()) {
    Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_rag' -Labels @{ signal = $entry.Key } -Value (Get-EnterpriseNumericSignal $signals $entry.Value)
  }

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_backup_fresh' -Help 'Whether the latest protected backup is within its freshness objective.' -Type 'gauge'
  $lines.Add("enterprise_agent_backup_fresh $(ConvertTo-EnterpriseBooleanMetric ([string]$MonitoringResult.core.backupStatus -eq 'fresh'))")
  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_restore_rehearsal_verified' -Help 'Whether the latest isolated restore rehearsal report is verified and fresh.' -Type 'gauge'
  $lines.Add("enterprise_agent_restore_rehearsal_verified $(ConvertTo-EnterpriseBooleanMetric ([string]$MonitoringResult.core.restoreStatus -eq 'verified'))")
  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_disaster_recovery_objectives_verified' -Help 'Whether a fresh isolated database rehearsal met its configured RPO and RTO contract.' -Type 'gauge'
  $lines.Add("enterprise_agent_disaster_recovery_objectives_verified $(ConvertTo-EnterpriseBooleanMetric ([string]$MonitoringResult.core.disasterRecoveryStatus -eq 'verified'))")

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_ai_dependency_status' -Help 'Independent AI dependency status; exactly one status sample per component is 1.' -Type 'gauge'
  $dependencies = $MonitoringResult.services.services.aiDependencies
  if ($null -eq $dependencies -or [string]$dependencies.status -eq 'unavailable') {
    foreach ($componentName in @('run_store', 'model', 'embedding', 'reranker')) {
      Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_ai_dependency_status' -Labels @{ component = $componentName; status = 'unavailable'; external_connectivity_verified = 'false' } -Value 1
    }
  }
  else {
    foreach ($componentName in @('run_store', 'model', 'embedding', 'reranker')) {
      $component = $dependencies.components.$componentName
      Add-EnterpriseLabeledMetric `
        -Lines $lines `
        -Name 'enterprise_agent_ai_dependency_status' `
        -Labels @{
          component = $componentName
          status = [string]$component.status
          external_connectivity_verified = ([bool]$component.externalConnectivityVerified).ToString().ToLowerInvariant()
        } `
        -Value 1
    }
  }

  Add-EnterpriseMetricFamily -Lines $lines -Name 'enterprise_agent_alert_active' -Help 'Active normalized monitoring alerts by bounded alert code.' -Type 'gauge'
  foreach ($alert in @($MonitoringResult.alerts | Sort-Object -Unique)) {
    if ([string]$alert -match '^[A-Z][A-Z0-9_:]{1,127}$') {
      Add-EnterpriseLabeledMetric -Lines $lines -Name 'enterprise_agent_alert_active' -Labels @{ code = [string]$alert } -Value 1
    }
  }

  return (($lines -join "`n") + "`n")
}

function Get-EnterpriseNumericSignal {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Signals,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $property = $Signals.PSObject.Properties[$Name]
  if ($null -eq $property -or $property.Value -isnot [ValueType]) { return -1 }
  return [double]$property.Value
}

function Add-EnterpriseMetricFamily {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Lines,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9_]*$')][string]$Name,
    [Parameter(Mandatory = $true)][string]$Help,
    [Parameter(Mandatory = $true)][ValidateSet('gauge', 'counter')][string]$Type
  )
  $Lines.Add("# HELP $Name $Help")
  $Lines.Add("# TYPE $Name $Type")
}

function Add-EnterpriseLabeledMetric {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Lines,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Labels,
    [Parameter(Mandatory = $true)][double]$Value
  )

  $renderedLabels = @(
    foreach ($key in @($Labels.Keys | Sort-Object)) {
      $labelValue = ([string]$Labels[$key]).Replace('\', '\\').Replace("`n", '\n').Replace('"', '\"')
      "$key=`"$labelValue`""
    }
  ) -join ','
  $Lines.Add("$Name{$renderedLabels} $Value")
}

function ConvertTo-EnterpriseBooleanMetric {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][bool]$Value)
  if ($Value) { return 1 }
  return 0
}
