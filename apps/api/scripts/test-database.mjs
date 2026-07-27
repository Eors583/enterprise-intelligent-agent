import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const environmentFile = ['.env', '.env.example']
  .map((name) => resolve(repositoryRoot, name))
  .find(existsSync);
if (environmentFile !== undefined) process.loadEnvFile(environmentFile);

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === '') {
  throw new Error(
    'TEST_DATABASE_URL (or DATABASE_URL) must point to a dedicated PostgreSQL integration-test database.',
  );
}

const require = createRequire(import.meta.url);
// `vitest/vitest.mjs` exists on disk but is not an exported package subpath.
// Resolve the exported package manifest, then address the adjacent CLI file.
const vitestCli = resolve(require.resolve('vitest/package.json'), '..', 'vitest.mjs');
const result = spawnSync(
  process.execPath,
  [
    vitestCli,
    'run',
    'test/prisma-auth.integration.spec.ts',
    'test/prisma-admin.integration.spec.ts',
    'test/prisma-rls.integration.spec.ts',
    'test/prisma-conversation.integration.spec.ts',
    'test/prisma-agent-run.integration.spec.ts',
    'test/prisma-im-outbox.integration.spec.ts',
    'test/prisma-knowledge-ingestion.integration.spec.ts',
  ],
  {
    cwd: resolve(repositoryRoot, 'apps/api'),
    // AppModule evaluates ConfigModule.forRoot() when the test file is imported,
    // before any Vitest lifecycle hook runs. Select the Prisma adapter in the
    // child process itself so database tests cannot silently exercise memory
    // repositories instead.
    env: {
      ...process.env,
      NODE_ENV: 'test',
      REPOSITORY_DRIVER: 'prisma',
      RUN_DATABASE_TESTS: 'true',
      // Database tests intentionally use one isolated administrative login so
      // every Prisma capability reaches the same acceptance database. Do not
      // inherit AUTH/ADMIN/OUTBOX URLs from a developer .env: doing so can mix
      // schemas and produce misleading failures against the live dev database.
      DATABASE_URL: testDatabaseUrl,
      AUTH_DATABASE_URL: testDatabaseUrl,
      ADMIN_DATABASE_URL: testDatabaseUrl,
      OUTBOX_DATABASE_URL: testDatabaseUrl,
      // Integration suites drive a bounded worker instance explicitly after
      // asserting the queued state. Disable the AppModule bootstrap worker so
      // it cannot claim the same row first and make those assertions racy.
      KNOWLEDGE_INGESTION_WORKER_ENABLED: 'false',
      AUTH_LOGIN_RATE_LIMIT_ENABLED: 'true',
      AUTH_TOKEN_PEPPER: 'database-integration-token-pepper',
      AUTH_LOGIN_RATE_LIMIT_NETWORK_ENABLED: 'false',
      AUTH_LOGIN_RATE_LIMIT_ACCOUNT_FAILURES: '2',
      AUTH_LOGIN_RATE_LIMIT_NETWORK_FAILURES: '100',
      FEISHU_DIRECTORY_SYNC_ENABLED: 'true',
      FEISHU_DIRECTORY_RECONCILE_REMOVALS: 'true',
      FEISHU_DIRECTORY_TARGET_TENANT_SLUG: 'admin-http-integration',
      FEISHU_APP_ID: 'cli_test_feishu_app',
      FEISHU_APP_SECRET: 'database-test-only-secret',
      FEISHU_SYNC_LEASE_MS: '900000',
    },
    stdio: 'inherit',
  },
);
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
