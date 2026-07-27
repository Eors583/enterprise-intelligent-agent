import { z } from 'zod';

export const tenantSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const currentUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  avatarUrl: z.url().optional(),
});

export const navigationItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const departmentSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  memberCount: z.number().int().nonnegative(),
});

export const memberAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['online', 'offline', 'disabled']),
  summary: z.string().min(1).optional(),
});

export const memberSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  departmentIds: z.array(z.string().min(1)),
  avatarUrl: z.url().optional(),
  status: z.enum(['active', 'inactive']),
  agent: memberAgentSchema.nullable(),
  capabilities: z.object({
    canContactHuman: z.boolean(),
    canContactAgent: z.boolean(),
  }),
});

export const bootstrapResponseSchema = z.object({
  tenant: tenantSummarySchema,
  currentUser: currentUserSchema,
  navigation: z.array(navigationItemSchema),
  departments: z.array(departmentSummarySchema),
  members: z.array(memberSummarySchema),
});

export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type NavigationItem = z.infer<typeof navigationItemSchema>;
export type DepartmentSummary = z.infer<typeof departmentSummarySchema>;
export type MemberAgent = z.infer<typeof memberAgentSchema>;
export type MemberSummary = z.infer<typeof memberSummarySchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
