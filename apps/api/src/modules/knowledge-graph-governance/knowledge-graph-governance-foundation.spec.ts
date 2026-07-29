import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260728002000_knowledge_graph_governance/migration.sql',
  ),
  'utf8',
);
const service = readFileSync(
  path.join(
    process.cwd(),
    'src/modules/knowledge-graph-governance/knowledge-graph-governance.service.ts',
  ),
  'utf8',
);

describe('knowledge graph governance database foundation', () => {
  it('persists versioned ontology, lineage, conflict, correction and temporal relation evidence', () => {
    for (const table of [
      'knowledge_ontologies',
      'knowledge_ontology_versions',
      'knowledge_ontology_entity_types',
      'knowledge_ontology_predicates',
      'knowledge_graph_corrections',
      'knowledge_graph_conflicts',
      'knowledge_entity_merges',
      'knowledge_entity_aliases',
      'knowledge_entity_source_identities',
      'knowledge_relation_governance',
      'knowledge_graph_commands',
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
    }
  });

  it('enforces ontology maker-checker, CAS and immutable published definitions', () => {
    expect(migration).toContain('reviewed_by_user_id <> created_by_user_id');
    expect(migration).toContain('NEW.revision <> OLD.revision + 1');
    expect(migration).toContain('knowledge_graph_version_transition_guard');
    expect(migration).toContain('knowledge_graph_draft_definition_guard');
    expect(migration).toContain(
      'Ontology definitions are mutable only while their version is DRAFT',
    );
    expect(migration).toContain('knowledge_ontology_versions_one_published_idx');
  });

  it('enforces domain, range, inverse, functional, temporal and self-loop constraints', () => {
    expect(migration).toContain('knowledge_ontology_predicates_domain_fkey');
    expect(migration).toContain('knowledge_ontology_predicates_range_fkey');
    expect(migration).toContain('knowledge_graph_predicate_consistency_guard');
    expect(migration).toContain(
      'Symmetric/inverse Predicate requires a matching reverse assertion',
    );
    expect(migration).toContain('Functional Predicate has overlapping values for the same subject');
    expect(migration).toContain('Relation endpoints violate Predicate domain/range constraints');
    expect(migration).toContain('Predicate does not allow self-loop relations');
    expect(migration).toContain('A non-temporal Predicate cannot declare valid_to');
  });

  it('keeps canonical merge lineage acyclic and excludes unresolved evidence conflicts', () => {
    expect(migration).toContain('Entity merge would create an alias-lineage cycle');
    expect(migration).toContain('knowledge_graph_resolve_canonical_entity');
    expect(migration).toContain('knowledge_graph_retrieval_relations');
    expect(migration).toContain("version.status = 'PUBLISHED'");
    expect(migration).toContain("conflict.status IN ('OPEN', 'IN_REVIEW')");
    expect(migration).toContain('governance.valid_from <= CURRENT_TIMESTAMP');
  });

  it('forces tenant RLS, narrows ACLs and fixes the SECURITY DEFINER search path', () => {
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('AS RESTRICTIVE FOR ALL TO PUBLIC');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO enterprise_agent_app',
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.knowledge_graph_resolve_canonical_entity(UUID, UUID, UUID)',
    );
  });

  it('records idempotency, audit and outbox evidence for each service mutation', () => {
    expect(service).toContain('knowledge_graph_commands');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('transaction.auditEvent.create');
    expect(service).toContain('transaction.outboxEvent.create');
    expect(service).toContain('request_hash');
    expect(service).toContain('idempotency_key');
  });
});
