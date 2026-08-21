INSERT INTO public."outbox_event_routes" (
  "event_type", "purpose", "consumer_key", "lane", "description"
)
VALUES
  (
    'knowledge.graph.conflict.created', 'FACT_ONLY', NULL, NULL,
    'Knowledge graph conflict creation fact.'
  ),
  (
    'knowledge.graph.ontology.created', 'FACT_ONLY', NULL, NULL,
    'Knowledge graph ontology creation fact.'
  ),
  (
    'knowledge.graph.ontology_version.created', 'FACT_ONLY', NULL, NULL,
    'Knowledge ontology-version creation fact.'
  ),
  (
    'knowledge.graph.ontology_version.submit', 'FACT_ONLY', NULL, NULL,
    'Knowledge ontology-version submit governance fact.'
  ),
  (
    'knowledge.graph.ontology_version.request_changes', 'FACT_ONLY', NULL, NULL,
    'Knowledge ontology-version request-changes governance fact.'
  ),
  (
    'knowledge.graph.ontology_version.publish', 'FACT_ONLY', NULL, NULL,
    'Knowledge ontology-version publish governance fact.'
  ),
  (
    'knowledge.graph.ontology_version.retire', 'FACT_ONLY', NULL, NULL,
    'Knowledge ontology-version retire governance fact.'
  ),
  (
    'knowledge.graph.correction.created', 'FACT_ONLY', NULL, NULL,
    'Knowledge correction creation fact.'
  ),
  (
    'knowledge.graph.correction.submit', 'FACT_ONLY', NULL, NULL,
    'Knowledge correction submit governance fact.'
  ),
  (
    'knowledge.graph.correction.approve', 'FACT_ONLY', NULL, NULL,
    'Knowledge correction approval governance fact.'
  ),
  (
    'knowledge.graph.correction.reject', 'FACT_ONLY', NULL, NULL,
    'Knowledge correction rejection governance fact.'
  ),
  (
    'knowledge.graph.correction.apply', 'FACT_ONLY', NULL, NULL,
    'Knowledge correction application governance fact.'
  )
ON CONFLICT ("event_type") DO NOTHING;
