import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import {
  createTaskCollaboration,
  getTaskCollaborationDetail,
  getWorkbenchTaskTrace,
  listTaskCollaborationCandidates,
  listTaskCollaborations,
  listTaskCorrections,
  listWorkbenchObjectives,
  listWorkbenchTasks,
  submitTaskCollaborationCommand,
  submitTaskCorrectionFeedback,
} from './api';
import {
  collaborationDetailFixture,
  collaborationFixture,
  correctionFixture,
  interactionId,
  runtimePage,
} from './interaction-test-fixtures';
import { objectiveFixture, taskFixture, workbenchTraceFixture } from './test-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('employee objective and task workbench API', () => {
  it('uses the deployed list routes and exact shared list envelopes', async () => {
    const objective = objectiveFixture();
    const task = taskFixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [objective] }))
      .mockResolvedValueOnce(jsonResponse({ items: [task] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkbenchObjectives(undefined, 'http://127.0.0.1:3000')).resolves.toEqual([
      objective,
    ]);
    await expect(listWorkbenchTasks(undefined, 'http://127.0.0.1:3000')).resolves.toEqual([task]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3000/api/v1/workbench/objectives',
      'http://127.0.0.1:3000/api/v1/workbench/tasks',
    ]);
  });

  it('validates the direct full-chain trace response before exposing it', async () => {
    const trace = workbenchTraceFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(trace));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getWorkbenchTaskTrace(trace.rootTaskId, undefined, 'http://127.0.0.1:3000'),
    ).resolves.toEqual(trace);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${trace.rootTaskId}/trace`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('rejects malformed success bodies instead of substituting sample work', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [{}] })));

    const error = await listWorkbenchTasks(undefined, 'http://127.0.0.1:3000').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ kind: 'contract' });
  });

  it('fails closed when a trace omits a required business-chain segment', async () => {
    const { processDefinitions: _omitted, ...incompleteTrace } = workbenchTraceFixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(incompleteTrace)));

    const error = await getWorkbenchTaskTrace(
      incompleteTrace.rootTaskId,
      undefined,
      'http://127.0.0.1:3000',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ kind: 'contract' });
  });

  it('uses task-scoped collaboration and correction routes with shared page envelopes', async () => {
    const task = taskFixture();
    const collaboration = collaborationFixture();
    const correction = correctionFixture();
    const updatedCorrection = correctionFixture({
      status: 'ACKNOWLEDGED',
      revision: correction.revision + 1,
      updatedAt: '2026-07-28T09:06:00.000Z',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(runtimePage([collaboration])))
      .mockResolvedValueOnce(jsonResponse(collaborationDetailFixture(collaboration)))
      .mockResolvedValueOnce(jsonResponse(runtimePage([correction])))
      .mockResolvedValueOnce(jsonResponse(updatedCorrection));
    vi.stubGlobal('fetch', fetchMock);

    await listTaskCollaborations(task.id, undefined, 'http://127.0.0.1:3000');
    await getTaskCollaborationDetail(task.id, collaboration.id, undefined, 'http://127.0.0.1:3000');
    await listTaskCorrections(task.id, undefined, 'http://127.0.0.1:3000');
    await submitTaskCorrectionFeedback(
      task.id,
      correction.id,
      {
        expectedRevision: correction.revision,
        action: 'ACKNOWLEDGE',
        comment: '已收到纠偏并开始核对。',
        evidenceIds: [],
        effectiveAt: '2026-07-28T09:06:00.000Z',
        idempotencyKey: 'desktop-correction-ack-1',
      },
      'http://127.0.0.1:3000',
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/collaborations`,
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/collaborations/${collaboration.id}`,
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/corrections`,
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/corrections/${correction.id}/feedback`,
    ]);
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(`"expectedRevision":${correction.revision}`),
      }),
    );
  });

  it('creates and advances a collaboration only after contract-confirmed server state', async () => {
    const task = taskFixture();
    const requested = collaborationFixture();
    const committed = collaborationFixture({
      status: 'COMMITTED',
      revision: 2,
      updatedAt: '2026-07-28T09:01:00.000Z',
    });
    const candidates = {
      items: [
        {
          roleAssignmentId: requested.requesterRoleAssignmentId,
          userId: interactionId(221),
          userName: '请求人',
          roleName: '客户成功负责人',
          orgUnitName: '客户成功部',
          canActAsRequester: true,
        },
        {
          roleAssignmentId: requested.recipientRoleAssignmentIds[0],
          userId: interactionId(222),
          userName: '接收人',
          roleName: '数据分析师',
          orgUnitName: '数据部',
          canActAsRequester: false,
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(candidates))
      .mockResolvedValueOnce(jsonResponse(collaborationDetailFixture(requested)))
      .mockResolvedValueOnce(jsonResponse(collaborationDetailFixture(committed)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listTaskCollaborationCandidates(task.id, undefined, 'http://127.0.0.1:3000'),
    ).resolves.toEqual(candidates);
    await expect(
      createTaskCollaboration(
        task.id,
        {
          actingRoleAssignmentId: requested.requesterRoleAssignmentId,
          recipientRoleAssignmentIds: requested.recipientRoleAssignmentIds,
          background: '客户留存指标偏离目标。',
          commonGoal: requested.commonGoal,
          requestedInput: requested.requestedInput,
          expectedOutputSchema: requested.expectedOutputSchema,
          dueAt: requested.dueAt,
          contextRefs: [],
          idempotencyKey: 'desktop-collaboration-create-1',
        },
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({ collaboration: { status: 'REQUESTED', revision: 1 } });
    await expect(
      submitTaskCollaborationCommand(
        task.id,
        requested.id,
        {
          type: 'COMMIT',
          expectedRevision: requested.revision,
          idempotencyKey: 'desktop-collaboration-commit-1',
          payload: {
            committedDueAt: requested.dueAt,
            outputSchema: requested.expectedOutputSchema,
            conditions: [],
          },
        },
        'http://127.0.0.1:3000',
      ),
    ).resolves.toMatchObject({ collaboration: { status: 'COMMITTED', revision: 2 } });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/collaboration-candidates`,
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/collaborations`,
      `http://127.0.0.1:3000/api/v1/workbench/tasks/${task.id}/collaborations/${requested.id}/commands`,
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(`"expectedRevision":${requested.revision}`),
      }),
    );
  });

  it('fails closed when collaboration detail breaks correlation or requested identity', async () => {
    const task = taskFixture();
    const collaboration = collaborationFixture();
    const brokenCorrelation = collaborationDetailFixture(collaboration);
    brokenCorrelation.messages[0] = {
      ...brokenCorrelation.messages[0]!,
      correlationId: interactionId(299),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(brokenCorrelation)));

    const correlationError = await getTaskCollaborationDetail(
      task.id,
      collaboration.id,
      undefined,
      'http://127.0.0.1:3000',
    ).catch((caught: unknown) => caught);
    expect(correlationError).toBeInstanceOf(ApiClientError);
    expect(correlationError).toMatchObject({ kind: 'contract' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(collaborationDetailFixture(collaboration))),
    );
    const identityError = await getTaskCollaborationDetail(
      task.id,
      interactionId(298),
      undefined,
      'http://127.0.0.1:3000',
    ).catch((caught: unknown) => caught);
    expect(identityError).toBeInstanceOf(ApiClientError);
    expect(identityError).toMatchObject({ kind: 'contract' });
  });

  it('does not report correction success when the server returns an unchanged revision', async () => {
    const task = taskFixture();
    const correction = correctionFixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(correction)));

    const error = await submitTaskCorrectionFeedback(
      task.id,
      correction.id,
      {
        expectedRevision: correction.revision,
        action: 'ACKNOWLEDGE',
        comment: '确认收到。',
        evidenceIds: [],
        effectiveAt: '2026-07-28T09:06:00.000Z',
        idempotencyKey: 'desktop-correction-stale-response-1',
      },
      'http://127.0.0.1:3000',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ kind: 'contract' });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
