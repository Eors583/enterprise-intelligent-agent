-- Enterprise identity governance foundation.
--
-- Security invariants established here:
--   * TOTP seeds, OIDC client secrets, and PKCE verifiers are ciphertext or
--     secret-manager references. No relation has a plaintext-secret column.
--   * Recovery codes, bearer tokens, device fingerprints, state, nonce, and
--     replay identifiers are stored only as server-peppered digests.
--   * Existing password login and existing auth_sessions remain valid. Device
--     binding is nullable for legacy rows, while every session receives a
--     refresh family/version so rotation history can be introduced safely.
--   * OIDC/SAML providers start NOT_VERIFIED and cannot be published until a
--     real verifier has supplied evidence for the exact configuration hash.
--   * SAML is fail-closed. This migration models the verifier port and receipts;
--     it does not claim to implement XML signature verification.
--   * Every tenant-scoped relation uses a composite tenant foreign key, FORCE
--     RLS, and explicit capability-role ACLs.

BEGIN;

CREATE TYPE public."IdentityPublicationStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED'
);
CREATE TYPE public."IdentityVerificationStatus" AS ENUM (
  'NOT_VERIFIED', 'VERIFIED', 'FAILED'
);
CREATE TYPE public."MfaPolicyRequirement" AS ENUM (
  'OPTIONAL', 'ADMINS', 'ALL_USERS'
);
CREATE TYPE public."MfaFactorStatus" AS ENUM (
  'PENDING', 'ACTIVE', 'DISABLED'
);
CREATE TYPE public."MfaMethod" AS ENUM ('TOTP', 'RECOVERY_CODE');
CREATE TYPE public."MfaChallengeStatus" AS ENUM (
  'PENDING', 'VERIFIED', 'CONSUMED', 'EXPIRED', 'LOCKED'
);
CREATE TYPE public."IdentityDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE public."IdentityProviderProtocol" AS ENUM ('OIDC', 'SAML');
CREATE TYPE public."IdentityProviderJitMode" AS ENUM (
  'DISABLED', 'EXISTING_USERS_ONLY', 'CREATE_USERS'
);
CREATE TYPE public."ExternalIdentityBindingStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE public."ScimConnectorStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'ACTIVE', 'SUSPENDED', 'RETIRED'
);
CREATE TYPE public."ScimTokenStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE public."ScimRequestStatus" AS ENUM (
  'IN_PROGRESS', 'SUCCEEDED', 'FAILED'
);
CREATE TYPE public."IdentityGovernanceCommandStatus" AS ENUM (
  'APPLIED', 'REJECTED'
);
CREATE TYPE public."BreakGlassRequestStatus" AS ENUM (
  'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'REVIEW_PENDING', 'CLOSED', 'REJECTED'
);
CREATE TYPE public."BreakGlassTerminationKind" AS ENUM ('EXPIRED', 'REVOKED');

-- One mutable, CAS-governed policy row per tenant. Absence of a row preserves
-- the current local-login behavior; creating one starts in DRAFT.
CREATE TABLE public."enterprise_identity_policies" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "publication_status" public."IdentityPublicationStatus" NOT NULL DEFAULT 'DRAFT',
  "mfa_requirement" public."MfaPolicyRequirement" NOT NULL DEFAULT 'OPTIONAL',
  "require_recent_mfa_for_admin" boolean NOT NULL DEFAULT true,
  "recent_mfa_max_age_seconds" integer NOT NULL DEFAULT 300,
  "totp_allowed_drift_steps" integer NOT NULL DEFAULT 1,
  "totp_max_attempts" integer NOT NULL DEFAULT 5,
  "totp_attempt_window_seconds" integer NOT NULL DEFAULT 300,
  "allow_local_password_fallback" boolean NOT NULL DEFAULT true,
  "revision" integer NOT NULL DEFAULT 1,
  "approved_revision" integer,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "proposed_by_user_id" uuid NOT NULL,
  "approved_by_user_id" uuid,
  "approved_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "enterprise_identity_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "enterprise_identity_policies_tenant_id_key" UNIQUE ("tenant_id"),
  CONSTRAINT "enterprise_identity_policies_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "enterprise_identity_policies_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "enterprise_identity_policies_bounds_check" CHECK (
    "revision" > 0
    AND "recent_mfa_max_age_seconds" BETWEEN 60 AND 3600
    AND "totp_allowed_drift_steps" BETWEEN 0 AND 1
    AND "totp_max_attempts" BETWEEN 3 AND 20
    AND "totp_attempt_window_seconds" BETWEEN 60 AND 3600
  ),
  CONSTRAINT "enterprise_identity_policies_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "enterprise_identity_policies_approval_check" CHECK (
    (
      "publication_status" = 'PUBLISHED'
      AND "approved_revision" = "revision"
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "proposed_by_user_id"
      AND "approved_at" IS NOT NULL
    )
    OR "publication_status" <> 'PUBLISHED'
  ),
  CONSTRAINT "enterprise_identity_policies_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "enterprise_identity_policies_proposer_fkey"
    FOREIGN KEY ("tenant_id", "proposed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "enterprise_identity_policies_approver_fkey"
    FOREIGN KEY ("tenant_id", "approved_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

-- The secret tuple deliberately has no plaintext alternative. A disabled
-- factor must have its recoverable seed erased while retaining audit metadata.
CREATE TABLE public."user_mfa_factors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "method" public."MfaMethod" NOT NULL DEFAULT 'TOTP',
  "status" public."MfaFactorStatus" NOT NULL DEFAULT 'PENDING',
  "label" varchar(120),
  "secret_ciphertext" bytea,
  "secret_ref" varchar(1000),
  "secret_key_id" varchar(200),
  "secret_format_version" integer NOT NULL DEFAULT 1,
  "verified_at" timestamptz(6),
  "disabled_at" timestamptz(6),
  "last_accepted_time_step" bigint,
  "failed_attempt_count" integer NOT NULL DEFAULT 0,
  "attempt_window_started_at" timestamptz(6),
  "blocked_until" timestamptz(6),
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_mfa_factors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_mfa_factors_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "user_mfa_factors_tenant_id_id_user_id_key"
    UNIQUE ("tenant_id", "id", "user_id"),
  CONSTRAINT "user_mfa_factors_method_check" CHECK ("method" = 'TOTP'),
  CONSTRAINT "user_mfa_factors_secret_storage_check" CHECK (
    (
      "status" IN ('PENDING', 'ACTIVE')
      AND (("secret_ciphertext" IS NOT NULL)::integer
         + ("secret_ref" IS NOT NULL)::integer) = 1
      AND (
        "secret_ciphertext" IS NULL
        OR ("secret_key_id" IS NOT NULL AND octet_length("secret_ciphertext") >= 32)
      )
      AND ("secret_ref" IS NULL OR btrim("secret_ref") <> '')
    )
    OR (
      "status" = 'DISABLED'
      AND "secret_ciphertext" IS NULL
      AND "secret_ref" IS NULL
      AND "secret_key_id" IS NULL
    )
  ),
  CONSTRAINT "user_mfa_factors_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "verified_at" IS NULL
      AND "disabled_at" IS NULL
    )
    OR (
      "status" = 'ACTIVE'
      AND "verified_at" IS NOT NULL
      AND "disabled_at" IS NULL
    )
    OR (
      "status" = 'DISABLED'
      AND "disabled_at" IS NOT NULL
    )
  ),
  CONSTRAINT "user_mfa_factors_attempt_check" CHECK (
    "secret_format_version" > 0
    AND "revision" > 0
    AND "failed_attempt_count" >= 0
    AND ("last_accepted_time_step" IS NULL OR "last_accepted_time_step" >= 0)
    AND (
      "blocked_until" IS NULL
      OR (
        "attempt_window_started_at" IS NOT NULL
        AND "blocked_until" >= "attempt_window_started_at"
      )
    )
  ),
  CONSTRAINT "user_mfa_factors_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "user_mfa_factors_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "user_mfa_factors_one_live_totp_idx"
  ON public."user_mfa_factors"("tenant_id", "user_id")
  WHERE "status" IN ('PENDING', 'ACTIVE');
CREATE INDEX "user_mfa_factors_user_status_idx"
  ON public."user_mfa_factors"("tenant_id", "user_id", "status");

-- Raw recovery codes are returned once by the API and never persisted. The
-- code_hash is an HMAC/peppered digest, not a fast unsalted hash.
CREATE TABLE public."mfa_recovery_codes" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "factor_id" uuid NOT NULL,
  "code_hash" char(64) NOT NULL,
  "consumed_at" timestamptz(6),
  "revoked_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_recovery_codes_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "mfa_recovery_codes_tenant_id_id_user_id_key"
    UNIQUE ("tenant_id", "id", "user_id"),
  CONSTRAINT "mfa_recovery_codes_code_hash_key" UNIQUE ("code_hash"),
  CONSTRAINT "mfa_recovery_codes_hash_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mfa_recovery_codes_terminal_check"
    CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL),
  CONSTRAINT "mfa_recovery_codes_factor_fkey"
    FOREIGN KEY ("tenant_id", "factor_id", "user_id")
    REFERENCES public."user_mfa_factors"("tenant_id", "id", "user_id")
    ON DELETE CASCADE,
  CONSTRAINT "mfa_recovery_codes_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "mfa_recovery_codes_available_idx"
  ON public."mfa_recovery_codes"("tenant_id", "user_id", "factor_id")
  WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;

