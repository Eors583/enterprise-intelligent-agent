import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const CODE = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/u);
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const IDEMPOTENCY_KEY = z.string().trim().min(1).max(200);
const JSON_OBJECT = z.record(z.string(), z.unknown());
const CREDENTIAL_FREE_HTTPS_URL = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
}, 'Evaluation evidence URLs must use HTTPS without credentials or fragments.');
const CANONICAL_HTTPS_ORIGIN = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    value === `${url.origin}/`
  );
}, 'Runner evidence origins must be canonical credential-free HTTPS origins.');
const UNIQUE_UUIDS = z
  .array(UUID)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'UUID values must be unique.');
const NON_EMPTY_UNIQUE_UUIDS = z
  .array(UUID)
  .min(1)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'UUID values must be unique.');

export const aiEvaluationCategorySchema = z.enum([
  'ROLE_BOUNDARY',
  'FACTUALITY',
  'CITATION',
  'GOAL_ALIGNMENT',
  'TOOL_USE',
  'CORRECTION',
  'REFUSAL',
  'SAFETY',
  'COST',
]);

export const aiEvaluationMetricSchema = z.enum([
  'ROLE_BOUNDARY_ADHERENCE',
  'FACTUAL_ACCURACY',
  'CITATION_COMPLETENESS',
  'GOAL_ALIGNMENT_ACCURACY',
  'TOOL_SUCCESS_RATE',
  'HIGH_RISK_CONFIRMATION_RATE',
  'CORRECTION_PRECISION',
  'CORRECTION_FALSE_POSITIVE_RATE',
  'REFUSAL_CORRECTNESS',
  'KNOWLEDGE_LEAKAGE_COUNT',
  'PROMPT_INJECTION_RESISTANCE',
  'SENSITIVE_DATA_DISCLOSURE_COUNT',
  'AVERAGE_COST_MICROS',
  'P95_LATENCY_MS',
]);

export const aiEvaluationDatasetStatusSchema = z.enum([
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'RETIRED',
]);

export const aiEvaluationRunStatusSchema = z.enum([
  'CREATED',
  'RUNNING',
  'SUBMITTED',
  'VERIFIED',
  'PASSED',
  'FAILED',
  'CANCELLED',
]);

export const aiEvaluationSubjectTypeSchema = z.enum([
  'AGENT_VERSION',
  'KNOWLEDGE_VERSION',
  'COMPOSITE_RELEASE',
]);

export const aiEvaluationJudgeTypeSchema = z.enum([
  'DETERMINISTIC_RULE',
  'SIGNED_CODE',
  'HUMAN',
  'EXTERNAL_RUNNER',
]);

export const aiEvaluationBadCaseStatusSchema = z.enum([
  'RECEIVED',
  'TRIAGED',
  'ADDED_TO_DATASET',
  'DISMISSED',
]);

export const aiEvaluationThresholdDirectionSchema = z.enum(['AT_LEAST', 'AT_MOST', 'ZERO']);

export const aiEvaluationThresholdSchema = z
  .object({
    metric: aiEvaluationMetricSchema,
    direction: aiEvaluationThresholdDirectionSchema,
    threshold: z.number().finite().nonnegative(),
    minimumSampleCount: z.number().int().positive().max(1_000_000),
    required: z.boolean(),
  })
  .strict()
  .superRefine((threshold, context) => {
    if (threshold.direction === 'ZERO' && threshold.threshold !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'A ZERO threshold must be exactly zero.',
      });
    }
    if (
      [
        'ROLE_BOUNDARY_ADHERENCE',
        'FACTUAL_ACCURACY',
        'CITATION_COMPLETENESS',
        'GOAL_ALIGNMENT_ACCURACY',
        'TOOL_SUCCESS_RATE',
        'HIGH_RISK_CONFIRMATION_RATE',
        'CORRECTION_PRECISION',
        'CORRECTION_FALSE_POSITIVE_RATE',
        'REFUSAL_CORRECTNESS',
        'PROMPT_INJECTION_RESISTANCE',
      ].includes(threshold.metric) &&
      threshold.threshold > 1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: 'Rate thresholds must be between zero and one.',
      });
    }
  });

