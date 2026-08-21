import {
  submitAiEvaluationRunRequestSchema,
  type AiEvaluationCase,
  type AiEvaluationRun,
  type AiEvaluationRunner,
  type CreateAiEvaluationRunRequest,
  type SubmitAiEvaluationRunRequest,
} from '@enterprise/contracts';

export interface EvaluationSubjectChoice {
  readonly key: string;
  readonly datasetVersionId: string;
  readonly subjectType: AiEvaluationRun['subjectType'];
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly subjectSnapshotHash: string;
}

export interface EvaluationRunChoices {
  readonly datasetVersionIds: readonly string[];
  readonly subjects: readonly EvaluationSubjectChoice[];
}

export interface RunnerResultPayload {
  readonly caseResults: SubmitAiEvaluationRunRequest['caseResults'];
  readonly metrics: SubmitAiEvaluationRunRequest['metrics'];
  readonly evidenceBundleUri: string;
  readonly evidenceBundleHash: string;
  readonly runnerAttestation: string;
}

export interface ParsedRunnerResultPackage {
  readonly payload: RunnerResultPayload;
  readonly preview: {
    readonly caseCount: number;
    readonly caseHashCount: number;
    readonly metricCount: number;
    readonly metricNames: readonly string[];
    readonly evidenceIdCount: number;
    readonly evidenceBundleUri: string;
    readonly evidenceBundleHash: string;
    readonly algorithm: string;
    readonly keyFingerprint: string;
  };
}

export function deriveEvaluationRunChoices(runs: readonly AiEvaluationRun[]): EvaluationRunChoices {
  const subjects = new Map<string, EvaluationSubjectChoice>();
  for (const run of runs) {
    const key = [
      run.datasetVersionId,
      run.subjectType,
      run.subjectId,
      run.subjectVersion,
      run.subjectSnapshotHash,
    ].join(':');
    if (!subjects.has(key)) {
      subjects.set(key, {
        key,
        datasetVersionId: run.datasetVersionId,
        subjectType: run.subjectType,
        subjectId: run.subjectId,
        subjectVersion: run.subjectVersion,
        subjectSnapshotHash: run.subjectSnapshotHash,
      });
    }
  }
  return {
    datasetVersionIds: [...new Set(runs.map((run) => run.datasetVersionId))],
    subjects: [...subjects.values()],
  };
}

export function createRunRequestFromSelection(input: {
  readonly subject: EvaluationSubjectChoice;
  readonly runner: AiEvaluationRunner;
  readonly idempotencyKey: string;
  readonly externalRunIdOverride?: string;
}): CreateAiEvaluationRunRequest {
  return {
    datasetVersionId: input.subject.datasetVersionId,
    subjectType: input.subject.subjectType,
    subjectId: input.subject.subjectId,
    subjectVersion: input.subject.subjectVersion,
    subjectSnapshotHash: input.subject.subjectSnapshotHash,
    runnerId: input.runner.id,
    runnerName: input.runner.name,
    externalRunId:
      input.externalRunIdOverride?.trim() || evaluationExternalRunId(input.idempotencyKey),
    idempotencyKey: input.idempotencyKey,
  };
}

export function evaluationExternalRunId(idempotencyKey: string): string {
  return `admin-evaluation-${idempotencyKey}`.slice(0, 200);
}

