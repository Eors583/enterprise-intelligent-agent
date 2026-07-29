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
  applyFeishuDirectoryPreviewRequestSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  completePasswordResetRequestSchema,
  completePasswordResetResponseSchema,
  createExperienceCandidateRequestSchema,
  createToolDefinitionRequestSchema,
  createToolVersionRequestSchema,
  createKnowledgeBaseRequestSchema,
  createKnowledgeDocumentRequestSchema,
  createKnowledgeGraphConflictRequestSchema,
  createKnowledgeGraphCorrectionRequestSchema,
  createKnowledgeOntologyRequestSchema,
  createKnowledgeOntologyVersionRequestSchema,
  createMemberRequestSchema,
  createOrgUnitRequestSchema,
  inviteMemberRequestSchema,
  issueMemberInvitationResponseSchema,
  feishuOrganizationSyncStatusSchema,
  feishuDirectoryPreviewSchema,
  feishuDirectorySyncRunDetailSchema,
  feishuDirectorySyncRunListSchema,
  experienceCandidateSchema,
  experienceKnowledgeProjectionSchema,
  experienceTransitionRequestSchema,
  prepareExperienceKnowledgeProjectionRequestSchema,
  knowledgeBaseSchema,
  knowledgeBaseIndexReadinessSchema,
  knowledgeBaseListResponseSchema,
  knowledgeDocumentChunkListResponseSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentVersionDetailSchema,
  knowledgeParseReviewQueueResponseSchema,
  knowledgeEmbeddingRebuildResponseSchema,
  knowledgeGraphRebuildResponseSchema,
  knowledgeGraphOverviewSchema,
  knowledgeGraphConflictSchema,
  knowledgeGraphCorrectionSchema,
  knowledgeGraphGovernanceOverviewSchema,
  knowledgeOntologySchema,
  knowledgeOntologyVersionSchema,
  knowledgeGraphQuerySchema,
  knowledgeGraphResponseSchema,
  knowledgeRetrievalTestRequestSchema,
  knowledgeRetrievalTestResponseSchema,
  importKnowledgeWebDocumentRequestSchema,
  reviewKnowledgeDocumentParseRequestSchema,
  reviewKnowledgeDocumentGovernanceRequestSchema,
  updateKnowledgeDocumentVersionGovernanceRequestSchema,
  transitionKnowledgeGraphCorrectionRequestSchema,
  transitionKnowledgeOntologyVersionRequestSchema,
  browserAuthSessionResponseSchema,
  browserLoginResultSchema,
  currentSessionResponseSchema,
  loginRequestSchema,
  mfaLoginVerifyRequestSchema,
  oidcLoginCallbackRequestSchema,
  oidcLoginStartRequestSchema,
  oidcLoginStartResponseSchema,
  oidcPublicProviderListResponseSchema,
  memberInvitationSchema,
  registerTenantRequestSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  resetMemberPasswordRequestSchema,
  resetMemberPasswordResponseSchema,
  createRoleBlueprintRequestSchema,
  createRoleVersionDraftRequestSchema,
  reviewRoleVersionRequestSchema,
  roleBlueprintListResponseSchema,
  roleBlueprintSchema,
  roleAssignmentCandidateListResponseSchema,
  roleAssignmentListResponseSchema,
  roleAssignmentSchema,
  roleVersionSchema,
  publishRoleVersionRequestSchema,
  roleVersionTransitionRequestSchema,
  rollbackRoleVersionRequestSchema,
  rollbackRoleVersionResponseSchema,
  createRoleAssignmentRequestSchema,
  revokeRoleAssignmentRequestSchema,
  rollbackKnowledgeDocumentVersionRequestSchema,
  publishKnowledgeDocumentVersionRequestSchema,
  updateKnowledgeBaseRequestSchema,
  updateKnowledgeDocumentRequestSchema,
  updateMemberRequestSchema,
  updateAdminAgentRequestSchema,
  updateAgentUsageLimitsRequestSchema,
  updateOrganizationRequestSchema,
  updateOrgUnitRequestSchema,
  updateRoleBlueprintRequestSchema,
  updateRoleVersionDraftRequestSchema,
  toolDefinitionDetailSchema,
  toolDefinitionListResponseSchema,
  toolDefinitionSchema,
  toolVersionLifecycleRequestSchema,
  toolVersionSchema,
  type AdminOrganizationResponse,
  type AdminAgent,
  type AdminAgentListResponse,
  type AdminAgentUsageSummary,
  type AgentRunResponse,
  type AgentUsageLimits,
  type AcceptMemberInvitationRequest,
  type AcceptMemberInvitationResponse,
  type BindFeishuOrganizationRequest,
  type ApplyFeishuDirectoryPreviewRequest,
  type BrowserAuthSessionResponse,
  type BrowserLoginResult,
  type CurrentSessionResponse,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type CompletePasswordResetRequest,
  type CompletePasswordResetResponse,
  type CreateExperienceCandidateRequest,
  type CreateToolDefinitionRequest,
  type CreateToolVersionRequest,
  type CreateKnowledgeBaseRequest,
  type CreateKnowledgeDocumentRequest,
  type CreateKnowledgeGraphConflictRequest,
  type CreateKnowledgeGraphCorrectionRequest,
  type CreateKnowledgeOntologyRequest,
  type CreateKnowledgeOntologyVersionRequest,
  type CreateMemberRequest,
  type CreateOrgUnitRequest,
  type FeishuOrganizationSyncStatus,
  type FeishuDirectoryPreview,
  type FeishuDirectorySyncRunDetail,
  type FeishuDirectorySyncRunList,
  type ExperienceCandidate,
  type ExperienceKnowledgeProjection,
  type ExperienceTransitionRequest,
  type PrepareExperienceKnowledgeProjectionRequest,
  type InviteMemberRequest,
  type IssueMemberInvitationResponse,
  type KnowledgeBase,
  type KnowledgeBaseIndexReadiness,
  type KnowledgeBaseListResponse,
  type KnowledgeDocumentChunkListResponse,
  type KnowledgeDocument,
  type KnowledgeDocumentGovernancePolicy,
  type KnowledgeDocumentVersionDetail,
  type KnowledgeParseReviewQueueResponse,
  type KnowledgeEmbeddingRebuildResponse,
  type KnowledgeGraphRebuildResponse,
  type KnowledgeGraphOverview,
  type KnowledgeGraphConflict,
  type KnowledgeGraphCorrection,
  type KnowledgeGraphGovernanceOverview,
  type KnowledgeGraphQuery,
  type KnowledgeGraphResponse,
  type KnowledgeOntology,
  type KnowledgeOntologyVersion,
  type KnowledgeRetrievalTestRequest,
  type KnowledgeRetrievalTestResponse,
  type ImportKnowledgeWebDocumentRequest,
  type ReviewKnowledgeDocumentParseRequest,
  type ReviewKnowledgeDocumentGovernanceRequest,
  type UpdateKnowledgeDocumentVersionGovernanceRequest,
  type TransitionKnowledgeGraphCorrectionRequest,
  type TransitionKnowledgeOntologyVersionRequest,
  type LoginRequest,
  type MfaLoginVerifyRequest,
  type OidcLoginCallbackRequest,
  type OidcLoginStartRequest,
  type OidcLoginStartResponse,
  type OidcPublicProviderListResponse,
  type MemberInvitation,
  type RegisterTenantRequest,
  type RequestPasswordResetRequest,
  type RequestPasswordResetResponse,
  type ResetMemberPasswordRequest,
  type ResetMemberPasswordResponse,
  type CreateRoleBlueprintRequest,
  type CreateRoleVersionDraftRequest,
  type ReviewRoleVersionRequest,
  type RoleBlueprint,
  type RoleBlueprintListResponse,
  type RoleAssignmentCandidateListResponse,
  type RoleAssignment,
  type RoleAssignmentListResponse,
  type RoleVersion,
  type PublishRoleVersionRequest,
  type RoleVersionTransitionRequest,
  type RollbackRoleVersionRequest,
  type RollbackRoleVersionResponse,
  type CreateRoleAssignmentRequest,
  type RevokeRoleAssignmentRequest,
  type RollbackKnowledgeDocumentVersionRequest,
  type PublishKnowledgeDocumentVersionRequest,
  type UpdateKnowledgeBaseRequest,
  type UpdateKnowledgeDocumentRequest,
  type UpdateMemberRequest,
  type UpdateAdminAgentRequest,
  type UpdateAgentUsageLimitsRequest,
  type UpdateOrganizationRequest,
  type UpdateOrgUnitRequest,
  type UpdateRoleBlueprintRequest,
  type UpdateRoleVersionDraftRequest,
  type ToolDefinition,
  type ToolDefinitionDetail,
  type ToolDefinitionListResponse,
  type ToolVersion,
  type ToolVersionLifecycleRequest,
} from '@enterprise/contracts';
import { z } from 'zod';

