import { z } from 'zod';

const UUID = z.uuid();
const ISO_DATE_TIME = z.iso.datetime();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const collaborationDisclosureScopeSchema = z.enum([
  'SELF_ONLY',
  'SHARED_WORK',
  'DEPARTMENT',
  'TENANT',
]);

export const personalManualSectionSchema = z.enum([
  'IDENTITY',
  'RESPONSIBILITIES',
  'COLLABORATION',
  'RESOURCES',
  'INTERESTS',
  'FAQ',
]);

export const personalManualDisclosurePolicySchema = z
  .object({
    IDENTITY: collaborationDisclosureScopeSchema,
    RESPONSIBILITIES: collaborationDisclosureScopeSchema,
    COLLABORATION: collaborationDisclosureScopeSchema,
    RESOURCES: collaborationDisclosureScopeSchema,
    INTERESTS: collaborationDisclosureScopeSchema,
    FAQ: collaborationDisclosureScopeSchema,
  })
  .strict();

export const DEFAULT_PERSONAL_MANUAL_DISCLOSURE_POLICY = {
  IDENTITY: 'SELF_ONLY',
  RESPONSIBILITIES: 'SELF_ONLY',
  COLLABORATION: 'SELF_ONLY',
  RESOURCES: 'SELF_ONLY',
  INTERESTS: 'SELF_ONLY',
  FAQ: 'SELF_ONLY',
} as const;

export const employeeAgentCollaborationSettingsSchema = z
  .object({
    manualSharingEnabled: z.boolean(),
    availabilitySharingEnabled: z.boolean(),
    privateRiskRemindersEnabled: z.boolean(),
  })
  .strict();

export const DEFAULT_EMPLOYEE_AGENT_COLLABORATION_SETTINGS = {
  manualSharingEnabled: false,
  availabilitySharingEnabled: false,
  privateRiskRemindersEnabled: true,
} as const;

export const workAvailabilityStatusSchema = z.enum([
  'AVAILABLE',
  'FOCUSING',
  'IN_MEETING',
  'TRAVELING',
  'ON_LEAVE',
  'UNAVAILABLE',
]);

export const workAvailabilitySchema = z
  .object({
    id: UUID,
    status: workAvailabilityStatusSchema,
    startsAt: ISO_DATE_TIME,
    endsAt: ISO_DATE_TIME.nullable(),
    summary: z.string().trim().max(500).nullable(),
    expectedResponse: z.string().trim().max(200).nullable(),
    emergencyContact: z
      .object({ id: UUID, displayName: z.string().min(1).max(120) })
      .strict()
      .nullable(),
    disclosureScope: collaborationDisclosureScopeSchema,
    revision: z.number().int().positive(),
    updatedAt: ISO_DATE_TIME,
    expired: z.boolean(),
  })
  .strict();

export const workAvailabilitySelfResponseSchema = z
  .object({ availability: workAvailabilitySchema.nullable() })
  .strict();

export const updateWorkAvailabilityRequestSchema = z
  .object({
    status: workAvailabilityStatusSchema,
    startsAt: ISO_DATE_TIME,
    endsAt: ISO_DATE_TIME.nullable(),
    summary: z.string().trim().max(500).nullable(),
    expectedResponse: z.string().trim().max(200).nullable(),
    emergencyContactUserId: UUID.nullable(),
    disclosureScope: collaborationDisclosureScopeSchema,
    expectedRevision: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsAt !== null && new Date(value.endsAt) <= new Date(value.startsAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: '结束时间必须晚于开始时间。',
      });
    }
  });

export const employeeCollaborationPurposeSchema = z.enum([
  'SELF_ASSISTANCE',
  'COLLABORATION_GUIDANCE',
  'AVAILABILITY_QUERY',
  'WORK_PROGRESS_QUERY',
]);

export const employeeCollaborationRelationshipSchema = z.enum([
  'SELF',
  'SHARED_WORK',
  'DEPARTMENT',
  'TENANT_MEMBER',
]);

export const employeeCollaborationSourceSchema = z
  .object({
    sourceId: UUID,
    sourceType: z.enum(['PERSONAL_MANUAL', 'WORK_AVAILABILITY', 'TASK_FACT']),
    sourceVersion: z.number().int().positive(),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(10_000),
    updatedAt: ISO_DATE_TIME,
    contentHash: SHA256,
  })
  .strict();

export const employeeCollaborationContextSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    requesterUserId: UUID,
    representedEmployeeId: UUID,
    purpose: employeeCollaborationPurposeSchema,
    relationship: employeeCollaborationRelationshipSchema,
    policyRevision: z.number().int().positive(),
    policyHash: SHA256,
    resolvedAt: ISO_DATE_TIME,
    sources: z.array(employeeCollaborationSourceSchema).max(12),
    allowedCapabilities: z.array(z.enum(['ANSWER_FACTS', 'GIVE_ADVICE', 'DRAFT_ACTION'])),
    deniedCapabilities: z.array(
      z.enum(['SEND_MESSAGE', 'CHANGE_TASK', 'MAKE_COMMITMENT', 'ACCEPT', 'APPROVE', 'ESCALATE']),
    ),
    snapshotHash: SHA256,
  })
  .strict();

export type CollaborationDisclosureScope = z.infer<typeof collaborationDisclosureScopeSchema>;
export type PersonalManualSection = z.infer<typeof personalManualSectionSchema>;
export type PersonalManualDisclosurePolicy = z.infer<typeof personalManualDisclosurePolicySchema>;
export type EmployeeAgentCollaborationSettings = z.infer<
  typeof employeeAgentCollaborationSettingsSchema
>;
export type WorkAvailabilityStatus = z.infer<typeof workAvailabilityStatusSchema>;
export type WorkAvailability = z.infer<typeof workAvailabilitySchema>;
export type WorkAvailabilitySelfResponse = z.infer<typeof workAvailabilitySelfResponseSchema>;
export type UpdateWorkAvailabilityRequest = z.infer<typeof updateWorkAvailabilityRequestSchema>;
export type EmployeeCollaborationPurpose = z.infer<typeof employeeCollaborationPurposeSchema>;
export type EmployeeCollaborationRelationship = z.infer<
  typeof employeeCollaborationRelationshipSchema
>;
export type EmployeeCollaborationSource = z.infer<typeof employeeCollaborationSourceSchema>;
export type EmployeeCollaborationContextSnapshot = z.infer<
  typeof employeeCollaborationContextSnapshotSchema
>;
