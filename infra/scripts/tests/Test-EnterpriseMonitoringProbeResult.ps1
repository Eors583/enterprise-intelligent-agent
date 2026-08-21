$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseMonitoringProbeResult.ps1')

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', received '$Actual'." }
}

$tests = 0
$testTimestamp = [DateTime]::UtcNow.ToString('o')
$healthyServiceOutput = [ordered]@{
  status = 'healthy'
  checkedAtUtc = $testTimestamp
  services = [ordered]@{
    apiLive = [ordered]@{ reachable = $true; ready = $true; httpStatus = 200 }
    apiReady = [ordered]@{ reachable = $true; ready = $true; httpStatus = 200 }
    admin = [ordered]@{ reachable = $true; ready = $true; httpStatus = 200 }
    aiRuntime = [ordered]@{ reachable = $true; ready = $true; httpStatus = 200 }
    aiDependencies = [ordered]@{
      reachable = $true
      httpStatus = 200
      status = 'ready'
      components = [ordered]@{
        run_store = [ordered]@{ status = 'ready'; configured = $true; externalConnectivityVerified = $false; fallbackMode = $null }
        model = [ordered]@{ status = 'ready'; configured = $true; externalConnectivityVerified = $false; fallbackMode = $null }
        embedding = [ordered]@{ status = 'disabled'; configured = $false; externalConnectivityVerified = $false; fallbackMode = 'semantic_retrieval_not_configured' }
        reranker = [ordered]@{ status = 'disabled'; configured = $false; externalConnectivityVerified = $false; fallbackMode = 'hybrid_retrieval_without_rerank' }
      }
    }
  }
  alerts = @()
} | ConvertTo-Json -Compress -Depth 5
$healthy = ConvertFrom-EnterpriseProbeProcessOutput -Output $healthyServiceOutput -ExitCode 0 -ProbeKind Service
Assert-Equal $healthy.status 'healthy' 'A complete healthy service result must pass.'
$tests++

$degradedService = $healthyServiceOutput | ConvertFrom-Json
$degradedService.status = 'alerting'
$degradedService.services.aiRuntime.ready = $false
$degradedService.services.aiRuntime.httpStatus = 503
$degradedService.services.aiDependencies.status = 'degraded'
$degradedService.services.aiDependencies.components.embedding.status = 'degraded'
$degradedService.services.aiDependencies.components.embedding.configured = $true
$degradedService.services.aiDependencies.components.embedding.fallbackMode = 'pause_unsupported_generation_and_use_structured_data'
$degradedService.alerts = @('AI_RUNTIME_READINESS_FAILED', 'AI_EMBEDDING_DEGRADED')
$degraded = ConvertFrom-EnterpriseProbeProcessOutput `
  -Output ($degradedService | ConvertTo-Json -Compress -Depth 8) `
  -ExitCode 2 `
  -ProbeKind Service
Assert-Equal $degraded.status 'alerting' 'An independently degraded embedding provider must remain observable.'
$tests++

$tamperedDegradation = $degradedService | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$tamperedDegradation.alerts = @('AI_RUNTIME_READINESS_FAILED')
$tampered = ConvertFrom-EnterpriseProbeProcessOutput `
  -Output ($tamperedDegradation | ConvertTo-Json -Compress -Depth 8) `
  -ExitCode 2 `
  -ProbeKind Service
Assert-Equal $tampered.alerts[0] 'PROBE_SIGNAL_STATUS_MISMATCH' 'A missing dependency alert must fail closed.'
$tests++

$incompleteHealthy = ConvertFrom-EnterpriseProbeProcessOutput `
  -Output (([ordered]@{ status = 'healthy'; checkedAtUtc = $testTimestamp; alerts = @() }) | ConvertTo-Json -Compress) `
  -ExitCode 0 `
  -ProbeKind Service
Assert-Equal $incompleteHealthy.alerts[0] 'PROBE_SCHEMA_INVALID' 'A status-only response must not impersonate a complete service probe.'
$tests++

$missing = ConvertFrom-EnterpriseProbeProcessOutput -Output '{"status":"healthy"}' -ExitCode 0 -ProbeKind Service
Assert-Equal $missing.alerts[0] 'PROBE_SCHEMA_INVALID' 'Missing alerts must become a deliverable alert.'
$tests++

$invalidJson = ConvertFrom-EnterpriseProbeProcessOutput -Output 'not-json' -ExitCode 0 -ProbeKind Core
Assert-Equal $invalidJson.alerts[0] 'PROBE_OUTPUT_INVALID' 'Invalid JSON must become a deliverable alert.'
$tests++

$execution = ConvertFrom-EnterpriseProbeProcessOutput -Output '' -ExitCode 1 -ProbeKind Core
Assert-Equal $execution.alerts[0] 'PROBE_EXECUTION_FAILED' 'Unexpected child exit must become a deliverable alert.'
$tests++

$mismatch = ConvertFrom-EnterpriseProbeProcessOutput -Output '{"status":"healthy","alerts":[]}' -ExitCode 2 -ProbeKind Core
Assert-Equal $mismatch.alerts[0] 'PROBE_EXIT_STATUS_MISMATCH' 'Status and exit code must agree.'
$tests++

$notReadyOutput = [ordered]@{
  status = 'not_ready'
  healthStatus = 'healthy'
  checkedAtUtc = $testTimestamp
  database = 'acceptance_db'
  semanticReadiness = [ordered]@{
    required = $true
    status = 'insufficient_evidence'
    evidenceVerified = $false
    reason = 'KNOWLEDGE_EMBEDDING_EVIDENCE_EMPTY'
  }
  signals = [ordered]@{
    outboxPending = 0
    outboxFailed = 0
    outboxUnknown = 0
    outboxStalePending = 0
    outboxOldestPendingAgeSeconds = 0
    outboxQuarantined = 0
    outboxRoutingIntegrityFailures = 0
    agentRunsStaleQueued = 0
    agentRunsStaleQueuedOrphaned = 0
    agentRunsStaleQueuedTotal = 0
    agentRunsStaleActive = 0
    agentRunsUnknown = 0
    agentRunUnverifiedHolds = 0
    tenantQuotasNearLimit = 0
    blockedLoginBuckets = 0
    ingestionFailures24h = 0
    currentKnowledgeChunks = 0
    currentChunksWithMatchingEmbeddings = 0
    currentChunksMissingEmbeddings = 0
  }
  backupStatus = 'fresh'
  restoreStatus = 'verified'
  disasterRecoveryStatus = 'verified'
  readinessBlockers = @('KNOWLEDGE_EMBEDDING_EVIDENCE_EMPTY')
  alerts = @()
} | ConvertTo-Json -Compress -Depth 6
$notReady = ConvertFrom-EnterpriseProbeProcessOutput `
  -Output $notReadyOutput `
  -ExitCode 2 `
  -ProbeKind Core
Assert-Equal $notReady.status 'not_ready' 'A readiness blocker is a valid non-healthy core result.'
$tests++

$unexplained = ConvertFrom-EnterpriseProbeProcessOutput -Output '{"status":"alerting","alerts":[]}' -ExitCode 2 -ProbeKind Service
Assert-Equal $unexplained.alerts[0] 'PROBE_STATUS_UNEXPLAINED' 'Unexplained failure must not disappear.'
$tests++

[ordered]@{ status = 'passed'; tests = $tests } | ConvertTo-Json
