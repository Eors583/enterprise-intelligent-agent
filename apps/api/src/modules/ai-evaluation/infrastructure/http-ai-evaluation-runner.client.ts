import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  aiEvaluationJudgeTypeSchema,
  aiEvaluationMetricSchema,
  aiEvaluationThresholdDirectionSchema,
} from '@enterprise/contracts';
import type {
  AiEvaluationJudgeType,
  AiEvaluationMetric,
  AiEvaluationThresholdDirection,
} from '@enterprise/contracts';

import {
  AiEvaluationRunnerClient,
  EvaluationRunnerUnavailableError,
  type EvaluationRunnerAttestation,
  type EvaluationRunnerExecutionRequest,
} from '../ai-evaluation-runner.client.js';
import type { EnvironmentVariables } from '../../../config/environment.js';

interface RuntimeCaseResult {
  readonly case_id: string;
  readonly judge_type: AiEvaluationJudgeType;
  readonly passed: boolean;
  readonly score: number;
  readonly actual_behavior_hash: string;
  readonly evidence_ids: readonly string[];
  readonly detail: string;
}

interface RuntimeMetricResult {
  readonly metric: AiEvaluationMetric;
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
  readonly threshold: number;
  readonly direction: AiEvaluationThresholdDirection;
  readonly sample_count: number;
  readonly minimum_sample_count: number;
  readonly passed: boolean;
  readonly evidence_ids: readonly string[];
}

interface RuntimeEvidenceBundle {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly runner_id: string;
  readonly nonce: string;
  readonly request_hash: string;
  readonly subject_snapshot_hash: string;
  readonly dataset_content_hash: string;
  readonly case_results: readonly RuntimeCaseResult[];
  readonly metrics: readonly RuntimeMetricResult[];
  readonly generated_at: string;
}

interface RuntimeExecutionResponse {
  readonly schema_version: 1;
  readonly algorithm: 'HMAC-SHA256';
  readonly key_fingerprint: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly runner_id: string;
  readonly nonce: string;
  readonly request_hash: string;
  readonly result_payload_hash: string;
  readonly evidence_bundle_uri: string;
  readonly evidence_bundle_hash: string;
  readonly issued_at: string;
  readonly signature: string;
  readonly evidence_bundle: RuntimeEvidenceBundle;
}

