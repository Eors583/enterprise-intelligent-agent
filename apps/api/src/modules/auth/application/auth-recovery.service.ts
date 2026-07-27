import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AcceptMemberInvitationRequest,
  AcceptMemberInvitationResponse,
  CompletePasswordResetRequest,
  CompletePasswordResetResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
} from '@enterprise/contracts';
import type { Prisma } from '@prisma/client';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import { AuthRecoveryNotificationService } from './auth-recovery-notification.service.js';
import { PasswordHasher } from './password-hasher.js';
import { TokenService } from './token.service.js';

export const PASSWORD_RESET_REQUEST_ACCEPTED_RESPONSE: RequestPasswordResetResponse = {
  accepted: true,
  message: 'If the account is eligible, a password reset message will be sent.',
};

type ActionPurpose = 'PASSWORD_RESET' | 'MEMBER_INVITATION';
const ACTION_TOKEN_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  purpose: true,
  expiresAt: true,
  consumedAt: true,
  revokedAt: true,
  tenant: { select: { status: true } },
  user: { select: { status: true } },
} satisfies Prisma.AuthActionTokenSelect;
type ActionTokenCandidate = Prisma.AuthActionTokenGetPayload<{
  select: typeof ACTION_TOKEN_SELECT;
}>;

@Injectable()
export class AuthRecoveryService {
  private readonly logger = new Logger(AuthRecoveryService.name);
  private readonly passwordResetTtlSeconds: number;

  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthRecoveryNotificationService)
    private readonly notifications: AuthRecoveryNotificationService,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.passwordResetTtlSeconds =
      config.get('AUTH_PASSWORD_RESET_TTL_SECONDS', { infer: true }) ?? 1_800;
  }

  async requestPasswordReset(
    request: RequestPasswordResetRequest,
  ): Promise<RequestPasswordResetResponse> {
    this.assertPersistenceEnabled();
    // Generate the same amount of opaque-token material before identity lookup
    // whether or not the tenant/account exists.
    const opaque = this.tokens.issueAction('reset');
    const issuedAt = new Date();
    const expiresAt = addSeconds(issuedAt, this.passwordResetTtlSeconds);

    const delivery = await this.prisma.withAuth(async (transaction) => {
      const identity = await findEligibleIdentity(transaction, request.tenantSlug, request.email);
      if (identity === null) return null;

      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${identity.tenantId}, true)`;
      await lockPasswordFlow(transaction, identity.tenantId, identity.userId);
      // Re-check status after taking the same lock used by login/password writes.
      const eligible = await transaction.user.findFirst({
        where: {
          id: identity.userId,
          tenantId: identity.tenantId,
          status: 'ACTIVE',
          passwordCredential: { isNot: null },
          tenant: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (eligible === null) return null;

      await transaction.authActionToken.updateMany({
        where: {
          tenantId: identity.tenantId,
          userId: identity.userId,
          purpose: 'PASSWORD_RESET',
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: issuedAt },
      });
      const action = await transaction.authActionToken.create({
        data: {
          tenantId: identity.tenantId,
          userId: identity.userId,
          purpose: 'PASSWORD_RESET',
          tokenHash: opaque.hash,
          deliveryStatus: 'PENDING',
          expiresAt,
        },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId: identity.tenantId,
          actorType: 'SERVICE',
          actorId: identity.userId,
          action: 'auth.password_reset.requested',
          resourceType: 'user',
          resourceId: identity.userId,
          metadata: { expiresAt: expiresAt.toISOString() },
        },
      });
      return { ...identity, actionId: action.id };
    });

    if (delivery !== null) {
      // Do not put provider latency on this public, enumeration-safe endpoint.
      // Raw action tokens are intentionally not persisted, so this is a
      // best-effort hand-off: a process crash can leave PENDING delivery that
      // cannot be replayed; the user must request a replacement token.
      setImmediate(() => {
        void this.deliverPasswordReset(delivery, opaque.value).catch(() => {
          this.logger.warn(
            'Password reset notification delivery failed after async hand-off; status recorded as FAILED.',
          );
          return this.recordDelivery(delivery.actionId, 'FAILED');
        });
      });
    }
    return PASSWORD_RESET_REQUEST_ACCEPTED_RESPONSE;
  }

  completePasswordReset(
    request: CompletePasswordResetRequest,
  ): Promise<CompletePasswordResetResponse> {
    return this.consumeActionToken(
      request.token,
      request.newPassword,
      'reset',
      'PASSWORD_RESET',
    ).then((result) => ({ completed: true, revokedSessionCount: result.revokedSessionCount }));
  }

  acceptMemberInvitation(
    request: AcceptMemberInvitationRequest,
  ): Promise<AcceptMemberInvitationResponse> {
    return this.consumeActionToken(
      request.token,
      request.newPassword,
      'invite',
      'MEMBER_INVITATION',
    ).then((result) => ({ accepted: true, revokedSessionCount: result.revokedSessionCount }));
  }

  private async consumeActionToken(
    rawToken: string,
    newPassword: string,
    kind: 'reset' | 'invite',
    purpose: ActionPurpose,
  ): Promise<{ readonly revokedSessionCount: number }> {
    this.assertPersistenceEnabled();
    if (!this.tokens.isActionWellFormed(rawToken, kind)) throw invalidActionToken();

    const tokenHash = this.tokens.hash(rawToken);
    // Reject random opaque capabilities before paying the password KDF cost.
    // Tokens carry 256 bits of entropy, while the pre-identity limiter bounds
    // lookups; doing scrypt for arbitrary random tokens would create a public
    // CPU-amplification endpoint when network throttling is unavailable.
    const preflight = await this.prisma.withAuth((transaction) =>
      transaction.authActionToken.findUnique({
        where: { tokenHash },
        select: ACTION_TOKEN_SELECT,
      }),
    );
    if (!isConsumable(preflight, purpose, new Date())) throw invalidActionToken();

    const passwordHash = await this.passwords.hash(newPassword);
    const consumedAt = new Date();
    return this.prisma.withAuth(async (transaction) => {
      const candidate = await transaction.authActionToken.findUnique({
        where: { tokenHash },
        select: ACTION_TOKEN_SELECT,
      });
      if (!isConsumable(candidate, purpose, consumedAt)) throw invalidActionToken();

      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${candidate.tenantId}, true)`;
      await lockPasswordFlow(transaction, candidate.tenantId, candidate.userId);
      const consumed = await transaction.authActionToken.updateMany({
        where: {
          id: candidate.id,
          tenantId: candidate.tenantId,
          userId: candidate.userId,
          purpose,
          tokenHash,
          expiresAt: { gt: consumedAt },
          consumedAt: null,
          revokedAt: null,
        },
        data: { consumedAt },
      });
      if (consumed.count !== 1) throw invalidActionToken();

      const credential = await transaction.passwordCredential.updateMany({
        where: { tenantId: candidate.tenantId, userId: candidate.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: consumedAt,
        },
      });
      if (credential.count !== 1) throw invalidActionToken();

      if (purpose === 'MEMBER_INVITATION') {
        const activated = await transaction.user.updateMany({
          where: {
            id: candidate.userId,
            tenantId: candidate.tenantId,
            status: { in: ['ACTIVE', 'INACTIVE'] },
          },
          data: { status: 'ACTIVE' },
        });
        if (activated.count !== 1) throw invalidActionToken();
        await transaction.employment.updateMany({
          where: {
            tenantId: candidate.tenantId,
            userId: candidate.userId,
            status: 'PENDING',
          },
          data: { status: 'ACTIVE' },
        });
      }

      const revoked = await transaction.authSession.updateMany({
        where: {
          tenantId: candidate.tenantId,
          userId: candidate.userId,
          revokedAt: null,
        },
        data: { revokedAt: consumedAt },
      });
      await transaction.authActionToken.updateMany({
        where: {
          tenantId: candidate.tenantId,
          userId: candidate.userId,
          id: { not: candidate.id },
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: consumedAt },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId: candidate.tenantId,
          actorType: 'SERVICE',
          actorId: candidate.userId,
          action:
            purpose === 'PASSWORD_RESET'
              ? 'auth.password_reset.completed'
              : 'auth.member_invitation.accepted',
          resourceType: 'user',
          resourceId: candidate.userId,
          metadata: { revokedSessionCount: revoked.count },
        },
      });
      return { revokedSessionCount: revoked.count };
    });
  }

  private async recordDelivery(
    actionId: string,
    status: 'NOT_CONFIGURED' | 'SENT' | 'FAILED',
  ): Promise<void> {
    try {
      await this.prisma.withAuth(async (transaction) => {
        await transaction.authActionToken.updateMany({
          where: { id: actionId, consumedAt: null, revokedAt: null },
          data: {
            deliveryStatus: status,
            ...(status === 'NOT_CONFIGURED'
              ? {}
              : { deliveryAttempts: { increment: 1 }, lastDeliveryAt: new Date() }),
          },
        });
      });
    } catch {
      // A notification status write must not change the public, enumeration-safe
      // response. The token remains PENDING and can be replaced by a new request.
    }
  }

  private async deliverPasswordReset(
    delivery: {
      readonly actionId: string;
      readonly email: string;
      readonly displayName: string;
      readonly tenantName: string;
    },
    rawToken: string,
  ): Promise<void> {
    const status = await this.notifications.sendPasswordReset({
      email: delivery.email,
      displayName: delivery.displayName,
      tenantName: delivery.tenantName,
      token: rawToken,
    });
    await this.recordDelivery(delivery.actionId, status);
  }

  private assertPersistenceEnabled(): void {
    if (!this.prisma.enabled) {
      throw new ServiceUnavailableException('Account recovery requires REPOSITORY_DRIVER=prisma.');
    }
  }
}

