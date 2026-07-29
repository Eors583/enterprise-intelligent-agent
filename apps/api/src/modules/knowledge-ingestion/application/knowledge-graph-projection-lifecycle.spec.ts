import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { activateKnowledgeGraphProjection } from './knowledge-ingestion.service.js';

const IDENTITY = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  knowledgeBaseId: '00000000-0000-7000-8000-000000000002',
  documentId: '00000000-0000-7000-8000-000000000003',
  documentVersionId: '00000000-0000-7000-8000-000000000004',
} as const;

const PROJECTION_ID = '00000000-0000-7000-8000-000000000005';
const GRAPH_HASH = 'a'.repeat(64);

describe('knowledge graph projection publication lifecycle', () => {
  it('atomically retires the old active projection and activates the governed candidate', async () => {
    const transaction = fakeTransaction([
      [{ id: PROJECTION_ID, graph_hash: GRAPH_HASH }],
      [{ open_schema_gap_count: 0, ungoverned_relation_count: 0 }],
    ]);

    await expect(activateKnowledgeGraphProjection(transaction.value, IDENTITY)).resolves.toEqual({
      projectionId: PROJECTION_ID,
      graphHash: GRAPH_HASH,
    });

    const queries = transaction.querySql.join('\n');
    const mutations = transaction.executeSql.join('\n');
    expect(queries).toContain(`"status" = 'CANDIDATE'`);
    expect(queries).toContain('FOR UPDATE');
    expect(queries).toContain('open_schema_gap_count');
    expect(queries).toContain('ungoverned_relation_count');
    expect(mutations).toContain(`"status" = 'OBSOLETE'`);
    expect(mutations).toContain(`"status" = 'ACTIVE'`);
    expect(mutations.indexOf(`"status" = 'OBSOLETE'`)).toBeLessThan(
      mutations.indexOf(`"status" = 'ACTIVE'`),
    );
  });

  it('refuses to activate a candidate with an open projection-bound schema gap', async () => {
    const transaction = fakeTransaction([
      [{ id: PROJECTION_ID, graph_hash: GRAPH_HASH }],
      [{ open_schema_gap_count: 1, ungoverned_relation_count: 0 }],
    ]);

    await expect(
      activateKnowledgeGraphProjection(transaction.value, IDENTITY),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.executeSql).toHaveLength(0);
  });

  it('refuses to activate extracted relations before independent ontology governance', async () => {
    const transaction = fakeTransaction([
      [{ id: PROJECTION_ID, graph_hash: GRAPH_HASH }],
      [{ open_schema_gap_count: 0, ungoverned_relation_count: 2 }],
    ]);

    await expect(activateKnowledgeGraphProjection(transaction.value, IDENTITY)).rejects.toThrow(
      'independently approved ontology governance',
    );
    expect(transaction.executeSql).toHaveLength(0);
  });
});

function fakeTransaction(queryResults: readonly unknown[][]) {
  const queue = [...queryResults];
  const querySql: string[] = [];
  const executeSql: string[] = [];
  const value = {
    $queryRaw: vi.fn().mockImplementation((sql: Prisma.Sql) => {
      querySql.push(sql.strings.join(''));
      return Promise.resolve(queue.shift() ?? []);
    }),
    $executeRaw: vi.fn().mockImplementation((sql: Prisma.Sql) => {
      executeSql.push(sql.strings.join(''));
      return Promise.resolve(1);
    }),
  } as unknown as Prisma.TransactionClient;
  return { value, querySql, executeSql };
}
