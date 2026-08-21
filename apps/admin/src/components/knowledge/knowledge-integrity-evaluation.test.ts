import {
  createAiEvaluationCaseRequestSchema,
  createAiEvaluationDatasetVersionRequestSchema,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

import {
  buildKnowledgeIntegrityCases,
  buildKnowledgeIntegrityVersionRequest,
  KNOWLEDGE_INTEGRITY_REQUIRED_CATEGORIES,
  KNOWLEDGE_INTEGRITY_THRESHOLDS,
} from './knowledge-integrity-evaluation';

const VERSION_ID = '00000000-0000-7000-8000-000000000201';
const EVIDENCE_ID = '00000000-0000-7000-8000-000000000901';

describe('knowledge integrity evaluation blueprint', () => {
  it('creates a governed enterprise dataset bound to the exact knowledge candidate', () => {
    const request = buildKnowledgeIntegrityVersionRequest({
      documentTitle: '员工制度',
      version: version(),
    });

    expect(createAiEvaluationDatasetVersionRequestSchema.parse(request)).toEqual(request);
    expect(request.targets.knowledgeVersionIds).toEqual([VERSION_ID]);
    expect(request.requiredCategories).toEqual(KNOWLEDGE_INTEGRITY_REQUIRED_CATEGORIES);
    expect(new Set(request.thresholds.map(({ metric }) => metric)).size).toBe(14);
    expect(request.thresholds).toEqual(KNOWLEDGE_INTEGRITY_THRESHOLDS);
  });

  it('covers chunk, citation, permission-negative, no-answer and retrieval-chain probes', () => {
    const cases = buildKnowledgeIntegrityCases({
      documentVersionId: VERSION_ID,
      excerpt: '企业知识引用必须绑定具体文档版本和切片。',
      evidenceIds: [EVIDENCE_ID],
    });
    const parsed = cases.map((item) => createAiEvaluationCaseRequestSchema.parse(item));
    const probes = new Set(
      parsed.map(({ context }) => context.structuredContext.integrityProbe as string),
    );
    const metrics = parsed.flatMap(({ scoring }) =>
      scoring.metricWeights.map(({ metric }) => metric),
    );

    expect(parsed).toHaveLength(9);
    expect(probes).toEqual(
      new Set([
        'CHUNK_PRESENCE',
        'CITATION_CHAIN',
        'PERMISSION_NEGATIVE',
        'NO_ANSWER',
        'RETRIEVAL_CHAIN',
        'TOOL_BOUNDARY',
        'CORRECTION_PATH',
        'SAFETY_BOUNDARY',
        'COST_LATENCY',
      ]),
    );
    expect(new Set(metrics).size).toBe(14);
    expect(parsed.every(({ requiredEvidenceIds }) => requiredEvidenceIds[0] === EVIDENCE_ID)).toBe(
      true,
    );
    expect(
      parsed.find(
        ({ context }) => context.structuredContext.integrityProbe === 'PERMISSION_NEGATIVE',
      )?.context.permissionLabels,
    ).toContain('__SYSTEM_INTEGRITY_DENY__');
  });
});

function version() {
  return {
    id: VERSION_ID,
    versionNumber: 2,
    sourceType: 'FILE' as const,
    mimeType: 'application/pdf',
    fileName: 'policy.pdf',
    checksum: 'a'.repeat(64),
    status: 'READY' as const,
    changeSummary: null,
    chunkCount: 3,
    createdAt: '2026-07-29T00:00:00.000Z',
    publishedAt: null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    sourceUri: null,
    parserName: 'pdf-v1',
    parseQualityScore: 1,
    parseReviewStatus: 'APPROVED' as const,
    parseReviewRevision: 2,
    parseReviewedById: '00000000-0000-7000-8000-000000000902',
    parseReviewedAt: '2026-07-29T00:10:00.000Z',
    parseReviewNote: '通过',
    parseDiagnostics: {},
    governance: testKnowledgeGovernance({ reviewStatus: 'APPROVED' }),
    ingestionJob: null,
  };
}
