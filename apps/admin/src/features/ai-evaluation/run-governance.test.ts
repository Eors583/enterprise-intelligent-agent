import type { AiEvaluationCase, AiEvaluationRun, AiEvaluationRunner } from '@enterprise/contracts';
import { describe, expect, it } from 'vitest';

import {
  createRunRequestFromSelection,
  deriveEvaluationRunChoices,
  parseRunnerResultPackage,
} from './run-governance';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '10000000-0000-4000-8000-000000000002';
const RUNNER_ID = '10000000-0000-4000-8000-000000000003';
const DATASET_VERSION_ID = '10000000-0000-4000-8000-000000000004';
const SUBJECT_ID = '10000000-0000-4000-8000-000000000005';
const CASE_ID = '10000000-0000-4000-8000-000000000006';
const EVIDENCE_ID = '10000000-0000-4000-8000-000000000007';
const HASH = 'a'.repeat(64);
const BUNDLE_HASH = 'b'.repeat(64);

const RUNNER: AiEvaluationRunner = {
  id: RUNNER_ID,
  name: 'Enterprise signed runner',
  status: 'ACTIVE',
  attestationKeyFingerprint: HASH,
  allowedEvidenceOrigins: ['https://evidence.example.com/'],
};

const RUN: AiEvaluationRun = {
  id: RUN_ID,
  tenantId: TENANT_ID,
  datasetVersionId: DATASET_VERSION_ID,
  subjectType: 'AGENT_VERSION',
  subjectId: SUBJECT_ID,
  subjectVersion: 7,
  subjectSnapshotHash: HASH,
  status: 'RUNNING',
  runnerId: RUNNER_ID,
  runnerName: RUNNER.name,
  runnerAttestationKeyFingerprint: HASH,
  externalRunId: 'external-run-7',
  expectedCaseCount: 1,
  submittedCaseCount: 0,
  evidenceBundleUri: null,
  evidenceBundleHash: null,
  runnerAttestation: null,
  metrics: [],
  revision: 3,
  startedAt: '2026-07-29T01:00:00.000Z',
  submittedAt: null,
  verifiedByUserId: null,
  verifiedAt: null,
  finishedAt: null,
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T01:00:00.000Z',
};

const TEST_CASE: AiEvaluationCase = {
  id: CASE_ID,
  tenantId: TENANT_ID,
  datasetVersionId: DATASET_VERSION_ID,
  caseKey: 'FACTUALITY.001',
  category: 'FACTUALITY',
  input: 'Question',
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
  expectedBehavior: 'Answer with evidence.',
  requiredEvidenceIds: [EVIDENCE_ID],
  forbiddenBehaviors: [],
  scoring: {
    judgeTypes: ['SIGNED_CODE'],
    rubric: 'Signed factuality check.',
    metricWeights: [{ metric: 'FACTUAL_ACCURACY', weight: 1 }],
  },
  sourceBadCaseId: null,
  contentHash: HASH,
  revision: 1,
  createdAt: '2026-07-29T00:00:00.000Z',
};