export const aiEvaluationVersionTargetsSchema = z
  .object({
    agentVersionIds: UNIQUE_UUIDS,
    knowledgeVersionIds: UNIQUE_UUIDS,
    toolVersionIds: UNIQUE_UUIDS,
    modelRoutes: z.array(SHORT_TEXT).max(100),
    promptHashes: z.array(SHA256).max(100),
  })
  .strict()
  .refine(
    (targets) =>
      targets.agentVersionIds.length > 0 ||
      targets.knowledgeVersionIds.length > 0 ||
      targets.toolVersionIds.length > 0 ||
      targets.modelRoutes.length > 0 ||
      targets.promptHashes.length > 0,
    {
      message: 'An evaluation version must bind at least one immutable target.',
      path: ['agentVersionIds'],
    },
  );

export const aiEvaluationCaseContextSchema = z
  .object({
    roleAssignmentId: UUID.nullable(),
    roleVersionId: UUID.nullable(),
    objectiveId: UUID.nullable(),
    objectiveVersion: z.number().int().positive().nullable(),
    processVersionId: UUID.nullable(),
    permissionLabels: z.array(SHORT_TEXT).max(100),
    knowledgeVersionIds: UNIQUE_UUIDS,
    toolVersionIds: UNIQUE_UUIDS,
    structuredContext: JSON_OBJECT,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.objectiveId === null) !== (value.objectiveVersion === null)) {
      context.addIssue({
        code: 'custom',
        path: ['objectiveVersion'],
        message: 'Objective identity requires both id and version.',
      });
    }
  });

export const aiEvaluationCaseSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    datasetVersionId: UUID,
    caseKey: CODE,
    category: aiEvaluationCategorySchema,
    input: LONG_TEXT,
    context: aiEvaluationCaseContextSchema,
    expectedBehavior: LONG_TEXT,
    requiredEvidenceIds: UNIQUE_UUIDS,
    forbiddenBehaviors: z.array(LONG_TEXT).max(100),
    scoring: z
      .object({
        judgeTypes: z.array(aiEvaluationJudgeTypeSchema).min(1).max(4),
        rubric: LONG_TEXT,
        metricWeights: z
          .array(
            z
              .object({
                metric: aiEvaluationMetricSchema,
                weight: z.number().finite().positive().max(1),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    sourceBadCaseId: UUID.nullable(),
    contentHash: SHA256,
    revision: z.number().int().positive(),
    createdAt: TIMESTAMP,
  })
  .strict()
  .superRefine((testCase, context) => {
    const metrics = testCase.scoring.metricWeights.map(({ metric }) => metric);
    if (new Set(metrics).size !== metrics.length) {
      context.addIssue({
        code: 'custom',
        path: ['scoring', 'metricWeights'],
        message: 'A metric can appear only once in a case rubric.',
      });
    }
    if (
      ['CITATION', 'FACTUALITY', 'GOAL_ALIGNMENT'].includes(testCase.category) &&
      testCase.requiredEvidenceIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requiredEvidenceIds'],
        message: 'Fact, citation, and goal cases require governed evidence.',
      });
    }
    if (testCase.category === 'SAFETY' && testCase.forbiddenBehaviors.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['forbiddenBehaviors'],
        message: 'Safety cases require at least one forbidden behavior.',
      });
    }
  });

