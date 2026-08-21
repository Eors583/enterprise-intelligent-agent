import {
  acceptMemberInvitationRequestSchema,
  acceptMemberInvitationResponseSchema,
  browserAuthSessionResponseSchema,
  browserLoginResultSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  completePasswordResetRequestSchema,
  completePasswordResetResponseSchema,
  currentSessionResponseSchema,
  loginRequestSchema,
  registerTenantRequestSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  type AcceptMemberInvitationRequest,
  type AcceptMemberInvitationResponse,
  type BrowserAuthSessionResponse,
  type BrowserLoginResult,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type CompletePasswordResetRequest,
  type CompletePasswordResetResponse,
  type CurrentSessionResponse,
  type LoginRequest,
  type RegisterTenantRequest,
  type RequestPasswordResetRequest,
  type RequestPasswordResetResponse,
} from '@enterprise/contracts/auth';
import {
  mfaLoginVerifyRequestSchema,
  oidcLoginCallbackRequestSchema,
  oidcLoginStartRequestSchema,
  oidcLoginStartResponseSchema,
  oidcPublicProviderListResponseSchema,
  type MfaLoginVerifyRequest,
  type OidcLoginCallbackRequest,
  type OidcLoginStartRequest,
  type OidcLoginStartResponse,
  type OidcPublicProviderListResponse,
} from '@enterprise/contracts/identity-governance';
import { z } from 'zod';

import { request } from './client';

const mutationResponseSchema = z.unknown();

export function login(input: LoginRequest): Promise<BrowserLoginResult> {
  return request('/auth/browser/login', {
    method: 'POST',
    body: loginRequestSchema.parse({ ...input, sessionLabel: '管理后台' }),
    schema: browserLoginResultSchema,
    authenticated: false,
  });
}

export function completeMfaLogin(
  input: MfaLoginVerifyRequest,
): Promise<BrowserAuthSessionResponse> {
  return request('/auth/browser/mfa/login/verify', {
    method: 'POST',
    body: mfaLoginVerifyRequestSchema.parse(input),
    schema: browserAuthSessionResponseSchema,
    authenticated: false,
  });
}

export function listOidcLoginProviders(
  tenantSlug: string,
): Promise<OidcPublicProviderListResponse> {
  return request(`/auth/oidc/providers/${encodeURIComponent(tenantSlug.trim().toLowerCase())}`, {
    schema: oidcPublicProviderListResponseSchema,
    authenticated: false,
  });
}

export function startOidcLogin(input: OidcLoginStartRequest): Promise<OidcLoginStartResponse> {
  return request('/auth/oidc/start', {
    method: 'POST',
    body: oidcLoginStartRequestSchema.parse(input),
    schema: oidcLoginStartResponseSchema,
    authenticated: false,
  });
}

export function completeOidcLogin(
  input: OidcLoginCallbackRequest,
): Promise<BrowserAuthSessionResponse> {
  return request('/auth/browser/oidc/callback', {
    method: 'POST',
    body: oidcLoginCallbackRequestSchema.parse(input),
    schema: browserAuthSessionResponseSchema,
    authenticated: false,
  });
}

export function registerTenant(input: RegisterTenantRequest): Promise<BrowserAuthSessionResponse> {
  return request('/auth/browser/register-tenant', {
    method: 'POST',
    body: registerTenantRequestSchema.parse({ ...input, sessionLabel: '管理后台' }),
    schema: browserAuthSessionResponseSchema,
    authenticated: false,
  });
}

export function currentBrowserSession(): Promise<BrowserAuthSessionResponse> {
  return request('/auth/me', {
    schema: currentSessionResponseSchema,
  }).then((account: CurrentSessionResponse) => ({ account }));
}

export function logout(): Promise<unknown> {
  return request('/auth/browser/logout', {
    method: 'POST',
    schema: mutationResponseSchema,
  });
}

export function changePassword(input: ChangePasswordRequest): Promise<ChangePasswordResponse> {
  return request('/auth/change-password', {
    method: 'POST',
    body: changePasswordRequestSchema.parse(input),
    schema: changePasswordResponseSchema,
  });
}

export function requestPasswordReset(
  input: RequestPasswordResetRequest,
): Promise<RequestPasswordResetResponse> {
  return request('/auth/password-reset/request', {
    method: 'POST',
    body: requestPasswordResetRequestSchema.parse(input),
    schema: requestPasswordResetResponseSchema,
    authenticated: false,
  });
}

export function completePasswordReset(
  input: CompletePasswordResetRequest,
): Promise<CompletePasswordResetResponse> {
  return request('/auth/password-reset/complete', {
    method: 'POST',
    body: completePasswordResetRequestSchema.parse(input),
    schema: completePasswordResetResponseSchema,
    authenticated: false,
  });
}

export function acceptMemberInvitation(
  input: AcceptMemberInvitationRequest,
): Promise<AcceptMemberInvitationResponse> {
  return request('/auth/invitations/accept', {
    method: 'POST',
    body: acceptMemberInvitationRequestSchema.parse(input),
    schema: acceptMemberInvitationResponseSchema,
    authenticated: false,
  });
}
