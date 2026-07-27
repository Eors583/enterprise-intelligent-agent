import { describe, expect, it } from 'vitest';

import {
  acceptMemberInvitationRequestSchema,
  completePasswordResetRequestSchema,
  inviteMemberRequestSchema,
  issueMemberInvitationResponseSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
} from '../src/index.js';

const resetToken = `ea_reset_${'a'.repeat(43)}`;
const inviteToken = `ea_invite_${'b'.repeat(43)}`;

describe('account recovery contracts', () => {
  it('normalizes public password-reset identity input', () => {
    expect(
      requestPasswordResetRequestSchema.parse({
        tenantSlug: ' ACME ',
        email: 'Owner@Example.com',
      }),
    ).toEqual({ tenantSlug: 'acme', email: 'owner@example.com' });
  });

  it('keeps the password-reset request response enumeration-safe', () => {
    expect(
      requestPasswordResetResponseSchema.parse({
        accepted: true,
        message: 'If the account is eligible, a message will be sent.',
      }),
    ).toEqual({
      accepted: true,
      message: 'If the account is eligible, a message will be sent.',
    });
  });

  it('requires purpose-bound opaque tokens and a strong replacement password', () => {
    expect(
      completePasswordResetRequestSchema.safeParse({
        token: inviteToken,
        newPassword: 'long-pass-1',
      }).success,
    ).toBe(false);
    expect(
      acceptMemberInvitationRequestSchema.safeParse({
        token: resetToken,
        newPassword: 'long-pass-1',
      }).success,
    ).toBe(false);
    expect(
      completePasswordResetRequestSchema.parse({ token: resetToken, newPassword: 'long-pass-1' }),
    ).toEqual({ token: resetToken, newPassword: 'long-pass-1' });
  });

  it('models invitation issue responses while keeping passwords out of invite input', () => {
    const invite = inviteMemberRequestSchema.parse({
      email: 'member@example.com',
      displayName: 'Member',
      role: 'MEMBER',
      orgUnitId: '00000000-0000-7000-8000-000000000111',
    });
    expect(invite).not.toHaveProperty('password');
    expect(
      issueMemberInvitationResponseSchema.parse({
        id: '00000000-0000-7000-8000-000000000211',
        memberId: '00000000-0000-7000-8000-000000000212',
        email: 'member@example.com',
        displayName: 'Member',
        status: 'SENT',
        deliveryStatus: 'SENT',
        issuedAt: '2026-07-22T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        consumedAt: null,
        acceptanceToken: inviteToken,
        acceptanceUrl: `https://example.com/#/accept-invitation?token=${inviteToken}`,
      }).acceptanceToken,
    ).toBe(inviteToken);
  });
});
