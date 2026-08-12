import { z } from 'zod';

export const tenantRoleSchema = z.enum(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN', 'MEMBER']);
export const adminConsoleRoleSchema = z.enum(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN']);
export const advancedSettingsRoleSchema = z.enum(['OWNER', 'ADMIN']);

export function canAccessAdminConsole(role: TenantRole): boolean {
  return adminConsoleRoleSchema.safeParse(role).success;
}

export function canAccessAdvancedSettings(role: TenantRole): boolean {
  return advancedSettingsRoleSchema.safeParse(role).success;
}

export const authAccountSchema = z.object({
  sessionId: z.uuid(),
  tenantId: z.uuid(),
  tenantSlug: z.string().min(1),
  tenantName: z.string().min(1),
  userId: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  role: tenantRoleSchema,
  passwordChangeRequired: z.boolean(),
  accessExpiresAt: z.iso.datetime(),
  refreshExpiresAt: z.iso.datetime(),
});

export const authSessionResponseSchema = z.object({
  accessToken: z.string().min(32),
  refreshToken: z.string().min(32),
  account: authAccountSchema,
});

/** Browser sessions never expose bearer credentials to browser JavaScript. */
export const browserAuthSessionResponseSchema = z.object({ account: authAccountSchema }).strict();

export const currentSessionResponseSchema = authAccountSchema.omit({ sessionId: true }).extend({
  sessionId: z.uuid(),
});

export type TenantRole = z.infer<typeof tenantRoleSchema>;
export type AuthAccount = z.infer<typeof authAccountSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type BrowserAuthSessionResponse = z.infer<typeof browserAuthSessionResponseSchema>;
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;
