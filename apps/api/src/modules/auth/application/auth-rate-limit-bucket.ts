import { Prisma } from '@prisma/client';

export type AuthRateLimitScope = 'ACCOUNT' | 'NETWORK' | 'RECOVERY_ACCOUNT' | 'RECOVERY_NETWORK';

export interface AuthRateLimitReservation {
  readonly blocked: boolean;
  readonly capacityExceeded: boolean;
}

interface ReserveAuthRateLimitBucketInput {
  readonly transaction: Prisma.TransactionClient;
  readonly keyHash: string;
  readonly scope: AuthRateLimitScope;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly blockSeconds: number;
  readonly capacity: number;
  readonly staleRetentionSeconds: number;
}

/**
 * Atomically increments one opaque throttle bucket without allowing attacker-
 * controlled identifiers to grow the pre-authentication table indefinitely.
 *
 * Existing keys stay on a lock-free UPDATE path. A new key takes a transaction-
 * scoped advisory lock for its scope, prunes stale rows, and is admitted only
 * while that scope remains below its hard capacity. Capacity exhaustion fails
 * closed without persisting the candidate key.
 */
export async function reserveAuthRateLimitBucket(
  input: ReserveAuthRateLimitBucketInput,
): Promise<AuthRateLimitReservation> {
  const existing = await updateExistingBucket(input);
  if (existing !== undefined) return existing;

  await input.transaction.$queryRaw(Prisma.sql`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(
      hashtext('enterprise-agent-auth-rate-limit'),
      hashtext(${input.scope})
    )
  `);
  await pruneStaleScope(input);

  const [created] = await input.transaction.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
    INSERT INTO public."auth_login_rate_limits" (
      "key_hash", "scope", "failure_count", "window_started_at", "blocked_until", "updated_at"
    )
    SELECT ${input.keyHash}, ${input.scope}, 1, now(), NULL, now()
    WHERE (
      SELECT count(*) < ${input.capacity}
      FROM public."auth_login_rate_limits"
      WHERE "scope" = ${input.scope}
    )
    ON CONFLICT ("key_hash") DO UPDATE SET
      "failure_count" = CASE
        WHEN public."auth_login_rate_limits"."window_started_at"
          <= now() - make_interval(secs => ${input.windowSeconds})
          THEN 1
        ELSE LEAST(public."auth_login_rate_limits"."failure_count", ${input.limit}) + 1
      END,
      "window_started_at" = CASE
        WHEN public."auth_login_rate_limits"."window_started_at"
          <= now() - make_interval(secs => ${input.windowSeconds})
          THEN now()
        ELSE public."auth_login_rate_limits"."window_started_at"
      END,
      "blocked_until" = CASE
        WHEN public."auth_login_rate_limits"."blocked_until" > now()
          THEN public."auth_login_rate_limits"."blocked_until"
        WHEN (
          CASE
            WHEN public."auth_login_rate_limits"."window_started_at"
              <= now() - make_interval(secs => ${input.windowSeconds})
              THEN 1
            ELSE LEAST(public."auth_login_rate_limits"."failure_count", ${input.limit}) + 1
          END
        ) > ${input.limit}
          THEN now() + make_interval(secs => ${input.blockSeconds})
        ELSE NULL
      END,
      "updated_at" = now()
    WHERE public."auth_login_rate_limits"."scope" = EXCLUDED."scope"
    RETURNING "blocked_until" > now() AS blocked
  `);

  if (created === undefined) return { blocked: true, capacityExceeded: true };
  return { blocked: created.blocked === true, capacityExceeded: false };
}

async function updateExistingBucket(
  input: ReserveAuthRateLimitBucketInput,
): Promise<AuthRateLimitReservation | undefined> {
  const [row] = await input.transaction.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
    UPDATE public."auth_login_rate_limits"
    SET "failure_count" = CASE
          WHEN "window_started_at" <= now() - make_interval(secs => ${input.windowSeconds})
            THEN 1
          ELSE LEAST("failure_count", ${input.limit}) + 1
        END,
        "window_started_at" = CASE
          WHEN "window_started_at" <= now() - make_interval(secs => ${input.windowSeconds})
            THEN now()
          ELSE "window_started_at"
        END,
        "blocked_until" = CASE
          WHEN "blocked_until" > now() THEN "blocked_until"
          WHEN (
            CASE
              WHEN "window_started_at" <= now() - make_interval(secs => ${input.windowSeconds})
                THEN 1
              ELSE LEAST("failure_count", ${input.limit}) + 1
            END
          ) > ${input.limit}
            THEN now() + make_interval(secs => ${input.blockSeconds})
          ELSE NULL
        END,
        "updated_at" = now()
    WHERE "key_hash" = ${input.keyHash}
      AND "scope" = ${input.scope}
    RETURNING "blocked_until" > now() AS blocked
  `);
  if (row === undefined) return undefined;
  return { blocked: row.blocked === true, capacityExceeded: false };
}

async function pruneStaleScope(input: ReserveAuthRateLimitBucketInput): Promise<void> {
  await input.transaction.$executeRaw(Prisma.sql`
    WITH stale AS (
      SELECT "key_hash"
      FROM public."auth_login_rate_limits"
      WHERE "scope" = ${input.scope}
        AND "updated_at" < now() - make_interval(secs => ${input.staleRetentionSeconds})
      ORDER BY "updated_at" ASC
      LIMIT 500
    )
    DELETE FROM public."auth_login_rate_limits" buckets
    USING stale
    WHERE buckets."key_hash" = stale."key_hash"
  `);
}
