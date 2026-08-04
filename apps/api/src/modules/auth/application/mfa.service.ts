import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { generateSecret, generateURI, verify } from 'otplib';
import type {
  IdentityDeviceRegistration,
  MfaEnrollmentStartRequest,
  MfaEnrollmentStartResponse,
  MfaEnrollmentVerifyRequest,
  MfaEnrollmentVerifyResponse,
  MfaLoginChallengeResponse,
  MfaLoginVerifyRequest,
  MfaStatusResponse,
  RecentMfaChallengeResponse,
  RecentMfaVerifyRequest,
  RecentMfaVerifyResponse,
  TenantRole,
} from '@enterprise/contracts';

import type { EnvironmentVariables } from '../../../config/environment.js';
import { AuthPrismaService } from '../../../database/auth-prisma.service.js';
import { IdentitySecretVault } from '../../identity-governance/identity-secret-vault.js';
import type { AuthenticatedPrincipal } from '../domain/authenticated-principal.js';

const MFA_TOKEN_PREFIX = 'ea_mfa_';
const RECOVERY_CODE_COUNT = 10;
const ENROLLMENT_MAX_AGE_MS = 10 * 60 * 1000;
const INVALID_MFA = 'The multi-factor authentication code is invalid or expired.';

interface ActiveFactorRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly secret_ciphertext: Uint8Array;
  readonly last_accepted_time_step: bigint | null;
  readonly failed_attempt_count: number;
  readonly attempt_window_started_at: Date | null;
  readonly blocked_until: Date | null;
  readonly created_at: Date;
  readonly label: string | null;
  readonly revision: number;
  readonly status: 'PENDING' | 'ACTIVE';
}

interface PolicyRow {
  readonly mfa_requirement: 'OPTIONAL' | 'ADMINS' | 'ALL_USERS';
  readonly totp_allowed_drift_steps: number;
  readonly totp_max_attempts: number;
  readonly totp_attempt_window_seconds: number;
}

interface ChallengeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly session_id: string | null;
  readonly factor_id: string | null;
  readonly status: 'PENDING' | 'VERIFIED' | 'CONSUMED' | 'EXPIRED' | 'LOCKED';
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly expires_at: Date;
  readonly purpose: string;
}

export interface VerifiedMfaLogin {
  readonly tenantId: string;
  readonly userId: string;
  readonly factorId: string;
  readonly method: 'TOTP' | 'RECOVERY_CODE';
  readonly verifiedAt: Date;
  readonly credentialBinding: string;
  readonly loginIdentifierBinding: string;
  readonly device?: IdentityDeviceRegistration;
  readonly sessionLabel?: string;
}

@Injectable()
export class MfaService {
  private readonly pepper: string;
  private readonly challengeTtlSeconds: number;

  constructor(
    @Inject(AuthPrismaService) private readonly prisma: AuthPrismaService,
    @Inject(IdentitySecretVault) private readonly vault: IdentitySecretVault,
    @Inject(ConfigService)
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.pepper = config.get('AUTH_TOKEN_PEPPER', { infer: true });
    this.challengeTtlSeconds = config.get('AUTH_MFA_CHALLENGE_TTL_SECONDS', {
      infer: true,
    });
  }

