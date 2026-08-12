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
      // Tests must not inherit the developer machine's live knowledge adapters.
      // Database integration tests exercise persistence explicitly; the separate
      // knowledge smoke test owns MinIO, Docling, Qdrant and AI Runtime coverage.
      KNOWLEDGE_PERSISTENT_WRITES_ENABLED: databaseTests ? 'true' : 'false',
      KNOWLEDGE_INGESTION_WORKER_ENABLED: 'false',
      KNOWLEDGE_SEMANTIC_SEARCH_ENABLED: 'false',
      KNOWLEDGE_RERANK_ENABLED: 'false',
      KNOWLEDGE_SEARCH_INDEX_DRIVER: 'postgres',
      KNOWLEDGE_OBJECT_STORE_DRIVER: 'local',
      KNOWLEDGE_FILE_SCANNER_DRIVER: 'disabled',
      KNOWLEDGE_DOCUMENT_PARSER_DRIVER: 'local',
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
