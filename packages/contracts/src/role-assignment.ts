import { z } from 'zod';

import { roleDefinitionSnapshotSchema } from './role-blueprint.js';

export const roleAssignmentStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED',
]);

export const roleAssignmentSourceSchema = z.enum([
  'LOCAL',
  'DIRECTORY',
  'PROJECT',
  'TEMPORARY',
  'DELEGATION',
  'HANDOVER',
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const roleAssignmentSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1).max(160),
  idempotencyKey: z.string().min(1).max(200).optional(),
  version: z.number().int().positive().optional(),
  status: roleAssignmentStatusSchema,
  source: roleAssignmentSourceSchema,
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().nullable(),
  organizationScope: jsonObjectSchema,
  permissionScope: jsonObjectSchema,
  memoryPolicy: jsonObjectSchema,
  delegatedFromAssignmentId: z.uuid().nullable(),
  roleTemplateId: z.uuid().optional(),
  roleVersionId: z.uuid().optional(),
  roleDefinitionSnapshot: roleDefinitionSnapshotSchema.nullable(),
  blueprintRevision: z.number().int().positive(),
  assignee: z.object({
    id: z.uuid(),
    displayName: z.string().min(1),
    status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']),
  }),
  employment: z
    .object({
      id: z.uuid(),
      organizationId: z.uuid(),
      orgUnitId: z.uuid(),
      positionId: z.uuid().nullable(),
      status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED']),
    })
    .nullable(),
  agent: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    status: z.enum(['ONLINE', 'OFFLINE', 'DISABLED']),
    versionId: z.uuid(),
    version: z.number().int().positive(),
    versionStatus: z.enum(['DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED']),
    template: z.object({
      id: z.uuid(),
      key: z.string().min(1),
      name: z.string().min(1),
    }),
  }),
  createdBy: z.object({
    id: z.uuid(),
    displayName: z.string().min(1),
  }),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z
    .object({
      id: z.uuid(),
      displayName: z.string().min(1),
    })
    .nullable(),
  revokeReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const roleAssignmentListResponseSchema = z.object({
  items: z.array(roleAssignmentSchema),
});

export const createRoleAssignmentRequestSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._:-]{2,159}$/)
      .optional(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
      .optional(),
    userId: z.uuid(),
    employmentId: z.uuid(),
    agentVersionId: z.uuid(),
    agentName: z.string().trim().min(1).max(200).optional(),
    effectiveFrom: z.iso.datetime(),
    effectiveTo: z.iso.datetime().nullable().optional(),
    source: roleAssignmentSourceSchema.default('LOCAL'),
    delegatedFromAssignmentId: z.uuid().nullable().optional(),
    organizationScope: jsonObjectSchema.default({}),
    permissionScope: jsonObjectSchema.default({}),
    memoryPolicy: jsonObjectSchema.default({}),
  })
  .superRefine((value, context) => {
    if (
      value.effectiveTo !== undefined &&
      value.effectiveTo !== null &&
      new Date(value.effectiveTo) <= new Date(value.effectiveFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'The assignment end must be after its start.',
      });
    }
    const delegatedSource = value.source === 'DELEGATION' || value.source === 'HANDOVER';
    if (delegatedSource && value.delegatedFromAssignmentId == null) {
      context.addIssue({
        code: 'custom',
        path: ['delegatedFromAssignmentId'],
        message: 'A delegation or handover must reference its source assignment.',
      });
    }
    if (!delegatedSource && value.delegatedFromAssignmentId != null) {
      context.addIssue({
        code: 'custom',
        path: ['delegatedFromAssignmentId'],
        message: 'Only a delegation or handover can reference a source assignment.',
      });
    }
  });

export const revokeRoleAssignmentRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    expectedUpdatedAt: z.iso.datetime().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .superRefine((value, context) => {
    if (value.expectedUpdatedAt === undefined && value.expectedVersion === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expectedVersion'],
        message: 'An expected version or timestamp is required.',
      });
    }
  });

export const roleAssignmentReconcileResponseSchema = z.object({
  activated: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  cancelledRuns: z.number().int().nonnegative(),
});

export type RoleAssignmentStatus = z.infer<typeof roleAssignmentStatusSchema>;
export type RoleAssignmentSource = z.infer<typeof roleAssignmentSourceSchema>;
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type RoleAssignmentListResponse = z.infer<typeof roleAssignmentListResponseSchema>;
export type CreateRoleAssignmentRequest = z.infer<typeof createRoleAssignmentRequestSchema>;
export type RevokeRoleAssignmentRequest = z.infer<typeof revokeRoleAssignmentRequestSchema>;
export type RoleAssignmentReconcileResponse = z.infer<typeof roleAssignmentReconcileResponseSchema>;