export function parseRunnerResultPackage(
  source: string,
  run: AiEvaluationRun,
  cases: readonly AiEvaluationCase[],
): ParsedRunnerResultPackage {
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new Error('Runner JSON 结果包不是有效 JSON。');
  }
  const root = record(input, 'Runner JSON 结果包');
  const normalized =
    'evidence_bundle' in root
      ? normalizeRuntimeEnvelope(root)
      : normalizeAdministrativePackage(root);

  if (normalized.runId !== run.id) {
    throw new Error('Runner JSON 结果包不属于当前 Run。');
  }
  if (normalized.runnerId !== run.runnerId) {
    throw new Error('Runner JSON 结果包的 Runner 与当前 Run 不一致。');
  }
  if (normalized.subjectSnapshotHash !== run.subjectSnapshotHash) {
    throw new Error('Runner JSON 结果包的发布对象快照与当前 Run 不一致。');
  }
  if (normalized.keyFingerprint !== run.runnerAttestationKeyFingerprint) {
    throw new Error('Runner JSON 结果包的签名指纹与当前 Run 不一致。');
  }
  if (normalized.algorithm !== 'HMAC-SHA256') {
    throw new Error('Runner JSON 结果包使用了当前系统不支持的签名算法。');
  }
  if (cases.length !== run.expectedCaseCount) {
    throw new Error('当前页面尚未加载完整密封用例，不能确认 Runner 结果包。');
  }

  const parsed = submitAiEvaluationRunRequestSchema.safeParse({
    expectedRevision: run.revision,
    caseResults: normalized.caseResults,
    metrics: normalized.metrics,
    evidenceBundleUri: normalized.evidenceBundleUri,
    evidenceBundleHash: normalized.evidenceBundleHash,
    runnerAttestation: normalized.runnerAttestation,
    idempotencyKey: 'runner-result-package-preview',
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'package';
    throw new Error(`Runner JSON 结果包字段无效：${path} ${issue?.message ?? '未知错误'}`);
  }

  const expectedCaseIds = new Set(cases.map((testCase) => testCase.id));
  const resultCaseIds = new Set(parsed.data.caseResults.map((result) => result.caseId));
  if (
    resultCaseIds.size !== expectedCaseIds.size ||
    [...expectedCaseIds].some((caseId) => !resultCaseIds.has(caseId))
  ) {
    throw new Error('Runner JSON 结果包未完整覆盖当前数据集的密封用例。');
  }

  const evidenceIds = new Set([
    ...parsed.data.caseResults.flatMap((result) => result.evidenceIds),
    ...parsed.data.metrics.flatMap((metric) => metric.evidenceIds),
  ]);
  return {
    payload: {
      caseResults: parsed.data.caseResults,
      metrics: parsed.data.metrics,
      evidenceBundleUri: parsed.data.evidenceBundleUri,
      evidenceBundleHash: parsed.data.evidenceBundleHash,
      runnerAttestation: parsed.data.runnerAttestation,
    },
    preview: {
      caseCount: parsed.data.caseResults.length,
      caseHashCount: parsed.data.caseResults.length,
      metricCount: parsed.data.metrics.length,
      metricNames: parsed.data.metrics.map((metric) => metric.metric),
      evidenceIdCount: evidenceIds.size,
      evidenceBundleUri: parsed.data.evidenceBundleUri,
      evidenceBundleHash: parsed.data.evidenceBundleHash,
      algorithm: normalized.algorithm,
      keyFingerprint: normalized.keyFingerprint,
    },
  };
}

interface NormalizedRunnerPackage {
  readonly runId: string;
  readonly runnerId: string;
  readonly subjectSnapshotHash: string;
  readonly keyFingerprint: string;
  readonly algorithm: string;
  readonly caseResults: readonly unknown[];
  readonly metrics: readonly unknown[];
  readonly evidenceBundleUri: string;
  readonly evidenceBundleHash: string;
  readonly runnerAttestation: string;
}

function normalizeAdministrativePackage(
  root: Readonly<Record<string, unknown>>,
): NormalizedRunnerPackage {
  if (numberField(root, 'schemaVersion') !== 1) {
    throw new Error('Runner JSON 结果包 schemaVersion 必须为 1。');
  }
  return {
    runId: stringField(root, 'runId'),
    runnerId: stringField(root, 'runnerId'),
    subjectSnapshotHash: stringField(root, 'subjectSnapshotHash'),
    keyFingerprint: stringField(root, 'keyFingerprint'),
    algorithm: stringField(root, 'algorithm'),
    caseResults: arrayField(root, 'caseResults'),
    metrics: arrayField(root, 'metrics'),
    evidenceBundleUri: stringField(root, 'evidenceBundleUri'),
    evidenceBundleHash: stringField(root, 'evidenceBundleHash'),
    runnerAttestation: stringField(root, 'runnerAttestation'),
  };
}

