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

/**
 * The employee application intentionally exposes only four primary business
 * destinations. Legacy workspace identifiers remain accepted by the generic
 * navigation item wire contract so an older server/client pair can still
 * bootstrap, but new servers must publish only these canonical identifiers.
 */
export const employeePrimaryNavigationIdSchema = z.enum([
  'workbench',
  'messages',
  'contacts',
  'profile',
]);

export const employeePrimaryNavigationIds = employeePrimaryNavigationIdSchema.options;

/**
 * Stable compatibility map for desktop deep links and persisted last-route
 * values. This changes entry placement without deleting the underlying
 * capability or its old URL.
 */
export const legacyEmployeeNavigationAliases = {
  home: 'workbench',
  agents: 'messages',
  roles: 'profile',
  growth: 'profile',
  memories: 'profile',
  'experience-usage': 'profile',
} as const satisfies Readonly<Record<string, z.infer<typeof employeePrimaryNavigationIdSchema>>>;

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

export const agentOperationalAvailabilitySchema = z.object({
  status: z.enum(['AVAILABLE', 'NOT_READY', 'DEGRADED', 'UNKNOWN']),
  evidenceStatus: z.enum(['VERIFIED', 'INSUFFICIENT_EVIDENCE']),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]{1,120}$/u)),
  checkedAt: z.iso.datetime().nullable(),
});

export const memberAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['online', 'offline', 'disabled']),
  summary: z.string().min(1).optional(),
  operationalAvailability: agentOperationalAvailabilitySchema,
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

export const departmentAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1).optional(),
  departmentId: z.string().min(1),
  departmentName: z.string().min(1),
  status: z.enum(['online', 'offline', 'disabled']),
  operationalAvailability: agentOperationalAvailabilitySchema,
});

export const bootstrapResponseSchema = z.object({
  tenant: tenantSummarySchema,
  currentUser: currentUserSchema,
  navigation: z.array(navigationItemSchema),
  departments: z.array(departmentSummarySchema),
  members: z.array(memberSummarySchema),
  departmentAgents: z.array(departmentAgentSchema).default([]),
});

export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type EmployeePrimaryNavigationId = z.infer<typeof employeePrimaryNavigationIdSchema>;
export type NavigationItem = z.infer<typeof navigationItemSchema>;
export type DepartmentSummary = z.infer<typeof departmentSummarySchema>;
export type AgentOperationalAvailability = z.infer<typeof agentOperationalAvailabilitySchema>;
export type MemberAgent = z.infer<typeof memberAgentSchema>;
export type MemberSummary = z.infer<typeof memberSummarySchema>;
export type DepartmentAgent = z.infer<typeof departmentAgentSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
