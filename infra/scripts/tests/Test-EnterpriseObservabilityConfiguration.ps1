$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$collectorPath = Join-Path $repositoryRoot 'infra\observability\otel-collector.production.example.yaml'
$sloPath = Join-Path $repositoryRoot 'infra\observability\prometheus\enterprise-agent-slo.yml'
$collector = Get-Content -LiteralPath $collectorPath -Raw -Encoding utf8
$slo = Get-Content -LiteralPath $sloPath -Raw -Encoding utf8

foreach ($requiredCollectorFragment in @(
  'receivers:',
  'otlp:',
  'processors:',
  'memory_limiter:',
  'attributes/sanitize:',
  'batch:',
  'prometheus:',
  'otlphttp/traces:',
  'resource_to_telemetry_conversion:',
  'translation_strategy: UnderscoreEscapingWithSuffixes',
  'bearertokenauth/ingest:',
  'auth:',
  'authenticator: bearertokenauth/ingest',
  'readers:',
  'exporters: [prometheus]',
  'exporters: [otlphttp/traces]'
)) {
  Assert-True ($collector.Contains($requiredCollectorFragment)) "Collector config is missing '$requiredCollectorFragment'."
}

foreach ($secretName in @(
  'OTEL_COLLECTOR_TLS_CERT_FILE',
  'OTEL_COLLECTOR_TLS_KEY_FILE',
  'OTEL_TRACE_BACKEND_AUTHORIZATION'
)) {
  Assert-True ($collector.Contains('${env:' + $secretName + '}')) "Collector config must inject $secretName through the environment provider."
}

Assert-True (-not ($collector -match '(?im)^\s*(password|api[_-]?key|secret|token)\s*:\s*[^$]')) 'Collector config must not contain an inline credential.'
Assert-True (-not $collector.Contains('insecure_skip_verify')) 'Collector config must not disable TLS verification.'
Assert-True ($collector.Contains('${env:OTEL_COLLECTOR_INGEST_TOKEN_FILE}')) 'Collector ingest token must come from a mounted secret file.'

foreach ($requiredSloFragment in @(
  'availability-99.9',
  'ordinary-qa-p95-8s',
  'structured-query-p95-3s',
  'business-event-freshness-60s',
  '14.4 * 0.001',
  '6 * 0.001',
  'enterprise_agent_run_duration_seconds_bucket',
  'enterprise_agent_run_time_to_first_token_seconds_bucket',
  'enterprise_agent_outbox_oldest_pending_age_seconds'
)) {
  Assert-True ($slo.Contains($requiredSloFragment)) "SLO rules are missing '$requiredSloFragment'."
}

Assert-True (-not $slo.Contains('tenant_id')) 'SLO rules must not introduce tenant-cardinality labels.'
Assert-True (-not $slo.Contains('run_id')) 'SLO rules must not introduce run-cardinality labels.'
Assert-True (-not $slo.Contains('TODO')) 'SLO rules must not contain unresolved TODO markers.'

Write-Output 'Enterprise observability configuration tests passed.'