@Injectable()
export class HttpAiEvaluationRunnerClient extends AiEvaluationRunnerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly serviceToken: string | undefined;
  private readonly secret: string | undefined;

  constructor(@Inject(ConfigService) config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.baseUrl = config.get('AI_RUNTIME_URL', { infer: true });
    this.timeoutMs = config.get('AI_RUNTIME_HTTP_TIMEOUT_MS', { infer: true });
    this.serviceToken = config.get('AI_RUNTIME_SERVICE_TOKEN', { infer: true });
    this.secret = config.get('AI_EVALUATION_RUNNER_HMAC_SECRET', { infer: true });
  }

  async execute(request: EvaluationRunnerExecutionRequest): Promise<EvaluationRunnerAttestation> {
    if (this.secret === undefined) {
      throw new EvaluationRunnerUnavailableError('EVALUATION_RUNNER_NOT_CONFIGURED', false);
    }
    const expectedFingerprint = sha256(this.secret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(new URL('/internal/v1/evaluations/execute', this.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': request.tenantId,
          'X-Request-ID': `evaluation-${request.runId}`,
          'X-Correlation-ID': request.runId,
          ...(this.serviceToken === undefined
            ? {}
            : { Authorization: `Bearer ${this.serviceToken}` }),
        },
        body: JSON.stringify(toRuntimeRequest(request)),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new EvaluationRunnerUnavailableError(
          response.status === 408 || response.status === 429 || response.status >= 500
            ? 'EVALUATION_RUNNER_UNAVAILABLE'
            : 'EVALUATION_RUNNER_INVALID_RESPONSE',
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      let value: RuntimeExecutionResponse;
      try {
        value = parseExecutionResponse(payload);
      } catch {
        return invalidResponse();
      }
      if (
        value.key_fingerprint !== expectedFingerprint ||
        value.tenant_id !== request.tenantId ||
        value.run_id !== request.runId ||
        value.runner_id !== request.runnerId ||
        value.nonce !== request.nonce ||
        value.request_hash !== request.requestHash ||
        value.evidence_bundle.tenant_id !== request.tenantId ||
        value.evidence_bundle.run_id !== request.runId ||
        value.evidence_bundle.runner_id !== request.runnerId ||
        value.evidence_bundle.nonce !== request.nonce ||
        value.evidence_bundle.request_hash !== request.requestHash ||
        value.evidence_bundle.subject_snapshot_hash !== request.subjectSnapshotHash ||
        value.evidence_bundle.dataset_content_hash !== request.datasetContentHash
      ) {
        return invalidAttestation();
      }
      const caseIds = value.evidence_bundle.case_results.map(({ case_id }) => case_id);
      if (
        caseIds.length !== request.cases.length ||
        new Set(caseIds).size !== caseIds.length ||
        request.cases.some(({ caseId }) => !caseIds.includes(caseId))
      ) {
        return invalidAttestation();
      }
      const metricNames = value.evidence_bundle.metrics.map(({ metric }) => metric);
      if (
        new Set(metricNames).size !== metricNames.length ||
        request.thresholds
          .filter(({ required }) => required)
          .some(({ metric }) => !metricNames.includes(metric))
      ) {
        return invalidAttestation();
      }
      const bundleHash = sha256(canonicalJson(value.evidence_bundle));
      const resultPayloadHash = sha256(
        canonicalJson({
          case_results: value.evidence_bundle.case_results,
          metrics: value.evidence_bundle.metrics,
        }),
      );
      if (
        bundleHash !== value.evidence_bundle_hash ||
        resultPayloadHash !== value.result_payload_hash
      ) {
        return invalidAttestation();
      }
      const signedEnvelope = {
        algorithm: value.algorithm,
        evidence_bundle_hash: value.evidence_bundle_hash,
        evidence_bundle_uri: value.evidence_bundle_uri,
        issued_at: value.issued_at,
        key_fingerprint: value.key_fingerprint,
        nonce: value.nonce,
        request_hash: value.request_hash,
        result_payload_hash: value.result_payload_hash,
        run_id: value.run_id,
        runner_id: value.runner_id,
        schema_version: value.schema_version,
        tenant_id: value.tenant_id,
      };
      const expectedSignature = createHmac('sha256', this.secret)
        .update(canonicalJson(signedEnvelope))
        .digest();
      const actualSignature = Buffer.from(value.signature, 'hex');
      if (
        actualSignature.length !== expectedSignature.length ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        return invalidAttestation();
      }
      return {
        schemaVersion: 1,
        algorithm: 'HMAC-SHA256',
        keyFingerprint: value.key_fingerprint,
        tenantId: value.tenant_id,
        runId: value.run_id,
        runnerId: value.runner_id,
        nonce: value.nonce,
        requestHash: value.request_hash,
        resultPayloadHash: value.result_payload_hash,
        evidenceBundleUri: value.evidence_bundle_uri,
        evidenceBundleHash: value.evidence_bundle_hash,
        issuedAt: value.issued_at,
        signature: value.signature,
        evidenceBundle: {
          schemaVersion: 1,
          tenantId: value.evidence_bundle.tenant_id,
          runId: value.evidence_bundle.run_id,
          runnerId: value.evidence_bundle.runner_id,
          nonce: value.evidence_bundle.nonce,
          requestHash: value.evidence_bundle.request_hash,
          subjectSnapshotHash: value.evidence_bundle.subject_snapshot_hash,
          datasetContentHash: value.evidence_bundle.dataset_content_hash,
          caseResults: value.evidence_bundle.case_results.map((result) => ({
            caseId: result.case_id,
            judgeType: result.judge_type,
            passed: result.passed,
            score: result.score,
            actualBehaviorHash: result.actual_behavior_hash,
            evidenceIds: result.evidence_ids,
            detail: result.detail,
          })),
          metrics: value.evidence_bundle.metrics.map((metric) => ({
            metric: metric.metric,
            numerator: metric.numerator,
            denominator: metric.denominator,
            value: metric.value,
            threshold: metric.threshold,
            direction: metric.direction,
            sampleCount: metric.sample_count,
            minimumSampleCount: metric.minimum_sample_count,
            passed: metric.passed,
            evidenceIds: metric.evidence_ids,
          })),
          generatedAt: value.evidence_bundle.generated_at,
        },
      };
    } catch (error) {
      if (error instanceof EvaluationRunnerUnavailableError) throw error;
      if (controller.signal.aborted) {
        throw new EvaluationRunnerUnavailableError('EVALUATION_RUNNER_TIMEOUT', true);
      }
      throw new EvaluationRunnerUnavailableError('EVALUATION_RUNNER_UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toRuntimeRequest(request: EvaluationRunnerExecutionRequest): unknown {
  return {
    schema_version: 1,
    tenant_id: request.tenantId,
    run_id: request.runId,
    runner_id: request.runnerId,
    runner_name: request.runnerName,
    nonce: request.nonce,
    request_hash: request.requestHash,
    dataset_version_id: request.datasetVersionId,
    dataset_content_hash: request.datasetContentHash,
    subject_type: request.subjectType,
    subject_id: request.subjectId,
    subject_version: request.subjectVersion,
    subject_snapshot_hash: request.subjectSnapshotHash,
    system_prompt: request.systemPrompt,
    knowledge_context: request.knowledgeContext,
    model_route:
      request.modelRoute === null
        ? null
        : {
            schema_version: request.modelRoute.schemaVersion,
            policy_version_id: request.modelRoute.policyVersionId,
            policy_version: request.modelRoute.policyVersion,
            policy_hash: request.modelRoute.policyHash,
            task_class: request.modelRoute.taskClass,
            maximum_classification: request.modelRoute.maximumClassification,
            required_capabilities: request.modelRoute.requiredCapabilities,
            maximum_attempts: request.modelRoute.maximumAttempts,
            circuit_failure_threshold: request.modelRoute.circuitFailureThreshold,
            circuit_open_seconds: request.modelRoute.circuitOpenSeconds,
            candidates: request.modelRoute.candidates.map((candidate) => ({
              ordinal: candidate.ordinal,
              catalog_version_id: candidate.catalogVersionId,
              route_key: candidate.routeKey,
              provider: candidate.provider,
              model: candidate.model,
              credential_reference: candidate.credentialReference,
            })),
          },
    cases: request.cases.map((testCase) => ({
      case_id: testCase.caseId,
      category: testCase.category,
      input: testCase.input,
      context: testCase.context,
      expected_behavior: testCase.expectedBehavior,
      forbidden_behaviors: testCase.forbiddenBehaviors,
      metric_weights: testCase.metricWeights,
      evidence_ids: testCase.evidenceIds,
    })),
    thresholds: request.thresholds.map((threshold) => ({
      metric: threshold.metric,
      direction: threshold.direction,
      threshold: threshold.threshold,
      minimum_sample_count: threshold.minimumSampleCount,
      required: threshold.required,
    })),
    evidence_origin: request.evidenceOrigin,
  };
}

export function evaluationExecutionRequestHash(
  request: Omit<EvaluationRunnerExecutionRequest, 'requestHash'>,
): string {
  return sha256(canonicalJson(toRuntimeRequest({ ...request, requestHash: '0'.repeat(64) })));
}

export function evaluationRunnerKeyFingerprint(secret: string): string {
  return sha256(secret);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') {
    throw new TypeError('Canonical JSON accepts only JSON values.');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidResponse(): never {
  throw new EvaluationRunnerUnavailableError('EVALUATION_RUNNER_INVALID_RESPONSE', true);
}

function invalidAttestation(): never {
  throw new EvaluationRunnerUnavailableError('EVALUATION_RUNNER_ATTESTATION_INVALID', false);
}

function parseExecutionResponse(payload: unknown): RuntimeExecutionResponse {
  const response = exactRecord(payload, [
    'schema_version',
    'algorithm',
    'key_fingerprint',
    'tenant_id',
    'run_id',
    'runner_id',
    'nonce',
    'request_hash',
    'result_payload_hash',
    'evidence_bundle_uri',
    'evidence_bundle_hash',
    'issued_at',
    'signature',
    'evidence_bundle',
  ]);
  if (response.schema_version !== 1 || response.algorithm !== 'HMAC-SHA256') {
    throw new TypeError('Unsupported evaluation attestation format.');
  }
  return {
    schema_version: 1,
    algorithm: 'HMAC-SHA256',
    key_fingerprint: sha256Value(response.key_fingerprint),
    tenant_id: uuidValue(response.tenant_id),
    run_id: uuidValue(response.run_id),
    runner_id: uuidValue(response.runner_id),
    nonce: sha256Value(response.nonce),
    request_hash: sha256Value(response.request_hash),
    result_payload_hash: sha256Value(response.result_payload_hash),
    evidence_bundle_uri: evidenceUrlValue(response.evidence_bundle_uri),
    evidence_bundle_hash: sha256Value(response.evidence_bundle_hash),
    issued_at: timestampValue(response.issued_at),
    signature: sha256Value(response.signature),
    evidence_bundle: parseEvidenceBundle(response.evidence_bundle),
  };
}

function parseEvidenceBundle(payload: unknown): RuntimeEvidenceBundle {
  const bundle = exactRecord(payload, [
    'schema_version',
    'tenant_id',
    'run_id',
    'runner_id',
    'nonce',
    'request_hash',
    'subject_snapshot_hash',
    'dataset_content_hash',
    'case_results',
    'metrics',
    'generated_at',
  ]);
  if (bundle.schema_version !== 1) {
    throw new TypeError('Unsupported evaluation evidence bundle.');
  }
  return {
    schema_version: 1,
    tenant_id: uuidValue(bundle.tenant_id),
    run_id: uuidValue(bundle.run_id),
    runner_id: uuidValue(bundle.runner_id),
    nonce: sha256Value(bundle.nonce),
    request_hash: sha256Value(bundle.request_hash),
    subject_snapshot_hash: sha256Value(bundle.subject_snapshot_hash),
    dataset_content_hash: sha256Value(bundle.dataset_content_hash),
    case_results: arrayValue(bundle.case_results, 1_000).map(parseCaseResult),
    metrics: arrayValue(bundle.metrics, 100).map(parseMetricResult),
    generated_at: timestampValue(bundle.generated_at),
  };
}

function parseCaseResult(payload: unknown): RuntimeCaseResult {
  const result = exactRecord(payload, [
    'case_id',
    'judge_type',
    'passed',
    'score',
    'actual_behavior_hash',
    'evidence_ids',
    'detail',
  ]);
  const judgeType = aiEvaluationJudgeTypeSchema.safeParse(result.judge_type);
  if (!judgeType.success) throw new TypeError('Invalid evaluation judge type.');
  return {
    case_id: uuidValue(result.case_id),
    judge_type: judgeType.data,
    passed: booleanValue(result.passed),
    score: boundedNumberValue(result.score, 0, 1),
    actual_behavior_hash: sha256Value(result.actual_behavior_hash),
    evidence_ids: uniqueUuidArray(result.evidence_ids, 500),
    detail: boundedTextValue(result.detail, 20_000),
  };
}

function parseMetricResult(payload: unknown): RuntimeMetricResult {
  const result = exactRecord(payload, [
    'metric',
    'numerator',
    'denominator',
    'value',
    'threshold',
    'direction',
    'sample_count',
    'minimum_sample_count',
    'passed',
    'evidence_ids',
  ]);
  const metric = aiEvaluationMetricSchema.safeParse(result.metric);
  const direction = aiEvaluationThresholdDirectionSchema.safeParse(result.direction);
  if (!metric.success || !direction.success) {
    throw new TypeError('Invalid evaluation metric.');
  }
  return {
    metric: metric.data,
    numerator: nonnegativeNumberValue(result.numerator),
    denominator: nonnegativeNumberValue(result.denominator),
    value: nonnegativeNumberValue(result.value),
    threshold: nonnegativeNumberValue(result.threshold),
    direction: direction.data,
    sample_count: nonnegativeIntegerValue(result.sample_count),
    minimum_sample_count: positiveIntegerValue(result.minimum_sample_count),
    passed: booleanValue(result.passed),
    evidence_ids: uniqueUuidArray(result.evidence_ids, 500),
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new TypeError('Unexpected evaluation response shape.');
  }
  return record;
}

function arrayValue(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new TypeError('Invalid evaluation result collection.');
  }
  return value;
}

function uniqueUuidArray(value: unknown, maximumLength: number): readonly string[] {
  const values = arrayValue(value, maximumLength).map(uuidValue);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new TypeError('Evaluation evidence identities must be non-empty and unique.');
  }
  return values;
}

function uuidValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new TypeError('Invalid UUID.');
  }
  return value;
}

function sha256Value(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('Invalid SHA-256 value.');
  }
  return value;
}

function evidenceUrlValue(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid evidence URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new TypeError('Evidence URL must be credential-free HTTPS.');
  }
  return value;
}

function timestampValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError('Invalid timestamp.');
  }
  return value;
}

function boundedTextValue(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    throw new TypeError('Invalid evaluation detail.');
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid boolean.');
  return value;
}

function boundedNumberValue(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError('Invalid numeric value.');
  }
  return value;
}

function nonnegativeNumberValue(value: unknown): number {
  return boundedNumberValue(value, 0, Number.MAX_VALUE);
}

function nonnegativeIntegerValue(value: unknown): number {
  const number = nonnegativeNumberValue(value);
  if (!Number.isSafeInteger(number)) throw new TypeError('Expected an integer.');
  return number;
}

function positiveIntegerValue(value: unknown): number {
  const number = nonnegativeIntegerValue(value);
  if (number === 0) throw new TypeError('Expected a positive integer.');
  return number;
}
