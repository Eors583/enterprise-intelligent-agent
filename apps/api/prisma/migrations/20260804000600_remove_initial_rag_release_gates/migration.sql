-- Initial RAG verification must not depend on ontology publication or conflict review.
-- Keep tenant, active-record, evidence and active-projection constraints, while making
-- governance metadata optional diagnostics instead of a relationship retrieval gate.
CREATE OR REPLACE VIEW public."knowledge_graph_retrieval_relations"
WITH (security_barrier = true)
AS
SELECT
  relation."id",
  relation."tenant_id",
  relation."knowledge_base_id",
  public.knowledge_graph_resolve_canonical_entity(
    relation."tenant_id",
    relation."knowledge_base_id",
    relation."subject_entity_id"
  ) AS "subject_entity_id",
  public.knowledge_graph_resolve_canonical_entity(
    relation."tenant_id",
    relation."knowledge_base_id",
    relation."object_entity_id"
  ) AS "object_entity_id",
  relation."predicate",
  relation."normalized_predicate",
  relation."attributes",
  relation."confidence",
  relation."status",
  governance."valid_from",
  governance."valid_to",
  governance."ontology_version_id",
  governance."predicate_definition_id"
FROM public."knowledge_relations" relation
LEFT JOIN public."knowledge_relation_governance" governance
  ON governance."tenant_id" = relation."tenant_id"
 AND governance."knowledge_base_id" = relation."knowledge_base_id"
 AND governance."relation_id" = relation."id"
JOIN public."knowledge_entities" subject
  ON subject."tenant_id" = relation."tenant_id"
 AND subject."knowledge_base_id" = relation."knowledge_base_id"
 AND subject."id" = public.knowledge_graph_resolve_canonical_entity(
    relation."tenant_id",
    relation."knowledge_base_id",
    relation."subject_entity_id"
 )
 AND subject."status" = 'ACTIVE'
JOIN public."knowledge_entities" object
  ON object."tenant_id" = relation."tenant_id"
 AND object."knowledge_base_id" = relation."knowledge_base_id"
 AND object."id" = public.knowledge_graph_resolve_canonical_entity(
    relation."tenant_id",
    relation."knowledge_base_id",
    relation."object_entity_id"
 )
 AND object."status" = 'ACTIVE'
WHERE relation."tenant_id" =
    NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND relation."status" = 'ACTIVE'
  AND EXISTS (
    SELECT 1
    FROM public."knowledge_relation_evidence" active_evidence
    JOIN public."knowledge_graph_projections" active_projection
      ON active_projection."tenant_id" = active_evidence."tenant_id"
     AND active_projection."knowledge_base_id" = active_evidence."knowledge_base_id"
     AND active_projection."id" = active_evidence."projection_id"
     AND active_projection."status" = 'ACTIVE'
    WHERE active_evidence."tenant_id" = relation."tenant_id"
      AND active_evidence."knowledge_base_id" = relation."knowledge_base_id"
      AND active_evidence."relation_id" = relation."id"
  );

REVOKE ALL ON TABLE public."knowledge_graph_retrieval_relations" FROM PUBLIC;
GRANT SELECT ON TABLE public."knowledge_graph_retrieval_relations"
  TO enterprise_agent_app, enterprise_agent_admin;
