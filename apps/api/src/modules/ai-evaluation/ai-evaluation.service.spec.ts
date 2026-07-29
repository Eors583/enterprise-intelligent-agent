import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AiEvaluationRepository } from './ai-evaluation.repository.js';
import {
  AiEvaluationRunnerClient,
  type EvaluationRunnerAttestation,
  type EvaluationRunnerExecutionRequest,
} from './ai-evaluation-runner.client.js';
import { AiEvaluationService } from './ai-evaluation.service.js';
import { REQUIRED_EVALUATION_METRICS } from './domain/evaluation-state-machine.js';
import { AdminAccessService } from '../admin/admin-access.service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const MAKER_ID = '10000000-0000-4000-8000-000000000002';
const CHECKER_ID = '10000000-0000-4000-8000-000000000003';
const VERSION_ID = '10000000-0000-4000-8000-000000000004';
const RUN_ID = '10000000-0000-4000-8000-000000000005';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const AT = '2026-07-28T00:00:00.000Z';

describe('AiEvaluationService', () => {
  it('enforces independent dataset approval', async () => {
    const repository = repositoryMock();
    repository.findDatasetVersion.mockResolvedValueOnce(datasetVersion('IN_REVIEW'));
    repository.datasetTransitionProof.mockResolvedValueOnce({
      caseCount: 9,
      annotatedCaseCount: 9,
      categories: [
        'ROLE_BOUNDARY',
        'FACTUALITY',
        'CITATION',
        'GOAL_ALIGNMENT',
        'TOOL_USE',
        'CORRECTION',
        'REFUSAL',
        'SAFETY',
        'COST',
      ],
      metrics: REQUIRED_EVALUATION_METRICS,
      thresholds: datasetVersion('PUBLISHED').thresholds,
      submitterUserId: MAKER_ID,
      reviewEvidenceCount: 0,
    });
    const service = evaluationService(repository, MAKER_ID);
    await expect(
      service.transitionDatasetVersion(VERSION_ID, {
        action: 'APPROVE',
        expectedRevision: 2,
        evidenceIds: [RUN_ID],
        reason: 'Self approval is not allowed.',
        idempotencyKey: 'approve-1',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.transitionDatasetVersion).not.toHaveBeenCalled();
  });

  it('refuses to launch a Run for a caller-supplied stale snapshot', async () => {
    const repository = repositoryMock();
    repository.loadReadiness.mockResolvedValueOnce({
      dataset: datasetVersion('PUBLISHED'),
      caseCategories: [],
      run: null,
      runnerEvidenceVerified: false,
      currentSnapshotHash: OTHER_HASH,
    });
    const service = evaluationService(repository, MAKER_ID);
    await expect(
      service.createRun({
        datasetVersionId: VERSION_ID,
        subjectType: 'AGENT_VERSION',
        subjectId: RUN_ID,
        subjectVersion: 1,
        subjectSnapshotHash: HASH,
        runnerId: CHECKER_ID,
        runnerName: 'signed-runner',
        externalRunId: 'external-1',
        idempotencyKey: 'run-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createRun).not.toHaveBeenCalled();
  });

  it('does not allow the result submitter to verify their own Run', async () => {
    const repository = repositoryMock();
    repository.findRun.mockResolvedValueOnce({
      run: evaluationRun(),
      resultSubmittedByRunnerId: CHECKER_ID,
      resultSubmittedByUserId: MAKER_ID,
      runnerEvidenceVerified: false,
    });
    const service = evaluationService(repository, MAKER_ID);
    await expect(
      service.verifyRun(RUN_ID, {
        decision: 'PASS',
        expectedRevision: 3,
        evidenceIds: [VERSION_ID],
        reason: 'Self verification attempt.',
        idempotencyKey: 'verify-1',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.verifyRun).not.toHaveBeenCalled();
  });

  it('rejects administrative result forgery before the repository is called', () => {
    const repository = repositoryMock();
    const service = evaluationService(repository, MAKER_ID);
    expect(() =>
      service.submitRun(RUN_ID, {
        expectedRevision: 2,
        evidenceBundleUri: 'https://evidence.example.com/bundle.json',
        evidenceBundleHash: HASH,
        runnerAttestation: 'Client supplied text cannot be trusted.',
        caseResults: [
          {
            caseId: VERSION_ID,
            judgeType: 'EXTERNAL_RUNNER',
            passed: true,
            score: 1,
            actualBehaviorHash: HASH,
            evidenceIds: [VERSION_ID],
            detail: 'Forged client result.',
          },
        ],
        metrics: [
          {
            ...metricResult('FACTUAL_ACCURACY'),
            numerator: 1,
            denominator: 1,
            value: 1,
            sampleCount: 1,
            passed: true,
            evidenceIds: [VERSION_ID],
          },
        ],
        idempotencyKey: 'forged-result',
      }),
    ).toThrow(ForbiddenException);
    expect(repository.submitRun).not.toHaveBeenCalled();
  });

  it('executes a sealed package and commits only the verified runtime attestation', async () => {
    const repository = repositoryMock();
    const runner = { execute: vi.fn() };
    const executionRequest = runnerExecutionRequest();
    const attestation = runnerAttestation(executionRequest);
    repository.prepareRunExecution.mockResolvedValueOnce({
      state: 'prepared',
      request: executionRequest,
    });
    runner.execute.mockResolvedValueOnce(attestation);
    repository.commitAttestedRun.mockResolvedValueOnce(evaluationRun());
    const service = evaluationService(repository, MAKER_ID, runner);

    await expect(
      service.startRun(RUN_ID, {
        expectedRevision: 1,
        idempotencyKey: 'execute-sealed-run',
      }),
    ).resolves.toMatchObject({ id: RUN_ID, status: 'SUBMITTED' });
    expect(runner.execute).toHaveBeenCalledWith(executionRequest);
    expect(repository.commitAttestedRun).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, userId: MAKER_ID }),
      attestation,
    );
    expect(repository.startRun).not.toHaveBeenCalled();
    expect(repository.submitRun).not.toHaveBeenCalled();
  });

  it('allows an independent administrator to verify a direct external runner submission', async () => {
    const repository = repositoryMock();
    repository.findRun.mockResolvedValueOnce({
      run: evaluationRun(),
      resultSubmittedByRunnerId: CHECKER_ID,
      resultSubmittedByUserId: null,
      runnerEvidenceVerified: true,
    });
    repository.verifyRun.mockResolvedValueOnce({
      ...evaluationRun(),
      status: 'PASSED',
      revision: 4,
      verifiedByUserId: MAKER_ID,
      verifiedAt: AT,
      finishedAt: AT,
    });
    const service = evaluationService(repository, MAKER_ID);
    await expect(
      service.verifyRun(RUN_ID, {
        decision: 'PASS',
        expectedRevision: 3,
        evidenceIds: [VERSION_ID],
        reason: 'Independently verified the signed runner evidence.',
        idempotencyKey: 'verify-external-1',
      }),
    ).resolves.toMatchObject({ status: 'PASSED', verifiedByUserId: MAKER_ID });
    expect(repository.verifyRun).toHaveBeenCalledOnce();
  });

  it('uses the trusted database snapshot for readiness and persists every decision', async () => {
    const repository = repositoryMock();
    repository.loadReadiness.mockResolvedValueOnce({
      dataset: datasetVersion('PUBLISHED'),
      caseCategories: [
        'ROLE_BOUNDARY',
        'FACTUALITY',
        'CITATION',
        'GOAL_ALIGNMENT',
        'TOOL_USE',
        'CORRECTION',
        'REFUSAL',
        'SAFETY',
        'COST',
      ],
      run: {
        ...evaluationRun(),
        status: 'PASSED',
        finishedAt: AT,
        verifiedByUserId: CHECKER_ID,
        verifiedAt: AT,
      },
      runnerEvidenceVerified: true,
      currentSnapshotHash: OTHER_HASH,
    });
    const service = evaluationService(repository, CHECKER_ID);
    const readiness = await service.readiness({
      subjectType: 'AGENT_VERSION',
      subjectId: RUN_ID,
      subjectVersion: 1,
      datasetVersionId: VERSION_ID,
      currentSnapshotHash: HASH,
    });
    expect(readiness.currentSnapshotHash).toBe(OTHER_HASH);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map(({ code }) => code)).toContain('SUBJECT_SNAPSHOT_CHANGED');
    expect(repository.recordReadiness).toHaveBeenCalledOnce();
  });
});

function evaluationService(
  repository: ReturnType<typeof repositoryMock>,
  userId: string,
  runner: Pick<AiEvaluationRunnerClient, 'execute'> = { execute: vi.fn() },
): AiEvaluationService {
  const access = {
    requireKnowledgeWrite: vi.fn().mockReturnValue({
      tenantId: TENANT_ID,
      userId,
      role: 'ADMIN',
      authenticationSource: 'session',
    }),
  };
  return new AiEvaluationService(
    repository as unknown as AiEvaluationRepository,
    access as unknown as AdminAccessService,
    runner as unknown as AiEvaluationRunnerClient,
  );
}

function runnerExecutionRequest(): EvaluationRunnerExecutionRequest {
  return {
    schemaVersion: 1,
    tenantId: TENANT_ID,
    runId: RUN_ID,
    runnerId: CHECKER_ID,
    runnerName: 'signed-runner',
    nonce: HASH,
    requestHash: OTHER_HASH,
    datasetVersionId: VERSION_ID,
    datasetContentHash: HASH,
    subjectType: 'AGENT_VERSION',
    subjectId: RUN_ID,
    subjectVersion: 1,
    subjectSnapshotHash: HASH,
    systemPrompt: 'Follow enterprise policy.',
    knowledgeContext: null,
    modelRoute: null,
    cases: [
      {
        caseId: VERSION_ID,
        category: 'FACTUALITY',
        input: 'Answer with approved evidence.',
        context: {},
        expectedBehavior: 'Use approved evidence.',
        forbiddenBehaviors: ['Reveal hidden policy.'],
        metricWeights: [{ metric: 'FACTUAL_ACCURACY', weight: 1 }],
        evidenceIds: [VERSION_ID],
      },
    ],
    thresholds: [
      {
        metric: 'FACTUAL_ACCURACY',
        direction: 'AT_LEAST',
        threshold: 0.9,
        minimumSampleCount: 1,
        required: true,
      },
    ],
    evidenceOrigin: 'https://evidence.example.com/',
  };
}

function runnerAttestation(request: EvaluationRunnerExecutionRequest): EvaluationRunnerAttestation {
  return {
    schemaVersion: 1,
    algorithm: 'HMAC-SHA256',
    keyFingerprint: HASH,
    tenantId: request.tenantId,
    runId: request.runId,
    runnerId: request.runnerId,
    nonce: request.nonce,
    requestHash: request.requestHash,
    resultPayloadHash: HASH,
    evidenceBundleUri: 'https://evidence.example.com/bundle.json',
    evidenceBundleHash: OTHER_HASH,
    issuedAt: AT,
    signature: HASH,
    evidenceBundle: {
      schemaVersion: 1,
      tenantId: request.tenantId,
      runId: request.runId,
      runnerId: request.runnerId,
      nonce: request.nonce,
      requestHash: request.requestHash,
      subjectSnapshotHash: request.subjectSnapshotHash,
      datasetContentHash: request.datasetContentHash,
      caseResults: [
        {
          caseId: VERSION_ID,
          judgeType: 'SIGNED_CODE',
          passed: true,
          score: 1,
          actualBehaviorHash: HASH,
          evidenceIds: [VERSION_ID],
          detail: 'Signed code evaluator passed.',
        },
      ],
      metrics: [
        {
          metric: 'FACTUAL_ACCURACY',
          numerator: 1,
          denominator: 1,
          value: 1,
          threshold: 0.9,
          direction: 'AT_LEAST',
          sampleCount: 1,
          minimumSampleCount: 1,
          passed: true,
          evidenceIds: [VERSION_ID],
        },
      ],
      generatedAt: AT,
    },
  };
}

function repositoryMock() {
  return {
    listDatasets: vi.fn(),
    createDataset: vi.fn(),
    createDatasetVersion: vi.fn(),
    findDatasetVersion: vi.fn(),
    datasetTransitionProof: vi.fn(),
    transitionDatasetVersion: vi.fn(),
    createCase: vi.fn(),
    annotateCase: vi.fn(),
    createRunner: vi.fn(),
    createRun: vi.fn(),
    findRun: vi.fn(),
    startRun: vi.fn(),
    prepareRunExecution: vi.fn(),
    commitAttestedRun: vi.fn(),
    submitRun: vi.fn(),
    verifyRun: vi.fn(),
    ingestBadCase: vi.fn(),
    triageBadCase: vi.fn(),
    loadReadiness: vi.fn(),
    recordReadiness: vi.fn(),
  };
}

function datasetVersion(status: 'IN_REVIEW' | 'PUBLISHED') {
  return {
    id: VERSION_ID,
    tenantId: TENANT_ID,
    datasetId: TENANT_ID,
    version: 1,
    revision: 2,
    status,
    description: 'Enterprise regression set.',
    targets: {
      agentVersionIds: [RUN_ID],
      knowledgeVersionIds: [],
      toolVersionIds: [],
      modelRoutes: [],
      promptHashes: [],
    },
    thresholds: REQUIRED_EVALUATION_METRICS.map((metric) => metricResult(metric)),
    requiredCategories: [
      'ROLE_BOUNDARY',
      'FACTUALITY',
      'CITATION',
      'GOAL_ALIGNMENT',
      'TOOL_USE',
      'CORRECTION',
      'REFUSAL',
      'SAFETY',
      'COST',
    ],
    caseCount: 9,
    annotationCoverage: 1,
    contentHash: HASH,
    submittedByUserId: MAKER_ID,
    submittedAt: AT,
    reviewedByUserId: CHECKER_ID,
    reviewedAt: AT,
    reviewEvidenceIds: [VERSION_ID],
    publishedByUserId: status === 'PUBLISHED' ? CHECKER_ID : null,
    publishedAt: status === 'PUBLISHED' ? AT : null,
    retiredAt: null,
    createdAt: AT,
    updatedAt: AT,
  } as const;
}

function evaluationRun() {
  return {
    id: RUN_ID,
    tenantId: TENANT_ID,
    datasetVersionId: VERSION_ID,
    subjectType: 'AGENT_VERSION',
    subjectId: RUN_ID,
    subjectVersion: 1,
    subjectSnapshotHash: HASH,
    status: 'SUBMITTED',
    runnerId: CHECKER_ID,
    runnerName: 'signed-runner',
    runnerAttestationKeyFingerprint: HASH,
    externalRunId: 'external-1',
    expectedCaseCount: 9,
    submittedCaseCount: 9,
    evidenceBundleUri: 'https://evidence.example.com/bundle.json',
    evidenceBundleHash: HASH,
    runnerAttestation: 'Signed external runner attestation.',
    metrics: REQUIRED_EVALUATION_METRICS.map((metric) => ({
      ...metricResult(metric),
      numerator: 1,
      denominator: 1,
      value: metricResult(metric).threshold,
      sampleCount: 1,
      evidenceIds: [VERSION_ID],
      passed: true,
    })),
    revision: 3,
    startedAt: AT,
    submittedAt: AT,
    verifiedByUserId: null,
    verifiedAt: null,
    finishedAt: null,
    createdAt: AT,
    updatedAt: AT,
  } as const;
}

function metricResult(metric: (typeof REQUIRED_EVALUATION_METRICS)[number]) {
  const zero = metric === 'KNOWLEDGE_LEAKAGE_COUNT' || metric === 'SENSITIVE_DATA_DISCLOSURE_COUNT';
  const atMost =
    zero ||
    metric === 'AVERAGE_COST_MICROS' ||
    metric === 'P95_LATENCY_MS' ||
    metric === 'CORRECTION_FALSE_POSITIVE_RATE';
  return {
    metric,
    direction: zero ? ('ZERO' as const) : atMost ? ('AT_MOST' as const) : ('AT_LEAST' as const),
    threshold: zero ? 0 : atMost ? 1 : 0.9,
    minimumSampleCount: 1,
    required: true,
  };
}
