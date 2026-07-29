import { z } from 'zod';

const UUID = z.uuid();
const TIMESTAMP = z.iso.datetime();
const SHORT_TEXT = z.string().trim().min(1).max(500);
const LONG_TEXT = z.string().trim().min(1).max(20_000);
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const JSON_OBJECT = z.record(z.string(), z.unknown());

export const toolDefinitionStatusSchema = z.enum(['DRAFT', 'TESTING', 'PUBLISHED', 'RETIRED']);

export const toolExecutionAdapterSchema = z.enum(['HTTP', 'INTERNAL', 'DATABASE', 'QUEUE']);

export const toolRiskClassSchema = z.enum([
  'READ_ONLY',
  'DRAFT_ONLY',
  'CONFIRM_REQUIRED',
  'HIGH_RISK_APPROVAL',
  'FORBIDDEN',
]);

export const toolDataClassificationSchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]);

export const toolIdempotencyModeSchema = z.enum([
  'REQUIRED',
  'PROVIDER_SUPPORTED',
  'SYSTEM_LEDGER',
]);

export const toolDryRunModeSchema = z.enum(['NATIVE', 'VALIDATE_ONLY', 'UNSUPPORTED']);

export const toolInvocationStatusSchema = z.enum([
  'REQUESTED',
  'POLICY_DENIED',
  'PENDING_CONFIRMATION',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED',
]);

export const toolJsonSchemaSchema = JSON_OBJECT.superRefine((schema, context) => {
  const budget = { nodes: 0 };
  validateToolSchemaNode(schema, context, [], budget, true);
});

export const toolDefinitionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.-]{2,99}$/u),
    name: z.string().trim().min(1).max(160),
    description: LONG_TEXT,
    ownerUserId: UUID,
    status: toolDefinitionStatusSchema,
    currentVersionId: UUID.nullable(),
    currentVersion: z.number().int().positive().nullable(),
    revision: z.number().int().positive(),
    permissionLabels: z
      .array(z.string().trim().min(1).max(160))
      .max(200)
      .refine(uniqueStrings, 'Permission labels must be unique.'),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .refine(
    (definition) => (definition.currentVersionId === null) === (definition.currentVersion === null),
    {
      path: ['currentVersionId'],
      message: 'Current Tool Version identity and number must be supplied together.',
    },
  );

export const toolVersionSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    toolId: UUID,
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.-]{2,99}$/u),
    name: z.string().trim().min(1).max(160),
    description: LONG_TEXT,
    ownerUserId: UUID,
    version: z.number().int().positive(),
    status: toolDefinitionStatusSchema,
    adapter: toolExecutionAdapterSchema,
    endpointRef: z.string().trim().min(1).max(300),
    inputSchema: toolJsonSchemaSchema,
    outputSchema: toolJsonSchemaSchema,
    riskClass: toolRiskClassSchema,
    dataClassification: toolDataClassificationSchema,
    timeoutMs: z.number().int().min(100).max(120_000),
    maxAttempts: z.number().int().min(1).max(5),
    idempotencyMode: toolIdempotencyModeSchema,
    dryRunMode: toolDryRunModeSchema,
    allowedHttpMethods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .max(5)
      .refine(uniqueStrings, 'HTTP methods must be unique.'),
    allowedHostPatterns: z
      .array(z.string().trim().min(1).max(253))
      .max(100)
      .refine(uniqueStrings, 'Allowed host patterns must be unique.'),
    compensationToolVersionId: UUID.nullable(),
    configurationHash: SHA256,
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.nullable(),
    publishedAt: TIMESTAMP.nullable(),
    retiredAt: TIMESTAMP.nullable(),
    createdAt: TIMESTAMP,
  })
  .strict()
  .superRefine((tool, context) => {
    if (
      tool.effectiveTo !== null &&
      Date.parse(tool.effectiveTo) <= Date.parse(tool.effectiveFrom)
    ) {
      issue(context, ['effectiveTo'], 'effectiveTo must be later than effectiveFrom.');
    }
    if (tool.status === 'PUBLISHED' && tool.publishedAt === null) {
      issue(context, ['publishedAt'], 'A published Tool Version requires publishedAt.');
    }
    if (tool.status === 'RETIRED' && tool.retiredAt === null) {
      issue(context, ['retiredAt'], 'A retired Tool Version requires retiredAt.');
    }
    if (tool.adapter !== 'HTTP' && tool.allowedHostPatterns.length > 0) {
      issue(
        context,
        ['allowedHostPatterns'],
        'Only HTTP Tool Versions can declare outbound host patterns.',
      );
    }
    if (tool.adapter === 'HTTP' && tool.allowedHostPatterns.length === 0) {
      issue(
        context,
        ['allowedHostPatterns'],
        'An HTTP Tool Version requires an explicit outbound host allowlist.',
      );
    }
    if (tool.adapter === 'HTTP' && tool.allowedHttpMethods.length === 0) {
      issue(
        context,
        ['allowedHttpMethods'],
        'An HTTP Tool Version requires at least one explicit HTTP method.',
      );
    }
    if (tool.adapter !== 'HTTP' && tool.allowedHttpMethods.length > 0) {
      issue(
        context,
        ['allowedHttpMethods'],
        'Only HTTP Tool Versions can declare outbound HTTP methods.',
      );
    }
    if (
      tool.adapter === 'HTTP' &&
      tool.riskClass === 'READ_ONLY' &&
      tool.allowedHttpMethods.some((method) => method !== 'GET')
    ) {
      issue(context, ['allowedHttpMethods'], 'A read-only HTTP Tool may use only GET.');
    }
    if (
      tool.adapter === 'HTTP' &&
      tool.riskClass === 'DRAFT_ONLY' &&
      tool.allowedHttpMethods.includes('DELETE')
    ) {
      issue(context, ['allowedHttpMethods'], 'A draft-only HTTP Tool cannot use DELETE.');
    }
    if (tool.compensationToolVersionId === tool.id) {
      issue(context, ['compensationToolVersionId'], 'A Tool Version cannot compensate itself.');
    }
    if (tool.riskClass === 'FORBIDDEN' && tool.status === 'PUBLISHED') {
      issue(context, ['status'], 'A forbidden Tool Version cannot be published.');
    }
  });