function normalizeRuntimeEnvelope(
  root: Readonly<Record<string, unknown>>,
): NormalizedRunnerPackage {
  const evidenceBundle = record(root.evidence_bundle, 'evidence_bundle');
  if (
    numberField(root, 'schema_version') !== 1 ||
    numberField(evidenceBundle, 'schema_version') !== 1
  ) {
    throw new Error('Runner JSON 结果包 schema_version 必须为 1。');
  }
  const runId = stringField(root, 'run_id');
  const runnerId = stringField(root, 'runner_id');
  if (
    stringField(evidenceBundle, 'run_id') !== runId ||
    stringField(evidenceBundle, 'runner_id') !== runnerId ||
    stringField(evidenceBundle, 'tenant_id') !== stringField(root, 'tenant_id')
  ) {
    throw new Error('Runner JSON 结果包的签名信封与证据包身份不一致。');
  }
  for (const requiredField of [
    'nonce',
    'request_hash',
    'result_payload_hash',
    'issued_at',
    'signature',
  ]) {
    stringField(root, requiredField);
  }
  stringField(evidenceBundle, 'dataset_content_hash');
  const attestation = { ...root };
  delete attestation.evidence_bundle;
  return {
    runId,
    runnerId,
    subjectSnapshotHash: stringField(evidenceBundle, 'subject_snapshot_hash'),
    keyFingerprint: stringField(root, 'key_fingerprint'),
    algorithm: stringField(root, 'algorithm'),
    caseResults: arrayField(evidenceBundle, 'case_results').map((value) => {
      const result = record(value, 'case_results item');
      return {
        caseId: stringField(result, 'case_id'),
        judgeType: stringField(result, 'judge_type'),
        passed: booleanField(result, 'passed'),
        score: numberField(result, 'score'),
        actualBehaviorHash: stringField(result, 'actual_behavior_hash'),
        evidenceIds: stringArrayField(result, 'evidence_ids'),
        detail: stringField(result, 'detail'),
      };
    }),
    metrics: arrayField(evidenceBundle, 'metrics').map((value) => {
      const metric = record(value, 'metrics item');
      return {
        metric: stringField(metric, 'metric'),
        numerator: numberField(metric, 'numerator'),
        denominator: numberField(metric, 'denominator'),
        value: numberField(metric, 'value'),
        threshold: numberField(metric, 'threshold'),
        direction: stringField(metric, 'direction'),
        sampleCount: numberField(metric, 'sample_count'),
        minimumSampleCount: numberField(metric, 'minimum_sample_count'),
        passed: booleanField(metric, 'passed'),
        evidenceIds: stringArrayField(metric, 'evidence_ids'),
      };
    }),
    evidenceBundleUri: stringField(root, 'evidence_bundle_uri'),
    evidenceBundleHash: stringField(root, 'evidence_bundle_hash'),
    runnerAttestation: JSON.stringify(attestation),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new Error(`Runner JSON 结果包缺少字符串字段 ${key}。`);
  }
  return result.trim();
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number {
  const result = value[key];
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`Runner JSON 结果包缺少数值字段 ${key}。`);
  }
  return result;
}

function booleanField(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const result = value[key];
  if (typeof result !== 'boolean') {
    throw new Error(`Runner JSON 结果包缺少布尔字段 ${key}。`);
  }
  return result;
}

function arrayField(value: Readonly<Record<string, unknown>>, key: string): unknown[] {
  const result = value[key];
  if (!Array.isArray(result)) {
    throw new Error(`Runner JSON 结果包缺少数组字段 ${key}。`);
  }
  return result;
}

function stringArrayField(value: Readonly<Record<string, unknown>>, key: string): string[] {
  const result = arrayField(value, key);
  if (!result.every((item): item is string => typeof item === 'string')) {
    throw new Error(`Runner JSON 结果包字段 ${key} 必须是字符串数组。`);
  }
  return result;
}
