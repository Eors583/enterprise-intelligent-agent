import { describe, expect, it } from 'vitest';

import {
  employeeAcceptanceRequestSchema,
  employeeDeliverableSubmissionRequestSchema,
  employeeEvidenceContributionRequestSchema,
  employeeTaskExecutionSnapshotSchema,
  employeeTaskTransitionRequestSchema,
} from '../src/employee-task-execution.js';

const tenantId = id(1);
const taskId = id(2);
const assignmentId = id(3);
const userId = id(4);
const deliverableId = id(5);
const now = '2026-07-28T08:00:00.000Z';

describe('employee task execution contracts', () => {
  it('accepts only the bounded employee transition surface and rejects client-owned fields', () => {
    const request = {
      expectedRevision: 2,
      action: 'START',
      roleAssignmentId: assignmentId,
      reason: 'The assigned employee started the verified task.',
      effectiveAt: now,
    } as const;

    expect(employeeTaskTransitionRequestSchema.parse(request)).toEqual(request);
    expect(
      employeeTaskTransitionRequestSchema.safeParse({ ...request, action: 'ACCEPT' }).success,
    ).toBe(false);
    expect(employeeTaskTransitionRequestSchema.safeParse({ ...request, tenantId }).success).toBe(
      false,
    );
    expect(
      employeeTaskTransitionRequestSchema.safeParse({ ...request, expectedRevision: 0 }).success,
    ).toBe(false);
  });

  it('requires one unique evidence set and a real SHA-256 for deliverable submission', () => {
    const request = {
      expectedRevision: 1,
      roleAssignmentId: assignmentId,
      submittedAt: now,
      artifactUri: 'https://artifacts.example.test/deliverable/5',
      contentHash: 'a'.repeat(64),
      evidenceIds: [id(6), id(7)],
    };

    expect(employeeDeliverableSubmissionRequestSchema.safeParse(request).success).toBe(true);
    expect(
      employeeDeliverableSubmissionRequestSchema.safeParse({
        ...request,
        evidenceIds: [id(6), id(6)],
      }).success,
    ).toBe(false);
    expect(
      employeeDeliverableSubmissionRequestSchema.safeParse({
        ...request,
        contentHash: 'not-a-hash',
      }).success,
    ).toBe(false);
    expect(
      employeeDeliverableSubmissionRequestSchema.safeParse({
        ...request,
        artifactUri: 'not-a-valid-uri',
      }).success,
    ).toBe(false);
  });

  it('keeps employee evidence unverified input provenance bounded and time-consistent', () => {
    const request = {
      roleAssignmentId: assignmentId,
      code: 'EVIDENCE.EXECUTION.REPORT',
      sourceType: 'DOCUMENT',
      sourceSystem: 'SYSTEM.DOCUMENT',
      sourceRecordId: 'report-2026-07-28',
      sourceVersion: '1',
      sourceUri: 'https://documents.example.test/report-2026-07-28',
      observedAt: now,
      contentHash: 'b'.repeat(64),
      summary: 'A source-attributed execution report awaiting independent verification.',
      effectiveFrom: now,
      effectiveTo: null,
      permissionLabels: ['classification:internal'],
    } as const;

    expect(employeeEvidenceContributionRequestSchema.safeParse(request).success).toBe(true);
    expect(
      employeeEvidenceContributionRequestSchema.safeParse({
        ...request,
        sourceType: 'AGENT_RUN',
      }).success,
    ).toBe(false);
    expect(
      employeeEvidenceContributionRequestSchema.safeParse({
        ...request,
        effectiveFrom: '2026-07-28T09:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('requires a formal Acceptance identity for every resolved request', () => {
    const request = acceptanceRequest();
    expect(employeeAcceptanceRequestSchema.safeParse(request).success).toBe(true);
    expect(
      employeeAcceptanceRequestSchema.safeParse({
        ...request,
        status: 'ACCEPTED',
      }).success,
    ).toBe(false);
    expect(
      employeeAcceptanceRequestSchema.safeParse({
        ...request,
        status: 'ACCEPTED',
        acceptanceId: id(8),
        acceptanceVersion: 1,
        decisionComment: 'Accepted by an independent governance role.',
      }).success,
    ).toBe(true);
  });

  it('fails a task execution snapshot closed on cross-tenant acceptance data', () => {
    const snapshot = {
      task: task(),
      capabilities: [
        {
          action: 'business.task.execute',
          roleAssignmentId: assignmentId,
        },
      ],
      deliverables: [],
      evidence: [],
      acceptanceRequests: [acceptanceRequest({ tenantId: id(99) })],
    };

    expect(employeeTaskExecutionSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(
      employeeTaskExecutionSnapshotSchema.safeParse({
        ...snapshot,
        acceptanceRequests: [acceptanceRequest()],
      }).success,
    ).toBe(true);
  });
});

function task() {
  return {
    id: taskId,
    tenantId,
    code: 'TASK.EXECUTION',
    owner: { type: 'ROLE_ASSIGNMENT' as const, id: assignmentId },
    version: 1,
    revision: 2,
    permissionLabels: ['classification:internal'],
    createdAt: now,
    updatedAt: now,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    objectiveId: id(10),
    valueDefinitionId: id(11),
    valueVersionId: id(12),
    processRef: {
      definitionId: id(13),
      definitionCode: 'PROCESS.EXECUTION',
      versionId: id(14),
      version: 1,
      nodeId: id(15),
      nodeCode: 'ACTIVITY.EXECUTE',
      instanceId: null,
    },
    title: 'Execute the governed task',
    description: 'A real task visible to an authorized employee.',
    status: 'READY' as const,
    priority: 'HIGH' as const,
    dueAt: '2026-12-31T00:00:00.000Z',
  };
}

function acceptanceRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: id(20),
    tenantId,
    taskId,
    taskVersion: 1,
    deliverableId,
    deliverableVersion: 1,
    requestedByUserId: userId,
    requestedByRoleAssignmentId: assignmentId,
    status: 'REQUESTED',
    revision: 1,
    reason: 'The evidence-sealed deliverable is ready for independent acceptance.',
    dueAt: '2026-08-01T00:00:00.000Z',
    requestedAt: now,
    acceptanceId: null,
    acceptanceVersion: null,
    decisionComment: null,
    ...overrides,
  };
}

function id(value: number): string {
  return `00000000-0000-7000-8000-${String(value).padStart(12, '0')}`;
}
