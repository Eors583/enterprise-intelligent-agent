import { readFileSync } from 'node:fs';
import path from 'node:path';

const migration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260729002000_knowledge_graph_projection_lifecycle/migration.sql',
  ),
  'utf8',
);
const activationFixMigration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260729002300_knowledge_graph_projection_activation_fix/migration.sql',
  ),
  'utf8',
);
const retrievalAclMigration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260729002400_knowledge_graph_projection_retrieval_acl/migration.sql',
  ),
  'utf8',
);
const aliasRetrievalAclMigration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260729002600_knowledge_graph_alias_retrieval_acl/migration.sql',
  ),
  'utf8',
);
const ingestionService = readFileSync(
  path.join(
    process.cwd(),
    'src/modules/knowledge-ingestion/application/knowledge-ingestion.service.ts',
  ),
  'utf8',
);
const adminService = readFileSync(
  path.join(process.cwd(), 'src/modules/admin/knowledge-admin.service.ts'),
  'utf8',
);

describe('knowledge graph projection migration', () => {
  it('adds an immutable CANDIDATE, ACTIVE and OBSOLETE projection ledger', () => {
    expect(migration).toContain('CREATE TYPE public."KnowledgeGraphProjectionStatus"');
    expect(migration).toContain('CREATE TABLE public."knowledge_graph_projections"');
    expect(migration).toContain('knowledge_graph_projection_lifecycle_guard');
    expect(migration).toContain('knowledge_graph_projections_one_active_document_idx');
    expect(migration).toContain('knowledge_graph_projections_one_candidate_document_idx');
    expect(migration).toContain('Knowledge Graph Projection history cannot be deleted');
  });

  it('binds mentions, evidence and schema gaps to an exact versioned projection', () => {
    expect(migration).toContain('knowledge_entity_mentions_projection_fkey');
    expect(migration).toContain('knowledge_relation_evidence_projection_fkey');
    expect(migration).toContain('knowledge_graph_conflicts_projection_fkey');
    expect(migration).toContain('knowledge_graph_conflicts_schema_gap_idx');
    expect(ingestionService).toContain("'ONTOLOGY.SCHEMA.GAP'");
    expect(ingestionService).toContain('ON CONFLICT (tenant_id, knowledge_base_id, conflict_key)');
  });

  it('allows trusted retrieval only from ACTIVE projections', () => {
    expect(migration).toContain(`active_projection."status" = 'ACTIVE'`);
    expect(migration).toContain(`conflict_projection."status" = 'ACTIVE'`);
  });

  it('keeps projection promotion in the document publication transaction', () => {
    expect(adminService).toContain('activateKnowledgeGraphProjection(transaction');
    expect(adminService).toContain('currentVersionId: version.id');
    expect(ingestionService).toContain(`"status" = 'OBSOLETE'`);
    expect(ingestionService).toContain(`"status" = 'ACTIVE'`);
  });

  it('creates each new knowledge base with an explicit draft ontology', () => {
    expect(adminService).toContain("'SYSTEM_DRAFT'");
    expect(adminService).toContain(`'DRAFT'::"KnowledgeOntologyVersionStatus"`);
    expect(adminService).toContain('system_bootstrap');
    expect(adminService).toContain('draftOntologyVersionId');
  });

  it('forces tenant RLS and exposes only ACTIVE projection state to employee retrieval', () => {
    expect(migration).toContain(
      'ALTER TABLE public."knowledge_graph_projections" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('FROM PUBLIC, enterprise_agent_app, enterprise_agent_admin');
    expect(migration).not.toContain(
      'GRANT SELECT ON TABLE public."knowledge_graph_projections" TO enterprise_agent_app',
    );
    expect(retrievalAclMigration).toContain('FOR SELECT');
    expect(retrievalAclMigration).toContain(
      `USING ("status" = 'ACTIVE'::public."KnowledgeGraphProjectionStatus")`,
    );
    expect(retrievalAclMigration).toContain('ON TABLE public."knowledge_graph_projections"');
    expect(retrievalAclMigration).toContain('TO enterprise_agent_app');
    expect(retrievalAclMigration).toContain('ON TYPE public."KnowledgeGraphProjectionStatus"');
    expect(retrievalAclMigration).toContain('REVOKE INSERT, UPDATE, DELETE');
    expect(aliasRetrievalAclMigration).toContain('FOR SELECT');
    expect(aliasRetrievalAclMigration).toContain('USING ("active")');
    expect(aliasRetrievalAclMigration).toContain('ON TABLE public."knowledge_entity_aliases"');
    expect(aliasRetrievalAclMigration).toContain('REVOKE INSERT, UPDATE, DELETE');
  });

  it('binds manually reported conflicts to exactly one active projection', () => {
    expect(activationFixMigration).toContain('knowledge_graph_conflict_bind_active_projection');
    expect(activationFixMigration).toContain(`projection."status" = 'ACTIVE'`);
    expect(activationFixMigration).toContain(
      'Graph Conflict requires target evidence in one active projection',
    );
    expect(activationFixMigration).toContain(
      'Graph Conflict target is ambiguous across active projections',
    );
    expect(activationFixMigration).toContain('NEW."projection_id" := matched_projection_id');
    expect(activationFixMigration).toContain(
      'NEW."document_version_id" := matched_document_version_id',
    );
  });
});
