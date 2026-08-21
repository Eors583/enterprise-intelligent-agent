import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import {
  createTaskToolCompensation,
  createTaskToolInvocation,
  decideTaskToolInvocation,
  listAvailableTaskTools,
  listTaskToolApprovals,
  listTaskToolInvocations,
} from './api';
import { availableToolFixture, toolFixtureIds, toolInvocationFixture } from './test-fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('employee governed Tool API', () => {
  it('discovers only server-authorized tools for the exact task route', async () => {
    const tool = availableToolFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [tool] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listAvailableTaskTools(toolFixtureIds.task, undefined, 'http://127.0.0.1:3000'),
    ).resolves.toEqual([tool]);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:3000/api/v1/workbench/tools?taskId=${toolFixtureIds.task}`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('keeps another task invocation out of the selected task panel', async () => {
    const current = toolInvocationFixture();
    const other = toolInvocationFixture({
      id: '20000000-0000-7000-8000-000000000001',
      taskId: '20000000-0000-7000-8000-000000000002',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ items: [current, other], nextCursor: null })),
    );

    await expect(
      listTaskToolInvocations(toolFixtureIds.task, undefined, 'http://127.0.0.1:3000'),
    ).resolves.toEqual([current]);
  });

  it('fails closed if the independent approval queue contains another task or state', async () => {
    const pendingApproval = toolInvocationFixture({
      riskClass: 'HIGH_RISK_APPROVAL',
      status: 'PENDING_APPROVAL',
      revision: 3,
      confirmation: {
        confirmedByUserId: toolFixtureIds.user,
        confirmedAt: '2026-07-28T06:01:00.000Z',
        reason: 'Confirmed',
      },
      updatedAt: '2026-07-28T06:01:00.000Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ items: [pendingApproval], nextCursor: null })),
    );
    await expect(
      listTaskToolApprovals(toolFixtureIds.task, undefined, 'http://127.0.0.1:3000'),
    ).resolves.toEqual([pendingApproval]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          items: [{ ...pendingApproval, status: 'APPROVED' }],
          nextCursor: null,
        }),
      ),
    );
    await expect(
      listTaskToolApprovals(toolFixtureIds.task, undefined, 'http://127.0.0.1:3000'),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('rejects a create response whose trusted task identity does not match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          toolInvocationFixture({
            taskId: '20000000-0000-7000-8000-000000000002',
          }),
        ),
      ),
    );

    await expect(
      createTaskToolInvocation(
        {
          toolVersionId: toolFixtureIds.version,
          taskId: toolFixtureIds.task,
          correlationId: toolFixtureIds.correlation,
          dryRun: false,
          input: { customerId: 'customer-1' },
          reason: 'Read the assigned customer.',
          idempotencyKey: 'desktop-tool:create-1',
        },
        'http://127.0.0.1:3000',
      ),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('requires a server-confirmed revision advance for confirmation', async () => {
    const current = toolInvocationFixture();
    const confirmed = toolInvocationFixture({
      status: 'APPROVED',
      revision: 3,
      confirmation: {
        confirmedByUserId: current.requesterUserId,
        confirmedAt: '2026-07-28T06:01:00.000Z',
        reason: 'Confirmed for the current task.',
      },
      updatedAt: '2026-07-28T06:01:00.000Z',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(confirmed)));

    await expect(
      decideTaskToolInvocation(
        toolFixtureIds.task,
        current,
        {
          expectedRevision: current.revision,
          action: 'CONFIRM',
          reason: 'Confirmed for the current task.',
          idempotencyKey: 'desktop-tool:confirm-1',
        },
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({ id: current.id, revision: 3, status: 'APPROVED' });
  });

  it('accepts only a separate compensation invocation bound to the original task', async () => {
    const original = toolInvocationFixture({
      status: 'SUCCEEDED',
      revision: 4,
      output: { customerId: 'customer-1' },
      outputHash: 'b'.repeat(64),
      providerRequestId: 'provider-request-1',
      confirmation: {
        confirmedByUserId: toolFixtureIds.user,
        confirmedAt: '2026-07-28T06:00:30.000Z',
        reason: 'Confirmed exact provider write.',
      },
      startedAt: '2026-07-28T06:01:00.000Z',
      completedAt: '2026-07-28T06:02:00.000Z',
      updatedAt: '2026-07-28T06:02:00.000Z',
    });
    const compensation = toolInvocationFixture({
      id: '20000000-0000-7000-8000-000000000003',
      compensationForInvocationId: original.id,
      causationId: original.id,
      input: { operation: 'COMPENSATE' },
      inputHash: 'd'.repeat(64),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(compensation)));
    await expect(
      createTaskToolCompensation(
        original,
        {
          expectedRevision: original.revision,
          reason: 'Reverse the immutable provider write.',
          idempotencyKey: 'desktop-tool:compensate-1',
        },
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({
      id: compensation.id,
      compensationForInvocationId: original.id,
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
