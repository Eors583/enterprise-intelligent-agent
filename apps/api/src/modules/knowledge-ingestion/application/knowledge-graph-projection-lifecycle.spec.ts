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
  it('atomically retires the old active projection and activates the candidate', async () => {
    const transaction = fakeTransaction([[{ id: PROJECTION_ID, graph_hash: GRAPH_HASH }]]);

    await expect(activateKnowledgeGraphProjection(transaction.value, IDENTITY)).resolves.toEqual({
      projectionId: PROJECTION_ID,
      graphHash: GRAPH_HASH,
    });

    const queries = transaction.querySql.join('\n');
    const mutations = transaction.executeSql.join('\n');
    expect(queries).toContain(`"status" = 'CANDIDATE'`);
    expect(queries).toContain('FOR UPDATE');
    expect(mutations).toContain(`"status" = 'OBSOLETE'`);
    expect(mutations).toContain(`"status" = 'ACTIVE'`);
    expect(mutations.indexOf(`"status" = 'OBSOLETE'`)).toBeLessThan(
      mutations.indexOf(`"status" = 'ACTIVE'`),
    );
  });

  it('returns null without mutations when the document version has no candidate projection', async () => {
    const transaction = fakeTransaction([[]]);

    await expect(activateKnowledgeGraphProjection(transaction.value, IDENTITY)).resolves.toBeNull();
    expect(transaction.executeSql).toHaveLength(0);
  });

  it('refuses ambiguous activation when a document version has multiple candidate projections', async () => {
    const transaction = fakeTransaction([
      [
        { id: PROJECTION_ID, graph_hash: GRAPH_HASH },
        {
          id: '00000000-0000-7000-8000-000000000006',
          graph_hash: 'b'.repeat(64),
        },
      ],
    ]);

    await expect(
      activateKnowledgeGraphProjection(transaction.value, IDENTITY),
    ).rejects.toBeInstanceOf(ConflictException);
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
