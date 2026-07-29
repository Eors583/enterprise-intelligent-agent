import type {
  AiEvaluationRun,
  KnowledgeBaseIndexReadiness,
  KnowledgeDocumentSummary,
  KnowledgeDocumentVersionSummary,
} from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import { testKnowledgeGovernance } from '@/test/knowledge-fixtures';

import {
  deriveKnowledgePublicationJourney,
  isEnterpriseSemanticReady,
} from './knowledge-publication-journey';

describe('knowledge publication journey', () => {
  it('makes parse review the next explicit step for a ready uploaded candidate', () => {
    const candidate = version({
      sourceType: 'FILE',
      parseReviewStatus: 'PENDING',
    });
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate),
      version: candidate,
      runs: [],
      readiness: lexicalReadiness(),
    });

    expect(journey.stages.map(({ label }) => label)).toEqual([
      '解析',
      '解析审核',
      '治理审核',
      '系统评测',
      '独立复核',
      '发布',
      '索引就绪',
    ]);
    expect(journey.stages[0]?.state).toBe('COMPLETE');
    expect(journey.stages[1]?.state).toBe('CURRENT');
    expect(journey.nextAction).toBe('OPEN_PARSE_REVIEW');
  });

  it('requires independent review after the trusted runner submits results', () => {
    const candidate = version();
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate),
      version: candidate,
      runs: [run({ status: 'SUBMITTED' })],
      readiness: lexicalReadiness(),
    });

    expect(journey.stages[3]?.state).toBe('COMPLETE');
    expect(journey.stages[4]?.state).toBe('CURRENT');
    expect(journey.nextAction).toBe('OPEN_REVIEW');
  });

  it('does not call a published lexical-only version enterprise ready', () => {
    const candidate = version({ publishedAt: '2026-07-29T02:00:00.000Z' });
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate, candidate.id),
      version: candidate,
      runs: [run()],
      readiness: lexicalReadiness(),
    });

    expect(journey.stages.slice(0, 6).every(({ state }) => state === 'COMPLETE')).toBe(true);
    expect(journey.stages[6]?.state).toBe('BLOCKED');
    expect(journey.semanticReady).toBe(false);
    expect(journey.semanticBlocker).toContain('Embedding');
    expect(journey.nextAction).toBe('REBUILD_INDEX');
  });

  it('finishes only with real hybrid coverage and a ready reranker', () => {
    const candidate = version({ publishedAt: '2026-07-29T02:00:00.000Z' });
    const readiness = lexicalReadiness({
      semanticCoverage: 1,
      embeddedChunkCount: 2,
      retrievalMode: 'HYBRID',
      activationAllowed: true,
      activationBlockers: [],
      degradedReason: null,
      embedding: {
        status: 'READY',
        provider: 'openai_compatible',
        model: 'embedding-model',
        dimensions: 1536,
      },
      rerank: {
        status: 'READY',
        provider: 'cohere_compatible',
        model: 'rerank-model',
        dimensions: null,
      },
    });
    const journey = deriveKnowledgePublicationJourney({
      document: document(candidate, candidate.id),
      version: candidate,
      runs: [run()],
      readiness,
    });

    expect(isEnterpriseSemanticReady(readiness)).toBe(true);
    expect(journey.stages.every(({ state }) => state === 'COMPLETE')).toBe(true);
    expect(journey.nextAction).toBe('NONE');
    expect(journey.nextActionLabel).toBeNull();
  });
});

