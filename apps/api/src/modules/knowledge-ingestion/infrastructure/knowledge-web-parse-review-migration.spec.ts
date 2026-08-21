import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../prisma/migrations/20260728002200_knowledge_web_parse_review/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const sourceTypeMigration = readFileSync(
  new URL(
    '../../../../prisma/migrations/20260728002150_knowledge_web_source_type/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('knowledge web parse-review migration', () => {
  it('commits the WEB enum value before a later migration references it', () => {
    expect(sourceTypeMigration).toContain(`ADD VALUE IF NOT EXISTS 'WEB'`);
    expect(migration).not.toContain(`ADD VALUE IF NOT EXISTS 'WEB'`);
  });

  it('adds web provenance, quality diagnostics and an optimistic review workflow', () => {
    expect(migration).toContain(`CREATE TYPE public."KnowledgeParseReviewStatus"`);
    expect(migration).toContain(`ADD COLUMN "source_uri" TEXT`);
    expect(migration).toContain(`ADD COLUMN "parse_quality_score" NUMERIC(5, 4)`);
    expect(migration).toContain(`ADD COLUMN "parse_review_revision" INTEGER NOT NULL DEFAULT 1`);
    expect(migration).toContain(`ADD COLUMN "parse_diagnostics" JSONB NOT NULL`);
    expect(migration).toContain(`"parse_reviewed_by_id" <> "created_by_id"`);
    expect(migration).toContain(`"parse_review_status" <> 'REJECTED'`);
    expect(migration).toContain(`OR "parse_review_note" IS NOT NULL`);
  });

  it('keeps reviewer identity tenant-scoped and preserves forced RLS with exact role ACLs', () => {
    expect(migration).toContain(`FOREIGN KEY ("tenant_id", "parse_reviewed_by_id")`);
    expect(migration).toContain(`REFERENCES public."users" ("tenant_id", "id")`);
    expect(migration).toContain(
      `ALTER TABLE public."knowledge_document_versions" ENABLE ROW LEVEL SECURITY`,
    );
    expect(migration).toContain(
      `ALTER TABLE public."knowledge_document_versions" FORCE ROW LEVEL SECURITY`,
    );
    expect(migration).toContain(
      `REVOKE ALL ON TABLE public."knowledge_document_versions" FROM PUBLIC`,
    );
    expect(migration).toContain(
      `GRANT SELECT ON TABLE public."knowledge_document_versions" TO enterprise_agent_app`,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\."knowledge_document_versions"\s+TO enterprise_agent_admin;/u,
    );
    expect(migration).not.toContain('DROP POLICY');
    expect(migration).not.toContain('DISABLE ROW LEVEL SECURITY');
  });
});
