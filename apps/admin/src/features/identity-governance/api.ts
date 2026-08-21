import {
  breakGlassListResponseSchema,
  breakGlassRequestSchema,
  scimConnectorListResponseSchema,
  scimConnectorSchema,
  scimServiceTokenCreatedSchema,
  scimServiceTokenListResponseSchema,
  scimServiceTokenMetadataSchema,
  identityPolicySchema,
  identityProviderListResponseSchema,
  identityProviderSchema,
  identitySecurityOverviewSchema,
  mfaEnrollmentStartResponseSchema,
  mfaEnrollmentVerifyResponseSchema,
  mfaStatusResponseSchema,
  recentMfaChallengeResponseSchema,
  recentMfaVerifyResponseSchema,
  revokeIdentityResourceResponseSchema,
  type BreakGlassActivateRequest,
  type BreakGlassDecisionRequest,
  type BreakGlassRequest,
  type BreakGlassRevokeRequest,
  type CloseBreakGlassReviewRequest,
  type CreateScimServiceTokenRequest,
  type CreateBreakGlassRequest,
  type IdentityPolicy,
  type IdentityProvider,
  type IdentityProviderCommandRequest,
  type IdentitySecurityOverview,
  type MfaEnrollmentStartRequest,
  type MfaEnrollmentStartResponse,
  type MfaEnrollmentVerifyRequest,
  type MfaEnrollmentVerifyResponse,
  type OidcProviderInput,
  type RevokeScimServiceTokenRequest,
  type RotateScimServiceTokenRequest,
  type ScimConnector,
  type ScimConnectorCommandRequest,
  type ScimConnectorCreateRequest,
  type ScimConnectorUpdateRequest,
  type ScimServiceTokenCreated,
  type ScimServiceTokenMetadata,
  type RecentMfaChallengeRequest,
  type RecentMfaChallengeResponse,
  type RecentMfaVerifyRequest,
  type RecentMfaVerifyResponse,
  type RevokeIdentityResourceRequest,
  type RevokeIdentityResourceResponse,
  type UpsertIdentityPolicyRequest,
} from '@enterprise/contracts';
import { z } from 'zod';

import { request } from '@/api/client';

const nullablePolicySchema = identityPolicySchema.nullable();

