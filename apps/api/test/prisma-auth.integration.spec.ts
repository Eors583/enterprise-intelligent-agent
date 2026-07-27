import { createHmac } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  acceptMemberInvitationResponseSchema,
  authSessionResponseSchema,
  completePasswordResetResponseSchema,
  currentSessionResponseSchema,
  issueMemberInvitationResponseSchema,
  requestPasswordResetResponseSchema,
} from '@enterprise/contracts';
import request from 'supertest';

import type { EnvironmentVariables } from '../src/config/environment.js';
import { AuthPrismaService } from '../src/database/auth-prisma.service.js';
import { LoginAttemptLimiter } from '../src/modules/auth/application/login-attempt-limiter.service.js';
import { RecoveryRequestLimiter } from '../src/modules/auth/application/recovery-request-limiter.service.js';
import { createTestApp } from '../src/testing/create-test-app.js';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const tenantSlug = `auth-self-test-${process.pid}`;
const crossTenantSlug = `auth-cross-tenant-self-test-${process.pid}`;
const authPepper = 'database-integration-token-pepper';

describe.runIf(enabled)('PostgreSQL authentication integration', () => {
  const administrator = new PrismaClient();
  let app: INestApplication;
  let accessToken: string;
  let refreshToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REPOSITORY_DRIVER = 'prisma';
    process.env.REGISTRATION_MODE = 'open';
    process.env.AUTH_TOKEN_PEPPER = authPepper;
    process.env.AUTH_LOGIN_RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED = 'false';
    process.env.AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES = '2';
    process.env.AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES = '100';
    await cleanup();
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await cleanup();
    await administrator.$disconnect();
  });

  it('registers a tenant and its first owner in one request', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register-tenant')
      .send({
        tenantName: 'Authentication self test',
        tenantSlug,
        organizationName: 'Authentication self test organization',
        displayName: 'First owner',
        email: 'owner@auth-self-test.invalid',
        password: 'SelfTestPassword!2026',
        sessionLabel: 'integration test',
      })
      .expect(201);

    expect(authSessionResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.headers['server-timing']).toBeUndefined();
    expect(response.body.account).toMatchObject({ tenantSlug, role: 'OWNER' });
    accessToken = response.body.accessToken;
    refreshToken = response.body.refreshToken;
  });

  it('resolves me, rotates both tokens, and immediately invalidates the old access token', async () => {
    const current = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(currentSessionResponseSchema.safeParse(current.body).success).toBe(true);

    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(authSessionResponseSchema.safeParse(rotated.body).success).toBe(true);
    expect(rotated.headers['server-timing']).toBeUndefined();
    expect(rotated.body.accessToken).not.toBe(accessToken);
    expect(rotated.body.refreshToken).not.toBe(refreshToken);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(401);
    accessToken = rotated.body.accessToken;
    refreshToken = rotated.body.refreshToken;
  });

  it('revokes the current session and can log in again with the password credential', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: 'owner@auth-self-test.invalid',
        password: 'wrong-password',
      })
      .expect(401);
    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: 'owner@auth-self-test.invalid',
        password: 'SelfTestPassword!2026',
      })
      .expect(200);
    expect(authSessionResponseSchema.safeParse(loggedIn.body).success).toBe(true);
    expect(loggedIn.headers['server-timing']).toBeUndefined();
    accessToken = loggedIn.body.accessToken;
    refreshToken = loggedIn.body.refreshToken;
  });

  it('keeps password-reset requests enumeration-safe and never returns the raw token', async () => {
    const known = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ tenantSlug, email: 'owner@auth-self-test.invalid' })
      .expect(202);
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ tenantSlug, email: 'missing@auth-self-test.invalid' })
      .expect(202);
    expect(requestPasswordResetResponseSchema.safeParse(known.body).success).toBe(true);
    expect(known.headers['server-timing']).toBeUndefined();
    expect(unknown.headers['server-timing']).toBeUndefined();
    expect(known.body).toEqual(unknown.body);
    expect(JSON.stringify(known.body)).not.toContain('ea_reset_');

    const tenant = await administrator.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
    const stored = await administrator.authActionToken.findFirstOrThrow({
      where: { tenantId: tenant.id, purpose: 'PASSWORD_RESET', revokedAt: null },
    });
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('ea_reset_');
  });

  it('consumes a password reset once, revokes sessions, and accepts only the new password', async () => {
    const tenant = await administrator.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
    const owner = await administrator.user.findFirstOrThrow({
      where: { tenantId: tenant.id, emailNormalized: 'owner@auth-self-test.invalid' },
    });
    const rawToken = `ea_reset_${'r'.repeat(43)}`;
    const tokenHash = createHmac('sha256', authPepper).update(rawToken).digest('hex');
    await administrator.authActionToken.updateMany({
      where: {
        tenantId: tenant.id,
        userId: owner.id,
        purpose: 'PASSWORD_RESET',
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    await administrator.authActionToken.create({
      data: {
        tenantId: tenant.id,
        userId: owner.id,
        purpose: 'PASSWORD_RESET',
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const completed = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ token: rawToken, newPassword: 'RecoveredPassword!2026' })
      .expect(200);
    expect(completePasswordResetResponseSchema.safeParse(completed.body).success).toBe(true);
    expect(completed.headers['server-timing']).toBeUndefined();
    expect(completed.body.revokedSessionCount).toBeGreaterThanOrEqual(1);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ token: rawToken, newPassword: 'AnotherPassword!2026' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: 'owner@auth-self-test.invalid',
        password: 'SelfTestPassword!2026',
      })
      .expect(401);
    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: 'owner@auth-self-test.invalid',
        password: 'RecoveredPassword!2026',
      })
      .expect(200);
    accessToken = loggedIn.body.accessToken;
    refreshToken = loggedIn.body.refreshToken;
  });

  it('allows exactly one concurrent consumer for the same reset token', async () => {
    const tenant = await administrator.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
    const owner = await administrator.user.findFirstOrThrow({
      where: { tenantId: tenant.id, emailNormalized: 'owner@auth-self-test.invalid' },
    });
    const rawToken = `ea_reset_${'c'.repeat(43)}`;
    const tokenHash = createHmac('sha256', authPepper).update(rawToken).digest('hex');
    await administrator.authActionToken.updateMany({
      where: {
        tenantId: tenant.id,
        userId: owner.id,
        purpose: 'PASSWORD_RESET',
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    const action = await administrator.authActionToken.create({
      data: {
        tenantId: tenant.id,
        userId: owner.id,
        purpose: 'PASSWORD_RESET',
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const auditBefore = await administrator.auditEvent.count({
      where: {
        tenantId: tenant.id,
        resourceId: owner.id,
        action: 'auth.password_reset.completed',
      },
    });
    const candidatePasswords = ['ConcurrentPasswordA!2026', 'ConcurrentPasswordB!2026'] as const;

    const responses = await Promise.all(
      candidatePasswords.map((newPassword) =>
        request(app.getHttpServer())
          .post('/api/v1/auth/password-reset/complete')
          .send({ token: rawToken, newPassword }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const successfulIndex = responses.findIndex((response) => response.status === 200);
    const failedIndex = responses.findIndex((response) => response.status === 400);
    expect(successfulIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(
      completePasswordResetResponseSchema.safeParse(responses[successfulIndex]!.body).success,
    ).toBe(true);
    expect(responses[failedIndex]!.body).toMatchObject({
      message: 'The recovery link is invalid or has expired.',
    });

    await expect(
      administrator.authActionToken.findUniqueOrThrow({ where: { id: action.id } }),
    ).resolves.toMatchObject({ consumedAt: expect.any(Date), revokedAt: null });
    await expect(
      administrator.auditEvent.count({
        where: {
          tenantId: tenant.id,
          resourceId: owner.id,
          action: 'auth.password_reset.completed',
        },
      }),
    ).resolves.toBe(auditBefore + 1);

    const successfulPassword = candidatePasswords[successfulIndex]!;
    const failedPassword = candidatePasswords[failedIndex]!;
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: 'owner@auth-self-test.invalid', password: failedPassword })
      .expect(401);
    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: 'owner@auth-self-test.invalid', password: successfulPassword })
      .expect(200);
    accessToken = loggedIn.body.accessToken;
    refreshToken = loggedIn.body.refreshToken;
  });

  it('creates, reports, resends, and accepts a one-time member invitation', async () => {
    const tenant = await administrator.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
    const unit = await administrator.orgUnit.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const issued = await request(app.getHttpServer())
      .post('/api/v1/admin/member-invitations')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        email: 'invited@auth-self-test.invalid',
        displayName: 'Invited member',
        role: 'MEMBER',
        orgUnitId: unit.id,
      })
      .expect(201);
    expect(issueMemberInvitationResponseSchema.safeParse(issued.body).success).toBe(true);
    expect(new URL(issued.body.acceptanceUrl).search).toBe('');
    expect(new URL(issued.body.acceptanceUrl).hash).toContain('/accept-invitation?token=');

    const pendingUser = await administrator.user.findFirstOrThrow({
      where: { tenantId: tenant.id, emailNormalized: 'invited@auth-self-test.invalid' },
      include: { employments: true },
    });
    expect(pendingUser.status).toBe('INACTIVE');
    expect(pendingUser.employments[0]?.status).toBe('PENDING');
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: 'invited@auth-self-test.invalid',
        password: 'InvitedPassword!2026',
      })
      .expect(401);

    const resent = await request(app.getHttpServer())
      .post(`/api/v1/admin/members/${pendingUser.id}/invitation/resend`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(issueMemberInvitationResponseSchema.safeParse(resent.body).success).toBe(true);
    expect(resent.body.acceptanceToken).not.toBe(issued.body.acceptanceToken);
    await request(app.getHttpServer())
      .post('/api/v1/auth/invitations/accept')
      .send({ token: issued.body.acceptanceToken, newPassword: 'InvitedPassword!2026' })
      .expect(400);

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/auth/invitations/accept')
      .send({ token: resent.body.acceptanceToken, newPassword: 'InvitedPassword!2026' })
      .expect(200);
    expect(acceptMemberInvitationResponseSchema.safeParse(accepted.body).success).toBe(true);
    expect(accepted.headers['server-timing']).toBeUndefined();
    await request(app.getHttpServer())
      .post('/api/v1/auth/invitations/accept')
      .send({ token: resent.body.acceptanceToken, newPassword: 'InvitedPassword!2027' })
      .expect(400);

    const activated = await administrator.user.findUniqueOrThrow({
      where: { id: pendingUser.id },
      include: { employments: true },
    });
    expect(activated.status).toBe('ACTIVE');
    expect(activated.employments[0]?.status).toBe('ACTIVE');
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        tenantSlug,
        email: 'invited@auth-self-test.invalid',
        password: 'InvitedPassword!2026',
      })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/member-invitations')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId: pendingUser.id, status: 'ACCEPTED' }),
      ]),
    );
  });

  it('resets through one ACTIVE work email without crossing tenant boundaries', async () => {
    const tenant = await administrator.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
    const member = await administrator.user.findFirstOrThrow({
      where: { tenantId: tenant.id, emailNormalized: 'invited@auth-self-test.invalid' },
      include: { employments: true },
    });
    const workEmail = 'invited@auth-self-test.invalid';
    const primaryEmail = 'invited-primary@auth-self-test.invalid';
    await administrator.user.update({
      where: { id: member.id },
      data: { email: primaryEmail, emailNormalized: primaryEmail },
    });
    await expect(
      administrator.employment.count({
        where: { tenantId: tenant.id, workEmail, status: 'ACTIVE' },
      }),
    ).resolves.toBe(1);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register-tenant')
      .send({
        tenantName: 'Cross tenant authentication self test',
        tenantSlug: crossTenantSlug,
        organizationName: 'Cross tenant authentication organization',
        displayName: 'Cross tenant owner',
        email: 'cross-owner@auth-self-test.invalid',
        password: 'CrossTenantPassword!2026',
        sessionLabel: 'cross tenant integration test',
      })
      .expect(201);
    const crossTenant = await administrator.tenant.findUniqueOrThrow({
      where: { slug: crossTenantSlug },
    });
    const crossOwner = await administrator.user.findFirstOrThrow({
      where: { tenantId: crossTenant.id, emailNormalized: 'cross-owner@auth-self-test.invalid' },
    });
    const foreignWorkEmail = 'foreign-work-email@auth-self-test.invalid';
    await administrator.employment.updateMany({
      where: { tenantId: crossTenant.id, userId: crossOwner.id },
      data: { workEmail: foreignWorkEmail },
    });

    const beforeForeignRequest = await administrator.authActionToken.count({
      where: { tenantId: tenant.id },
    });
    const foreignRequest = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ tenantSlug, email: foreignWorkEmail })
      .expect(202);
    expect(foreignRequest.headers['server-timing']).toBeUndefined();
    await expect(
      administrator.authActionToken.count({ where: { tenantId: tenant.id } }),
    ).resolves.toBe(beforeForeignRequest);

    const workEmailRequest = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ tenantSlug, email: workEmail })
      .expect(202);
    expect(workEmailRequest.headers['server-timing']).toBeUndefined();
    expect(workEmailRequest.body).toEqual(foreignRequest.body);
    const requested = await administrator.authActionToken.findFirstOrThrow({
      where: {
        tenantId: tenant.id,
        userId: member.id,
        purpose: 'PASSWORD_RESET',
        consumedAt: null,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    const rawToken = `ea_reset_${'w'.repeat(43)}`;
    await administrator.authActionToken.update({
      where: { id: requested.id },
      data: { tokenHash: createHmac('sha256', authPepper).update(rawToken).digest('hex') },
    });
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/complete')
      .send({ token: rawToken, newPassword: 'WorkEmailRecovered!2026' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: primaryEmail, password: 'InvitedPassword!2026' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ tenantSlug, email: primaryEmail, password: 'WorkEmailRecovered!2026' })
      .expect(200);
  });

  it('does not let one successful account erase shared network failure history', async () => {
    const values: Record<string, unknown> = {
      AUTH_LOGIN_RATE_LIMIT_ENABLED: true,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: true,
      AUTH_TOKEN_PEPPER: authPepper,
      AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: 5,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: 30,
      AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: 900,
      AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS: 900,
      AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const limiter = new LoginAttemptLimiter(app.get(AuthPrismaService), config);
    const failedAccount = limiter.createContext({
      tenantSlug,
      email: 'sprayed-account@auth-self-test.invalid',
      clientAddress: '203.0.113.8',
    });
    const validAccount = limiter.createContext({
      tenantSlug,
      email: 'valid-account@auth-self-test.invalid',
      clientAddress: '203.0.113.8',
    });
    if (failedAccount.networkKeyHash === null || validAccount.networkKeyHash === null) {
      throw new Error('Expected network throttling to be enabled for this test.');
    }

    try {
      await limiter.beginAttempt(failedAccount);
      await limiter.beginAttempt(validAccount);
      await limiter.clearSuccessfulAttempt(validAccount);

      await expect(
        administrator.authLoginRateLimit.findUniqueOrThrow({
          where: { keyHash: failedAccount.networkKeyHash },
        }),
      ).resolves.toMatchObject({ scope: 'NETWORK', failureCount: 1 });
      await expect(
        administrator.authLoginRateLimit.findUnique({
          where: { keyHash: validAccount.accountKeyHash },
        }),
      ).resolves.toBeNull();
      await expect(
        administrator.authLoginRateLimit.findUniqueOrThrow({
          where: { keyHash: failedAccount.accountKeyHash },
        }),
      ).resolves.toMatchObject({ scope: 'ACCOUNT', failureCount: 1 });
    } finally {
      await administrator.authLoginRateLimit.deleteMany({
        where: {
          keyHash: {
            in: [
              failedAccount.accountKeyHash,
              validAccount.accountKeyHash,
              failedAccount.networkKeyHash,
            ],
          },
        },
      });
    }
  });

  it('shares one network bucket across tenants and stops random login-account growth after blocking', async () => {
    const values: Record<string, unknown> = {
      AUTH_LOGIN_RATE_LIMIT_ENABLED: true,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: true,
      AUTH_TOKEN_PEPPER: authPepper,
      AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: 5,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: 1,
      AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: 900,
      AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS: 900,
      AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const limiter = new LoginAttemptLimiter(app.get(AuthPrismaService), config);
    const first = limiter.createContext({
      tenantSlug,
      email: 'random-one@auth-self-test.invalid',
      clientAddress: '198.51.100.44',
    });
    const second = limiter.createContext({
      tenantSlug: crossTenantSlug,
      email: 'random-two@auth-self-test.invalid',
      clientAddress: '198.51.100.44',
    });
    const third = limiter.createContext({
      tenantSlug: 'nonexistent-tenant',
      email: 'random-three@auth-self-test.invalid',
      clientAddress: '198.51.100.44',
    });
    expect(first.networkKeyHash).toBe(second.networkKeyHash);
    expect(second.networkKeyHash).toBe(third.networkKeyHash);
    if (first.networkKeyHash === null) throw new Error('Expected a global network bucket.');
    const keys = [
      first.networkKeyHash,
      first.accountKeyHash,
      second.accountKeyHash,
      third.accountKeyHash,
    ];

    try {
      await administrator.authLoginRateLimit.deleteMany({ where: { keyHash: { in: keys } } });
      await expect(limiter.beginAttempt(first)).resolves.toBeUndefined();
      await expect(limiter.beginAttempt(second)).rejects.toMatchObject({ status: 429 });
      await expect(limiter.beginAttempt(third)).rejects.toMatchObject({ status: 429 });

      await expect(
        administrator.authLoginRateLimit.findUniqueOrThrow({
          where: { keyHash: first.networkKeyHash },
        }),
      ).resolves.toMatchObject({ scope: 'NETWORK', failureCount: 2 });
      await expect(
        administrator.authLoginRateLimit.findUniqueOrThrow({
          where: { keyHash: first.accountKeyHash },
        }),
      ).resolves.toMatchObject({ scope: 'ACCOUNT', failureCount: 1 });
      await expect(
        administrator.authLoginRateLimit.count({
          where: { keyHash: { in: [second.accountKeyHash, third.accountKeyHash] } },
        }),
      ).resolves.toBe(0);
    } finally {
      await administrator.authLoginRateLimit.deleteMany({ where: { keyHash: { in: keys } } });
    }
  });

  it('bounds random recovery tokens after network blocking and saturates its counter', async () => {
    const values: Record<string, unknown> = {
      AUTH_LOGIN_RATE_LIMIT_ENABLED: true,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: true,
      AUTH_TOKEN_PEPPER: authPepper,
      AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS: 10,
      AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS: 1,
      AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS: 3600,
      AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 100_000,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const limiter = new RecoveryRequestLimiter(app.get(AuthPrismaService), config);
    const contexts = ['a', 'b', 'c'].map((suffix) =>
      limiter.createContext({
        namespace: 'reset-token',
        tenantSlug: `opaque-${suffix}`,
        accountValue: `ea_reset_${suffix.repeat(43)}`,
        clientAddress: '198.51.100.45',
      }),
    );
    const networkKey = contexts[0]!.networkKeyHash;
    if (networkKey === null) throw new Error('Expected a global recovery network bucket.');
    expect(contexts.every((context) => context.networkKeyHash === networkKey)).toBe(true);
    const keys = [networkKey, ...contexts.map((context) => context.accountKeyHash)];

    try {
      await administrator.authLoginRateLimit.deleteMany({ where: { keyHash: { in: keys } } });
      await expect(limiter.beginRequest(contexts[0]!)).resolves.toBeUndefined();
      await expect(limiter.beginRequest(contexts[1]!)).rejects.toMatchObject({ status: 429 });
      await expect(limiter.beginRequest(contexts[2]!)).rejects.toMatchObject({ status: 429 });

      await expect(
        administrator.authLoginRateLimit.findUniqueOrThrow({ where: { keyHash: networkKey } }),
      ).resolves.toMatchObject({ scope: 'RECOVERY_NETWORK', failureCount: 2 });
      await expect(
        administrator.authLoginRateLimit.count({
          where: {
            keyHash: { in: contexts.slice(1).map((context) => context.accountKeyHash) },
          },
        }),
      ).resolves.toBe(0);
    } finally {
      await administrator.authLoginRateLimit.deleteMany({ where: { keyHash: { in: keys } } });
    }
  });

  it('admits at most one concurrent new bucket at a hard scope capacity', async () => {
    const values: Record<string, unknown> = {
      AUTH_LOGIN_RATE_LIMIT_ENABLED: true,
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: false,
      AUTH_TOKEN_PEPPER: authPepper,
      AUTH_RECOVERY_RATE_LIMIT_ACCOUNT_REQUESTS: 10,
      AUTH_RECOVERY_RATE_LIMIT_NETWORK_REQUESTS: 20,
      AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS: 3600,
      AUTH_RATE_LIMIT_BUCKET_CAPACITY_PER_SCOPE: 1,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const limiter = new RecoveryRequestLimiter(app.get(AuthPrismaService), config);
    const contexts = ['one', 'two'].map((value) =>
      limiter.createContext({
        namespace: 'password-request',
        tenantSlug: 'capacity-test',
        accountValue: `${value}@capacity.invalid`,
      }),
    );

    await administrator.authLoginRateLimit.deleteMany({
      where: { scope: { in: ['RECOVERY_ACCOUNT', 'RECOVERY_NETWORK'] } },
    });
    try {
      const results = await Promise.allSettled(
        contexts.map((context) => limiter.beginRequest(context)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await expect(
        administrator.authLoginRateLimit.count({ where: { scope: 'RECOVERY_ACCOUNT' } }),
      ).resolves.toBe(1);
    } finally {
      await administrator.authLoginRateLimit.deleteMany({
        where: { keyHash: { in: contexts.map((context) => context.accountKeyHash) } },
      });
    }
  });

  it('persists an account throttle across requests and rejects even a correct password while blocked', async () => {
    const body = {
      tenantSlug,
      email: 'owner@auth-self-test.invalid',
      password: 'wrong-password',
    };
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(body).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(body).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ ...body, password: 'SelfTestPassword!2026' })
      .expect(429);
  });

  async function cleanup(): Promise<void> {
    const accountKey = createHmac('sha256', authPepper)
      .update(`account\u0000${tenantSlug}\u0000owner@auth-self-test.invalid`, 'utf8')
      .digest('hex');
    await administrator.$executeRaw`
      DELETE FROM public."auth_login_rate_limits" WHERE "key_hash" = ${accountKey}
    `;
    await administrator.authLoginRateLimit.deleteMany({
      where: { scope: { in: ['RECOVERY_ACCOUNT', 'RECOVERY_NETWORK'] } },
    });
    for (const slug of [tenantSlug, crossTenantSlug]) {
      const tenant = await administrator.tenant.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (tenant === null) continue;

      await administrator.$transaction(async (transaction) => {
        await transaction.authSession.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.authActionToken.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.passwordCredential.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.auditEvent.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.employment.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.orgUnit.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.organization.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.user.deleteMany({ where: { tenantId: tenant.id } });
        await transaction.tenant.delete({ where: { id: tenant.id } });
      });
    }
  }
});
