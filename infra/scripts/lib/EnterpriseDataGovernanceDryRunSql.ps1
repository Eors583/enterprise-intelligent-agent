function Get-EnterpriseDataGovernanceDryRunSql {
  [CmdletBinding()]
  param()

  return @'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL app.tenant_id = :'tenant_id';

WITH
outbox_observation AS (
  SELECT
    count(*) FILTER (
      WHERE route."event_type" IS NULL
         OR event."routing_purpose"::text = 'QUARANTINED'
    )::integer AS quarantined_or_unregistered_events,
    count(*) FILTER (
      WHERE route."purpose"::text = 'FACT_ONLY'
        AND event."routing_purpose"::text IS DISTINCT FROM 'FACT_ONLY'
    )::integer AS fact_only_mapping_candidates,
    count(*) FILTER (
      WHERE route."purpose"::text = 'DELIVERY'
        AND delivery."id" IS NULL
    )::integer AS missing_delivery_candidates
  FROM public."outbox_events" AS event
  LEFT JOIN public."outbox_event_routes" AS route
    ON route."event_type" = event."event_type"
  LEFT JOIN public."outbox_event_deliveries" AS delivery
    ON delivery."tenant_id" = event."tenant_id"
   AND delivery."event_id" = event."id"
   AND delivery."consumer_key" = route."consumer_key"
  WHERE event."tenant_id" = :'tenant_id'::uuid
),
usage_observation AS (
  SELECT
    count(*) FILTER (
      WHERE run."status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
        AND run."token_evidence"::text = 'UNREPORTED'
        AND run."reserved_tokens" > 0
    )::integer AS terminal_upper_bound_candidates,
    count(*) FILTER (
      WHERE run."status"::text = 'UNKNOWN'
        AND (
          run."reserved_tokens" > 0
          OR run."token_evidence"::text = 'UNREPORTED'
        )
    )::integer AS unknown_runs_preserving_holds,
    count(*) FILTER (
      WHERE run."token_evidence"::text = 'QUOTA_UPPER_BOUND'
        AND (
          run."quota_charged_tokens" <= 0
          OR run."reserved_tokens" <> 0
          OR run."quota_settled_at" IS NULL
        )
    )::integer AS invalid_upper_bound_settlements
  FROM public."agent_runs" AS run
  WHERE run."tenant_id" = :'tenant_id'::uuid
),
schema_gap_instances AS (
  SELECT
    conflict."projection_id",
    conflict."conflict_type",
    coalesce(conflict."schema_predicate", 'UNKNOWN') AS predicate,
    coalesce(conflict."schema_subject_type", 'UNKNOWN') AS subject_type,
    coalesce(conflict."schema_object_type", 'UNKNOWN') AS object_type,
    conflict."occurrence_count"
  FROM public."knowledge_graph_conflicts" AS conflict
  JOIN public."knowledge_graph_projections" AS projection
    ON projection."tenant_id" = conflict."tenant_id"
   AND projection."knowledge_base_id" = conflict."knowledge_base_id"
   AND projection."id" = conflict."projection_id"
  WHERE conflict."tenant_id" = :'tenant_id'::uuid
    AND conflict."status"::text IN ('OPEN', 'IN_REVIEW')
    AND conflict."conflict_type" = 'ONTOLOGY.MAPPING.MISSING'
    AND projection."status"::text <> 'OBSOLETE'
),
schema_gap_observation AS (
  SELECT
    coalesce(sum(occurrence_count), 0)::integer AS instance_conflicts,
    count(*)::integer AS aggregate_schema_gap_rows,
    count(
      DISTINCT ROW(projection_id, conflict_type, predicate, subject_type, object_type)
    )::integer
      AS aggregate_schema_gaps
  FROM schema_gap_instances
),
candidate_version_observation AS (
  SELECT
    count(*)::integer AS non_current_ready_versions,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM public."knowledge_entity_mentions" AS mention
        WHERE mention."tenant_id" = version."tenant_id"
          AND mention."document_version_id" = version."id"
      )
      OR EXISTS (
        SELECT 1
        FROM public."knowledge_relation_evidence" AS evidence
        WHERE evidence."tenant_id" = version."tenant_id"
          AND evidence."document_version_id" = version."id"
      )
    )::integer AS non_current_versions_with_graph_evidence
  FROM public."knowledge_document_versions" AS version
  JOIN public."knowledge_documents" AS document
    ON document."tenant_id" = version."tenant_id"
   AND document."id" = version."document_id"
  WHERE version."tenant_id" = :'tenant_id'::uuid
    AND version."status"::text = 'READY'
    AND document."current_version_id" IS DISTINCT FROM version."id"
),
projection_capabilities AS (
  SELECT
    count(*)::integer AS lifecycle_column_count
  FROM information_schema.columns AS column_info
  WHERE column_info."table_schema" = 'public'
    AND column_info."table_name" = 'knowledge_graph_projections'
    AND column_info."column_name" IN ('status', 'document_version_id')
),
schema_gap_capabilities AS (
  SELECT
    count(*)::integer AS aggregate_column_count
  FROM information_schema.columns AS column_info
  WHERE column_info."table_schema" = 'public'
    AND column_info."table_name" = 'knowledge_graph_conflicts'
    AND column_info."column_name" IN (
      'projection_id',
      'schema_predicate',
      'schema_subject_type',
      'schema_object_type',
      'occurrence_count'
    )
)
SELECT jsonb_pretty(
  jsonb_build_object(
    'mode', 'READ_ONLY_DRY_RUN',
    'database', current_database(),
    'tenantId', :'tenant_id',
    'transactionReadOnly', current_setting('transaction_read_only') = 'on',
    'mutationsPerformed', 0,
    'historyDeleted', false,
    'applySupported', false,
    'auditEventsRequiredForApply', true,
    'outbox', jsonb_build_object(
      'quarantinedOrUnregisteredEvents', outbox.quarantined_or_unregistered_events,
      'factOnlyMappingCandidates', outbox.fact_only_mapping_candidates,
      'missingDeliveryCandidates', outbox.missing_delivery_candidates
    ),
    'usage', jsonb_build_object(
      'terminalUpperBoundCandidates', usage.terminal_upper_bound_candidates,
      'unknownRunsPreservingHolds', usage.unknown_runs_preserving_holds,
      'invalidUpperBoundSettlements', usage.invalid_upper_bound_settlements
    ),
    'schemaGap', jsonb_build_object(
      'instanceConflicts', schema_gap.instance_conflicts,
      'aggregateSchemaGapRows', schema_gap.aggregate_schema_gap_rows,
      'aggregateSchemaGaps', schema_gap.aggregate_schema_gaps,
      'aggregationCapabilityColumnCount', gap_capability.aggregate_column_count
    ),
    'candidateProjection', jsonb_build_object(
      'nonCurrentReadyVersions', candidate.non_current_ready_versions,
      'nonCurrentVersionsWithGraphEvidence',
        candidate.non_current_versions_with_graph_evidence,
      'lifecycleCapabilityColumnCount', projection.lifecycle_column_count
    ),
    'nextGate', CASE
      WHEN projection.lifecycle_column_count <> 2
        OR gap_capability.aggregate_column_count <> 5
      THEN 'BLOCKED_SCHEMA_CAPABILITY_NOT_INSTALLED'
      ELSE 'READY_FOR_REVIEWED_REPAIR_IMPLEMENTATION'
    END,
    'requiredApplyControls', jsonb_build_array(
      'backup hash and restore report verified',
      'isolated rehearsal completed before source repair',
      'explicit tenant and actor scope',
      'append-only audit event for each repair category',
      'no DELETE, TRUNCATE, event cloning, or blind replay',
      'UNKNOWN runs retain reservations until trusted reconciliation',
      'single transaction or resumable idempotent command with before/after counts'
    )
  )
)::text
FROM outbox_observation AS outbox
CROSS JOIN usage_observation AS usage
CROSS JOIN schema_gap_observation AS schema_gap
CROSS JOIN candidate_version_observation AS candidate
CROSS JOIN projection_capabilities AS projection
CROSS JOIN schema_gap_capabilities AS gap_capability;

ROLLBACK;
'@
}