export function identitySecurityOverview(signal?: AbortSignal): Promise<IdentitySecurityOverview> {
  return request('/identity/security', {
    schema: identitySecurityOverviewSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function startMfaEnrollment(
  input: MfaEnrollmentStartRequest,
): Promise<MfaEnrollmentStartResponse> {
  return request('/auth/mfa/enrollment/start', {
    method: 'POST',
    body: input,
    schema: mfaEnrollmentStartResponseSchema,
  });
}

export function verifyMfaEnrollment(
  input: MfaEnrollmentVerifyRequest,
): Promise<MfaEnrollmentVerifyResponse> {
  return request('/auth/mfa/enrollment/verify', {
    method: 'POST',
    body: input,
    schema: mfaEnrollmentVerifyResponseSchema,
  });
}

export function requestRecentMfa(
  input: RecentMfaChallengeRequest,
): Promise<RecentMfaChallengeResponse> {
  return request('/auth/mfa/recent/challenge', {
    method: 'POST',
    body: input,
    schema: recentMfaChallengeResponseSchema,
  });
}

export function verifyRecentMfa(input: RecentMfaVerifyRequest): Promise<RecentMfaVerifyResponse> {
  return request('/auth/mfa/recent/verify', {
    method: 'POST',
    body: input,
    schema: recentMfaVerifyResponseSchema,
  });
}

export function revokeIdentitySession(
  sessionId: string,
  input: RevokeIdentityResourceRequest,
): Promise<RevokeIdentityResourceResponse> {
  return request(`/identity/security/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    body: input,
    schema: revokeIdentityResourceResponseSchema,
  });
}

export function revokeIdentityDevice(
  deviceId: string,
  input: RevokeIdentityResourceRequest,
): Promise<RevokeIdentityResourceResponse> {
  return request(`/identity/security/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: 'POST',
    body: input,
    schema: revokeIdentityResourceResponseSchema,
  });
}

export function listMyBreakGlass(signal?: AbortSignal): Promise<{ items: BreakGlassRequest[] }> {
  return request('/identity/break-glass', {
    schema: breakGlassListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createBreakGlass(input: CreateBreakGlassRequest): Promise<BreakGlassRequest> {
  return request('/identity/break-glass', {
    method: 'POST',
    body: input,
    schema: breakGlassRequestSchema,
  });
}

export function activateBreakGlass(
  requestId: string,
  input: BreakGlassActivateRequest,
): Promise<BreakGlassRequest> {
  return request(`/identity/break-glass/${encodeURIComponent(requestId)}/activate`, {
    method: 'POST',
    body: input,
    schema: breakGlassRequestSchema,
  });
}

export function revokeMyBreakGlass(
  requestId: string,
  input: BreakGlassRevokeRequest,
): Promise<BreakGlassRequest> {
  return request(`/identity/break-glass/${encodeURIComponent(requestId)}/revoke`, {
    method: 'POST',
    body: input,
    schema: breakGlassRequestSchema,
  });
}

export function listIdentityProviders(
  signal?: AbortSignal,
): Promise<{ items: IdentityProvider[] }> {
  return request('/admin/identity-governance/providers', {
    schema: identityProviderListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function saveOidcProvider(input: OidcProviderInput): Promise<IdentityProvider> {
  return request('/admin/identity-governance/providers/oidc', {
    method: 'PUT',
    body: input,
    schema: identityProviderSchema,
  });
}

export function verifyOidcProvider(providerId: string): Promise<IdentityProvider> {
  return request(`/admin/identity-governance/providers/${encodeURIComponent(providerId)}/verify`, {
    method: 'POST',
    schema: identityProviderSchema,
  });
}

export function transitionIdentityProvider(
  providerId: string,
  action: 'submit' | 'publish' | 'retire',
  input: IdentityProviderCommandRequest,
): Promise<IdentityProvider> {
  return request(
    `/admin/identity-governance/providers/${encodeURIComponent(providerId)}/${action}`,
    {
      method: 'POST',
      body: input,
      schema: identityProviderSchema,
    },
  );
}

export function getIdentityPolicy(signal?: AbortSignal): Promise<IdentityPolicy | null> {
  return request('/admin/identity-governance/policy', {
    schema: nullablePolicySchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function saveIdentityPolicy(input: UpsertIdentityPolicyRequest): Promise<IdentityPolicy> {
  return request('/admin/identity-governance/policy', {
    method: 'PUT',
    body: input,
    schema: identityPolicySchema,
  });
}

export function listScimConnectors(signal?: AbortSignal): Promise<{ items: ScimConnector[] }> {
  return request('/admin/identity-governance/scim/connectors', {
    schema: scimConnectorListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createScimConnector(input: ScimConnectorCreateRequest): Promise<ScimConnector> {
  return request('/admin/identity-governance/scim/connectors', {
    method: 'POST',
    body: input,
    schema: scimConnectorSchema,
  });
}

export function updateScimConnector(
  connectorId: string,
  input: ScimConnectorUpdateRequest,
): Promise<ScimConnector> {
  return request(`/admin/identity-governance/scim/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    body: input,
    schema: scimConnectorSchema,
  });
}

export function transitionScimConnector(
  connectorId: string,
  action: 'submit' | 'activate' | 'suspend' | 'retire',
  input: ScimConnectorCommandRequest,
): Promise<ScimConnector> {
  return request(
    `/admin/identity-governance/scim/connectors/${encodeURIComponent(connectorId)}/${action}`,
    {
      method: 'POST',
      body: input,
      schema: scimConnectorSchema,
    },
  );
}

export function listScimServiceTokens(
  connectorId: string,
  signal?: AbortSignal,
): Promise<{ items: ScimServiceTokenMetadata[] }> {
  return request(
    `/admin/identity-governance/scim/connectors/${encodeURIComponent(connectorId)}/tokens`,
    {
      schema: scimServiceTokenListResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

export function createScimServiceToken(
  connectorId: string,
  input: CreateScimServiceTokenRequest,
): Promise<ScimServiceTokenCreated> {
  return request(
    `/admin/identity-governance/scim/connectors/${encodeURIComponent(connectorId)}/tokens`,
    {
      method: 'POST',
      body: input,
      schema: scimServiceTokenCreatedSchema,
    },
  );
}

export function rotateScimServiceToken(
  connectorId: string,
  tokenId: string,
  input: RotateScimServiceTokenRequest,
): Promise<ScimServiceTokenCreated> {
  return request(
    `/admin/identity-governance/scim/connectors/${encodeURIComponent(connectorId)}/tokens/${encodeURIComponent(tokenId)}/rotate`,
    {
      method: 'POST',
      body: input,
      schema: scimServiceTokenCreatedSchema,
    },
  );
}

export function revokeScimServiceToken(
  connectorId: string,
  tokenId: string,
  input: RevokeScimServiceTokenRequest,
): Promise<ScimServiceTokenMetadata> {
  return request(
    `/admin/identity-governance/scim/connectors/${encodeURIComponent(connectorId)}/tokens/${encodeURIComponent(tokenId)}/revoke`,
    {
      method: 'POST',
      body: input,
      schema: scimServiceTokenMetadataSchema,
    },
  );
}

export function listAdminBreakGlass(signal?: AbortSignal): Promise<{ items: BreakGlassRequest[] }> {
  return request('/admin/identity-governance/break-glass', {
    schema: breakGlassListResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function decideBreakGlass(
  requestId: string,
  action: 'approve' | 'reject',
  input: BreakGlassDecisionRequest,
): Promise<BreakGlassRequest> {
  return request(
    `/admin/identity-governance/break-glass/${encodeURIComponent(requestId)}/${action}`,
    {
      method: 'POST',
      body: input,
      schema: breakGlassRequestSchema,
    },
  );
}

export function revokeAdminBreakGlass(
  requestId: string,
  input: BreakGlassRevokeRequest,
): Promise<BreakGlassRequest> {
  return request(`/admin/identity-governance/break-glass/${encodeURIComponent(requestId)}/revoke`, {
    method: 'POST',
    body: input,
    schema: breakGlassRequestSchema,
  });
}

export function closeBreakGlassReview(
  requestId: string,
  input: CloseBreakGlassReviewRequest,
): Promise<BreakGlassRequest> {
  return request(
    `/admin/identity-governance/break-glass/${encodeURIComponent(requestId)}/review-close`,
    {
      method: 'POST',
      body: input,
      schema: breakGlassRequestSchema,
    },
  );
}

export const identityGovernanceMutationSchema = z.unknown();
