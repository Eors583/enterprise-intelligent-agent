import type {
  AiEvaluationCategory,
  AiEvaluationJudgeType,
  AiEvaluationMetric,
  AiEvaluationThresholdDirection,
  TrustedModelRouteSnapshot,
} from '@enterprise/contracts';

export interface EvaluationRunnerCase {
  readonly caseId: string;
  readonly category: AiEvaluationCategory;
  readonly input: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly expectedBehavior: string;
  readonly forbiddenBehaviors: readonly string[];
  readonly metricWeights: readonly {
    readonly metric: AiEvaluationMetric;
    readonly weight: number;
  }[];
  readonly evidenceIds: readonly string[];
}

export interface EvaluationRunnerThreshold {
  readonly metric: AiEvaluationMetric;
  readonly direction: AiEvaluationThresholdDirection;
  readonly threshold: number;
  readonly minimumSampleCount: number;
  readonly required: boolean;
}

export interface EvaluationRunnerExecutionRequest {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly runnerName: string;
  readonly nonce: string;
  readonly requestHash: string;
  readonly datasetVersionId: string;
  readonly datasetContentHash: string;
  readonly subjectType: 'AGENT_VERSION' | 'KNOWLEDGE_VERSION' | 'COMPOSITE_RELEASE';
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly subjectSnapshotHash: string;
  readonly systemPrompt: string | null;
  readonly knowledgeContext: string | null;
  readonly modelRoute: TrustedModelRouteSnapshot | null;
  readonly cases: readonly EvaluationRunnerCase[];
  readonly thresholds: readonly EvaluationRunnerThreshold[];
  readonly evidenceOrigin: string;
}

export interface EvaluationRunnerCaseResult {
  readonly caseId: string;
  readonly judgeType: AiEvaluationJudgeType;
  readonly passed: boolean;
  readonly score: number;
  readonly actualBehaviorHash: string;
  readonly evidenceIds: readonly string[];
  readonly detail: string;
}

export interface EvaluationRunnerMetricResult {
  readonly metric: AiEvaluationMetric;
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
  readonly threshold: number;
  readonly direction: AiEvaluationThresholdDirection;
  readonly sampleCount: number;
  readonly minimumSampleCount: number;
  readonly passed: boolean;
  readonly evidenceIds: readonly string[];
}

export interface EvaluationRunnerEvidenceBundle {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly nonce: string;
  readonly requestHash: string;
  readonly subjectSnapshotHash: string;
  readonly datasetContentHash: string;
  readonly caseResults: readonly EvaluationRunnerCaseResult[];
  readonly metrics: readonly EvaluationRunnerMetricResult[];
  readonly generatedAt: string;
}

export interface EvaluationRunnerAttestation {
  readonly schemaVersion: 1;
  readonly algorithm: 'HMAC-SHA256';
  readonly keyFingerprint: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly nonce: string;
  readonly requestHash: string;
  readonly resultPayloadHash: string;
  readonly evidenceBundleUri: string;
  readonly evidenceBundleHash: string;
  readonly issuedAt: string;
  readonly signature: string;
  readonly evidenceBundle: EvaluationRunnerEvidenceBundle;
}

export class EvaluationRunnerUnavailableError extends Error {
  constructor(
    readonly code:
      | 'EVALUATION_RUNNER_NOT_CONFIGURED'
      | 'EVALUATION_RUNNER_TIMEOUT'
      | 'EVALUATION_RUNNER_UNAVAILABLE'
      | 'EVALUATION_RUNNER_INVALID_RESPONSE'
      | 'EVALUATION_RUNNER_ATTESTATION_INVALID',
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'EvaluationRunnerUnavailableError';
  }
}

export abstract class AiEvaluationRunnerClient {
  abstract execute(request: EvaluationRunnerExecutionRequest): Promise<EvaluationRunnerAttestation>;
}
