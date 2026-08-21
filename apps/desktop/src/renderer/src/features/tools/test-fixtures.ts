import type { AvailableTool, ToolInvocation } from '@enterprise/contracts';

const IDS = {
  tenant: '10000000-0000-7000-8000-000000000001',
  tool: '10000000-0000-7000-8000-000000000002',
  version: '10000000-0000-7000-8000-000000000003',
  user: '10000000-0000-7000-8000-000000000004',
  assignment: '10000000-0000-7000-8000-000000000005',
  task: '10000000-0000-7000-8000-000000000006',
  correlation: '10000000-0000-7000-8000-000000000007',
  invocation: '10000000-0000-7000-8000-000000000008',
} as const;

const CLOSED_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { customerId: { type: 'string' } },
  required: ['customerId'],
} as const;

const CLOSED_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { customerName: { type: 'string' } },
  required: ['customerName'],
} as const;

export function availableToolFixture(override: Partial<AvailableTool> = {}): AvailableTool {
  return {
    toolId: IDS.tool,
    toolVersionId: IDS.version,
    key: 'crm.customer.read',
    name: '查询客户档案',
    description: '通过受控连接器读取当前任务授权的客户档案。',
    version: 2,
    inputSchema: CLOSED_INPUT_SCHEMA,
    outputSchema: CLOSED_OUTPUT_SCHEMA,
    riskClass: 'CONFIRM_REQUIRED',
    dataClassification: 'CONFIDENTIAL',
    dryRunMode: 'NATIVE',
    requiresConfirmation: true,
    requiresApproval: false,
    ...override,
  };
}

export function toolInvocationFixture(override: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    id: IDS.invocation,
    tenantId: IDS.tenant,
    toolId: IDS.tool,
    toolVersionId: IDS.version,
    toolVersion: 2,
    requesterUserId: IDS.user,
    roleAssignmentId: IDS.assignment,
    taskId: IDS.task,
    processInstanceId: null,
    processStepInstanceId: null,
    agentRunId: null,
    correlationId: IDS.correlation,
    causationId: null,
    retryOfInvocationId: null,
    compensationForInvocationId: null,
    riskClass: 'CONFIRM_REQUIRED',
    status: 'PENDING_CONFIRMATION',
    revision: 2,
    dryRun: false,
    input: { customerId: 'customer-1' },
    inputHash: 'a'.repeat(64),
    policyDecisionId: 'tool-policy:customer-read',
    policySnapshot: {
      schemaVersion: 1,
      reasonCode: 'CONFIRMATION_REQUIRED',
    },
    confirmation: null,
    approval: null,
    executionAttempt: 0,
    providerRequestId: null,
    output: null,
    outputHash: null,
    errorCode: null,
    errorDetail: null,
    startedAt: null,
    completedAt: null,
    idempotencyKey: 'desktop-tool:customer-read',
    createdAt: '2026-07-28T06:00:00.000Z',
    updatedAt: '2026-07-28T06:00:00.000Z',
    ...override,
  };
}

export const toolFixtureIds = IDS;