-- Device fingerprints and network identifiers are server-peppered digests.
CREATE TABLE public."identity_devices" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "fingerprint_hash" char(64) NOT NULL,
  "fingerprint_version" integer NOT NULL DEFAULT 1,
  "label" varchar(120),
  "platform" varchar(80),
  "device_class" varchar(40),
  "status" public."IdentityDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "first_seen_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" timestamptz(6),
  "revoked_by_user_id" uuid,
  "revoke_reason" varchar(500),
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_devices_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "identity_devices_tenant_id_id_user_id_key"
    UNIQUE ("tenant_id", "id", "user_id"),
  CONSTRAINT "identity_devices_fingerprint_key"
    UNIQUE ("tenant_id", "user_id", "fingerprint_hash"),
  CONSTRAINT "identity_devices_fingerprint_check"
    CHECK ("fingerprint_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_devices_bounds_check"
    CHECK ("fingerprint_version" > 0 AND "revision" > 0),
  CONSTRAINT "identity_devices_revocation_check" CHECK (
    (
      "status" = 'ACTIVE'
      AND "revoked_at" IS NULL
      AND "revoked_by_user_id" IS NULL
      AND "revoke_reason" IS NULL
    )
    OR (
      "status" = 'REVOKED'
      AND "revoked_at" IS NOT NULL
      AND length(btrim("revoke_reason")) BETWEEN 1 AND 500
    )
  ),
  CONSTRAINT "identity_devices_seen_check"
    CHECK ("last_seen_at" >= "first_seen_at"),
  CONSTRAINT "identity_devices_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "identity_devices_revoker_fkey"
    FOREIGN KEY ("tenant_id", "revoked_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "identity_devices_user_status_seen_idx"
  ON public."identity_devices"(
    "tenant_id", "user_id", "status", "last_seen_at" DESC
  );

-- Preserve every existing session while adding device, step-up, and refresh
-- rotation state. gen_random_uuid() is evaluated per legacy row.
ALTER TABLE public."auth_sessions"
  ADD CONSTRAINT "auth_sessions_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  ADD CONSTRAINT "auth_sessions_tenant_id_id_user_id_key"
    UNIQUE ("tenant_id", "id", "user_id"),
  ADD COLUMN "device_id" uuid,
  ADD COLUMN "refresh_family_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "refresh_generation" integer NOT NULL DEFAULT 1,
  ADD COLUMN "last_mfa_at" timestamptz(6),
  ADD COLUMN "last_mfa_method" public."MfaMethod",
  ADD COLUMN "last_mfa_factor_id" uuid,
  ADD COLUMN "last_network_hash" char(64),
  ADD COLUMN "refresh_replay_detected_at" timestamptz(6),
  ADD COLUMN "revoked_reason" varchar(500),
  ADD COLUMN "version" integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT "auth_sessions_refresh_generation_check"
    CHECK ("refresh_generation" > 0 AND "version" > 0),
  ADD CONSTRAINT "auth_sessions_network_hash_check"
    CHECK (
      "last_network_hash" IS NULL
      OR "last_network_hash" ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT "auth_sessions_mfa_tuple_check" CHECK (
    (
      "last_mfa_at" IS NULL
      AND "last_mfa_method" IS NULL
      AND "last_mfa_factor_id" IS NULL
    )
    OR (
      "last_mfa_at" IS NOT NULL
      AND "last_mfa_method" IS NOT NULL
      AND "last_mfa_factor_id" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "auth_sessions_device_fkey"
    FOREIGN KEY ("tenant_id", "device_id", "user_id")
    REFERENCES public."identity_devices"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "auth_sessions_mfa_factor_fkey"
    FOREIGN KEY ("tenant_id", "last_mfa_factor_id", "user_id")
    REFERENCES public."user_mfa_factors"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT;

CREATE INDEX "auth_sessions_device_active_idx"
  ON public."auth_sessions"("tenant_id", "user_id", "device_id", "revoked_at");
CREATE INDEX "auth_sessions_refresh_family_idx"
  ON public."auth_sessions"("tenant_id", "refresh_family_id", "refresh_generation");

-- Spent refresh hashes make a replay distinguishable from an invalid token.
-- The currently valid refresh hash remains in auth_sessions for compatibility.
CREATE TABLE public."auth_refresh_token_history" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "refresh_family_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "token_hash" char(64) NOT NULL,
  "successor_token_hash" char(64) NOT NULL,
  "rotated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamptz(6) NOT NULL,
  "replayed_at" timestamptz(6),
  CONSTRAINT "auth_refresh_token_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_refresh_token_history_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "auth_refresh_token_history_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "auth_refresh_token_history_family_generation_key"
    UNIQUE ("tenant_id", "refresh_family_id", "generation"),
  CONSTRAINT "auth_refresh_token_history_hash_check" CHECK (
    "token_hash" ~ '^[0-9a-f]{64}$'
    AND "successor_token_hash" ~ '^[0-9a-f]{64}$'
    AND "token_hash" <> "successor_token_hash"
  ),
  CONSTRAINT "auth_refresh_token_history_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "auth_refresh_token_history_expiry_check"
    CHECK ("expires_at" >= "rotated_at"),
  CONSTRAINT "auth_refresh_token_history_session_fkey"
    FOREIGN KEY ("tenant_id", "session_id", "user_id")
    REFERENCES public."auth_sessions"("tenant_id", "id", "user_id")
    ON DELETE CASCADE,
  CONSTRAINT "auth_refresh_token_history_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "auth_refresh_token_history_session_idx"
  ON public."auth_refresh_token_history"(
    "tenant_id", "session_id", "generation" DESC
  );

-- Opaque, single-use step-up challenge. challenge_hash is peppered; an
-- accepted TOTP time step is recorded so the service can atomically reject
-- reuse and advance user_mfa_factors.last_accepted_time_step.
CREATE TABLE public."auth_mfa_challenges" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid,
  "factor_id" uuid,
  "recovery_code_id" uuid,
  "verification_method" public."MfaMethod",
  "challenge_hash" char(64) NOT NULL,
  "purpose" varchar(120) NOT NULL,
  "status" public."MfaChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "accepted_time_step" bigint,
  "issued_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamptz(6) NOT NULL,
  "verified_at" timestamptz(6),
  "consumed_at" timestamptz(6),
  "idempotency_key" varchar(200) NOT NULL,
  CONSTRAINT "auth_mfa_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_mfa_challenges_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "auth_mfa_challenges_hash_key" UNIQUE ("challenge_hash"),
  CONSTRAINT "auth_mfa_challenges_idempotency_key"
    UNIQUE ("tenant_id", "user_id", "idempotency_key"),
  CONSTRAINT "auth_mfa_challenges_hash_check"
    CHECK ("challenge_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "auth_mfa_challenges_bounds_check" CHECK (
    "attempt_count" >= 0
    AND "max_attempts" BETWEEN 1 AND 20
    AND "attempt_count" <= "max_attempts"
    AND "expires_at" > "issued_at"
    AND "expires_at" <= "issued_at" + interval '10 minutes'
    AND ("accepted_time_step" IS NULL OR "accepted_time_step" >= 0)
    AND (
      "verified_at" IS NULL
      OR "verified_at" BETWEEN "issued_at" AND "expires_at"
    )
    AND (
      "consumed_at" IS NULL
      OR ("verified_at" IS NOT NULL AND "consumed_at" >= "verified_at")
    )
  ),
  CONSTRAINT "auth_mfa_challenges_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "verified_at" IS NULL
      AND "consumed_at" IS NULL
      AND "accepted_time_step" IS NULL
      AND "recovery_code_id" IS NULL
      AND "verification_method" IS NULL
    )
    OR (
      "status" = 'VERIFIED'
      AND "verified_at" IS NOT NULL
      AND "consumed_at" IS NULL
      AND "factor_id" IS NOT NULL
      AND "verification_method" IS NOT NULL
      AND (
        (
          "verification_method" = 'TOTP'
          AND "accepted_time_step" IS NOT NULL
          AND "recovery_code_id" IS NULL
        )
        OR (
          "verification_method" = 'RECOVERY_CODE'
          AND "accepted_time_step" IS NULL
          AND "recovery_code_id" IS NOT NULL
        )
      )
    )
    OR (
      "status" = 'CONSUMED'
      AND "verified_at" IS NOT NULL
      AND "consumed_at" IS NOT NULL
      AND "factor_id" IS NOT NULL
      AND "verification_method" IS NOT NULL
    )
    OR (
      "status" IN ('EXPIRED', 'LOCKED')
      AND "consumed_at" IS NULL
    )
  ),
  CONSTRAINT "auth_mfa_challenges_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "auth_mfa_challenges_session_fkey"
    FOREIGN KEY ("tenant_id", "session_id", "user_id")
    REFERENCES public."auth_sessions"("tenant_id", "id", "user_id")
    ON DELETE CASCADE,
  CONSTRAINT "auth_mfa_challenges_factor_fkey"
    FOREIGN KEY ("tenant_id", "factor_id", "user_id")
    REFERENCES public."user_mfa_factors"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT,
  CONSTRAINT "auth_mfa_challenges_recovery_code_fkey"
    FOREIGN KEY ("tenant_id", "recovery_code_id", "user_id")
    REFERENCES public."mfa_recovery_codes"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT
);

CREATE INDEX "auth_mfa_challenges_pending_idx"
  ON public."auth_mfa_challenges"(
    "tenant_id", "user_id", "status", "expires_at"
  );

-- Reuse the existing persistent login limiter for MFA attempts. The service
-- continues to derive account/network keys with AUTH_TOKEN_PEPPER.
ALTER TABLE public."auth_login_rate_limits"
  DROP CONSTRAINT "auth_login_rate_limits_scope_check";
ALTER TABLE public."auth_login_rate_limits"
  ADD CONSTRAINT "auth_login_rate_limits_scope_check" CHECK (
    "scope" IN (
      'ACCOUNT', 'NETWORK',
      'RECOVERY_ACCOUNT', 'RECOVERY_NETWORK',
      'MFA_ACCOUNT', 'MFA_NETWORK'
    )
  );

-- ---------------------------------------------------------------------------
-- Enterprise OIDC/SAML provider configuration
-- ---------------------------------------------------------------------------

CREATE TABLE public."enterprise_identity_providers" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "key" varchar(100) NOT NULL,
  "display_name" varchar(200) NOT NULL,
  "protocol" public."IdentityProviderProtocol" NOT NULL,
  "verification_status" public."IdentityVerificationStatus"
    NOT NULL DEFAULT 'NOT_VERIFIED',
  "publication_status" public."IdentityPublicationStatus"
    NOT NULL DEFAULT 'DRAFT',
  "configuration_hash" char(64) NOT NULL,
  "verified_configuration_hash" char(64),
  "verification_evidence_hash" char(64),
  "verification_error_code" varchar(120),
  "verified_at" timestamptz(6),
  "jit_mode" public."IdentityProviderJitMode"
    NOT NULL DEFAULT 'EXISTING_USERS_ONLY',
  "allow_verified_email_linking" boolean NOT NULL DEFAULT false,
  "allowed_email_domains" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "revision" integer NOT NULL DEFAULT 1,
  "approved_revision" integer,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "proposed_by_user_id" uuid NOT NULL,
  "approved_by_user_id" uuid,
  "approved_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "enterprise_identity_providers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "enterprise_identity_providers_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "enterprise_identity_providers_tenant_key_key"
    UNIQUE ("tenant_id", "key"),
  CONSTRAINT "enterprise_identity_providers_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "enterprise_identity_providers_key_check" CHECK (
    length("key") BETWEEN 1 AND 100
    AND "key" = lower(btrim("key"))
    AND "key" ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  CONSTRAINT "enterprise_identity_providers_hash_check" CHECK (
    "configuration_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "verified_configuration_hash" IS NULL
      OR "verified_configuration_hash" ~ '^[0-9a-f]{64}$'
    )
    AND (
      "verification_evidence_hash" IS NULL
      OR "verification_evidence_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "enterprise_identity_providers_verification_check" CHECK (
    (
      "verification_status" = 'VERIFIED'
      AND "verified_configuration_hash" = "configuration_hash"
      AND "verification_evidence_hash" IS NOT NULL
      AND "verification_error_code" IS NULL
      AND "verified_at" IS NOT NULL
    )
    OR (
      "verification_status" = 'FAILED'
      AND "verification_error_code" IS NOT NULL
      AND "verified_at" IS NULL
    )
    OR (
      "verification_status" = 'NOT_VERIFIED'
      AND "verified_configuration_hash" IS NULL
      AND "verification_evidence_hash" IS NULL
      AND "verified_at" IS NULL
    )
  ),
  CONSTRAINT "enterprise_identity_providers_publication_check" CHECK (
    (
      "publication_status" = 'PUBLISHED'
      AND "verification_status" = 'VERIFIED'
      AND "approved_revision" = "revision"
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "proposed_by_user_id"
      AND "approved_at" IS NOT NULL
    )
    OR "publication_status" <> 'PUBLISHED'
  ),
  CONSTRAINT "enterprise_identity_providers_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "enterprise_identity_providers_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "enterprise_identity_providers_proposer_fkey"
    FOREIGN KEY ("tenant_id", "proposed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "enterprise_identity_providers_approver_fkey"
    FOREIGN KEY ("tenant_id", "approved_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "enterprise_identity_providers_protocol_status_idx"
  ON public."enterprise_identity_providers"(
    "tenant_id", "protocol", "publication_status", "verification_status"
  );

-- Secret material is isolated from provider metadata so the admin role can be
-- write-only and UI reads cannot accidentally serialize ciphertext. Rotation
-- changes the provider configuration_hash and resets verification in the same
-- transaction.
CREATE TABLE public."identity_provider_secrets" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "kind" varchar(80) NOT NULL,
  "secret_ciphertext" bytea,
  "secret_ref" varchar(1000),
  "secret_key_id" varchar(200),
  "secret_format_version" integer NOT NULL DEFAULT 1,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_provider_secrets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_provider_secrets_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "identity_provider_secrets_provider_kind_key"
    UNIQUE ("tenant_id", "provider_id", "kind"),
  CONSTRAINT "identity_provider_secrets_kind_check" CHECK (
    "kind" IN (
      'OIDC_CLIENT_SECRET',
      'SAML_SP_SIGNING_PRIVATE_KEY',
      'SAML_SP_DECRYPTION_PRIVATE_KEY'
    )
  ),
  CONSTRAINT "identity_provider_secrets_storage_check" CHECK (
    (("secret_ciphertext" IS NOT NULL)::integer
       + ("secret_ref" IS NOT NULL)::integer) = 1
    AND (
      "secret_ciphertext" IS NULL
      OR ("secret_key_id" IS NOT NULL AND octet_length("secret_ciphertext") >= 32)
    )
    AND ("secret_ref" IS NULL OR btrim("secret_ref") <> '')
    AND "secret_format_version" > 0
    AND "revision" > 0
  ),
  CONSTRAINT "identity_provider_secrets_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE CASCADE
);

CREATE TABLE public."oidc_provider_configs" (
  "provider_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "issuer" varchar(1000) NOT NULL,
  "discovery_url" varchar(1000) NOT NULL,
  "authorization_endpoint" varchar(1000) NOT NULL,
  "token_endpoint" varchar(1000) NOT NULL,
  "jwks_uri" varchar(1000) NOT NULL,
  "client_id" varchar(500) NOT NULL,
  "scopes" text[] NOT NULL DEFAULT ARRAY['openid', 'profile', 'email']::text[],
  "response_type" varchar(20) NOT NULL DEFAULT 'code',
  "pkce_code_challenge_method" varchar(20) NOT NULL DEFAULT 'S256',
  "discovery_document_hash" char(64) NOT NULL,
  "discovered_at" timestamptz(6) NOT NULL,
  "clock_skew_seconds" integer NOT NULL DEFAULT 60,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oidc_provider_configs_pkey" PRIMARY KEY ("provider_id"),
  CONSTRAINT "oidc_provider_configs_tenant_id_provider_id_key"
    UNIQUE ("tenant_id", "provider_id"),
  CONSTRAINT "oidc_provider_configs_protocol_check"
    CHECK ("response_type" = 'code' AND "pkce_code_challenge_method" = 'S256'),
  CONSTRAINT "oidc_provider_configs_scope_check"
    CHECK ('openid' = ANY("scopes")),
  CONSTRAINT "oidc_provider_configs_hash_check"
    CHECK ("discovery_document_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "oidc_provider_configs_clock_check"
    CHECK ("clock_skew_seconds" BETWEEN 0 AND 300),
  CONSTRAINT "oidc_provider_configs_secure_endpoints_check" CHECK (
    (
      "issuer" ~ '^https://'
      AND "discovery_url" ~ '^https://'
      AND "authorization_endpoint" ~ '^https://'
      AND "token_endpoint" ~ '^https://'
      AND "jwks_uri" ~ '^https://'
    )
    OR (
      "issuer" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      AND "discovery_url" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      AND "authorization_endpoint" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      AND "token_endpoint" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      AND "jwks_uri" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
    )
  ),
  CONSTRAINT "oidc_provider_configs_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE CASCADE
);

-- The verifier_status represents a concrete external XML-signature verifier
-- adapter. With no adapter configured the row remains NOT_VERIFIED and the
-- provider publication guard below fails closed.
CREATE TABLE public."saml_provider_configs" (
  "provider_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "sp_entity_id" varchar(1000) NOT NULL,
  "idp_entity_id" varchar(1000) NOT NULL,
  "sso_url" varchar(1000) NOT NULL,
  "acs_url" varchar(1000) NOT NULL,
  "metadata_source_url" varchar(1000),
  "metadata_document_hash" char(64) NOT NULL,
  "idp_signing_certificate_fingerprints" jsonb NOT NULL,
  "want_response_signed" boolean NOT NULL DEFAULT true,
  "want_assertions_signed" boolean NOT NULL DEFAULT true,
  "require_in_response_to" boolean NOT NULL DEFAULT true,
  "fail_closed" boolean NOT NULL DEFAULT true,
  "clock_skew_seconds" integer NOT NULL DEFAULT 60,
  "verifier_port_name" varchar(200),
  "verifier_port_version" varchar(100),
  "verifier_status" public."IdentityVerificationStatus"
    NOT NULL DEFAULT 'NOT_VERIFIED',
  "verified_metadata_hash" char(64),
  "verifier_evidence_hash" char(64),
  "verifier_verified_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saml_provider_configs_pkey" PRIMARY KEY ("provider_id"),
  CONSTRAINT "saml_provider_configs_tenant_id_provider_id_key"
    UNIQUE ("tenant_id", "provider_id"),
  CONSTRAINT "saml_provider_configs_hash_check" CHECK (
    "metadata_document_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "verified_metadata_hash" IS NULL
      OR "verified_metadata_hash" ~ '^[0-9a-f]{64}$'
    )
    AND (
      "verifier_evidence_hash" IS NULL
      OR "verifier_evidence_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "saml_provider_configs_certificates_check" CHECK (
    jsonb_typeof("idp_signing_certificate_fingerprints") = 'array'
    AND jsonb_array_length("idp_signing_certificate_fingerprints") > 0
  ),
  CONSTRAINT "saml_provider_configs_security_check" CHECK (
    "want_response_signed"
    AND "want_assertions_signed"
    AND "require_in_response_to"
    AND "fail_closed"
    AND "clock_skew_seconds" BETWEEN 0 AND 300
  ),
  CONSTRAINT "saml_provider_configs_verifier_check" CHECK (
    (
      "verifier_status" = 'VERIFIED'
      AND "verifier_port_name" IS NOT NULL
      AND "verifier_port_version" IS NOT NULL
      AND "verified_metadata_hash" = "metadata_document_hash"
      AND "verifier_evidence_hash" IS NOT NULL
      AND "verifier_verified_at" IS NOT NULL
    )
    OR (
      "verifier_status" <> 'VERIFIED'
      AND "verified_metadata_hash" IS NULL
      AND "verifier_evidence_hash" IS NULL
      AND "verifier_verified_at" IS NULL
    )
  ),
  CONSTRAINT "saml_provider_configs_secure_endpoints_check" CHECK (
    (
      "sso_url" ~ '^https://'
      AND "acs_url" ~ '^https://'
      AND ("metadata_source_url" IS NULL OR "metadata_source_url" ~ '^https://')
    )
    OR (
      "sso_url" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      AND "acs_url" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      AND (
        "metadata_source_url" IS NULL
        OR "metadata_source_url"
          ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/|$)'
      )
    )
  ),
  CONSTRAINT "saml_provider_configs_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE CASCADE
);

-- Authorization Code + PKCE transaction. Only an encrypted verifier or a
-- secret-store reference is recoverable for the code exchange.
CREATE TABLE public."oidc_auth_transactions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "state_hash" char(64) NOT NULL,
  "nonce_hash" char(64) NOT NULL,
  "pkce_verifier_ciphertext" bytea,
  "pkce_verifier_ref" varchar(1000),
  "pkce_key_id" varchar(200),
  "redirect_uri" varchar(1000) NOT NULL,
  "requested_user_id" uuid,
  "authorization_code_hash" char(64),
  "issued_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamptz(6) NOT NULL,
  "consumed_at" timestamptz(6),
  "failed_at" timestamptz(6),
  "failure_code" varchar(120),
  CONSTRAINT "oidc_auth_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oidc_auth_transactions_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "oidc_auth_transactions_tenant_id_id_provider_id_key"
    UNIQUE ("tenant_id", "id", "provider_id"),
  CONSTRAINT "oidc_auth_transactions_state_hash_key" UNIQUE ("state_hash"),
  CONSTRAINT "oidc_auth_transactions_nonce_hash_key" UNIQUE ("nonce_hash"),
  CONSTRAINT "oidc_auth_transactions_digest_check" CHECK (
    "state_hash" ~ '^[0-9a-f]{64}$'
    AND "nonce_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "authorization_code_hash" IS NULL
      OR "authorization_code_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "oidc_auth_transactions_pkce_storage_check" CHECK (
    (
      "consumed_at" IS NULL
      AND "failed_at" IS NULL
      AND (("pkce_verifier_ciphertext" IS NOT NULL)::integer
         + ("pkce_verifier_ref" IS NOT NULL)::integer) = 1
      AND (
        "pkce_verifier_ciphertext" IS NULL
        OR (
          "pkce_key_id" IS NOT NULL
          AND octet_length("pkce_verifier_ciphertext") >= 32
        )
      )
    )
    OR (
      ("consumed_at" IS NOT NULL OR "failed_at" IS NOT NULL)
      AND "pkce_verifier_ciphertext" IS NULL
      AND "pkce_verifier_ref" IS NULL
      AND "pkce_key_id" IS NULL
    )
  ),
  CONSTRAINT "oidc_auth_transactions_lifetime_check" CHECK (
    "expires_at" > "issued_at"
    AND "expires_at" <= "issued_at" + interval '15 minutes'
  ),
  CONSTRAINT "oidc_auth_transactions_terminal_check" CHECK (
    NOT ("consumed_at" IS NOT NULL AND "failed_at" IS NOT NULL)
    AND ("consumed_at" IS NULL OR "authorization_code_hash" IS NOT NULL)
    AND ("failed_at" IS NULL OR "failure_code" IS NOT NULL)
  ),
  CONSTRAINT "oidc_auth_transactions_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "oidc_auth_transactions_requested_user_fkey"
    FOREIGN KEY ("tenant_id", "requested_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "oidc_auth_transactions_expiry_idx"
  ON public."oidc_auth_transactions"("expires_at")
  WHERE "consumed_at" IS NULL AND "failed_at" IS NULL;

-- Verification receipt for the ID token returned by the code exchange. Raw
-- JWTs and claims are never stored. VERIFIED requires an exact state/nonce
-- transaction plus issuer, audience, time, signature, and JWKS-key validation.
CREATE TABLE public."oidc_token_validation_receipts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "auth_transaction_id" uuid NOT NULL,
  "id_token_hash" char(64) NOT NULL,
  "subject_hash" char(64) NOT NULL,
  "claims_hash" char(64) NOT NULL,
  "nonce_hash" char(64) NOT NULL,
  "jwks_key_thumbprint" char(64),
  "validation_status" public."IdentityVerificationStatus"
    NOT NULL DEFAULT 'NOT_VERIFIED',
  "signature_valid" boolean NOT NULL DEFAULT false,
  "jwks_key_valid" boolean NOT NULL DEFAULT false,
  "issuer_valid" boolean NOT NULL DEFAULT false,
  "audience_valid" boolean NOT NULL DEFAULT false,
  "nonce_valid" boolean NOT NULL DEFAULT false,
  "time_window_valid" boolean NOT NULL DEFAULT false,
  "verifier_evidence_hash" char(64),
  "failure_code" varchar(120),
  "received_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" timestamptz(6),
  CONSTRAINT "oidc_token_validation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oidc_token_validation_receipts_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "oidc_token_validation_receipts_tenant_id_id_provider_id_key"
    UNIQUE ("tenant_id", "id", "provider_id"),
  CONSTRAINT "oidc_token_validation_receipts_token_hash_key"
    UNIQUE ("id_token_hash"),
  CONSTRAINT "oidc_token_validation_receipts_transaction_key"
    UNIQUE ("tenant_id", "auth_transaction_id"),
  CONSTRAINT "oidc_token_validation_receipts_hash_check" CHECK (
    "id_token_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_hash" ~ '^[0-9a-f]{64}$'
    AND "claims_hash" ~ '^[0-9a-f]{64}$'
    AND "nonce_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "jwks_key_thumbprint" IS NULL
      OR "jwks_key_thumbprint" ~ '^[0-9a-f]{64}$'
    )
    AND (
      "verifier_evidence_hash" IS NULL
      OR "verifier_evidence_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "oidc_token_validation_receipts_fail_closed_check" CHECK (
    (
      "validation_status" = 'VERIFIED'
      AND "signature_valid"
      AND "jwks_key_valid"
      AND "issuer_valid"
      AND "audience_valid"
      AND "nonce_valid"
      AND "time_window_valid"
      AND "jwks_key_thumbprint" IS NOT NULL
      AND "verifier_evidence_hash" IS NOT NULL
      AND "failure_code" IS NULL
      AND "verified_at" IS NOT NULL
    )
    OR (
      "validation_status" = 'FAILED'
      AND "failure_code" IS NOT NULL
      AND "verified_at" IS NULL
    )
    OR (
      "validation_status" = 'NOT_VERIFIED'
      AND "verified_at" IS NULL
    )
  ),
  CONSTRAINT "oidc_token_validation_receipts_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "oidc_token_validation_receipts_transaction_fkey"
    FOREIGN KEY ("tenant_id", "auth_transaction_id", "provider_id")
    REFERENCES public."oidc_auth_transactions"(
      "tenant_id", "id", "provider_id"
    )
    ON DELETE RESTRICT
);

-- Subject lookup uses a server-peppered digest. The original subject and token
-- claims are not persisted; claims_hash allows audit correlation.
CREATE TABLE public."oidc_account_bindings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_from_receipt_id" uuid NOT NULL,
  "subject_hash" char(64) NOT NULL,
  "claims_hash" char(64) NOT NULL,
  "status" public."ExternalIdentityBindingStatus" NOT NULL DEFAULT 'ACTIVE',
  "linked_by_user_id" uuid,
  "linked_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_login_at" timestamptz(6),
  "revoked_at" timestamptz(6),
  "revision" integer NOT NULL DEFAULT 1,
  CONSTRAINT "oidc_account_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oidc_account_bindings_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "oidc_account_bindings_subject_key"
    UNIQUE ("tenant_id", "provider_id", "subject_hash"),
  CONSTRAINT "oidc_account_bindings_user_key"
    UNIQUE ("tenant_id", "provider_id", "user_id"),
  CONSTRAINT "oidc_account_bindings_receipt_key"
    UNIQUE ("tenant_id", "created_from_receipt_id"),
  CONSTRAINT "oidc_account_bindings_hash_check" CHECK (
    "subject_hash" ~ '^[0-9a-f]{64}$'
    AND "claims_hash" ~ '^[0-9a-f]{64}$'
    AND "revision" > 0
  ),
  CONSTRAINT "oidc_account_bindings_state_check" CHECK (
    ("status" = 'ACTIVE' AND "revoked_at" IS NULL)
    OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)
  ),
  CONSTRAINT "oidc_account_bindings_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "oidc_account_bindings_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "oidc_account_bindings_receipt_fkey"
    FOREIGN KEY ("tenant_id", "created_from_receipt_id", "provider_id")
    REFERENCES public."oidc_token_validation_receipts"(
      "tenant_id", "id", "provider_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "oidc_account_bindings_linker_fkey"
    FOREIGN KEY ("tenant_id", "linked_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE TABLE public."saml_authn_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "request_id_hash" char(64) NOT NULL,
  "relay_state_hash" char(64) NOT NULL,
  "requested_user_id" uuid,
  "issued_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamptz(6) NOT NULL,
  "consumed_at" timestamptz(6),
  CONSTRAINT "saml_authn_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "saml_authn_requests_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "saml_authn_requests_tenant_id_id_provider_id_key"
    UNIQUE ("tenant_id", "id", "provider_id"),
  CONSTRAINT "saml_authn_requests_request_hash_key" UNIQUE ("request_id_hash"),
  CONSTRAINT "saml_authn_requests_relay_hash_key" UNIQUE ("relay_state_hash"),
  CONSTRAINT "saml_authn_requests_hash_check" CHECK (
    "request_id_hash" ~ '^[0-9a-f]{64}$'
    AND "relay_state_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "saml_authn_requests_lifetime_check" CHECK (
    "expires_at" > "issued_at"
    AND "expires_at" <= "issued_at" + interval '15 minutes'
  ),
  CONSTRAINT "saml_authn_requests_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "saml_authn_requests_user_fkey"
    FOREIGN KEY ("tenant_id", "requested_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "saml_authn_requests_expiry_idx"
  ON public."saml_authn_requests"("expires_at")
  WHERE "consumed_at" IS NULL;

-- A receipt contains only digests and verifier conclusions, never the raw XML.
-- VERIFIED is structurally impossible unless every mandatory validation passed.
CREATE TABLE public."saml_assertion_receipts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "authn_request_id" uuid NOT NULL,
  "response_hash" char(64) NOT NULL,
  "assertion_id_hash" char(64) NOT NULL,
  "subject_hash" char(64) NOT NULL,
  "validation_status" public."IdentityVerificationStatus"
    NOT NULL DEFAULT 'NOT_VERIFIED',
  "signature_valid" boolean NOT NULL DEFAULT false,
  "issuer_valid" boolean NOT NULL DEFAULT false,
  "audience_valid" boolean NOT NULL DEFAULT false,
  "recipient_valid" boolean NOT NULL DEFAULT false,
  "in_response_to_valid" boolean NOT NULL DEFAULT false,
  "time_window_valid" boolean NOT NULL DEFAULT false,
  "subject_confirmation_valid" boolean NOT NULL DEFAULT false,
  "replay_check_passed" boolean NOT NULL DEFAULT false,
  "not_before" timestamptz(6),
  "not_on_or_after" timestamptz(6),
  "verifier_port_name" varchar(200),
  "verifier_port_version" varchar(100),
  "verifier_evidence_hash" char(64),
  "failure_code" varchar(120),
  "received_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" timestamptz(6),
  CONSTRAINT "saml_assertion_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "saml_assertion_receipts_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "saml_assertion_receipts_response_hash_key" UNIQUE ("response_hash"),
  CONSTRAINT "saml_assertion_receipts_assertion_replay_key"
    UNIQUE ("tenant_id", "provider_id", "assertion_id_hash"),
  CONSTRAINT "saml_assertion_receipts_request_key"
    UNIQUE ("tenant_id", "authn_request_id"),
  CONSTRAINT "saml_assertion_receipts_hash_check" CHECK (
    "response_hash" ~ '^[0-9a-f]{64}$'
    AND "assertion_id_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "verifier_evidence_hash" IS NULL
      OR "verifier_evidence_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "saml_assertion_receipts_time_check" CHECK (
    "not_before" IS NULL
    OR "not_on_or_after" IS NULL
    OR "not_on_or_after" > "not_before"
  ),
  CONSTRAINT "saml_assertion_receipts_fail_closed_check" CHECK (
    (
      "validation_status" = 'VERIFIED'
      AND "signature_valid"
      AND "issuer_valid"
      AND "audience_valid"
      AND "recipient_valid"
      AND "in_response_to_valid"
      AND "time_window_valid"
      AND "subject_confirmation_valid"
      AND "replay_check_passed"
      AND "verifier_port_name" IS NOT NULL
      AND "verifier_port_version" IS NOT NULL
      AND "verifier_evidence_hash" IS NOT NULL
      AND "verified_at" IS NOT NULL
      AND "failure_code" IS NULL
    )
    OR (
      "validation_status" = 'FAILED'
      AND "failure_code" IS NOT NULL
      AND "verified_at" IS NULL
    )
    OR (
      "validation_status" = 'NOT_VERIFIED'
      AND "verified_at" IS NULL
    )
  ),
  CONSTRAINT "saml_assertion_receipts_provider_fkey"
    FOREIGN KEY ("tenant_id", "provider_id")
    REFERENCES public."enterprise_identity_providers"("tenant_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "saml_assertion_receipts_request_fkey"
    FOREIGN KEY ("tenant_id", "authn_request_id", "provider_id")
    REFERENCES public."saml_authn_requests"(
      "tenant_id", "id", "provider_id"
    )
    ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- SCIM 2.0 provisioning
-- ---------------------------------------------------------------------------

CREATE TABLE public."scim_connectors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "key" varchar(100) NOT NULL,
  "display_name" varchar(200) NOT NULL,
  "status" public."ScimConnectorStatus" NOT NULL DEFAULT 'DRAFT',
  "base_path" varchar(300) NOT NULL,
  "allow_user_create" boolean NOT NULL DEFAULT true,
  "allow_group_create" boolean NOT NULL DEFAULT true,
  "deactivate_user_on_scim_disable" boolean NOT NULL DEFAULT true,
  "revision" integer NOT NULL DEFAULT 1,
  "approved_revision" integer,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "proposed_by_user_id" uuid NOT NULL,
  "approved_by_user_id" uuid,
  "approved_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_connectors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_connectors_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "scim_connectors_tenant_key_key" UNIQUE ("tenant_id", "key"),
  CONSTRAINT "scim_connectors_tenant_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "scim_connectors_key_check" CHECK (
    length("key") BETWEEN 1 AND 100
    AND "key" = lower(btrim("key"))
    AND "key" ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  CONSTRAINT "scim_connectors_base_path_check" CHECK (
    "base_path" ~ '^/api/v1/scim/[a-zA-Z0-9._/-]+$'
    AND position('..' IN "base_path") = 0
  ),
  CONSTRAINT "scim_connectors_revision_hash_check" CHECK (
    "revision" > 0
    AND "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "scim_connectors_approval_check" CHECK (
    (
      "status" = 'ACTIVE'
      AND "approved_revision" = "revision"
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "proposed_by_user_id"
      AND "approved_at" IS NOT NULL
    )
    OR "status" <> 'ACTIVE'
  ),
  CONSTRAINT "scim_connectors_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "scim_connectors_proposer_fkey"
    FOREIGN KEY ("tenant_id", "proposed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "scim_connectors_approver_fkey"
    FOREIGN KEY ("tenant_id", "approved_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

-- The bearer value is shown once by the API. Only a peppered token hash and a
-- non-sensitive display hint are stored.
CREATE TABLE public."scim_service_tokens" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "token_hash" char(64) NOT NULL,
  "token_hint" varchar(12) NOT NULL,
  "status" public."ScimTokenStatus" NOT NULL DEFAULT 'ACTIVE',
  "scopes" text[] NOT NULL DEFAULT ARRAY[
    'scim.users.read', 'scim.users.write',
    'scim.groups.read', 'scim.groups.write'
  ]::text[],
  "created_by_user_id" uuid NOT NULL,
  "expires_at" timestamptz(6),
  "last_used_at" timestamptz(6),
  "revoked_at" timestamptz(6),
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_service_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_service_tokens_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "scim_service_tokens_tenant_id_id_connector_id_key"
    UNIQUE ("tenant_id", "id", "connector_id"),
  CONSTRAINT "scim_service_tokens_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "scim_service_tokens_hash_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "scim_service_tokens_hint_check" CHECK (
    length(btrim("token_hint")) BETWEEN 4 AND 12
  ),
  CONSTRAINT "scim_service_tokens_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "scim_service_tokens_state_check" CHECK (
    ("status" = 'ACTIVE' AND "revoked_at" IS NULL)
    OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)
    OR ("status" = 'EXPIRED' AND "expires_at" IS NOT NULL)
  ),
  CONSTRAINT "scim_service_tokens_connector_fkey"
    FOREIGN KEY ("tenant_id", "connector_id")
    REFERENCES public."scim_connectors"("tenant_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "scim_service_tokens_creator_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "scim_service_tokens_connector_status_idx"
  ON public."scim_service_tokens"(
    "tenant_id", "connector_id", "status", "expires_at"
  );

CREATE TABLE public."scim_users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "scim_id" varchar(200) NOT NULL,
  "external_id" varchar(500),
  "user_id" uuid NOT NULL,
  "user_name_normalized" varchar(320) NOT NULL,
  "display_name" varchar(200) NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "resource_version" bigint NOT NULL DEFAULT 1,
  "etag" char(64) NOT NULL,
  "last_modified_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deprovisioned_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_users_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "scim_users_tenant_connector_id_key"
    UNIQUE ("tenant_id", "connector_id", "id"),
  CONSTRAINT "scim_users_scim_id_key"
    UNIQUE ("tenant_id", "connector_id", "scim_id"),
  CONSTRAINT "scim_users_external_id_key"
    UNIQUE ("tenant_id", "connector_id", "external_id"),
  CONSTRAINT "scim_users_local_user_key"
    UNIQUE ("tenant_id", "connector_id", "user_id"),
  CONSTRAINT "scim_users_username_key"
    UNIQUE ("tenant_id", "connector_id", "user_name_normalized"),
  CONSTRAINT "scim_users_version_etag_check" CHECK (
    "resource_version" > 0
    AND "etag" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("attributes") = 'object'
  ),
  CONSTRAINT "scim_users_deprovision_check" CHECK (
    ("active" AND "deprovisioned_at" IS NULL)
    OR (NOT "active" AND "deprovisioned_at" IS NOT NULL)
  ),
  CONSTRAINT "scim_users_connector_fkey"
    FOREIGN KEY ("tenant_id", "connector_id")
    REFERENCES public."scim_connectors"("tenant_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "scim_users_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "scim_users_filter_idx"
  ON public."scim_users"(
    "tenant_id", "connector_id", "user_name_normalized", "active"
  );
CREATE INDEX "scim_users_modified_idx"
  ON public."scim_users"(
    "tenant_id", "connector_id", "last_modified_at", "scim_id"
  );

CREATE TABLE public."scim_groups" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "scim_id" varchar(200) NOT NULL,
  "external_id" varchar(500),
  "display_name" varchar(200) NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "resource_version" bigint NOT NULL DEFAULT 1,
  "etag" char(64) NOT NULL,
  "last_modified_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_groups_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "scim_groups_tenant_connector_id_key"
    UNIQUE ("tenant_id", "connector_id", "id"),
  CONSTRAINT "scim_groups_scim_id_key"
    UNIQUE ("tenant_id", "connector_id", "scim_id"),
  CONSTRAINT "scim_groups_external_id_key"
    UNIQUE ("tenant_id", "connector_id", "external_id"),
  CONSTRAINT "scim_groups_display_name_key"
    UNIQUE ("tenant_id", "connector_id", "display_name"),
  CONSTRAINT "scim_groups_version_etag_check" CHECK (
    "resource_version" > 0
    AND "etag" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "scim_groups_deleted_check" CHECK (
    ("active" AND "deleted_at" IS NULL)
    OR (NOT "active" AND "deleted_at" IS NOT NULL)
  ),
  CONSTRAINT "scim_groups_connector_fkey"
    FOREIGN KEY ("tenant_id", "connector_id")
    REFERENCES public."scim_connectors"("tenant_id", "id")
    ON DELETE CASCADE
);

CREATE INDEX "scim_groups_filter_idx"
  ON public."scim_groups"(
    "tenant_id", "connector_id", "display_name", "active"
  );

CREATE TABLE public."scim_group_memberships" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "group_id" uuid NOT NULL,
  "scim_user_id" uuid NOT NULL,
  "resource_version" bigint NOT NULL DEFAULT 1,
  "etag" char(64) NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_group_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_group_memberships_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "scim_group_memberships_member_key"
    UNIQUE ("tenant_id", "connector_id", "group_id", "scim_user_id"),
  CONSTRAINT "scim_group_memberships_version_etag_check" CHECK (
    "resource_version" > 0
    AND "etag" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "scim_group_memberships_group_fkey"
    FOREIGN KEY ("tenant_id", "connector_id", "group_id")
    REFERENCES public."scim_groups"("tenant_id", "connector_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "scim_group_memberships_user_fkey"
    FOREIGN KEY ("tenant_id", "connector_id", "scim_user_id")
    REFERENCES public."scim_users"("tenant_id", "connector_id", "id")
    ON DELETE CASCADE
);

-- One row per HTTP mutation provides idempotency, ETag precondition evidence,
-- and a sanitized synchronization log. Raw Authorization headers, request
-- bodies, and SCIM filters are deliberately absent.
CREATE TABLE public."scim_provisioning_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "service_token_id" uuid NOT NULL,
  "request_id" varchar(200) NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "http_method" varchar(10) NOT NULL,
  "resource_type" varchar(40) NOT NULL,
  "resource_id" varchar(200),
  "filter_attribute" varchar(80),
  "filter_operator" varchar(10),
  "filter_value_hash" char(64),
  "if_match_etag" char(64),
  "result_etag" char(64),
  "status" public."ScimRequestStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "http_status" integer,
  "error_code" varchar(120),
  "started_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" timestamptz(6),
  CONSTRAINT "scim_provisioning_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_provisioning_requests_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "scim_provisioning_requests_request_id_key"
    UNIQUE ("tenant_id", "connector_id", "request_id"),
  CONSTRAINT "scim_provisioning_requests_idempotency_key"
    UNIQUE ("tenant_id", "connector_id", "idempotency_key"),
  CONSTRAINT "scim_provisioning_requests_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
    AND (
      "filter_value_hash" IS NULL
      OR "filter_value_hash" ~ '^[0-9a-f]{64}$'
    )
    AND ("if_match_etag" IS NULL OR "if_match_etag" ~ '^[0-9a-f]{64}$')
    AND ("result_etag" IS NULL OR "result_etag" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "scim_provisioning_requests_method_check"
    CHECK ("http_method" IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT "scim_provisioning_requests_resource_check"
    CHECK ("resource_type" IN ('User', 'Group')),
  CONSTRAINT "scim_provisioning_requests_filter_check" CHECK (
    (
      "filter_attribute" IS NULL
      AND "filter_operator" IS NULL
      AND "filter_value_hash" IS NULL
    )
    OR (
      "filter_attribute" IN ('userName', 'externalId', 'displayName', 'id')
      AND "filter_operator" IN ('eq')
      AND "filter_value_hash" IS NOT NULL
    )
  ),
  CONSTRAINT "scim_provisioning_requests_terminal_check" CHECK (
    (
      "status" = 'IN_PROGRESS'
      AND "http_status" IS NULL
      AND "completed_at" IS NULL
      AND "error_code" IS NULL
    )
    OR (
      "status" = 'SUCCEEDED'
      AND "http_status" BETWEEN 200 AND 299
      AND "completed_at" IS NOT NULL
      AND "error_code" IS NULL
    )
    OR (
      "status" = 'FAILED'
      AND "http_status" BETWEEN 400 AND 599
      AND "completed_at" IS NOT NULL
      AND "error_code" IS NOT NULL
    )
  ),
  CONSTRAINT "scim_provisioning_requests_connector_fkey"
    FOREIGN KEY ("tenant_id", "connector_id")
    REFERENCES public."scim_connectors"("tenant_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "scim_provisioning_requests_token_fkey"
    FOREIGN KEY ("tenant_id", "service_token_id", "connector_id")
    REFERENCES public."scim_service_tokens"("tenant_id", "id", "connector_id")
    ON DELETE RESTRICT
);

CREATE INDEX "scim_provisioning_requests_sync_log_idx"
  ON public."scim_provisioning_requests"(
    "tenant_id", "connector_id", "started_at" DESC, "id"
  );

-- Durable evidence for the local effects of a SCIM disable. This is separate
-- from the SCIM request log so retries can prove which revocations happened.
CREATE TABLE public."identity_deprovisioning_actions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "scim_user_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "sessions_revoked" integer NOT NULL,
  "devices_revoked" integer NOT NULL,
  "assignments_suspended" integer NOT NULL,
  "agent_runs_cancelled" integer NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "occurred_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_deprovisioning_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_deprovisioning_actions_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "identity_deprovisioning_actions_scim_user_key"
    UNIQUE ("tenant_id", "connector_id", "scim_user_id"),
  CONSTRAINT "identity_deprovisioning_actions_counts_check" CHECK (
    "sessions_revoked" >= 0
    AND "devices_revoked" >= 0
    AND "assignments_suspended" >= 0
    AND "agent_runs_cancelled" >= 0
  ),
  CONSTRAINT "identity_deprovisioning_actions_scim_user_fkey"
    FOREIGN KEY ("tenant_id", "connector_id", "scim_user_id")
    REFERENCES public."scim_users"("tenant_id", "connector_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "identity_deprovisioning_actions_user_fkey"
    FOREIGN KEY ("tenant_id", "user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_deprovisioning_actions_outbox_fkey"
    FOREIGN KEY ("tenant_id", "outbox_event_id")
    REFERENCES public."outbox_events"("tenant_id", "id") ON DELETE RESTRICT
);

-- Generic governance command ledger for idempotency, optimistic concurrency,
-- recent-MFA evidence, and maker-checker approval. The command and its resource
-- mutation/audit/outbox writes are committed in one transaction by the API.
CREATE TABLE public."identity_governance_commands" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "resource_type" varchar(80) NOT NULL,
  "resource_id" uuid NOT NULL,
  "action" varchar(80) NOT NULL,
  "expected_revision" integer NOT NULL,
  "result_revision" integer NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "maker_user_id" uuid NOT NULL,
  "checker_user_id" uuid,
  "requires_independent_approval" boolean NOT NULL DEFAULT false,
  "recent_mfa_session_id" uuid NOT NULL,
  "status" public."IdentityGovernanceCommandStatus" NOT NULL,
  "reason_code" varchar(120),
  "occurred_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_governance_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_governance_commands_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "identity_governance_commands_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "identity_governance_commands_revision_check" CHECK (
    "expected_revision" >= 0
    AND (
      (
        "status" = 'APPLIED'
        AND "result_revision" = "expected_revision" + 1
      )
      OR (
        "status" = 'REJECTED'
        AND "result_revision" = "expected_revision"
      )
    )
  ),
  CONSTRAINT "identity_governance_commands_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_governance_commands_approval_check" CHECK (
    (
      NOT "requires_independent_approval"
      AND "checker_user_id" IS NULL
    )
    OR (
      "requires_independent_approval"
      AND "checker_user_id" IS NOT NULL
      AND "checker_user_id" <> "maker_user_id"
    )
  ),
  CONSTRAINT "identity_governance_commands_status_check" CHECK (
    ("status" = 'APPLIED' AND "reason_code" IS NULL)
    OR ("status" = 'REJECTED' AND "reason_code" IS NOT NULL)
  ),
  CONSTRAINT "identity_governance_commands_maker_fkey"
    FOREIGN KEY ("tenant_id", "maker_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_governance_commands_checker_fkey"
    FOREIGN KEY ("tenant_id", "checker_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_governance_commands_session_fkey"
    FOREIGN KEY ("tenant_id", "recent_mfa_session_id", "maker_user_id")
    REFERENCES public."auth_sessions"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT
);

CREATE INDEX "identity_governance_commands_resource_idx"
  ON public."identity_governance_commands"(
    "tenant_id", "resource_type", "resource_id", "occurred_at" DESC
  );

-- Temporary privileged access is a two-person, short-lived grant. The grant
-- never changes a user's durable role. Callers must check the bounded grant at
-- the authorization point through has_active_break_glass_grant().
CREATE TABLE public."identity_break_glass_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "requester_user_id" uuid NOT NULL,
  "scopes" text[] NOT NULL,
  "reason" varchar(1000) NOT NULL,
  "requested_duration_seconds" integer NOT NULL,
  "status" public."BreakGlassRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "approved_by_user_id" uuid,
  "approval_comment" varchar(1000),
  "approved_at" timestamptz(6),
  "rejected_by_user_id" uuid,
  "rejection_reason" varchar(1000),
  "rejected_at" timestamptz(6),
  "activated_at" timestamptz(6),
  "active_until" timestamptz(6),
  "termination_kind" public."BreakGlassTerminationKind",
  "terminated_at" timestamptz(6),
  "revoked_by_user_id" uuid,
  "revocation_reason" varchar(1000),
  "reviewed_by_user_id" uuid,
  "review_outcome" varchar(80),
  "review_summary" varchar(2000),
  "reviewed_at" timestamptz(6),
  "closed_at" timestamptz(6),
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_break_glass_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_break_glass_requests_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "identity_break_glass_requests_duration_check"
    CHECK ("requested_duration_seconds" BETWEEN 60 AND 900),
  CONSTRAINT "identity_break_glass_requests_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 20 AND 1000),
  CONSTRAINT "identity_break_glass_requests_scope_check" CHECK (
    cardinality("scopes") BETWEEN 1 AND 8
    AND "scopes" <@ ARRAY[
      'IDENTITY_PROVIDER_RECOVERY',
      'AUTHENTICATION_POLICY_RECOVERY',
      'SESSION_REVOCATION',
      'SCIM_RECOVERY'
    ]::text[]
  ),
  CONSTRAINT "identity_break_glass_requests_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "identity_break_glass_requests_lifecycle_check" CHECK (
    (
      "status" = 'PENDING_APPROVAL'
      AND "approved_by_user_id" IS NULL AND "approved_at" IS NULL
      AND "rejected_by_user_id" IS NULL AND "rejected_at" IS NULL
      AND "activated_at" IS NULL AND "active_until" IS NULL
      AND "termination_kind" IS NULL AND "terminated_at" IS NULL
      AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL
    )
    OR (
      "status" = 'APPROVED'
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "requester_user_id"
      AND "approval_comment" IS NOT NULL AND "approved_at" IS NOT NULL
      AND "activated_at" IS NULL AND "active_until" IS NULL
      AND "termination_kind" IS NULL AND "terminated_at" IS NULL
      AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL
    )
    OR (
      "status" = 'ACTIVE'
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "requester_user_id"
      AND "approval_comment" IS NOT NULL AND "approved_at" IS NOT NULL
      AND "activated_at" IS NOT NULL
      AND "active_until" = "activated_at" + make_interval(secs => "requested_duration_seconds")
      AND "termination_kind" IS NULL AND "terminated_at" IS NULL
      AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL
    )
    OR (
      "status" = 'REVIEW_PENDING'
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "requester_user_id"
      AND "activated_at" IS NOT NULL AND "active_until" IS NOT NULL
      AND "termination_kind" IS NOT NULL AND "terminated_at" IS NOT NULL
      AND (
        ("termination_kind" = 'EXPIRED' AND "revoked_by_user_id" IS NULL)
        OR (
          "termination_kind" = 'REVOKED'
          AND "revoked_by_user_id" IS NOT NULL
          AND "revocation_reason" IS NOT NULL
        )
      )
      AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL
    )
    OR (
      "status" = 'CLOSED'
      AND "approved_by_user_id" IS NOT NULL
      AND "approved_by_user_id" <> "requester_user_id"
      AND "activated_at" IS NOT NULL AND "active_until" IS NOT NULL
      AND "termination_kind" IS NOT NULL AND "terminated_at" IS NOT NULL
      AND "reviewed_by_user_id" IS NOT NULL
      AND "reviewed_by_user_id" <> "requester_user_id"
      AND "review_outcome" IN ('NO_ISSUE', 'FOLLOW_UP_REQUIRED', 'CONTROL_GAP_FOUND')
      AND "review_summary" IS NOT NULL
      AND "reviewed_at" IS NOT NULL AND "closed_at" IS NOT NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "approved_by_user_id" IS NULL AND "approved_at" IS NULL
      AND "rejected_by_user_id" IS NOT NULL
      AND "rejected_by_user_id" <> "requester_user_id"
      AND "rejection_reason" IS NOT NULL AND "rejected_at" IS NOT NULL
      AND "activated_at" IS NULL AND "active_until" IS NULL
      AND "termination_kind" IS NULL AND "terminated_at" IS NULL
      AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL
    )
  ),
  CONSTRAINT "identity_break_glass_requests_tenant_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES public."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_requests_requester_fkey"
    FOREIGN KEY ("tenant_id", "requester_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_requests_approver_fkey"
    FOREIGN KEY ("tenant_id", "approved_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_requests_rejector_fkey"
    FOREIGN KEY ("tenant_id", "rejected_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_requests_revoker_fkey"
    FOREIGN KEY ("tenant_id", "revoked_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_requests_reviewer_fkey"
    FOREIGN KEY ("tenant_id", "reviewed_by_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "identity_break_glass_requests_requester_status_idx"
  ON public."identity_break_glass_requests"(
    "tenant_id", "requester_user_id", "status", "created_at" DESC
  );
CREATE INDEX "identity_break_glass_requests_active_expiry_idx"
  ON public."identity_break_glass_requests"("tenant_id", "active_until")
  WHERE "status" = 'ACTIVE';

-- Every transition has an immutable, idempotent event with the acting session
-- where applicable. SYSTEM is reserved for deterministic expiry.
CREATE TABLE public."identity_break_glass_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "action" varchar(80) NOT NULL,
  "from_status" public."BreakGlassRequestStatus",
  "to_status" public."BreakGlassRequestStatus" NOT NULL,
  "actor_type" varchar(20) NOT NULL,
  "actor_user_id" uuid,
  "actor_session_id" uuid,
  "expected_revision" integer NOT NULL,
  "result_revision" integer NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "reason" varchar(2000),
  "occurred_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_break_glass_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_break_glass_events_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "identity_break_glass_events_idempotency_key"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "identity_break_glass_events_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_break_glass_events_revision_check" CHECK (
    "expected_revision" >= 0
    AND "result_revision" = "expected_revision" + 1
  ),
  CONSTRAINT "identity_break_glass_events_actor_check" CHECK (
    (
      "actor_type" = 'USER'
      AND "actor_user_id" IS NOT NULL
      AND "actor_session_id" IS NOT NULL
    )
    OR (
      "actor_type" = 'SYSTEM'
      AND "actor_user_id" IS NULL
      AND "actor_session_id" IS NULL
      AND "action" = 'EXPIRE'
    )
  ),
  CONSTRAINT "identity_break_glass_events_request_fkey"
    FOREIGN KEY ("tenant_id", "request_id")
    REFERENCES public."identity_break_glass_requests"("tenant_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_events_actor_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id")
    REFERENCES public."users"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "identity_break_glass_events_actor_session_fkey"
    FOREIGN KEY ("tenant_id", "actor_session_id", "actor_user_id")
    REFERENCES public."auth_sessions"("tenant_id", "id", "user_id")
    ON DELETE RESTRICT
);

CREATE INDEX "identity_break_glass_events_request_idx"
  ON public."identity_break_glass_events"(
    "tenant_id", "request_id", "occurred_at", "id"
  );

-- ---------------------------------------------------------------------------
-- State machines, CAS, replay controls, and deprovisioning side effects
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.identity_policy_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."publication_status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Identity policy must start as DRAFT revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'enterprise_identity_policies_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."tenant_id" <> OLD."tenant_id" THEN
    RAISE EXCEPTION 'Identity policy identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'enterprise_identity_policies_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Identity policy update requires exact revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'enterprise_identity_policies_revision_cas';
  END IF;
  IF NOT (
    NEW."publication_status" = OLD."publication_status"
    OR (OLD."publication_status" = 'DRAFT'
        AND NEW."publication_status" = 'IN_REVIEW')
    OR (OLD."publication_status" = 'IN_REVIEW'
        AND NEW."publication_status" IN ('DRAFT', 'PUBLISHED'))
    OR (OLD."publication_status" = 'PUBLISHED'
        AND NEW."publication_status" IN ('DRAFT', 'RETIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid identity policy publication transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'enterprise_identity_policies_transition';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.mfa_factor_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'MFA factor must start PENDING at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'user_mfa_factors_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenant_id", NEW."user_id", NEW."method")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."user_id", OLD."method") THEN
    RAISE EXCEPTION 'MFA factor identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'user_mfa_factors_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'MFA factor update requires exact revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'user_mfa_factors_revision_cas';
  END IF;
  IF NOT (
    NEW."status" = OLD."status"
    OR (OLD."status" = 'PENDING' AND NEW."status" IN ('ACTIVE', 'DISABLED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'DISABLED')
  ) THEN
    RAISE EXCEPTION 'Invalid MFA factor transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'user_mfa_factors_transition';
  END IF;
  IF OLD."last_accepted_time_step" IS NOT NULL
     AND (
       NEW."last_accepted_time_step" IS NULL
       OR NEW."last_accepted_time_step" < OLD."last_accepted_time_step"
     ) THEN
    RAISE EXCEPTION 'MFA time step cannot move backwards'
      USING ERRCODE = '23514',
            CONSTRAINT = 'user_mfa_factors_time_step_monotonic';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.mfa_recovery_code_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MFA recovery-code history cannot be deleted'
      USING ERRCODE = '55000',
            CONSTRAINT = 'mfa_recovery_codes_append_only';
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."user_id", NEW."factor_id",
      NEW."code_hash", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."user_id", OLD."factor_id",
      OLD."code_hash", OLD."created_at") THEN
    RAISE EXCEPTION 'MFA recovery-code identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mfa_recovery_codes_identity_immutable';
  END IF;
  IF OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at" THEN
    RAISE EXCEPTION 'Consumed recovery code cannot be reused'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mfa_recovery_codes_single_use';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'Revoked recovery code cannot be restored'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mfa_recovery_codes_revocation_terminal';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.revoke_disabled_mfa_factor_dependents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD."status" <> 'DISABLED' AND NEW."status" = 'DISABLED' THEN
    UPDATE public."mfa_recovery_codes"
    SET "revoked_at" = COALESCE("revoked_at", NEW."disabled_at")
    WHERE "tenant_id" = NEW."tenant_id"
      AND "factor_id" = NEW."id"
      AND "consumed_at" IS NULL
      AND "revoked_at" IS NULL;

    -- A disabled factor cannot continue satisfying recent-MFA step-up.
    UPDATE public."auth_sessions"
    SET
      "last_mfa_at" = NULL,
      "last_mfa_method" = NULL,
      "last_mfa_factor_id" = NULL,
      "version" = "version" + 1
    WHERE "tenant_id" = NEW."tenant_id"
      AND "user_id" = NEW."user_id"
      AND "last_mfa_factor_id" = NEW."id"
      AND "revoked_at" IS NULL;
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_device_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Identity device must start ACTIVE at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'identity_devices_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."user_id", NEW."fingerprint_hash",
      NEW."fingerprint_version", NEW."first_seen_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."user_id", OLD."fingerprint_hash",
      OLD."fingerprint_version", OLD."first_seen_at") THEN
    RAISE EXCEPTION 'Device fingerprint identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_devices_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Identity device update requires exact revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'identity_devices_revision_cas';
  END IF;
  IF OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED' THEN
    RAISE EXCEPTION 'Revoked device cannot be reactivated'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_devices_revocation_terminal';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.revoke_identity_device_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD."status" <> 'REVOKED' AND NEW."status" = 'REVOKED' THEN
    UPDATE public."auth_sessions"
    SET
      "revoked_at" = COALESCE("revoked_at", NEW."revoked_at"),
      "revoked_reason" = COALESCE(
        "revoked_reason",
        left(
          'DEVICE_REVOKED:' || COALESCE(NEW."revoke_reason", 'UNSPECIFIED'),
          500
        )
      ),
      "version" = "version" + 1
    WHERE "tenant_id" = NEW."tenant_id"
      AND "user_id" = NEW."user_id"
      AND "device_id" = NEW."id"
      AND "revoked_at" IS NULL;
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.auth_session_refresh_rotation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."auth_refresh_token_history" AS history
    WHERE history."token_hash" = NEW."refresh_token_hash"
  ) THEN
    RAISE EXCEPTION 'Refresh token hash was already retired'
      USING ERRCODE = '23505',
            CONSTRAINT = 'auth_refresh_token_history_token_hash_key';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenant_id", NEW."user_id", NEW."refresh_family_id")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."user_id", OLD."refresh_family_id") THEN
    RAISE EXCEPTION 'Session refresh family identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_sessions_refresh_family_immutable';
  END IF;

  IF NEW."refresh_token_hash" IS DISTINCT FROM OLD."refresh_token_hash" THEN
    INSERT INTO public."auth_refresh_token_history" (
      "tenant_id",
      "session_id",
      "user_id",
      "refresh_family_id",
      "generation",
      "token_hash",
      "successor_token_hash",
      "rotated_at",
      "expires_at"
    )
    VALUES (
      OLD."tenant_id",
      OLD."id",
      OLD."user_id",
      OLD."refresh_family_id",
      OLD."refresh_generation",
      OLD."refresh_token_hash",
      NEW."refresh_token_hash",
      CURRENT_TIMESTAMP,
      OLD."refresh_expires_at"
    );
    NEW."refresh_generation" := OLD."refresh_generation" + 1;
    IF NEW."version" = OLD."version" THEN
      NEW."version" := OLD."version" + 1;
    ELSIF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Refresh rotation requires exact session revision CAS'
        USING ERRCODE = '40001',
              CONSTRAINT = 'auth_sessions_refresh_revision_cas';
    END IF;
  ELSIF NEW."refresh_generation" <> OLD."refresh_generation" THEN
    RAISE EXCEPTION 'Refresh generation changes only during token rotation'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_sessions_refresh_generation_guard';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.mfa_challenge_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  factor_row public."user_mfa_factors"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'MFA challenge must start PENDING'
        USING ERRCODE = '23514',
              CONSTRAINT = 'auth_mfa_challenges_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenant_id", NEW."user_id", NEW."session_id",
      NEW."challenge_hash", NEW."purpose", NEW."issued_at", NEW."expires_at",
      NEW."idempotency_key")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."user_id", OLD."session_id",
      OLD."challenge_hash", OLD."purpose", OLD."issued_at", OLD."expires_at",
      OLD."idempotency_key") THEN
    RAISE EXCEPTION 'MFA challenge identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_mfa_challenges_identity_immutable';
  END IF;

  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN (
      'PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED'
    ))
    OR (OLD."status" = 'VERIFIED' AND NEW."status" = 'CONSUMED')
  ) THEN
    RAISE EXCEPTION 'MFA challenge is terminal or transition is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_mfa_challenges_transition';
  END IF;
  IF NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION 'MFA attempt count cannot decrease'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_mfa_challenges_attempt_monotonic';
  END IF;
  IF OLD."status" = 'VERIFIED'
     AND ROW(
       NEW."factor_id", NEW."recovery_code_id", NEW."verification_method",
       NEW."accepted_time_step", NEW."verified_at"
     ) IS DISTINCT FROM ROW(
       OLD."factor_id", OLD."recovery_code_id", OLD."verification_method",
       OLD."accepted_time_step", OLD."verified_at"
     ) THEN
    RAISE EXCEPTION 'Verified MFA evidence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_mfa_challenges_verified_evidence_immutable';
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" = 'VERIFIED' THEN
    IF NEW."verified_at" > NEW."expires_at" THEN
      RAISE EXCEPTION 'Expired MFA challenge cannot verify'
        USING ERRCODE = '23514',
              CONSTRAINT = 'auth_mfa_challenges_expired';
    END IF;

    SELECT factor.*
    INTO factor_row
    FROM public."user_mfa_factors" AS factor
    WHERE factor."tenant_id" = NEW."tenant_id"
      AND factor."id" = NEW."factor_id"
      AND factor."user_id" = NEW."user_id"
      AND factor."status" IN ('PENDING', 'ACTIVE')
      AND (
        factor."blocked_until" IS NULL
        OR factor."blocked_until" <= NEW."verified_at"
      )
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'MFA factor is unavailable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'auth_mfa_challenges_factor_available';
    END IF;

    IF NEW."verification_method" = 'TOTP' THEN
      IF factor_row."last_accepted_time_step" IS NOT NULL
         AND NEW."accepted_time_step" <= factor_row."last_accepted_time_step" THEN
        RAISE EXCEPTION 'TOTP time step was already accepted'
          USING ERRCODE = '23514',
                CONSTRAINT = 'auth_mfa_challenges_totp_replay';
      END IF;
      UPDATE public."user_mfa_factors"
      SET
        "last_accepted_time_step" = NEW."accepted_time_step",
        "failed_attempt_count" = 0,
        "attempt_window_started_at" = NULL,
        "blocked_until" = NULL,
        "revision" = "revision" + 1,
        "updated_at" = NEW."verified_at"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "id" = NEW."factor_id";
    ELSIF NEW."verification_method" = 'RECOVERY_CODE' THEN
      UPDATE public."mfa_recovery_codes"
      SET "consumed_at" = NEW."verified_at"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "id" = NEW."recovery_code_id"
        AND "user_id" = NEW."user_id"
        AND "factor_id" = NEW."factor_id"
        AND "consumed_at" IS NULL
        AND "revoked_at" IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Recovery code was already consumed or revoked'
          USING ERRCODE = '23514',
                CONSTRAINT = 'auth_mfa_challenges_recovery_replay';
      END IF;
    END IF;

    IF NEW."session_id" IS NOT NULL THEN
      UPDATE public."auth_sessions"
      SET
        "last_mfa_at" = NEW."verified_at",
        "last_mfa_method" = NEW."verification_method",
        "last_mfa_factor_id" = NEW."factor_id",
        "version" = "version" + 1
      WHERE "tenant_id" = NEW."tenant_id"
        AND "id" = NEW."session_id"
        AND "user_id" = NEW."user_id"
        AND "revoked_at" IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Step-up session is unavailable'
          USING ERRCODE = '23514',
                CONSTRAINT = 'auth_mfa_challenges_session_available';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_provider_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  config_ready boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1
       OR NEW."publication_status" <> 'DRAFT'
       OR NEW."verification_status" <> 'NOT_VERIFIED' THEN
      RAISE EXCEPTION 'Identity provider must start DRAFT and NOT_VERIFIED'
        USING ERRCODE = '23514',
              CONSTRAINT = 'enterprise_identity_providers_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenant_id", NEW."key", NEW."protocol")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."key", OLD."protocol") THEN
    RAISE EXCEPTION 'Identity provider identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'enterprise_identity_providers_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Identity provider update requires exact revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'enterprise_identity_providers_revision_cas';
  END IF;
  IF NEW."configuration_hash" IS DISTINCT FROM OLD."configuration_hash"
     AND (
       NEW."verification_status" <> 'NOT_VERIFIED'
       OR NEW."publication_status" NOT IN ('DRAFT', 'RETIRED')
     ) THEN
    RAISE EXCEPTION 'Changed IdP configuration must return to NOT_VERIFIED DRAFT'
      USING ERRCODE = '23514',
            CONSTRAINT = 'enterprise_identity_providers_reverify_on_change';
  END IF;
  IF ROW(
    NEW."verification_status",
    NEW."verified_configuration_hash",
    NEW."verification_evidence_hash",
    NEW."verification_error_code",
    NEW."verified_at"
  ) IS DISTINCT FROM ROW(
    OLD."verification_status",
    OLD."verified_configuration_hash",
    OLD."verification_evidence_hash",
    OLD."verification_error_code",
    OLD."verified_at"
  )
     AND NEW."verification_status" <> 'NOT_VERIFIED'
     AND current_user <> 'enterprise_agent_auth' THEN
    RAISE EXCEPTION 'Only the authentication verifier may attest an IdP configuration'
      USING ERRCODE = '42501',
            CONSTRAINT = 'enterprise_identity_providers_verifier_role';
  END IF;

  IF NEW."verification_status" = 'VERIFIED'
     OR NEW."publication_status" = 'PUBLISHED' THEN
    IF NEW."protocol" = 'OIDC' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public."oidc_provider_configs" AS config
        WHERE config."tenant_id" = NEW."tenant_id"
          AND config."provider_id" = NEW."id"
          AND config."discovered_at" IS NOT NULL
      ) INTO config_ready;
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public."saml_provider_configs" AS config
        WHERE config."tenant_id" = NEW."tenant_id"
          AND config."provider_id" = NEW."id"
          AND config."verifier_status" = 'VERIFIED'
          AND config."verified_metadata_hash" = config."metadata_document_hash"
          AND config."want_response_signed"
          AND config."want_assertions_signed"
          AND config."require_in_response_to"
          AND config."fail_closed"
      ) INTO config_ready;
    END IF;
    IF NOT config_ready THEN
      RAISE EXCEPTION 'Identity provider has no verified protocol configuration'
        USING ERRCODE = '23514',
              CONSTRAINT = 'enterprise_identity_providers_protocol_verified';
    END IF;
  END IF;

  IF NOT (
    NEW."publication_status" = OLD."publication_status"
    OR (OLD."publication_status" = 'DRAFT'
        AND NEW."publication_status" = 'IN_REVIEW')
    OR (OLD."publication_status" = 'IN_REVIEW'
        AND NEW."publication_status" IN ('DRAFT', 'PUBLISHED'))
    OR (OLD."publication_status" = 'PUBLISHED'
        AND NEW."publication_status" IN ('DRAFT', 'RETIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid identity provider publication transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'enterprise_identity_providers_transition';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_provider_protocol_config_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  provider_protocol public."IdentityProviderProtocol";
  provider_verification public."IdentityVerificationStatus";
  provider_publication public."IdentityPublicationStatus";
BEGIN
  SELECT
    provider."protocol",
    provider."verification_status",
    provider."publication_status"
  INTO
    provider_protocol,
    provider_verification,
    provider_publication
  FROM public."enterprise_identity_providers" AS provider
  WHERE provider."tenant_id" = NEW."tenant_id"
    AND provider."id" = NEW."provider_id"
  FOR UPDATE;

  IF NOT FOUND OR provider_protocol::text <> TG_ARGV[0] THEN
    RAISE EXCEPTION 'Identity provider protocol configuration mismatch'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_provider_protocol_config_match';
  END IF;
  IF TG_ARGV[0] = 'SAML' THEN
    IF TG_OP = 'INSERT'
       AND NEW."verifier_status" = 'VERIFIED'
       AND current_user <> 'enterprise_agent_auth' THEN
      RAISE EXCEPTION 'Only the configured SAML verifier port may attest metadata'
        USING ERRCODE = '42501',
              CONSTRAINT = 'saml_provider_configs_verifier_role';
    ELSIF TG_OP = 'UPDATE'
       AND NEW."verifier_status" = 'VERIFIED'
       AND (
         NEW."verifier_status" IS DISTINCT FROM OLD."verifier_status"
         OR NEW."verifier_evidence_hash" IS DISTINCT FROM OLD."verifier_evidence_hash"
       )
       AND current_user <> 'enterprise_agent_auth' THEN
      RAISE EXCEPTION 'Only the configured SAML verifier port may attest metadata'
        USING ERRCODE = '42501',
              CONSTRAINT = 'saml_provider_configs_verifier_role';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (
       provider_verification <> 'NOT_VERIFIED'
       OR provider_publication NOT IN ('DRAFT', 'RETIRED')
     ) THEN
    RAISE EXCEPTION 'Published or verified provider configuration is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_provider_protocol_config_reverification';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."tenant_id", NEW."provider_id")
         IS DISTINCT FROM (OLD."tenant_id", OLD."provider_id") THEN
    RAISE EXCEPTION 'Provider protocol configuration identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_provider_protocol_config_identity';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_provider_secret_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  provider_verification public."IdentityVerificationStatus";
  provider_publication public."IdentityPublicationStatus";
  target_tenant_id uuid;
  target_provider_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant_id := OLD."tenant_id";
    target_provider_id := OLD."provider_id";
  ELSE
    target_tenant_id := NEW."tenant_id";
    target_provider_id := NEW."provider_id";
  END IF;
  SELECT provider."verification_status", provider."publication_status"
  INTO provider_verification, provider_publication
  FROM public."enterprise_identity_providers" AS provider
  WHERE provider."tenant_id" = target_tenant_id
    AND provider."id" = target_provider_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Identity provider does not exist'
      USING ERRCODE = '23503',
            CONSTRAINT = 'identity_provider_secrets_provider_fkey';
  END IF;
  IF provider_verification <> 'NOT_VERIFIED'
     OR provider_publication NOT IN ('DRAFT', 'RETIRED') THEN
    RAISE EXCEPTION 'Rotate provider secrets only after unpublishing and resetting verification'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_provider_secrets_rotation_gate';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 THEN
      RAISE EXCEPTION 'Provider secret must start at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'identity_provider_secrets_initial_revision';
    END IF;
  ELSE
    IF (NEW."id", NEW."tenant_id", NEW."provider_id", NEW."kind")
       IS DISTINCT FROM
       (OLD."id", OLD."tenant_id", OLD."provider_id", OLD."kind") THEN
      RAISE EXCEPTION 'Provider secret identity is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'identity_provider_secrets_identity_immutable';
    END IF;
    IF NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'Provider secret rotation requires exact revision CAS'
        USING ERRCODE = '40001',
              CONSTRAINT = 'identity_provider_secrets_revision_cas';
    END IF;
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.oidc_transaction_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
    FROM public."enterprise_identity_providers" AS provider
    WHERE provider."tenant_id" = NEW."tenant_id"
      AND provider."id" = NEW."provider_id"
      AND provider."protocol" = 'OIDC'
      AND provider."verification_status" = 'VERIFIED'
      AND provider."publication_status" = 'PUBLISHED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OIDC provider is not verified and published'
        USING ERRCODE = '42501',
              CONSTRAINT = 'oidc_auth_transactions_provider_published';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OIDC transaction history cannot be deleted'
      USING ERRCODE = '55000',
            CONSTRAINT = 'oidc_auth_transactions_append_only';
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."provider_id", NEW."state_hash",
      NEW."nonce_hash", NEW."redirect_uri", NEW."requested_user_id",
      NEW."issued_at", NEW."expires_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."provider_id", OLD."state_hash",
      OLD."nonce_hash", OLD."redirect_uri", OLD."requested_user_id",
      OLD."issued_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'OIDC transaction identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_auth_transactions_identity_immutable';
  END IF;
  IF OLD."consumed_at" IS NOT NULL OR OLD."failed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'OIDC transaction is already terminal'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_auth_transactions_single_use';
  END IF;
  IF NEW."consumed_at" IS NULL AND NEW."failed_at" IS NULL THEN
    RAISE EXCEPTION 'OIDC transaction update must be terminal'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_auth_transactions_terminal_update';
  END IF;
  NEW."pkce_verifier_ciphertext" := NULL;
  NEW."pkce_verifier_ref" := NULL;
  NEW."pkce_key_id" := NULL;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.oidc_token_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  transaction_row public."oidc_auth_transactions"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."validation_status" <> 'NOT_VERIFIED' THEN
      RAISE EXCEPTION 'OIDC token receipt must start NOT_VERIFIED'
        USING ERRCODE = '23514',
              CONSTRAINT = 'oidc_token_validation_receipts_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OIDC token validation receipts are append-only'
      USING ERRCODE = '55000',
            CONSTRAINT = 'oidc_token_validation_receipts_append_only';
  END IF;
  IF ROW(
    NEW."id", NEW."tenant_id", NEW."provider_id", NEW."auth_transaction_id",
    NEW."id_token_hash", NEW."subject_hash", NEW."claims_hash",
    NEW."nonce_hash", NEW."received_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenant_id", OLD."provider_id", OLD."auth_transaction_id",
    OLD."id_token_hash", OLD."subject_hash", OLD."claims_hash",
    OLD."nonce_hash", OLD."received_at"
  ) THEN
    RAISE EXCEPTION 'OIDC token validation receipt identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_token_validation_receipts_identity_immutable';
  END IF;
  IF OLD."validation_status" <> 'NOT_VERIFIED'
     OR NEW."validation_status" = 'NOT_VERIFIED' THEN
    RAISE EXCEPTION 'OIDC token receipt has one fail-closed terminal decision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_token_validation_receipts_terminal';
  END IF;

  SELECT transaction.*
  INTO transaction_row
  FROM public."oidc_auth_transactions" AS transaction
  WHERE transaction."tenant_id" = NEW."tenant_id"
    AND transaction."id" = NEW."auth_transaction_id"
    AND transaction."provider_id" = NEW."provider_id"
  FOR SHARE;

  IF NOT FOUND
     OR transaction_row."nonce_hash" <> NEW."nonce_hash"
     OR transaction_row."failed_at" IS NOT NULL
     OR transaction_row."consumed_at" IS NULL
     OR transaction_row."consumed_at" > transaction_row."expires_at" THEN
    RAISE EXCEPTION 'OIDC state/nonce transaction is invalid or replayed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_token_validation_receipts_transaction_valid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.saml_authn_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
    FROM public."enterprise_identity_providers" AS provider
    JOIN public."saml_provider_configs" AS config
      ON config."tenant_id" = provider."tenant_id"
     AND config."provider_id" = provider."id"
    WHERE provider."tenant_id" = NEW."tenant_id"
      AND provider."id" = NEW."provider_id"
      AND provider."protocol" = 'SAML'
      AND provider."verification_status" = 'VERIFIED'
      AND provider."publication_status" = 'PUBLISHED'
      AND config."verifier_status" = 'VERIFIED'
      AND config."fail_closed";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SAML provider/verifier is not verified and published'
        USING ERRCODE = '42501',
              CONSTRAINT = 'saml_authn_requests_provider_published';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SAML AuthnRequest history cannot be deleted'
      USING ERRCODE = '55000',
            CONSTRAINT = 'saml_authn_requests_append_only';
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."provider_id", NEW."request_id_hash",
      NEW."relay_state_hash", NEW."requested_user_id", NEW."issued_at",
      NEW."expires_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."provider_id", OLD."request_id_hash",
      OLD."relay_state_hash", OLD."requested_user_id", OLD."issued_at",
      OLD."expires_at") THEN
    RAISE EXCEPTION 'SAML AuthnRequest identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saml_authn_requests_identity_immutable';
  END IF;
  IF OLD."consumed_at" IS NOT NULL OR NEW."consumed_at" IS NULL THEN
    RAISE EXCEPTION 'SAML AuthnRequest can be consumed only once'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saml_authn_requests_single_use';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.saml_assertion_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."validation_status" <> 'NOT_VERIFIED' THEN
      RAISE EXCEPTION 'SAML assertion receipt must start NOT_VERIFIED'
        USING ERRCODE = '23514',
              CONSTRAINT = 'saml_assertion_receipts_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SAML assertion receipts are append-only'
      USING ERRCODE = '55000',
            CONSTRAINT = 'saml_assertion_receipts_append_only';
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."provider_id", NEW."authn_request_id",
      NEW."response_hash", NEW."assertion_id_hash", NEW."subject_hash",
      NEW."received_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."provider_id", OLD."authn_request_id",
      OLD."response_hash", OLD."assertion_id_hash", OLD."subject_hash",
      OLD."received_at") THEN
    RAISE EXCEPTION 'SAML assertion receipt identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saml_assertion_receipts_identity_immutable';
  END IF;
  IF OLD."validation_status" <> 'NOT_VERIFIED'
     OR NEW."validation_status" = 'NOT_VERIFIED' THEN
    RAISE EXCEPTION 'SAML assertion receipt has one fail-closed terminal decision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saml_assertion_receipts_terminal';
  END IF;
  IF NEW."validation_status" = 'VERIFIED' THEN
    UPDATE public."saml_authn_requests"
    SET "consumed_at" = NEW."verified_at"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."authn_request_id"
      AND "provider_id" = NEW."provider_id"
      AND "consumed_at" IS NULL
      AND "expires_at" >= NEW."verified_at";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SAML InResponseTo is expired, unknown, or replayed'
        USING ERRCODE = '23514',
              CONSTRAINT = 'saml_assertion_receipts_in_response_to_replay';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.scim_connector_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'SCIM connector must start DRAFT at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_connectors_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."key", NEW."base_path")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."key", OLD."base_path") THEN
    RAISE EXCEPTION 'SCIM connector identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_connectors_identity_immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'SCIM connector update requires exact revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'scim_connectors_revision_cas';
  END IF;
  IF NOT (
    NEW."status" = OLD."status"
    OR (OLD."status" = 'DRAFT' AND NEW."status" = 'IN_REVIEW')
    OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('DRAFT', 'ACTIVE'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('DRAFT', 'SUSPENDED', 'RETIRED'))
    OR (OLD."status" = 'SUSPENDED' AND NEW."status" IN ('DRAFT', 'ACTIVE', 'RETIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid SCIM connector transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_connectors_transition';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.scim_token_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'SCIM token must start ACTIVE at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_service_tokens_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."tenant_id", NEW."connector_id", NEW."token_hash",
      NEW."token_hint", NEW."created_by_user_id", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."connector_id", OLD."token_hash",
      OLD."token_hint", OLD."created_by_user_id", OLD."created_at") THEN
    RAISE EXCEPTION 'SCIM token identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_service_tokens_identity_immutable';
  END IF;
  IF NEW."last_used_at" IS DISTINCT FROM OLD."last_used_at"
     AND ROW(
       NEW."status", NEW."scopes", NEW."expires_at", NEW."revoked_at"
     ) IS NOT DISTINCT FROM ROW(
       OLD."status", OLD."scopes", OLD."expires_at", OLD."revoked_at"
     ) THEN
    -- High-frequency last-used telemetry does not consume a governance revision.
    IF NEW."revision" <> OLD."revision" THEN
      RAISE EXCEPTION 'SCIM token telemetry must preserve revision'
        USING ERRCODE = '40001',
              CONSTRAINT = 'scim_service_tokens_telemetry_revision';
    END IF;
    IF OLD."last_used_at" IS NOT NULL
       AND NEW."last_used_at" < OLD."last_used_at" THEN
      RAISE EXCEPTION 'SCIM token last-used time cannot move backwards'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_service_tokens_last_used_monotonic';
    END IF;
  ELSIF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'SCIM token mutation requires exact revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'scim_service_tokens_revision_cas';
  END IF;
  IF OLD."status" <> 'ACTIVE' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'SCIM token terminal state cannot be reversed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_service_tokens_terminal';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.scim_resource_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."resource_version" <> 1 THEN
      RAISE EXCEPTION 'SCIM resource must start at version 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_resource_initial_version';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."connector_id" <> OLD."connector_id" THEN
    RAISE EXCEPTION 'SCIM resource identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_resource_identity_immutable';
  END IF;
  IF NEW."resource_version" <> OLD."resource_version" + 1
     OR NEW."etag" = OLD."etag" THEN
    RAISE EXCEPTION 'SCIM update requires If-Match CAS and a new ETag'
      USING ERRCODE = '40001',
            CONSTRAINT = 'scim_resource_version_cas';
  END IF;
  IF TG_TABLE_NAME = 'scim_users' THEN
    IF NEW."user_id" <> OLD."user_id" OR NEW."scim_id" <> OLD."scim_id" THEN
      RAISE EXCEPTION 'SCIM user binding identity is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_users_binding_immutable';
    END IF;
    IF NOT OLD."active" AND NEW."active" THEN
      RAISE EXCEPTION 'SCIM-deprovisioned user requires an explicit admin reactivation workflow'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_users_deprovision_terminal';
    END IF;
    IF OLD."active" AND NOT NEW."active" AND NEW."deprovisioned_at" IS NULL THEN
      NEW."deprovisioned_at" := CURRENT_TIMESTAMP;
    END IF;
  ELSIF TG_TABLE_NAME = 'scim_groups' THEN
    IF NEW."scim_id" <> OLD."scim_id" THEN
      RAISE EXCEPTION 'SCIM group identity is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_groups_identity_immutable';
    END IF;
    IF NOT OLD."active" AND NEW."active" THEN
      RAISE EXCEPTION 'Deleted SCIM group requires explicit admin recreation'
        USING ERRCODE = '23514',
              CONSTRAINT = 'scim_groups_delete_terminal';
    END IF;
    IF OLD."active" AND NOT NEW."active" AND NEW."deleted_at" IS NULL THEN
      NEW."deleted_at" := CURRENT_TIMESTAMP;
    END IF;
    IF OLD."active" AND NOT NEW."active" THEN
      DELETE FROM public."scim_group_memberships"
      WHERE "tenant_id" = NEW."tenant_id"
        AND "connector_id" = NEW."connector_id"
        AND "group_id" = NEW."id";
    END IF;
  ELSIF TG_TABLE_NAME = 'scim_group_memberships'
        AND (
          NEW."group_id" <> OLD."group_id"
          OR NEW."scim_user_id" <> OLD."scim_user_id"
        ) THEN
    RAISE EXCEPTION 'SCIM membership identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_group_memberships_identity_immutable';
  END IF;
  IF TG_TABLE_NAME = 'scim_group_memberships' THEN
    NEW."updated_at" := CURRENT_TIMESTAMP;
  ELSE
    NEW."last_modified_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.scim_request_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SCIM request log cannot be deleted'
      USING ERRCODE = '55000',
            CONSTRAINT = 'scim_provisioning_requests_append_only';
  END IF;
  IF OLD."status" <> 'IN_PROGRESS' OR NEW."status" = 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'SCIM request has one terminal transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_provisioning_requests_terminal';
  END IF;
  IF ROW(
    NEW."id", NEW."tenant_id", NEW."connector_id", NEW."service_token_id",
    NEW."request_id", NEW."idempotency_key", NEW."request_hash",
    NEW."http_method", NEW."resource_type", NEW."resource_id",
    NEW."filter_attribute", NEW."filter_operator", NEW."filter_value_hash",
    NEW."if_match_etag", NEW."started_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenant_id", OLD."connector_id", OLD."service_token_id",
    OLD."request_id", OLD."idempotency_key", OLD."request_hash",
    OLD."http_method", OLD."resource_type", OLD."resource_id",
    OLD."filter_attribute", OLD."filter_operator", OLD."filter_value_hash",
    OLD."if_match_etag", OLD."started_at"
  ) THEN
    RAISE EXCEPTION 'SCIM request identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'scim_provisioning_requests_identity_immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION public.refresh_history_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refresh rotation history cannot be deleted'
      USING ERRCODE = '55000',
            CONSTRAINT = 'auth_refresh_token_history_append_only';
  END IF;
  IF ROW(
    NEW."id", NEW."tenant_id", NEW."session_id", NEW."user_id",
    NEW."refresh_family_id", NEW."generation", NEW."token_hash",
    NEW."successor_token_hash", NEW."rotated_at", NEW."expires_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenant_id", OLD."session_id", OLD."user_id",
    OLD."refresh_family_id", OLD."generation", OLD."token_hash",
    OLD."successor_token_hash", OLD."rotated_at", OLD."expires_at"
  ) THEN
    RAISE EXCEPTION 'Refresh rotation evidence is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_refresh_token_history_identity_immutable';
  END IF;
  IF OLD."replayed_at" IS NOT NULL
     AND NEW."replayed_at" IS DISTINCT FROM OLD."replayed_at" THEN
    RAISE EXCEPTION 'Refresh replay evidence cannot be cleared'
      USING ERRCODE = '23514',
            CONSTRAINT = 'auth_refresh_token_history_replay_terminal';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.external_identity_binding_cas_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'External identity binding must start ACTIVE at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'oidc_account_bindings_initial_state';
    END IF;
    PERFORM 1
    FROM public."oidc_token_validation_receipts" AS receipt
    WHERE receipt."tenant_id" = NEW."tenant_id"
      AND receipt."id" = NEW."created_from_receipt_id"
      AND receipt."provider_id" = NEW."provider_id"
      AND receipt."subject_hash" = NEW."subject_hash"
      AND receipt."claims_hash" = NEW."claims_hash"
      AND receipt."validation_status" = 'VERIFIED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OIDC account binding requires a verified token receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'oidc_account_bindings_verified_receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW."id", NEW."tenant_id", NEW."provider_id", NEW."user_id",
    NEW."subject_hash", NEW."created_from_receipt_id", NEW."linked_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenant_id", OLD."provider_id", OLD."user_id",
    OLD."subject_hash", OLD."created_from_receipt_id", OLD."linked_at"
  ) THEN
    RAISE EXCEPTION 'External identity binding identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_account_bindings_identity_immutable';
  END IF;
  IF NEW."last_login_at" IS DISTINCT FROM OLD."last_login_at"
     AND ROW(NEW."status", NEW."claims_hash", NEW."revoked_at")
         IS NOT DISTINCT FROM
         ROW(OLD."status", OLD."claims_hash", OLD."revoked_at") THEN
    IF NEW."revision" <> OLD."revision" THEN
      RAISE EXCEPTION 'Binding login telemetry must preserve revision'
        USING ERRCODE = '40001',
              CONSTRAINT = 'oidc_account_bindings_telemetry_revision';
    END IF;
    IF OLD."last_login_at" IS NOT NULL
       AND NEW."last_login_at" < OLD."last_login_at" THEN
      RAISE EXCEPTION 'OIDC binding last-login time cannot move backwards'
        USING ERRCODE = '23514',
              CONSTRAINT = 'oidc_account_bindings_last_login_monotonic';
    END IF;
  ELSIF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'External identity binding update requires revision CAS'
      USING ERRCODE = '40001',
            CONSTRAINT = 'oidc_account_bindings_revision_cas';
  END IF;
  IF OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED' THEN
    RAISE EXCEPTION 'Revoked external identity binding cannot be restored'
      USING ERRCODE = '23514',
            CONSTRAINT = 'oidc_account_bindings_revocation_terminal';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_governance_command_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  mfa_verified_at timestamptz;
  session_revoked_at timestamptz;
  max_age_seconds integer := 300;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Identity governance command ledger is append-only'
      USING ERRCODE = '55000',
            CONSTRAINT = 'identity_governance_commands_append_only';
  END IF;

  SELECT policy."recent_mfa_max_age_seconds"
  INTO max_age_seconds
  FROM public."enterprise_identity_policies" AS policy
  WHERE policy."tenant_id" = NEW."tenant_id"
    AND policy."publication_status" = 'PUBLISHED';
  max_age_seconds := COALESCE(max_age_seconds, 300);

  SELECT session."last_mfa_at", session."revoked_at"
  INTO mfa_verified_at, session_revoked_at
  FROM public."auth_sessions" AS session
  WHERE session."tenant_id" = NEW."tenant_id"
    AND session."id" = NEW."recent_mfa_session_id"
    AND session."user_id" = NEW."maker_user_id"
  FOR SHARE;

  IF NOT FOUND
     OR session_revoked_at IS NOT NULL
     OR mfa_verified_at IS NULL
     OR mfa_verified_at < NEW."occurred_at" - make_interval(secs => max_age_seconds)
     OR mfa_verified_at > NEW."occurred_at" + interval '30 seconds' THEN
    RAISE EXCEPTION 'Identity governance command requires recent MFA step-up'
      USING ERRCODE = '42501',
            CONSTRAINT = 'identity_governance_commands_recent_mfa';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.emit_identity_governance_command_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  event_type text;
BEGIN
  event_type := CASE NEW."status"
    WHEN 'APPLIED' THEN 'IdentityGovernanceCommandApplied.v1'
    ELSE 'IdentityGovernanceCommandRejected.v1'
  END;

  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  )
  VALUES (
    gen_random_uuid(),
    NEW."tenant_id",
    NEW."resource_type",
    NEW."resource_id",
    event_type,
    jsonb_build_object(
      'commandId', NEW."id",
      'resourceType', NEW."resource_type",
      'resourceId', NEW."resource_id",
      'action', NEW."action",
      'expectedRevision', NEW."expected_revision",
      'resultRevision', NEW."result_revision",
      'requestHash', NEW."request_hash",
      'status', NEW."status"
    ),
    'PENDING',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  )
  VALUES (
    gen_random_uuid(),
    NEW."tenant_id",
    'USER',
    NEW."maker_user_id",
    'identity.governance.' || lower(NEW."status"::text),
    NEW."resource_type",
    NEW."resource_id",
    jsonb_build_object(
      'commandId', NEW."id",
      'action', NEW."action",
      'expectedRevision', NEW."expected_revision",
      'resultRevision', NEW."result_revision",
      'checkerUserId', NEW."checker_user_id",
      'requestHash', NEW."request_hash",
      'reasonCode', NEW."reason_code"
    ),
    NEW."occurred_at"
  );
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_break_glass_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING_APPROVAL' OR NEW."revision" <> 1 THEN
      RAISE EXCEPTION 'Break-glass request must start pending at revision 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'identity_break_glass_requests_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."requester_user_id" <> OLD."requester_user_id"
     OR NEW."scopes" <> OLD."scopes"
     OR NEW."reason" <> OLD."reason"
     OR NEW."requested_duration_seconds" <> OLD."requested_duration_seconds"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'Break-glass request identity and requested authority are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_break_glass_requests_identity_immutable';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Break-glass transition requires revision compare-and-swap'
      USING ERRCODE = '40001',
            CONSTRAINT = 'identity_break_glass_requests_revision_cas';
  END IF;

  IF NOT (
    (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'ACTIVE')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'REVIEW_PENDING')
    OR (OLD."status" = 'REVIEW_PENDING' AND NEW."status" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'Invalid break-glass lifecycle transition: % -> %',
      OLD."status", NEW."status"
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_break_glass_requests_transition';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.identity_break_glass_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  request_row public."identity_break_glass_requests"%ROWTYPE;
  actor_role public."TenantRole";
  mfa_verified_at timestamptz;
  max_age_seconds integer := 300;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Break-glass event history is append-only'
      USING ERRCODE = '55000',
            CONSTRAINT = 'identity_break_glass_events_append_only';
  END IF;

  SELECT *
  INTO request_row
  FROM public."identity_break_glass_requests"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."request_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Break-glass request does not exist'
      USING ERRCODE = '23503',
            CONSTRAINT = 'identity_break_glass_events_request_fkey';
  END IF;

  IF request_row."status" <> NEW."to_status"
     OR request_row."revision" <> NEW."result_revision" THEN
    RAISE EXCEPTION 'Break-glass event does not match persisted request revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_break_glass_events_state_match';
  END IF;

  IF NOT (
    (NEW."action" = 'REQUEST'
      AND NEW."from_status" IS NULL
      AND NEW."to_status" = 'PENDING_APPROVAL'
      AND NEW."actor_type" = 'USER'
      AND NEW."actor_user_id" = request_row."requester_user_id")
    OR (NEW."action" = 'APPROVE'
      AND NEW."from_status" = 'PENDING_APPROVAL'
      AND NEW."to_status" = 'APPROVED'
      AND NEW."actor_type" = 'USER'
      AND NEW."actor_user_id" = request_row."approved_by_user_id")
    OR (NEW."action" = 'REJECT'
      AND NEW."from_status" = 'PENDING_APPROVAL'
      AND NEW."to_status" = 'REJECTED'
      AND NEW."actor_type" = 'USER'
      AND NEW."actor_user_id" = request_row."rejected_by_user_id")
    OR (NEW."action" = 'ACTIVATE'
      AND NEW."from_status" = 'APPROVED'
      AND NEW."to_status" = 'ACTIVE'
      AND NEW."actor_type" = 'USER'
      AND NEW."actor_user_id" = request_row."requester_user_id")
    OR (NEW."action" = 'REVOKE'
      AND NEW."from_status" = 'ACTIVE'
      AND NEW."to_status" = 'REVIEW_PENDING'
      AND NEW."actor_type" = 'USER'
      AND NEW."actor_user_id" = request_row."revoked_by_user_id")
    OR (NEW."action" = 'EXPIRE'
      AND NEW."from_status" = 'ACTIVE'
      AND NEW."to_status" = 'REVIEW_PENDING'
      AND NEW."actor_type" = 'SYSTEM'
      AND request_row."termination_kind" = 'EXPIRED'
      AND request_row."active_until" <= NEW."occurred_at")
    OR (NEW."action" = 'REVIEW_CLOSE'
      AND NEW."from_status" = 'REVIEW_PENDING'
      AND NEW."to_status" = 'CLOSED'
      AND NEW."actor_type" = 'USER'
      AND NEW."actor_user_id" = request_row."reviewed_by_user_id")
  ) THEN
    RAISE EXCEPTION 'Break-glass event action, actor, or transition is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_break_glass_events_transition';
  END IF;

  IF NEW."actor_type" = 'USER' THEN
    SELECT "role"
    INTO actor_role
    FROM public."users"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."actor_user_id";

    IF NEW."action" IN ('APPROVE', 'REJECT', 'REVIEW_CLOSE')
       AND actor_role NOT IN ('OWNER', 'ADMIN') THEN
      RAISE EXCEPTION 'Break-glass approval and review require an administrator'
        USING ERRCODE = '42501',
              CONSTRAINT = 'identity_break_glass_events_admin_actor';
    END IF;
    IF NEW."action" = 'REVOKE'
       AND NEW."actor_user_id" <> request_row."requester_user_id"
       AND actor_role NOT IN ('OWNER', 'ADMIN') THEN
      RAISE EXCEPTION 'Only the requester or an administrator may revoke break-glass access'
        USING ERRCODE = '42501',
              CONSTRAINT = 'identity_break_glass_events_revoker';
    END IF;

    IF NEW."action" IN ('APPROVE', 'ACTIVATE', 'REVOKE', 'REVIEW_CLOSE') THEN
      SELECT session."last_mfa_at",
             COALESCE(policy."recent_mfa_max_age_seconds", 300)
      INTO mfa_verified_at, max_age_seconds
      FROM public."auth_sessions" AS session
      LEFT JOIN public."enterprise_identity_policies" AS policy
        ON policy."tenant_id" = session."tenant_id"
       AND policy."publication_status" = 'PUBLISHED'
      WHERE session."tenant_id" = NEW."tenant_id"
        AND session."id" = NEW."actor_session_id"
        AND session."user_id" = NEW."actor_user_id"
        AND session."revoked_at" IS NULL
        AND session."access_expires_at" > NEW."occurred_at";
      IF mfa_verified_at IS NULL
         OR mfa_verified_at < NEW."occurred_at" - make_interval(secs => max_age_seconds)
         OR mfa_verified_at > NEW."occurred_at" + interval '30 seconds' THEN
        RAISE EXCEPTION 'Break-glass transition requires recent MFA'
          USING ERRCODE = '42501',
                CONSTRAINT = 'identity_break_glass_events_recent_mfa';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.verify_identity_break_glass_transition_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."identity_break_glass_events" AS event
    WHERE event."tenant_id" = NEW."tenant_id"
      AND event."request_id" = NEW."id"
      AND event."result_revision" = NEW."revision"
      AND event."to_status" = NEW."status"
  ) THEN
    RAISE EXCEPTION 'Break-glass state transition requires an audit event'
      USING ERRCODE = '23514',
            CONSTRAINT = 'identity_break_glass_requests_event_required';
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.emit_identity_break_glass_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  ) VALUES (
    gen_random_uuid(), NEW."tenant_id", 'IdentityBreakGlassRequest', NEW."request_id",
    'IdentityBreakGlass' || initcap(lower(NEW."action")) || '.v1',
    jsonb_build_object(
      'requestId', NEW."request_id",
      'action', NEW."action",
      'fromStatus', NEW."from_status",
      'toStatus', NEW."to_status",
      'expectedRevision', NEW."expected_revision",
      'resultRevision', NEW."result_revision",
      'requestHash', NEW."request_hash"
    ),
    'PENDING', 0, NEW."occurred_at", NEW."occurred_at"
  );

  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  ) VALUES (
    gen_random_uuid(),
    NEW."tenant_id",
    CASE WHEN NEW."actor_type" = 'SYSTEM'
      THEN 'SERVICE'::public."AuditActorType"
      ELSE 'USER'::public."AuditActorType"
    END,
    COALESCE(NEW."actor_user_id", NEW."request_id"),
    'identity.break_glass.' || lower(NEW."action"),
    'IdentityBreakGlassRequest',
    NEW."request_id",
    jsonb_build_object(
      'eventId', NEW."id",
      'fromStatus', NEW."from_status",
      'toStatus', NEW."to_status",
      'expectedRevision', NEW."expected_revision",
      'resultRevision', NEW."result_revision",
      'requestHash', NEW."request_hash"
    ),
    NEW."occurred_at"
  );
  RETURN NULL;
END
$function$;

-- Authorization checks derive the requester from the authenticated session and
-- evaluate time at the point of use. A row that has not yet been swept to
-- REVIEW_PENDING is therefore still denied immediately after active_until.
CREATE OR REPLACE FUNCTION public.has_active_break_glass_grant(
  p_session_id uuid,
  p_scope text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public."auth_sessions" AS session
    JOIN public."identity_break_glass_requests" AS request
      ON request."tenant_id" = session."tenant_id"
     AND request."requester_user_id" = session."user_id"
    WHERE session."tenant_id" =
          NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND session."id" = p_session_id
      AND session."revoked_at" IS NULL
      AND session."access_expires_at" > CURRENT_TIMESTAMP
      AND request."status" = 'ACTIVE'
      AND request."activated_at" <= CURRENT_TIMESTAMP
      AND request."active_until" > CURRENT_TIMESTAMP
      AND p_scope = ANY(request."scopes")
  )
$function$;

-- A SCIM active=true -> false transition synchronously closes local access.
-- Role Assignments are suspended (rather than forged as revoked by a fake human
-- actor); an Outbox event drives external IM/tool/connector cleanup.
CREATE OR REPLACE FUNCTION public.apply_scim_user_deprovisioning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  revoked_session_count integer := 0;
  revoked_device_count integer := 0;
  suspended_assignment_count integer := 0;
  cancelled_run_count integer := 0;
  outbox_id uuid := gen_random_uuid();
BEGIN
  IF NOT OLD."active" OR NEW."active" THEN
    RETURN NEW;
  END IF;

  -- Serialize against concurrent admin login/session issuance for this user.
  PERFORM 1
  FROM public."users" AS target_user
  WHERE target_user."tenant_id" = NEW."tenant_id"
    AND target_user."id" = NEW."user_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCIM target user does not exist in this tenant'
      USING ERRCODE = '23503',
            CONSTRAINT = 'scim_users_user_fkey';
  END IF;

  UPDATE public."users"
  SET "status" = 'INACTIVE', "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."user_id"
    AND "status" <> 'INACTIVE';

  UPDATE public."auth_sessions"
  SET
    "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP),
    "revoked_reason" = COALESCE("revoked_reason", 'SCIM_DEPROVISIONING'),
    "version" = "version" + 1
  WHERE "tenant_id" = NEW."tenant_id"
    AND "user_id" = NEW."user_id"
    AND "revoked_at" IS NULL;
  GET DIAGNOSTICS revoked_session_count = ROW_COUNT;

  UPDATE public."identity_devices"
  SET
    "status" = 'REVOKED',
    "revoked_at" = CURRENT_TIMESTAMP,
    "revoke_reason" = 'SCIM_DEPROVISIONING',
    "revision" = "revision" + 1,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "user_id" = NEW."user_id"
    AND "status" = 'ACTIVE';
  GET DIAGNOSTICS revoked_device_count = ROW_COUNT;

  UPDATE public."role_assignments"
  SET
    "status" = 'SUSPENDED',
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "user_id" = NEW."user_id"
    AND "status" IN ('PENDING', 'ACTIVE');
  GET DIAGNOSTICS suspended_assignment_count = ROW_COUNT;

  UPDATE public."agent_runs" AS run
  SET
    "status" = 'CANCELLED',
    "error_code" = 'IDENTITY_DEPROVISIONED',
    "error_message" = 'Requester identity was deprovisioned by SCIM.',
    "finished_at" = CURRENT_TIMESTAMP,
    "reserved_tokens" = 0,
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE run."tenant_id" = NEW."tenant_id"
    AND (
      run."requester_user_id" = NEW."user_id"
      OR EXISTS (
        SELECT 1
        FROM public."role_assignments" AS assignment
        WHERE assignment."tenant_id" = NEW."tenant_id"
          AND assignment."user_id" = NEW."user_id"
          AND assignment."agent_instance_id" = run."agent_id"
      )
    )
    AND run."status" IN ('QUEUED', 'DISPATCHING', 'RUNNING', 'UNKNOWN');
  GET DIAGNOSTICS cancelled_run_count = ROW_COUNT;

  INSERT INTO public."outbox_events" (
    "id", "tenant_id", "aggregate_type", "aggregate_id", "event_type",
    "payload", "status", "attempts", "available_at", "created_at"
  )
  VALUES (
    outbox_id,
    NEW."tenant_id",
    'User',
    NEW."user_id",
    'IdentityPrincipalDeprovisioned.v1',
    jsonb_build_object(
      'tenantId', NEW."tenant_id",
      'userId', NEW."user_id",
      'connectorId', NEW."connector_id",
      'scimUserId', NEW."id",
      'sessionsRevoked', revoked_session_count,
      'devicesRevoked', revoked_device_count,
      'assignmentsSuspended', suspended_assignment_count,
      'agentRunsCancelled', cancelled_run_count
    ),
    'PENDING',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO public."audit_events" (
    "id", "tenant_id", "actor_type", "actor_id", "action",
    "resource_type", "resource_id", "metadata", "occurred_at"
  )
  VALUES (
    gen_random_uuid(),
    NEW."tenant_id",
    'SERVICE',
    NEW."connector_id",
    'identity.scim.user.deprovisioned',
    'User',
    NEW."user_id",
    jsonb_build_object(
      'connectorId', NEW."connector_id",
      'scimUserId', NEW."id",
      'sessionsRevoked', revoked_session_count,
      'devicesRevoked', revoked_device_count,
      'assignmentsSuspended', suspended_assignment_count,
      'agentRunsCancelled', cancelled_run_count
    ),
    CURRENT_TIMESTAMP
  );

  INSERT INTO public."identity_deprovisioning_actions" (
    "tenant_id", "connector_id", "scim_user_id", "user_id",
    "sessions_revoked", "devices_revoked", "assignments_suspended",
    "agent_runs_cancelled", "outbox_event_id", "occurred_at"
  )
  VALUES (
    NEW."tenant_id",
    NEW."connector_id",
    NEW."id",
    NEW."user_id",
    revoked_session_count,
    revoked_device_count,
    suspended_assignment_count,
    cancelled_run_count,
    outbox_id,
    CURRENT_TIMESTAMP
  );
  RETURN NEW;
END
$function$;

CREATE TRIGGER "enterprise_identity_policies_cas_guard"
  BEFORE INSERT OR UPDATE ON public."enterprise_identity_policies"
  FOR EACH ROW EXECUTE FUNCTION public.identity_policy_cas_guard();

CREATE TRIGGER "user_mfa_factors_cas_guard"
  BEFORE INSERT OR UPDATE ON public."user_mfa_factors"
  FOR EACH ROW EXECUTE FUNCTION public.mfa_factor_cas_guard();

CREATE TRIGGER "user_mfa_factors_disable_dependents"
  AFTER UPDATE OF "status" ON public."user_mfa_factors"
  FOR EACH ROW EXECUTE FUNCTION public.revoke_disabled_mfa_factor_dependents();

CREATE TRIGGER "mfa_recovery_codes_guard"
  BEFORE UPDATE OR DELETE ON public."mfa_recovery_codes"
  FOR EACH ROW EXECUTE FUNCTION public.mfa_recovery_code_guard();

CREATE TRIGGER "identity_devices_cas_guard"
  BEFORE INSERT OR UPDATE ON public."identity_devices"
  FOR EACH ROW EXECUTE FUNCTION public.identity_device_cas_guard();

CREATE TRIGGER "identity_devices_revoke_sessions"
  AFTER UPDATE OF "status" ON public."identity_devices"
  FOR EACH ROW EXECUTE FUNCTION public.revoke_identity_device_sessions();

CREATE TRIGGER "auth_sessions_refresh_rotation_guard"
  BEFORE INSERT OR UPDATE OF "refresh_token_hash", "refresh_family_id",
    "refresh_generation"
  ON public."auth_sessions"
  FOR EACH ROW EXECUTE FUNCTION public.auth_session_refresh_rotation_guard();

CREATE TRIGGER "auth_refresh_token_history_guard"
  BEFORE UPDATE OR DELETE ON public."auth_refresh_token_history"
  FOR EACH ROW EXECUTE FUNCTION public.refresh_history_guard();

CREATE TRIGGER "auth_mfa_challenges_transition_guard"
  BEFORE INSERT OR UPDATE ON public."auth_mfa_challenges"
  FOR EACH ROW EXECUTE FUNCTION public.mfa_challenge_transition_guard();

CREATE TRIGGER "enterprise_identity_providers_guard"
  BEFORE INSERT OR UPDATE ON public."enterprise_identity_providers"
  FOR EACH ROW EXECUTE FUNCTION public.identity_provider_guard();

CREATE TRIGGER "oidc_provider_configs_guard"
  BEFORE INSERT OR UPDATE ON public."oidc_provider_configs"
  FOR EACH ROW
  EXECUTE FUNCTION public.identity_provider_protocol_config_guard('OIDC');

CREATE TRIGGER "saml_provider_configs_guard"
  BEFORE INSERT OR UPDATE ON public."saml_provider_configs"
  FOR EACH ROW
  EXECUTE FUNCTION public.identity_provider_protocol_config_guard('SAML');

CREATE TRIGGER "identity_provider_secrets_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."identity_provider_secrets"
  FOR EACH ROW EXECUTE FUNCTION public.identity_provider_secret_guard();

CREATE TRIGGER "oidc_auth_transactions_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."oidc_auth_transactions"
  FOR EACH ROW EXECUTE FUNCTION public.oidc_transaction_guard();

CREATE TRIGGER "oidc_token_validation_receipts_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."oidc_token_validation_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.oidc_token_receipt_guard();

CREATE TRIGGER "oidc_account_bindings_cas_guard"
  BEFORE INSERT OR UPDATE ON public."oidc_account_bindings"
  FOR EACH ROW EXECUTE FUNCTION public.external_identity_binding_cas_guard();

CREATE TRIGGER "saml_authn_requests_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."saml_authn_requests"
  FOR EACH ROW EXECUTE FUNCTION public.saml_authn_request_guard();

CREATE TRIGGER "saml_assertion_receipts_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."saml_assertion_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.saml_assertion_receipt_guard();

CREATE TRIGGER "scim_connectors_cas_guard"
  BEFORE INSERT OR UPDATE ON public."scim_connectors"
  FOR EACH ROW EXECUTE FUNCTION public.scim_connector_cas_guard();

CREATE TRIGGER "scim_service_tokens_cas_guard"
  BEFORE INSERT OR UPDATE ON public."scim_service_tokens"
  FOR EACH ROW EXECUTE FUNCTION public.scim_token_cas_guard();

CREATE TRIGGER "scim_users_cas_guard"
  BEFORE INSERT OR UPDATE ON public."scim_users"
  FOR EACH ROW EXECUTE FUNCTION public.scim_resource_cas_guard();

CREATE TRIGGER "scim_groups_cas_guard"
  BEFORE INSERT OR UPDATE ON public."scim_groups"
  FOR EACH ROW EXECUTE FUNCTION public.scim_resource_cas_guard();

CREATE TRIGGER "scim_group_memberships_cas_guard"
  BEFORE INSERT OR UPDATE ON public."scim_group_memberships"
  FOR EACH ROW EXECUTE FUNCTION public.scim_resource_cas_guard();

CREATE TRIGGER "scim_provisioning_requests_guard"
  BEFORE UPDATE OR DELETE ON public."scim_provisioning_requests"
  FOR EACH ROW EXECUTE FUNCTION public.scim_request_transition_guard();

CREATE TRIGGER "scim_users_deprovision"
  AFTER UPDATE OF "active" ON public."scim_users"
  FOR EACH ROW EXECUTE FUNCTION public.apply_scim_user_deprovisioning();

CREATE TRIGGER "identity_deprovisioning_actions_append_only"
  BEFORE UPDATE OR DELETE ON public."identity_deprovisioning_actions"
  FOR EACH ROW EXECUTE FUNCTION public.identity_append_only_guard();

CREATE TRIGGER "identity_governance_commands_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."identity_governance_commands"
  FOR EACH ROW EXECUTE FUNCTION public.identity_governance_command_guard();

CREATE TRIGGER "identity_governance_commands_events"
  AFTER INSERT ON public."identity_governance_commands"
  FOR EACH ROW EXECUTE FUNCTION public.emit_identity_governance_command_events();

CREATE TRIGGER "identity_break_glass_requests_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."identity_break_glass_requests"
  FOR EACH ROW EXECUTE FUNCTION public.identity_break_glass_request_guard();

CREATE CONSTRAINT TRIGGER "identity_break_glass_requests_event_required"
  AFTER INSERT OR UPDATE ON public."identity_break_glass_requests"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.verify_identity_break_glass_transition_event();

CREATE TRIGGER "identity_break_glass_events_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."identity_break_glass_events"
  FOR EACH ROW EXECUTE FUNCTION public.identity_break_glass_event_guard();

CREATE TRIGGER "identity_break_glass_events_emit"
  AFTER INSERT ON public."identity_break_glass_events"
  FOR EACH ROW EXECUTE FUNCTION public.emit_identity_break_glass_event();

-- ---------------------------------------------------------------------------
-- Dedicated SCIM capability role
-- ---------------------------------------------------------------------------

DO $scim_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'enterprise_agent_scim'
  ) THEN
    CREATE ROLE enterprise_agent_scim
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE enterprise_agent_scim
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT enterprise_agent_scim TO %I', current_user);
END
$scim_role$;

REVOKE enterprise_agent_scim
  FROM enterprise_agent_app,
       enterprise_agent_auth,
       enterprise_agent_admin,
       enterprise_agent_outbox,
       enterprise_agent_provisioner;
GRANT USAGE ON SCHEMA public TO enterprise_agent_scim;

-- ---------------------------------------------------------------------------
-- RLS and explicit ACLs
-- ---------------------------------------------------------------------------

DO $identity_table_security$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'enterprise_identity_policies',
    'user_mfa_factors',
    'mfa_recovery_codes',
    'identity_devices',
    'auth_refresh_token_history',
    'auth_mfa_challenges',
    'enterprise_identity_providers',
    'identity_provider_secrets',
    'oidc_provider_configs',
    'saml_provider_configs',
    'oidc_auth_transactions',
    'oidc_token_validation_receipts',
    'oidc_account_bindings',
    'saml_authn_requests',
    'saml_assertion_receipts',
    'scim_connectors',
    'scim_service_tokens',
    'scim_users',
    'scim_groups',
    'scim_group_memberships',
    'scim_provisioning_requests',
    'identity_deprovisioning_actions',
    'identity_governance_commands',
    'identity_break_glass_requests',
    'identity_break_glass_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, '
      || 'enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin, '
      || 'enterprise_agent_outbox, enterprise_agent_provisioner, enterprise_agent_scim',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY identity_admin_tenant_isolation ON public.%I '
      || 'AS RESTRICTIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY identity_admin_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_admin '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
    -- Authentication resolves a tenant from an opaque token/state before an
    -- app.tenant_id is available. Like the existing auth_sessions policy this
    -- is intentionally limited by the dedicated role's narrow table ACLs.
    EXECUTE format(
      'CREATE POLICY identity_auth_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_auth '
      || 'USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END
$identity_table_security$;

-- The SCIM bearer digest is the only pre-tenant lookup. Every resource mutation
-- after it must set transaction-local app.tenant_id and pass this predicate.
CREATE POLICY "identity_scim_token_lookup"
  ON public."scim_service_tokens"
  AS PERMISSIVE
  FOR SELECT
  TO enterprise_agent_scim
  USING (true);
CREATE POLICY "identity_scim_token_telemetry"
  ON public."scim_service_tokens"
  AS PERMISSIVE
  FOR UPDATE
  TO enterprise_agent_scim
  USING (true)
  WITH CHECK (true);

DO $scim_tenant_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scim_connectors',
    'scim_users',
    'scim_groups',
    'scim_group_memberships',
    'scim_provisioning_requests',
    'identity_deprovisioning_actions',
    'identity_devices'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY identity_scim_tenant_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO enterprise_agent_scim '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$scim_tenant_policies$;

CREATE POLICY "identity_scim_user_access"
  ON public."users"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_scim
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "identity_scim_session_access"
  ON public."auth_sessions"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_scim
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "identity_scim_assignment_access"
  ON public."role_assignments"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_scim
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "identity_scim_run_access"
  ON public."agent_runs"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_scim
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "identity_scim_outbox_access"
  ON public."outbox_events"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_scim
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY "identity_scim_audit_access"
  ON public."audit_events"
  AS PERMISSIVE
  FOR ALL
  TO enterprise_agent_scim
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- Authentication capability: no provider/MFA secret is exposed to the admin or
-- business roles. DELETE is intentionally absent for durable identity history.
GRANT SELECT ON TABLE
  public."enterprise_identity_policies",
  public."user_mfa_factors",
  public."mfa_recovery_codes",
  public."identity_devices",
  public."auth_refresh_token_history",
  public."auth_mfa_challenges",
  public."enterprise_identity_providers",
  public."identity_provider_secrets",
  public."oidc_provider_configs",
  public."saml_provider_configs",
  public."oidc_auth_transactions",
  public."oidc_token_validation_receipts",
  public."oidc_account_bindings",
  public."saml_authn_requests",
  public."saml_assertion_receipts"
TO enterprise_agent_auth;

GRANT INSERT, UPDATE ON TABLE
  public."user_mfa_factors",
  public."mfa_recovery_codes",
  public."identity_devices",
  public."auth_refresh_token_history",
  public."auth_mfa_challenges",
  public."oidc_auth_transactions",
  public."oidc_token_validation_receipts",
  public."oidc_account_bindings",
  public."saml_authn_requests",
  public."saml_assertion_receipts"
TO enterprise_agent_auth;

GRANT UPDATE (
  "publication_status",
  "verification_status",
  "verified_configuration_hash",
  "verification_evidence_hash",
  "verification_error_code",
  "verified_at",
  "revision",
  "request_hash",
  "updated_at"
) ON TABLE public."enterprise_identity_providers"
TO enterprise_agent_auth;
GRANT UPDATE (
  "verifier_port_name",
  "verifier_port_version",
  "verifier_status",
  "verified_metadata_hash",
  "verifier_evidence_hash",
  "verifier_verified_at",
  "updated_at"
) ON TABLE public."saml_provider_configs"
TO enterprise_agent_auth;

-- Admin capability. Secret tables remain write-only and have metadata views
-- below; all reads are still tenant-restricted by FORCE RLS.
GRANT SELECT, INSERT, UPDATE ON TABLE
  public."enterprise_identity_policies",
  public."enterprise_identity_providers",
  public."oidc_provider_configs",
  public."saml_provider_configs",
  public."scim_connectors",
  public."identity_governance_commands",
  public."identity_break_glass_requests"
TO enterprise_agent_admin;
GRANT SELECT, INSERT ON TABLE
  public."identity_break_glass_events"
TO enterprise_agent_admin;
GRANT INSERT, UPDATE, DELETE ON TABLE
  public."identity_provider_secrets"
TO enterprise_agent_admin;
GRANT INSERT, UPDATE ON TABLE
  public."scim_service_tokens"
TO enterprise_agent_admin;
GRANT SELECT ON TABLE
  public."scim_users",
  public."scim_groups",
  public."scim_group_memberships",
  public."scim_provisioning_requests",
  public."identity_deprovisioning_actions",
  public."auth_refresh_token_history"
TO enterprise_agent_admin;
GRANT UPDATE ON TABLE public."identity_devices"
TO enterprise_agent_admin;

-- Dedicated SCIM role. Token creation/revocation remains an admin operation.
GRANT SELECT ON TABLE
  public."scim_service_tokens",
  public."scim_connectors"
TO enterprise_agent_scim;
GRANT UPDATE ("last_used_at") ON TABLE public."scim_service_tokens"
TO enterprise_agent_scim;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public."scim_users",
  public."scim_groups",
  public."scim_group_memberships",
  public."scim_provisioning_requests"
TO enterprise_agent_scim;
GRANT DELETE ON TABLE
  public."scim_group_memberships"
TO enterprise_agent_scim;
GRANT SELECT, INSERT ON TABLE
  public."identity_deprovisioning_actions"
TO enterprise_agent_scim;

GRANT SELECT (
  "tenant_id", "id", "status"
) ON TABLE public."users" TO enterprise_agent_scim;
GRANT INSERT (
  "id", "tenant_id", "email", "email_normalized", "display_name",
  "status", "role", "created_at", "updated_at"
) ON TABLE public."users" TO enterprise_agent_scim;
GRANT UPDATE (
  "email", "email_normalized", "display_name", "status", "updated_at"
) ON TABLE public."users" TO enterprise_agent_scim;

GRANT SELECT (
  "tenant_id", "id", "user_id", "revoked_at"
) ON TABLE public."auth_sessions" TO enterprise_agent_scim;
GRANT UPDATE (
  "revoked_at", "revoked_reason", "version"
) ON TABLE public."auth_sessions" TO enterprise_agent_scim;

GRANT SELECT (
  "tenant_id", "id", "user_id", "status", "revision"
) ON TABLE public."identity_devices" TO enterprise_agent_scim;
GRANT UPDATE (
  "status", "revoked_at", "revoke_reason", "revision", "updated_at"
) ON TABLE public."identity_devices" TO enterprise_agent_scim;

GRANT SELECT (
  "tenant_id", "id", "user_id", "agent_instance_id", "status", "version"
) ON TABLE public."role_assignments" TO enterprise_agent_scim;
GRANT UPDATE (
  "status", "version", "updated_at"
) ON TABLE public."role_assignments" TO enterprise_agent_scim;

GRANT SELECT (
  "tenant_id", "id", "requester_user_id", "status", "version"
) ON TABLE public."agent_runs" TO enterprise_agent_scim;
GRANT UPDATE (
  "status", "error_code", "error_message", "finished_at",
  "reserved_tokens", "version", "updated_at"
) ON TABLE public."agent_runs" TO enterprise_agent_scim;

GRANT SELECT, INSERT ON TABLE
  public."outbox_events",
  public."audit_events"
TO enterprise_agent_scim;

-- Read-safe metadata surfaces for admin and employee-facing API adapters.
-- security_invoker preserves the caller's RLS and column privileges.
CREATE VIEW public."identity_mfa_factor_metadata"
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  "id",
  "tenant_id",
  "user_id",
  "method",
  "status",
  "label",
  "verified_at",
  "disabled_at",
  "blocked_until",
  "revision",
  "created_at",
  "updated_at"
FROM public."user_mfa_factors";

CREATE VIEW public."identity_device_metadata"
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  "id",
  "tenant_id",
  "user_id",
  "fingerprint_version",
  "label",
  "platform",
  "device_class",
  "status",
  "first_seen_at",
  "last_seen_at",
  "revoked_at",
  "revoke_reason",
  "revision",
  "created_at",
  "updated_at"
FROM public."identity_devices";

CREATE VIEW public."identity_session_metadata"
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  "id",
  "tenant_id",
  "user_id",
  "device_id",
  "label",
  "access_expires_at",
  "refresh_expires_at",
  "last_used_at",
  "last_mfa_at",
  "last_mfa_method",
  "refresh_generation",
  "refresh_replay_detected_at",
  "revoked_at",
  "revoked_reason",
  "created_at",
  "version"
FROM public."auth_sessions";

CREATE VIEW public."identity_provider_secret_metadata"
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  "id",
  "tenant_id",
  "provider_id",
  "kind",
  "secret_key_id",
  "secret_format_version",
  "revision",
  "created_at",
  "updated_at"
FROM public."identity_provider_secrets";

CREATE VIEW public."scim_service_token_metadata"
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  "id",
  "tenant_id",
  "connector_id",
  "token_hint",
  "status",
  "scopes",
  "created_by_user_id",
  "expires_at",
  "last_used_at",
  "revoked_at",
  "revision",
  "created_at"
FROM public."scim_service_tokens";

REVOKE ALL PRIVILEGES ON
  public."identity_mfa_factor_metadata",
  public."identity_device_metadata",
  public."identity_session_metadata",
  public."identity_provider_secret_metadata",
  public."scim_service_token_metadata"
FROM PUBLIC, enterprise_agent_app, enterprise_agent_auth,
  enterprise_agent_admin, enterprise_agent_outbox,
  enterprise_agent_provisioner, enterprise_agent_scim;

-- Column-level base grants are exactly the columns projected by the safe views.
GRANT SELECT (
  "id", "tenant_id", "user_id", "method", "status", "label",
  "verified_at", "disabled_at", "blocked_until", "revision",
  "created_at", "updated_at"
) ON TABLE public."user_mfa_factors" TO enterprise_agent_admin;
GRANT SELECT (
  "id", "tenant_id", "user_id", "fingerprint_version", "label", "platform",
  "device_class", "status", "first_seen_at", "last_seen_at", "revoked_at",
  "revoke_reason", "revision", "created_at", "updated_at"
) ON TABLE public."identity_devices" TO enterprise_agent_admin;
GRANT SELECT (
  "id", "tenant_id", "provider_id", "kind", "secret_key_id",
  "secret_format_version", "revision", "created_at", "updated_at"
) ON TABLE public."identity_provider_secrets" TO enterprise_agent_admin;
GRANT SELECT (
  "id", "tenant_id", "connector_id", "token_hint", "status", "scopes",
  "created_by_user_id", "expires_at", "last_used_at", "revoked_at",
  "revision", "created_at"
) ON TABLE public."scim_service_tokens" TO enterprise_agent_admin;

-- auth_sessions already has a legacy admin SELECT grant. The view is the
-- required response projection; token digests must never be serialized by API
-- contracts or logs.
GRANT SELECT ON
  public."identity_mfa_factor_metadata",
  public."identity_device_metadata",
  public."identity_session_metadata",
  public."identity_provider_secret_metadata",
  public."scim_service_token_metadata"
TO enterprise_agent_admin;
GRANT SELECT ON
  public."identity_mfa_factor_metadata",
  public."identity_device_metadata",
  public."identity_session_metadata"
TO enterprise_agent_auth;

GRANT USAGE ON TYPE
  public."IdentityPublicationStatus",
  public."IdentityVerificationStatus",
  public."MfaPolicyRequirement",
  public."MfaFactorStatus",
  public."MfaMethod",
  public."MfaChallengeStatus",
  public."IdentityDeviceStatus",
  public."IdentityProviderProtocol",
  public."IdentityProviderJitMode",
  public."ExternalIdentityBindingStatus",
  public."ScimConnectorStatus",
  public."ScimTokenStatus",
  public."ScimRequestStatus",
  public."IdentityGovernanceCommandStatus"
TO enterprise_agent_auth, enterprise_agent_admin, enterprise_agent_scim;

-- Trigger helpers are not general-purpose APIs.
DO $revoke_identity_helpers$
DECLARE
  helper record;
BEGIN
  FOR helper IN
    SELECT procedure.oid::regprocedure AS signature
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = ANY (ARRAY[
        'identity_policy_cas_guard',
        'mfa_factor_cas_guard',
        'mfa_recovery_code_guard',
        'revoke_disabled_mfa_factor_dependents',
        'identity_device_cas_guard',
        'revoke_identity_device_sessions',
        'auth_session_refresh_rotation_guard',
        'mfa_challenge_transition_guard',
        'identity_provider_guard',
        'identity_provider_protocol_config_guard',
        'identity_provider_secret_guard',
        'oidc_transaction_guard',
        'oidc_token_receipt_guard',
        'saml_authn_request_guard',
        'saml_assertion_receipt_guard',
        'scim_connector_cas_guard',
        'scim_token_cas_guard',
        'scim_resource_cas_guard',
        'scim_request_transition_guard',
        'identity_append_only_guard',
        'refresh_history_guard',
        'external_identity_binding_cas_guard',
        'identity_governance_command_guard',
        'emit_identity_governance_command_events',
        'identity_break_glass_request_guard',
        'identity_break_glass_event_guard',
        'verify_identity_break_glass_transition_event',
        'emit_identity_break_glass_event',
        'has_active_break_glass_grant',
        'apply_scim_user_deprovisioning'
      ])
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
      helper.signature
    );
  END LOOP;
END
$revoke_identity_helpers$;

GRANT EXECUTE ON FUNCTION public.has_active_break_glass_grant(uuid, text)
TO enterprise_agent_app, enterprise_agent_auth, enterprise_agent_admin;

COMMIT;
