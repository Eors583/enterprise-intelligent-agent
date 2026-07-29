import type { Deliverable, EmployeeTaskExecutionSnapshot, Evidence } from '@enterprise/contracts';

import { taskFixture } from './test-fixtures';

export const executionAssignmentId = id(201);
export const executionDeliverableId = id(202);
export const executionEvidenceId = id(203);
const owner = { type: 'ROLE_ASSIGNMENT' as const, id: executionAssignmentId };
const timestamp = '2026-07-28T08:00:00.000Z';

export function executionDeliverableFixture(overrides: Partial<Deliverable> = {}): Deliverable {
  const task = taskFixture();
  return {
    id: executionDeliverableId,
    tenantId: task.tenantId,
    code: 'DELIVERABLE.EXECUTION.RESULT',
    owner,
    version: 1,
    revision: 1,
    permissionLabels: ['business.read'],
    createdAt: timestamp,
    updatedAt: timestamp,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    taskId: task.id,
    title: 'Governed execution result',
    description: 'An evidence-sealed result awaiting submission.',
    status: 'DRAFT',
    dueAt: '2026-08-01T00:00:00.000Z',
    submittedAt: null,
    artifactUri: null,
    contentHash: null,
    ...overrides,
  };
}

export function executionEvidenceFixture(overrides: Partial<Evidence> = {}): Evidence {
  const task = taskFixture();
  return {
    id: executionEvidenceId,
    tenantId: task.tenantId,
    code: 'EVIDENCE.EXECUTION.RESULT',
    owner,
    version: 1,
    revision: 1,
    permissionLabels: ['business.read'],
    createdAt: timestamp,
    updatedAt: timestamp,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    status: 'ACTIVE',
    sourceType: 'DOCUMENT',
    sourceSystem: 'SYSTEM.DOCUMENT',
    sourceRecordId: 'execution-result',
    sourceVersion: '1',
    sourceUri: 'https://documents.example.test/execution-result',
    observedAt: timestamp,
    contentHashAlgorithm: 'SHA256',
    contentHash: 'a'.repeat(64),
    trustLevel: 'HIGH',
    confidence: 0.9,
    summary: 'Verified evidence linked to the task.',
    verifiedBy: null,
    verifiedAt: null,
    ...overrides,
  };
}

export function employeeTaskExecutionFixture(
  overrides: Partial<EmployeeTaskExecutionSnapshot> = {},
): EmployeeTaskExecutionSnapshot {
  const task = taskFixture({ status: 'READY', revision: 3 });
  return {
    task,
    capabilities: [
      { action: 'business.task.execute', roleAssignmentId: executionAssignmentId },
      { action: 'business.deliverable.submit', roleAssignmentId: executionAssignmentId },
      { action: 'business.evidence.contribute', roleAssignmentId: executionAssignmentId },
      { action: 'business.acceptance.request', roleAssignmentId: executionAssignmentId },
    ],
    deliverables: [executionDeliverableFixture({ taskId: task.id })],
    evidence: [executionEvidenceFixture()],
    acceptanceRequests: [],
    ...overrides,
  };
}

function id(value: number): string {
  return `00000000-0000-7000-8000-${String(value).padStart(12, '0')}`;
}
