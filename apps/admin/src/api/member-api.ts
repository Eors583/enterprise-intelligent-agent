import {
  adminOrganizationResponseSchema,
  inviteMemberRequestSchema,
  issueMemberInvitationResponseSchema,
  memberInvitationSchema,
  resetMemberPasswordRequestSchema,
  resetMemberPasswordResponseSchema,
  updateMemberRequestSchema,
  type AdminOrganizationResponse,
  type InviteMemberRequest,
  type IssueMemberInvitationResponse,
  type MemberInvitation,
  type ResetMemberPasswordRequest,
  type ResetMemberPasswordResponse,
  type UpdateMemberRequest,
} from '@enterprise/contracts/admin';
import { z } from 'zod';

import { request } from './client';

const mutationResponseSchema = z.unknown();

export function getOrganization(signal?: AbortSignal): Promise<AdminOrganizationResponse> {
  return request('/admin/organization', {
    schema: adminOrganizationResponseSchema,
    ...(signal ? { signal } : {}),
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
