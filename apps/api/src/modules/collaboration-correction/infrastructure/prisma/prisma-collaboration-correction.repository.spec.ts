import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../../database/prisma.service.js';
import type { AuthorizedRuntimeTaskScope } from '../../collaboration-correction-authorization.port.js';
import { PrismaCollaborationCorrectionRepository } from './prisma-collaboration-correction.repository.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const TASK_ID = '00000000-0000-7000-8000-000000000003';

describe('PrismaCollaborationCorrectionRepository authorization filters', () => {
  it('keeps label scopes separated instead of authorizing their union', async () => {
    const { repository, queries } = repositoryFixture();

    await repository.listCorrections(
      scope({
        permissionLabelScopes: [['finance'], ['customer']],
        permissionLabels: ['customer', 'finance'],
      }),
      { cursor: null, limit: 100 },
    );

    expect(queries).toHaveLength(1);
    const query = sql(queries[0]);
    expect(query.text).toContain('"permission_labels" <@');
    expect(query.text).toContain(' OR ');
    expect(query.values).toContain(JSON.stringify(['finance']));
    expect(query.values).toContain(JSON.stringify(['customer']));
    expect(query.values).not.toContain(JSON.stringify(['customer', 'finance']));
  });

  it('uses an explicit fail-closed predicate when no employee grant exists', async () => {
    const { repository, queries } = repositoryFixture();

    await repository.listCorrections(
      scope({
        permissionLabelScopes: [],
        permissionLabels: [],
      }),
      { cursor: null, limit: 100 },
    );

    expect(sql(queries[0]).text).toContain('AND false');
  });

  it('allows the trusted management bypass without synthesizing label grants', async () => {
    const { repository, queries } = repositoryFixture();

    await repository.listCorrections(
      scope({
        managementBypass: true,
        permissionLabelScopes: [],
        permissionLabels: [],
      }),
      { cursor: null, limit: 100 },
    );

    const query = sql(queries[0]);
    expect(query.text).toContain('AND true');
    expect(query.text).not.toContain('"permission_labels" <@');
  });
});

function repositoryFixture(): {
  readonly repository: PrismaCollaborationCorrectionRepository;
  readonly queries: unknown[];
} {
  const queries: unknown[] = [];
  const transaction = {
    $queryRaw: vi.fn(async (query: unknown) => {
      queries.push(query);
      return [];
    }),
  };
  const prisma = {
    withTenant: vi.fn(
      async (_tenantId: string, operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  return {
    repository: new PrismaCollaborationCorrectionRepository(prisma as unknown as PrismaService),
    queries,
  };
}

function scope(overrides: Partial<AuthorizedRuntimeTaskScope> = {}): AuthorizedRuntimeTaskScope {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    taskId: TASK_ID,
    decisionId: 'decision-runtime-task-read',
    managementBypass: false,
    roleAssignmentIds: [],
    organizationIds: [],
    projectIds: [],
    permissionLabelScopes: [['internal']],
    permissionLabels: ['internal'],
    ...overrides,
  };
}

function sql(value: unknown): {
  readonly text: string;
  readonly values: readonly unknown[];
} {
  const query = value as {
    readonly strings: readonly string[];
    readonly values: readonly unknown[];
  };
  return {
    text: query.strings.join('?'),
    values: query.values,
  };
}
