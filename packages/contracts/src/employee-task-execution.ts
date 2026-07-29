import { z } from 'zod';

import {
  businessCodeSchema,
  businessPermissionLabelsSchema,
  deliverableSchema,
  evidenceSchema,
  taskSchema,
} from './business-semantics.js';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const REVISION = z.number().int().positive();
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const SHA256 = z
  .string()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/);

export const employeeTaskActionSchema = z.enum(['START', 'BLOCK', 'UNBLOCK', 'DELIVER']);

export const employeeTaskCapabilitySchema = z
  .object({
    action: z.enum([
      'business.task.execute',
      'business.deliverable.submit',
      'business.evidence.contribute',
      'business.acceptance.request',
    ]),
    roleAssignmentId: UUID,
  })
  .strict();

export const employeeTaskTransitionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    action: employeeTaskActionSchema,
    roleAssignmentId: UUID,
    reason: SHORT_TEXT,
    effectiveAt: TIMESTAMP,
  })
  .strict();

export const employeeDeliverableSubmissionRequestSchema = z
  .object({
    expectedRevision: REVISION,
    roleAssignmentId: UUID,
    submittedAt: TIMESTAMP,
    artifactUri: z.url(),
    contentHash: SHA256,
    evidenceIds: z.array(UUID).min(1).max(100).refine(uniqueStrings, {
      message: 'Submission evidence IDs must be unique.',
    }),
  })
  .strict();

export const employeeEvidenceContributionRequestSchema = z
  .object({
    roleAssignmentId: UUID,
    code: businessCodeSchema,
    sourceType: z.enum(['DOCUMENT', 'HUMAN_ATTESTATION']),
    sourceSystem: businessCodeSchema,
    sourceRecordId: z.string().trim().min(1).max(500),
    sourceVersion: z.string().trim().min(1).max(200),
    sourceUri: z.url().nullable().default(null),
    observedAt: TIMESTAMP,
    contentHash: SHA256,
    summary: LONG_TEXT,
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable().default(null),
    permissionLabels: businessPermissionLabelsSchema.default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.effectiveTo === null || Date.parse(value.effectiveTo) > Date.parse(value.effectiveFrom),
    {
      message: 'effectiveTo must be later than effectiveFrom.',
      path: ['effectiveTo'],
    },
  )
  .refine((value) => Date.parse(value.observedAt) >= Date.parse(value.effectiveFrom), {
    message: 'observedAt cannot precede effectiveFrom.',
    path: ['observedAt'],
  })
  .refine(
    (value) =>
      value.effectiveTo === null || Date.parse(value.observedAt) <= Date.parse(value.effectiveTo),
    {
      message: 'observedAt cannot be later than effectiveTo.',
      path: ['observedAt'],
    },
  );

export const employeeAcceptanceRequestInputSchema = z
  .object({
    expectedDeliverableRevision: REVISION,
    roleAssignmentId: UUID,
    reason: LONG_TEXT,
    dueAt: TIMESTAMP,
  })
  .strict();

export const employeeAcceptanceRequestStatusSchema = z.enum([
  'REQUESTED',
  'ACCEPTED',
  'REJECTED',
  'CHANGES_REQUESTED',
]);

export const employeeAcceptanceRequestSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    taskId: UUID,
    taskVersion: REVISION,
    deliverableId: UUID,
    deliverableVersion: REVISION,
    requestedByUserId: UUID,
    requestedByRoleAssignmentId: UUID,
    status: employeeAcceptanceRequestStatusSchema,
    revision: REVISION,
    reason: LONG_TEXT,
    dueAt: TIMESTAMP,
    requestedAt: TIMESTAMP,
    acceptanceId: UUID.nullable(),
    acceptanceVersion: REVISION.nullable(),
    decisionComment: LONG_TEXT.nullable(),
  })
  .strict()
  .refine(
    (request) =>
      (request.acceptanceId === null) === (request.acceptanceVersion === null) &&
      (request.acceptanceId === null) === (request.decisionComment === null),
    {
      message: 'Acceptance decision identity, version, and comment must be returned together.',
      path: ['acceptanceId'],
    },
  )
  .refine((request) => request.status === 'REQUESTED' || request.acceptanceId !== null, {
    message: 'A resolved Acceptance Request requires a formal Acceptance.',
    path: ['status'],
  });

export const employeeTaskExecutionSnapshotSchema = z
  .object({
    task: taskSchema,
    capabilities: z.array(employeeTaskCapabilitySchema).max(100),
    deliverables: z.array(deliverableSchema).max(10_000),
    evidence: z.array(evidenceSchema).max(20_000),
    acceptanceRequests: z.array(employeeAcceptanceRequestSchema).max(10_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.deliverables.some(
        (deliverable) =>
          deliverable.tenantId !== snapshot.task.tenantId ||
          deliverable.taskId !== snapshot.task.id,
      ) ||
      snapshot.evidence.some((evidence) => evidence.tenantId !== snapshot.task.tenantId) ||
      snapshot.acceptanceRequests.some(
        (request) =>
          request.tenantId !== snapshot.task.tenantId || request.taskId !== snapshot.task.id,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Every execution record must belong to the enclosing Task and tenant.',
        path: ['task'],
      });
    }
  });

export type EmployeeTaskAction = z.infer<typeof employeeTaskActionSchema>;
export type EmployeeTaskCapability = z.infer<typeof employeeTaskCapabilitySchema>;
export type EmployeeTaskTransitionRequest = z.infer<typeof employeeTaskTransitionRequestSchema>;
export type EmployeeDeliverableSubmissionRequest = z.infer<
  typeof employeeDeliverableSubmissionRequestSchema
>;
export type EmployeeEvidenceContributionRequest = z.infer<
  typeof employeeEvidenceContributionRequestSchema
>;
export type EmployeeAcceptanceRequestInput = z.infer<typeof employeeAcceptanceRequestInputSchema>;
export type EmployeeAcceptanceRequest = z.infer<typeof employeeAcceptanceRequestSchema>;
export type EmployeeTaskExecutionSnapshot = z.infer<typeof employeeTaskExecutionSnapshotSchema>;

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
