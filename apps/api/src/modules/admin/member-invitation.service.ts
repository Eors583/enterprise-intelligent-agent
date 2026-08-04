import { randomBytes } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  InviteMemberRequest,
  IssueMemberInvitationResponse,
  MemberInvitation,
} from '@enterprise/contracts';
import { Prisma } from '@prisma/client';

import type { EnvironmentVariables } from '../../config/environment.js';
import { AdminPrismaService } from '../../database/admin-prisma.service.js';
import { AuthRecoveryNotificationService } from '../auth/application/auth-recovery-notification.service.js';
import { PasswordHasher } from '../auth/application/password-hasher.js';
import { TokenService } from '../auth/application/token.service.js';
import { AdminAccessService } from './admin-access.service.js';
import { recordAdminAudit } from './admin-audit.js';
import { lockOrganizationDirectory } from './organization-directory-lock.js';

type InvitationRecord = Prisma.AuthActionTokenGetPayload<{
  include: { user: true };
}>;

@Injectable()
export class MemberInvitationService {
  private readonly invitationTtlSeconds: number;
  private readonly fallbackTtlSeconds: number;

  constructor(
    @Inject(AdminPrismaService) private readonly prisma: AdminPrismaService,
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthRecoveryNotificationService)
    private readonly notifications: AuthRecoveryNotificationService,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.invitationTtlSeconds =
      config.get('AUTH_MEMBER_INVITATION_TTL_SECONDS', { infer: true }) ?? 604_800;
    this.fallbackTtlSeconds =
      config.get('AUTH_MEMBER_INVITATION_FALLBACK_TTL_SECONDS', { infer: true }) ?? 900;
  }

  async list(): Promise<ReadonlyArray<MemberInvitation>> {
    const principal = this.access.requireDirectoryRead();
    return this.prisma.withTenant(principal.tenantId, async (transaction) => {
      const rows = await transaction.authActionToken.findMany({
        where: { tenantId: principal.tenantId, purpose: 'MEMBER_INVITATION' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['userId'],
        include: { user: true },
      });
      return rows.map((row) => mapInvitation(row, new Date()));
    });
  }

  async invite(request: InviteMemberRequest): Promise<IssueMemberInvitationResponse> {
    const principal = this.access.requireDirectoryWrite();
    this.access.assertCanAssignRole(principal, request.role);

    // Invited accounts receive an unknowable placeholder credential and remain
    // inactive until their one-time invitation is consumed.
    const placeholderHash = await this.passwords.hash(randomBytes(32).toString('base64url'));
    const opaque = this.tokens.issueAction('invite');
    const issuedAt = new Date();
    const expiresAt = addSeconds(issuedAt, this.invitationTtlSeconds);

    let created: { readonly invitation: InvitationRecord; readonly tenantName: string };
    try {
      created = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
        const organization = await transaction.organization.findFirst({
          where: { tenantId: principal.tenantId },
          orderBy: { createdAt: 'asc' },
        });
        if (organization === null) throw new NotFoundException('The organization was not found.');
        await lockOrganizationDirectory(transaction, principal.tenantId, organization.id);
        const unit = await transaction.orgUnit.findFirst({
          where: {
            id: request.orgUnitId,
            tenantId: principal.tenantId,
            organizationId: organization.id,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (unit === null) throw new NotFoundException('The organization unit was not found.');

        const user = await transaction.user.create({
          data: {
            tenantId: principal.tenantId,
            email: request.email,
            emailNormalized: request.email,
            displayName: request.displayName,
            status: 'INACTIVE',
            role: request.role,
          },
        });
        await transaction.passwordCredential.create({
          data: {
            tenantId: principal.tenantId,
            userId: user.id,
            passwordHash: placeholderHash,
            mustChangePassword: true,
          },
        });
        const positionId =
          request.title === undefined
            ? null
            : await upsertInvitationPosition(
                transaction,
                principal.tenantId,
                organization.id,
                user.id,
                request.orgUnitId,
                request.title,
              );
        await transaction.employment.create({
          data: {
            tenantId: principal.tenantId,
            userId: user.id,
            organizationId: organization.id,
            orgUnitId: request.orgUnitId,
            positionId,
            workEmail: request.email,
            status: 'PENDING',
            isPrimary: true,
            ...(request.employeeNumber === undefined
              ? {}
              : { employeeNumber: request.employeeNumber }),
          },
        });
        const invitation = await transaction.authActionToken.create({
          data: {
            tenantId: principal.tenantId,
            userId: user.id,
            purpose: 'MEMBER_INVITATION',
            tokenHash: opaque.hash,
            deliveryTargetEmail: request.email,
            deliveryTargetEvidence: 'ISSUED',
            deliveryStatus: 'PENDING',
            expiresAt,
            createdById: principal.userId,
          },
          include: { user: true },
        });
        await recordAdminAudit(transaction, principal, 'admin.member.invited', 'user', user.id, {
          role: user.role,
          orgUnitId: request.orgUnitId,
          expiresAt: expiresAt.toISOString(),
        });
        const tenant = await transaction.tenant.findUniqueOrThrow({
          where: { id: principal.tenantId },
          select: { name: true },
        });
        return { invitation, tenantName: tenant.name };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('A member with this email or employee number already exists.');
      }
      throw error;
    }

    return this.deliver(
      created.invitation,
      created.tenantName,
      opaque.value,
      created.invitation.user.email,
      principal,
    );
  }

  async issueForDirectoryMember(memberId: string): Promise<IssueMemberInvitationResponse> {
    const principal = this.access.requireDirectoryWrite();
    const opaque = this.tokens.issueAction('invite');
    const issuedAt = new Date();
    const expiresAt = addSeconds(issuedAt, this.invitationTtlSeconds);

    const created = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPasswordFlow(transaction, principal.tenantId, memberId);
      const member = await transaction.user.findFirst({
        where: {
          id: memberId,
          tenantId: principal.tenantId,
          status: 'ACTIVE',
          directoryBindings: { some: { integration: { provider: 'FEISHU' } } },
        },
        include: {
          passwordCredential: true,
          employments: {
            where: { status: 'ACTIVE', workEmail: { not: null } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { workEmail: true },
          },
        },
      });
      if (member === null) {
        throw new NotFoundException('The active Feishu directory member was not found.');
      }
      this.access.assertCanManageMember(principal, member.role);
      if (member.passwordCredential !== null) {
        throw new ConflictException(
          'This member already has a local password credential. Use password reset instead.',
        );
      }
      const deliveryEmail = requireSingleWorkEmail(member.employments);

      await transaction.authActionToken.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: member.id,
          purpose: 'MEMBER_INVITATION',
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: issuedAt },
      });
      const invitation = await transaction.authActionToken.create({
        data: {
          tenantId: principal.tenantId,
          userId: member.id,
          purpose: 'MEMBER_INVITATION',
          tokenHash: opaque.hash,
          deliveryTargetEmail: deliveryEmail,
          deliveryTargetEvidence: 'ISSUED',
          deliveryStatus: 'PENDING',
          expiresAt,
          createdById: principal.userId,
        },
        include: { user: true },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.directory_member.invited',
        'user',
        member.id,
        { expiresAt: expiresAt.toISOString(), source: 'FEISHU' },
      );
      const tenant = await transaction.tenant.findUniqueOrThrow({
        where: { id: principal.tenantId },
        select: { name: true },
      });
      return { invitation, tenantName: tenant.name, deliveryEmail };
    });

    return this.deliver(
      created.invitation,
      created.tenantName,
      opaque.value,
      created.deliveryEmail,
      principal,
    );
  }

  async resend(memberId: string): Promise<IssueMemberInvitationResponse> {
    const principal = this.access.requireDirectoryWrite();
    const opaque = this.tokens.issueAction('invite');
    const issuedAt = new Date();
    const expiresAt = addSeconds(issuedAt, this.invitationTtlSeconds);

    const created = await this.prisma.withTenant(principal.tenantId, async (transaction) => {
      await lockPasswordFlow(transaction, principal.tenantId, memberId);
      const member = await transaction.user.findFirst({
        where: { id: memberId, tenantId: principal.tenantId },
        include: {
          directoryBindings: { select: { id: true } },
          employments: {
            where: { status: { not: 'TERMINATED' }, workEmail: { not: null } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { workEmail: true, status: true },
          },
          authActionTokens: {
            where: { purpose: 'MEMBER_INVITATION' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      });
      if (member === null) throw new NotFoundException('The member was not found.');
      this.access.assertCanManageMember(principal, member.role);
      const latest = member.authActionTokens[0];
      if (latest === undefined) {
        throw new ConflictException('This member was not created through an invitation.');
      }
      if (latest.consumedAt !== null) {
        throw new ConflictException('This invitation has already been accepted.');
      }
      if (member.directoryBindings.length > 0 && member.status !== 'ACTIVE') {
        throw new ConflictException('An inactive directory member cannot be invited.');
      }
      const deliveryEmail =
        member.directoryBindings.length === 0
          ? member.email
          : requireSingleWorkEmail(
              member.employments.filter((employment) => employment.status === 'ACTIVE'),
            );

      await transaction.authActionToken.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: member.id,
          purpose: 'MEMBER_INVITATION',
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: issuedAt },
      });
      const invitation = await transaction.authActionToken.create({
        data: {
          tenantId: principal.tenantId,
          userId: member.id,
          purpose: 'MEMBER_INVITATION',
          tokenHash: opaque.hash,
          deliveryTargetEmail: deliveryEmail,
          deliveryTargetEvidence: 'ISSUED',
          deliveryStatus: 'PENDING',
          expiresAt,
          createdById: principal.userId,
        },
        include: { user: true },
      });
      await recordAdminAudit(
        transaction,
        principal,
        'admin.member.invitation_resent',
        'user',
        member.id,
        { expiresAt: expiresAt.toISOString(), replacedInvitationId: latest.id },
      );
      const tenant = await transaction.tenant.findUniqueOrThrow({
        where: { id: principal.tenantId },
        select: { name: true },
      });
      return {
        invitation,
        tenantName: tenant.name,
        deliveryEmail,
      };
    });

    return this.deliver(
      created.invitation,
      created.tenantName,
      opaque.value,
      created.deliveryEmail,
      principal,
    );
  }

  private async deliver(
    invitation: InvitationRecord,
    tenantName: string,
    rawToken: string,
    deliveryEmail: string,
    principal: { readonly tenantId: string; readonly userId: string },
  ): Promise<IssueMemberInvitationResponse> {
    const deliveryStatus = await this.notifications.sendMemberInvitation({
      email: deliveryEmail,
      displayName: invitation.user.displayName,
      tenantName,
      token: rawToken,
    });
    const fallbackExpiresAt = addSeconds(new Date(), this.fallbackTtlSeconds);
    const updated = await this.prisma.withTenant(invitation.tenantId, async (transaction) => {
      const row = await transaction.authActionToken.update({
        where: { id: invitation.id },
        data: {
          deliveryStatus,
          ...(deliveryStatus === 'SENT' ? {} : { expiresAt: fallbackExpiresAt }),
          ...(deliveryStatus === 'NOT_CONFIGURED'
            ? {}
            : { deliveryAttempts: { increment: 1 }, lastDeliveryAt: new Date() }),
        },
        include: { user: true },
      });
      if (deliveryStatus !== 'SENT') {
        await recordAdminAudit(
          transaction,
          principal,
          'admin.member.invitation_manual_fallback_issued',
          'auth_action_token',
          invitation.id,
          {
            deliveryStatus,
            expiresAt: row.expiresAt.toISOString(),
            oneTime: true,
          },
        );
      }
      return row;
    });
    const response = {
      ...mapInvitation(updated, new Date()),
      email: deliveryEmail,
    };
    if (deliveryStatus === 'SENT') {
      return { ...response, deliveryKind: 'EMAIL_SENT', fallback: null };
    }
    return {
      ...response,
      deliveryKind: 'MANUAL_FALLBACK',
      fallback: {
        kind: 'MANUAL_FALLBACK',
        acceptanceUrl: this.notifications.actionUrl('accept-invitation', rawToken),
        expiresAt: updated.expiresAt.toISOString(),
      },
    };
  }
}