async function findEligibleIdentity(
  transaction: Prisma.TransactionClient,
  tenantSlug: string,
  email: string,
): Promise<{
  readonly tenantId: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
} | null> {
  const tenant = await transaction.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, name: true, status: true },
  });
  if (tenant === null || tenant.status !== 'ACTIVE') return null;

  // Tenant discovery happens before a trusted identity exists, but every user
  // and employment lookup below is tenant-scoped by RLS. Establish the local
  // auth transaction context immediately after resolving the active tenant so
  // work-email fallback observes only this tenant and cannot silently miss all
  // rows or see another tenant.
  await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

  const direct = await transaction.user.findFirst({
    where: {
      tenantId: tenant.id,
      emailNormalized: email,
      status: 'ACTIVE',
      passwordCredential: { isNot: null },
    },
    select: { id: true, email: true, displayName: true },
  });
  if (direct !== null) {
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      userId: direct.id,
      email: direct.email,
      displayName: direct.displayName,
    };
  }

  const matches = await transaction.employment.groupBy({
    by: ['userId'],
    where: {
      tenantId: tenant.id,
      workEmail: { equals: email, mode: 'insensitive' },
      status: { not: 'TERMINATED' },
    },
    orderBy: { userId: 'asc' },
    take: 2,
  });
  if (matches.length !== 1) return null;
  const external = await transaction.user.findFirst({
    where: {
      id: matches[0]!.userId,
      tenantId: tenant.id,
      status: 'ACTIVE',
      passwordCredential: { isNot: null },
    },
    select: { id: true, displayName: true },
  });
  if (external === null) return null;
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    userId: external.id,
    email,
    displayName: external.displayName,
  };
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

function invalidActionToken(): BadRequestException {
  return new BadRequestException('The recovery link is invalid or has expired.');
}

function isConsumable(
  candidate: ActionTokenCandidate | null,
  purpose: ActionPurpose,
  now: Date,
): candidate is ActionTokenCandidate {
  return (
    candidate !== null &&
    candidate.purpose === purpose &&
    candidate.consumedAt === null &&
    candidate.revokedAt === null &&
    candidate.expiresAt > now &&
    candidate.tenant.status === 'ACTIVE' &&
    (purpose === 'PASSWORD_RESET'
      ? candidate.user.status === 'ACTIVE'
      : candidate.user.status === 'ACTIVE' || candidate.user.status === 'INACTIVE')
  );
}
