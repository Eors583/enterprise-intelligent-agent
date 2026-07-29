import type { ToolRiskClass, ToolVersion } from '@enterprise/contracts';

export const TOOL_RECONCILIATION_EVENT_TYPE = 'ToolInvocation.ReconciliationRequested';

export interface ClaimedToolReconciliationEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly eventType: typeof TOOL_RECONCILIATION_EVENT_TYPE;
  readonly payload: unknown;
  readonly attempts: number;
  readonly leaseExpiresAt: Date;
  readonly createdAt: Date;
}

export interface ParsedToolReconciliationEvent {
  readonly invocationId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export type ToolReconciliationEligibility = 'READ_ONLY' | 'PROVIDER_IDEMPOTENT' | 'INELIGIBLE';

export interface PreparedToolReconciliation {
  readonly attemptId: string;
  readonly outboxEventId: string;
  readonly tenantId: string;
  readonly invocationId: string;
  readonly expectedRevision: number;
  readonly toolVersionId: string;
  readonly endpointRef: string;
  readonly riskClass: ToolRiskClass;
  readonly idempotencyMode: ToolVersion['idempotencyMode'];
  readonly eligibility: ToolReconciliationEligibility;
  readonly requesterUserId: string;
  readonly roleAssignmentId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly providerRequestId: string;
  readonly inputHash: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly allowedHostPatterns: readonly string[];
  readonly startedAt: Date;
}

export type ToolReconciliationPreparation =
  | { readonly kind: 'ready'; readonly reconciliation: PreparedToolReconciliation }
  | {
      readonly kind: 'already_completed';
      readonly providerRequestId: string | null;
      readonly outcome: 'reconciled' | 'inconclusive';
      readonly reasonCode: string;
    }
  | {
      readonly kind: 'skip';
      readonly providerRequestId: string | null;
      readonly reasonCode:
        | 'INVOCATION_NOT_FOUND'
        | 'INVOCATION_NOT_UNKNOWN'
        | 'PROVIDER_REQUEST_ID_MISSING'
        | 'STALE_RECONCILIATION_REQUEST';
    };

interface ToolReconciliationResolutionBase {
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly proofHash: string | null;
  readonly proofType: 'STATUS' | 'IDEMPOTENT_REPLAY' | null;
  readonly proofId: string | null;
  readonly providerObservedAt: Date | null;
}

export type ToolReconciliationResolution =
  | (ToolReconciliationResolutionBase & {
      readonly kind: 'SUCCEEDED';
      readonly output: Readonly<Record<string, unknown>>;
      readonly outputHash: string;
      readonly reasonCode: 'TOOL_RECONCILIATION_PROVED_SUCCEEDED';
    })
  | (ToolReconciliationResolutionBase & {
      readonly kind: 'FAILED';
      readonly output: null;
      readonly outputHash: null;
      readonly errorCode: string;
      readonly reasonCode: 'TOOL_RECONCILIATION_PROVED_FAILED';
    })
  | (ToolReconciliationResolutionBase & {
      readonly kind: 'INCONCLUSIVE';
      readonly output: null;
      readonly outputHash: null;
      readonly reasonCode: string;
    });

export interface ToolReconciliationCompletion {
  readonly invocationStatus: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  readonly invocationRevision: number;
  readonly outcome: 'reconciled' | 'inconclusive';
  readonly reasonCode: string;
}

export function parseToolReconciliationEvent(
  event: Pick<ClaimedToolReconciliationEvent, 'aggregateId' | 'payload'>,
): ParsedToolReconciliationEvent {
  if (!isRecord(event.payload)) throw new Error('TOOL_RECONCILIATION_EVENT_MALFORMED');
  const invocationId = event.payload.invocationId;
  const expectedRevision = event.payload.expectedRevision;
  const idempotencyKey = event.payload.idempotencyKey;
  if (
    typeof invocationId !== 'string' ||
    !UUID_PATTERN.test(invocationId) ||
    invocationId !== event.aggregateId ||
    !Number.isInteger(expectedRevision) ||
    (expectedRevision as number) < 1 ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.trim().length < 1 ||
    idempotencyKey.length > 200
  ) {
    throw new Error('TOOL_RECONCILIATION_EVENT_MALFORMED');
  }
  return {
    invocationId,
    expectedRevision: expectedRevision as number,
    idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