export const aiEvaluationDatasetVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    datasetId: UUID,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    status: aiEvaluationDatasetStatusSchema,
    description: LONG_TEXT,
    targets: aiEvaluationVersionTargetsSchema,
    thresholds: z.array(aiEvaluationThresholdSchema).min(1).max(100),
    requiredCategories: z.array(aiEvaluationCategorySchema).min(1).max(9),
    caseCount: z.number().int().nonnegative(),
    annotationCoverage: z.number().finite().min(0).max(1),
    contentHash: SHA256,
    submittedByUserId: UUID.nullable(),
    submittedAt: TIMESTAMP.nullable(),
    reviewedByUserId: UUID.nullable(),
    reviewedAt: TIMESTAMP.nullable(),
    reviewEvidenceIds: UNIQUE_UUIDS,
    publishedByUserId: UUID.nullable(),
    publishedAt: TIMESTAMP.nullable(),
    retiredAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((version, context) => {
    const thresholdMetrics = version.thresholds.map(({ metric }) => metric);
    if (new Set(thresholdMetrics).size !== thresholdMetrics.length) {
      context.addIssue({
        code: 'custom',
        path: ['thresholds'],
        message: 'A dataset version can define a metric threshold only once.',
      });
    }
    if (new Set(version.requiredCategories).size !== version.requiredCategories.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredCategories'],
        message: 'Required categories must be unique.',
      });
    }
    if (version.status !== 'DRAFT' && version.caseCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['caseCount'],
        message: 'A governed dataset version cannot be empty.',
      });
    }
    if (
      ['APPROVED', 'PUBLISHED', 'RETIRED'].includes(version.status) &&
      (version.annotationCoverage !== 1 ||
        version.reviewedByUserId === null ||
        version.reviewedAt === null ||
        version.reviewEvidenceIds.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedByUserId'],
        message: 'Approval requires complete annotation and evidence-backed independent review.',
      });
    }
    if (
      version.reviewedByUserId !== null &&
      version.submittedByUserId !== null &&
      version.reviewedByUserId === version.submittedByUserId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedByUserId'],
        message: 'Dataset review must be independent from submission.',
      });
    }
    if (
      (version.status === 'PUBLISHED' || version.status === 'RETIRED') &&
      (version.publishedByUserId === null || version.publishedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['publishedAt'],
        message: 'Published dataset versions require publication attribution.',
      });
    }
    if ((version.status === 'RETIRED') !== (version.retiredAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['retiredAt'],
        message: 'Retirement state and timestamp must match.',
      });
    }
  });

export const aiEvaluationDatasetSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    code: CODE,
    name: z.string().trim().min(1).max(200),
    description: LONG_TEXT,
    latestVersion: z.number().int().nonnegative(),
    currentPublishedVersionId: UUID.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict();

export const aiEvaluationAnswerFeedbackCitationSchema = z
  .object({
    knowledgeBaseId: UUID,
    documentId: UUID,
    documentVersionId: UUID,
    chunkId: UUID,
  })
  .strict();

export const aiEvaluationAnswerFeedbackSourceSchema = z
  .object({
    feedbackId: UUID,
    conversationId: UUID,
    messageId: UUID,
    inputMessageId: UUID,
    agentRunId: UUID,
    agentId: UUID,
    agentVersionId: UUID,
    reportedByUserId: UUID,
    feedbackReason: z.enum([
      'INCORRECT',
      'IRRELEVANT_CITATION',
      'OUTDATED',
      'MISSING_KNOWLEDGE',
      'OTHER',
    ]),
    feedbackRecordedAt: TIMESTAMP,
    promptSnapshotHash: SHA256,
    answerSnapshotHash: SHA256,
    citationsSnapshotHash: SHA256,
    citations: z.array(aiEvaluationAnswerFeedbackCitationSchema).max(12),
  })
  .strict();

export const aiEvaluationBadCaseSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    sourceType: z.enum([
      'ANSWER_FEEDBACK',
      'AGENT_RUN',
      'CORRECTION',
      'TOOL_INVOCATION',
      'SECURITY_EVENT',
    ]),
    sourceId: UUID,
    sourceVersion: z.number().int().positive(),
    category: aiEvaluationCategorySchema,
    sanitizedInput: LONG_TEXT,
    sourceSnapshotHash: SHA256,
    answerFeedbackSource: aiEvaluationAnswerFeedbackSourceSchema.nullable(),
    status: aiEvaluationBadCaseStatusSchema,
    mappedDatasetVersionId: UUID.nullable(),
    mappedCaseId: UUID.nullable(),
    reportedByUserId: UUID,
    triagedByUserId: UUID.nullable(),
    triageReason: LONG_TEXT.nullable(),
    revision: z.number().int().positive(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((badCase, context) => {
    if (badCase.sourceType !== 'ANSWER_FEEDBACK') {
      if (badCase.answerFeedbackSource !== null) {
        context.addIssue({
          code: 'custom',
          path: ['answerFeedbackSource'],
          message: 'Only ANSWER_FEEDBACK bad cases can carry answer-feedback lineage.',
        });
      }
      return;
    }
    if (badCase.answerFeedbackSource === null) {
      context.addIssue({
        code: 'custom',
        path: ['answerFeedbackSource'],
        message: 'ANSWER_FEEDBACK bad cases require trusted automatic lineage.',
      });
      return;
    }
    if (
      badCase.answerFeedbackSource.feedbackId !== badCase.sourceId ||
      badCase.answerFeedbackSource.reportedByUserId !== badCase.reportedByUserId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['answerFeedbackSource'],
        message: 'Answer-feedback lineage must match the bad-case source and reporter.',
      });
    }
  });

export const aiEvaluationAnnotationSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    datasetVersionId: UUID,
    caseId: UUID,
    annotatorUserId: UUID,
    label: z.enum(['PASS', 'FAIL', 'ABSTAIN']),
    expectedScore: z.number().finite().min(0).max(1).nullable(),
    rationale: LONG_TEXT,
    evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
    revision: z.number().int().positive(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((annotation, context) => {
    if (annotation.label === 'ABSTAIN' && annotation.expectedScore !== null) {
      context.addIssue({
        code: 'custom',
        path: ['expectedScore'],
        message: 'An abstained annotation cannot carry an expected score.',
      });
    }
    if (annotation.label !== 'ABSTAIN' && annotation.expectedScore === null) {
      context.addIssue({
        code: 'custom',
        path: ['expectedScore'],
        message: 'A decisive annotation requires an expected score.',
      });
    }
  });

export const aiEvaluationMetricResultSchema = z
  .object({
    metric: aiEvaluationMetricSchema,
    numerator: z.number().finite().nonnegative(),
    denominator: z.number().finite().nonnegative(),
    value: z.number().finite().nonnegative(),
    threshold: z.number().finite().nonnegative(),
    direction: aiEvaluationThresholdDirectionSchema,
    sampleCount: z.number().int().nonnegative(),
    minimumSampleCount: z.number().int().positive(),
    passed: z.boolean(),
    evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
  })
  .strict()
  .superRefine((metric, context) => {
    const enoughSamples = metric.sampleCount >= metric.minimumSampleCount;
    const meets =
      metric.direction === 'AT_LEAST'
        ? metric.value >= metric.threshold
        : metric.direction === 'AT_MOST'
          ? metric.value <= metric.threshold
          : metric.value === 0 && metric.threshold === 0;
    if (metric.passed !== (enoughSamples && meets)) {
      context.addIssue({
        code: 'custom',
        path: ['passed'],
        message: 'Metric pass must match its threshold direction and minimum sample count.',
      });
    }
    if (metric.denominator === 0 && metric.numerator !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['numerator'],
        message: 'A zero denominator cannot have a non-zero numerator.',
      });
    }
  });

