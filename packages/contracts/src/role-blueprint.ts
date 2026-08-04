import { z } from 'zod';

const roleKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._:-]{2,99}$/);

const namedRoleElementSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._:-]{1,99}$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const roleResponsibilitySchema = namedRoleElementSchema
  .extend({
    outcomes: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict();

export const roleValueDefinitionSchema = z
  .object({
    statement: z.string().trim().min(1).max(2_000),
    stakeholderOutcomes: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    measures: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  })
  .strict();

export const roleCapabilitySchema = namedRoleElementSchema
  .extend({
    level: z.enum(['FOUNDATIONAL', 'PRACTITIONER', 'ADVANCED', 'EXPERT']).optional(),
  })
  .strict();

export const roleProcessSchema = namedRoleElementSchema
  .extend({
    responsibility: z.enum(['OWNER', 'APPROVER', 'CONTRIBUTOR', 'OBSERVER']),
  })
  .strict();

export const roleToolSchema = namedRoleElementSchema
  .extend({
    access: z.enum(['READ', 'DRAFT', 'EXECUTE', 'APPROVAL_REQUIRED']),
  })
  .strict();

export const roleKnowledgeDomainSchema = namedRoleElementSchema
  .extend({
    sensitivity: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
  })
  .strict();

const structuredRoleShape = {
  mission: z.string().trim().min(1).max(20_000),
  responsibilities: z.array(roleResponsibilitySchema).min(1).max(100),
  valueDefinition: roleValueDefinitionSchema,
  capabilities: z.array(roleCapabilitySchema).max(100),
  processes: z.array(roleProcessSchema).max(100),
  tools: z.array(roleToolSchema).max(100),
  knowledgeDomains: z.array(roleKnowledgeDomainSchema).max(100),
} as const;

export const roleDefinitionSnapshotSchema = z.object(structuredRoleShape).strict();

export const agentVersionStatusSchema = z.enum(['DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED']);
export const agentVersionReviewStatusSchema = z.enum([
  'NOT_SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
]);

export const roleKnowledgeScopeSchema = z
  .object({
    knowledgeBaseIds: z.array(z.uuid()).max(50).optional(),
  })
  .catchall(z.unknown());

export const roleVersionSchema = z
  .object({
    id: z.uuid(),
    templateId: z.uuid(),
    version: z.number().int().positive(),
    status: agentVersionStatusSchema,
    reviewStatus: agentVersionReviewStatusSchema,
    systemPrompt: z.string().min(1),
    modelPolicy: z.record(z.string(), z.unknown()),
    toolPolicy: z.record(z.string(), z.unknown()),
    knowledgeScope: roleKnowledgeScopeSchema,
    roleDefinitionSnapshot: roleDefinitionSnapshotSchema.nullable(),
    blueprintRevision: z.number().int().positive(),
    changeSummary: z.string().nullable(),
    revision: z.number().int().positive(),
    createdById: z.uuid().nullable(),
    reviewRequestedAt: z.iso.datetime().nullable(),
    reviewRequestedById: z.uuid().nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewedById: z.uuid().nullable(),
    reviewComment: z.string().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    approvedById: z.uuid().nullable(),
    publishedAt: z.iso.datetime().nullable(),
    publishedById: z.uuid().nullable(),
    evaluationRunId: z.uuid().nullable(),
    evaluationDatasetVersionId: z.uuid().nullable(),
    evaluationSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    retiredAt: z.iso.datetime().nullable(),
    retiredById: z.uuid().nullable(),
    rollbackOfVersionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const roleBlueprintSchema = z
  .object({
    id: z.uuid(),
    key: roleKeySchema,
    name: z.string().min(1).max(200),
    description: z.string().nullable(),
    ...structuredRoleShape,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    versions: z.array(roleVersionSchema),
  })
  .strict();

export const roleBlueprintListResponseSchema = z
  .object({ items: z.array(roleBlueprintSchema) })
  .strict();

export const roleAssignmentCandidateSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    blueprintRevision: z.number().int().positive(),
    roleDefinitionSnapshot: roleDefinitionSnapshotSchema,
    blueprint: z
      .object({
        id: z.uuid(),
        key: roleKeySchema,
        name: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();

export const roleAssignmentCandidateListResponseSchema = z
  .object({ items: z.array(roleAssignmentCandidateSchema) })
  .strict();

export const createRoleBlueprintRequestSchema = z
  .object({
    key: roleKeySchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5_000).nullable().optional(),
    mission: structuredRoleShape.mission,
    responsibilities: structuredRoleShape.responsibilities,
    valueDefinition: structuredRoleShape.valueDefinition,
    capabilities: structuredRoleShape.capabilities.default([]),
    processes: structuredRoleShape.processes.default([]),
    tools: structuredRoleShape.tools.default([]),
    knowledgeDomains: structuredRoleShape.knowledgeDomains.default([]),
  })
  .strict();

export const updateRoleBlueprintRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(5_000).nullable().optional(),
    mission: structuredRoleShape.mission.optional(),
    responsibilities: structuredRoleShape.responsibilities.optional(),
    valueDefinition: structuredRoleShape.valueDefinition.optional(),
    capabilities: structuredRoleShape.capabilities.optional(),
    processes: structuredRoleShape.processes.optional(),
    tools: structuredRoleShape.tools.optional(),
    knowledgeDomains: structuredRoleShape.knowledgeDomains.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
    'At least one Role Blueprint field must change.',
  );

const roleVersionConfigurationShape = {
  systemPrompt: z.string().trim().min(20).max(20_000),
  modelPolicy: z.record(z.string(), z.unknown()),
  toolPolicy: z.record(z.string(), z.unknown()),
  knowledgeScope: roleKnowledgeScopeSchema,
  changeSummary: z.string().trim().min(1).max(500),
} as const;

export const createRoleVersionDraftRequestSchema = z.object(roleVersionConfigurationShape).strict();

export const updateRoleVersionDraftRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    systemPrompt: roleVersionConfigurationShape.systemPrompt.optional(),
    modelPolicy: roleVersionConfigurationShape.modelPolicy.optional(),
    toolPolicy: roleVersionConfigurationShape.toolPolicy.optional(),
    knowledgeScope: roleVersionConfigurationShape.knowledgeScope.optional(),
    changeSummary: roleVersionConfigurationShape.changeSummary.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
    'At least one Role Version field must change.',
  );

export const roleVersionTransitionRequestSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

export const publishRoleVersionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    evaluationRunId: z.uuid(),
  })
  .strict();

export const reviewRoleVersionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    decision: z.enum(['APPROVE', 'REQUEST_CHANGES']),
    comment: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const rollbackRoleVersionRequestSchema = z
  .object({
    expectedPublishedVersionId: z.uuid().nullable(),
    changeSummary: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Rollback never bypasses the normal maker-checker workflow. The endpoint
 * creates a new draft with immutable lineage; submit, independent review, and
 * publish are separate transitions.
 */
export const rollbackRoleVersionResponseSchema = roleVersionSchema
  .extend({
    status: z.literal('DRAFT'),
    reviewStatus: z.literal('NOT_SUBMITTED'),
    roleDefinitionSnapshot: roleDefinitionSnapshotSchema,
    rollbackOfVersionId: z.uuid(),
  })
  .strict();

export type RoleResponsibility = z.infer<typeof roleResponsibilitySchema>;
export type RoleValueDefinition = z.infer<typeof roleValueDefinitionSchema>;
export type RoleCapability = z.infer<typeof roleCapabilitySchema>;
export type RoleProcess = z.infer<typeof roleProcessSchema>;
export type RoleTool = z.infer<typeof roleToolSchema>;
export type RoleKnowledgeDomain = z.infer<typeof roleKnowledgeDomainSchema>;
export type RoleDefinitionSnapshot = z.infer<typeof roleDefinitionSnapshotSchema>;
export type RoleVersion = z.infer<typeof roleVersionSchema>;
export type RoleBlueprint = z.infer<typeof roleBlueprintSchema>;
export type RoleBlueprintListResponse = z.infer<typeof roleBlueprintListResponseSchema>;
export type RoleAssignmentCandidate = z.infer<typeof roleAssignmentCandidateSchema>;
export type RoleAssignmentCandidateListResponse = z.infer<
  typeof roleAssignmentCandidateListResponseSchema
>;
export type CreateRoleBlueprintRequest = z.infer<typeof createRoleBlueprintRequestSchema>;
export type UpdateRoleBlueprintRequest = z.infer<typeof updateRoleBlueprintRequestSchema>;
export type CreateRoleVersionDraftRequest = z.infer<typeof createRoleVersionDraftRequestSchema>;
export type UpdateRoleVersionDraftRequest = z.infer<typeof updateRoleVersionDraftRequestSchema>;
export type RoleVersionTransitionRequest = z.infer<typeof roleVersionTransitionRequestSchema>;
export type PublishRoleVersionRequest = z.infer<typeof publishRoleVersionRequestSchema>;
export type ReviewRoleVersionRequest = z.infer<typeof reviewRoleVersionRequestSchema>;
export type RollbackRoleVersionRequest = z.infer<typeof rollbackRoleVersionRequestSchema>;
export type RollbackRoleVersionResponse = z.infer<typeof rollbackRoleVersionResponseSchema>;
