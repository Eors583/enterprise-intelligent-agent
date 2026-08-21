import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const benchmarkMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260805000400_ai_knowledge_retrieval_benchmarks/migration.sql',
  ),
  'utf8',
);
const profileMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260805000500_ai_retrieval_evaluation_profile/migration.sql',
  ),
  'utf8',
);
const progressMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260805000600_ai_retrieval_benchmark_progress/migration.sql',
  ),
  'utf8',
);
const service = readFileSync(
  resolve(process.cwd(), 'src/modules/ai-evaluation/knowledge-retrieval-benchmark.service.ts'),
  'utf8',
);

describe('knowledge retrieval benchmark foundation', () => {
  it('persists immutable tenant-scoped runs with audit and outbox side effects', () => {
    expect(benchmarkMigration).toContain(
      'CREATE TABLE public."ai_knowledge_retrieval_benchmark_runs"',
    );
    expect(benchmarkMigration).toContain(
      'ALTER TABLE public."ai_knowledge_retrieval_benchmark_runs" FORCE ROW LEVEL SECURITY',
    );
    expect(benchmarkMigration).toContain('ai_knowledge_retrieval_benchmark_tenant_isolation');
    expect(benchmarkMigration).toContain('guard_ai_knowledge_retrieval_benchmark_run');
    expect(benchmarkMigration).toContain('ai_evaluation_append_side_effects');
  });

  it('exposes monotonic progress while preserving immutable terminal results', () => {
    expect(progressMigration).toContain('ADD COLUMN "processed_case_count"');
    expect(progressMigration).toContain('ADD COLUMN "total_case_count"');
    expect(progressMigration).toContain('A running benchmark may only advance its progress.');
    expect(progressMigration).toContain(
      'Completed Knowledge Retrieval Benchmark Runs are immutable.',
    );
    expect(progressMigration).toContain('AFTER INSERT OR UPDATE OF "status"');
  });

  it('keeps the dedicated retrieval profile governed without requiring unrelated agent categories', () => {
    expect(profileMigration).toContain('retrieval_profile boolean');
    expect(profileMigration).toContain('jsonb_array_length(NEW."required_categories") = 1');
    expect(profileMigration).toContain('RETRIEVAL_RECALL_AT_5');
    expect(profileMigration).toContain('RETRIEVAL_MRR');
    expect(profileMigration).toContain('RETRIEVAL_NDCG_AT_10');
    expect(profileMigration).toContain('CITATION_SUPPORT_RATE');
    expect(profileMigration).toContain('ai_evaluation_dataset_seal_review_evidence');
  });

  it('executes the production retrieval service and scores chunk identities', () => {
    expect(service).toContain('await this.retrieval.search({');
    expect(service).toContain('response.items.map(({ chunkId }) => chunkId)');
    expect(service).toContain('recallAtK(retrievedChunkIds, relevant, 5)');
    expect(service).toContain('reciprocalRank(retrievedChunkIds, relevant)');
    expect(service).toContain('ndcgAtK(retrievedChunkIds, relevant, 10)');
    expect(service).toContain('collectAclEvents(groundTruth, response)');
    expect(service).toContain('ORDER BY "created_at" DESC, "id" DESC');
    expect(service).not.toContain('expectedAnswer.includes');
  });
});
