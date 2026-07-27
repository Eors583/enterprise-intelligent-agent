import { defineConfig } from 'vitest/config';

const databaseTests = process.env.RUN_DATABASE_TESTS === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      REPOSITORY_DRIVER: databaseTests ? 'prisma' : 'memory',
      IM_OUTBOX_ENABLED: 'false',
      ALLOW_DEV_IDENTITY_HEADERS: 'true',
    },
    globals: true,
    hookTimeout: 60_000,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Database integration files own tenant fixtures and cleanup routines.
    // Running them in parallel can let one file delete another file's rows,
    // producing false negatives and occasionally testing the wrong state.
    fileParallelism: !databaseTests,
    sequence: { concurrent: false },
    testTimeout: 30_000,
  },
});
