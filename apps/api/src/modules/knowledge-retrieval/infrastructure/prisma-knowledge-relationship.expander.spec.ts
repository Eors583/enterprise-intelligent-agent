import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { PrismaKnowledgeRelationshipExpander } from './prisma-knowledge-relationship.expander.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const KNOWLEDGE_BASE_ID = '00000000-0000-7000-8000-000000000002';
const SEED_CHUNK_ID = '00000000-0000-7000-8000-000000000003';
const TARGET_CHUNK_ID = '00000000-0000-7000-8000-000000000004';
const SOURCE_ENTITY_ID = '00000000-0000-7000-8000-000000000005';
const MIDDLE_ENTITY_ID = '00000000-0000-7000-8000-000000000006';
const TARGET_ENTITY_ID = '00000000-0000-7000-8000-000000000007';
const FIRST_RELATION_ID = '00000000-0000-7000-8000-000000000008';
const SECOND_RELATION_ID = '00000000-0000-7000-8000-000000000009';

describe('PrismaKnowledgeRelationshipExpander', () => {
  it('returns a complete two-hop path and carries a direct entity seed score', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        chunk_id: TARGET_CHUNK_ID,
        knowledge_base_id: KNOWLEDGE_BASE_ID,
        knowledge_base_name: 'Operations',
        document_id: '00000000-0000-7000-8000-000000000010',
        document_version_id: '00000000-0000-7000-8000-000000000011',
        document_version: 1,
        title: 'Alert system',
        heading_path: ['Dependencies'],
        content: 'The response workflow depends on the alert system.',
        source_type: 'MARKDOWN',
        classification: 'INTERNAL',
        governance_hash: 'a'.repeat(64),
        content_hash: 'b'.repeat(64),
        updated_at: new Date('2026-07-27T00:00:00.000Z'),
        metadata: {},
        resource_policy: {},
        relation_id: SECOND_RELATION_ID,
        relation_type: 'OWNS > DEPENDS_ON',
        source_chunk_id: SEED_CHUNK_ID,
        source_entity_name: 'Security lead',
        target_entity_name: 'Alert system',
        direction: 'OUTBOUND',
        hop_distance: 2,
        confidence: 0.9,
        source_seed_score: 0.96,
        path_relation_ids: [FIRST_RELATION_ID, SECOND_RELATION_ID],
        path_predicates: ['OWNS', 'DEPENDS_ON'],
        path_directions: ['OUTBOUND', 'OUTBOUND'],
        path_entity_ids: [SOURCE_ENTITY_ID, MIDDLE_ENTITY_ID, TARGET_ENTITY_ID],
        path_entity_names: ['Security lead', 'Response workflow', 'Alert system'],
      },
    ]);
    const transaction = { $queryRaw: queryRaw };

    const result = await new PrismaKnowledgeRelationshipExpander().expand(
      transaction as unknown as Prisma.TransactionClient,
      {
        tenantId: TENANT_ID,
        accessibleKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        previewDraftKnowledgeBaseIds: [],
        previewKnowledgeVersionIds: [],
        seedChunkIds: [],
        query: 'security-owner-alias',
        candidateLimit: 2,
        authorizationFilters: unrestrictedFilters(),
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.evidence[0]).toMatchObject({
      relationId: SECOND_RELATION_ID,
      hopDistance: 2,
      sourceSeedScore: 0.96,
      path: [
        {
          relationId: FIRST_RELATION_ID,
          predicate: 'OWNS',
          direction: 'OUTBOUND',
          sourceEntityId: SOURCE_ENTITY_ID,
          sourceEntityName: 'Security lead',
          targetEntityId: MIDDLE_ENTITY_ID,
          targetEntityName: 'Response workflow',
        },
        {
          relationId: SECOND_RELATION_ID,
          predicate: 'DEPENDS_ON',
          direction: 'OUTBOUND',
          sourceEntityId: MIDDLE_ENTITY_ID,
          sourceEntityName: 'Response workflow',
          targetEntityId: TARGET_ENTITY_ID,
          targetEntityName: 'Alert system',
        },
      ],
    });
  });

  it('matches canonical, normalized and alias names and bounds unique targets before evidence rows', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const transaction = { $queryRaw: queryRaw };

    await new PrismaKnowledgeRelationshipExpander().expand(
      transaction as unknown as Prisma.TransactionClient,
      {
        tenantId: TENANT_ID,
        accessibleKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        previewDraftKnowledgeBaseIds: [],
        previewKnowledgeVersionIds: [],
        seedChunkIds: [SEED_CHUNK_ID],
        query: 'response-hub',
        candidateLimit: 3,
        authorizationFilters: unrestrictedFilters(),
      },
    );

    const sql = prismaSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('entity."canonical_name"');
    expect(sql).toContain('entity."normalized_name"');
    expect(sql).toContain('unnest(entity."aliases")');
    expect(sql).toContain('public."knowledge_entity_aliases"');
    expect(sql).toContain('governed_alias."active"');
    expect(sql).toContain('target_priority AS');
    expect(sql).toContain('GROUP BY chunk_id');
    expect(sql).toContain('PARTITION BY candidate.chunk_id');
    expect(sql.indexOf('LIMIT ?')).toBeLessThan(sql.indexOf('PARTITION BY candidate.chunk_id'));
    expect(sql).toContain(`seed_document."current_version_id" = seed_chunk."document_version_id"`);
    expect(sql).toContain(`relation."status" = 'ACTIVE'`);
  });

  it('uses only the exact candidate projection and version during an admin preview', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const transaction = { $queryRaw: queryRaw };
    const candidateVersionId = '00000000-0000-7000-8000-000000000012';

    await new PrismaKnowledgeRelationshipExpander().expand(
      transaction as unknown as Prisma.TransactionClient,
      {
        tenantId: TENANT_ID,
        accessibleKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        previewDraftKnowledgeBaseIds: [KNOWLEDGE_BASE_ID],
        previewKnowledgeVersionIds: [candidateVersionId],
        seedChunkIds: [SEED_CHUNK_ID],
        query: 'response-hub',
        candidateLimit: 3,
        authorizationFilters: unrestrictedFilters(),
      },
    );

    const statement = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    const sql = prismaSqlText(statement);
    expect(sql).toContain(`evidence_projection."status" = 'CANDIDATE'`);
    expect(sql).toContain(`seed_projection."status" = 'CANDIDATE'`);
    expect(sql).toContain(`target_projection."status" = 'CANDIDATE'`);
    expect(sql).toContain('eligible_relations AS');
    expect(sql).not.toContain('knowledge_relation_governance');
    expect(sql).not.toContain(`ontology_version."status" = 'PUBLISHED'`);
    expect(sql).not.toContain('knowledge_graph_retrieval_relations');
    expect(sql).not.toContain(
      `seed_document."current_version_id" = seed_chunk."document_version_id"`,
    );
    expect(statement.values).toContain(candidateVersionId);
  });
});

function prismaSqlText(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('strings' in value) ||
    !Array.isArray(value.strings)
  ) {
    return '';
  }
  return value.strings.join('?');
}

function unrestrictedFilters() {
  return {
    assignmentOrganizationScoped: false,
    organizationIds: [],
    includeOrganizationDescendants: false,
    projectIds: [],
    taskIds: [],
    roleTemplateIds: [],
    principalDataLabels: [],
  } as const;
}
