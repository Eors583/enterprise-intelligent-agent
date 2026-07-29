import { z } from 'zod';

import {
  identityDeviceRegistrationSchema,
  mfaLoginChallengeResponseSchema,
} from './identity-governance.js';

export const tenantRoleSchema = z.enum(['OWNER', 'ADMIN', 'KNOWLEDGE_ADMIN', 'MEMBER']);

export const registerTenantRequestSchema = z.object({
  tenantName: z.string().trim().min(2).max(200),
  tenantSlug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  organizationName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(1).max(120),
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(128),
  sessionLabel: z.string().trim().min(1).max(120).optional(),
});

export const loginRequestSchema = z.object({
  tenantSlug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((value) => value.toLowerCase()),
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
  sessionLabel: z.string().trim().min(1).max(120).optional(),
  device: identityDeviceRegistrationSchema.optional(),
});

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

/**
 * Browser/BFF session responses deliberately contain no bearer credential.
 * Access and refresh tokens are transported only in HttpOnly same-site
 * cookies; browser JavaScript receives the account projection.
 */
export const browserAuthSessionResponseSchema = z
  .object({
    account: authAccountSchema,
  })
  .strict();

export const loginResultSchema = z.union([
  authSessionResponseSchema,
  mfaLoginChallengeResponseSchema,
]);

export const browserLoginResultSchema = z.union([
  browserAuthSessionResponseSchema,
  mfaLoginChallengeResponseSchema,
]);

export const refreshSessionRequestSchema = z.object({
  refreshToken: z.string().min(32).max(512),
});

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(10).max(128),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'New password must be different from the current password.',
    path: ['newPassword'],
  });

export const changePasswordResponseSchema = z.object({
  account: authAccountSchema,
  revokedSessionCount: z.number().int().nonnegative(),
});

const passwordResetTokenSchema = z
  .string()
  .min(48)
  .max(160)
  .regex(/^ea_reset_[A-Za-z0-9_-]+$/);

const invitationTokenSchema = z
  .string()
  .min(48)
  .max(160)
  .regex(/^ea_invite_[A-Za-z0-9_-]+$/);

export const requestPasswordResetRequestSchema = z.object({
  tenantSlug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((value) => value.toLowerCase()),
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
});

/**
 * The response is deliberately identical whether the workspace/account exists,
 * the account is inactive, or notification delivery is unavailable.
 */
export const requestPasswordResetResponseSchema = z.object({
  accepted: z.literal(true),
  message: z.string().min(1),
});

export const completePasswordResetRequestSchema = z.object({
  token: passwordResetTokenSchema,
  newPassword: z.string().min(10).max(128),
});

export const completePasswordResetResponseSchema = z.object({
  completed: z.literal(true),
  revokedSessionCount: z.number().int().nonnegative(),
});

export const acceptMemberInvitationRequestSchema = z.object({
  token: invitationTokenSchema,
  newPassword: z.string().min(10).max(128),
});

export const acceptMemberInvitationResponseSchema = z.object({
  accepted: z.literal(true),
  revokedSessionCount: z.number().int().nonnegative(),
});

export const currentSessionResponseSchema = authAccountSchema.omit({ sessionId: true }).extend({
  sessionId: z.uuid(),
});

export type TenantRole = z.infer<typeof tenantRoleSchema>;
export type RegisterTenantRequest = z.infer<typeof registerTenantRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResult = z.infer<typeof loginResultSchema>;
export type RefreshSessionRequest = z.infer<typeof refreshSessionRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;
export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetRequestSchema>;
export type RequestPasswordResetResponse = z.infer<typeof requestPasswordResetResponseSchema>;
export type CompletePasswordResetRequest = z.infer<typeof completePasswordResetRequestSchema>;
export type CompletePasswordResetResponse = z.infer<typeof completePasswordResetResponseSchema>;
export type AcceptMemberInvitationRequest = z.infer<typeof acceptMemberInvitationRequestSchema>;
export type AcceptMemberInvitationResponse = z.infer<typeof acceptMemberInvitationResponseSchema>;
export type AuthAccount = z.infer<typeof authAccountSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type BrowserAuthSessionResponse = z.infer<typeof browserAuthSessionResponseSchema>;
export type BrowserLoginResult = z.infer<typeof browserLoginResultSchema>;
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;