export const toolInvocationSchema = z
  .object({
    id: UUID,
    tenantId: UUID,
    toolId: UUID,
    toolVersionId: UUID,
    toolVersion: z.number().int().positive(),
    requesterUserId: UUID,
    roleAssignmentId: UUID,
    taskId: UUID,
    processInstanceId: UUID.nullable(),
    processStepInstanceId: UUID.nullable(),
    agentRunId: UUID.nullable(),
    correlationId: UUID,
    causationId: UUID.nullable(),
    retryOfInvocationId: UUID.nullable(),
    compensationForInvocationId: UUID.nullable(),
    riskClass: toolRiskClassSchema,
    status: toolInvocationStatusSchema,
    revision: z.number().int().positive(),
    dryRun: z.boolean(),
    input: JSON_OBJECT,
    inputHash: SHA256,
    policyDecisionId: z.string().trim().min(1).max(200),
    policySnapshot: JSON_OBJECT,
    confirmation: z
      .object({
        confirmedByUserId: UUID,
        confirmedAt: TIMESTAMP,
        reason: SHORT_TEXT,
      })
      .strict()
      .nullable(),
    approval: z
      .object({
        approverUserId: UUID,
        approverRoleAssignmentId: UUID,
        decision: z.enum(['APPROVED', 'REJECTED']),
        decidedAt: TIMESTAMP,
        reason: SHORT_TEXT,
      })
      .strict()
      .nullable(),
    executionAttempt: z.number().int().nonnegative().max(100),
    providerRequestId: z.string().trim().min(1).max(300).nullable(),
    output: JSON_OBJECT.nullable(),
    outputHash: SHA256.nullable(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    errorDetail: LONG_TEXT.nullable(),
    startedAt: TIMESTAMP.nullable(),
    completedAt: TIMESTAMP.nullable(),
    idempotencyKey: z.string().trim().min(1).max(200),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })
  .strict()
  .superRefine((invocation, context) => {
    if (invocation.processStepInstanceId !== null && invocation.processInstanceId === null) {
      issue(
        context,
        ['processInstanceId'],
        'A Process Step Tool Invocation requires its Process Instance.',
      );
    }
    if (
      invocation.retryOfInvocationId !== null &&
      invocation.retryOfInvocationId === invocation.id
    ) {
      issue(context, ['retryOfInvocationId'], 'A Tool Invocation cannot retry itself.');
    }
    if (
      invocation.compensationForInvocationId !== null &&
      invocation.compensationForInvocationId === invocation.id
    ) {
      issue(
        context,
        ['compensationForInvocationId'],
        'A Tool Invocation cannot compensate itself.',
      );
    }
    if (
      invocation.compensationForInvocationId !== null &&
      (invocation.causationId !== invocation.compensationForInvocationId ||
        invocation.retryOfInvocationId !== null ||
        invocation.dryRun ||
        invocation.input.operation !== 'COMPENSATE')
    ) {
      issue(
        context,
        ['compensationForInvocationId'],
        'A compensation must be a separate non-dry-run invocation causally bound to its original.',
      );
    }
    if (
      invocation.approval !== null &&
      (invocation.approval.approverUserId === invocation.requesterUserId ||
        invocation.approval.approverRoleAssignmentId === invocation.roleAssignmentId)
    ) {
      issue(
        context,
        ['approval', 'approverUserId'],
        'A requester cannot independently approve their own Tool Invocation.',
      );
    }
    if (
      invocation.confirmation !== null &&
      invocation.confirmation.confirmedByUserId !== invocation.requesterUserId
    ) {
      issue(
        context,
        ['confirmation', 'confirmedByUserId'],
        'Only the requester can confirm a Tool Invocation.',
      );
    }
    if (
      invocation.confirmation !== null &&
      !['CONFIRM_REQUIRED', 'HIGH_RISK_APPROVAL'].includes(invocation.riskClass)
    ) {
      issue(
        context,
        ['confirmation'],
        'Only a confirmation-gated Tool Invocation may carry requester confirmation.',
      );
    }
    if (invocation.approval !== null && invocation.riskClass !== 'HIGH_RISK_APPROVAL') {
      issue(
        context,
        ['approval'],
        'Only a high-risk Tool Invocation may carry an approval decision.',
      );
    }
    if (
      ['REQUESTED', 'POLICY_DENIED', 'PENDING_CONFIRMATION'].includes(invocation.status) &&
      (invocation.confirmation !== null || invocation.approval !== null)
    ) {
      issue(
        context,
        ['status'],
        'This Tool Invocation state cannot already carry confirmation or approval.',
      );
    }
    if (
      invocation.status === 'PENDING_APPROVAL' &&
      (invocation.riskClass !== 'HIGH_RISK_APPROVAL' ||
        invocation.confirmation === null ||
        invocation.approval !== null)
    ) {
      issue(
        context,
        ['status'],
        'Pending approval requires a confirmed high-risk Tool Invocation without a decision.',
      );
    }
    if (
      invocation.status === 'REJECTED' &&
      (invocation.riskClass !== 'HIGH_RISK_APPROVAL' ||
        invocation.confirmation === null ||
        invocation.approval?.decision !== 'REJECTED')
    ) {
      issue(
        context,
        ['approval'],
        'A rejected Tool Invocation requires a recorded independent rejection.',
      );
    }
    if (invocation.approval?.decision === 'REJECTED' && invocation.status !== 'REJECTED') {
      issue(
        context,
        ['approval', 'decision'],
        'A rejected approval decision requires rejected invocation state.',
      );
    }
    if (
      invocation.riskClass === 'HIGH_RISK_APPROVAL' &&
      [
        'APPROVED',
        'EXECUTING',
        'SUCCEEDED',
        'FAILED',
        'UNKNOWN',
        'COMPENSATING',
        'COMPENSATED',
        'COMPENSATION_FAILED',
      ].includes(invocation.status) &&
      (invocation.confirmation === null ||
        invocation.approval === null ||
        invocation.approval.decision !== 'APPROVED')
    ) {
      issue(
        context,
        ['approval'],
        'A high-risk Tool Invocation requires requester confirmation and independent approval.',
      );
    }
    if (
      invocation.riskClass === 'CONFIRM_REQUIRED' &&
      [
        'APPROVED',
        'EXECUTING',
        'SUCCEEDED',
        'FAILED',
        'UNKNOWN',
        'COMPENSATING',
        'COMPENSATED',
        'COMPENSATION_FAILED',
      ].includes(invocation.status) &&
      invocation.confirmation === null
    ) {
      issue(
        context,
        ['confirmation'],
        'This Tool Invocation requires requester confirmation before execution.',
      );
    }
    if (
      [
        'EXECUTING',
        'SUCCEEDED',
        'FAILED',
        'UNKNOWN',
        'COMPENSATING',
        'COMPENSATED',
        'COMPENSATION_FAILED',
      ].includes(invocation.status) &&
      invocation.startedAt === null
    ) {
      issue(context, ['startedAt'], 'An executed Tool Invocation requires startedAt.');
    }
    if (
      [
        'REJECTED',
        'POLICY_DENIED',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
        'COMPENSATED',
        'COMPENSATION_FAILED',
      ].includes(invocation.status) &&
      invocation.completedAt === null
    ) {
      issue(context, ['completedAt'], 'A terminal Tool Invocation requires completedAt.');
    }
    if (
      invocation.status === 'SUCCEEDED' &&
      (invocation.output === null || invocation.outputHash === null)
    ) {
      issue(context, ['output'], 'A succeeded Tool Invocation requires output and its hash.');
    }
    if ((invocation.output === null) !== (invocation.outputHash === null)) {
      issue(context, ['outputHash'], 'Tool output and outputHash must be supplied together.');
    }
    if (
      (invocation.errorCode === null) !== (invocation.errorDetail === null) ||
      (['FAILED', 'COMPENSATION_FAILED'].includes(invocation.status) &&
        invocation.errorCode === null)
    ) {
      issue(
        context,
        ['errorCode'],
        'Failed Tool Invocations require both errorCode and errorDetail.',
      );
    }
    if (
      Date.parse(invocation.updatedAt) < Date.parse(invocation.createdAt) ||
      (invocation.confirmation !== null &&
        (Date.parse(invocation.confirmation.confirmedAt) < Date.parse(invocation.createdAt) ||
          Date.parse(invocation.confirmation.confirmedAt) > Date.parse(invocation.updatedAt))) ||
      (invocation.approval !== null &&
        (Date.parse(invocation.approval.decidedAt) < Date.parse(invocation.createdAt) ||
          Date.parse(invocation.approval.decidedAt) > Date.parse(invocation.updatedAt) ||
          (invocation.confirmation !== null &&
            Date.parse(invocation.approval.decidedAt) <
              Date.parse(invocation.confirmation.confirmedAt)))) ||
      (invocation.startedAt !== null &&
        Date.parse(invocation.startedAt) < Date.parse(invocation.createdAt)) ||
      (invocation.completedAt !== null &&
        Date.parse(invocation.completedAt) <
          Date.parse(invocation.startedAt ?? invocation.createdAt)) ||
      (invocation.startedAt !== null &&
        Date.parse(invocation.startedAt) > Date.parse(invocation.updatedAt)) ||
      (invocation.completedAt !== null &&
        Date.parse(invocation.completedAt) > Date.parse(invocation.updatedAt))
    ) {
      issue(
        context,
        ['updatedAt'],
        'Tool Invocation timestamps must follow confirmation, approval, execution, and completion order.',
      );
    }
  });

export const createToolDefinitionRequestSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.-]{2,99}$/u),
    name: z.string().trim().min(1).max(160),
    description: LONG_TEXT,
    ownerUserId: UUID.optional(),
    permissionLabels: z
      .array(z.string().trim().min(1).max(160))
      .max(200)
      .refine(uniqueStrings, 'Permission labels must be unique.')
      .default([]),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const createToolVersionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: LONG_TEXT,
    ownerUserId: UUID.optional(),
    adapter: toolExecutionAdapterSchema,
    endpointRef: z.string().trim().min(1).max(300),
    inputSchema: toolJsonSchemaSchema,
    outputSchema: toolJsonSchemaSchema,
    riskClass: toolRiskClassSchema,
    dataClassification: toolDataClassificationSchema,
    timeoutMs: z.number().int().min(100).max(120_000),
    maxAttempts: z.number().int().min(1).max(5),
    idempotencyMode: toolIdempotencyModeSchema,
    dryRunMode: toolDryRunModeSchema,
    allowedHttpMethods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .max(5)
      .refine(uniqueStrings, 'HTTP methods must be unique.')
      .default([]),
    allowedHostPatterns: z
      .array(z.string().trim().min(1).max(253))
      .max(100)
      .refine(uniqueStrings, 'Allowed host patterns must be unique.')
      .default([]),
    sensitiveInputPaths: z
      .array(z.string().trim().min(1).max(500))
      .max(200)
      .refine(uniqueStrings, 'Sensitive input paths must be unique.')
      .default([]),
    compensationToolVersionId: UUID.optional(),
    effectiveFrom: TIMESTAMP,
    effectiveTo: TIMESTAMP.optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.effectiveTo !== undefined &&
      Date.parse(request.effectiveTo) <= Date.parse(request.effectiveFrom)
    ) {
      issue(context, ['effectiveTo'], 'effectiveTo must be later than effectiveFrom.');
    }
    if (request.adapter === 'HTTP' && request.allowedHostPatterns.length === 0) {
      issue(context, ['allowedHostPatterns'], 'An HTTP Tool requires an outbound host allowlist.');
    }
    if (request.adapter === 'HTTP' && request.allowedHttpMethods.length === 0) {
      issue(context, ['allowedHttpMethods'], 'An HTTP Tool requires an allowed HTTP method.');
    }
    if (
      request.adapter !== 'HTTP' &&
      (request.allowedHostPatterns.length > 0 || request.allowedHttpMethods.length > 0)
    ) {
      issue(
        context,
        ['allowedHostPatterns'],
        'Only an HTTP Tool may declare outbound HTTP configuration.',
      );
    }
    if (
      request.adapter === 'HTTP' &&
      request.riskClass === 'READ_ONLY' &&
      request.allowedHttpMethods.some((method) => method !== 'GET')
    ) {
      issue(context, ['allowedHttpMethods'], 'A read-only HTTP Tool may use only GET.');
    }
    if (
      request.adapter === 'HTTP' &&
      request.riskClass === 'DRAFT_ONLY' &&
      request.allowedHttpMethods.includes('DELETE')
    ) {
      issue(context, ['allowedHttpMethods'], 'A draft-only HTTP Tool cannot use DELETE.');
    }
  });

