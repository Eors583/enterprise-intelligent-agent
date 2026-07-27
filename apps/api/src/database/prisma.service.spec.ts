import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService, REQUIRED_APPLICATION_SCHEMA_COLUMNS } from './prisma.service.js';

interface ReadinessState {
  readonly role: string;
  readonly table_count: number;
  readonly forced_rls_count: number;
  readonly policy_count: number;
  readonly missing_schema_columns: string[];
}

function serviceWithState(state: ReadinessState): {
  readonly service: PrismaService;
  readonly executeRaw: ReturnType<typeof vi.fn>;
  readonly queryRaw: ReturnType<typeof vi.fn>;
  readonly countUsers: ReturnType<typeof vi.fn>;
} {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([state]);
  const countUsers = vi.fn().mockResolvedValue(0);
  const transaction = {
    $executeRawUnsafe: executeRaw,
    $queryRaw: queryRaw,
    user: { count: countUsers },
  };
  const service = Object.create(PrismaService.prototype) as PrismaService;
  Object.defineProperty(service, 'enabled', { value: true });
  Object.defineProperty(service, '$transaction', {
    value: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    ),
  });
  return { service, executeRaw, queryRaw, countUsers };
}

const readyState: ReadinessState = {
  role: 'enterprise_agent_app',
  table_count: 3,
  forced_rls_count: 3,
  policy_count: 3,
  missing_schema_columns: [],
};

describe('PrismaService readiness', () => {
  it('only checks physical table columns present in the generated Prisma schema', () => {
    const physicalColumns = new Set(
      Prisma.dmmf.datamodel.models.flatMap((model) =>
        model.fields
          .filter((field) => field.kind !== 'object')
          .map((field) => `${model.dbName ?? model.name}.${field.dbName ?? field.name}`),
      ),
    );

    expect(
      REQUIRED_APPLICATION_SCHEMA_COLUMNS.filter(
        ({ tableName, columnName }) => !physicalColumns.has(`${tableName}.${columnName}`),
      ),
    ).toEqual([]);
    expect(REQUIRED_APPLICATION_SCHEMA_COLUMNS).toContainEqual({
      tableName: 'org_units',
      columnName: 'status',
    });
  });

  it('accepts a database with the security and application schema baselines', async () => {
    const { service, executeRaw, queryRaw, countUsers } = serviceWithState(readyState);

    await expect(service.ping()).resolves.toBeUndefined();

    expect(executeRaw).toHaveBeenCalledWith('SET LOCAL ROLE enterprise_agent_app');
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(countUsers).toHaveBeenCalledOnce();
  });

  it('rejects a database that is reachable but is missing a required business column', async () => {
    const { service, countUsers } = serviceWithState({
      ...readyState,
      missing_schema_columns: ['knowledge_chunk_embeddings.embedding_model'],
    });

    await expect(service.ping()).rejects.toThrow(
      'Database security or application schema baseline is incomplete.',
    );
    expect(countUsers).not.toHaveBeenCalled();
  });
});
