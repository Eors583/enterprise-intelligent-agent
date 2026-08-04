import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type TenantRole as PrismaTenantRole } from '@prisma/client';
import type {
  AuthAccount,
  AuthSessionResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  CurrentSessionResponse,
  LoginRequest,
  LoginResult,
  MfaLoginVerifyRequest,
  RefreshSessionRequest,
  RegisterTenantRequest,
  TenantRole,
} from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import type { AuthenticatedPrincipal } from '../domain/authenticated-principal.js';
import { PasswordHasher } from './password-hasher.js';
import { MfaService } from './mfa.service.js';
import { TokenService, type SessionTokenPair } from './token.service.js';

const AUTHENTICATION_FAILED = 'The workspace, email, or password is incorrect.';
const ACCESS_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

interface AccountSource {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: PrismaTenantRole;
  readonly passwordChangeRequired: boolean;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(ConfigService)
    private readonly config: ConfigService<EnvironmentVariables, true>,
    @Optional()
    @Inject(MfaService)
    private readonly mfa?: MfaService,
  ) {}

  async registerTenant(request: RegisterTenantRequest): Promise<AuthSessionResponse> {
    this.assertPersistenceEnabled();
    if (this.config.get('REGISTRATION_MODE', { infer: true }) !== 'open') {
      throw new ForbiddenException('Workspace registration is disabled.');
    }

    const passwordHash = await this.passwords.hash(request.password);
    const pair = this.tokens.issuePair();
    const now = new Date();
    const accessExpiresAt = this.accessExpiry(now);
    const refreshExpiresAt = this.refreshExpiry(now);

    try {
      const source = await this.prisma.withAuth(async (transaction) => {
        const tenant = await transaction.tenant.create({
          data: {
            name: request.tenantName,
            slug: request.tenantSlug,
            status: 'ACTIVE',
          },
          select: { id: true, slug: true, name: true },
        });
        // The auth role can discover/create identity rows before a tenant is
        // known, but all organization and audit writes remain tenant-scoped.
        await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        const organization = await transaction.organization.create({
          data: {
            tenantId: tenant.id,
            externalKey: request.tenantSlug,
            name: request.organizationName,
            countryCode: 'CN',
          },
          select: { id: true },
        });
        const root = await transaction.orgUnit.create({
          data: {
            tenantId: tenant.id,
            organizationId: organization.id,
            externalKey: 'root',
            name: request.organizationName,
            sortOrder: 0,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        const user = await transaction.user.create({
          data: {
            tenantId: tenant.id,
            email: request.email,
            emailNormalized: request.email,
            displayName: request.displayName,
            role: 'OWNER',
            status: 'ACTIVE',
          },
          select: { id: true, email: true, displayName: true, role: true },
        });
        await transaction.passwordCredential.create({
          data: { tenantId: tenant.id, userId: user.id, passwordHash },
        });
        await transaction.employment.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            organizationId: organization.id,
            orgUnitId: root.id,
            employeeNumber: 'OWNER-0001',
            workEmail: user.email,
            employmentType: 'FULL_TIME',
            status: 'ACTIVE',
            isPrimary: true,
          },
        });
        const session = await transaction.authSession.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            accessTokenHash: pair.access.hash,
            refreshTokenHash: pair.refresh.hash,
            accessExpiresAt,
            refreshExpiresAt,
            ...(request.sessionLabel === undefined ? {} : { label: request.sessionLabel }),
          },
          select: { id: true },
        });
        await transaction.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actorType: 'USER',
            actorId: user.id,
            action: 'auth.tenant_registered',
            resourceType: 'tenant',
            resourceId: tenant.id,
            metadata: { tenantSlug: tenant.slug, organizationId: organization.id },
          },
        });
        return {
          sessionId: session.id,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          tenantName: tenant.name,
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          passwordChangeRequired: false,
          accessExpiresAt,
          refreshExpiresAt,
        } satisfies AccountSource;
      });
      return response(pair, source);
    } catch (error: unknown) {
      if (isUniqueConstraint(error)) {
        throw new ConflictException('That workspace address is already registered.');
      }
      throw error;
    }
  }

  async login(request: LoginRequest): Promise<LoginResult> {
    this.assertPersistenceEnabled();
    const identity = await this.prisma.withAuth(async (transaction) => {
      const tenant = await transaction.tenant.findUnique({
        where: { slug: request.tenantSlug },
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
        },
      });
      if (tenant === null) return null;

      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      const selectUser = {
        id: true,
        email: true,
        displayName: true,
        role: true,
        status: true,
        passwordCredential: {
          select: { passwordHash: true, mustChangePassword: true },
        },
      } satisfies Prisma.UserSelect;
      const reservedInternalEmail = isReservedInternalEmail(request.email);
      const localUser = reservedInternalEmail
        ? null
        : await transaction.user.findFirst({
            where: { tenantId: tenant.id, emailNormalized: request.email },
            select: selectUser,
          });
      if (localUser !== null) return { ...tenant, user: localUser };
      if (reservedInternalEmail) return { ...tenant, user: undefined };

      // A work-email alias is valid only when exactly one active employment
      // owns it. Invitation-pending and suspended memberships cannot log in.
      const candidates = await transaction.employment.groupBy({
        by: ['userId'],
        where: {
          tenantId: tenant.id,
          workEmail: { equals: request.email, mode: 'insensitive' },
          status: 'ACTIVE',
        },
        orderBy: { userId: 'asc' },
        take: 2,
      });
      if (candidates.length !== 1) return { ...tenant, user: undefined };

      const externalUser = await transaction.user.findUnique({
        where: { tenantId_id: { tenantId: tenant.id, id: candidates[0]!.userId } },
        select: selectUser,
      });
      return { ...tenant, user: externalUser ?? undefined };
    });
    const user = identity?.user;
    const credential = user?.passwordCredential;
    const encoded = credential?.passwordHash;
    const passwordMatches =
      encoded === undefined
        ? await this.passwords.verify(request.password, DUMMY_PASSWORD_HASH)
        : await this.passwords.verify(request.password, encoded);
    if (
      identity === null ||
      identity.status !== 'ACTIVE' ||
      user === undefined ||
      user.status !== 'ACTIVE' ||
      credential === null ||
      credential === undefined ||
      !passwordMatches
    ) {
      throw invalidCredentials();
    }

    if (
      this.mfa !== undefined &&
      (await this.mfa.requiresLoginMfa(identity.id, user.id, user.role as TenantRole))
    ) {
      return this.mfa.beginLoginChallenge(
        identity.id,
        user.id,
        this.mfa.credentialBinding(credential.passwordHash),
        this.mfa.loginIdentifierBinding(request.email),
      );
    }

    const pair = this.tokens.issuePair();
    const now = new Date();
    const accessExpiresAt = this.accessExpiry(now);
    const refreshExpiresAt = this.refreshExpiry(now);
    const session = await this.prisma.withAuth(async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${identity.id}, true)`;
      await transaction.$queryRaw`
        WITH password_flow_lock AS (
          SELECT pg_advisory_xact_lock(hashtextextended(${passwordFlowLockKey(identity.id, user.id)}, 0))
        )
        SELECT 1::integer AS locked FROM password_flow_lock
      `;
      const lockedCredential = await transaction.passwordCredential.findUnique({
        where: { userId: user.id },
        select: { passwordHash: true, mustChangePassword: true },
      });
      if (lockedCredential === null || lockedCredential.passwordHash !== credential.passwordHash) {
        throw invalidCredentials();
      }
      const lockedAccount = await transaction.user.findFirst({
        where: {
          id: user.id,
          tenantId: identity.id,
          status: 'ACTIVE',
          tenant: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (lockedAccount === null) throw invalidCredentials();
      // The email may have changed after the initial password verification.
      // Re-resolve it while holding the same lock used by profile edits and
      // invitation/reset flows so a stale alias cannot create a new session.
      const canonicalOwner = await transaction.user.findFirst({
        where: { tenantId: identity.id, emailNormalized: request.email },
        select: { id: true },
      });
      if (canonicalOwner !== null) {
        if (canonicalOwner.id !== user.id) throw invalidCredentials();
      } else {
        const activeAliasOwners = await transaction.employment.groupBy({
          by: ['userId'],
          where: {
            tenantId: identity.id,
            workEmail: { equals: request.email, mode: 'insensitive' },
            status: 'ACTIVE',
          },
          orderBy: { userId: 'asc' },
          take: 2,
        });
        if (activeAliasOwners.length !== 1 || activeAliasOwners[0]?.userId !== user.id) {
          throw invalidCredentials();
        }
      }

      const deviceId = await this.mfa?.upsertDevice(
        transaction,
        identity.id,
        user.id,
        request.device,
      );

      const created = await transaction.authSession.create({
        data: {
          tenantId: identity.id,
          userId: user.id,
          accessTokenHash: pair.access.hash,
          refreshTokenHash: pair.refresh.hash,
          accessExpiresAt,
          refreshExpiresAt,
          ...(deviceId === undefined || deviceId === null ? {} : { deviceId }),
          ...(request.sessionLabel === undefined ? {} : { label: request.sessionLabel }),
        },
        select: { id: true },
      });
      return { ...created, passwordChangeRequired: lockedCredential.mustChangePassword };
    });
    return response(pair, {
      sessionId: session.id,
      tenantId: identity.id,
      tenantSlug: identity.slug,
      tenantName: identity.name,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      passwordChangeRequired: session.passwordChangeRequired,
      accessExpiresAt,
      refreshExpiresAt,
    });
  }

  async completeMfaLogin(request: MfaLoginVerifyRequest): Promise<AuthSessionResponse> {
    this.assertPersistenceEnabled();
    if (this.mfa === undefined) {
      throw new ServiceUnavailableException('Multi-factor authentication is unavailable.');
    }
    return this.mfa.completeLogin(request, async (transaction, verified) => {
      await transaction.$queryRaw`
        SELECT set_config('app.tenant_id', ${verified.tenantId}, true)
      `;
      await transaction.$queryRaw`
        WITH password_flow_lock AS (
          SELECT pg_advisory_xact_lock(hashtextextended(${passwordFlowLockKey(verified.tenantId, verified.userId)}, 0))
        )
        SELECT 1::integer AS locked FROM password_flow_lock
      `;
      const tenant = await transaction.tenant.findUnique({
        where: { id: verified.tenantId },
        select: { id: true, slug: true, name: true, status: true },
      });
      const user = await transaction.user.findUnique({
        where: {
          tenantId_id: { tenantId: verified.tenantId, id: verified.userId },
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          status: true,
          passwordCredential: {
            select: { passwordHash: true, mustChangePassword: true },
          },
        },
      });
      if (
        tenant === null ||
        tenant.status !== 'ACTIVE' ||
        user === null ||
        user.status !== 'ACTIVE' ||
        user.passwordCredential === null ||
        verified.credentialBinding !==
          this.mfa!.credentialBinding(user.passwordCredential.passwordHash)
      ) {
        throw invalidCredentials();
      }
      const activeAliases = await transaction.employment.findMany({
        where: {
          tenantId: tenant.id,
          userId: user.id,
          status: 'ACTIVE',
          workEmail: { not: null },
        },
        select: { workEmail: true },
      });
      const candidateEmails = new Set<string>();
      if (!isReservedInternalEmail(user.email)) candidateEmails.add(user.email.toLowerCase());
      for (const { workEmail } of activeAliases) {
        if (workEmail !== null && !isReservedInternalEmail(workEmail)) {
          candidateEmails.add(workEmail.trim().toLowerCase());
        }
      }
      const matchedEmail = [...candidateEmails].find(
        (email) => this.mfa!.loginIdentifierBinding(email) === verified.loginIdentifierBinding,
      );
      if (matchedEmail === undefined) throw invalidCredentials();
      const canonicalOwner = await transaction.user.findFirst({
        where: { tenantId: tenant.id, emailNormalized: matchedEmail },
        select: { id: true },
      });
      if (canonicalOwner !== null && canonicalOwner.id !== user.id) throw invalidCredentials();
      if (canonicalOwner === null) {
        const aliasOwners = await transaction.employment.groupBy({
          by: ['userId'],
          where: {
            tenantId: tenant.id,
            workEmail: { equals: matchedEmail, mode: 'insensitive' },
            status: 'ACTIVE',
          },
          orderBy: { userId: 'asc' },
          take: 2,
        });
        if (aliasOwners.length !== 1 || aliasOwners[0]?.userId !== user.id) {
          throw invalidCredentials();
        }
      }
      const pair = this.tokens.issuePair();
      const now = verified.verifiedAt;
      const accessExpiresAt = this.accessExpiry(now);
      const refreshExpiresAt = this.refreshExpiry(now);
      const deviceId = await this.mfa!.upsertDevice(
        transaction,
        tenant.id,
        user.id,
        verified.device,
      );
      const session = await transaction.authSession.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          accessTokenHash: pair.access.hash,
          refreshTokenHash: pair.refresh.hash,
          accessExpiresAt,
          refreshExpiresAt,
          lastMfaAt: now,
          lastMfaMethod: verified.method,
          lastMfaFactorId: verified.factorId,
          ...(deviceId === null ? {} : { deviceId }),
          ...(verified.sessionLabel === undefined ? {} : { label: verified.sessionLabel }),
        },
        select: { id: true },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: 'USER',
          actorId: user.id,
          action: 'auth.mfa_login_completed',
          resourceType: 'auth_session',
          resourceId: session.id,
          metadata: { method: verified.method, factorId: verified.factorId },
        },
      });
      return response(pair, {
        sessionId: session.id,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        passwordChangeRequired: user.passwordCredential.mustChangePassword,
        accessExpiresAt,
        refreshExpiresAt,
      });
    });
  }

  async refresh(request: RefreshSessionRequest): Promise<AuthSessionResponse> {
    this.assertPersistenceEnabled();
    if (!this.tokens.isWellFormed(request.refreshToken)) throw unauthorized();

    const oldHash = this.tokens.hash(request.refreshToken);
    const pair = this.tokens.issuePair();
    const now = new Date();
    const outcome = await this.prisma.withAuth<
      AuthSessionResponse | { readonly refreshReplayDetected: true }
    >(async (transaction) => {
      const existing = await transaction.authSession.findUnique({
        where: { refreshTokenHash: oldHash },
        include: {
          tenant: true,
          user: {
            include: {
              passwordCredential: { select: { mustChangePassword: true } },
            },
          },
        },
      });
      if (existing === null) {
        const [retired] = await transaction.$queryRaw<
          Array<{
            tenant_id: string;
            refresh_family_id: string;
          }>
        >`
          SELECT "tenant_id", "refresh_family_id"
          FROM public."auth_refresh_token_history"
          WHERE "token_hash" = ${oldHash}
          LIMIT 1
          FOR UPDATE
        `;
        if (retired === undefined) throw unauthorized();
        await transaction.$queryRaw`
          SELECT set_config('app.tenant_id', ${retired.tenant_id}, true)
        `;
        await transaction.$executeRaw`
          UPDATE public."auth_refresh_token_history"
          SET "replayed_at" = COALESCE("replayed_at", ${now})
          WHERE "token_hash" = ${oldHash}
        `;
        await transaction.$executeRaw`
          UPDATE public."auth_sessions"
          SET "refresh_replay_detected_at" = COALESCE(
                "refresh_replay_detected_at", ${now}
              ),
              "revoked_at" = COALESCE("revoked_at", ${now}),
              "revoked_reason" = COALESCE("revoked_reason", 'REFRESH_TOKEN_REPLAY'),
              "version" = "version" + 1
          WHERE "tenant_id" = ${retired.tenant_id}::uuid
            AND "refresh_family_id" = ${retired.refresh_family_id}::uuid
        `;
        return { refreshReplayDetected: true };
      }
      if (
        existing.revokedAt !== null ||
        existing.refreshExpiresAt <= now ||
        existing.tenant.status !== 'ACTIVE' ||
        existing.user.status !== 'ACTIVE'
      ) {
        throw unauthorized();
      }

      const accessExpiresAt = minDate(this.accessExpiry(now), existing.refreshExpiresAt);
      const rotated = await transaction.authSession.updateMany({
        where: {
          id: existing.id,
          refreshTokenHash: oldHash,
          revokedAt: null,
          refreshExpiresAt: { gt: now },
        },
        data: {
          accessTokenHash: pair.access.hash,
          refreshTokenHash: pair.refresh.hash,
          accessExpiresAt,
          lastUsedAt: now,
        },
      });
      if (rotated.count !== 1) throw unauthorized();

      return response(pair, {
        sessionId: existing.id,
        tenantId: existing.tenantId,
        tenantSlug: existing.tenant.slug,
        tenantName: existing.tenant.name,
        userId: existing.userId,
        email: existing.user.email,
        displayName: existing.user.displayName,
        role: existing.user.role,
        passwordChangeRequired: existing.user.passwordCredential?.mustChangePassword ?? false,
        accessExpiresAt,
        refreshExpiresAt: existing.refreshExpiresAt,
      });
    });
    if ('refreshReplayDetected' in outcome) throw unauthorized();
    return outcome;
  }

  async authenticateAccessToken(value: string): Promise<AuthenticatedPrincipal> {
    this.assertPersistenceEnabled();
    if (!this.tokens.isWellFormed(value) || !value.startsWith('ea_access_')) throw unauthorized();

    const hash = this.tokens.hash(value);
    const now = new Date();
    return this.prisma.withAuth(async (transaction) => {
      const session = await transaction.authSession.findUnique({
        where: { accessTokenHash: hash },
        include: {
          tenant: true,
          user: {
            include: {
              passwordCredential: { select: { mustChangePassword: true } },
            },
          },
        },
      });
      if (
        session === null ||
        session.revokedAt !== null ||
        session.accessExpiresAt <= now ||
        session.tenant.status !== 'ACTIVE' ||
        session.user.status !== 'ACTIVE'
      ) {
        throw unauthorized();
      }

      if (now.getTime() - session.lastUsedAt.getTime() >= ACCESS_ACTIVITY_WRITE_INTERVAL_MS) {
        await transaction.authSession.update({
          where: { id: session.id },
          data: { lastUsedAt: now },
        });
      }
      return {
        ...toAccount({
          sessionId: session.id,
          tenantId: session.tenantId,
          tenantSlug: session.tenant.slug,
          tenantName: session.tenant.name,
          userId: session.userId,
          email: session.user.email,
          displayName: session.user.displayName,
          role: session.user.role,
          passwordChangeRequired: session.user.passwordCredential?.mustChangePassword ?? false,
          accessExpiresAt: session.accessExpiresAt,
          refreshExpiresAt: session.refreshExpiresAt,
        }),
        authenticationSource: 'session',
      };
    });
  }

  current(principal: AuthenticatedPrincipal): CurrentSessionResponse {
    const { authenticationSource: _, ...account } = principal;
    return account;
  }

  async changePassword(
    request: ChangePasswordRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<ChangePasswordResponse> {
    this.assertPersistenceEnabled();
    if (request.currentPassword === request.newPassword) {
      throw new BadRequestException('New password must be different from the current password.');
    }

    const credential = await this.prisma.withAuth((transaction) =>
      transaction.passwordCredential.findUnique({
        where: { userId: principal.userId },
        select: { passwordHash: true },
      }),
    );
    const currentPasswordMatches = await this.passwords.verify(
      request.currentPassword,
      credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (credential === null || !currentPasswordMatches) {
      throw new UnauthorizedException('The current password is incorrect.');
    }

    const passwordHash = await this.passwords.hash(request.newPassword);
    const changedAt = new Date();
    const revokedSessionCount = await this.prisma.withAuth(async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`;
      await transaction.$queryRaw`
        WITH password_flow_lock AS (
          SELECT pg_advisory_xact_lock(hashtextextended(${passwordFlowLockKey(principal.tenantId, principal.userId)}, 0))
        )
        SELECT 1::integer AS locked FROM password_flow_lock
      `;
      const updated = await transaction.passwordCredential.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          passwordHash: credential.passwordHash,
        },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: changedAt,
        },
      });
      if (updated.count !== 1) {
        throw new UnauthorizedException('The current password is no longer valid.');
      }

      const revoked = await transaction.authSession.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          id: { not: principal.sessionId },
          revokedAt: null,
        },
        data: { revokedAt: changedAt },
      });
      await transaction.authActionToken.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: changedAt },
      });
      await transaction.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'USER',
          actorId: principal.userId,
          action: 'auth.password_changed',
          resourceType: 'user',
          resourceId: principal.userId,
          metadata: { revokedSessionCount: revoked.count },
        },
      });
      return revoked.count;
    });

    const { authenticationSource: _, ...account } = principal;
    return {
      account: { ...account, passwordChangeRequired: false },
      revokedSessionCount,
    };
  }

  async logout(principal: AuthenticatedPrincipal): Promise<void> {
    this.assertPersistenceEnabled();
    await this.prisma.withAuth(async (transaction) => {
      await transaction.authSession.updateMany({
        where: {
          id: principal.sessionId,
          tenantId: principal.tenantId,
          userId: principal.userId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    });
  }

  private accessExpiry(now: Date): Date {
    return addSeconds(now, this.config.get('AUTH_ACCESS_TTL_SECONDS', { infer: true }));
  }

  private refreshExpiry(now: Date): Date {
    return addSeconds(now, this.config.get('AUTH_REFRESH_TTL_SECONDS', { infer: true }));
  }

  private assertPersistenceEnabled(): void {
    if (!this.prisma.enabled) {
      throw new ServiceUnavailableException('Authentication requires REPOSITORY_DRIVER=prisma.');
    }
  }
}

function passwordFlowLockKey(tenantId: string, userId: string): string {
  return `password-flow:${tenantId}:${userId}`;
}

function isReservedInternalEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@external.invalid');
}

function response(pair: SessionTokenPair, source: AccountSource): AuthSessionResponse {
  return {
    accessToken: pair.access.value,
    refreshToken: pair.refresh.value,
    account: toAccount(source),
  };
}

function toAccount(source: AccountSource): AuthAccount {
  return {
    sessionId: source.sessionId,
    tenantId: source.tenantId,
    tenantSlug: source.tenantSlug,
    tenantName: source.tenantName,
    userId: source.userId,
    email: source.email,
    displayName: source.displayName,
    role: source.role as TenantRole,
    passwordChangeRequired: source.passwordChangeRequired,
    accessExpiresAt: source.accessExpiresAt.toISOString(),
    refreshExpiresAt: source.refreshExpiresAt.toISOString(),
  };
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1000);
}

function minDate(left: Date, right: Date): Date {
  return left <= right ? left : right;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException(AUTHENTICATION_FAILED);
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException('Authentication required.');
}

// A valid, fixed hash makes missing-identity login attempts perform the same
// expensive verification operation without creating a per-request salt/hash.
const DUMMY_PASSWORD_HASH =
  'scrypt$v1$16384$8$1$64$MDEyMzQ1Njc4OWFiY2RlZg$SX8HrLXPC-h5Tj9LqXyZw9L-jNbZ-uB6SB5iI-t9xB3PdqB7UGeGHMueIYlAszs6VQf1-lPXQ2FrZfXLgkM1pg';
