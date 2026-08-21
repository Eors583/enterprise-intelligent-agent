import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import { listMemories, transitionMemory } from './api';
import { memoryFixture } from './test-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('five-layer memory API', () => {
  it('sends the private-memory purpose to the governed workbench route', async () => {
    const memory = memoryFixture({
      scope: 'EMPLOYEE_PRIVATE',
      status: 'ACTIVE',
      ownerUserId: '10000000-0000-7000-8000-000000000004',
      roleTemplateId: '10000000-0000-7000-8000-000000000005',
      roleVersionId: '10000000-0000-7000-8000-000000000006',
      roleAssignmentId: '10000000-0000-7000-8000-000000000007',
      consent: {
        required: true,
        grantedByUserId: '10000000-0000-7000-8000-000000000004',
        grantedAt: '2026-07-28T00:00:00.000Z',
        purpose: 'Personal assistance',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [memory], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listMemories(
        { scope: 'EMPLOYEE_PRIVATE', purpose: 'Personal assistance' },
        undefined,
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({ items: [memory] });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/v1/workbench/memories?limit=100&scope=EMPLOYEE_PRIVATE&purpose=Personal+assistance',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('rejects records returned outside the requested scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ items: [memoryFixture({ scope: 'ENTERPRISE' })], nextCursor: null }),
        ),
    );

    await expect(
      listMemories({ scope: 'TASK' }, undefined, 'http://127.0.0.1:3000'),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('requires a matching identity and advanced revision after a transition', async () => {
    const memory = memoryFixture({ status: 'ACTIVE', revision: 2 });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(memory));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transitionMemory(
        memory.id,
        {
          expectedRevision: 1,
          action: 'ACTIVATE',
          reason: 'Employee confirmed the governed source.',
          idempotencyKey: 'memory-transition-1',
        },
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({ id: memory.id, revision: 2 });

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:3000/api/v1/workbench/memories/${memory.id}/transitions`,
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
