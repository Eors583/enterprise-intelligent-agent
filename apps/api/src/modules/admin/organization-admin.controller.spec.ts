import { describe, expect, it, vi } from 'vitest';

import { OrganizationAdminController } from './organization-admin.controller.js';
import type { OrganizationAdminService } from './organization-admin.service.js';
import type { MemberInvitationService } from './member-invitation.service.js';

const MEMBER_ID = '00000000-0000-7000-8000-000000000102';

describe('OrganizationAdminController member password reset', () => {
  it('delegates the validated temporary password and returns no credential material', async () => {
    const resetMemberPassword = vi.fn().mockResolvedValue({
      memberId: MEMBER_ID,
      passwordChangeRequired: true,
      revokedSessionCount: 4,
    });
    const controller = new OrganizationAdminController(
      {
        resetMemberPassword,
      } as unknown as OrganizationAdminService,
      {} as MemberInvitationService,
    );

    const result = await controller.resetMemberPassword(MEMBER_ID, {
      temporaryPassword: 'TemporaryPassword!2026',
    });

    expect(resetMemberPassword).toHaveBeenCalledWith(MEMBER_ID, {
      temporaryPassword: 'TemporaryPassword!2026',
    });
    expect(result).toEqual({
      memberId: MEMBER_ID,
      passwordChangeRequired: true,
      revokedSessionCount: 4,
    });
    expect(result).not.toHaveProperty('temporaryPassword');
  });
});