function version(
  overrides: Partial<KnowledgeDocumentVersionSummary> = {},
): KnowledgeDocumentVersionSummary {
  return {
    id: '00000000-0000-7000-8000-000000000201',
    versionNumber: 2,
    sourceType: 'MARKDOWN',
    mimeType: 'text/markdown',
    fileName: null,
    checksum: 'a'.repeat(64),
    status: 'READY',
    changeSummary: null,
    chunkCount: 2,
    createdAt: '2026-07-29T00:00:00.000Z',
    publishedAt: null,
    evaluationRunId: null,
    evaluationDatasetVersionId: null,
    evaluationSnapshotHash: null,
    sourceUri: null,
    parserName: 'markdown-v1',
    parseQualityScore: 1,
    parseReviewStatus: 'NOT_REQUIRED',
    parseReviewRevision: 1,
    parseReviewedById: null,
    parseReviewedAt: null,
    parseReviewNote: null,
    parseDiagnostics: {},
    governance: testKnowledgeGovernance({ reviewStatus: 'APPROVED' }),
    ingestionJob: null,
    ...overrides,
  };
}

function document(
  candidate: KnowledgeDocumentVersionSummary,
  currentVersionId: string | null = null,
): KnowledgeDocumentSummary {
  return {
    id: '00000000-0000-7000-8000-000000000101',
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    title: '员工制度',
    sourceType: candidate.sourceType,
    mimeType: candidate.mimeType,
    fileName: candidate.fileName,
    checksum: candidate.checksum,
    status: currentVersionId === null ? 'DRAFT' : 'READY',
    documentVersion: candidate.versionNumber,
    currentVersionId,
    versions: [candidate],
    updatedAt: '2026-07-29T02:00:00.000Z',
  };
}

function run(overrides: Partial<AiEvaluationRun> = {}): AiEvaluationRun {
  return {
    id: '00000000-0000-7000-8000-000000000301',
    tenantId: '00000000-0000-7000-8000-000000000001',
    datasetVersionId: '00000000-0000-7000-8000-000000000401',
    subjectType: 'KNOWLEDGE_VERSION',
    subjectId: '00000000-0000-7000-8000-000000000201',
    subjectVersion: 2,
    subjectSnapshotHash: 'b'.repeat(64),
    status: 'PASSED',
    runnerId: '00000000-0000-7000-8000-000000000501',
    runnerName: 'trusted-runtime',
    runnerAttestationKeyFingerprint: 'c'.repeat(64),
    externalRunId: 'knowledge-integrity-run',
    expectedCaseCount: 9,
    submittedCaseCount: 9,
    evidenceBundleUri: 'https://evidence.example.test/run.json',
    evidenceBundleHash: 'd'.repeat(64),
    runnerAttestation: 'HMAC-SHA256 signed attestation',
    metrics: [],
    revision: 3,
    startedAt: '2026-07-29T01:00:00.000Z',
    submittedAt: '2026-07-29T01:01:00.000Z',
    verifiedByUserId: '00000000-0000-7000-8000-000000000601',
    verifiedAt: '2026-07-29T01:02:00.000Z',
    finishedAt: '2026-07-29T01:02:00.000Z',
    createdAt: '2026-07-29T01:00:00.000Z',
    updatedAt: '2026-07-29T01:02:00.000Z',
    ...overrides,
  };
}

function lexicalReadiness(
  overrides: Partial<KnowledgeBaseIndexReadiness> = {},
): KnowledgeBaseIndexReadiness {
  return {
    knowledgeBaseId: '00000000-0000-7000-8000-000000000001',
    documents: {
      total: 1,
      ready: 1,
      failed: 0,
      processing: 0,
      draft: 0,
      archived: 0,
    },
    publishedChunkCount: 2,
    embeddedChunkCount: 0,
    semanticCoverage: 0,
    embedding: {
      status: 'DISABLED',
      provider: 'disabled',
      model: null,
      dimensions: 1536,
    },
    rerank: {
      status: 'DISABLED',
      provider: 'disabled',
      model: null,
      dimensions: null,
    },
    retrievalMode: 'LEXICAL',
    degradedReason: 'EMBEDDING_DISABLED',
    activationAllowed: false,
    activationBlockers: ['EMBEDDING_DISABLED', 'RERANK_DISABLED'],
    ...overrides,
  };
}
