import type { ToolInvocationStatus, ToolRiskClass, ToolVersion } from '@enterprise/contracts';

import type { ToolInvocationCommand } from './tool-invocation-state-machine.js';

export const TOOL_INVOCATION_COMMAND_EVENT_TYPE = 'ToolInvocationCommandRecorded';

export interface ClaimedToolExecutionEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly eventType: typeof TOOL_INVOCATION_COMMAND_EVENT_TYPE;
  readonly payload: unknown;
  readonly attempts: number;
  readonly firstAttemptedAt: Date;
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
}

export interface ParsedToolCommandEvent {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly command: ToolInvocationCommand;
  readonly expectedRevision: number;
  readonly resultRevision: number;
}

export interface PreparedToolExecution {
  readonly id: string;
  readonly tenantId: string;
  readonly toolId: string;
  readonly toolVersionId: string;
  readonly toolVersion: number;
  readonly configurationHash: string;
  readonly endpointRef: string;
  readonly adapter: ToolVersion['adapter'];
  readonly riskClass: ToolRiskClass;
  readonly dataClassification: ToolVersion['dataClassification'];
  readonly idempotencyMode: ToolVersion['idempotencyMode'];
  readonly dryRunMode: ToolVersion['dryRunMode'];
  readonly requesterUserId: string;
  readonly roleAssignmentId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly status: ToolInvocationStatus;
  readonly revision: number;
  readonly providerRequestId: string;
  readonly providerDryRun: boolean;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputHash: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly allowedHttpMethods: readonly string[];
  readonly allowedHostPatterns: readonly string[];
  readonly executionAttempt: number;
  readonly startedAt: Date | null;
}

export type ToolExecutionStartResult =
  | {
      readonly kind: 'started';
      readonly execution: PreparedToolExecution;
    }
  | {
      readonly kind: 'deferred';
      readonly reasonCode: 'TOOL_CONCURRENCY_LIMIT' | 'TOOL_RATE_LIMIT';
      readonly availableAt: Date;
    }
  | {
      readonly kind: 'stale';
    };

export type ToolExecutionInspection =
  | { readonly kind: 'ready'; readonly execution: PreparedToolExecution }
  | {
      readonly kind: 'ambiguous_dispatch';
      readonly execution: PreparedToolExecution;
      readonly reasonCode: 'TOOL_PROVIDER_DISPATCH_AMBIGUOUS';
    }
  | {
      readonly kind: 'skip';
      readonly reasonCode:
        | 'COMMAND_DOES_NOT_START_EXECUTION'
        | 'EXECUTION_EVENT_ALREADY_SETTLED'
        | 'EXECUTION_START_EVENT_RECORDED'
        | 'STALE_EXECUTION_EVENT';
      readonly providerRequestId: string | null;
    };

export interface ToolDnsProofInput {
  readonly tenantId: string;
  readonly invocationId: string;
  readonly invocationRevision: number;
  readonly requestedUrl: string;
  readonly hostname: string;
  readonly tlsServerName: string;
  readonly addresses: readonly string[];
  readonly pinnedIpAddress: string | null;
  readonly resolverName: string;
  readonly ttlSeconds: number;
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly decisionReason: string;
  readonly resolvedAt: Date;
  readonly expiresAt: Date;
}

export interface ToolExecutionSettlement {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  readonly providerRequestId: string;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly cost:
    | { readonly kind: 'UNATTESTED' }
    | { readonly kind: 'PROVIDER_ATTESTED'; readonly costMicros: bigint }
    | { readonly kind: 'GATEWAY_ATTESTED'; readonly costMicros: 0n };
}

const COMMANDS = new Set<ToolInvocationCommand>([
  'DENY',
  'REQUEST_CONFIRMATION',
  'CONFIRM',
  'REQUEST_APPROVAL',
  'APPROVE',
  'REJECT',
  'START',
  'SUCCEED',
  'FAIL',
  'MARK_UNKNOWN',
  'CANCEL_CONFIRMED',
  'BEGIN_COMPENSATION',
  'COMPLETE_COMPENSATION',
  'FAIL_COMPENSATION',
]);

export function parseToolCommandEvent(payload: unknown): ParsedToolCommandEvent {
  if (!isRecord(payload)) throw new Error('TOOL_COMMAND_EVENT_MALFORMED');
  const schemaVersion = payload.schemaVersion;
  const commandId = payload.commandId;
  const command = payload.command;
  const expectedRevision = payload.expectedRevision;
  const resultRevision = payload.resultRevision;
  if (
    schemaVersion !== 1 ||
    typeof commandId !== 'string' ||
    !UUID_PATTERN.test(commandId) ||
    typeof command !== 'string' ||
    !COMMANDS.has(command as ToolInvocationCommand) ||
    !Number.isInteger(expectedRevision) ||
    !Number.isInteger(resultRevision) ||
    (expectedRevision as number) < 1 ||
    resultRevision !== (expectedRevision as number) + 1
  ) {
    throw new Error('TOOL_COMMAND_EVENT_MALFORMED');
  }
  return {
    schemaVersion: 1,
    commandId,
    command: command as ToolInvocationCommand,
    expectedRevision: expectedRevision as number,
    resultRevision: resultRevision as number,
  };
}

export function commandCanStartExecution(command: ToolInvocationCommand): boolean {
  return command === 'START' || command === 'CONFIRM' || command === 'APPROVE';
}

export function decideToolExecutionEvent(input: {
  readonly command: ToolInvocationCommand;
  readonly eventResultRevision: number;
  readonly currentStatus: ToolInvocationStatus;
  readonly currentRevision: number;
  readonly providerRequestId: string | null;
  readonly providerDispatchAllowed: boolean;
  readonly dryRun: boolean;
  readonly dryRunMode: PreparedToolExecution['dryRunMode'];
}):
  | { readonly kind: 'ready' }
  | { readonly kind: 'ambiguous_dispatch' }
  | {
      readonly kind: 'skip';
      readonly reasonCode: Extract<ToolExecutionInspection, { kind: 'skip' }>['reasonCode'];
    } {
  if (!commandCanStartExecution(input.command)) {
    return { kind: 'skip', reasonCode: 'COMMAND_DOES_NOT_START_EXECUTION' };
  }
  if (input.currentStatus === 'APPROVED') {
    return input.eventResultRevision === input.currentRevision &&
      input.providerDispatchAllowed &&
      (!input.dryRun || input.dryRunMode === 'NATIVE')
      ? { kind: 'ready' }
      : { kind: 'skip', reasonCode: 'STALE_EXECUTION_EVENT' };
  }
  if (input.currentStatus === 'EXECUTING') {
    if (input.command === 'START' && input.eventResultRevision === input.currentRevision) {
      return { kind: 'skip', reasonCode: 'EXECUTION_START_EVENT_RECORDED' };
    }
    if (input.eventResultRevision < input.currentRevision && input.providerRequestId !== null) {
      return { kind: 'ambiguous_dispatch' };
    }
    return { kind: 'skip', reasonCode: 'STALE_EXECUTION_EVENT' };
  }
  return { kind: 'skip', reasonCode: 'EXECUTION_EVENT_ALREADY_SETTLED' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
