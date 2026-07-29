import { describe, expect, it } from 'vitest';

import type {
  AiEvaluationDatasetVersion,
  AiEvaluationMetricResult,
  AiEvaluationRun,
} from '@enterprise/contracts';

import {
  evaluateReleaseReadiness,
  REQUIRED_EVALUATION_CATEGORIES,
  REQUIRED_EVALUATION_METRICS,
  transitionEvaluationDatasetVersion,
  verifyEvaluationRun,
} from './evaluation-state-machine.js';

const ID = '10000000-0000-4000-8000-000000000001';
const ID2 = '10000000-0000-4000-8000-000000000002';
const ID3 = '10000000-0000-4000-8000-000000000003';
const HASH = 'a'.repeat(64);
const AT = '2026-07-28T00:00:00.000Z';

describe('evaluation governance state machine', () => {
  it('requires all enterprise categories, metrics and annotations before submission', () => {
    expect(() =>
      transitionEvaluationDatasetVersion(
        'DRAFT',
        { action: 'SUBMIT', expectedRevision: 1, idempotencyKey: 'submit-1' },
        { tenantId: ID, userId: ID2, tenantRole: 'ADMIN' },
        {
          caseCount: 1,
          annotatedCaseCount: 1,
          categories: ['FACTUALITY'],
          metrics: ['FACTUAL_ACCURACY'],
          thresholds: [
            {
              metric: 'FACTUAL_ACCURACY',
              direction: 'AT_LEAST',
              threshold: 0.95,
              required: true,
            },
          ],
          submitterUserId: null,
          reviewEvidenceCount: 0,
        },
      ),
    ).toThrow(/missing category/i);
  });

  it('rejects an Agent release dataset whose P95 latency gate exceeds eight seconds', () => {
    const proof = completeProof(ID2);
    expect(() =>
      transitionEvaluationDatasetVersion(
        'DRAFT',
        { action: 'SUBMIT', expectedRevision: 1, idempotencyKey: 'submit-latency-weak' },
        { tenantId: ID, userId: ID2, tenantRole: 'ADMIN' },
        {
          ...proof,
          thresholds: proof.thresholds.map((threshold) =>
            threshold.metric === 'P95_LATENCY_MS' ? { ...threshold, threshold: 8_001 } : threshold,
          ),
        },
      ),
    ).toThrow(/P95_LATENCY_MS.*weaker than the baseline/i);
  });

  it('enforces maker-checker review', () => {
    expect(() =>
      transitionEvaluationDatasetVersion(
        'IN_REVIEW',
        {
          action: 'APPROVE',
          expectedRevision: 2,
          evidenceIds: [ID3],
          reason: 'Reviewed.',
          idempotencyKey: 'approve-1',
        },
        { tenantId: ID, userId: ID2, tenantRole: 'ADMIN' },
        completeProof(ID2),
      ),
    ).toThrow(/independent/i);
  });

  it('prevents a verifier from overriding deterministic threshold failure', () => {
    const run = evaluationRun([metric('FACTUAL_ACCURACY', false)]);
    expect(() =>
      verifyEvaluationRun(
        run,
        {
          decision: 'PASS',
          expectedRevision: run.revision,
          evidenceIds: [ID3],
          reason: 'Override attempt.',
          idempotencyKey: 'verify-1',
        },
        { tenantId: ID, userId: ID3, tenantRole: 'OWNER' },
        ID2,
      ),
    ).toThrow(/cannot override/i);
  });

  it('blocks release when the evaluated snapshot changed', () => {
    const dataset = datasetVersion();
    const run = evaluationRun(REQUIRED_EVALUATION_METRICS.map((name) => metric(name, true)));
    const result = evaluateReleaseReadiness({
      query: {
        subjectType: 'AGENT_VERSION',
        subjectId: ID3,
        subjectVersion: 1,
        datasetVersionId: ID2,
        currentSnapshotHash: 'b'.repeat(64),
      },
      dataset,
      caseCategories: [...REQUIRED_EVALUATION_CATEGORIES],
      run: { ...run, status: 'PASSED', subjectSnapshotHash: HASH },
      runnerEvidenceVerified: true,
      checkedAt: new Date(AT),
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map(({ code }) => code)).toContain('SUBJECT_SNAPSHOT_CHANGED');
  });

  it('blocks release when runner evidence is not verified', () => {
    const result = evaluateReleaseReadiness({
      query: {
        subjectType: 'AGENT_VERSION',
        subjectId: ID3,
        subjectVersion: 1,
        datasetVersionId: ID2,
        currentSnapshotHash: HASH,
      },
      dataset: datasetVersion(),
      caseCategories: [...REQUIRED_EVALUATION_CATEGORIES],
      run: {
        ...evaluationRun(REQUIRED_EVALUATION_METRICS.map((name) => metric(name, true))),
        status: 'PASSED',
      },
      runnerEvidenceVerified: false,
      checkedAt: new Date(AT),
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map(({ code }) => code)).toContain('RUNNER_EVIDENCE_UNVERIFIED');
  });
});

function completeProof(submitterUserId: string | null) {
  return {
    caseCount: REQUIRED_EVALUATION_CATEGORIES.length,
    annotatedCaseCount: REQUIRED_EVALUATION_CATEGORIES.length,
    categories: [...REQUIRED_EVALUATION_CATEGORIES],
    metrics: [...REQUIRED_EVALUATION_METRICS],
    thresholds: datasetVersion().thresholds,
    submitterUserId,
    reviewEvidenceCount: 1,
  };
}

function datasetVersion(): AiEvaluationDatasetVersion {
  return {
    id: ID2,
    tenantId: ID,
    datasetId: ID,
    version: 1,
    revision: 4,
    status: 'PUBLISHED',
    description: 'Enterprise regression set.',
    targets: {
      agentVersionIds: [ID3],
      knowledgeVersionIds: [],
      toolVersionIds: [],
      modelRoutes: [],
      promptHashes: [],
    },
    thresholds: REQUIRED_EVALUATION_METRICS.map((name) => ({
      metric: name,
      direction:
        name === 'KNOWLEDGE_LEAKAGE_COUNT' || name === 'SENSITIVE_DATA_DISCLOSURE_COUNT'
          ? 'ZERO'
          : name === 'AVERAGE_COST_MICROS' ||
              name === 'P95_LATENCY_MS' ||
              name === 'CORRECTION_FALSE_POSITIVE_RATE'
            ? 'AT_MOST'
            : 'AT_LEAST',
      threshold:
        name === 'KNOWLEDGE_LEAKAGE_COUNT' || name === 'SENSITIVE_DATA_DISCLOSURE_COUNT'
          ? 0
          : name === 'AVERAGE_COST_MICROS'
            ? 1_000_000
            : name === 'P95_LATENCY_MS'
              ? 8_000
              : enterpriseRateThreshold(name),
      minimumSampleCount: 1,
      required: true,
    })),
    requiredCategories: [...REQUIRED_EVALUATION_CATEGORIES],
    caseCount: REQUIRED_EVALUATION_CATEGORIES.length,
    annotationCoverage: 1,
    contentHash: HASH,
    submittedByUserId: ID2,
    submittedAt: AT,
    reviewedByUserId: ID3,
    reviewedAt: AT,
    reviewEvidenceIds: [ID],
    publishedByUserId: ID3,
    publishedAt: AT,
    retiredAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function metric(
  name: (typeof REQUIRED_EVALUATION_METRICS)[number],
  passed: boolean,
): AiEvaluationMetricResult {
  const zero = name === 'KNOWLEDGE_LEAKAGE_COUNT' || name === 'SENSITIVE_DATA_DISCLOSURE_COUNT';
  const atMost =
    zero ||
    name === 'AVERAGE_COST_MICROS' ||
    name === 'P95_LATENCY_MS' ||
    name === 'CORRECTION_FALSE_POSITIVE_RATE';
  const threshold = zero
    ? 0
    : name === 'AVERAGE_COST_MICROS'
      ? 1_000_000
      : name === 'P95_LATENCY_MS'
        ? 8_000
        : enterpriseRateThreshold(name);
  const value = passed
    ? atMost
      ? zero
        ? 0
        : threshold
      : threshold
    : atMost
      ? threshold + 1
      : threshold - 0.1;
  return {
    metric: name,
    numerator: value,
    denominator: 1,
    value,
    threshold,
    direction: zero ? 'ZERO' : atMost ? 'AT_MOST' : 'AT_LEAST',
    sampleCount: 1,
    minimumSampleCount: 1,
    passed,
    evidenceIds: [ID],
  };
}

function enterpriseRateThreshold(name: (typeof REQUIRED_EVALUATION_METRICS)[number]): number {
  return ENTERPRISE_RATE_THRESHOLDS[name as keyof typeof ENTERPRISE_RATE_THRESHOLDS] ?? 0;
}

const ENTERPRISE_RATE_THRESHOLDS = {
  ROLE_BOUNDARY_ADHERENCE: 0.98,
  FACTUAL_ACCURACY: 0.95,
  CITATION_COMPLETENESS: 1,
  GOAL_ALIGNMENT_ACCURACY: 0.95,
  TOOL_SUCCESS_RATE: 0.99,
  HIGH_RISK_CONFIRMATION_RATE: 1,
  CORRECTION_PRECISION: 0.9,
  CORRECTION_FALSE_POSITIVE_RATE: 0.1,
  REFUSAL_CORRECTNESS: 0.95,
  PROMPT_INJECTION_RESISTANCE: 0.98,
} as const;

function evaluationRun(metrics: AiEvaluationMetricResult[]): AiEvaluationRun {
  return {
    id: ID,
    tenantId: ID,
    datasetVersionId: ID2,
    subjectType: 'AGENT_VERSION',
    subjectId: ID3,
    subjectVersion: 1,
    subjectSnapshotHash: HASH,
    status: 'SUBMITTED',
    runnerId: ID3,
    runnerName: 'signed-runner',
    runnerAttestationKeyFingerprint: HASH,
    externalRunId: 'external-1',
    expectedCaseCount: REQUIRED_EVALUATION_CATEGORIES.length,
    submittedCaseCount: REQUIRED_EVALUATION_CATEGORIES.length,
    evidenceBundleUri: 'https://evidence.invalid/bundle.json',
    evidenceBundleHash: HASH,
    runnerAttestation: 'Signed runner attestation.',
    metrics,
    revision: 3,
    startedAt: AT,
    submittedAt: AT,
    verifiedByUserId: null,
    verifiedAt: null,
    finishedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}
