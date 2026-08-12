import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MODULES_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULES_ROOT, '../../../../');
const TOOLS_ROOT = path.join(REPOSITORY_ROOT, 'tools');

const KNOWLEDGE_BOUNDARY_PREFIXES = [
  'knowledge-gateway/',
  'knowledge-graph-governance/',
  'knowledge-ingestion/',
  'knowledge-retrieval/',
  'knowledge-search-index/',
  'knowledge-semantic/',
] as const;

// These administration entry points are currently physically under admin but
// are owned by the knowledge boundary. Expanding this list requires an ADR.
const KNOWLEDGE_ADMINISTRATION_FILES = new Set([
  'admin/controlled-knowledge-source-fetcher.ts',
  'admin/knowledge-admin.controller.ts',
  'admin/knowledge-admin.module.ts',
  'admin/knowledge-admin.service.ts',
  'admin/knowledge-graph-readiness.ts',
  'admin/knowledge-readiness.ts',
  'admin/knowledge-source-sync.service.ts',
]);

const KNOWLEDGE_PRISMA_MODELS = [
  'knowledgeBase',
  'knowledgeEmbeddingIndexVersion',
  'knowledgeBaseOrgUnit',
  'knowledgeDocument',
  'knowledgeDocumentVersion',
  'knowledgeSourceConnector',
  'knowledgeSourceItem',
  'knowledgeSourceSyncRun',
  'knowledgeParentChunk',
  'knowledgeChunk',
  'knowledgeChunkEmbedding',
  'knowledgeIngestionJob',
  'knowledgeEntity',
  'knowledgeEntityMention',
  'knowledgeRelation',
  'knowledgeRelationEvidence',
  'knowledgeGraphProjection',
  'knowledgeOntology',
  'knowledgeOntologyVersion',
  'knowledgeOntologyEntityType',
  'knowledgeOntologyPredicate',
  'knowledgeGraphCorrection',
  'knowledgeGraphConflict',
  'knowledgeEntityMerge',
  'knowledgeEntityAlias',
  'knowledgeEntitySourceIdentity',
  'knowledgeRelationGovernance',
  'knowledgeGraphCommand',
] as const;

const DIRECT_INTERNAL_IMPORT =
  /(?:knowledge-ingestion|knowledge-retrieval|knowledge-search-index|knowledge-semantic|knowledge-graph-governance)\//u;
const DIRECT_KNOWLEDGE_TABLE = new RegExp(
  `\\.(?:${KNOWLEDGE_PRISMA_MODELS.join('|')})\\.(?:find|count|aggregate|groupBy|create|update|delete|upsert)`,
  'u',
);
const RAW_KNOWLEDGE_SQL =
  /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?["']?knowledge_[a-z0-9_]+/iu;
const DIRECT_INFRASTRUCTURE =
  /KNOWLEDGE_QDRANT_(?:URL|API_KEY|COLLECTION)|\/collections\/|\b(?:KnowledgeObjectStore|LocalKnowledgeObjectStore|S3KnowledgeObjectStore)\b/u;

describe('knowledge independent business boundary', () => {
  it('blocks production modules from bypassing Knowledge Gateway', async () => {
    const files = await listFiles(MODULES_ROOT, (file) => file.endsWith('.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const relative = normalize(path.relative(MODULES_ROOT, file));
      if (
        relative.endsWith('.spec.ts') ||
        relative.endsWith('.test.ts') ||
        isKnowledgeBoundaryOwned(relative)
      ) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      recordViolation(violations, relative, source, DIRECT_INTERNAL_IMPORT, 'internal import');
      recordViolation(violations, relative, source, DIRECT_KNOWLEDGE_TABLE, 'Prisma table access');
      recordViolation(violations, relative, source, RAW_KNOWLEDGE_SQL, 'raw knowledge SQL');
      recordViolation(
        violations,
        relative,
        source,
        DIRECT_INFRASTRUCTURE,
        'Qdrant/object-store access',
      );
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('keeps the public Gateway contract transport and implementation neutral', async () => {
    const source = await readFile(
      path.join(MODULES_ROOT, 'knowledge-gateway/knowledge-gateway.port.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /\.\.\/knowledge-(?:ingestion|retrieval|search-index|semantic|graph-governance)\//u,
    );
    expect(source).not.toMatch(/@prisma\/client|Prisma\.|TransactionClient/u);
    expect(source).not.toMatch(DIRECT_INFRASTRUCTURE);
  });

  it('keeps external smoke tools on public APIs instead of storage internals', async () => {
    const smokeRoot = path.join(TOOLS_ROOT, 'knowledge-smoke');
    const files = await listFiles(smokeRoot, (file) => /\.(?:mjs|cjs|js|ts)$/u.test(file));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      recordViolation(
        violations,
        normalize(path.relative(REPOSITORY_ROOT, file)),
        source,
        DIRECT_INFRASTRUCTURE,
        'direct infrastructure access',
      );
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

function isKnowledgeBoundaryOwned(relative: string): boolean {
  return (
    KNOWLEDGE_BOUNDARY_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    KNOWLEDGE_ADMINISTRATION_FILES.has(relative)
  );
}

async function listFiles(root: string, include: (file: string) => boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) return listFiles(absolute, include);
      return include(absolute) ? [absolute] : [];
    }),
  );
  return files.flat();
}

function recordViolation(
  violations: string[],
  relative: string,
  source: string,
  pattern: RegExp,
  rule: string,
): void {
  const match = pattern.exec(source);
  if (match?.index === undefined) return;
  const line = source.slice(0, match.index).split(/\r?\n/u).length;
  violations.push(`${relative}:${line} bypasses Knowledge Gateway (${rule})`);
}

function normalize(value: string): string {
  return value.replaceAll('\\', '/');
}