  async requiresLoginMfa(tenantId: string, userId: string, role: TenantRole): Promise<boolean> {
    return this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, tenantId);
      const [factors, policies] = await Promise.all([
        transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM public."user_mfa_factors"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "user_id" = ${userId}::uuid
            AND "status" = 'ACTIVE'
          LIMIT 1
        `,
        transaction.$queryRaw<PolicyRow[]>`
          SELECT "mfa_requirement", "totp_allowed_drift_steps",
                 "totp_max_attempts", "totp_attempt_window_seconds"
          FROM public."enterprise_identity_policies"
          WHERE "tenant_id" = ${tenantId}::uuid
            AND "publication_status" = 'PUBLISHED'
          LIMIT 1
        `,
      ]);
      if (factors.length > 0) return true;
      const requirement = policies[0]?.mfa_requirement ?? 'OPTIONAL';
      if (requirement === 'ALL_USERS') {
        throw new ForbiddenException('Multi-factor enrollment is required for this account.');
      }
      if (requirement === 'ADMINS' && role !== 'MEMBER') {
        throw new ForbiddenException('Multi-factor enrollment is required for administrators.');
      }
      return false;
    });
  }

  async beginLoginChallenge(
    tenantId: string,
    userId: string,
    credentialBinding: string,
    loginIdentifierBinding: string,
  ): Promise<MfaLoginChallengeResponse> {
    const token = issueMfaToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.challengeTtlSeconds * 1000);
    await this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, tenantId);
      const [factor] = await transaction.$queryRaw<ActiveFactorRow[]>`
        SELECT *
        FROM public."user_mfa_factors"
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "user_id" = ${userId}::uuid
          AND "status" = 'ACTIVE'
        ORDER BY "created_at" DESC
        LIMIT 1
      `;
      if (factor === undefined) {
        throw new ForbiddenException('Multi-factor enrollment is required for this account.');
      }
      const policy = await this.policy(transaction, tenantId);
      await transaction.$executeRaw`
        INSERT INTO public."auth_mfa_challenges" (
          "tenant_id", "user_id", "factor_id", "challenge_hash", "purpose",
          "max_attempts", "issued_at", "expires_at", "idempotency_key"
        ) VALUES (
          ${tenantId}::uuid, ${userId}::uuid, ${factor.id}::uuid,
          ${this.hash('challenge', token)}, ${`LOGIN:${credentialBinding}:${loginIdentifierBinding}`},
          ${policy.totp_max_attempts}, ${now}, ${expiresAt}, ${`login:${randomUUID()}`}
        )
      `;
    });
    return {
      kind: 'MFA_REQUIRED',
      challenge: token,
      expiresAt: expiresAt.toISOString(),
      methods: ['TOTP', 'RECOVERY_CODE'],
    };
  }

  async completeLogin<T>(
    request: MfaLoginVerifyRequest,
    createSession: (
      transaction: Prisma.TransactionClient,
      verified: VerifiedMfaLogin,
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withAuth(async (transaction) => {
      const verified = await this.verifyChallenge(transaction, request, 'LOGIN');
      const result = await createSession(transaction, {
        ...verified,
        ...(request.device === undefined ? {} : { device: request.device }),
        ...(request.sessionLabel === undefined ? {} : { sessionLabel: request.sessionLabel }),
      });
      const consumed = await transaction.$executeRaw`
        UPDATE public."auth_mfa_challenges"
        SET "status" = 'CONSUMED', "consumed_at" = ${verified.verifiedAt}
        WHERE "id" = ${verified.challengeId}::uuid
          AND "status" = 'VERIFIED'
      `;
      if (consumed !== 1) throw invalidMfa();
      return result;
    });
  }

  async startEnrollment(
    request: MfaEnrollmentStartRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<MfaEnrollmentStartResponse> {
    const factorId = randomUUID();
    const secret = generateSecret({ length: 20 });
    const encrypted = this.vault.encrypt(secret, {
      tenantId: principal.tenantId,
      resourceId: factorId,
      purpose: 'MFA_TOTP_SEED',
    });
    const now = new Date();
    await this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, principal.tenantId);
      const active = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM public."user_mfa_factors"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "status" = 'ACTIVE'
        LIMIT 1
      `;
      if (active.length > 0) {
        throw new ConflictException('An active authenticator is already enrolled.');
      }
      await transaction.$executeRaw`
        UPDATE public."user_mfa_factors"
        SET "status" = 'DISABLED',
            "secret_ciphertext" = NULL,
            "secret_ref" = NULL,
            "secret_key_id" = NULL,
            "disabled_at" = ${now},
            "revision" = "revision" + 1,
            "updated_at" = ${now}
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "status" = 'PENDING'
      `;
      await transaction.$executeRaw`
        INSERT INTO public."user_mfa_factors" (
          "id", "tenant_id", "user_id", "label", "secret_ciphertext",
          "secret_key_id", "secret_format_version", "created_at", "updated_at"
        ) VALUES (
          ${factorId}::uuid, ${principal.tenantId}::uuid, ${principal.userId}::uuid,
          ${request.label ?? null}, ${encrypted.ciphertext},
          ${encrypted.keyId}, ${encrypted.formatVersion}, ${now}, ${now}
        )
      `;
    });
    return {
      factorId,
      secret,
      otpauthUri: generateURI({
        issuer: principal.tenantName,
        label: principal.email,
        secret,
        algorithm: 'sha1',
        digits: 6,
        period: 30,
      }),
      expiresAt: new Date(now.getTime() + ENROLLMENT_MAX_AGE_MS).toISOString(),
    };
  }

  async verifyEnrollment(
    request: MfaEnrollmentVerifyRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<MfaEnrollmentVerifyResponse> {
    return this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, principal.tenantId);
      const [factor] = await transaction.$queryRaw<ActiveFactorRow[]>`
        SELECT *
        FROM public."user_mfa_factors"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "id" = ${request.factorId}::uuid
        FOR UPDATE
      `;
      if (
        factor === undefined ||
        factor.status !== 'PENDING' ||
        Date.now() - factor.created_at.getTime() > ENROLLMENT_MAX_AGE_MS
      ) {
        throw invalidMfa();
      }
      const secret = this.decryptFactor(factor);
      const result = await verify({ secret, token: request.code, epochTolerance: 30 });
      if (!result.valid || !('timeStep' in result)) throw invalidMfa();
      const now = new Date();
      const updated = await transaction.$executeRaw`
        UPDATE public."user_mfa_factors"
        SET "status" = 'ACTIVE',
            "verified_at" = ${now},
            "last_accepted_time_step" = ${BigInt(result.timeStep)},
            "failed_attempt_count" = 0,
            "attempt_window_started_at" = NULL,
            "blocked_until" = NULL,
            "revision" = "revision" + 1,
            "updated_at" = ${now}
        WHERE "id" = ${factor.id}::uuid
          AND "status" = 'PENDING'
      `;
      if (updated !== 1) throw invalidMfa();
      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => issueRecoveryCode());
      for (const code of recoveryCodes) {
        await transaction.$executeRaw`
          INSERT INTO public."mfa_recovery_codes" (
            "tenant_id", "user_id", "factor_id", "code_hash"
          ) VALUES (
            ${principal.tenantId}::uuid, ${principal.userId}::uuid,
            ${factor.id}::uuid, ${this.hash('recovery-code', canonicalRecoveryCode(code))}
          )
        `;
      }
      return {
        factor: {
          id: factor.id,
          method: 'TOTP',
          status: 'ACTIVE',
          label: factor.label,
          verifiedAt: now.toISOString(),
          revision: factor.revision + 1,
        },
        recoveryCodes,
      };
    });
  }

  async status(principal: AuthenticatedPrincipal): Promise<MfaStatusResponse> {
    return this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, principal.tenantId);
      const [factors, remaining, sessions] = await Promise.all([
        transaction.$queryRaw<
          Array<{
            id: string;
            method: 'TOTP';
            status: 'PENDING' | 'ACTIVE' | 'DISABLED';
            label: string | null;
            verified_at: Date | null;
            disabled_at: Date | null;
            blocked_until: Date | null;
            revision: number;
          }>
        >`
          SELECT "id", "method", "status", "label", "verified_at",
                 "disabled_at", "blocked_until", "revision"
          FROM public."identity_mfa_factor_metadata"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "user_id" = ${principal.userId}::uuid
          ORDER BY "created_at" DESC
        `,
        transaction.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS "count"
          FROM public."mfa_recovery_codes"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "user_id" = ${principal.userId}::uuid
            AND "consumed_at" IS NULL
            AND "revoked_at" IS NULL
        `,
        transaction.$queryRaw<Array<{ last_mfa_at: Date | null }>>`
          SELECT "last_mfa_at"
          FROM public."identity_session_metadata"
          WHERE "tenant_id" = ${principal.tenantId}::uuid
            AND "id" = ${principal.sessionId}::uuid
          LIMIT 1
        `,
      ]);
      return {
        factors: factors.map((factor) => ({
          id: factor.id,
          method: factor.method,
          status: factor.status,
          label: factor.label,
          verifiedAt: factor.verified_at?.toISOString() ?? null,
          disabledAt: factor.disabled_at?.toISOString() ?? null,
          blockedUntil: factor.blocked_until?.toISOString() ?? null,
          revision: factor.revision,
        })),
        recoveryCodesRemaining: Number(remaining[0]?.count ?? 0),
        recentMfaAt: sessions[0]?.last_mfa_at?.toISOString() ?? null,
      };
    });
  }

  async beginRecentMfa(
    purpose: string,
    principal: AuthenticatedPrincipal,
  ): Promise<RecentMfaChallengeResponse> {
    const token = issueMfaToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.challengeTtlSeconds * 1000);
    await this.prisma.withAuth(async (transaction) => {
      await setTenant(transaction, principal.tenantId);
      const [factor] = await transaction.$queryRaw<ActiveFactorRow[]>`
        SELECT *
        FROM public."user_mfa_factors"
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "status" = 'ACTIVE'
        LIMIT 1
      `;
      if (factor === undefined) {
        throw new ForbiddenException('An active authenticator is required.');
      }
      const policy = await this.policy(transaction, principal.tenantId);
      await transaction.$executeRaw`
        INSERT INTO public."auth_mfa_challenges" (
          "tenant_id", "user_id", "session_id", "factor_id", "challenge_hash",
          "purpose", "max_attempts", "issued_at", "expires_at", "idempotency_key"
        ) VALUES (
          ${principal.tenantId}::uuid, ${principal.userId}::uuid,
          ${principal.sessionId}::uuid, ${factor.id}::uuid,
          ${this.hash('challenge', token)}, ${purpose}, ${policy.totp_max_attempts},
          ${now}, ${expiresAt}, ${`step-up:${randomUUID()}`}
        )
      `;
    });
    return {
      challenge: token,
      expiresAt: expiresAt.toISOString(),
      methods: ['TOTP', 'RECOVERY_CODE'],
    };
  }

  async verifyRecentMfa(
    request: RecentMfaVerifyRequest,
    principal: AuthenticatedPrincipal,
  ): Promise<RecentMfaVerifyResponse> {
    return this.prisma.withAuth(async (transaction) => {
      const verified = await this.verifyChallenge(transaction, request, undefined, principal);
      const updated = await transaction.$executeRaw`
        UPDATE public."auth_sessions"
        SET "last_mfa_at" = ${verified.verifiedAt},
            "last_mfa_method" = ${verified.method}::public."MfaMethod",
            "last_mfa_factor_id" = ${verified.factorId}::uuid,
            "version" = "version" + 1
        WHERE "tenant_id" = ${principal.tenantId}::uuid
          AND "id" = ${principal.sessionId}::uuid
          AND "user_id" = ${principal.userId}::uuid
          AND "revoked_at" IS NULL
      `;
      if (updated !== 1) throw invalidMfa();
      await transaction.$executeRaw`
        UPDATE public."auth_mfa_challenges"
        SET "status" = 'CONSUMED', "consumed_at" = ${verified.verifiedAt}
        WHERE "id" = ${verified.challengeId}::uuid
          AND "status" = 'VERIFIED'
      `;
      return {
        verifiedAt: verified.verifiedAt.toISOString(),
        method: verified.method,
      };
    });
  }

  async upsertDevice(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    device: IdentityDeviceRegistration | undefined,
  ): Promise<string | null> {
    if (device === undefined) return null;
    const fingerprintHash = this.hash('device-fingerprint', device.fingerprint);
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      INSERT INTO public."identity_devices" (
        "tenant_id", "user_id", "fingerprint_hash", "label", "platform",
        "device_class"
      ) VALUES (
        ${tenantId}::uuid, ${userId}::uuid, ${fingerprintHash},
        ${device.label ?? null}, ${device.platform ?? null}, ${device.deviceClass ?? null}
      )
      ON CONFLICT ("tenant_id", "user_id", "fingerprint_hash")
      DO UPDATE SET
        "last_seen_at" = CURRENT_TIMESTAMP,
        "label" = COALESCE(EXCLUDED."label", public."identity_devices"."label"),
        "platform" = COALESCE(EXCLUDED."platform", public."identity_devices"."platform"),
        "device_class" = COALESCE(
          EXCLUDED."device_class", public."identity_devices"."device_class"
        ),
        "updated_at" = CURRENT_TIMESTAMP
      RETURNING "id"
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Device registration did not return an identity.');
    return id;
  }

  credentialBinding(passwordHash: string): string {
    return this.hash('login-credential-binding', passwordHash);
  }

  loginIdentifierBinding(email: string): string {
    return this.hash('login-identifier-binding', email.trim().toLowerCase());
  }

  private async verifyChallenge(
    transaction: Prisma.TransactionClient,
    request: Pick<MfaLoginVerifyRequest, 'challenge' | 'code' | 'method'>,
    requiredPurpose?: string,
    principal?: AuthenticatedPrincipal,
  ): Promise<{
    tenantId: string;
    userId: string;
    factorId: string;
    challengeId: string;
    method: 'TOTP' | 'RECOVERY_CODE';
    verifiedAt: Date;
    credentialBinding: string;
    loginIdentifierBinding: string;
  }> {
    const challengeHash = this.hash('challenge', request.challenge);
    const [challenge] = await transaction.$queryRaw<ChallengeRow[]>`
      SELECT *
      FROM public."auth_mfa_challenges"
      WHERE "challenge_hash" = ${challengeHash}
      FOR UPDATE
    `;
    const now = new Date();
    if (
      challenge === undefined ||
      challenge.status !== 'PENDING' ||
      challenge.expires_at <= now ||
      challenge.attempt_count >= challenge.max_attempts ||
      (requiredPurpose !== undefined &&
        challenge.purpose !== requiredPurpose &&
        !challenge.purpose.startsWith(`${requiredPurpose}:`)) ||
      (principal !== undefined &&
        (challenge.tenant_id !== principal.tenantId ||
          challenge.user_id !== principal.userId ||
          challenge.session_id !== principal.sessionId))
    ) {
      throw invalidMfa();
    }
    await setTenant(transaction, challenge.tenant_id);
    if (challenge.factor_id === null) throw invalidMfa();
    const [factor] = await transaction.$queryRaw<ActiveFactorRow[]>`
      SELECT *
      FROM public."user_mfa_factors"
      WHERE "tenant_id" = ${challenge.tenant_id}::uuid
        AND "user_id" = ${challenge.user_id}::uuid
        AND "id" = ${challenge.factor_id}::uuid
        AND "status" = 'ACTIVE'
      FOR UPDATE
    `;
    if (factor === undefined || (factor.blocked_until !== null && factor.blocked_until > now)) {
      throw invalidMfa();
    }
    const policy = await this.policy(transaction, challenge.tenant_id);
    let acceptedTimeStep: bigint | null = null;
    let recoveryCodeId: string | null = null;
    let valid = false;
    if (request.method === 'TOTP' && /^\d{6}$/.test(request.code)) {
      const secret = this.decryptFactor(factor);
      const result = await verify({
        secret,
        token: request.code,
        epochTolerance: policy.totp_allowed_drift_steps * 30,
        ...(factor.last_accepted_time_step === null
          ? {}
          : { afterTimeStep: Number(factor.last_accepted_time_step) }),
      });
      valid = result.valid && 'timeStep' in result;
      if (valid && 'timeStep' in result) acceptedTimeStep = BigInt(result.timeStep);
    } else if (request.method === 'RECOVERY_CODE') {
      const codeHash = this.hash('recovery-code', canonicalRecoveryCode(request.code));
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM public."mfa_recovery_codes"
        WHERE "tenant_id" = ${challenge.tenant_id}::uuid
          AND "user_id" = ${challenge.user_id}::uuid
          AND "factor_id" = ${factor.id}::uuid
          AND "code_hash" = ${codeHash}
          AND "consumed_at" IS NULL
          AND "revoked_at" IS NULL
        FOR UPDATE
      `;
      recoveryCodeId = rows[0]?.id ?? null;
      valid = recoveryCodeId !== null;
    }
    if (!valid) {
      await this.recordFailure(transaction, challenge, factor, policy, now);
      throw invalidMfa();
    }
    if (recoveryCodeId !== null) {
      const consumed = await transaction.$executeRaw`
        UPDATE public."mfa_recovery_codes"
        SET "consumed_at" = ${now}
        WHERE "id" = ${recoveryCodeId}::uuid
          AND "consumed_at" IS NULL
          AND "revoked_at" IS NULL
      `;
      if (consumed !== 1) throw invalidMfa();
    }
    const factorUpdated = await transaction.$executeRaw`
      UPDATE public."user_mfa_factors"
      SET "last_accepted_time_step" = COALESCE(
            ${acceptedTimeStep}, "last_accepted_time_step"
          ),
          "failed_attempt_count" = 0,
          "attempt_window_started_at" = NULL,
          "blocked_until" = NULL,
          "revision" = "revision" + 1,
          "updated_at" = ${now}
      WHERE "id" = ${factor.id}::uuid
        AND (
          ${acceptedTimeStep}::bigint IS NULL
          OR "last_accepted_time_step" IS NULL
          OR "last_accepted_time_step" < ${acceptedTimeStep}
        )
    `;
    if (factorUpdated !== 1) throw invalidMfa();
    const challengeUpdated = await transaction.$executeRaw`
      UPDATE public."auth_mfa_challenges"
      SET "status" = 'VERIFIED',
          "verification_method" = ${request.method}::public."MfaMethod",
          "accepted_time_step" = ${acceptedTimeStep},
          "recovery_code_id" = ${recoveryCodeId}::uuid,
          "verified_at" = ${now},
          "factor_id" = ${factor.id}::uuid
      WHERE "id" = ${challenge.id}::uuid
        AND "status" = 'PENDING'
    `;
    if (challengeUpdated !== 1) throw invalidMfa();
    const loginBindings =
      requiredPurpose === 'LOGIN' && challenge.purpose.startsWith('LOGIN:')
        ? challenge.purpose.slice('LOGIN:'.length).split(':')
        : [];
    return {
      tenantId: challenge.tenant_id,
      userId: challenge.user_id,
      factorId: factor.id,
      challengeId: challenge.id,
      method: request.method,
      verifiedAt: now,
      credentialBinding: loginBindings[0] ?? '',
      loginIdentifierBinding: loginBindings[1] ?? '',
    };
  }

  private async recordFailure(
    transaction: Prisma.TransactionClient,
    challenge: ChallengeRow,
    factor: ActiveFactorRow,
    policy: PolicyRow,
    now: Date,
  ): Promise<void> {
    const windowMs = policy.totp_attempt_window_seconds * 1000;
    const withinWindow =
      factor.attempt_window_started_at !== null &&
      now.getTime() - factor.attempt_window_started_at.getTime() <= windowMs;
    const nextFactorAttempts = withinWindow ? factor.failed_attempt_count + 1 : 1;
    const nextChallengeAttempts = challenge.attempt_count + 1;
    const locked =
      nextChallengeAttempts >= challenge.max_attempts ||
      nextFactorAttempts >= policy.totp_max_attempts;
    const blockedUntil = locked ? new Date(now.getTime() + windowMs) : null;
    await transaction.$executeRaw`
      UPDATE public."user_mfa_factors"
      SET "failed_attempt_count" = ${nextFactorAttempts},
          "attempt_window_started_at" = ${withinWindow ? factor.attempt_window_started_at : now},
          "blocked_until" = ${blockedUntil},
          "revision" = "revision" + 1,
          "updated_at" = ${now}
      WHERE "id" = ${factor.id}::uuid
    `;
    await transaction.$executeRaw`
      UPDATE public."auth_mfa_challenges"
      SET "attempt_count" = ${nextChallengeAttempts},
          "status" = ${locked ? 'LOCKED' : 'PENDING'}::public."MfaChallengeStatus"
      WHERE "id" = ${challenge.id}::uuid
    `;
  }

  private async policy(
    transaction: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<PolicyRow> {
    const rows = await transaction.$queryRaw<PolicyRow[]>`
      SELECT "mfa_requirement", "totp_allowed_drift_steps",
             "totp_max_attempts", "totp_attempt_window_seconds"
      FROM public."enterprise_identity_policies"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "publication_status" = 'PUBLISHED'
      LIMIT 1
    `;
    return (
      rows[0] ?? {
        mfa_requirement: 'OPTIONAL',
        totp_allowed_drift_steps: 1,
        totp_max_attempts: 5,
        totp_attempt_window_seconds: 300,
      }
    );
  }

  private decryptFactor(factor: ActiveFactorRow): string {
    return this.vault.decrypt(factor.secret_ciphertext, {
      tenantId: factor.tenant_id,
      resourceId: factor.id,
      purpose: 'MFA_TOTP_SEED',
    });
  }

  private hash(namespace: string, value: string): string {
    return createHmac('sha256', this.pepper)
      .update(`enterprise-agent:${namespace}:v1\0`)
      .update(value)
      .digest('hex');
  }
}

async function setTenant(transaction: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

function issueMfaToken(): string {
  return `${MFA_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function issueRecoveryCode(): string {
  const raw = randomBytes(10).toString('hex').toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
}

function canonicalRecoveryCode(value: string): string {
  return value.toUpperCase().replaceAll(/[\s-]/g, '');
}

function invalidMfa(): UnauthorizedException {
  return new UnauthorizedException(INVALID_MFA);
}
