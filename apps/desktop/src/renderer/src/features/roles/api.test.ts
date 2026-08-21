import { afterEach, describe, expect, it, vi } from 'vitest';

import { listMyRoleAssignments } from './api';
import { roleAssignmentFixture } from './test-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('my role assignment API', () => {
  it('loads the current employee endpoint and validates the shared response contract', async () => {
    const assignment = roleAssignmentFixture();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [assignment] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMyRoleAssignments(undefined, 'http://localhost:3000')).resolves.toEqual([
      assignment,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/role-assignments/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('rejects a response that does not satisfy the assignment contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [{ id: 'not-a-role' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(listMyRoleAssignments(undefined, 'http://localhost:3000')).rejects.toMatchObject({
      kind: 'contract',
    });
  });

  it('preserves an explicit null snapshot for legacy assignments', async () => {
    const legacyAssignment = {
      ...roleAssignmentFixture(),
      roleDefinitionSnapshot: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [legacyAssignment] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(listMyRoleAssignments(undefined, 'http://localhost:3000')).resolves.toEqual([
      legacyAssignment,
    ]);
  });
});
