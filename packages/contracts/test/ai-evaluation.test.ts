import { describe, expect, it } from 'vitest';

import {
  aiEvaluationBadCaseSchema,
  aiEvaluationCaseSchema,
  aiEvaluationDatasetVersionSchema,
  aiEvaluationMetricResultSchema,
  aiEvaluationReadinessSchema,
  aiEvaluationRunListQuerySchema,
  aiEvaluationRunSchema,
  aiEvaluationRunnerListResponseSchema,
  annotateAiEvaluationCaseRequestSchema,
  createAiEvaluationRunnerRequestSchema,
  ingestAiEvaluationBadCaseRequestSchema,
  submitAiEvaluationRunRequestSchema,
} from '../src/ai-evaluation.js';

const ID = '10000000-0000-4000-8000-000000000001';
const ID2 = '10000000-0000-4000-8000-000000000002';
const ID3 = '10000000-0000-4000-8000-000000000003';
const ID4 = '10000000-0000-4000-8000-000000000004';
const HASH = 'a'.repeat(64);
const AT = '2026-07-28T00:00:00.000Z';

describe('AI evaluation governance contracts', () => {
  it('requires evidence for factual, citation and goal-alignment cases', () => {
    const result = aiEvaluationCaseSchema.safeParse({
      id: ID,
      tenantId: ID2,
      datasetVersionId: ID3,
      caseKey: 'FACT-001',
      category: 'FACTUALITY',
      input: 'What is the contractual delivery date?',
      context: {
        roleAssignmentId: null,
        roleVersionId: null,
        objectiveId: null,
        objectiveVersion: null,
        processVersionId: null,
        permissionLabels: [],
        knowledgeVersionIds: [],
        toolVersionIds: [],
        structuredContext: {},
      },
      expectedBehavior: 'Answer from the signed contract.',
      requiredEvidenceIds: [],
      forbiddenBehaviors: [],
      scoring: {
        judgeTypes: ['HUMAN'],
        rubric: 'The date must match the signed contract.',
        metricWeights: [{ metric: 'FACTUAL_ACCURACY', weight: 1 }],
      },
      sourceBadCaseId: null,
      contentHash: HASH,
      revision: 1,
      createdAt: AT,
    });
    expect(result.success).toBe(false);
  });

  it('requires complete annotation and independent evidence-backed review before approval', () => {
    const result = aiEvaluationDatasetVersionSchema.safeParse({
      id: ID,
      tenantId: ID2,
      datasetId: ID3,
      version: 1,
      revision: 3,
      status: 'APPROVED',
      description: 'Release regression set.',
      targets: {
        agentVersionIds: [ID4],
        knowledgeVersionIds: [],
        toolVersionIds: [],
        modelRoutes: [],
        promptHashes: [],
      },
      thresholds: [
        {
          metric: 'FACTUAL_ACCURACY',
          direction: 'AT_LEAST',
          threshold: 0.95,
          minimumSampleCount: 20,
          required: true,
        },
      ],
      requiredCategories: ['FACTUALITY'],
      caseCount: 20,
      annotationCoverage: 0.95,
      contentHash: HASH,
      submittedByUserId: ID,
      submittedAt: AT,
      reviewedByUserId: ID,
      reviewedAt: AT,
      reviewEvidenceIds: [],
      publishedByUserId: null,
      publishedAt: null,
      retiredAt: null,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(result.success).toBe(false);
  });

  it('derives metric pass from the threshold and minimum sample size', () => {
    expect(
      aiEvaluationMetricResultSchema.safeParse({
        metric: 'FACTUAL_ACCURACY',
        numerator: 19,
        denominator: 20,
        value: 0.95,
        threshold: 0.95,
        direction: 'AT_LEAST',
        sampleCount: 19,
        minimumSampleCount: 20,
        passed: true,
        evidenceIds: [ID],
      }).success,
    ).toBe(false);
  });

  it('does not trust a passing status without complete signed runner evidence', () => {
    const result = aiEvaluationRunSchema.safeParse({
      id: ID,
      tenantId: ID2,
      datasetVersionId: ID3,
      subjectType: 'AGENT_VERSION',
      subjectId: ID4,
      subjectVersion: 1,
      subjectSnapshotHash: HASH,
      status: 'PASSED',
      runnerId: ID,
      runnerName: 'sandbox-evaluator',
      runnerAttestationKeyFingerprint: HASH,
      externalRunId: 'external-1',
      expectedCaseCount: 20,
      submittedCaseCount: 20,
      evidenceBundleUri: null,
      evidenceBundleHash: null,
      runnerAttestation: null,
      metrics: [],
      revision: 4,
      startedAt: AT,
      submittedAt: AT,
      verifiedByUserId: ID2,
      verifiedAt: AT,
      finishedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate case results instead of allowing coverage inflation', () => {
    const request = {
      expectedRevision: 2,
      caseResults: [
        {
          caseId: ID,
          judgeType: 'EXTERNAL_RUNNER',
          passed: true,
          score: 1,
          actualBehaviorHash: HASH,
          evidenceIds: [ID2],
          detail: 'Matched.',
        },
        {
          caseId: ID,
          judgeType: 'EXTERNAL_RUNNER',
          passed: true,
          score: 1,
          actualBehaviorHash: HASH,
          evidenceIds: [ID3],
          detail: 'Duplicate.',
        },
      ],
      metrics: [
        {
          metric: 'FACTUAL_ACCURACY',
          numerator: 2,
          denominator: 2,
          value: 1,
          threshold: 0.95,
          direction: 'AT_LEAST',
          sampleCount: 2,
          minimumSampleCount: 2,
          passed: true,
          evidenceIds: [ID4],
        },
      ],
      evidenceBundleUri: 'https://evidence.invalid/bundle.json',
      evidenceBundleHash: HASH,
      runnerAttestation: 'Signed by the registered runner key.',
      idempotencyKey: 'submit-1',
    };
    expect(submitAiEvaluationRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it('keeps readiness blocked on snapshot mismatch even after a prior passing Run', () => {
    expect(
      aiEvaluationReadinessSchema.safeParse({
        subjectType: 'AGENT_VERSION',
        subjectId: ID,
        subjectVersion: 1,
        datasetVersionId: ID2,
        ready: true,
        passingRunId: ID3,
        evaluatedSnapshotHash: HASH,
        currentSnapshotHash: 'b'.repeat(64),
        blockers: [],
        checkedAt: AT,
      }).success,
    ).toBe(false);
  });

  it('requires evidence-backed decisive human annotations', () => {
    expect(
      annotateAiEvaluationCaseRequestSchema.safeParse({
        label: 'PASS',
        expectedScore: null,
        rationale: 'Looks right.',
        evidenceIds: [],
        expectedRevision: 0,
        idempotencyKey: 'annotation-1',
      }).success,
    ).toBe(false);
  });

  it('accepts only credential-free HTTPS origins for external runners', () => {
    const request = {
      name: 'signed-runner',
      attestationKeyFingerprint: HASH,
      allowedEvidenceOrigins: ['https://evidence.example.com/'],
      idempotencyKey: 'runner-1',
    };
    expect(createAiEvaluationRunnerRequestSchema.safeParse(request).success).toBe(true);
    expect(
      createAiEvaluationRunnerRequestSchema.safeParse({
        ...request,
        allowedEvidenceOrigins: ['https://user:secret@evidence.example.com/'],
      }).success,
    ).toBe(false);
    expect(
      createAiEvaluationRunnerRequestSchema.safeParse({
        ...request,
        allowedEvidenceOrigins: ['http://evidence.example.com/'],
      }).success,
    ).toBe(false);
    expect(
      createAiEvaluationRunnerRequestSchema.safeParse({
        ...request,
        allowedEvidenceOrigins: ['https://evidence.example.com'],
      }).success,
    ).toBe(false);
  });

  it('requires an exact all-or-none subject triple for server-side Run filtering', () => {
    expect(
      aiEvaluationRunListQuerySchema.safeParse({
        limit: 50,
        subjectType: 'AGENT_VERSION',
        subjectId: ID,
        subjectVersion: 2,
        status: 'PASSED',
      }).success,
    ).toBe(true);
    expect(
      aiEvaluationRunListQuerySchema.safeParse({
        limit: 50,
        subjectType: 'AGENT_VERSION',
        status: 'PASSED',
      }).success,
    ).toBe(false);
  });

  it('validates Runner list responses without credential material', () => {
    expect(
      aiEvaluationRunnerListResponseSchema.safeParse({
        items: [
          {
            id: ID,
            name: 'signed-runner',
            status: 'ACTIVE',
            attestationKeyFingerprint: HASH,
            allowedEvidenceOrigins: ['https://evidence.example.com/'],
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it('binds an automatic answer-feedback bad case to immutable Run and citation lineage', () => {
    expect(
      aiEvaluationBadCaseSchema.safeParse({
        id: ID,
        tenantId: ID2,
        sourceType: 'ANSWER_FEEDBACK',
        sourceId: ID3,
        sourceVersion: 1,
        category: 'CITATION',
        sanitizedInput: 'What is the approved delivery date?',
        sourceSnapshotHash: HASH,
        answerFeedbackSource: {
          feedbackId: ID3,
          conversationId: ID4,
          messageId: '10000000-0000-4000-8000-000000000005',
          inputMessageId: '10000000-0000-4000-8000-000000000006',
          agentRunId: '10000000-0000-4000-8000-000000000007',
          agentId: '10000000-0000-4000-8000-000000000008',
          agentVersionId: '10000000-0000-4000-8000-000000000009',
          reportedByUserId: ID,
          feedbackReason: 'IRRELEVANT_CITATION',
          feedbackRecordedAt: AT,
          promptSnapshotHash: 'b'.repeat(64),
          answerSnapshotHash: 'c'.repeat(64),
          citationsSnapshotHash: 'd'.repeat(64),
          citations: [
            {
              knowledgeBaseId: '10000000-0000-4000-8000-000000000010',
              documentId: '10000000-0000-4000-8000-000000000011',
              documentVersionId: '10000000-0000-4000-8000-000000000012',
              chunkId: '10000000-0000-4000-8000-000000000013',
            },
          ],
        },
        status: 'RECEIVED',
        mappedDatasetVersionId: null,
        mappedCaseId: null,
        reportedByUserId: ID,
        triagedByUserId: null,
        triageReason: null,
        revision: 1,
        createdAt: AT,
        updatedAt: AT,
      }).success,
    ).toBe(true);
  });

  it('reserves ANSWER_FEEDBACK ingestion for the trusted automatic projection', () => {
    expect(
      ingestAiEvaluationBadCaseRequestSchema.safeParse({
        sourceType: 'ANSWER_FEEDBACK',
        sourceId: ID,
        sourceVersion: 1,
        category: 'FACTUALITY',
        sanitizedInput: 'Forged feedback.',
        sourceSnapshotHash: HASH,
        evidenceIds: [ID2],
        idempotencyKey: 'forged-answer-feedback',
      }).success,
    ).toBe(false);
  });
});
