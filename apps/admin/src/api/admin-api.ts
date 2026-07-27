import {
  adminOrganizationResponseSchema,
  adminAgentListResponseSchema,
  adminAgentSchema,
  adminAgentUsageSummarySchema,
  agentRunResponseSchema,
  agentUsageLimitsSchema,
  acceptMemberInvitationRequestSchema,
  acceptMemberInvitationResponseSchema,
  bindFeishuOrganizationRequestSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  completePasswordResetRequestSchema,
  completePasswordResetResponseSchema,
  createKnowledgeBaseRequestSchema,
  createKnowledgeDocumentRequestSchema,
  createMemberRequestSchema,
  createOrgUnitRequestSchema,
  inviteMemberRequestSchema,
  issueMemberInvitationResponseSchema,
  feishuOrganizationSyncStatusSchema,
  knowledgeBaseSchema,
  knowledgeBaseIndexReadinessSchema,
  knowledgeBaseListResponseSchema,
  knowledgeDocumentChunkListResponseSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentVersionDetailSchema,
  knowledgeEmbeddingRebuildResponseSchema,
  knowledgeRetrievalTestRequestSchema,
  knowledgeRetrievalTestResponseSchema,
  loginRequestSchema,
  memberInvitationSchema,
  registerTenantRequestSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  resetMemberPasswordRequestSchema,
  resetMemberPasswordResponseSchema,
  rollbackKnowledgeDocumentVersionRequestSchema,
  updateKnowledgeBaseRequestSchema,
  updateKnowledgeDocumentRequestSchema,
  updateMemberRequestSchema,
  updateAdminAgentRequestSchema,
  updateAgentUsageLimitsRequestSchema,
  updateOrganizationRequestSchema,
  updateOrgUnitRequestSchema,
  authSessionResponseSchema,
  type AdminOrganizationResponse,
  type AdminAgent,
  type AdminAgentListResponse,
  type AdminAgentUsageSummary,
  type AgentRunResponse,
  type AgentUsageLimits,
  type AcceptMemberInvitationRequest,
  type AcceptMemberInvitationResponse,
  type BindFeishuOrganizationRequest,
  type AuthSessionResponse,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type CompletePasswordResetRequest,
  type CompletePasswordResetResponse,
  type CreateKnowledgeBaseRequest,
  type CreateKnowledgeDocumentRequest,
  type CreateMemberRequest,
  type CreateOrgUnitRequest,
  type FeishuOrganizationSyncStatus,
  type InviteMemberRequest,
  type IssueMemberInvitationResponse,
  type KnowledgeBase,
  type KnowledgeBaseIndexReadiness,
  type KnowledgeBaseListResponse,
  type KnowledgeDocumentChunkListResponse,
  type KnowledgeDocument,
  type KnowledgeDocumentVersionDetail,
  type KnowledgeEmbeddingRebuildResponse,
  type KnowledgeRetrievalTestRequest,
  type KnowledgeRetrievalTestResponse,
  type LoginRequest,
  type MemberInvitation,
  type RegisterTenantRequest,
  type RequestPasswordResetRequest,
  type RequestPasswordResetResponse,
  type ResetMemberPasswordRequest,
  type ResetMemberPasswordResponse,
  type RollbackKnowledgeDocumentVersionRequest,
  type UpdateKnowledgeBaseRequest,
  type UpdateKnowledgeDocumentRequest,
  type UpdateMemberRequest,
  type UpdateAdminAgentRequest,
  type UpdateAgentUsageLimitsRequest,
  type UpdateOrganizationRequest,
  type UpdateOrgUnitRequest,
} from '@enterprise/contracts';
import { z } from 'zod';

import { request } from './client';

const mutationResponseSchema = z.unknown();

export function login(input: LoginRequest): Promise<AuthSessionResponse> {
  return request('/auth/login', {
    method: 'POST',
    body: loginRequestSchema.parse({ ...input, sessionLabel: '管理后台' }),
    schema: authSessionResponseSchema,
    authenticated: false,
  });
}

export function registerTenant(input: RegisterTenantRequest): Promise<AuthSessionResponse> {
  return request('/auth/register-tenant', {
    method: 'POST',
    body: registerTenantRequestSchema.parse({ ...input, sessionLabel: '管理后台' }),
    schema: authSessionResponseSchema,
    authenticated: false,
  });
}