describe('AI evaluation Run governance helpers', () => {
  it('derives deduplicated data-set and release-object choices from real Run records', () => {
    const choices = deriveEvaluationRunChoices([RUN, { ...RUN, id: EVIDENCE_ID }]);
    expect(choices.datasetVersionIds).toEqual([DATASET_VERSION_ID]);
    expect(choices.subjects).toEqual([
      {
        key: `${DATASET_VERSION_ID}:AGENT_VERSION:${SUBJECT_ID}:7:${HASH}`,
        datasetVersionId: DATASET_VERSION_ID,
        subjectType: 'AGENT_VERSION',
        subjectId: SUBJECT_ID,
        subjectVersion: 7,
        subjectSnapshotHash: HASH,
      },
    ]);
  });

  it('creates the existing API wire from selected records and generates a real correlation id', () => {
    const subject = deriveEvaluationRunChoices([RUN]).subjects[0]!;
    expect(
      createRunRequestFromSelection({
        subject,
        runner: RUNNER,
        idempotencyKey: 'request-123',
      }),
    ).toEqual({
      datasetVersionId: DATASET_VERSION_ID,
      subjectType: 'AGENT_VERSION',
      subjectId: SUBJECT_ID,
      subjectVersion: 7,
      subjectSnapshotHash: HASH,
      runnerId: RUNNER_ID,
      runnerName: RUNNER.name,
      externalRunId: 'admin-evaluation-request-123',
      idempotencyKey: 'request-123',
    });
  });

  it('parses and previews a camelCase Runner JSON package without changing submit wire fields', () => {
    const parsed = parseRunnerResultPackage(JSON.stringify(administrativePackage()), RUN, [
      TEST_CASE,
    ]);
    expect(parsed.payload.caseResults).toHaveLength(1);
    expect(parsed.payload.metrics).toHaveLength(1);
    expect(parsed.payload.evidenceBundleUri).toBe('https://evidence.example.com/runs/result.json');
    expect(parsed.preview).toMatchObject({
      caseCount: 1,
      caseHashCount: 1,
      metricCount: 1,
      metricNames: ['FACTUAL_ACCURACY'],
      evidenceIdCount: 1,
      algorithm: 'HMAC-SHA256',
      keyFingerprint: HASH,
    });
  });

  it('normalizes the Runtime snake_case signature envelope and rejects cross-Run packages', () => {
    const envelope = runtimeEnvelope();
    const parsed = parseRunnerResultPackage(JSON.stringify(envelope), RUN, [TEST_CASE]);
    expect(parsed.payload.caseResults[0]).toMatchObject({
      caseId: CASE_ID,
      actualBehaviorHash: HASH,
      judgeType: 'SIGNED_CODE',
    });
    expect(JSON.parse(parsed.payload.runnerAttestation)).toMatchObject({
      run_id: RUN_ID,
      signature: HASH,
    });

    expect(() =>
      parseRunnerResultPackage(
        JSON.stringify({
          ...envelope,
          run_id: EVIDENCE_ID,
          evidence_bundle: {
            ...(envelope.evidence_bundle as Record<string, unknown>),
            run_id: EVIDENCE_ID,
          },
        }),
        RUN,
        [TEST_CASE],
      ),
    ).toThrow('不属于当前 Run');
  });
});

function administrativePackage(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    algorithm: 'HMAC-SHA256',
    keyFingerprint: HASH,
    runId: RUN_ID,
    runnerId: RUNNER_ID,
    subjectSnapshotHash: HASH,
    caseResults: [caseResult()],
    metrics: [metricResult()],
    evidenceBundleUri: 'https://evidence.example.com/runs/result.json',
    evidenceBundleHash: BUNDLE_HASH,
    runnerAttestation: 'Signed external Runner attestation.',
  };
}

function runtimeEnvelope(): Record<string, unknown> {
  return {
    schema_version: 1,
    algorithm: 'HMAC-SHA256',
    key_fingerprint: HASH,
    tenant_id: TENANT_ID,
    run_id: RUN_ID,
    runner_id: RUNNER_ID,
    nonce: 'nonce-1',
    request_hash: HASH,
    result_payload_hash: HASH,
    evidence_bundle_uri: 'https://evidence.example.com/runs/result.json',
    evidence_bundle_hash: BUNDLE_HASH,
    issued_at: '2026-07-29T01:10:00.000Z',
    signature: HASH,
    evidence_bundle: {
      schema_version: 1,
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      runner_id: RUNNER_ID,
      nonce: 'nonce-1',
      request_hash: HASH,
      subject_snapshot_hash: HASH,
      dataset_content_hash: HASH,
      case_results: [
        {
          case_id: CASE_ID,
          judge_type: 'SIGNED_CODE',
          passed: true,
          score: 1,
          actual_behavior_hash: HASH,
          evidence_ids: [EVIDENCE_ID],
          detail: 'Signed factuality check passed.',
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
          sample_count: 1,
          minimum_sample_count: 1,
          passed: true,
          evidence_ids: [EVIDENCE_ID],
        },
      ],
      generated_at: '2026-07-29T01:10:00.000Z',
    },
  };
}

function caseResult(): Record<string, unknown> {
  return {
    caseId: CASE_ID,
    judgeType: 'SIGNED_CODE',
    passed: true,
    score: 1,
    actualBehaviorHash: HASH,
    evidenceIds: [EVIDENCE_ID],
    detail: 'Signed factuality check passed.',
  };
}

function metricResult(): Record<string, unknown> {
  return {
    metric: 'FACTUAL_ACCURACY',
    numerator: 1,
    denominator: 1,
    value: 1,
    threshold: 0.9,
    direction: 'AT_LEAST',
    sampleCount: 1,
    minimumSampleCount: 1,
    passed: true,
    evidenceIds: [EVIDENCE_ID],
  };
}