import { request } from './client';

const mutationResponseSchema = z.unknown();
const experienceListResponseSchema = z
  .object({
    items: z.array(experienceCandidateSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export interface ExperienceListResponse {
  readonly items: readonly ExperienceCandidate[];
  readonly nextCursor: string | null;
}

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

export function getFeishuDirectoryPreview(
  signal?: AbortSignal,
): Promise<FeishuDirectoryPreview | null> {
  return request('/admin/integrations/feishu/organization-sync/preview', {
    schema: feishuDirectoryPreviewSchema.nullable(),
    ...(signal ? { signal } : {}),
  });
}

export function createFeishuDirectoryPreview(): Promise<FeishuDirectoryPreview> {
  return request('/admin/integrations/feishu/organization-sync/preview', {
    method: 'POST',
    schema: feishuDirectoryPreviewSchema,
  });
}

export function applyFeishuDirectoryPreview(
  input: ApplyFeishuDirectoryPreviewRequest,
): Promise<FeishuDirectorySyncRunDetail> {
  return request('/admin/integrations/feishu/organization-sync/runs', {
    method: 'POST',
    body: applyFeishuDirectoryPreviewRequestSchema.parse(input),
    schema: feishuDirectorySyncRunDetailSchema,
  });
}

export function listFeishuDirectorySyncRuns(
  signal?: AbortSignal,
): Promise<FeishuDirectorySyncRunList> {
  return request('/admin/integrations/feishu/organization-sync/runs', {
    schema: feishuDirectorySyncRunListSchema,
    ...(signal ? { signal } : {}),
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

export function issueDirectoryMemberInvitation(
  memberId: string,
): Promise<IssueMemberInvitationResponse> {
  return request(`/admin/members/${encodeURIComponent(memberId)}/invitation`, {
    method: 'POST',
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

export function listRoleAssignments(signal?: AbortSignal): Promise<RoleAssignmentListResponse> {
  return request('/admin/role-assignments', {
    schema: roleAssignmentListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function listExperienceCandidates(
  input: { readonly status?: ExperienceCandidate['status']; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<ExperienceListResponse> {
  const search = new URLSearchParams({ limit: String(input.limit ?? 100) });
  if (input.status) search.set('status', input.status);
  return request(`/admin/experiences?${search.toString()}`, {
    schema: experienceListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getExperienceCandidate(
  experienceId: string,
  signal?: AbortSignal,
): Promise<ExperienceCandidate> {
  return request(`/admin/experiences/${encodeURIComponent(experienceId)}`, {
    schema: experienceCandidateSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createExperienceCandidate(
  input: CreateExperienceCandidateRequest,
): Promise<ExperienceCandidate> {
  return request('/admin/experiences', {
    method: 'POST',
    body: createExperienceCandidateRequestSchema.parse(input),
    schema: experienceCandidateSchema,
  });
}

export function transitionExperienceCandidate(
  experienceId: string,
  input: ExperienceTransitionRequest,
): Promise<ExperienceCandidate> {
  return request(`/admin/experiences/${encodeURIComponent(experienceId)}/transitions`, {
    method: 'POST',
    body: experienceTransitionRequestSchema.parse(input),
    schema: experienceCandidateSchema,
  });
}

export function getExperienceKnowledgeProjection(
  experienceId: string,
  signal?: AbortSignal,
): Promise<ExperienceKnowledgeProjection> {
  return request(`/admin/experiences/${encodeURIComponent(experienceId)}/knowledge-projection`, {
    schema: experienceKnowledgeProjectionSchema,
    ...(signal ? { signal } : {}),
  });
}

export function prepareExperienceKnowledgeProjection(
  experienceId: string,
  input: PrepareExperienceKnowledgeProjectionRequest,
): Promise<ExperienceKnowledgeProjection> {
  return request(`/admin/experiences/${encodeURIComponent(experienceId)}/knowledge-projection`, {
    method: 'POST',
    body: prepareExperienceKnowledgeProjectionRequestSchema.parse(input),
    schema: experienceKnowledgeProjectionSchema,
  });
}

export function listToolDefinitions(signal?: AbortSignal): Promise<ToolDefinitionListResponse> {
  return request('/admin/tool-definitions', {
    schema: toolDefinitionListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getToolDefinition(
  toolId: string,
  signal?: AbortSignal,
): Promise<ToolDefinitionDetail> {
  return request(`/admin/tool-definitions/${encodeURIComponent(toolId)}`, {
    schema: toolDefinitionDetailSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createToolDefinition(input: CreateToolDefinitionRequest): Promise<ToolDefinition> {
  return request('/admin/tool-definitions', {
    method: 'POST',
    body: createToolDefinitionRequestSchema.parse(input),
    schema: toolDefinitionSchema,
  });
}

export function createToolVersion(
  toolId: string,
  input: CreateToolVersionRequest,
): Promise<ToolVersion> {
  return request(`/admin/tool-definitions/${encodeURIComponent(toolId)}/versions`, {
    method: 'POST',
    body: createToolVersionRequestSchema.parse(input),
    schema: toolVersionSchema,
  });
}

export function transitionToolVersion(
  toolId: string,
  toolVersionId: string,
  input: ToolVersionLifecycleRequest,
): Promise<ToolDefinitionDetail> {
  return request(
    `/admin/tool-definitions/${encodeURIComponent(toolId)}/versions/${encodeURIComponent(toolVersionId)}/lifecycle`,
    {
      method: 'POST',
      body: toolVersionLifecycleRequestSchema.parse(input),
      schema: toolDefinitionDetailSchema,
    },
  );
}

export function createRoleAssignment(input: CreateRoleAssignmentRequest): Promise<RoleAssignment> {
  return request('/admin/role-assignments', {
    method: 'POST',
    body: createRoleAssignmentRequestSchema.parse(input),
    schema: roleAssignmentSchema,
  });
}

export function revokeRoleAssignment(
  id: string,
  input: RevokeRoleAssignmentRequest,
): Promise<RoleAssignment> {
  return request(`/admin/role-assignments/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: revokeRoleAssignmentRequestSchema.parse(input),
    schema: roleAssignmentSchema,
  });
}

export function listRoleAssignmentCandidates(
  signal?: AbortSignal,
): Promise<RoleAssignmentCandidateListResponse> {
  return request('/admin/role-blueprints/assignment-candidates', {
    schema: roleAssignmentCandidateListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function listRoleBlueprints(signal?: AbortSignal): Promise<RoleBlueprintListResponse> {
  return request('/admin/role-blueprints', {
    schema: roleBlueprintListResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createRoleBlueprint(input: CreateRoleBlueprintRequest): Promise<RoleBlueprint> {
  return request('/admin/role-blueprints', {
    method: 'POST',
    body: createRoleBlueprintRequestSchema.parse(input),
    schema: roleBlueprintSchema,
  });
}

export function updateRoleBlueprint(
  blueprintId: string,
  input: UpdateRoleBlueprintRequest,
): Promise<RoleBlueprint> {
  return request(`/admin/role-blueprints/${encodeURIComponent(blueprintId)}`, {
    method: 'PATCH',
    body: updateRoleBlueprintRequestSchema.parse(input),
    schema: roleBlueprintSchema,
  });
}

export function createRoleVersionDraft(
  blueprintId: string,
  input: CreateRoleVersionDraftRequest,
): Promise<RoleVersion> {
  return request(`/admin/role-blueprints/${encodeURIComponent(blueprintId)}/versions`, {
    method: 'POST',
    body: createRoleVersionDraftRequestSchema.parse(input),
    schema: roleVersionSchema,
  });
}

export function updateRoleVersionDraft(
  blueprintId: string,
  versionId: string,
  input: UpdateRoleVersionDraftRequest,
): Promise<RoleVersion> {
  return request(
    `/admin/role-blueprints/${encodeURIComponent(blueprintId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'PATCH',
      body: updateRoleVersionDraftRequestSchema.parse(input),
      schema: roleVersionSchema,
    },
  );
}

export function submitRoleVersion(
  blueprintId: string,
  versionId: string,
  input: RoleVersionTransitionRequest,
): Promise<RoleVersion> {
  return transitionRoleVersion(blueprintId, versionId, 'submit', input);
}

export function reviewRoleVersion(
  blueprintId: string,
  versionId: string,
  input: ReviewRoleVersionRequest,
): Promise<RoleVersion> {
  return request(
    `/admin/role-blueprints/${encodeURIComponent(blueprintId)}/versions/${encodeURIComponent(versionId)}/review`,
    {
      method: 'POST',
      body: reviewRoleVersionRequestSchema.parse(input),
      schema: roleVersionSchema,
    },
  );
}

export function publishRoleVersion(
  blueprintId: string,
  versionId: string,
  input: PublishRoleVersionRequest,
): Promise<RoleVersion> {
  return request(
    `/admin/role-blueprints/${encodeURIComponent(blueprintId)}/versions/${encodeURIComponent(versionId)}/publish`,
    {
      method: 'POST',
      body: publishRoleVersionRequestSchema.parse(input),
      schema: roleVersionSchema,
    },
  );
}

export function retireRoleVersion(
  blueprintId: string,
  versionId: string,
  input: RoleVersionTransitionRequest,
): Promise<RoleVersion> {
  return transitionRoleVersion(blueprintId, versionId, 'retire', input);
}

export function rollbackRoleVersion(
  blueprintId: string,
  sourceVersionId: string,
  input: RollbackRoleVersionRequest,
): Promise<RollbackRoleVersionResponse> {
  return request(
    `/admin/role-blueprints/${encodeURIComponent(blueprintId)}/versions/${encodeURIComponent(sourceVersionId)}/rollback`,
    {
      method: 'POST',
      body: rollbackRoleVersionRequestSchema.parse(input),
      schema: rollbackRoleVersionResponseSchema,
    },
  );
}

function transitionRoleVersion(
  blueprintId: string,
  versionId: string,
  action: 'submit' | 'retire',
  input: RoleVersionTransitionRequest,
): Promise<RoleVersion> {
  return request(
    `/admin/role-blueprints/${encodeURIComponent(blueprintId)}/versions/${encodeURIComponent(versionId)}/${action}`,
    {
      method: 'POST',
      body: roleVersionTransitionRequestSchema.parse(input),
      schema: roleVersionSchema,
    },
  );
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

export function getKnowledgeGraphOverview(
  knowledgeBaseId: string,
  signal?: AbortSignal,
): Promise<KnowledgeGraphOverview> {
  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-overview`, {
    schema: knowledgeGraphOverviewSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getKnowledgeGraph(
  knowledgeBaseId: string,
  input: KnowledgeGraphQuery = { limit: 50 },
  signal?: AbortSignal,
): Promise<KnowledgeGraphResponse> {
  const parsed = knowledgeGraphQuerySchema.parse(input);
  const search = new URLSearchParams({ limit: String(parsed.limit) });
  if (parsed.query) search.set('query', parsed.query);
  if (parsed.entityType) search.set('entityType', parsed.entityType);
  if (parsed.focusEntityId) search.set('focusEntityId', parsed.focusEntityId);
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph?${search.toString()}`,
    {
      schema: knowledgeGraphResponseSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export function getKnowledgeGraphGovernance(
  knowledgeBaseId: string,
  signal?: AbortSignal,
): Promise<KnowledgeGraphGovernanceOverview> {
  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance`, {
    schema: knowledgeGraphGovernanceOverviewSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createKnowledgeOntology(
  knowledgeBaseId: string,
  input: CreateKnowledgeOntologyRequest,
): Promise<KnowledgeOntology> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance/ontologies`,
    {
      method: 'POST',
      body: createKnowledgeOntologyRequestSchema.parse(input),
      schema: knowledgeOntologySchema,
    },
  );
}

export function createKnowledgeOntologyVersion(
  knowledgeBaseId: string,
  ontologyId: string,
  input: CreateKnowledgeOntologyVersionRequest,
): Promise<KnowledgeOntologyVersion> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance/ontologies/${encodeURIComponent(ontologyId)}/versions`,
    {
      method: 'POST',
      body: createKnowledgeOntologyVersionRequestSchema.parse(input),
      schema: knowledgeOntologyVersionSchema,
    },
  );
}

export function transitionKnowledgeOntologyVersion(
  knowledgeBaseId: string,
  versionId: string,
  input: TransitionKnowledgeOntologyVersionRequest,
): Promise<KnowledgeOntologyVersion> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance/ontology-versions/${encodeURIComponent(versionId)}/transitions`,
    {
      method: 'POST',
      body: transitionKnowledgeOntologyVersionRequestSchema.parse(input),
      schema: knowledgeOntologyVersionSchema,
    },
  );
}

export function createKnowledgeGraphConflict(
  knowledgeBaseId: string,
  input: CreateKnowledgeGraphConflictRequest,
): Promise<KnowledgeGraphConflict> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance/conflicts`,
    {
      method: 'POST',
      body: createKnowledgeGraphConflictRequestSchema.parse(input),
      schema: knowledgeGraphConflictSchema,
    },
  );
}

export function createKnowledgeGraphCorrection(
  knowledgeBaseId: string,
  input: CreateKnowledgeGraphCorrectionRequest,
): Promise<KnowledgeGraphCorrection> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance/corrections`,
    {
      method: 'POST',
      body: createKnowledgeGraphCorrectionRequestSchema.parse(input),
      schema: knowledgeGraphCorrectionSchema,
    },
  );
}

export function transitionKnowledgeGraphCorrection(
  knowledgeBaseId: string,
  correctionId: string,
  input: TransitionKnowledgeGraphCorrectionRequest,
): Promise<KnowledgeGraphCorrection> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph-governance/corrections/${encodeURIComponent(correctionId)}/transitions`,
    {
      method: 'POST',
      body: transitionKnowledgeGraphCorrectionRequestSchema.parse(input),
      schema: knowledgeGraphCorrectionSchema,
    },
  );
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
  input: {
    file: File;
    title: string;
    changeSummary?: string;
    governance?: KnowledgeDocumentGovernancePolicy;
  },
): Promise<KnowledgeDocument> {
  const body = new FormData();
  body.append('file', input.file, input.file.name);
  body.append('title', input.title.trim());
  if (input.changeSummary?.trim()) body.append('changeSummary', input.changeSummary.trim());
  if (input.governance !== undefined) {
    body.append('governance', JSON.stringify(input.governance));
  }

  return request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/upload`, {
    method: 'POST',
    body,
    schema: knowledgeDocumentSchema,
  });
}

export function importKnowledgeWebDocument(
  knowledgeBaseId: string,
  input: ImportKnowledgeWebDocumentRequest,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/import-web`,
    {
      method: 'POST',
      body: importKnowledgeWebDocumentRequestSchema.parse(input),
      schema: knowledgeDocumentSchema,
    },
  );
}

export function listPendingKnowledgeParseReviews(
  knowledgeBaseId: string,
  signal?: AbortSignal,
): Promise<KnowledgeParseReviewQueueResponse> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/parse-review-queue`,
    {
      schema: knowledgeParseReviewQueueResponseSchema,
      ...(signal ? { signal } : {}),
    },
  );
}

export function reviewKnowledgeDocumentParse(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
  input: ReviewKnowledgeDocumentParseRequest,
): Promise<KnowledgeDocumentVersionDetail> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/parse-review`,
    {
      method: 'POST',
      body: reviewKnowledgeDocumentParseRequestSchema.parse(input),
      schema: knowledgeDocumentVersionDetailSchema,
    },
  );
}

export function updateKnowledgeDocumentVersionGovernance(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
  input: UpdateKnowledgeDocumentVersionGovernanceRequest,
): Promise<KnowledgeDocumentVersionDetail> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/governance`,
    {
      method: 'PATCH',
      body: updateKnowledgeDocumentVersionGovernanceRequestSchema.parse(input),
      schema: knowledgeDocumentVersionDetailSchema,
    },
  );
}

export function reviewKnowledgeDocumentGovernance(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
  input: ReviewKnowledgeDocumentGovernanceRequest,
): Promise<KnowledgeDocumentVersionDetail> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/governance-review`,
    {
      method: 'POST',
      body: reviewKnowledgeDocumentGovernanceRequestSchema.parse(input),
      schema: knowledgeDocumentVersionDetailSchema,
    },
  );
}

export function uploadKnowledgeDocumentVersion(
  knowledgeBaseId: string,
  documentId: string,
  input: {
    file: File;
    changeSummary?: string;
    governance?: KnowledgeDocumentGovernancePolicy;
  },
): Promise<KnowledgeDocument> {
  const body = new FormData();
  body.append('file', input.file, input.file.name);
  if (input.changeSummary?.trim()) body.append('changeSummary', input.changeSummary.trim());
  if (input.governance !== undefined) {
    body.append('governance', JSON.stringify(input.governance));
  }

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
  input: PublishKnowledgeDocumentVersionRequest,
): Promise<KnowledgeDocument> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/publish`,
    {
      method: 'POST',
      body: publishKnowledgeDocumentVersionRequestSchema.parse(input),
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

export function rebuildKnowledgeDocumentGraph(
  knowledgeBaseId: string,
  documentId: string,
  versionId: string,
): Promise<KnowledgeGraphRebuildResponse> {
  return request(
    `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/rebuild-graph`,
    {
      method: 'POST',
      schema: knowledgeGraphRebuildResponseSchema,
    },
  );
}