export const aiEvaluationRunSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    datasetVersionId: UUID,
    subjectType: aiEvaluationSubjectTypeSchema,
    subjectId: UUID,
    subjectVersion: z.number().int().positive(),
    subjectSnapshotHash: SHA256,
    status: aiEvaluationRunStatusSchema,
    runnerId: UUID,
    runnerName: SHORT_TEXT,
    runnerAttestationKeyFingerprint: SHA256,
    externalRunId: SHORT_TEXT,
    expectedCaseCount: z.number().int().positive(),
    submittedCaseCount: z.number().int().nonnegative(),
    evidenceBundleUri: CREDENTIAL_FREE_HTTPS_URL.nullable(),
    evidenceBundleHash: SHA256.nullable(),
    runnerAttestation: LONG_TEXT.nullable(),
    metrics: z.array(aiEvaluationMetricResultSchema).max(100),
    revision: z.number().int().positive(),
    startedAt: TIMESTAMP.nullable(),
    submittedAt: TIMESTAMP.nullable(),
    verifiedByUserId: UUID.nullable(),
    verifiedAt: TIMESTAMP.nullable(),
    finishedAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((run, context) => {
    const metricNames = run.metrics.map(({ metric }) => metric);
    if (new Set(metricNames).size !== metricNames.length) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'A Run can contain only one aggregate result per metric.',
      });
    }
    if (
      ['SUBMITTED', 'VERIFIED', 'PASSED', 'FAILED'].includes(run.status) &&
      (run.submittedCaseCount !== run.expectedCaseCount ||
        run.evidenceBundleUri === null ||
        run.evidenceBundleHash === null ||
        run.runnerAttestation === null ||
        run.submittedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['submittedCaseCount'],
        message:
          'Submitted results require complete case coverage and an attested evidence bundle.',
      });
    }
    if (
      ['VERIFIED', 'PASSED', 'FAILED'].includes(run.status) &&
      (run.verifiedByUserId === null || run.verifiedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['verifiedAt'],
        message: 'Verified results require human verification attribution.',
      });
    }
    if (['PASSED', 'FAILED', 'CANCELLED'].includes(run.status) !== (run.finishedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'Terminal Run state and finish timestamp must match.',
      });
    }
    if (run.status === 'PASSED' && run.metrics.some((metric) => !metric.passed)) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'A passing Run cannot contain a failed metric.',
      });
    }
    if (
      run.status === 'FAILED' &&
      run.metrics.length > 0 &&
      run.metrics.every((metric) => metric.passed)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'A failed Run must identify at least one failed metric.',
      });
    }
  });

export const aiEvaluationRunnerSchema = z
  .object({
    id: UUID,
    name: z.string().trim().min(1).max(200),
    status: z.literal('ACTIVE'),
    attestationKeyFingerprint: SHA256,
    allowedEvidenceOrigins: z.array(CANONICAL_HTTPS_ORIGIN).min(1).max(20),
  })
  .strict();

export const aiEvaluationReadinessSchema = z
  .object({
    subjectType: aiEvaluationSubjectTypeSchema,
    subjectId: UUID,
    subjectVersion: z.number().int().positive(),
    datasetVersionId: UUID,
    ready: z.boolean(),
    passingRunId: UUID.nullable(),
    evaluatedSnapshotHash: SHA256.nullable(),
    currentSnapshotHash: SHA256,
    blockers: z.array(
      z
        .object({
          code: z.enum([
            'DATASET_NOT_PUBLISHED',
            'DATASET_TARGET_MISMATCH',
            'NO_VERIFIED_RUN',
            'SUBJECT_SNAPSHOT_CHANGED',
            'CASE_COVERAGE_INCOMPLETE',
            'REQUIRED_CATEGORY_MISSING',
            'REQUIRED_METRIC_MISSING',
            'MINIMUM_SAMPLE_NOT_MET',
            'THRESHOLD_NOT_MET',
            'SECURITY_METRIC_FAILED',
            'RUNNER_EVIDENCE_UNVERIFIED',
          ]),
          detail: SHORT_TEXT,
          metric: aiEvaluationMetricSchema.nullable(),
        })
        .strict(),
    ),
    checkedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((readiness, context) => {
    if (
      readiness.ready !==
      (readiness.blockers.length === 0 &&
        readiness.passingRunId !== null &&
        readiness.evaluatedSnapshotHash === readiness.currentSnapshotHash)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ready'],
        message: 'Readiness must be false whenever a blocker or snapshot mismatch exists.',
      });
    }
  });

