import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ExperienceCandidate } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { renderExperienceKnowledge } from './infrastructure/prisma/prisma-experience-knowledge-projection.adapter.js';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260728002800_experience_knowledge_projection/migration.sql',
  ),
  'utf8',
);
const adapter = readFileSync(
  resolve(
    process.cwd(),
    'src/modules/memory-experience/infrastructure/prisma/prisma-experience-knowledge-projection.adapter.ts',
  ),
  'utf8',
);

describe('Experience Knowledge projection', () => {
  it('renders only reviewed structured content and stable provenance into Knowledge markdown', () => {
    const content = renderExperienceKnowledge(
      {
        id: '00000000-0000-7000-8000-000000000001',
        title: 'RAW PRIVATE TITLE MUST NOT LEAK',
        sourceTaskId: '00000000-0000-7000-8000-000000000002',
        contributorUserId: '00000000-0000-7000-8000-000000000003',
        candidateSummary: 'RAW PRIVATE INPUT MUST NOT LEAK',
        structuredContent: {
          scenario: 'A governed enterprise handoff.',
          problem: 'Acceptance evidence was previously ambiguous.',
          steps: ['Define acceptance criteria.', 'Seal the evidence.'],
          preconditions: ['A versioned task exists.'],
          counterexamples: ['Chat acknowledgement is not acceptance.'],
          risks: ['Unsealed evidence can be changed.'],
          outcomes: ['The handoff is auditable.'],
          applicabilityBoundaries: ['Only governed delivery tasks.'],
        },
      } as ExperienceCandidate,
      'Reliable handoff',
    );

    expect(content).toContain('# Reliable handoff');
    expect(content).toContain('## 步骤');
    expect(content).toContain('Seal the evidence.');
    expect(content).toContain('Only governed delivery tasks.');
    expect(content).not.toContain('RAW PRIVATE INPUT MUST NOT LEAK');
    expect(content).not.toContain('RAW PRIVATE TITLE MUST NOT LEAK');
  });

  it('installs a tenant-isolated, idempotent projection ledger and exact Knowledge identity', () => {
    expect(migration).toContain('CREATE TABLE public."experience_knowledge_projections"');
    expect(migration).toContain('"experience_knowledge_projections_experience_key"');
    expect(migration).toContain('"experience_knowledge_projections_idempotency_key"');
    expect(migration).toContain('"experience_knowledge_projections_document_version_fkey"');
    expect(migration).toContain(
      'ALTER TABLE public."experience_knowledge_projections" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('CREATE POLICY "tenant_isolation"');
    expect(migration).toContain('EXPERIENCE_PROJECTION_CREATION_NOT_AUTHORIZED');
    expect(migration).toContain('EXPERIENCE_PROJECTION_IDENTITY_IMMUTABLE');
  });

  it('requires chunks plus embeddings, exact publication and retrieval-stopping retirement', () => {
    expect(migration).toContain('public."knowledge_chunk_embeddings"');
    expect(migration).toContain('EXPERIENCE_PROJECTION_KNOWLEDGE_NOT_READY');
    expect(migration).toContain('EXPERIENCE_PROJECTION_KNOWLEDGE_SCOPE_MISMATCH');
    expect(migration).toContain(
      'btrim(version."checksum"::text) =\n          btrim(NEW."publication_hash"::text)',
    );
    expect(migration).toContain('version."evaluation_run_id" IS NOT NULL');
    expect(migration).toContain('payload_shape_valid IS DISTINCT FROM true');
    expect(migration).toContain("command_payload ->> 'knowledgeBaseId' IS DISTINCT FROM");
    expect(migration).toContain(
      'version."governance_owner_user_id" = candidate_record."contributor_user_id"',
    );
    expect(migration).toContain('projection_record."status" <> \'PUBLISHED\'');
    expect(migration).toContain('experience_publication_projection_completeness');
    expect(migration).toContain('target_role_template_ids');
    expect(migration).toContain('target_org_unit_ids');
    expect(migration).toContain('document."status" = \'READY\'');
    expect(migration).toContain('version."status" = \'READY\'');
    expect(migration).toContain('CREATE TRIGGER "experience_candidates_retire_knowledge_trigger"');
    expect(migration).toContain('SET "status" = \'ARCHIVED\'');
  });

  it('records durable audit and Outbox evidence for preparation, materialization, failure and reconciliation', () => {
    expect(adapter).toContain('experience.knowledge-projection.preparation-requested.v1');
    expect(adapter).toContain('experience.knowledge-projection.materialized.v1');
    expect(adapter).toContain('experience.knowledge-projection.failed.v1');
    expect(adapter).toContain('experience.knowledge-projection.status-changed.v1');
    expect(adapter).toContain('transaction.auditEvent.create');
    expect(adapter).toContain('transaction.outboxEvent.create');
  });
});
