function Get-EnterpriseCoreAlertOutboxSignalsSql {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 1440)]
    [int]$QueueAgeMinutes
  )

  return @"
WITH registered_deliveries AS (
  SELECT
    delivery."status",
    delivery."available_at",
    delivery."locked_until",
    event."created_at" AS event_created_at
  FROM public."outbox_event_deliveries" AS delivery
  JOIN public."outbox_events" AS event
    ON event."tenant_id" = delivery."tenant_id"
   AND event."id" = delivery."event_id"
  JOIN public."outbox_event_routes" AS route
    ON route."event_type" = event."event_type"
   AND route."purpose" = 'DELIVERY'::public."OutboxEventRoutingPurpose"
   AND route."consumer_key" = delivery."consumer_key"
   AND route."lane" = delivery."lane"
),
event_route_issues AS (
  SELECT event."id"
  FROM public."outbox_events" AS event
  LEFT JOIN public."outbox_event_routes" AS route
    ON route."event_type" = event."event_type"
  WHERE
    (
      route."event_type" IS NOT NULL
      AND event."routing_purpose" IS DISTINCT FROM route."purpose"
    )
    OR (
      route."purpose" = 'DELIVERY'::public."OutboxEventRoutingPurpose"
      AND NOT EXISTS (
        SELECT 1
        FROM public."outbox_event_deliveries" AS required_delivery
        WHERE required_delivery."tenant_id" = event."tenant_id"
          AND required_delivery."event_id" = event."id"
          AND required_delivery."consumer_key" = route."consumer_key"
          AND required_delivery."lane" = route."lane"
      )
    )
    OR (
      route."purpose" = 'FACT_ONLY'::public."OutboxEventRoutingPurpose"
      AND EXISTS (
        SELECT 1
        FROM public."outbox_event_deliveries" AS unexpected_delivery
        WHERE unexpected_delivery."tenant_id" = event."tenant_id"
          AND unexpected_delivery."event_id" = event."id"
      )
    )
),
delivery_route_issues AS (
  SELECT delivery."id"
  FROM public."outbox_event_deliveries" AS delivery
  JOIN public."outbox_events" AS event
    ON event."tenant_id" = delivery."tenant_id"
   AND event."id" = delivery."event_id"
  LEFT JOIN public."outbox_event_routes" AS route
    ON route."event_type" = event."event_type"
   AND route."purpose" = 'DELIVERY'::public."OutboxEventRoutingPurpose"
   AND route."consumer_key" = delivery."consumer_key"
   AND route."lane" = delivery."lane"
  WHERE route."event_type" IS NULL
),
quarantined_events AS (
  SELECT event."id"
  FROM public."outbox_events" AS event
  LEFT JOIN public."outbox_event_routes" AS route
    ON route."event_type" = event."event_type"
  WHERE route."event_type" IS NULL
     OR event."routing_purpose" = 'QUARANTINED'::public."OutboxEventRoutingPurpose"
     OR event."routing_error" IS NOT NULL
)
SELECT json_build_object(
  'pending', count(*) FILTER (
    WHERE delivery."status" = 'PENDING'::public."OutboxEventStatus"
  ),
  'failed', count(*) FILTER (
    WHERE delivery."status" = 'FAILED'::public."OutboxEventStatus"
  ),
  'unknown', count(*) FILTER (
    WHERE delivery."status" = 'UNKNOWN'::public."OutboxEventStatus"
  ),
  'stalePending', count(*) FILTER (
    WHERE delivery."status" = 'PENDING'::public."OutboxEventStatus"
      AND delivery."available_at" < now() - interval '$QueueAgeMinutes minutes'
      AND (
        delivery."locked_until" IS NULL
        OR delivery."locked_until" < now()
      )
  ),
  'oldestPendingAgeSeconds', COALESCE(
    floor(EXTRACT(EPOCH FROM (
      now() - min(delivery.event_created_at) FILTER (
        WHERE delivery."status" = 'PENDING'::public."OutboxEventStatus"
      )
    )))::integer,
    0
  ),
  'quarantined', (SELECT count(*) FROM quarantined_events),
  'routingIntegrityFailures',
    (SELECT count(*) FROM event_route_issues)
    + (SELECT count(*) FROM delivery_route_issues)
)::text
FROM registered_deliveries AS delivery;
"@
}
