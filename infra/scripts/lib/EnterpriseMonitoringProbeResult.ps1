function New-EnterpriseProbeFailureResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Alert,
    [int]$ExitCode = -1
  )

  return [ordered]@{
    status = 'probe_failed'
    exitCode = $ExitCode
    alerts = @($Alert)
  }
}

function Test-EnterpriseObjectProperties {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Names
  )

  if ($null -eq $Value -or $Value -is [Array] -or $Value -is [string] -or $Value -is [ValueType]) {
    return $false
  }
  foreach ($name in $Names) {
    if ($null -eq $Value.PSObject.Properties[$name]) { return $false }
  }
  return $true
}

function ConvertFrom-EnterpriseProbeProcessOutput {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Output,
    [Parameter(Mandatory = $true)][int]$ExitCode,
    [Parameter(Mandatory = $true)][ValidateSet('Core', 'Service')][string]$ProbeKind
  )

  if ($ExitCode -notin @(0, 2)) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_EXECUTION_FAILED' -ExitCode $ExitCode
  }
  try {
    $parsed = $Output | ConvertFrom-Json
  }
  catch {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_OUTPUT_INVALID' -ExitCode $ExitCode
  }
  if ($null -eq $parsed -or $parsed -is [Array] -or $parsed -is [string] -or $parsed -is [ValueType]) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_OUTPUT_INVALID' -ExitCode $ExitCode
  }
  $statusProperty = $parsed.PSObject.Properties['status']
  $alertsProperty = $parsed.PSObject.Properties['alerts']
  if ($null -eq $statusProperty -or $null -eq $alertsProperty -or $null -eq $alertsProperty.Value) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
  }

  $allowedStatuses = if ($ProbeKind -eq 'Core') { @('healthy', 'alerting', 'not_ready') } else { @('healthy', 'alerting') }
  $status = [string]$statusProperty.Value
  if ($status -notin $allowedStatuses) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
  }
  [object[]]$alerts = @($alertsProperty.Value)
  foreach ($alert in $alerts) {
    if ($alert -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$alert)) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
  }
  $expectedExitCode = if ($status -eq 'healthy') { 0 } else { 2 }
  if ($ExitCode -ne $expectedExitCode) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_EXIT_STATUS_MISMATCH' -ExitCode $ExitCode
  }

  [object[]]$readinessBlockers = @()
  $readinessProperty = $parsed.PSObject.Properties['readinessBlockers']
  if ($null -ne $readinessProperty -and $null -ne $readinessProperty.Value) {
    $readinessBlockers = @($readinessProperty.Value)
    foreach ($blocker in $readinessBlockers) {
      if ($blocker -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$blocker)) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
    }
  }
  if ($status -ne 'healthy' -and $alerts.Count -eq 0 -and $readinessBlockers.Count -eq 0) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_STATUS_UNEXPLAINED' -ExitCode $ExitCode
  }

  $checkedAtProperty = $parsed.PSObject.Properties['checkedAtUtc']
  if ($null -eq $checkedAtProperty) {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
  }
  try {
    $checkedAt = [DateTimeOffset]::Parse([string]$checkedAtProperty.Value)
    if ($checkedAt.UtcDateTime -gt [DateTime]::UtcNow.AddMinutes(5)) { throw 'future timestamp' }
  }
  catch {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
  }

  if ($ProbeKind -eq 'Service') {
    if (-not (Test-EnterpriseObjectProperties -Value $parsed -Names @('services'))) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    $services = $parsed.services
    $serviceNames = @('apiLive', 'apiReady', 'admin', 'aiRuntime')
    if (-not (Test-EnterpriseObjectProperties -Value $services -Names ($serviceNames + @('aiDependencies')))) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    $expectedServiceAlerts = [ordered]@{
      apiLive = 'API_LIVENESS_FAILED'
      apiReady = 'API_READINESS_FAILED'
      admin = 'ADMIN_HTTP_FAILED'
      aiRuntime = 'AI_RUNTIME_READINESS_FAILED'
    }
    $derivedAlerts = @()
    foreach ($serviceName in $serviceNames) {
      $service = $services.$serviceName
      if (-not (Test-EnterpriseObjectProperties -Value $service -Names @('reachable', 'ready', 'httpStatus'))) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
      if ($service.ready -isnot [bool]) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
      if ($null -ne $service.reachable -and $service.reachable -isnot [bool]) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
      if ($null -ne $service.httpStatus -and $service.httpStatus -isnot [ValueType]) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
      if (-not [bool]$service.ready) { $derivedAlerts += [string]$expectedServiceAlerts[$serviceName] }
    }
    $dependencies = $services.aiDependencies
    if (-not (Test-EnterpriseObjectProperties -Value $dependencies -Names @('reachable', 'httpStatus', 'status', 'components'))) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    if ([string]$dependencies.status -notin @('ready', 'degraded', 'unavailable')) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    if ([string]$dependencies.status -eq 'unavailable') {
      $derivedAlerts += 'AI_RUNTIME_DEPENDENCY_STATUS_UNAVAILABLE'
    }
    else {
      $dependencyAlerts = [ordered]@{
        run_store = 'AI_RUN_STORE_DEGRADED'
        model = 'AI_MODEL_DEGRADED'
        embedding = 'AI_EMBEDDING_DEGRADED'
        reranker = 'AI_RERANKER_DEGRADED'
      }
      if (-not (Test-EnterpriseObjectProperties -Value $dependencies.components -Names @($dependencyAlerts.Keys))) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
      foreach ($componentName in $dependencyAlerts.Keys) {
        $component = $dependencies.components.$componentName
        if (
          -not (Test-EnterpriseObjectProperties -Value $component -Names @('status', 'configured', 'externalConnectivityVerified', 'fallbackMode')) -or
          [string]$component.status -notin @('ready', 'degraded', 'disabled') -or
          $component.configured -isnot [bool] -or
          $component.externalConnectivityVerified -isnot [bool]
        ) {
          return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
        }
        if ([string]$component.status -eq 'degraded') {
          $derivedAlerts += [string]$dependencyAlerts[$componentName]
        }
      }
    }
    $actualAlertFingerprint = @($alerts | Sort-Object) -join "`n"
    $derivedAlertFingerprint = @($derivedAlerts | Sort-Object) -join "`n"
    if ($actualAlertFingerprint -ne $derivedAlertFingerprint) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SIGNAL_STATUS_MISMATCH' -ExitCode $ExitCode
    }
    $derivedStatus = if ($derivedAlerts.Count -eq 0) { 'healthy' } else { 'alerting' }
    if ($status -ne $derivedStatus) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SIGNAL_STATUS_MISMATCH' -ExitCode $ExitCode
    }
  }
  else {
    if (-not (Test-EnterpriseObjectProperties `
      -Value $parsed `
      -Names @('healthStatus', 'database', 'semanticReadiness', 'signals', 'backupStatus', 'restoreStatus', 'disasterRecoveryStatus', 'readinessBlockers'))) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    if ([string]::IsNullOrWhiteSpace([string]$parsed.database)) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    $semantic = $parsed.semanticReadiness
    if (-not (Test-EnterpriseObjectProperties -Value $semantic -Names @('required', 'status', 'evidenceVerified', 'reason')) `
      -or $semantic.required -isnot [bool] `
      -or $semantic.evidenceVerified -isnot [bool] `
      -or [string]$semantic.status -notin @('not_evaluated', 'insufficient_evidence', 'coverage_incomplete', 'schema_missing', 'ready')) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    if (-not (Test-EnterpriseObjectProperties `
      -Value $parsed.signals `
      -Names @(
        'outboxPending', 'outboxFailed', 'outboxUnknown', 'outboxStalePending',
        'outboxOldestPendingAgeSeconds', 'outboxQuarantined',
        'outboxRoutingIntegrityFailures',
        'agentRunsStaleQueued', 'agentRunsStaleActive',
        'agentRunsStaleQueuedOrphaned', 'agentRunsStaleQueuedTotal',
        'agentRunsUnknown', 'agentRunUnverifiedHolds', 'tenantQuotasNearLimit', 'blockedLoginBuckets',
        'ingestionFailures24h', 'currentKnowledgeChunks', 'currentChunksWithMatchingEmbeddings',
        'currentChunksMissingEmbeddings'
      ))) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    foreach ($signalProperty in $parsed.signals.PSObject.Properties) {
      if ($signalProperty.Value -isnot [ValueType]) {
        return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
      }
    }
    if ([string]$parsed.backupStatus -notin @('fresh', 'stale', 'invalid', 'missing') `
      -or [string]$parsed.restoreStatus -notin @('verified', 'stale-or-invalid', 'missing') `
      -or [string]$parsed.disasterRecoveryStatus -notin @('verified', 'stale-or-invalid', 'missing') `
      -or [string]$parsed.healthStatus -notin @('healthy', 'alerting')) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SCHEMA_INVALID' -ExitCode $ExitCode
    }
    $derivedHealthStatus = if ($alerts.Count -eq 0) { 'healthy' } else { 'alerting' }
    $derivedCoreStatus = if ($alerts.Count -gt 0) {
      'alerting'
    }
    elseif ([bool]$semantic.required -and -not [bool]$semantic.evidenceVerified) {
      'not_ready'
    }
    else {
      'healthy'
    }
    if ([string]$parsed.healthStatus -ne $derivedHealthStatus -or $status -ne $derivedCoreStatus) {
      return New-EnterpriseProbeFailureResult -Alert 'PROBE_SIGNAL_STATUS_MISMATCH' -ExitCode $ExitCode
    }
  }
  return $parsed
}
