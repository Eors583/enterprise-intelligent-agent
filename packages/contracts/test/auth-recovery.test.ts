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

  it('never exposes an acceptance capability after successful email delivery', () => {
    const invite = inviteMemberRequestSchema.parse({
      email: 'member@example.com',
      displayName: 'Member',
      role: 'MEMBER',
      orgUnitId: '00000000-0000-7000-8000-000000000111',
    });
    expect(invite).not.toHaveProperty('password');
    const response = issueMemberInvitationResponseSchema.parse({
      id: '00000000-0000-7000-8000-000000000211',
      memberId: '00000000-0000-7000-8000-000000000212',
      email: 'member@example.com',
      displayName: 'Member',
      status: 'SENT',
      deliveryStatus: 'SENT',
      deliveryTargetEvidence: 'ISSUED',
      issuedAt: '2026-07-22T00:00:00.000Z',
      expiresAt: '2026-07-29T00:00:00.000Z',
      consumedAt: null,
      deliveryKind: 'EMAIL_SENT',
      fallback: null,
    });
    expect(response).not.toHaveProperty('acceptanceToken');
    expect(response).not.toHaveProperty('acceptanceUrl');
    expect(
      issueMemberInvitationResponseSchema.safeParse({
        ...response,
        acceptanceToken: inviteToken,
        acceptanceUrl: `https://example.com/#/accept-invitation?token=${inviteToken}`,
      }).success,
    ).toBe(false);
  });

  it('models a short-lived explicit manual fallback without a separate raw token', () => {
    const response = issueMemberInvitationResponseSchema.parse({
      id: '00000000-0000-7000-8000-000000000211',
      memberId: '00000000-0000-7000-8000-000000000212',
      email: 'member@example.com',
      displayName: 'Member',
      status: 'PENDING',
      deliveryStatus: 'NOT_CONFIGURED',
      deliveryTargetEvidence: 'ISSUED',
      issuedAt: '2026-07-22T00:00:00.000Z',
      expiresAt: '2026-07-22T00:15:00.000Z',
      consumedAt: null,
      deliveryKind: 'MANUAL_FALLBACK',
      fallback: {
        kind: 'MANUAL_FALLBACK',
        acceptanceUrl: `https://example.com/#/accept-invitation?token=${inviteToken}`,
        expiresAt: '2026-07-22T00:15:00.000Z',
      },
    });
    expect(response.fallback?.acceptanceUrl).toContain(inviteToken);
    expect(response).not.toHaveProperty('acceptanceToken');
  });
});
