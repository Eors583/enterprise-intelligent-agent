import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  request: requestMock,
}));

import {
  getBusinessEventDetail,
  getProcessInstanceDetail,
  listBusinessEvents,
  listProcessInstances,
  replayEventDelivery,
  runtimeGovernanceApiPaths,
  sendProcessCommand,
  sendProcessStepCommand,
} from './api';
import {
  deliveryFixture,
  processInstanceFixture,
  processStepFixture,
  runtimeId,
} from './test-fixtures';

describe('admin runtime governance API adapter', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
  });

  it('centralizes the exact process, event, and delivery list routes', async () => {
    const controller = new AbortController();
    await listProcessInstances(controller.signal);
    requestMock.mockResolvedValueOnce({
      instance: processInstanceFixture(),
      steps: [processStepFixture()],
    });
    await getProcessInstanceDetail(runtimeId(1), controller.signal);
    await listBusinessEvents(controller.signal);
    requestMock.mockResolvedValueOnce({
      event: {
        eventId: runtimeId(21),
      },
      deliveries: [],
    });
    await getBusinessEventDetail(runtimeId(21), controller.signal);

    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/process-runtime/instances',
      `/admin/process-runtime/instances/${runtimeId(1)}`,
      '/admin/business-events/events',
      `/admin/business-events/events/${runtimeId(21)}`,
    ]);
    expect(runtimeGovernanceApiPaths.processInstances()).toBe('/admin/process-runtime/instances');
  });

  it('sends revision-bound process and step commands to nested command routes', async () => {
    const instance = processInstanceFixture();
    const step = processStepFixture();
    requestMock
      .mockResolvedValueOnce(
        processInstanceFixture({
          status: 'PAUSED',
          revision: instance.revision + 1,
          pausedAt: '2026-07-28T08:05:00.000Z',
          updatedAt: '2026-07-28T08:05:00.000Z',
        }),
      )
      .mockResolvedValueOnce(
        processStepFixture({
          status: 'COMPLETED',
          revision: step.revision + 1,
          output: { reviewed: true },
          completedAt: '2026-07-28T08:06:00.000Z',
          updatedAt: '2026-07-28T08:06:00.000Z',
        }),
      );

    await sendProcessCommand(instance.id, {
      processInstanceId: instance.id,
      expectedRevision: instance.revision,
      command: 'PAUSE',
      reason: '人工检查运行上下文',
      effectiveAt: '2026-07-28T08:05:00.000Z',
      idempotencyKey: 'admin-process-pause-1',
    });
    await sendProcessStepCommand(instance.id, step.id, {
      stepInstanceId: step.id,
      expectedRevision: step.revision,
      command: 'COMPLETE',
      actorRoleAssignmentId: step.resolvedRoleAssignmentId,
      reason: '步骤输出已人工复核',
      effectiveAt: '2026-07-28T08:06:00.000Z',
      idempotencyKey: 'admin-step-complete-1',
      output: { reviewed: true },
    });

    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      `/admin/process-runtime/instances/${instance.id}/commands`,
      `/admin/process-runtime/instances/${instance.id}/steps/${step.id}/commands`,
    ]);
    expect(requestMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ expectedRevision: instance.revision }),
      }),
    );
  });

  it('replays only an explicitly expected dead-letter state', async () => {
    requestMock.mockResolvedValueOnce(deliveryFixture());
    await replayEventDelivery(runtimeId(31), {
      expectedStatus: 'DEAD_LETTERED',
      reason: '下游规则服务已恢复',
      idempotencyKey: 'admin-dlq-replay-1',
    });

    expect(requestMock).toHaveBeenCalledWith(
      `/admin/business-events/deliveries/${runtimeId(31)}/replay`,
      expect.objectContaining({
        method: 'POST',
        body: {
          expectedStatus: 'DEAD_LETTERED',
          reason: '下游规则服务已恢复',
          idempotencyKey: 'admin-dlq-replay-1',
        },
      }),
    );
  });

  it('attaches strict shared-contract schemas to all successful responses', async () => {
    await listProcessInstances();
    const options = requestMock.mock.calls[0]?.[1];

    expect(
      options.schema.safeParse({
        items: [{}],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(false);
    expect(
      options.schema.safeParse({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false },
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('fails closed on mismatched detail identity or an unadvanced command revision', async () => {
    const instance = processInstanceFixture();
    requestMock.mockResolvedValueOnce({
      instance: processInstanceFixture({ id: runtimeId(99) }),
      steps: [],
    });
    await expect(getProcessInstanceDetail(instance.id)).rejects.toThrow(
      '流程实例详情与请求身份不一致',
    );

    requestMock.mockResolvedValueOnce(instance);
    await expect(
      sendProcessCommand(instance.id, {
        processInstanceId: instance.id,
        expectedRevision: instance.revision,
        command: 'PAUSE',
        reason: '核对并发修订',
        effectiveAt: '2026-07-28T08:05:00.000Z',
        idempotencyKey: 'admin-process-stale-response-1',
      }),
    ).rejects.toThrow('未确认请求实例的新 revision');
  });
});
