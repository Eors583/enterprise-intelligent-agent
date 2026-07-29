import { describe, expect, it } from 'vitest';

import {
  availableToolSchema,
  createToolCompensationRequestSchema,
  createToolDefinitionRequestSchema,
  createToolInvocationRequestSchema,
  createToolVersionRequestSchema,
  toolInvocationSchema,
  toolJsonSchemaSchema,
  toolReconciliationStatusSchema,
  toolVersionSchema,
} from '../src/tool-gateway.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000001';
const TOOL_ID = '00000000-0000-7000-8000-000000000002';
const TOOL_VERSION_ID = '00000000-0000-7000-8000-000000000003';
const USER_ID = '00000000-0000-7000-8000-000000000004';
const APPROVER_ID = '00000000-0000-7000-8000-000000000005';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000006';
const APPROVER_ASSIGNMENT_ID = '00000000-0000-7000-8000-000000000007';
const TASK_ID = '00000000-0000-7000-8000-000000000008';
const CORRELATION_ID = '00000000-0000-7000-8000-000000000009';
const INVOCATION_ID = '00000000-0000-7000-8000-000000000010';
const HASH = 'a'.repeat(64);
const CREATED_AT = '2026-07-28T00:00:00.000Z';

describe('Tool Gateway contracts', () => {
  it('does not let a compensation caller override immutable provider bindings', () => {
    expect(
      createToolCompensationRequestSchema.safeParse({
        expectedRevision: 4,
        reason: '撤销已确认的外部写操作',
        idempotencyKey: 'compensate-1',
      }).success,
    ).toBe(true);
    expect(
      createToolCompensationRequestSchema.safeParse({
        expectedRevision: 4,
        reason: '撤销已确认的外部写操作',
        idempotencyKey: 'compensate-1',
        input: { attackerControlled: true },
        providerRequestId: 'forged-provider-request',
        compensationToolVersionId: TOOL_VERSION_ID,
      }).success,
    ).toBe(false);
  });

  it('requires closed object JSON Schemas with valid required properties', () => {
    expect(
      toolJsonSchemaSchema.safeParse({
        type: 'object',
        additionalProperties: false,
        properties: { customerId: { type: 'string' } },
        required: ['customerId'],
      }).success,
    ).toBe(true);
    expect(
      toolJsonSchemaSchema.safeParse({
        type: 'object',
        properties: { customerId: { type: 'string' } },
      }).success,
    ).toBe(false);
    expect(
      toolJsonSchemaSchema.safeParse({
        type: 'object',
        additionalProperties: false,
        properties: {
          customer: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      toolJsonSchemaSchema.safeParse({
        type: 'object',
        additionalProperties: false,
        properties: {
          customer: { $ref: 'https://attacker.example/schema.json' },
        },
      }).success,
    ).toBe(false);
    expect(
      toolJsonSchemaSchema.safeParse({
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: ['undeclared'],
      }).success,
    ).toBe(false);
  });

  it('requires an explicit outbound allowlist only for HTTP tools', () => {
    expect(toolVersionSchema.safeParse(toolVersion()).success).toBe(true);
    expect(
      toolVersionSchema.safeParse({
        ...toolVersion(),
        allowedHostPatterns: [],
      }).success,
    ).toBe(false);
    expect(
      toolVersionSchema.safeParse({
        ...toolVersion(),
        adapter: 'INTERNAL',
      }).success,
    ).toBe(false);
  });

  it('publishes only an employee-safe available Tool projection with exact risk gates', () => {
    const available = {
      toolId: TOOL_ID,
      toolVersionId: TOOL_VERSION_ID,
      key: 'crm.customer.read',
      name: 'Read CRM customer',
      description: 'Reads a customer record without mutating the CRM.',
      version: 1,
      inputSchema: toolVersion().inputSchema,
      outputSchema: toolVersion().outputSchema,
      riskClass: 'READ_ONLY',
      dataClassification: 'CONFIDENTIAL',
      dryRunMode: 'NATIVE',
      requiresConfirmation: false,
      requiresApproval: false,
    } as const;
    expect(availableToolSchema.safeParse(available).success).toBe(true);
    expect(
      availableToolSchema.safeParse({
        ...available,
        endpointRef: 'secret://tenant/crm/customer-read',
      }).success,
    ).toBe(false);
    expect(
      availableToolSchema.safeParse({
        ...available,
        riskClass: 'HIGH_RISK_APPROVAL',
        requiresConfirmation: true,
        requiresApproval: false,
      }).success,
    ).toBe(false);
  });

  it('forbids publishing a tool whose risk class is forbidden', () => {
    expect(
      toolVersionSchema.safeParse({
        ...toolVersion(),
        riskClass: 'FORBIDDEN',
      }).success,
    ).toBe(false);
  });

  it('keeps read-only HTTP methods non-mutating and compensation non-recursive', () => {
    expect(
      toolVersionSchema.safeParse({
        ...toolVersion(),
        allowedHttpMethods: ['POST'],
      }).success,
    ).toBe(false);
    expect(
      toolVersionSchema.safeParse({
        ...toolVersion(),
        compensationToolVersionId: TOOL_VERSION_ID,
      }).success,
    ).toBe(false);
  });

  it('does not let a client declare tenant, employee, assignment, or approval identity', () => {
    expect(
      createToolInvocationRequestSchema.safeParse({
        toolVersionId: TOOL_VERSION_ID,
        taskId: TASK_ID,
        correlationId: CORRELATION_ID,
        input: { customerId: 'customer-1' },
        reason: 'Read the customer profile.',
        idempotencyKey: 'customer-read-1',
        requesterUserId: USER_ID,
      }).success,
    ).toBe(false);
  });

  it('validates admin registration without accepting tenant identity or open schemas', () => {
    expect(
      createToolDefinitionRequestSchema.safeParse({
        key: 'crm.customer.read',
        name: 'Read customer',
        description: 'Reads a customer through a governed connector.',
        permissionLabels: ['crm.read'],
        idempotencyKey: 'tool-definition-1',
      }).success,
    ).toBe(true);
    expect(
      createToolDefinitionRequestSchema.safeParse({
        key: 'crm.customer.read',
        name: 'Read customer',
        description: 'Reads a customer through a governed connector.',
        permissionLabels: [],
        idempotencyKey: 'tool-definition-1',
        tenantId: TENANT_ID,
      }).success,
    ).toBe(false);
    expect(
      createToolVersionRequestSchema.safeParse({
        name: 'Read customer',
        description: 'Reads a customer through a governed connector.',
        adapter: 'HTTP',
        endpointRef: 'secret://tenant/crm/customer',
        inputSchema: toolVersion().inputSchema,
        outputSchema: toolVersion().outputSchema,
        riskClass: 'READ_ONLY',
        dataClassification: 'CONFIDENTIAL',
        timeoutMs: 5_000,
        maxAttempts: 2,
        idempotencyMode: 'REQUIRED',
        dryRunMode: 'VALIDATE_ONLY',
        allowedHttpMethods: ['GET'],
        allowedHostPatterns: ['crm.example.com'],
        sensitiveInputPaths: [],
        effectiveFrom: CREATED_AT,
        idempotencyKey: 'tool-version-1',
      }).success,
    ).toBe(true);
    expect(
      createToolVersionRequestSchema.safeParse({
        name: 'Read customer',
        description: 'Reads a customer through a governed connector.',
        adapter: 'HTTP',
        endpointRef: 'secret://tenant/crm/customer',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        outputSchema: toolVersion().outputSchema,
        riskClass: 'READ_ONLY',
        dataClassification: 'CONFIDENTIAL',
        timeoutMs: 5_000,
        maxAttempts: 2,
        idempotencyMode: 'REQUIRED',
        dryRunMode: 'VALIDATE_ONLY',
        allowedHttpMethods: ['GET'],
        allowedHostPatterns: ['crm.example.com'],
        effectiveFrom: CREATED_AT,
        idempotencyKey: 'tool-version-2',
      }).success,
    ).toBe(false);
  });

  it('requires an independent approval and confirmation before high-risk execution', () => {
    expect(toolInvocationSchema.safeParse(highRiskInvocation()).success).toBe(true);
    expect(
      toolInvocationSchema.safeParse({
        ...highRiskInvocation(),
        approval: null,
      }).success,
    ).toBe(false);
    expect(
      toolInvocationSchema.safeParse({
        ...highRiskInvocation(),
        confirmation: {
          ...highRiskInvocation().confirmation,
          confirmedByUserId: APPROVER_ID,
        },
      }).success,
    ).toBe(false);
    expect(
      toolInvocationSchema.safeParse({
        ...highRiskInvocation(),
        approval: {
          ...highRiskInvocation().approval,
          approverRoleAssignmentId: ASSIGNMENT_ID,
        },
      }).success,
    ).toBe(false);
    expect(
      toolInvocationSchema.safeParse({
        ...highRiskInvocation(),
        approval: {
          ...highRiskInvocation().approval,
          approverUserId: USER_ID,
        },
      }).success,
    ).toBe(false);
  });

  it('requires immutable-result shape for a succeeded invocation', () => {
    expect(
      toolInvocationSchema.safeParse({
        ...highRiskInvocation(),
        outputHash: null,
      }).success,
    ).toBe(false);
  });

  it('does not admit state snapshots that skip or contradict the approval flow', () => {
    const base = highRiskInvocation();
    expect(
      toolInvocationSchema.safeParse({
        ...base,
        status: 'PENDING_APPROVAL',
        confirmation: null,
        approval: null,
        executionAttempt: 0,
        providerRequestId: null,
        output: null,
        outputHash: null,
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(false);
    expect(
      toolInvocationSchema.safeParse({
        ...base,
        approval: { ...base.approval, decision: 'REJECTED' },
      }).success,
    ).toBe(false);
  });

  it('requires terminal timestamps and keeps execution inside the snapshot time', () => {
    const base = highRiskInvocation();
    expect(
      toolInvocationSchema.safeParse({
        ...base,
        riskClass: 'READ_ONLY',
        status: 'POLICY_DENIED',
        confirmation: null,
        approval: null,
        executionAttempt: 0,
        providerRequestId: null,
        output: null,
        outputHash: null,
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(false);
    expect(
      toolInvocationSchema.safeParse({
        ...base,
        updatedAt: '2026-07-28T00:03:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('exposes only safe reconciliation state and rejects provider credentials', () => {
    const status = {
      invocationId: INVOCATION_ID,
      state: 'INCONCLUSIVE',
      attemptId: '00000000-0000-7000-8000-000000000011',
      eligibility: 'PROVIDER_IDEMPOTENT',
      resolution: 'INCONCLUSIVE',
      reasonCode: 'TOOL_RECONCILIATION_PENDING',
      requestedAt: CREATED_AT,
      completedAt: '2026-07-28T00:00:01.000Z',
    } as const;
    expect(toolReconciliationStatusSchema.safeParse(status).success).toBe(true);
    expect(
      toolReconciliationStatusSchema.safeParse({
        ...status,
        endpoint: 'https://secret.example.test/status',
        headers: { authorization: 'Bearer secret' },
      }).success,
    ).toBe(false);
  });
});

function toolVersion() {
  return {
    id: TOOL_VERSION_ID,
    tenantId: TENANT_ID,
    toolId: TOOL_ID,
    key: 'crm.customer.read',
    name: 'Read CRM customer',
    description: 'Reads a customer record without mutating the CRM.',
    ownerUserId: USER_ID,
    version: 1,
    status: 'PUBLISHED',
    adapter: 'HTTP',
    endpointRef: 'secret://tenant/crm/customer-read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: ['customer'],
    },
    riskClass: 'READ_ONLY',
    dataClassification: 'CONFIDENTIAL',
    timeoutMs: 5_000,
    maxAttempts: 2,
    idempotencyMode: 'REQUIRED',
    dryRunMode: 'NATIVE',
    allowedHttpMethods: ['GET'],
    allowedHostPatterns: ['crm.example.com'],
    compensationToolVersionId: null,
    configurationHash: HASH,
    effectiveFrom: CREATED_AT,
    effectiveTo: null,
    publishedAt: CREATED_AT,
    retiredAt: null,
    createdAt: CREATED_AT,
  } as const;
}

function highRiskInvocation() {
  return {
    id: INVOCATION_ID,
    tenantId: TENANT_ID,
    toolId: TOOL_ID,
    toolVersionId: TOOL_VERSION_ID,
    toolVersion: 1,
    requesterUserId: USER_ID,
    roleAssignmentId: ASSIGNMENT_ID,
    taskId: TASK_ID,
    processInstanceId: null,
    processStepInstanceId: null,
    agentRunId: null,
    correlationId: CORRELATION_ID,
    causationId: null,
    retryOfInvocationId: null,
    compensationForInvocationId: null,
    riskClass: 'HIGH_RISK_APPROVAL',
    status: 'SUCCEEDED',
    revision: 4,
    dryRun: false,
    input: { amount: 1_000 },
    inputHash: HASH,
    policyDecisionId: 'authz-decision-1',
    policySnapshot: { schemaVersion: 1 },
    confirmation: {
      confirmedByUserId: USER_ID,
      confirmedAt: '2026-07-28T00:01:00.000Z',
      reason: 'I confirm the requested action.',
    },
    approval: {
      approverUserId: APPROVER_ID,
      approverRoleAssignmentId: APPROVER_ASSIGNMENT_ID,
      decision: 'APPROVED',
      decidedAt: '2026-07-28T00:02:00.000Z',
      reason: 'Reviewed against the approved change.',
    },
    executionAttempt: 1,
    providerRequestId: 'provider-request-1',
    output: { changeId: 'change-1' },
    outputHash: HASH,
    errorCode: null,
    errorDetail: null,
    startedAt: '2026-07-28T00:03:00.000Z',
    completedAt: '2026-07-28T00:03:01.000Z',
    idempotencyKey: 'tool-invocation-1',
    createdAt: CREATED_AT,
    updatedAt: '2026-07-28T00:03:01.000Z',
  } as const;
}
