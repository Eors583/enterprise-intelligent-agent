import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../shared/api/client';
import {
  contributeEmployeeEvidence,
  getEmployeeTaskExecution,
  requestEmployeeAcceptance,
  submitEmployeeDeliverable,
  transitionEmployeeTask,
} from './api';
import {
  employeeTaskExecutionFixture,
  executionAssignmentId,
  executionDeliverableFixture,
  executionDeliverableId,
  executionEvidenceFixture,
} from './employee-task-execution-test-fixtures';

const apiBaseUrl = 'http://127.0.0.1:3000';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('employee task execution API', () => {
  it('loads only a contract-valid snapshot for the requested Task identity', async () => {
    const snapshot = employeeTaskExecutionFixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(snapshot)));

    await expect(
      getEmployeeTaskExecution(snapshot.task.id, undefined, apiBaseUrl),
    ).resolves.toEqual(snapshot);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...snapshot,
          task: {
            ...snapshot.task,
            id: '00000000-0000-7000-8000-000000000099',
          },
        }),
      ),
    );
    await expect(
      getEmployeeTaskExecution(snapshot.task.id, undefined, apiBaseUrl),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('reports a transition only after the server returns its exact new status and revision', async () => {
    const snapshot = employeeTaskExecutionFixture();
    const request = {
      expectedRevision: snapshot.task.revision,
      action: 'START' as const,
      roleAssignmentId: executionAssignmentId,
      reason: 'Start the assigned real task.',
      effectiveAt: '2026-07-28T08:00:00.000Z',
    };
    const updated = {
      ...snapshot.task,
      status: 'IN_PROGRESS' as const,
      revision: snapshot.task.revision + 1,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    await expect(transitionEmployeeTask(snapshot.task.id, request, apiBaseUrl)).resolves.toEqual(
      updated,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBaseUrl}/api/v1/workbench/tasks/${snapshot.task.id}/execution/task-transitions`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify(request),
      }),
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(snapshot.task)));
    await expect(
      transitionEmployeeTask(snapshot.task.id, request, apiBaseUrl),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('uses task-scoped Deliverable, Evidence and Acceptance routes with strict responses', async () => {
    const snapshot = employeeTaskExecutionFixture();
    const submittedAt = '2026-07-28T08:10:00.000Z';
    const deliverable = executionDeliverableFixture({
      taskId: snapshot.task.id,
      status: 'SUBMITTED',
      revision: 2,
      submittedAt,
      artifactUri: 'https://artifacts.example.test/result',
      contentHash: 'b'.repeat(64),
    });
    const evidence = executionEvidenceFixture({
      code: 'EVIDENCE.NEW.RESULT',
      status: 'DRAFT',
      trustLevel: 'UNVERIFIED',
      confidence: 0.5,
      verifiedBy: null,
      verifiedAt: null,
      sourceRecordId: 'new-result',
      contentHash: 'c'.repeat(64),
    });
    const acceptance = {
      id: '00000000-0000-7000-8000-000000000210',
      tenantId: snapshot.task.tenantId,
      taskId: snapshot.task.id,
      taskVersion: snapshot.task.version,
      deliverableId: executionDeliverableId,
      deliverableVersion: deliverable.version,
      requestedByUserId: '00000000-0000-7000-8000-000000000211',
      requestedByRoleAssignmentId: executionAssignmentId,
      status: 'REQUESTED' as const,
      revision: 1,
      reason: 'Ready for independent acceptance.',
      dueAt: '2026-08-01T00:00:00.000Z',
      requestedAt: submittedAt,
      acceptanceId: null,
      acceptanceVersion: null,
      decisionComment: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(deliverable))
      .mockResolvedValueOnce(jsonResponse(evidence))
      .mockResolvedValueOnce(jsonResponse(acceptance));
    vi.stubGlobal('fetch', fetchMock);

    await submitEmployeeDeliverable(
      snapshot.task.id,
      executionDeliverableId,
      {
        expectedRevision: 1,
        roleAssignmentId: executionAssignmentId,
        submittedAt,
        artifactUri: deliverable.artifactUri!,
        contentHash: deliverable.contentHash!,
        evidenceIds: [snapshot.evidence[0]!.id],
      },
      apiBaseUrl,
    );
    await contributeEmployeeEvidence(
      snapshot.task.id,
      {
        roleAssignmentId: executionAssignmentId,
        code: evidence.code,
        sourceType: evidence.sourceType as 'DOCUMENT',
        sourceSystem: evidence.sourceSystem,
        sourceRecordId: evidence.sourceRecordId,
        sourceVersion: evidence.sourceVersion,
        sourceUri: evidence.sourceUri,
        observedAt: evidence.observedAt,
        contentHash: evidence.contentHash,
        summary: evidence.summary,
        effectiveFrom: evidence.effectiveFrom,
        effectiveTo: evidence.effectiveTo,
        permissionLabels: evidence.permissionLabels,
      },
      apiBaseUrl,
    );
    await requestEmployeeAcceptance(
      snapshot.task.id,
      executionDeliverableId,
      {
        expectedDeliverableRevision: deliverable.revision,
        roleAssignmentId: executionAssignmentId,
        reason: acceptance.reason,
        dueAt: acceptance.dueAt,
      },
      apiBaseUrl,
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${apiBaseUrl}/api/v1/workbench/tasks/${snapshot.task.id}/execution/deliverables/${executionDeliverableId}/submit`,
      `${apiBaseUrl}/api/v1/workbench/tasks/${snapshot.task.id}/execution/evidence`,
      `${apiBaseUrl}/api/v1/workbench/tasks/${snapshot.task.id}/execution/deliverables/${executionDeliverableId}/acceptance-requests`,
    ]);
  });

  it('rejects a forged Evidence success that is already active or verified', async () => {
    const snapshot = employeeTaskExecutionFixture();
    const active = executionEvidenceFixture({
      code: 'EVIDENCE.NEW.RESULT',
      sourceRecordId: 'new-result',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(active)));

    const error = await contributeEmployeeEvidence(
      snapshot.task.id,
      {
        roleAssignmentId: executionAssignmentId,
        code: active.code,
        sourceType: 'DOCUMENT',
        sourceSystem: active.sourceSystem,
        sourceRecordId: active.sourceRecordId,
        sourceVersion: active.sourceVersion,
        sourceUri: active.sourceUri,
        observedAt: active.observedAt,
        contentHash: active.contentHash,
        summary: active.summary,
        effectiveFrom: active.effectiveFrom,
        effectiveTo: active.effectiveTo,
        permissionLabels: active.permissionLabels,
      },
      apiBaseUrl,
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