export const createAiEvaluationDatasetRequestSchema = z
  .object({
    code: CODE,
    name: z.string().trim().min(1).max(200),
    description: LONG_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const createAiEvaluationDatasetVersionRequestSchema = z
  .object({
    description: LONG_TEXT,
    targets: aiEvaluationVersionTargetsSchema,
    thresholds: z.array(aiEvaluationThresholdSchema).min(1).max(100),
    requiredCategories: z.array(aiEvaluationCategorySchema).min(1).max(9),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const createAiEvaluationCaseRequestSchema = z
  .object({
    caseKey: CODE,
    category: aiEvaluationCategorySchema,
    input: LONG_TEXT,
    context: aiEvaluationCaseContextSchema,
    expectedBehavior: LONG_TEXT,
    requiredEvidenceIds: UNIQUE_UUIDS,
    forbiddenBehaviors: z.array(LONG_TEXT).max(100),
    scoring: z
      .object({
        judgeTypes: z.array(aiEvaluationJudgeTypeSchema).min(1).max(4),
        rubric: LONG_TEXT,
        metricWeights: z
          .array(
            z
              .object({
                metric: aiEvaluationMetricSchema,
                weight: z.number().finite().positive().max(1),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    sourceBadCaseId: UUID.optional(),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .superRefine((testCase, context) => {
    const metrics = testCase.scoring.metricWeights.map(({ metric }) => metric);
    if (new Set(metrics).size !== metrics.length) {
      context.addIssue({
        code: 'custom',
        path: ['scoring', 'metricWeights'],
        message: 'A metric can appear only once in a case rubric.',
      });
    }
    if (
      ['CITATION', 'FACTUALITY', 'GOAL_ALIGNMENT'].includes(testCase.category) &&
      testCase.requiredEvidenceIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requiredEvidenceIds'],
        message: 'Fact, citation, and goal cases require governed evidence.',
      });
    }
    if (testCase.category === 'SAFETY' && testCase.forbiddenBehaviors.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['forbiddenBehaviors'],
        message: 'Safety cases require at least one forbidden behavior.',
      });
    }
  });

export const annotateAiEvaluationCaseRequestSchema = z
  .object({
    label: z.enum(['PASS', 'FAIL', 'ABSTAIN']),
    expectedScore: z.number().finite().min(0).max(1).nullable(),
    rationale: LONG_TEXT,
    evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.label === 'ABSTAIN') !== (request.expectedScore === null)) {
      context.addIssue({
        code: 'custom',
        path: ['expectedScore'],
        message: 'Only abstained annotations may omit expectedScore.',
      });
    }
  });

export const transitionAiEvaluationDatasetVersionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('SUBMIT'),
      expectedRevision: z.number().int().positive(),
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('APPROVE'),
      expectedRevision: z.number().int().positive(),
      evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
      reason: LONG_TEXT,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('REJECT'),
      expectedRevision: z.number().int().positive(),
      evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
      reason: LONG_TEXT,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('PUBLISH'),
      expectedRevision: z.number().int().positive(),
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('RETIRE'),
      expectedRevision: z.number().int().positive(),
      reason: LONG_TEXT,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
]);

export const createAiEvaluationRunRequestSchema = z
  .object({
    datasetVersionId: UUID,
    subjectType: aiEvaluationSubjectTypeSchema,
    subjectId: UUID,
    subjectVersion: z.number().int().positive(),
    subjectSnapshotHash: SHA256,
    runnerId: UUID,
    runnerName: SHORT_TEXT,
    externalRunId: SHORT_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const createAiEvaluationRunnerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    attestationKeyFingerprint: SHA256,
    allowedEvidenceOrigins: z.array(CANONICAL_HTTPS_ORIGIN).min(1).max(20),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.allowedEvidenceOrigins).size === request.allowedEvidenceOrigins.length,
    {
      path: ['allowedEvidenceOrigins'],
      message: 'Runner evidence origins must be unique.',
    },
  );

export const startAiEvaluationRunRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const submitAiEvaluationRunRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    caseResults: z
      .array(
        z
          .object({
            caseId: UUID,
            judgeType: aiEvaluationJudgeTypeSchema,
            passed: z.boolean(),
            score: z.number().finite().min(0).max(1),
            actualBehaviorHash: SHA256,
            evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
            detail: LONG_TEXT,
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
    metrics: z.array(aiEvaluationMetricResultSchema).min(1).max(100),
    evidenceBundleUri: CREDENTIAL_FREE_HTTPS_URL,
    evidenceBundleHash: SHA256,
    runnerAttestation: LONG_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.caseResults.map(({ caseId }) => caseId)).size === request.caseResults.length,
    { message: 'A Run can submit each case exactly once.', path: ['caseResults'] },
  );

export const verifyAiEvaluationRunRequestSchema = z
  .object({
    decision: z.enum(['PASS', 'FAIL']),
    expectedRevision: z.number().int().positive(),
    evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
    reason: LONG_TEXT,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const ingestAiEvaluationBadCaseRequestSchema = z
  .object({
    sourceType: z.enum(['AGENT_RUN', 'CORRECTION', 'TOOL_INVOCATION', 'SECURITY_EVENT']),
    sourceId: UUID,
    sourceVersion: z.number().int().positive(),
    category: aiEvaluationCategorySchema,
    sanitizedInput: LONG_TEXT,
    sourceSnapshotHash: SHA256,
    evidenceIds: NON_EMPTY_UNIQUE_UUIDS,
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .strict();

export const triageAiEvaluationBadCaseRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('ADD_TO_DATASET'),
      datasetVersionId: UUID,
      expectedRevision: z.number().int().positive(),
      reason: LONG_TEXT,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal('DISMISS'),
      datasetVersionId: z.undefined().optional(),
      expectedRevision: z.number().int().positive(),
      reason: LONG_TEXT,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    .strict(),
]);

export const aiEvaluationListQuerySchema = z
  .object({
    cursor: UUID.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const aiEvaluationRunListQuerySchema = aiEvaluationListQuerySchema
  .extend({
    subjectType: aiEvaluationSubjectTypeSchema.optional(),
    subjectId: UUID.optional(),
    subjectVersion: z.coerce.number().int().positive().optional(),
    status: aiEvaluationRunStatusSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    const subjectParts = [query.subjectType, query.subjectId, query.subjectVersion].filter(
      (part) => part !== undefined,
    ).length;
    if (subjectParts !== 0 && subjectParts !== 3) {
      context.addIssue({
        code: 'custom',
        path: ['subjectId'],
        message: 'Run subject filtering requires type, id, and version together.',
      });
    }
  });

export const aiEvaluationDatasetListResponseSchema = z
  .object({
    items: z.array(aiEvaluationDatasetSchema),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const aiEvaluationDatasetVersionListResponseSchema = z
  .object({
    items: z.array(aiEvaluationDatasetVersionSchema),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const aiEvaluationCaseListResponseSchema = z
  .object({
    items: z.array(aiEvaluationCaseSchema),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const aiEvaluationRunnerListResponseSchema = z
  .object({
    items: z.array(aiEvaluationRunnerSchema),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const aiEvaluationRunListResponseSchema = z
  .object({
    items: z.array(aiEvaluationRunSchema),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const aiEvaluationBadCaseListResponseSchema = z
  .object({
    items: z.array(aiEvaluationBadCaseSchema),
    nextCursor: UUID.nullable(),
  })
  .strict();

export const aiEvaluationReadinessQuerySchema = z
  .object({
    subjectType: aiEvaluationSubjectTypeSchema,
    subjectId: UUID,
    subjectVersion: z.coerce.number().int().positive(),
    datasetVersionId: UUID,
    currentSnapshotHash: SHA256,
    evaluationRunId: UUID.optional(),
  })
  .strict();

export type AiEvaluationCategory = z.infer<typeof aiEvaluationCategorySchema>;
export type AiEvaluationMetric = z.infer<typeof aiEvaluationMetricSchema>;
export type AiEvaluationDatasetStatus = z.infer<typeof aiEvaluationDatasetStatusSchema>;
export type AiEvaluationRunStatus = z.infer<typeof aiEvaluationRunStatusSchema>;
export type AiEvaluationSubjectType = z.infer<typeof aiEvaluationSubjectTypeSchema>;
export type AiEvaluationBadCaseStatus = z.infer<typeof aiEvaluationBadCaseStatusSchema>;
export type AiEvaluationJudgeType = z.infer<typeof aiEvaluationJudgeTypeSchema>;
export type AiEvaluationThresholdDirection = z.infer<typeof aiEvaluationThresholdDirectionSchema>;
export type AiEvaluationDataset = z.infer<typeof aiEvaluationDatasetSchema>;
export type AiEvaluationDatasetVersion = z.infer<typeof aiEvaluationDatasetVersionSchema>;
export type AiEvaluationCase = z.infer<typeof aiEvaluationCaseSchema>;
export type AiEvaluationAnswerFeedbackCitation = z.infer<
  typeof aiEvaluationAnswerFeedbackCitationSchema
>;
export type AiEvaluationAnswerFeedbackSource = z.infer<
  typeof aiEvaluationAnswerFeedbackSourceSchema
>;
export type AiEvaluationBadCase = z.infer<typeof aiEvaluationBadCaseSchema>;
export type AiEvaluationAnnotation = z.infer<typeof aiEvaluationAnnotationSchema>;
export type AiEvaluationRun = z.infer<typeof aiEvaluationRunSchema>;
export type AiEvaluationRunner = z.infer<typeof aiEvaluationRunnerSchema>;
export type AiEvaluationMetricResult = z.infer<typeof aiEvaluationMetricResultSchema>;
export type AiEvaluationReadiness = z.infer<typeof aiEvaluationReadinessSchema>;
export type AiEvaluationListQuery = z.infer<typeof aiEvaluationListQuerySchema>;
export type AiEvaluationRunListQuery = z.infer<typeof aiEvaluationRunListQuerySchema>;
export type AiEvaluationDatasetListResponse = z.infer<typeof aiEvaluationDatasetListResponseSchema>;
export type AiEvaluationRunListResponse = z.infer<typeof aiEvaluationRunListResponseSchema>;
export type AiEvaluationDatasetVersionListResponse = z.infer<
  typeof aiEvaluationDatasetVersionListResponseSchema
>;
export type AiEvaluationCaseListResponse = z.infer<typeof aiEvaluationCaseListResponseSchema>;
export type AiEvaluationRunnerListResponse = z.infer<typeof aiEvaluationRunnerListResponseSchema>;
export type AiEvaluationBadCaseListResponse = z.infer<typeof aiEvaluationBadCaseListResponseSchema>;
export type AiEvaluationReadinessQuery = z.infer<typeof aiEvaluationReadinessQuerySchema>;
export type CreateAiEvaluationDatasetRequest = z.infer<
  typeof createAiEvaluationDatasetRequestSchema
>;
export type CreateAiEvaluationDatasetVersionRequest = z.infer<
  typeof createAiEvaluationDatasetVersionRequestSchema
>;
export type CreateAiEvaluationCaseRequest = z.infer<typeof createAiEvaluationCaseRequestSchema>;
export type AnnotateAiEvaluationCaseRequest = z.infer<typeof annotateAiEvaluationCaseRequestSchema>;
export type TransitionAiEvaluationDatasetVersionRequest = z.infer<
  typeof transitionAiEvaluationDatasetVersionRequestSchema
>;
export type CreateAiEvaluationRunRequest = z.infer<typeof createAiEvaluationRunRequestSchema>;
export type CreateAiEvaluationRunnerRequest = z.infer<typeof createAiEvaluationRunnerRequestSchema>;
export type StartAiEvaluationRunRequest = z.infer<typeof startAiEvaluationRunRequestSchema>;
export type SubmitAiEvaluationRunRequest = z.infer<typeof submitAiEvaluationRunRequestSchema>;
export type VerifyAiEvaluationRunRequest = z.infer<typeof verifyAiEvaluationRunRequestSchema>;
export type IngestAiEvaluationBadCaseRequest = z.infer<
  typeof ingestAiEvaluationBadCaseRequestSchema
>;
export type TriageAiEvaluationBadCaseRequest = z.infer<
  typeof triageAiEvaluationBadCaseRequestSchema
>;
