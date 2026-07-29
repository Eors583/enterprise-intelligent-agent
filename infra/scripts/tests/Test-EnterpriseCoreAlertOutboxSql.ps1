$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseCoreAlertOutboxSql.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$tests = 0
$sql = Get-EnterpriseCoreAlertOutboxSignalsSql -QueueAgeMinutes 7

Assert-True (
  $sql.Contains('FROM public."outbox_event_deliveries" AS delivery')
) 'Operational Outbox signals must come from consumer delivery records.'
Assert-True (
  $sql.Contains('JOIN public."outbox_event_routes" AS route')
) 'Operational Outbox signals must be joined to the route registry.'
Assert-True (
  $sql.Contains("route.`"purpose`" = 'DELIVERY'::public.`"OutboxEventRoutingPurpose`"")
) 'Only event types registered for delivery may contribute to delivery backlog signals.'
Assert-True (
  $sql.Contains('route."consumer_key" = delivery."consumer_key"')
) 'Delivery signals must bind the exact registered consumer.'
Assert-True (
  $sql.Contains('route."lane" = delivery."lane"')
) 'Delivery signals must bind the exact registered lane.'
Assert-True (
  $sql.Contains("route.`"purpose`" = 'FACT_ONLY'::public.`"OutboxEventRoutingPurpose`"")
) 'The integrity probe must explicitly recognize fact-only routes.'
Assert-True (
  $sql.Contains('AND EXISTS (')
) 'Unexpected delivery rows for fact-only facts must be detected as routing corruption.'
Assert-True (
  $sql.Contains("event.`"routing_purpose`" = 'QUARANTINED'::public.`"OutboxEventRoutingPurpose`"")
) 'Explicitly quarantined events must be reported.'
Assert-True (
  $sql.Contains('route."event_type" IS NULL')
) 'Unregistered event types must be reported instead of silently ignored.'
Assert-True (
  $sql.Contains('AND NOT EXISTS (')
) 'A registered delivery event missing its exact delivery row must fail the integrity probe.'
Assert-True (
  $sql.Contains("delivery.`"status`" = 'UNKNOWN'::public.`"OutboxEventStatus`"")
) 'UNKNOWN must be counted from immutable-event consumer delivery evidence.'
Assert-True (
  $sql.Contains("delivery.`"available_at`" < now() - interval '7 minutes'")
) 'The stale-delivery threshold must use the validated queue-age setting.'
Assert-True (
  $sql.Contains('delivery."locked_until" < now()')
) 'A stale signal must require an absent or expired delivery lease.'
Assert-True (
  -not ($sql -match 'event\."status"\s*=')
) 'Immutable domain-event status must not be used as consumer delivery state.'
Assert-True (
  -not ($sql -match 'event\."attempts"|event\."locked_until"|event\."last_error"|event\."published_at"')
) 'The probe must not read legacy mutable delivery columns from domain events.'
$tests += 15

$invalidThresholdRejected = $false
try {
  Get-EnterpriseCoreAlertOutboxSignalsSql -QueueAgeMinutes 0 | Out-Null
}
catch {
  $invalidThresholdRejected = $true
}
Assert-True $invalidThresholdRejected 'An invalid queue-age threshold must fail before SQL is constructed.'
$tests++

$probePath = Join-Path $PSScriptRoot '..\Test-EnterpriseCoreAlerts.ps1'
$probeSource = Get-Content -LiteralPath $probePath -Raw -Encoding utf8
Assert-True (
  $probeSource.Contains("lib\EnterpriseCoreAlertOutboxSql.ps1")
) 'The production probe must load the reviewed Outbox SQL builder.'
Assert-True (
  $probeSource.Contains('Get-EnterpriseCoreAlertOutboxSignalsSql -QueueAgeMinutes $QueueAgeMinutes')
) 'The production probe must use the delivery-aware Outbox snapshot.'
Assert-True (
  -not ($probeSource -match 'SELECT count\(\*\) FROM public\."outbox_events" WHERE status')
) 'The production probe must not fall back to mutable event delivery state.'
Assert-True (
  $probeSource.Contains("if (`$signals.outboxQuarantined -gt 0) { `$alerts += 'OUTBOX_EVENT_QUARANTINED' }")
) 'Quarantined or unregistered events must produce an operator-visible alert.'
Assert-True (
  $probeSource.Contains("if (`$signals.outboxRoutingIntegrityFailures -gt 0) { `$alerts += 'OUTBOX_ROUTING_INTEGRITY' }")
) 'Broken delivery routing invariants must produce an operator-visible alert.'
$tests += 5

[ordered]@{ status = 'passed'; tests = $tests } | ConvertTo-Json