export const toolVersionLifecycleRequestSchema = z
  .object({
    action: z.enum(['TEST', 'PUBLISH', 'RETIRE']),
    expectedDefinitionRevision: z.number().int().positive(),
    reason: SHORT_TEXT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const toolDefinitionDetailSchema = z
  .object({
    definition: toolDefinitionSchema,
    versions: z.array(toolVersionSchema).max(500),
  })
  .strict();

export const toolDefinitionListResponseSchema = z
  .object({
    items: z.array(toolDefinitionSchema).max(500),
    nextCursor: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

export const createToolInvocationRequestSchema = z
  .object({
    toolVersionId: UUID,
    taskId: UUID,
    processInstanceId: UUID.optional(),
    processStepInstanceId: UUID.optional(),
    agentRunId: UUID.optional(),
    correlationId: UUID,
    causationId: UUID.optional(),
    dryRun: z.boolean().default(false),
    input: JSON_OBJECT,
    reason: SHORT_TEXT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(
    (request) =>
      request.processStepInstanceId === undefined || request.processInstanceId !== undefined,
    {
      path: ['processInstanceId'],
      message: 'A Process Step Tool Invocation requires its Process Instance.',
    },
  );

export const toolInvocationDecisionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum(['CONFIRM', 'APPROVE', 'REJECT', 'CANCEL', 'RETRY', 'RECONCILE']),
    reason: SHORT_TEXT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * Requests an independently gated compensation invocation for one completed
 * side-effecting invocation. The server derives the compensation payload from
 * the immutable original invocation; callers cannot provide or override any
 * provider identity, input hash, output hash, or compensation Tool Version.
 */
export const createToolCompensationRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: SHORT_TEXT,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const toolInvocationListResponseSchema = z
  .object({
    items: z.array(toolInvocationSchema).max(500),
    nextCursor: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

export const toolReconciliationStatusSchema = z
  .object({
    invocationId: UUID,
    state: z.enum(['NONE', 'PENDING', 'INCONCLUSIVE', 'RESOLVED']),
    attemptId: UUID.nullable(),
    eligibility: z.enum(['READ_ONLY', 'PROVIDER_IDEMPOTENT', 'INELIGIBLE']).nullable(),
    resolution: z.enum(['SUCCEEDED', 'FAILED', 'INCONCLUSIVE']).nullable(),
    reasonCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,120}$/u)
      .nullable(),
    requestedAt: TIMESTAMP.nullable(),
    completedAt: TIMESTAMP.nullable(),
  })
  .strict();

export const availableToolSchema = z
  .object({
    toolId: UUID,
    toolVersionId: UUID,
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.-]{2,99}$/u),
    name: z.string().trim().min(1).max(160),
    description: LONG_TEXT,
    version: z.number().int().positive(),
    inputSchema: toolJsonSchemaSchema,
    outputSchema: toolJsonSchemaSchema,
    riskClass: toolRiskClassSchema,
    dataClassification: toolDataClassificationSchema,
    dryRunMode: toolDryRunModeSchema,
    requiresConfirmation: z.boolean(),
    requiresApproval: z.boolean(),
  })
  .strict()
  .superRefine((tool, context) => {
    const confirmationRequired = ['CONFIRM_REQUIRED', 'HIGH_RISK_APPROVAL'].includes(
      tool.riskClass,
    );
    const approvalRequired = tool.riskClass === 'HIGH_RISK_APPROVAL';
    if (tool.requiresConfirmation !== confirmationRequired) {
      issue(
        context,
        ['requiresConfirmation'],
        'Confirmation metadata must match the Tool risk class.',
      );
    }
    if (tool.requiresApproval !== approvalRequired) {
      issue(context, ['requiresApproval'], 'Approval metadata must match the Tool risk class.');
    }
  });

export const availableToolListResponseSchema = z
  .object({
    items: z.array(availableToolSchema).max(500),
  })
  .strict();

export type ToolDefinitionStatus = z.infer<typeof toolDefinitionStatusSchema>;
export type ToolRiskClass = z.infer<typeof toolRiskClassSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolVersion = z.infer<typeof toolVersionSchema>;
export type ToolInvocationStatus = z.infer<typeof toolInvocationStatusSchema>;
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type ToolInvocationListResponse = z.infer<typeof toolInvocationListResponseSchema>;
export type CreateToolDefinitionRequest = z.infer<typeof createToolDefinitionRequestSchema>;
export type CreateToolVersionRequest = z.infer<typeof createToolVersionRequestSchema>;
export type ToolVersionLifecycleRequest = z.infer<typeof toolVersionLifecycleRequestSchema>;
export type ToolDefinitionDetail = z.infer<typeof toolDefinitionDetailSchema>;
export type ToolDefinitionListResponse = z.infer<typeof toolDefinitionListResponseSchema>;
export type CreateToolInvocationRequest = z.infer<typeof createToolInvocationRequestSchema>;
export type CreateToolCompensationRequest = z.infer<typeof createToolCompensationRequestSchema>;
export type ToolInvocationDecisionRequest = z.infer<typeof toolInvocationDecisionRequestSchema>;
export type ToolReconciliationStatus = z.infer<typeof toolReconciliationStatusSchema>;
export type AvailableTool = z.infer<typeof availableToolSchema>;
export type AvailableToolListResponse = z.infer<typeof availableToolListResponseSchema>;

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function validateToolSchemaNode(
  schema: Record<string, unknown>,
  context: z.RefinementCtx,
  path: PropertyKey[],
  budget: { nodes: number },
  root: boolean,
): void {
  budget.nodes += 1;
  if (path.length > 40 || budget.nodes > 5_000) {
    issue(context, path, 'Tool JSON Schema exceeds the supported complexity limit.');
    return;
  }
  for (const keyword of [
    '$ref',
    '$dynamicRef',
    '$id',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'patternProperties',
    'unevaluatedProperties',
    'dependentSchemas',
  ]) {
    if (keyword in schema) {
      issue(context, [...path, keyword], `Unsupported Tool JSON Schema keyword ${keyword}.`);
    }
  }

  const type = schema.type;
  if (
    typeof type !== 'string' ||
    !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)
  ) {
    issue(
      context,
      [...path, 'type'],
      root
        ? 'A Tool input/output schema must have JSON Schema type object.'
        : 'Every Tool schema property requires one supported explicit type.',
    );
    return;
  }
  if (root && type !== 'object') {
    issue(
      context,
      [...path, 'type'],
      'A Tool input/output schema must have JSON Schema type object.',
    );
  }

  if (type === 'object') {
    if (schema.additionalProperties !== false) {
      issue(
        context,
        [...path, 'additionalProperties'],
        'Every object in a Tool schema must explicitly reject additional properties.',
      );
    }
    const properties = schema.properties;
    if (!isRecord(properties)) {
      issue(context, [...path, 'properties'], 'A Tool object schema requires a properties object.');
      return;
    }
    const propertyNames = Object.keys(properties);
    if (propertyNames.some((name) => ['__proto__', 'prototype', 'constructor'].includes(name))) {
      issue(context, [...path, 'properties'], 'Unsafe Tool schema property name.');
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((property) => typeof property !== 'string') ||
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some((property) => !(property in properties)))
    ) {
      issue(
        context,
        [...path, 'required'],
        'Required properties must be unique strings declared in properties.',
      );
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema)) {
        issue(context, [...path, 'properties', name], 'A property schema must be an object.');
        continue;
      }
      validateToolSchemaNode(propertySchema, context, [...path, 'properties', name], budget, false);
    }
  } else if (type === 'array') {
    if (!isRecord(schema.items)) {
      issue(context, [...path, 'items'], 'A Tool array schema requires one closed item schema.');
      return;
    }
    validateToolSchemaNode(schema.items, context, [...path, 'items'], budget, false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