export function logout(refreshToken: string): Promise<unknown> {
  return request('/auth/logout', {
    method: 'POST',
    body: { refreshToken },
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

export function getOrganization(signal?: AbortSignal): Promise<AdminOrganizationResponse> {
  return request('/admin/organization', {
    schema: adminOrganizationResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getFeishuOrganizationSyncStatus(
  signal?: AbortSignal,
): Promise<FeishuOrganizationSyncStatus> {
  return request('/admin/integrations/feishu/organization-sync', {
    schema: feishuOrganizationSyncStatusSchema,
    ...(signal ? { signal } : {}),
  });
}

export function startFeishuOrganizationSync(): Promise<FeishuOrganizationSyncStatus> {
  return request('/admin/integrations/feishu/organization-sync', {
    method: 'POST',
    schema: feishuOrganizationSyncStatusSchema,
  });
}

export function bindFeishuOrganization(
  input: BindFeishuOrganizationRequest,
): Promise<FeishuOrganizationSyncStatus> {
  return request('/admin/integrations/feishu/organization-sync/connection', {
    method: 'PUT',
    body: bindFeishuOrganizationRequestSchema.parse(input),
    schema: feishuOrganizationSyncStatusSchema,
  });
}

export function updateOrganization(input: UpdateOrganizationRequest): Promise<unknown> {
  return request('/admin/organization', {
    method: 'PATCH',
    body: updateOrganizationRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function createOrgUnit(input: CreateOrgUnitRequest): Promise<unknown> {
  return request('/admin/org-units', {
    method: 'POST',
    body: createOrgUnitRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function updateOrgUnit(id: string, input: UpdateOrgUnitRequest): Promise<unknown> {
  return request(`/admin/org-units/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updateOrgUnitRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function archiveOrgUnit(id: string, expectedVersion: number): Promise<unknown> {
  return request(
    `/admin/org-units/${encodeURIComponent(id)}?expectedVersion=${encodeURIComponent(String(expectedVersion))}`,
    {
      method: 'DELETE',
      schema: mutationResponseSchema,
    },
  );
}

export function createMember(input: CreateMemberRequest): Promise<unknown> {
  return request('/admin/members', {
    method: 'POST',
    body: createMemberRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function listMemberInvitations(
  signal?: AbortSignal,
): Promise<ReadonlyArray<MemberInvitation>> {
  return request('/admin/member-invitations', {
    schema: z.array(memberInvitationSchema),
    ...(signal ? { signal } : {}),
  });
}

export function inviteMember(input: InviteMemberRequest): Promise<IssueMemberInvitationResponse> {
  return request('/admin/member-invitations', {
    method: 'POST',
    body: inviteMemberRequestSchema.parse(input),
    schema: issueMemberInvitationResponseSchema,
  });
}

export function resendMemberInvitation(memberId: string): Promise<IssueMemberInvitationResponse> {
  return request(`/admin/members/${encodeURIComponent(memberId)}/invitation/resend`, {
    method: 'POST',
    schema: issueMemberInvitationResponseSchema,
  });
}

export function updateMember(id: string, input: UpdateMemberRequest): Promise<unknown> {
  return request(`/admin/members/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updateMemberRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function resetMemberPassword(
  id: string,
  input: ResetMemberPasswordRequest,
): Promise<ResetMemberPasswordResponse> {
  return request(`/admin/members/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST',
    body: resetMemberPasswordRequestSchema.parse(input),
    schema: resetMemberPasswordResponseSchema,
  });
}

export function listAgents(signal?: AbortSignal): Promise<AdminAgentListResponse> {
  return request('/admin/agents', {
    schema: adminAgentListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getAgentUsageSummary(signal?: AbortSignal): Promise<AdminAgentUsageSummary> {
  return request('/admin/agents/usage-summary', {
    schema: adminAgentUsageSummarySchema,
    ...(signal ? { signal } : {}),
  });
}

export function reconcileUnknownAgentRun(runId: string): Promise<AgentRunResponse> {
  return request(`/admin/agents/runs/${encodeURIComponent(runId)}/reconcile`, {
    method: 'POST',
    schema: agentRunResponseSchema,
  });
}

export function updateAgentUsageLimits(
  input: UpdateAgentUsageLimitsRequest,
): Promise<AgentUsageLimits> {
  return request('/admin/agents/usage-limits', {
    method: 'PATCH',
    body: updateAgentUsageLimitsRequestSchema.parse(input),
    schema: agentUsageLimitsSchema,
  });
}

export function updateAgent(id: string, input: UpdateAdminAgentRequest): Promise<AdminAgent> {
  return request(`/admin/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updateAdminAgentRequestSchema.parse(input),
    schema: adminAgentSchema,
  });
}

export function listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBaseListResponse> {
  return request('/admin/knowledge-bases', {
    schema: knowledgeBaseListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getKnowledgeBaseReadiness(
  knowledgeBaseId: string,
  signal?: AbortSignal,
): Promise<KnowledgeBaseIndexReadiness> {
  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/readiness`, {
    schema: knowledgeBaseIndexReadinessSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createKnowledgeBase(input: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> {
  return request('/admin/knowledge-bases', {
    method: 'POST',
    body: createKnowledgeBaseRequestSchema.parse(input),
    schema: knowledgeBaseSchema,
  });
}

export function updateKnowledgeBase(
  id: string,
  input: UpdateKnowledgeBaseRequest,
): Promise<unknown> {
  return request(`/admin/knowledge-bases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updateKnowledgeBaseRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function createKnowledgeDocument(
  knowledgeBaseId: string,
  input: CreateKnowledgeDocumentRequest,
): Promise<unknown> {
  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`, {
    method: 'POST',
    body: createKnowledgeDocumentRequestSchema.parse(input),
    schema: mutationResponseSchema,
  });
}

export function getKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`,
    {
      schema: knowledgeDocumentSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export function getKnowledgeDocumentVersion(
  knowledgeBaseId: string,
  documentId: string,
  documentVersionId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocumentVersionDetail> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(documentVersionId)}`,
    {
      schema: knowledgeDocumentVersionDetailSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export function listKnowledgeDocumentChunks(
  knowledgeBaseId: string,
  documentId: string,
  documentVersionId: string,
  input: { offset?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<KnowledgeDocumentChunkListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 10),
  });
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(documentVersionId)}/chunks?${search.toString()}`,
    {
      schema: knowledgeDocumentChunkListResponseSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export function updateKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  input: UpdateKnowledgeDocumentRequest,
): Promise<unknown> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`,
    {
      method: 'PATCH',
      body: updateKnowledgeDocumentRequestSchema.parse(input),
      schema: mutationResponseSchema,
    },
  );
}

export function archiveKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  expectedVersion: number,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}?expectedVersion=${encodeURIComponent(String(expectedVersion))}`,
    { method: 'DELETE', schema: knowledgeDocumentSchema },
  );
}

export function uploadKnowledgeDocument(
  knowledgeBaseId: string,
  input: { file: File; title: string; changeSummary?: string },
): Promise<KnowledgeDocument> {
  const body = new FormData();
  body.append('file', input.file, input.file.name);
  body.append('title', input.title.trim());
  if (input.changeSummary?.trim()) body.append('changeSummary', input.changeSummary.trim());

  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/upload`, {
    method: 'POST',
    body,
    schema: knowledgeDocumentSchema,
  });
}

export function uploadKnowledgeDocumentVersion(
  knowledgeBaseId: string,
  documentId: string,
  input: { file: File; changeSummary?: string },
): Promise<KnowledgeDocument> {
  const body = new FormData();
  body.append('file', input.file, input.file.name);
  if (input.changeSummary?.trim()) body.append('changeSummary', input.changeSummary.trim());

  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/upload`,
    {
      method: 'POST',
      body,
      schema: knowledgeDocumentSchema,
    },
  );
}

export function retryKnowledgeDocumentIngestion(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/retry`,
    {
      method: 'POST',
      schema: knowledgeDocumentSchema,
    },
  );
}

export function publishKnowledgeDocumentVersion(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/publish`,
    {
      method: 'POST',
      schema: knowledgeDocumentSchema,
    },
  );
}

export function rollbackKnowledgeDocumentVersion(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
  input: RollbackKnowledgeDocumentVersionRequest,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/rollback`,
    {
      method: 'POST',
      body: rollbackKnowledgeDocumentVersionRequestSchema.parse(input),
      schema: knowledgeDocumentSchema,
    },
  );
}

export function testKnowledgeRetrieval(
  knowledgeBaseId: string,
  input: KnowledgeRetrievalTestRequest,
): Promise<KnowledgeRetrievalTestResponse> {
  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/retrieval-test`, {
    method: 'POST',
    body: knowledgeRetrievalTestRequestSchema.parse(input),
    schema: knowledgeRetrievalTestResponseSchema,
  });
}

export function rebuildKnowledgeDocumentEmbeddings(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
): Promise<KnowledgeEmbeddingRebuildResponse> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/rebuild-embeddings`,
    {
      method: 'POST',
      schema: knowledgeEmbeddingRebuildResponseSchema,
    },
  );
}
