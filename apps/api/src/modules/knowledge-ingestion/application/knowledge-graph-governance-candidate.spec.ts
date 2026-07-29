import { Prisma } from '@prisma/client';

import { persistKnowledgeGraphProjection } from './knowledge-ingestion.service.js';

const IDENTITY = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
  documentId: '00000000-0000-7000-8000-000000000003',
  documentVersionId: '00000000-0000-7000-8000-000000000004',
  actorUserId: '00000000-0000-7000-8000-000000000005',
} as const;

const SUBJECT_ID = '00000000-0000-7000-8000-000000000101';
const OBJECT_ID = '00000000-0000-7000-8000-000000000102';
const RELATION_ID = '00000000-0000-7000-8000-000000000103';
const ONTOLOGY_VERSION_ID = '00000000-0000-7000-8000-000000000104';
const PREDICATE_ID = '00000000-0000-7000-8000-000000000105';
const CORRECTION_ID = '00000000-0000-7000-8000-000000000106';
const CONFLICT_ID = '00000000-0000-7000-8000-000000000107';

const PROJECTION = {
  entities: [
    {
      key: 'subject',
      entityType: 'POLICY',
      canonicalName: '差旅制度',
      normalizedName: '差旅制度',
      externalKey: null,
      description: null,
      aliases: [],
      attributes: {},
      confidence: 0.9,
    },
    {
      key: 'object',
      entityType: 'SCOPE',
      canonicalName: '全体员工',
      normalizedName: '全体员工',
      externalKey: null,
      description: null,
      aliases: [],
      attributes: {},
      confidence: 0.9,
    },
  ],
  mentions: [],
  relations: [
    {
      key: 'relation',
      subjectEntityKey: 'subject',
      predicate: '适用于',
      normalizedPredicate: 'APPLIES_TO',
      objectEntityKey: 'object',
      confidence: 0.88,
      attributes: {},
      evidence: [],
    },
  ],
} as const;

describe('projected knowledge relation governance', () => {
  it('queues a non-trusted maker/checker correction when a published ontology matches', async () => {
    const transaction = fakeTransaction([
      [{ id: SUBJECT_ID }],
      [{ id: OBJECT_ID }],
      [{ id: RELATION_ID }],
      [],
      [
        {
          ontology_version_id: ONTOLOGY_VERSION_ID,
          predicate_definition_id: PREDICATE_ID,
          relation_created_at: new Date('2026-07-28T00:00:00.000Z'),
          subject_type: 'POLICY',
          object_type: 'SCOPE',
        },
      ],
      [{ id: CORRECTION_ID }],
    ]);

    await persistKnowledgeGraphProjection(transaction.value, IDENTITY, PROJECTION);

    const sql = transaction.querySql.join('\n');
    expect(sql).toContain('INSERT INTO public.knowledge_graph_corrections');
    expect(sql).toContain("'UPSERT_RELATION_VALIDITY'");
    expect(sql).not.toContain('INSERT INTO public.knowledge_relation_governance');
    expect(transaction.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: IDENTITY.actorUserId,
          action: 'admin.knowledge-graph-correction.auto-proposed',
          resourceId: CORRECTION_ID,
        }),
      }),
    );
    expect(transaction.outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aggregateId: CORRECTION_ID,
          payload: expect.objectContaining({ trustedForRetrieval: false }),
        }),
      }),
    );
  });

  it('opens an explicit ontology conflict instead of silently trusting an unmapped edge', async () => {
    const transaction = fakeTransaction([
      [{ id: SUBJECT_ID }],
      [{ id: OBJECT_ID }],
      [{ id: RELATION_ID }],
      [],
      [],
      [{ subject_type: 'POLICY', object_type: 'SCOPE' }],
      [{ id: CONFLICT_ID, revision: 1 }],
    ]);

    await persistKnowledgeGraphProjection(transaction.value, IDENTITY, PROJECTION);

    const sql = transaction.querySql.join('\n');
    expect(sql).toContain('INSERT INTO public.knowledge_graph_conflicts');
    expect(sql).toContain('ONTOLOGY.SCHEMA.GAP');
    expect(sql).toContain('ON CONFLICT (tenant_id, knowledge_base_id, conflict_key)');
    expect(sql).toContain('public.knowledge_graph_conflicts.occurrence_count + 1');
    expect(sql).not.toContain('INSERT INTO public.knowledge_relation_governance');
    expect(transaction.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.knowledge-graph-conflict.auto-detected',
          resourceId: CONFLICT_ID,
        }),
      }),
    );
  });
});

function fakeTransaction(queryResults: readonly unknown[][]) {
  const queue = [...queryResults];
  const querySql: string[] = [];
  const auditCreate = vi.fn().mockResolvedValue({});
  const outboxCreate = vi.fn().mockResolvedValue({});
  const value = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockImplementation((sql: Prisma.Sql) => {
      querySql.push(sql.strings.join(''));
      return Promise.resolve(queue.shift() ?? []);
    }),
    auditEvent: { create: auditCreate },
    outboxEvent: { create: outboxCreate },
  } as unknown as Prisma.TransactionClient;
  return { value, querySql, auditCreate, outboxCreate };
}