function mapInvitation(record: InvitationRecord, now: Date): MemberInvitation {
  return {
    id: record.id,
    memberId: record.userId,
    email: record.deliveryTargetEmail,
    deliveryTargetEvidence:
      record.deliveryTargetEvidence === 'LEGACY_INFERRED' ? 'LEGACY_INFERRED' : 'ISSUED',
    displayName: record.user.displayName,
    status:
      record.consumedAt !== null
        ? 'ACCEPTED'
        : record.revokedAt !== null
          ? 'REVOKED'
          : record.expiresAt <= now
            ? 'EXPIRED'
            : record.deliveryStatus === 'SENT'
              ? 'SENT'
              : record.deliveryStatus === 'FAILED'
                ? 'DELIVERY_FAILED'
                : 'PENDING',
    deliveryStatus: deliveryStatus(record.deliveryStatus),
    issuedAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    consumedAt: record.consumedAt?.toISOString() ?? null,
  };
}

function deliveryStatus(value: string): MemberInvitation['deliveryStatus'] {
  if (value === 'NOT_CONFIGURED' || value === 'SENT' || value === 'FAILED') return value;
  return 'PENDING';
}

async function upsertInvitationPosition(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  organizationId: string,
  userId: string,
  orgUnitId: string,
  title: string,
): Promise<string> {
  const code = `ADMIN_MEMBER_${userId.replaceAll('-', '')}`;
  const position = await transaction.position.upsert({
    where: { tenantId_code: { tenantId, code } },
    create: { tenantId, organizationId, orgUnitId, code, name: title },
    update: { orgUnitId, name: title },
    select: { id: true },
  });
  return position.id;
}

async function lockPasswordFlow(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  await transaction.$queryRaw`
    WITH password_flow_lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`password-flow:${tenantId}:${userId}`}, 0))
    )
    SELECT 1::integer AS locked FROM password_flow_lock
  `;
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1000);
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function requireSingleWorkEmail(
  employments: ReadonlyArray<{ readonly workEmail: string | null }>,
): string {
  const emails = [
    ...new Map(
      employments
        .map(({ workEmail }) => workEmail?.trim())
        .filter((email): email is string => email !== undefined && email.length > 0)
        .map((email) => [email.toLowerCase(), email] as const),
    ).values(),
  ];
  if (emails.length !== 1) {
    throw new ConflictException(
      'A Feishu directory member requires exactly one active work email before invitation.',
    );
  }
  const email = emails[0]!;
  if (email.toLowerCase().endsWith('@external.invalid')) {
    throw new ConflictException(
      'Set a real login email for this Feishu directory member before sending an invitation.',
    );
  }
  return email;
}
